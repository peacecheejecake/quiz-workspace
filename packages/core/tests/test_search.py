"""Search (M2.3): RRF, mode routing, server-enforced scope, filters, reranker hook, seed metrics.

Default tests run on qdrant-client's in-process local mode with ``FakeEmbedder`` (no server, no
model). ``infra`` repeats the seed checks on the real Qdrant server (``test_<uuid>_``
collections, deleted afterwards). ``models`` runs the seed set with Qwen3-Embedding (MRL 256).

Seed metrics: every ``retrieval-seed.json`` query is judged against both books (book-ko and
book-en share section ids), so a relevant item is a (document, leaf section) pair and each query
has two. Recall@5 = share of those pairs among the top-5 hits; MRR = 1 / rank of the first
relevant hit (0 when none in the top 10). Measured (default limits, no reranker):

- FakeEmbedder, in-process and real Qdrant: keyword R@5 0.500 / MRR 0.917, hybrid R@5 0.583 /
  MRR 0.917 (keyword cannot cross languages; the fake dense vectors add a few cross-book hits).
- Qwen3-Embedding-0.6B (MRL 256): keyword 0.500 / 0.917, semantic 0.917 / 0.917, hybrid
  0.667 / 0.917. Per direction (one book at a time) hybrid R@5 is 1.0 for KO->KO, KO->EN,
  EN->KO and EN->EN (MRR 0.833 / 1.0 / 1.0 / 1.0). Over both books together, plain RRF lets
  same-language keyword hits push the cross-language section below rank 5, so hybrid trails
  semantic there.
- With Qwen3-Reranker-0.6B on the top 20 (M2.4, reranker input = chunk ``content``): semantic
  and hybrid both reach R@5 1.000 / MRR 0.917 over both books (the reranker restores the
  cross-language section); per direction R@5 stays 1.0 everywhere, MRR 0.833 / 0.833 / 1.0 / 1.0
  (KO->EN drops from 1.0: one query ranks a same-chapter sibling first). Keyword is unchanged
  (0.500 / 0.917: the reranker cannot add cross-language candidates BM25 never returned). With
  ``search_text`` (breadcrumb) as reranker input hybrid MRR was 0.889, so ``content`` is used.
"""

from __future__ import annotations

import json
import math
import os
import uuid
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass

import pytest
from book_core.chunker import chunk_revision
from book_core.contracts import (
    ChunkLevel,
    DocumentRevision,
    ScoreType,
    SearchChunk,
    SearchMode,
)
from book_core.embedding import Embedder, FakeEmbedder
from book_core.indexing import (
    Candidate,
    CollectionNames,
    QdrantIndexStore,
    SearchScope,
    scope_filter,
)
from book_core.parser import FakeParser
from book_core.reranker import FakeReranker
from book_core.search import (
    MAX_RESULTS,
    InvalidQueryError,
    RerankMode,
    SearchFilters,
    SearchLimits,
    SearchResult,
    SearchScopeError,
    SearchService,
    detect_language,
    prepare_query,
    reciprocal_rank_fusion,
)
from book_core.structure import build_revision, publish
from make_fixture_pdfs import OUT_DIR
from qdrant_client import QdrantClient
from qdrant_client import models as qm

WS = "ws-search"
OTHER_WS = "ws-other"
BOOKS = ("book-ko", "book-en")
SEED = json.loads((OUT_DIR / "retrieval-seed.json").read_text(encoding="utf-8"))["queries"]

# (book, query, expected leaf section of the top keyword hit): single keywords plus the seed
# queries in the book of their own language (q-ko-01's top keyword hit is the chapter-2 intro,
# which shares 정수/처리 with the query; its relevant section is rank 2).
KEYWORD_CASES = [
    ("book-ko", "염소", "ch2-s2"),
    ("book-ko", "응결", "ch1-s1"),
    ("book-ko", "침전", "ch2-s1"),
    ("book-ko", "지하수", "ch1-s2"),
    ("book-en", "chlorine", "ch2-s2"),
    ("book-en", "condensation", "ch1-s1"),
    ("book-en", "sedimentation", "ch2-s1"),
    ("book-en", "groundwater", "ch1-s2"),
    *(
        (
            "book-ko" if q["language"] == "ko" else "book-en",
            q["query"],
            q["relevant"][0]["section_id"],
        )
        for q in SEED
        if q["id"] != "q-ko-01"
    ),
]


# --- fixtures and helpers ----------------------------------------------------------------------


def _revision(book: str, revision_id: str = "r1") -> DocumentRevision:
    parsed = FakeParser.from_truth_files([OUT_DIR / f"{book}.truth.json"]).parse(
        OUT_DIR / f"{book}.pdf"
    )
    return publish(build_revision(parsed, document_id=book, revision_id=revision_id).revision)


REVISIONS = {book: _revision(book) for book in BOOKS}
CHUNKS = {book: chunk_revision(rev).chunks for book, rev in REVISIONS.items()}


def _fixture_section(book: str, section_id: str | None) -> str | None:
    """Revision section id -> fixture section id (``ch2-s2``) via the section title."""
    truth = json.loads((OUT_DIR / f"{book}.truth.json").read_text(encoding="utf-8"))
    by_title = {s["title"]: s["id"] for s in truth["sections"]}
    titles = {s.id: s.title for s in REVISIONS[book].sections}
    return by_title.get(titles.get(section_id or "", ""))


SECTION_MAP = {
    (book, s.id): _fixture_section(book, s.id) for book in BOOKS for s in REVISIONS[book].sections
}


def _scope(*revisions: str, workspace: str = WS, **kwargs: object) -> SearchScope:
    return SearchScope(workspace_id=workspace, revision_ids=revisions or ("r1",), **kwargs)  # type: ignore[arg-type]


def _index(store: QdrantIndexStore, workspace: str = WS) -> None:
    for book in BOOKS:
        store.index_revision(workspace, book, "r1", CHUNKS[book])
        store.activate_revision(workspace, book, "r1")


@pytest.fixture(scope="module")
def memory_store() -> Iterator[QdrantIndexStore]:
    client = QdrantClient(":memory:")
    store = QdrantIndexStore(client, FakeEmbedder())
    _index(store)
    yield store
    client.close()


class RecordingStore(QdrantIndexStore):
    """Real store that records every scope and call it receives."""

    def __init__(self, inner: QdrantIndexStore) -> None:
        self.inner = inner
        self.calls: list[tuple[str, SearchScope, int]] = []

    def keyword_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        self.calls.append(("keyword", scope, limit))
        return self.inner.keyword_candidates(scope, query, limit)

    def dense_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        self.calls.append(("dense", scope, limit))
        return self.inner.dense_candidates(scope, query, limit)

    def get_chunks(self, scope: SearchScope, chunk_ids: Collection[str]) -> list[SearchChunk]:
        self.calls.append(("get", scope, len(chunk_ids)))
        return self.inner.get_chunks(scope, chunk_ids)


class CannedStore(QdrantIndexStore):
    """Returns fixed candidate lists regardless of the scope (a misbehaving store)."""

    def __init__(self, keyword: Sequence[Candidate], dense: Sequence[Candidate]) -> None:
        self.keyword = list(keyword)
        self.dense = list(dense)

    def keyword_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        return self.keyword[:limit]

    def dense_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        return self.dense[:limit]

    def get_chunks(self, scope: SearchScope, chunk_ids: Collection[str]) -> list[SearchChunk]:
        return []


class RecordingReranker(FakeReranker):
    def __init__(self, scores: Mapping[str, float] | None = None) -> None:
        super().__init__()
        self.seen: list[list[str]] = []
        self.scores = scores

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        self.seen.append(list(passages))
        if self.scores is None:
            return super().score(query, passages)
        return [self.scores.get(p, 0.0) for p in passages]


def _child(
    chunk_id: str, *, revision: str = "r1", document: str = "doc", text: str = ""
) -> SearchChunk:
    template = next(c for c in CHUNKS["book-en"] if c.level is ChunkLevel.CHILD)
    return template.model_copy(
        update={
            "id": chunk_id,
            "document_id": document,
            "revision_id": revision,
            "content": text or f"passage {chunk_id}",
            "search_text": text or f"passage {chunk_id}",
            "parent_id": None,
        }
    )


def _ids(result: SearchResult) -> list[str]:
    return [h.hit.chunk_id for h in result.hits]


# --- RRF ---------------------------------------------------------------------------------------


def test_rrf_scores_and_order_match_the_formula() -> None:
    fused = reciprocal_rank_fusion([["a", "b", "c"], ["c", "a", "d"]], k=60)
    assert [f.key for f in fused] == ["a", "c", "b", "d"]
    expected = {"a": 1 / 61 + 1 / 62, "c": 1 / 63 + 1 / 61, "b": 1 / 62, "d": 1 / 63}
    for item in fused:
        assert math.isclose(item.score, expected[item.key])
    assert fused[0].ranks == (1, 2)
    assert fused[-1].ranks == (None, 3)


def test_rrf_ties_break_on_best_rank_then_list_order_and_k_matters() -> None:
    # a and b have identical scores (1/61 + 1/62); both reach rank 1, a in the first list.
    assert [f.key for f in reciprocal_rank_fusion([["a", "b"], ["b", "a"]])] == ["a", "b"]
    assert [f.key for f in reciprocal_rank_fusion([["b", "a"], ["a", "b"]])] == ["b", "a"]
    # k=0: x (1), z (1) and y (1/2 + 1/2) all score 1.0; best rank 1 beats 2, list 0 beats 1.
    assert [f.key for f in reciprocal_rank_fusion([["x", "y"], ["z", "y"]], k=0)] == ["x", "z", "y"]
    # k=60: appearing in both lists wins.
    assert reciprocal_rank_fusion([["x", "y"], ["z", "y"]], k=60)[0].key == "y"
    # A repeated key counts once, at its first rank.
    [only] = reciprocal_rank_fusion([["a", "a", "a"]], k=1)
    assert only.score == 0.5
    assert reciprocal_rank_fusion([]) == []
    with pytest.raises(ValueError, match="rrf k"):
        reciprocal_rank_fusion([["a"]], k=-1)


# --- query handling ----------------------------------------------------------------------------


@pytest.mark.parametrize("query", ["", "   ", "\n\t "])
def test_empty_queries_are_rejected(memory_store: QdrantIndexStore, query: str) -> None:
    with pytest.raises(InvalidQueryError):
        SearchService(memory_store).search(query, _scope())


def test_long_queries_are_truncated_with_a_warning(memory_store: QdrantIndexStore) -> None:
    service = SearchService(memory_store, max_query_chars=20)
    result = service.search("chlorine   disinfection " * 10, _scope(), mode="keyword")
    assert result.truncated
    assert result.query == "chlorine disinfectio"
    assert any("truncated" in w for w in result.warnings)
    assert result.hits


def test_language_hint() -> None:
    assert detect_language("정수장에서 염소를 넣는 이유") == "ko"
    assert detect_language("why is a coagulant added") == "en"
    assert detect_language("BM25 검색과 dense 검색") == "mixed"
    assert detect_language("1234 !!") is None
    assert prepare_query("  구름은\n어떻게  ").text == "구름은 어떻게"


# --- scope guardrails --------------------------------------------------------------------------


def test_unscoped_searches_are_refused(memory_store: QdrantIndexStore) -> None:
    service = SearchService(memory_store)
    with pytest.raises(SearchScopeError):
        service.search("chlorine", None)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="published revision"):
        SearchScope(workspace_id=WS, revision_ids=())
    with pytest.raises(ValueError, match="workspace_id"):
        SearchScope(workspace_id="", revision_ids=("r1",))
    tampered = _scope()
    object.__setattr__(tampered, "revision_ids", ())
    with pytest.raises(SearchScopeError):
        service.search("chlorine", tampered)
    with pytest.raises(SearchScopeError, match="child"):
        service.search("chlorine", _scope(level=ChunkLevel.PARENT))


@pytest.mark.parametrize("mode", list(SearchMode))
def test_other_workspaces_and_unpublished_revisions_never_leak(mode: SearchMode) -> None:
    client = QdrantClient(":memory:")
    store = QdrantIndexStore(client, FakeEmbedder())
    _index(store)
    _index(store, workspace=OTHER_WS)
    draft = _revision("book-en", "r2")
    store.index_revision(WS, "book-en", "r2", chunk_revision(draft).chunks)
    service = SearchService(store, limits=SearchLimits(results=100))
    result = service.search("chlorine water treatment", _scope("r1"), mode=mode)
    assert result.hits
    assert {h.hit.revision_id for h in result.hits} == {"r1"}
    other = service.search("chlorine", _scope("r9"), mode=mode)
    assert other.hits == ()
    client.close()


def test_candidates_outside_the_scope_are_dropped_even_if_the_store_returns_them() -> None:
    good = _child("good")
    leaks = [
        _child("stale", revision="r0"),
        _child("other-doc", document="secret"),
        _child("parent").model_copy(update={"level": ChunkLevel.PARENT}),
        _child("ko", text="다른 언어").model_copy(update={"language": "ko"}),
    ]
    store = CannedStore([Candidate(c, 9.0) for c in leaks] + [Candidate(good, 1.0)], [])
    scope = _scope("r1", document_ids=("doc",), languages=("en",))
    result = SearchService(store).search("passage", scope, mode="keyword")
    assert _ids(result) == ["good"]


def test_filters_only_narrow_the_scope(memory_store: QdrantIndexStore) -> None:
    service = SearchService(memory_store)
    scope = _scope(document_ids=("book-ko",))
    widened = service.search(
        "chlorine", scope, mode="keyword", filters=SearchFilters(document_ids=("book-en",))
    )
    assert widened.hits == ()
    assert widened.warnings == ("filters exclude every chunk in scope",)


# --- mode routing, score types, filters --------------------------------------------------------


@pytest.mark.parametrize(
    ("mode", "calls", "score_type"),
    [
        (SearchMode.KEYWORD, ["keyword"], ScoreType.BM25),
        (SearchMode.SEMANTIC, ["dense"], ScoreType.COSINE),
        (SearchMode.HYBRID, ["keyword", "dense"], ScoreType.RRF),
    ],
)
def test_modes_route_to_their_candidate_lists(
    memory_store: QdrantIndexStore, mode: SearchMode, calls: list[str], score_type: ScoreType
) -> None:
    store = RecordingStore(memory_store)
    limits = SearchLimits(dense_candidates=7, keyword_candidates=5, results=3)
    result = SearchService(store, limits=limits).search("water treatment", _scope(), mode=mode)
    assert [c[0] for c in store.calls] == calls
    assert {c[2] for c in store.calls} <= {5, 7}
    assert result.mode is mode
    assert len(result.hits) == 3
    assert [h.hit.rank for h in result.hits] == [1, 2, 3]
    assert {h.hit.score_type for h in result.hits} == {score_type}
    scores = [h.hit.score for h in result.hits]
    assert scores == sorted(scores, reverse=True)
    assert all(h.scores[score_type.value] == h.hit.score for h in result.hits)
    if mode is SearchMode.HYBRID:
        top = result.hits[0]
        expected = sum(1 / (60 + r) for r in top.ranks.values())
        assert math.isclose(top.hit.score, expected)


def test_section_tree_filters_become_qdrant_conditions(memory_store: QdrantIndexStore) -> None:
    store = RecordingStore(memory_store)
    service = SearchService(store, limits=SearchLimits(results=50))
    sections = REVISIONS["book-en"].sections
    chapter2 = next(s.id for s in sections if s.level == 1 and "Treatment" in s.title)
    descendants = {s.id for s in sections if s.parent_id == chapter2} | {chapter2}

    unfiltered = service.search("water", _scope(), mode="hybrid", sections=sections)
    filtered = service.search(
        "water",
        _scope(),
        mode="hybrid",
        filters=SearchFilters(
            document_ids=("book-en",), chapter_ids=(chapter2,), languages=("en",)
        ),
        sections=sections,
    )
    narrowed = store.calls[-1][1]
    assert set(narrowed.section_ids) == descendants
    assert narrowed.document_ids == ("book-en",)
    assert narrowed.languages == ("en",)
    conditions = {c.key: c.match for c in scope_filter(narrowed).must}  # type: ignore[union-attr]
    assert set(conditions["section_id"].any) == descendants  # type: ignore[union-attr]
    assert conditions["revision_id"].any == ["r1"]  # type: ignore[union-attr]

    assert {h.hit.document_id for h in unfiltered.hits} == set(BOOKS)
    assert filtered.hits
    assert {h.hit.document_id for h in filtered.hits} == {"book-en"}
    assert {h.hit.section_id for h in filtered.hits} <= descendants
    assert {h.chapter_id for h in filtered.hits} == {chapter2}


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        (SearchFilters(languages=("ko",)), {("book-ko", None)}),
        (SearchFilters(document_ids=("book-en",)), {("book-en", None)}),
        (
            SearchFilters(section_ids=("sec-ch1-s2-heading",)),
            {("book-ko", "ch1-s2"), ("book-en", "ch1-s2")},
        ),
        (SearchFilters(chapter_ids=("unknown",)), set()),
    ],
)
def test_filters_change_results(
    memory_store: QdrantIndexStore,
    filters: SearchFilters,
    expected: set[tuple[str, str | None]],
) -> None:
    sections = REVISIONS["book-ko"].sections
    result = SearchService(memory_store, limits=SearchLimits(results=50)).search(
        "물 water", _scope(), mode="hybrid", filters=filters, sections=sections
    )
    found = {
        (h.hit.document_id, SECTION_MAP[(h.hit.document_id, h.hit.section_id or "")])
        for h in result.hits
    }
    if not expected:
        assert result.hits == ()
        return
    documents = {d for d, _ in expected}
    assert {d for d, _ in found} == documents
    if all(s is not None for _, s in expected):
        assert found == expected


def test_chapter_filter_without_a_section_tree_is_refused(memory_store: QdrantIndexStore) -> None:
    with pytest.raises(ValueError, match="section tree"):
        SearchService(memory_store).search(
            "water", _scope(), filters=SearchFilters(chapter_ids=("sec-ch1-heading",))
        )


def test_dedupe_by_chunk_across_and_within_lists() -> None:
    a, b, c = _child("a"), _child("b"), _child("c")
    keyword = [Candidate(a, 3.0), Candidate(a, 2.0), Candidate(b, 1.0)]
    dense = [Candidate(b, 0.9), Candidate(a, 0.8), Candidate(c, 0.1)]
    result = SearchService(CannedStore(keyword, dense)).search("q", _scope())
    assert _ids(result) == ["a", "b", "c"]
    assert result.hits[0].ranks == {"bm25": 1, "cosine": 2}
    assert result.hits[0].scores["bm25"] == 3.0
    assert result.candidates == {"bm25": 2, "cosine": 3}
    # Same chunk id in two documents stays two hits.
    other = _child("a", document="doc2")
    two = SearchService(CannedStore([Candidate(a, 1.0), Candidate(other, 1.0)], [])).search(
        "q", _scope(), mode="keyword"
    )
    assert [(h.hit.document_id, h.hit.chunk_id) for h in two.hits] == [("doc", "a"), ("doc2", "a")]


# --- reranker hook, limits, parents ------------------------------------------------------------


def test_reranker_sees_the_fused_top_n_and_decides_the_final_order() -> None:
    chunks = [_child(f"c{i}") for i in range(6)]
    keyword = [Candidate(c, 10.0 - i) for i, c in enumerate(chunks)]
    dense = [Candidate(c, 1.0 - i / 10) for i, c in enumerate(chunks)]
    reranker = RecordingReranker({"passage c2": 0.9, "passage c0": 0.5, "passage c1": 0.5})
    limits = SearchLimits(rerank_top=3, results=5)
    result = SearchService(CannedStore(keyword, dense), reranker=reranker, limits=limits).search(
        "q", _scope()
    )
    assert reranker.seen == [["passage c0", "passage c1", "passage c2"]]
    # c2 first; c0/c1 tie on 0.5 and keep their fused order; nothing beyond rerank_top.
    assert _ids(result) == ["c2", "c0", "c1"]
    assert {h.hit.score_type for h in result.hits} == {ScoreType.RERANK}
    assert set(result.hits[0].scores) == {"bm25", "cosine", "rrf", "rerank"}
    assert any("rerank_top" in w for w in result.warnings)


class FailingReranker(FakeReranker):
    def __init__(self, scores: BaseException | list[float]) -> None:
        super().__init__()
        self.scores = scores

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        if isinstance(self.scores, BaseException):
            raise self.scores
        return self.scores


def _six() -> CannedStore:
    chunks = [_child(f"c{i}") for i in range(6)]
    return CannedStore(
        [Candidate(c, 10.0 - i) for i, c in enumerate(chunks)],
        [Candidate(c, 1.0 - i / 10) for i, c in enumerate(chunks)],
    )


@pytest.mark.parametrize(
    ("scores", "error"),
    [
        (RuntimeError("model crashed"), "RuntimeError"),
        (MemoryError(), "MemoryError"),
        ([1.0], "RuntimeError"),  # wrong count
        ([1.0, math.nan, 0.0], "RuntimeError"),  # non-finite
    ],
)
def test_reranker_failure_keeps_the_first_stage_order(
    scores: BaseException | list[float], error: str, caplog: pytest.LogCaptureFixture
) -> None:
    limits = SearchLimits(rerank_top=3, results=5)
    baseline = SearchService(_six(), limits=limits).search("secret query", _scope())
    service = SearchService(_six(), reranker=FailingReranker(scores), limits=limits)
    with caplog.at_level("WARNING", logger="book_core.search.service"):
        result = service.search("secret query", _scope())
    # Not cut to rerank_top: the full first-stage list up to `results`, with its own scores.
    assert _ids(result) == _ids(baseline) == ["c0", "c1", "c2", "c3", "c4"]
    assert {h.hit.score_type for h in result.hits} == {ScoreType.RRF}
    assert all("rerank" not in h.scores for h in result.hits)
    assert result.warnings == (f"reranker failed ({error}); first-stage order kept",)
    assert "reranker" in caplog.text
    assert "secret query" not in caplog.text
    assert "passage c0" not in caplog.text


def test_rerank_mode_off_skips_the_reranker() -> None:
    reranker = RecordingReranker({"passage c5": 1.0})
    off = SearchLimits(rerank=RerankMode.OFF, rerank_top=3, results=5)
    result = SearchService(_six(), reranker=reranker, limits=off).search("q", _scope())
    assert reranker.seen == []
    assert _ids(result) == ["c0", "c1", "c2", "c3", "c4"]
    assert result.warnings == ()
    assert SearchLimits(rerank="off").rerank is RerankMode.OFF  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="always"):
        SearchLimits(rerank="always")  # type: ignore[arg-type]
    # Per-request limits override the service default in both directions.
    on = SearchService(_six(), reranker=reranker, limits=off).search(
        "q", _scope(), limits=SearchLimits(rerank_top=6, results=3)
    )
    assert _ids(on) == ["c5", "c0", "c1"]


def test_reranker_ties_keep_the_first_stage_order_in_every_mode() -> None:
    reranker = RecordingReranker({})  # every passage scores 0.0
    for mode in SearchMode:
        plain = SearchService(_six()).search("q", _scope(), mode=mode)
        tied = SearchService(_six(), reranker=reranker).search("q", _scope(), mode=mode)
        assert _ids(tied) == _ids(plain), mode
        assert [h.hit.rank for h in tied.hits] == list(range(1, 7))
        assert {h.hit.score for h in tied.hits} == {0.0}


def test_rerank_top_bounds_what_the_reranker_sees() -> None:
    reranker = RecordingReranker({"passage c4": 2.0, "passage c5": 3.0})
    # rerank_top above the candidate count: every candidate is reranked, no warning.
    wide = SearchService(_six(), reranker=reranker, limits=SearchLimits(rerank_top=50, results=4))
    result = wide.search("q", _scope())
    assert reranker.seen[-1] == [f"passage c{i}" for i in range(6)]
    assert _ids(result) == ["c5", "c4", "c0", "c1"]
    assert result.warnings == ()
    # rerank_top below: the tail is never seen, so it cannot be promoted.
    narrow = SearchService(_six(), reranker=reranker, limits=SearchLimits(rerank_top=4))
    assert _ids(narrow.search("q", _scope())) == ["c0", "c1", "c2", "c3"]
    assert reranker.seen[-1] == [f"passage c{i}" for i in range(4)]
    # The reranker sees the passage content, not the breadcrumb-prefixed search_text.
    crumbed = _child("x").model_copy(update={"search_text": "Ch > Sec\nbody", "content": "body"})
    SearchService(CannedStore([Candidate(crumbed, 1.0)], []), reranker=reranker).search(
        "q", _scope(), mode="keyword"
    )
    assert reranker.seen[-1] == ["body"]


def test_limits_are_validated_and_capped(memory_store: QdrantIndexStore) -> None:
    with pytest.raises(ValueError, match="results"):
        SearchLimits(results=0)
    with pytest.raises(ValueError, match="rrf_k"):
        SearchLimits(rrf_k=-1)
    store = RecordingStore(memory_store)
    result = SearchService(
        store, limits=SearchLimits(results=10_000, dense_candidates=10_000)
    ).search("water", _scope(), mode="semantic")
    assert store.calls[0][2] == 200
    assert "results capped at 100" in result.warnings
    assert len(result.hits) <= MAX_RESULTS


def test_parent_context_is_attached_on_request(memory_store: QdrantIndexStore) -> None:
    result = SearchService(memory_store).search(
        "chlorine", _scope(), mode="keyword", with_parents=True
    )
    assert result.hits
    for item in result.hits:
        assert item.parent is not None
        assert item.parent.id == item.chunk.parent_id
        assert item.parent.level is ChunkLevel.PARENT
        assert item.hit.passage == item.chunk.content
    assert all(
        h.parent is None for h in SearchService(memory_store).search("chlorine", _scope()).hits
    )


# --- seed set ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class SeedMetrics:
    recall_at_5: float
    mrr: float
    per_query: Mapping[str, tuple[float, float]]


def _seed_metrics(service: SearchService, mode: SearchMode, scope: SearchScope) -> SeedMetrics:
    per_query: dict[str, tuple[float, float]] = {}
    for query in SEED:
        relevant = {(r["fixture_id"], r["section_id"]) for r in query["relevant"]}
        result = service.search(query["query"], scope, mode=mode)
        judged = [
            (h.hit.document_id, SECTION_MAP[(h.hit.document_id, h.hit.section_id or "")])
            for h in result.hits
        ]
        recall = len(relevant & set(judged[:5])) / len(relevant)
        rr = next((1 / rank for rank, j in enumerate(judged, 1) if j in relevant), 0.0)
        per_query[query["id"]] = (recall, rr)
    n = len(per_query)
    return SeedMetrics(
        recall_at_5=sum(r for r, _ in per_query.values()) / n,
        mrr=sum(m for _, m in per_query.values()) / n,
        per_query=per_query,
    )


def _check_keyword_cases(store: QdrantIndexStore) -> None:
    service = SearchService(store)
    for book, query, section in KEYWORD_CASES:
        result = service.search(
            query, _scope(), mode="keyword", filters=SearchFilters(document_ids=(book,))
        )
        top = result.hits[0].hit
        assert SECTION_MAP[(book, top.section_id or "")] == section, (book, query)


def _check_hybrid_not_worse(store: QdrantIndexStore) -> tuple[SeedMetrics, SeedMetrics]:
    service = SearchService(store)
    keyword = _seed_metrics(service, SearchMode.KEYWORD, _scope())
    hybrid = _seed_metrics(service, SearchMode.HYBRID, _scope())
    print(f"seed keyword R@5={keyword.recall_at_5:.3f} MRR={keyword.mrr:.3f}")
    print(f"seed hybrid  R@5={hybrid.recall_at_5:.3f} MRR={hybrid.mrr:.3f}")
    assert hybrid.recall_at_5 >= keyword.recall_at_5
    assert hybrid.mrr >= keyword.mrr
    return keyword, hybrid


def test_keyword_search_finds_seed_keyword_cases(memory_store: QdrantIndexStore) -> None:
    _check_keyword_cases(memory_store)


def test_hybrid_is_not_worse_than_keyword_on_the_seed_set(memory_store: QdrantIndexStore) -> None:
    _check_hybrid_not_worse(memory_store)


# --- real Qdrant -------------------------------------------------------------------------------


@pytest.fixture
def server_store() -> Iterator[QdrantIndexStore]:
    url = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
    client = QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY") or None, timeout=10)
    try:
        client.get_collections()
    except Exception as exc:
        client.close()
        reason = f"Qdrant not reachable at {url} ({exc.__class__.__name__}); run `make infra-up`"
        if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    prefix = f"test_{uuid.uuid4().hex}_"
    store = QdrantIndexStore(client, FakeEmbedder(), names=CollectionNames(prefix=prefix))
    try:
        _index(store)
        yield store
    finally:
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
        client.close()


@pytest.mark.infra
def test_search_on_the_server_keyword_cases_and_hybrid(server_store: QdrantIndexStore) -> None:
    _check_keyword_cases(server_store)
    _check_hybrid_not_worse(server_store)


@pytest.mark.infra
def test_search_on_the_server_enforces_scope_and_filters(server_store: QdrantIndexStore) -> None:
    service = SearchService(server_store, limits=SearchLimits(results=50))
    sections = REVISIONS["book-ko"].sections
    result = service.search(
        "물",
        _scope(),
        filters=SearchFilters(chapter_ids=("sec-ch1-heading",), languages=("ko",)),
        sections=sections,
    )
    assert result.hits
    assert {h.hit.document_id for h in result.hits} == {"book-ko"}
    assert {h.chapter_id for h in result.hits} == {"sec-ch1-heading"}
    assert service.search("물", _scope("r1", workspace=OTHER_WS)).hits == ()
    assert service.search("물", _scope("r2")).hits == ()


# --- real models -------------------------------------------------------------------------------


def _qwen3() -> Embedder:
    from book_core.embedding import Qwen3Embedder, Qwen3EmbedderConfig

    return Qwen3Embedder(Qwen3EmbedderConfig(dimension=256))


@pytest.fixture(scope="module")
def qwen3_store() -> Iterator[QdrantIndexStore]:
    client = QdrantClient(":memory:")
    store = QdrantIndexStore(client, _qwen3())
    _index(store)
    yield store
    client.close()


def _seed_report(
    service: SearchService, modes: Sequence[SearchMode]
) -> dict[str, dict[str, float]]:
    """Seed metrics over both books (``<mode>``) and per direction, one book at a time
    (``<mode> <query language>-><book language>``)."""
    report: dict[str, dict[str, float]] = {}
    for mode in modes:
        metrics = _seed_metrics(service, mode, _scope())
        report[mode.value] = {"R@5": metrics.recall_at_5, "MRR": metrics.mrr}
        for query in SEED:
            for book, lang in (("book-ko", "ko"), ("book-en", "en")):
                result = service.search(
                    query["query"],
                    _scope(),
                    mode=mode,
                    filters=SearchFilters(document_ids=(book,)),
                )
                relevant = {r["section_id"] for r in query["relevant"] if r["fixture_id"] == book}
                judged = [SECTION_MAP[(book, h.hit.section_id or "")] for h in result.hits]
                rr = next((1 / k for k, s in enumerate(judged, 1) if s in relevant), 0.0)
                bucket = report.setdefault(f"{mode.value} {query['language']}->{lang}", {})
                bucket["MRR"] = bucket.get("MRR", 0.0) + rr / 3
                bucket["R@5"] = bucket.get("R@5", 0.0) + (bool(relevant & set(judged[:5]))) / 3
    return report


DIRECTIONS = ("ko->ko", "ko->en", "en->ko", "en->en")


@pytest.mark.models
def test_search_seed_with_qwen3_hybrid(qwen3_store: QdrantIndexStore) -> None:
    report = _seed_report(SearchService(qwen3_store), list(SearchMode))
    print(json.dumps(report, indent=1, sort_keys=True))
    assert report["hybrid"]["R@5"] >= SEED_QWEN3_MIN["hybrid R@5"]
    assert report["hybrid"]["MRR"] >= SEED_QWEN3_MIN["hybrid MRR"]
    for direction in DIRECTIONS:
        assert report[f"hybrid {direction}"]["R@5"] == 1.0, direction


@pytest.mark.models
def test_qwen3_reranker_lifts_hybrid_on_the_seed_set(qwen3_store: QdrantIndexStore) -> None:
    from book_core.reranker import Qwen3Reranker

    modes = (SearchMode.SEMANTIC, SearchMode.HYBRID)
    plain = _seed_report(SearchService(qwen3_store), modes)
    reranked = _seed_report(SearchService(qwen3_store, reranker=Qwen3Reranker()), modes)
    print(json.dumps({"plain": plain, "reranked": reranked}, indent=1, sort_keys=True))
    for mode in ("semantic", "hybrid"):
        assert reranked[mode]["R@5"] >= SEED_RERANK_MIN[f"{mode} R@5"], mode
        assert reranked[mode]["MRR"] >= SEED_RERANK_MIN[f"{mode} MRR"], mode
        assert reranked[mode]["MRR"] >= plain[mode]["MRR"], mode
        assert reranked[mode]["R@5"] >= plain[mode]["R@5"], mode
        for direction in DIRECTIONS:
            assert reranked[f"{mode} {direction}"]["R@5"] == 1.0, (mode, direction)
    # Over both books the reranker restores the cross-language section RRF pushed out.
    assert reranked["hybrid"]["R@5"] > plain["hybrid"]["R@5"]


SEED_QWEN3_MIN = {"hybrid R@5": 0.66, "hybrid MRR": 0.9}
# Measured with Qwen3-Reranker-0.6B on `content`: semantic and hybrid R@5 1.000 / MRR 0.917.
SEED_RERANK_MIN = {"semantic R@5": 1.0, "semantic MRR": 0.9, "hybrid R@5": 1.0, "hybrid MRR": 0.9}
