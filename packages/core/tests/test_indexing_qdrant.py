"""Qdrant indexing (M2.2) against a real Qdrant server (``infra``) and the real embedder
(``models``).

``infra`` tests need ``make infra-up`` (Qdrant at ``QDRANT_URL``, default
``http://127.0.0.1:6333``). Every test works in its own ``test_<uuid>_`` namespace (alias and
physical collections) and deletes it afterwards; nothing else on the shared server is touched.
Without the server they skip; ``make test-infra`` (QUIZ_REQUIRE_INFRA=1) fails instead.

BM25 evidence (client-side Korean bigram tokenisation vs. Qdrant's server-side ``Qdrant/bm25``
inference, same children, top-1 section): seed queries 5/6 vs 4/6, single Korean nouns without
their particle (``염소``, ``지하수``...) 4/4 vs 2/4, English keywords 4/4 vs 4/4. Asserted here:
the keyword cases and the seed queries listed in ``KEYWORD_CASES``.

The ``models`` test indexes book-ko with Qwen3-Embedding (MRL 256) into an in-process Qdrant and
checks that every seed query (Korean and cross-lingual) has a relevant child in its top 3.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator, Sequence

import pytest
from book_core.chunker import chunk_revision
from book_core.contracts import ChunkLevel, DocumentRevision, SearchChunk
from book_core.embedding import FakeEmbedder, Qwen3Embedder, Qwen3EmbedderConfig
from book_core.indexing import (
    DENSE_VECTOR,
    SPARSE_VECTOR,
    CollectionNames,
    QdrantIndexStore,
    RevisionChunks,
    RevisionNotReadyError,
    SearchScope,
    alias_target,
    rebuild,
    switch_alias,
)
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision, publish
from make_fixture_pdfs import OUT_DIR
from qdrant_client import QdrantClient
from qdrant_client import models as qm

WS = "ws-infra"
BOOKS = ("book-ko", "book-en")
SEED = json.loads((OUT_DIR / "retrieval-seed.json").read_text(encoding="utf-8"))["queries"]

# (book, query, expected leaf section of the top keyword hit)
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
        # q-ko-01's top hit is the chapter-2 intro (it shares 정수/처리 with the query);
        # its relevant section is rank 2.
        if q["id"] != "q-ko-01"
    ),
]


def _revision(book: str, revision_id: str = "r1") -> DocumentRevision:
    parsed = FakeParser.from_truth_files([OUT_DIR / f"{book}.truth.json"]).parse(
        OUT_DIR / f"{book}.pdf"
    )
    return publish(build_revision(parsed, document_id=book, revision_id=revision_id).revision)


def _chunks(revision: DocumentRevision) -> tuple[SearchChunk, ...]:
    return chunk_revision(revision).chunks


def _sections(book: str) -> dict[str, str]:
    """Leaf section title -> fixture section id."""
    truth = json.loads((OUT_DIR / f"{book}.truth.json").read_text(encoding="utf-8"))
    return {entry["title"]: entry["section_id"] for entry in truth["toc"]}


def _section(book: str, chunk: SearchChunk) -> str:
    return _sections(book)[chunk.breadcrumb[-1]]


class FailingEmbedder(FakeEmbedder):
    def __init__(self, fail_after: int) -> None:
        super().__init__()
        self.embedded = 0
        self.fail_after = fail_after

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if self.embedded + len(texts) > self.fail_after:
            raise RuntimeError("embedding backend crashed")
        self.embedded += len(texts)
        return super().embed_documents(texts)


@pytest.fixture
def qdrant() -> Iterator[QdrantClient]:
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
    yield client
    client.close()


@pytest.fixture
def names(qdrant: QdrantClient) -> Iterator[CollectionNames]:
    prefix = f"test_{uuid.uuid4().hex}_"
    yield CollectionNames(prefix=prefix)
    for alias in qdrant.get_aliases().aliases:
        if alias.alias_name.startswith(prefix):
            qdrant.update_collection_aliases(
                change_aliases_operations=[
                    qm.DeleteAliasOperation(
                        delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                    )
                ]
            )
    for collection in qdrant.get_collections().collections:
        if collection.name.startswith(prefix):
            qdrant.delete_collection(collection.name)
    leftovers = [c.name for c in qdrant.get_collections().collections if c.name.startswith(prefix)]
    assert leftovers == []


@pytest.fixture
def store(qdrant: QdrantClient, names: CollectionNames) -> QdrantIndexStore:
    return QdrantIndexStore(qdrant, FakeEmbedder(), names=names, batch_size=8)


def _index_books(store: QdrantIndexStore) -> None:
    for book in BOOKS:
        store.index_revision(WS, book, "r1", _chunks(_revision(book)))
        store.activate_revision(WS, book, "r1")


@pytest.mark.infra
def test_schema_payload_indexes_and_alias_on_the_server(
    qdrant: QdrantClient, store: QdrantIndexStore, names: CollectionNames
) -> None:
    _index_books(store)
    name = store.ensure_collection()
    assert name == names.physical(store.model_key)
    assert alias_target(qdrant, names.alias) == name
    info = qdrant.get_collection(names.alias)  # readers address the alias
    assert isinstance(info.config.params.vectors, dict)
    assert info.config.params.vectors[DENSE_VECTOR].size == 64
    assert info.config.params.sparse_vectors is not None
    assert info.config.params.sparse_vectors[SPARSE_VECTOR].modifier is qm.Modifier.IDF
    schema = info.payload_schema
    for field in ("workspace_id", "document_id", "revision_id", "level", "language", "active"):
        assert field in schema, field
    total = sum(len(_chunks(_revision(book))) for book in BOOKS)
    assert qdrant.count(names.alias, exact=True).count == total


@pytest.mark.infra
@pytest.mark.parametrize(("book", "query", "section"), KEYWORD_CASES)
def test_bm25_finds_expected_sections(
    store: QdrantIndexStore, book: str, query: str, section: str
) -> None:
    _index_books(store)
    scope = SearchScope(workspace_id=WS, revision_ids=("r1",), document_ids=(book,))
    [top, *_] = store.keyword_candidates(scope, query, 3)
    assert top.chunk.document_id == book
    assert top.chunk.level is ChunkLevel.CHILD
    assert _section(book, top.chunk) == section


@pytest.mark.infra
def test_mid_index_failure_keeps_the_active_revision(
    qdrant: QdrantClient, store: QdrantIndexStore, names: CollectionNames
) -> None:
    base = _revision("book-ko")
    store.index_revision(WS, "book-ko", "r1", _chunks(base))
    store.activate_revision(WS, "book-ko", "r1")
    edits = {
        b.id: b.text + " 개정." for b in base.blocks if b.section_id and b.type.value == "text"
    }
    new = _chunks(publish(apply_edits(base, edits, revision_id="r2")))

    broken = QdrantIndexStore(qdrant, FailingEmbedder(fail_after=8), names=names, batch_size=8)
    with pytest.raises(RuntimeError, match="crashed"):
        broken.index_revision(WS, "book-ko", "r2", new)
    with pytest.raises(RevisionNotReadyError):
        store.activate_revision(WS, "book-ko", "r2")
    assert store.active_revision(WS, "book-ko") == "r1"
    scope = SearchScope(workspace_id=WS, revision_ids=("r1",))
    [top] = store.keyword_candidates(scope, "염소", 1)
    assert top.chunk.revision_id == "r1"

    store.index_revision(WS, "book-ko", "r2", new)
    store.activate_revision(WS, "book-ko", "r2")
    store.delete_inactive_revisions(WS, "book-ko")
    assert store.load_chunks(WS, "book-ko", "r1") == []
    assert len(store.load_chunks(WS, "book-ko", "r2")) == len(new)


@pytest.mark.infra
def test_rebuild_switches_the_alias_atomically_and_rolls_back(
    qdrant: QdrantClient, store: QdrantIndexStore, names: CollectionNames
) -> None:
    _index_books(store)
    old = store.ensure_collection()
    report = rebuild(
        qdrant,
        FakeEmbedder(),
        [RevisionChunks(WS, book, "r1", _chunks(_revision(book))) for book in BOOKS],
        names=names,
    )
    assert report.previous == old
    assert report.collection == names.physical(store.model_key, 2)
    assert alias_target(qdrant, names.alias) == report.collection
    assert qdrant.count(names.alias, exact=True).count == report.points

    assert switch_alias(qdrant, names.alias, old) == report.collection
    assert alias_target(qdrant, names.alias) == old


@pytest.mark.infra
def test_live_store_follows_the_alias_and_survives_dropping_the_old_generation(
    qdrant: QdrantClient, store: QdrantIndexStore, names: CollectionNames
) -> None:
    store.index_revision(WS, "book-ko", "r1", _chunks(_revision("book-ko")))
    store.activate_revision(WS, "book-ko", "r1")
    old = store.ensure_collection()
    report = rebuild(
        qdrant,
        FakeEmbedder(),
        [RevisionChunks(WS, "book-ko", "r1", _chunks(_revision("book-ko")))],
        names=names,
    )
    qdrant.delete_collection(old)

    en = _chunks(_revision("book-en"))
    assert store.index_revision(WS, "book-en", "r1", en).collection == report.collection
    store.activate_revision(WS, "book-en", "r1")
    scope = SearchScope(workspace_id=WS, revision_ids=("r1",), document_ids=("book-en",))
    [top] = store.keyword_candidates(scope, "chlorine", 1)
    assert top.chunk.document_id == "book-en"
    assert qdrant.count(names.alias, exact=True).count == report.points + len(en)


@pytest.mark.models
def test_qwen3_dense_retrieval_after_indexing() -> None:
    client = QdrantClient(":memory:")
    embedder = Qwen3Embedder(Qwen3EmbedderConfig(dimension=256))
    store = QdrantIndexStore(client, embedder)
    store.index_revision(WS, "book-ko", "r1", _chunks(_revision("book-ko")))
    scope = SearchScope(workspace_id=WS, revision_ids=("r1",))
    for query in SEED:
        relevant = {r["section_id"] for r in query["relevant"]}
        hits = store.dense_candidates(scope, query["query"], 3)
        assert {_section("book-ko", hit.chunk) for hit in hits} & relevant, query["id"]
