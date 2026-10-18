"""Search without the dense side (M7.4b, SEARCH-01-AC06): an unavailable query embedder degrades
hybrid/semantic search to BM25 instead of failing; index errors still fail."""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence

import pytest
from book_core.chunker import chunk_revision
from book_core.contracts import ScoreType, SearchMode
from book_core.embedding import (
    EmbeddingQuotaExceededError,
    EmbeddingUnavailableError,
    FakeEmbedder,
)
from book_core.indexing import IndexStoreError, QdrantIndexStore, SearchScope
from book_core.parser import FakeParser
from book_core.search import DEGRADED_DENSE_UNAVAILABLE, SearchService
from book_core.structure import build_revision, publish
from make_fixture_pdfs import OUT_DIR
from qdrant_client import QdrantClient

WS = "ws-degrade"
QUERY = "chlorine disinfection"


class SwitchableEmbedder(FakeEmbedder):
    """FakeEmbedder whose query side can be made to fail (documents always work)."""

    def __init__(self) -> None:
        super().__init__()
        self.failure: Exception | None = None
        self.queries: list[str] = []

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return super().embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        self.queries.append(text)
        if self.failure is not None:
            raise self.failure
        return super().embed_query(text)


@pytest.fixture(scope="module")
def indexed() -> Iterator[tuple[QdrantIndexStore, SwitchableEmbedder]]:
    parsed = FakeParser.from_truth_files([OUT_DIR / "book-en.truth.json"]).parse(
        OUT_DIR / "book-en.pdf"
    )
    revision = publish(build_revision(parsed, document_id="book-en", revision_id="r1").revision)
    embedder = SwitchableEmbedder()
    client = QdrantClient(":memory:")
    store = QdrantIndexStore(client, embedder)
    store.index_revision(WS, "book-en", "r1", list(chunk_revision(revision).chunks))
    store.activate_revision(WS, "book-en", "r1")
    yield store, embedder
    client.close()


@pytest.fixture
def service(indexed: tuple[QdrantIndexStore, SwitchableEmbedder]) -> Iterator[SearchService]:
    store, embedder = indexed
    embedder.failure = None
    yield SearchService(store)
    embedder.failure = None


SCOPE = SearchScope(workspace_id=WS, revision_ids=("r1",))


def test_healthy_hybrid_search_is_not_degraded(service: SearchService) -> None:
    result = service.search(QUERY, SCOPE, mode=SearchMode.HYBRID)
    assert result.degraded == ()
    assert result.hits
    assert {h.hit.score_type for h in result.hits} == {ScoreType.RRF}


@pytest.mark.parametrize("mode", [SearchMode.HYBRID, SearchMode.SEMANTIC])
@pytest.mark.parametrize(
    "failure",
    [EmbeddingUnavailableError("down"), EmbeddingQuotaExceededError("quota")],
)
def test_unavailable_query_embedding_falls_back_to_keyword_results(
    service: SearchService,
    indexed: tuple[QdrantIndexStore, SwitchableEmbedder],
    mode: SearchMode,
    failure: Exception,
    caplog: pytest.LogCaptureFixture,
) -> None:
    keyword = service.search(QUERY, SCOPE, mode=SearchMode.KEYWORD)
    indexed[1].failure = failure
    caplog.set_level(logging.DEBUG)

    result = service.search(QUERY, SCOPE, mode=mode)

    assert result.degraded == (DEGRADED_DENSE_UNAVAILABLE,)
    assert DEGRADED_DENSE_UNAVAILABLE == "dense_unavailable"
    assert result.mode is mode
    assert [h.hit.chunk_id for h in result.hits] == [h.hit.chunk_id for h in keyword.hits]
    assert {h.hit.score_type for h in result.hits} == {ScoreType.BM25}
    assert "bm25" in result.candidates
    assert "cosine" not in result.candidates
    # One WARNING with the error type/code, never the query.
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "chlorine" not in caplog.text
    assert type(failure).__name__ in warnings[0].getMessage()


def test_keyword_search_never_touches_the_embedder(
    service: SearchService, indexed: tuple[QdrantIndexStore, SwitchableEmbedder]
) -> None:
    _store, embedder = indexed
    embedder.failure = EmbeddingUnavailableError("down")
    embedder.queries.clear()
    result = service.search(QUERY, SCOPE, mode=SearchMode.KEYWORD)
    assert result.degraded == ()
    assert embedder.queries == []


def test_other_failures_are_not_swallowed(
    service: SearchService, indexed: tuple[QdrantIndexStore, SwitchableEmbedder]
) -> None:
    indexed[1].failure = IndexStoreError("qdrant down")
    with pytest.raises(IndexStoreError):
        service.search(QUERY, SCOPE, mode=SearchMode.HYBRID)
    indexed[1].failure = RuntimeError("bug")
    with pytest.raises(RuntimeError):
        service.search(QUERY, SCOPE, mode=SearchMode.SEMANTIC)
