"""Retrieval evaluation runner (docs/architecture.md §9).

``build_index`` writes a dataset's revisions into Qdrant (in-process ``:memory:`` or a server,
under a collection prefix) with ``rebuild``. ``evaluate`` runs every configured mode
(keyword / semantic / hybrid) with the reranker off and on and reports, per run:

- ``overall``: every query against every document (all judgements);
- ``directions``: one document language at a time (``ko->en`` = Korean queries searched in the
  English documents, judged only against those documents), the KO<->EN slices of §4;
- Recall@5, Recall@10, MRR@10 and nDCG@10 (``book_core.evaluation.metrics``);
- the location-mapping check: for the first hit of every judgement found in the top 10 of the
  overall search, the ``ExcerptResolver`` excerpt must hold the judged block's page and bbox (the
  bbox centre of each judged content block the hit covers lies in an excerpt location on the
  same page, and the excerpt's primary location is on one of those pages);
- latency percentiles of whole searches and of reranker calls (wall clock, this process).

``sweep`` repeats a run over a grid of RRF ``k`` and candidate depths (dense = keyword) to
compare settings; the index is built once.

Reports hold query ids, languages, judgement keys and numbers only, never passages.
"""

from __future__ import annotations

import itertools
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from qdrant_client import QdrantClient
from qdrant_client import models as qm

from book_core.contracts import BBox, BlockType, SearchMode, SourceLocation
from book_core.evaluation.dataset import CorpusDocument, Dataset, EvalQuery, Judgement
from book_core.evaluation.metrics import (
    mean,
    ndcg_at,
    percentile,
    recall_at,
    reciprocal_rank_at,
)
from book_core.indexing import (
    CollectionNames,
    QdrantIndexStore,
    RevisionChunks,
    SearchScope,
    rebuild,
)
from book_core.search import (
    ExcerptResolver,
    RankedHit,
    RerankMode,
    SearchFilters,
    SearchLimits,
    SearchService,
)

if TYPE_CHECKING:
    from book_core.embedding import Embedder
    from book_core.indexing import IndexStore
    from book_core.reranker import Reranker

REPORT_SCHEMA_VERSION = 1
METRIC_NAMES = ("R@5", "R@10", "MRR@10", "nDCG@10")
LOCATION_DEPTH = 10
DEFAULT_WORKSPACE = "eval"


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class SweepConfig(_Model):
    rrf_ks: Annotated[tuple[Annotated[int, Field(ge=0)], ...], Field(min_length=1)] = (
        0,
        10,
        30,
        60,
        100,
    )
    depths: Annotated[tuple[Annotated[int, Field(ge=1, le=200)], ...], Field(min_length=1)] = (
        5,
        10,
        20,
        30,
        50,
    )
    modes: tuple[SearchMode, ...] = (SearchMode.HYBRID,)
    rerank: tuple[RerankMode, ...] = (RerankMode.OFF,)


class EvalConfig(_Model):
    """What to run. Model choice lives here so a config file fully describes a report.

    ``rerank`` lists the reranker modes to run; ``top_k`` runs are skipped when ``reranker`` is
    ``none``.
    """

    name: Annotated[str, Field(min_length=1, pattern=r"^[A-Za-z0-9_.-]+$")] = "default"
    embedder: Literal["fake", "qwen3"] = "fake"
    embedding_dimension: Annotated[int, Field(ge=1)] | None = None
    reranker: Literal["none", "fake", "qwen3"] = "fake"
    modes: Annotated[tuple[SearchMode, ...], Field(min_length=1)] = tuple(SearchMode)
    rerank: Annotated[tuple[RerankMode, ...], Field(min_length=1)] = (
        RerankMode.OFF,
        RerankMode.TOP_K,
    )
    dense_candidates: Annotated[int, Field(ge=1, le=200)] = 30
    keyword_candidates: Annotated[int, Field(ge=1, le=200)] = 30
    rerank_top: Annotated[int, Field(ge=1, le=200)] = 20
    results: Annotated[int, Field(ge=1, le=100)] = 10
    rrf_k: Annotated[int, Field(ge=0)] = 60
    directions: bool = True
    check_locations: bool = True
    latency: bool = True
    sweep: SweepConfig | None = None

    def limits(self, **overrides: Any) -> SearchLimits:
        values: dict[str, Any] = {
            "dense_candidates": self.dense_candidates,
            "keyword_candidates": self.keyword_candidates,
            "rerank_top": self.rerank_top,
            "results": self.results,
            "rrf_k": self.rrf_k,
        }
        values.update(overrides)
        return SearchLimits(**values)


def make_embedder(kind: str, dimension: int | None = None) -> Embedder:
    if kind == "fake":
        from book_core.embedding import FakeEmbedder

        return FakeEmbedder() if dimension is None else FakeEmbedder(dimension)
    if kind == "qwen3":
        from book_core.embedding import Qwen3Embedder, Qwen3EmbedderConfig

        return Qwen3Embedder(Qwen3EmbedderConfig(dimension=dimension))
    raise ValueError(f"unknown embedder {kind!r}")


def make_reranker(kind: str) -> Reranker | None:
    if kind == "none":
        return None
    if kind == "fake":
        from book_core.reranker import FakeReranker

        return FakeReranker()
    if kind == "qwen3":
        from book_core.reranker import Qwen3Reranker

        return Qwen3Reranker()
    raise ValueError(f"unknown reranker {kind!r}")


# --- index -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EvalIndex:
    store: QdrantIndexStore
    workspace_id: str
    collection: str
    points: int


def build_index(
    dataset: Dataset,
    embedder: Embedder,
    client: QdrantClient,
    *,
    names: CollectionNames | None = None,
    workspace_id: str = DEFAULT_WORKSPACE,
) -> EvalIndex:
    """Index every document's revision (published) into a fresh collection behind the alias."""
    names = names or CollectionNames()
    report = rebuild(
        client,
        embedder,
        [
            RevisionChunks(workspace_id, d.id, d.revision_id, d.chunks, active=True)
            for d in dataset.documents
        ],
        names=names,
    )
    store = QdrantIndexStore(client, embedder, names=names)
    return EvalIndex(
        store=store, workspace_id=workspace_id, collection=report.collection, points=report.points
    )


def drop_prefixed(client: QdrantClient, prefix: str) -> None:
    """Delete every alias and collection whose name starts with ``prefix`` (cleanup)."""
    if not prefix:
        raise ValueError("refusing to drop collections without a prefix")
    for alias in client.get_aliases().aliases:
        if alias.alias_name.startswith(prefix):
            client.update_collection_aliases(
                change_aliases_operations=[
                    qm.DeleteAliasOperation(
                        delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                    )
                ]
            )
    for collection in client.get_collections().collections:
        if collection.name.startswith(prefix):
            client.delete_collection(collection.name)


# --- judgements --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Judged:
    """A judgement resolved against its document's revision."""

    judgement: Judgement
    # revision block id -> expected locations of that block (ground truth when the dataset has
    # it, else the revision's own locations); headings are flagged for the location check.
    blocks: Mapping[str, tuple[SourceLocation, ...]]
    headings: frozenset[str]


def _resolve_judgement(judgement: Judgement, document: CorpusDocument) -> _Judged:
    revision = document.revision
    wanted = set(judgement.block_ids)
    if wanted:
        chosen = [b for b in revision.blocks if b.id in wanted or wanted & set(b.source_block_ids)]
    else:
        subtree = {judgement.section_id}
        changed = True
        while changed:
            changed = False
            for section in revision.sections:
                if section.parent_id in subtree and section.id not in subtree:
                    subtree.add(section.id)
                    changed = True
        chosen = [b for b in revision.blocks if b.section_id in subtree]
    expected: dict[str, tuple[SourceLocation, ...]] = {}
    for block in chosen:
        ids = {block.id, *block.source_block_ids}
        truth = tuple(loc for loc in judgement.locations if loc.block_id in ids)
        expected[block.id] = truth or block.locations
    return _Judged(
        judgement=judgement,
        blocks=expected,
        headings=frozenset(b.id for b in chosen if b.type is BlockType.HEADING),
    )


def _center_inside(outer: BBox, inner: BBox, tolerance: float = 1.0) -> bool:
    cx, cy = (inner.x0 + inner.x1) / 2, (inner.y0 + inner.y1) / 2
    return (
        outer.x0 - tolerance <= cx <= outer.x1 + tolerance
        and outer.y0 - tolerance <= cy <= outer.y1 + tolerance
    )


def _location_found(expected: SourceLocation, shown: Sequence[SourceLocation]) -> bool:
    for location in shown:
        if location.page != expected.page:
            continue
        if expected.bbox is None or location.bbox is None:
            return True
        if _center_inside(location.bbox, expected.bbox):
            return True
    return False


# --- runs --------------------------------------------------------------------------------------


class _TimedReranker:
    def __init__(self, inner: Reranker) -> None:
        self._inner = inner
        self.seconds: list[float] = []

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        start = time.perf_counter()
        try:
            return self._inner.score(query, passages)
        finally:
            self.seconds.append(time.perf_counter() - start)


@dataclass(slots=True)
class _Bucket:
    values: dict[str, list[float]] = field(default_factory=lambda: {m: [] for m in METRIC_NAMES})

    def add(self, metrics: Mapping[str, float]) -> None:
        for name in METRIC_NAMES:
            self.values[name].append(metrics[name])

    def summary(self) -> dict[str, Any]:
        count = len(self.values[METRIC_NAMES[0]])
        out: dict[str, Any] = {"queries": count}
        for name in METRIC_NAMES:
            value = mean(self.values[name])
            out[name] = None if value is None else round(value, 4)
        return out


def _metrics(ranked: Sequence[str | None], qrels: Mapping[str, int]) -> dict[str, float]:
    return {
        "R@5": recall_at(ranked, qrels, 5),
        "R@10": recall_at(ranked, qrels, 10),
        "MRR@10": reciprocal_rank_at(ranked, qrels, 10),
        "nDCG@10": ndcg_at(ranked, qrels, 10),
    }


def _latency(seconds: Sequence[float]) -> dict[str, float] | None:
    if not seconds:
        return None
    ms = [s * 1000 for s in seconds]
    return {
        "count": len(ms),
        "p50": round(percentile(ms, 50) or 0.0, 2),
        "p95": round(percentile(ms, 95) or 0.0, 2),
        "max": round(max(ms), 2),
        "mean": round(sum(ms) / len(ms), 2),
    }


class Evaluator:
    """Runs searches for a dataset against an index and scores them."""

    def __init__(
        self,
        dataset: Dataset,
        store: IndexStore,
        *,
        workspace_id: str = DEFAULT_WORKSPACE,
        reranker: Reranker | None = None,
    ) -> None:
        self._dataset = dataset
        self._store = store
        self._workspace_id = workspace_id
        self._reranker = _TimedReranker(reranker) if reranker is not None else None
        self._resolvers = {d.id: ExcerptResolver(d.revision) for d in dataset.documents}
        self._judged = {
            (q.id, j.key): _resolve_judgement(j, dataset.document(j.document_id))
            for q in dataset.queries
            for j in q.judgements
        }

    @property
    def reranker_name(self) -> str | None:
        return self._reranker.model_name if self._reranker is not None else None

    def _scope(self, documents: Sequence[CorpusDocument]) -> SearchScope:
        return SearchScope(
            workspace_id=self._workspace_id,
            revision_ids=tuple(sorted({d.revision_id for d in documents})),
            document_ids=tuple(d.id for d in documents),
        )

    def _unit(self, hit: RankedHit, judged: Sequence[_Judged]) -> _Judged | None:
        covered = set(hit.chunk.block_ids)
        best: _Judged | None = None
        for item in judged:
            if item.judgement.document_id != hit.hit.document_id:
                continue
            if covered & set(item.blocks) and (
                best is None or item.judgement.grade > best.judgement.grade
            ):
                best = item
        return best

    def _location_ok(self, query: EvalQuery, hit: RankedHit, judged: _Judged) -> bool:
        resolver = self._resolvers[hit.hit.document_id]
        excerpt = resolver.resolve_hit(hit, query=query.text)
        covered = [b for b in hit.chunk.block_ids if b in judged.blocks]
        targets = [b for b in covered if b not in judged.headings] or covered
        expected = [loc for b in targets for loc in judged.blocks[b]]
        if not expected:
            return False
        if not all(_location_found(loc, excerpt.locations) for loc in expected):
            return False
        primary = excerpt.primary_location
        return primary is not None and primary.page in {loc.page for loc in expected}

    def _search(
        self,
        service: SearchService,
        query: EvalQuery,
        documents: Sequence[CorpusDocument],
        mode: SearchMode,
        limits: SearchLimits,
    ) -> tuple[list[RankedHit], float]:
        scope = self._scope(documents)
        filters = SearchFilters(document_ids=tuple(d.id for d in documents))
        start = time.perf_counter()
        result = service.search(query.text, scope, mode=mode, filters=filters, limits=limits)
        return list(result.hits), time.perf_counter() - start

    def run(
        self,
        mode: SearchMode,
        limits: SearchLimits,
        *,
        directions: bool = True,
        check_locations: bool = True,
        latency: bool = True,
        per_query: bool = True,
    ) -> dict[str, Any]:
        if limits.rerank is RerankMode.TOP_K and self._reranker is None:
            raise ValueError("rerank top_k needs a reranker")
        service = SearchService(self._store, reranker=self._reranker, limits=limits)
        if self._reranker is not None:
            self._reranker.seconds.clear()
        documents = self._dataset.documents
        languages = self._dataset.languages
        overall = _Bucket()
        by_language: dict[str, _Bucket] = {}
        by_direction: dict[str, _Bucket] = {}
        search_seconds: list[float] = []
        checked = located = 0
        failures: list[dict[str, Any]] = []
        queries: list[dict[str, Any]] = []
        for query in self._dataset.queries:
            judged = [self._judged[(query.id, j.key)] for j in query.judgements]
            hits, seconds = self._search(service, query, documents, mode, limits)
            search_seconds.append(seconds)
            units = [self._unit(h, judged) for h in hits]
            ranked = [u.judgement.key if u else None for u in units]
            qrels = {j.judgement.key: j.judgement.grade for j in judged}
            metrics = _metrics(ranked, qrels)
            overall.add(metrics)
            by_language.setdefault(query.language, _Bucket()).add(metrics)
            ranks: dict[str, int | None] = dict.fromkeys(qrels)
            for rank, unit in enumerate(units, start=1):
                if unit is None or ranks[unit.judgement.key] is not None:
                    continue
                ranks[unit.judgement.key] = rank
                if check_locations and rank <= LOCATION_DEPTH:
                    checked += 1
                    if self._location_ok(query, hits[rank - 1], unit):
                        located += 1
                    else:
                        failures.append({"query": query.id, "judgement": unit.judgement.key})
            entry: dict[str, Any] = {
                "id": query.id,
                "language": query.language,
                "ranks": ranks,
                **{k: round(v, 4) for k, v in metrics.items()},
            }
            if directions:
                entry["directions"] = {}
                for language in languages:
                    subset = [d for d in documents if d.language == language]
                    ids = {d.id for d in subset}
                    sub_judged = [j for j in judged if j.judgement.document_id in ids]
                    if not sub_judged:
                        continue
                    sub_hits, _ = self._search(service, query, subset, mode, limits)
                    sub_units = [self._unit(h, sub_judged) for h in sub_hits]
                    sub_metrics = _metrics(
                        [u.judgement.key if u else None for u in sub_units],
                        {j.judgement.key: j.judgement.grade for j in sub_judged},
                    )
                    direction = f"{query.language}->{language}"
                    by_direction.setdefault(direction, _Bucket()).add(sub_metrics)
                    entry["directions"][direction] = {
                        k: round(v, 4) for k, v in sub_metrics.items()
                    }
            queries.append(entry)

        run: dict[str, Any] = {
            "mode": mode.value,
            "rerank": limits.rerank.value,
            "limits": {
                "dense_candidates": limits.dense_candidates,
                "keyword_candidates": limits.keyword_candidates,
                "rerank_top": limits.rerank_top,
                "results": limits.results,
                "rrf_k": limits.rrf_k,
            },
            "overall": overall.summary(),
            "by_query_language": {k: v.summary() for k, v in sorted(by_language.items())},
        }
        if directions:
            run["directions"] = {k: v.summary() for k, v in sorted(by_direction.items())}
        if check_locations:
            run["locations"] = {
                "checked": checked,
                "ok": located,
                "accuracy": round(located / checked, 4) if checked else None,
                "failures": failures,
            }
        if latency:
            reranks = self._reranker.seconds if self._reranker is not None else []
            run["latency_ms"] = {
                "search": _latency(search_seconds),
                "rerank": _latency(reranks) if limits.rerank is RerankMode.TOP_K else None,
            }
        if per_query:
            run["queries"] = queries
        return run


# --- reports -----------------------------------------------------------------------------------


def _dataset_info(dataset: Dataset) -> dict[str, Any]:
    return {
        "name": dataset.name,
        "source": dataset.source,
        "synthetic": dataset.synthetic,
        "queries": len(dataset.queries),
        "query_languages": dict(
            sorted(
                {
                    lang: sum(1 for q in dataset.queries if q.language == lang)
                    for lang in {q.language for q in dataset.queries}
                }.items()
            )
        ),
        "documents": [
            {
                "id": d.id,
                "language": d.language,
                "revision_id": d.revision_id,
                "children": sum(1 for c in d.chunks if c.level.value == "child"),
            }
            for d in dataset.documents
        ],
    }


def evaluate(
    dataset: Dataset,
    index: EvalIndex,
    config: EvalConfig,
    *,
    embedder_name: str,
    reranker: Reranker | None = None,
    backend: str = "memory",
) -> dict[str, Any]:
    """Run every (mode, rerank) combination of ``config`` and the optional sweep."""
    evaluator = Evaluator(dataset, index.store, workspace_id=index.workspace_id, reranker=reranker)
    runs = []
    for mode, rerank in itertools.product(config.modes, config.rerank):
        if rerank is RerankMode.TOP_K and reranker is None:
            continue
        runs.append(
            evaluator.run(
                mode,
                config.limits(rerank=rerank),
                directions=config.directions,
                check_locations=config.check_locations,
                latency=config.latency,
            )
        )
    report: dict[str, Any] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "name": config.name,
        "dataset": _dataset_info(dataset),
        "config": config.model_dump(mode="json"),
        "models": {"embedder": embedder_name, "reranker": evaluator.reranker_name},
        "index": {"backend": backend, "points": index.points},
        "runs": runs,
    }
    if config.sweep is not None:
        report["sweep"] = sweep(evaluator, config, config.sweep)
    return report


def sweep(evaluator: Evaluator, config: EvalConfig, grid: SweepConfig) -> dict[str, Any]:
    """Grid over RRF ``k`` and candidate depth (dense = keyword candidates)."""
    rows = []
    for mode, rerank, rrf_k, depth in itertools.product(
        grid.modes, grid.rerank, grid.rrf_ks, grid.depths
    ):
        limits = config.limits(
            rerank=rerank, rrf_k=rrf_k, dense_candidates=depth, keyword_candidates=depth
        )
        run = evaluator.run(
            mode,
            limits,
            directions=config.directions,
            check_locations=False,
            latency=config.latency,
            per_query=False,
        )
        row: dict[str, Any] = {
            "mode": mode.value,
            "rerank": rerank.value,
            "rrf_k": rrf_k,
            "depth": depth,
            **{name: run["overall"][name] for name in METRIC_NAMES},
        }
        if config.directions:
            cross = [
                v["R@5"]
                for k, v in run["directions"].items()
                if k.split("->")[0] != k.split("->")[1] and v["R@5"] is not None
            ]
            row["cross R@5"] = round(sum(cross) / len(cross), 4) if cross else None
        if config.latency:
            row["p50 ms"] = run["latency_ms"]["search"]["p50"]
        rows.append(row)
    return {
        "grid": grid.model_dump(mode="json"),
        "rows": rows,
        "best": _best(rows),
    }


def _best(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Best row by (R@5, MRR@10, nDCG@10), then the smallest depth and k (cheapest)."""
    if not rows:
        return None
    best = min(
        rows,
        key=lambda r: (
            -(r["R@5"] or 0.0),
            -(r["MRR@10"] or 0.0),
            -(r["nDCG@10"] or 0.0),
            r["depth"],
            r["rrf_k"],
        ),
    )
    return dict(best)


@contextmanager
def qdrant_client(
    *, url: str | None = None, path: str | None = None, api_key: str | None = None
) -> Iterator[QdrantClient]:
    """``url`` (server), ``path`` (local on-disk) or neither (in-process ``:memory:``)."""
    if url is not None and path is not None:
        raise ValueError("pass a url or a path, not both")
    if url is not None:
        client = QdrantClient(
            url=url, api_key=api_key or None, timeout=30, check_compatibility=False
        )
    elif path is not None:
        client = QdrantClient(path=path)
    else:
        client = QdrantClient(":memory:")
    try:
        yield client
    finally:
        client.close()
