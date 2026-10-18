"""Keyword / semantic / hybrid search over the document index (Task M2.3).

Flow (docs/architecture.md §4): BM25 sparse and/or dense candidates from Qdrant, restricted by the
server-built ``SearchScope`` (workspace + published revision ids) and the request filters, both
applied inside the Qdrant filter; hybrid fuses the two candidate lists with RRF; an optional
reranker rescores the top ``rerank_top`` (M2.4; ``SearchLimits.rerank`` = ``off`` skips it); the
first ``results`` are returned. A failing reranker never fails the search: the first-stage order
is kept and the result carries a warning. An unavailable query embedder
(``EmbeddingUnavailableError``, e.g. the hosted Workers AI embedder rate-limited or down; M7.4b,
SEARCH-01-AC06) never fails a semantic/hybrid search either: it continues on the BM25 list alone
and ``SearchResult.degraded`` carries ``dense_unavailable``. Index (Qdrant) errors still raise.

Scores are reported as what they are (``bm25`` = Qdrant sparse dot product with IDF, ``cosine``,
``rrf``, ``rerank``); they are never normalised into a common scale. The raw component scores of
every hit are kept in ``RankedHit.scores``.

The service is synchronous (qdrant-client's sync client and CPU models); an async API should
call it in a worker thread (``starlette.concurrency.run_in_threadpool``).
"""

from __future__ import annotations

import dataclasses
import logging
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from book_core.contracts import (
    ChunkLevel,
    ScoreType,
    SearchChunk,
    SearchHit,
    SearchMode,
    Section,
)
from book_core.embedding import EmbeddingUnavailableError
from book_core.indexing import Candidate, IndexStore, SearchScope
from book_core.reranker import Reranker
from book_core.search.fusion import DEFAULT_RRF_K, reciprocal_rank_fusion
from book_core.search.query import DEFAULT_MAX_QUERY_CHARS, prepare_query

logger = logging.getLogger(__name__)

MAX_CANDIDATES = 200
MAX_RESULTS = 100

# `SearchResult.degraded` code: the dense (embedding) side was unavailable, BM25 results only.
DEGRADED_DENSE_UNAVAILABLE = "dense_unavailable"

ChunkKey = tuple[str, str, str]
"""(document_id, revision_id, chunk_id): one indexed point within a scope."""


class RerankMode(StrEnum):
    """``top_k``: rerank the first ``rerank_top`` first-stage candidates (when the service has a
    reranker); ``off``: the first-stage order is final."""

    OFF = "off"
    TOP_K = "top_k"


class SearchScopeError(ValueError):
    """The request has no valid server-built scope (no workspace or no published revision)."""


@dataclass(frozen=True, slots=True)
class SearchLimits:
    """Candidate and result counts (architecture §4 defaults; to be tuned by evaluation).

    Values above ``MAX_CANDIDATES`` / ``MAX_RESULTS`` are capped, with a warning in the result.
    """

    dense_candidates: int = 30
    keyword_candidates: int = 30
    rerank_top: int = 20
    results: int = 10
    rrf_k: int = DEFAULT_RRF_K
    rerank: RerankMode = RerankMode.TOP_K

    def __post_init__(self) -> None:
        object.__setattr__(self, "rerank", RerankMode(self.rerank))
        for name in ("dense_candidates", "keyword_candidates", "rerank_top", "results"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be an integer >= 1")
        if isinstance(self.rrf_k, bool) or not isinstance(self.rrf_k, int) or self.rrf_k < 0:
            raise ValueError("rrf_k must be an integer >= 0")

    def capped(self) -> tuple[SearchLimits, list[str]]:
        warnings: list[str] = []
        values: dict[str, Any] = {}
        for name, cap in (
            ("dense_candidates", MAX_CANDIDATES),
            ("keyword_candidates", MAX_CANDIDATES),
            ("rerank_top", MAX_CANDIDATES),
            ("results", MAX_RESULTS),
        ):
            value = getattr(self, name)
            if value > cap:
                warnings.append(f"{name} capped at {cap}")
                values[name] = cap
        return dataclasses.replace(self, **values), warnings


@dataclass(frozen=True, slots=True)
class SearchFilters:
    """User-selected narrowing filters. They can only narrow the scope, never widen it.

    ``chapter_ids`` and ``section_ids`` select whole subtrees of the revision's section tree
    (the id and all its descendants); this needs ``sections`` to be passed to ``search``.
    Without a tree, ``section_ids`` match chunk ``section_id`` exactly and ``chapter_ids`` are
    refused. Section ids are per-document identifiers: when they are not globally unique,
    combine them with ``document_ids``.
    """

    document_ids: tuple[str, ...] = ()
    chapter_ids: tuple[str, ...] = ()
    section_ids: tuple[str, ...] = ()
    languages: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("document_ids", "chapter_ids", "section_ids", "languages"):
            values = getattr(self, name)
            if isinstance(values, str):
                raise TypeError(f"{name} must be a sequence of strings, not a string")
            for value in values:
                if not isinstance(value, str) or not value or value != value.strip():
                    raise ValueError(f"{name} must contain non-empty identifiers")


@dataclass(frozen=True, slots=True)
class RankedHit:
    """A result: the ``SearchHit`` contract plus the indexed chunk, its parent (when requested),
    the chapter (top-level section) it belongs to (when a section tree was given), every
    component score (``bm25``/``cosine``/``rrf``/``rerank``) and its 1-based rank in each
    candidate list."""

    hit: SearchHit
    chunk: SearchChunk
    parent: SearchChunk | None = None
    chapter_id: str | None = None
    scores: Mapping[str, float] = field(default_factory=dict)
    ranks: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SearchResult:
    query: str
    mode: SearchMode
    query_language: str | None
    hits: tuple[RankedHit, ...]
    truncated: bool = False
    warnings: tuple[str, ...] = ()
    candidates: Mapping[str, int] = field(default_factory=dict)
    # Machine-readable degradations (``DEGRADED_DENSE_UNAVAILABLE``); empty when complete.
    degraded: tuple[str, ...] = ()


class SearchService:
    """Runs scoped searches over an ``IndexStore``.

    ``reranker`` (``Reranker`` protocol, e.g. ``Qwen3Reranker``) rescores the top
    ``SearchLimits.rerank_top`` candidates of every mode unless ``SearchLimits.rerank`` is
    ``off``; without it the first-stage order is final. Rerankers see each chunk's ``content``
    (the passage text without the breadcrumb that ``search_text`` adds for BM25 and embeddings):
    on the seed set with Qwen3-Reranker it ranked as well or better on every slice (hybrid MRR
    0.917 vs 0.889 over both books; the shared chapter breadcrumb makes sibling sections look
    alike). If the reranker raises or returns unusable scores, the first-stage order is kept and
    the result carries a warning.
    """

    def __init__(
        self,
        store: IndexStore,
        *,
        reranker: Reranker | None = None,
        limits: SearchLimits | None = None,
        max_query_chars: int = DEFAULT_MAX_QUERY_CHARS,
    ) -> None:
        if max_query_chars < 1:
            raise ValueError("max_query_chars must be >= 1")
        self._store = store
        self._reranker = reranker
        self._limits = limits or SearchLimits()
        self._max_query_chars = max_query_chars

    def search(
        self,
        query: str,
        scope: SearchScope,
        *,
        mode: SearchMode | str = SearchMode.HYBRID,
        filters: SearchFilters | None = None,
        sections: Sequence[Section] | None = None,
        limits: SearchLimits | None = None,
        with_parents: bool = False,
    ) -> SearchResult:
        """Search within ``scope``, which the server builds from the database (workspace the
        caller may read + its published revision ids); never from client input alone."""
        _check_scope(scope)
        mode = SearchMode(mode)
        filters = filters or SearchFilters()
        prepared = prepare_query(query, max_chars=self._max_query_chars)
        limits, warnings = (limits or self._limits).capped()
        degraded: list[str] = []
        if prepared.truncated:
            warnings.append(
                f"query truncated from {prepared.original_length} to {len(prepared.text)} "
                "characters"
            )

        def result(hits: Sequence[RankedHit], counts: Mapping[str, int]) -> SearchResult:
            return SearchResult(
                query=prepared.text,
                mode=mode,
                query_language=prepared.language,
                hits=tuple(hits),
                truncated=prepared.truncated,
                warnings=tuple(warnings),
                candidates=dict(counts),
                degraded=tuple(degraded),
            )

        narrowed = _narrow(scope, filters, sections)
        if narrowed is None:
            warnings.append("filters exclude every chunk in scope")
            return result([], {})

        lists: dict[str, list[Candidate]] = {}

        def keyword_list() -> None:
            keyword = self._store.keyword_candidates(
                narrowed, prepared.text, limits.keyword_candidates
            )
            if not keyword and mode is SearchMode.KEYWORD:
                warnings.append("no keyword matches")
            lists[ScoreType.BM25.value] = _in_scope(keyword, narrowed)

        if mode in (SearchMode.KEYWORD, SearchMode.HYBRID):
            keyword_list()
        if mode in (SearchMode.SEMANTIC, SearchMode.HYBRID):
            try:
                dense = self._store.dense_candidates(
                    narrowed, prepared.text, limits.dense_candidates
                )
            except EmbeddingUnavailableError as exc:
                # Type and code only: never the query (it is user content).
                logger.warning(
                    "search: query embedding unavailable (%s, %s); BM25 results only",
                    type(exc).__name__,
                    exc.code,
                )
                degraded.append(DEGRADED_DENSE_UNAVAILABLE)
                if mode is SearchMode.SEMANTIC:
                    keyword_list()
            else:
                lists[ScoreType.COSINE.value] = _in_scope(dense, narrowed)
        counts = {name: len(items) for name, items in lists.items()}

        # Without the dense list (degraded) the BM25 list alone is the first stage.
        stage_mode = SearchMode.KEYWORD if degraded else mode
        ranked = _first_stage(stage_mode, lists, limits.rrf_k)
        if self._reranker is not None and ranked and limits.rerank is RerankMode.TOP_K:
            try:
                ranked = _rerank(self._reranker, prepared.text, ranked[: limits.rerank_top])
            except Exception as exc:
                # Never log the query or passages; the exception type is enough to triage.
                logger.warning(
                    "search: reranker %s failed (%s); keeping first-stage order",
                    self._reranker.model_name,
                    type(exc).__name__,
                )
                warnings.append(f"reranker failed ({type(exc).__name__}); first-stage order kept")
            else:
                if limits.results > limits.rerank_top:
                    warnings.append(
                        f"results limited to rerank_top ({limits.rerank_top}) when reranking"
                    )
        ranked = ranked[: limits.results]

        parents: dict[str, SearchChunk] = {}
        if with_parents and ranked:
            parent_ids = {r.chunk.parent_id for r in ranked if r.chunk.parent_id is not None}
            for found in self._store.get_chunks(scope, parent_ids):
                if found.revision_id in scope.revision_ids:
                    parents[_parent_key(found.document_id, found.revision_id, found.id)] = found
        chapters = _chapter_index(sections) if sections is not None else {}

        hits = []
        for rank, item in enumerate(ranked, start=1):
            chunk = item.chunk
            parent: SearchChunk | None = None
            if chunk.parent_id is not None:
                parent = parents.get(
                    _parent_key(chunk.document_id, chunk.revision_id, chunk.parent_id)
                )
            hits.append(
                RankedHit(
                    hit=SearchHit(
                        chunk_id=chunk.id,
                        document_id=chunk.document_id,
                        revision_id=chunk.revision_id,
                        section_id=chunk.section_id,
                        # The mode that produced the hit (keyword when degraded).
                        mode=stage_mode,
                        score_type=item.score_type,
                        score=item.score,
                        rank=rank,
                        passage=chunk.content,
                        locations=chunk.locations,
                    ),
                    chunk=chunk,
                    parent=parent,
                    chapter_id=chapters.get(chunk.section_id) if chunk.section_id else None,
                    scores=dict(item.scores),
                    ranks=dict(item.ranks),
                )
            )
        return result(hits, counts)


# --- internals ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Scored:
    chunk: SearchChunk
    score: float
    score_type: ScoreType
    scores: Mapping[str, float]
    ranks: Mapping[str, int]


def _key(chunk: SearchChunk) -> ChunkKey:
    return (chunk.document_id, chunk.revision_id, chunk.id)


def _parent_key(document_id: str, revision_id: str, chunk_id: str) -> str:
    return "\x1f".join((document_id, revision_id, chunk_id))


def _check_scope(scope: object) -> None:
    if not isinstance(scope, SearchScope):
        raise SearchScopeError("search requires a server-built SearchScope")
    # SearchScope validates itself on construction; re-check in case it was mutated.
    if not scope.workspace_id or not scope.revision_ids or isinstance(scope.revision_ids, str):
        raise SearchScopeError("search scope needs a workspace and published revision ids")
    if scope.level is not ChunkLevel.CHILD:
        raise SearchScopeError("search runs on child chunks only")


def _intersect(allowed: tuple[str, ...], requested: Iterable[str] | None) -> tuple[str, ...] | None:
    """Combine a scope constraint (empty = unconstrained) with a request filter (``None`` =
    no filter). ``None`` means "nothing can match"."""
    if requested is None:
        return allowed
    wanted = tuple(dict.fromkeys(requested))
    if allowed:
        allowed_set = set(allowed)
        wanted = tuple(v for v in wanted if v in allowed_set)
    return wanted or None


def _subtrees(sections: Sequence[Section], roots: Iterable[str]) -> set[str]:
    children: dict[str, list[str]] = {}
    for section in sections:
        if section.parent_id is not None:
            children.setdefault(section.parent_id, []).append(section.id)
    known = {s.id for s in sections}
    found: set[str] = set()
    stack = [r for r in roots if r in known]
    while stack:
        current = stack.pop()
        if current in found:
            continue
        found.add(current)
        stack.extend(children.get(current, ()))
    return found


def _chapter_index(sections: Sequence[Section]) -> dict[str, str]:
    """Section id -> id of its top-level ancestor (itself for a chapter)."""
    parents = {s.id: s.parent_id for s in sections}
    chapters: dict[str, str] = {}
    for section_id in parents:
        current = section_id
        seen = {current}
        while (parent := parents.get(current)) is not None and parent not in seen:
            seen.add(parent)
            current = parent
        chapters[section_id] = current
    return chapters


def _narrow(
    scope: SearchScope, filters: SearchFilters, sections: Sequence[Section] | None
) -> SearchScope | None:
    """The scope narrowed by ``filters``, or ``None`` when no chunk can match."""
    documents = _intersect(scope.document_ids, filters.document_ids or None)
    languages = _intersect(scope.languages, filters.languages or None)
    requested_sections: set[str] | None = None
    if filters.chapter_ids or filters.section_ids:
        if sections is None:
            if filters.chapter_ids:
                raise ValueError("chapter filters need the revision's section tree")
            requested_sections = set(filters.section_ids)
        else:
            for ids in (filters.chapter_ids, filters.section_ids):
                if ids:
                    subtree = _subtrees(sections, ids)
                    requested_sections = (
                        subtree if requested_sections is None else requested_sections & subtree
                    )
    section_ids = _intersect(
        scope.section_ids,
        sorted(requested_sections) if requested_sections is not None else None,
    )
    if documents is None or languages is None or section_ids is None:
        return None
    return dataclasses.replace(
        scope, document_ids=documents, languages=languages, section_ids=section_ids
    )


def _in_scope(candidates: Sequence[Candidate], scope: SearchScope) -> list[Candidate]:
    """Defence in depth: drop anything the store returned outside the scope, dedupe points, and
    order ties deterministically (score desc, then document and chunk id)."""
    kept: dict[ChunkKey, Candidate] = {}
    dropped = 0
    for candidate in candidates:
        chunk = candidate.chunk
        if (
            chunk.revision_id not in scope.revision_ids
            or chunk.level is not ChunkLevel.CHILD
            or (scope.document_ids and chunk.document_id not in scope.document_ids)
            or (scope.section_ids and chunk.section_id not in scope.section_ids)
            or (scope.languages and chunk.language not in scope.languages)
            or not scope.admits_section(chunk.document_id, chunk.section_id)
            or not math.isfinite(candidate.score)
        ):
            dropped += 1
            continue
        key = _key(chunk)
        if key not in kept or candidate.score > kept[key].score:
            kept[key] = candidate
    if dropped:
        logger.warning("search: dropped %d candidates outside the scope", dropped)
    return sorted(kept.values(), key=lambda c: (-c.score, c.chunk.document_id, c.chunk.id))


def _first_stage(mode: SearchMode, lists: Mapping[str, list[Candidate]], k: int) -> list[_Scored]:
    if mode is not SearchMode.HYBRID:
        [(name, candidates)] = lists.items()
        return [
            _Scored(
                chunk=c.chunk,
                score=c.score,
                score_type=ScoreType(name),
                scores={name: c.score},
                ranks={name: rank},
            )
            for rank, c in enumerate(candidates, start=1)
        ]
    names = list(lists)
    by_key: dict[ChunkKey, SearchChunk] = {}
    raw: dict[ChunkKey, dict[str, float]] = {}
    for name in names:
        for candidate in lists[name]:
            key = _key(candidate.chunk)
            by_key.setdefault(key, candidate.chunk)
            raw.setdefault(key, {})[name] = candidate.score
    fused = reciprocal_rank_fusion([[_key(c.chunk) for c in lists[n]] for n in names], k=k)
    return [
        _Scored(
            chunk=by_key[item.key],
            score=item.score,
            score_type=ScoreType.RRF,
            scores={**raw[item.key], ScoreType.RRF.value: item.score},
            ranks={n: r for n, r in zip(names, item.ranks, strict=True) if r is not None},
        )
        for item in fused
    ]


def _rerank(reranker: Reranker, query: str, items: list[_Scored]) -> list[_Scored]:
    """Rescore ``items``; ties keep the first-stage order."""
    scores = reranker.score(query, [item.chunk.content for item in items])
    if len(scores) != len(items):
        raise RuntimeError("reranker returned the wrong number of scores")
    rescored = []
    for position, (item, score) in enumerate(zip(items, scores, strict=True)):
        value = float(score)
        if not math.isfinite(value):
            raise RuntimeError("reranker returned a non-finite score")
        rescored.append(
            (
                -value,
                position,
                dataclasses.replace(
                    item,
                    score=value,
                    score_type=ScoreType.RERANK,
                    scores={**item.scores, ScoreType.RERANK.value: value},
                ),
            )
        )
    rescored.sort(key=lambda entry: (entry[0], entry[1]))
    return [entry[2] for entry in rescored]
