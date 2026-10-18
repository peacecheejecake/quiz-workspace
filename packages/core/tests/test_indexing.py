"""Qdrant indexing (M2.2) on qdrant-client's in-process local mode: no server, no model.

Covers the collection schema, payload, deterministic point ids, incremental re-index from a base
revision, activation/rollback semantics, mid-index failure, the mandatory read scope, retries,
alias switching and rebuilds. Tests against a real Qdrant server live in
``test_indexing_qdrant.py`` (``infra`` marker).
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from decimal import Decimal
from fractions import Fraction

import pytest
from book_core.chunker import ChunkerConfig, chunk_revision, diff_chunks
from book_core.contracts import ChunkLevel, DocumentRevision, SearchChunk
from book_core.embedding import FakeEmbedder
from book_core.indexing import (
    BM25_VERSION,
    DENSE_VECTOR,
    SPARSE_VECTOR,
    Bm25Encoder,
    CollectionNames,
    IndexSchemaError,
    IndexStore,
    QdrantIndexStore,
    RetryPolicy,
    RevisionChunks,
    RevisionNotReadyError,
    SearchScope,
    alias_target,
    chunk_from_payload,
    is_transient,
    model_key,
    point_id,
    rebuild,
    scope_filter,
    switch_alias,
    tokenize,
)
from book_core.indexing.sparse import term_index
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision, publish
from make_fixture_pdfs import OUT_DIR
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse

WS = "ws-a"
OTHER_WS = "ws-b"
SMALL = ChunkerConfig(target_tokens=64, max_tokens=96, overlap_tokens=24, parent_max_tokens=208)


# --- helpers ---------------------------------------------------------------------------------


def _revision(book: str, document_id: str, revision_id: str = "r1") -> DocumentRevision:
    parsed = FakeParser.from_truth_files([OUT_DIR / f"{book}.truth.json"]).parse(
        OUT_DIR / f"{book}.pdf"
    )
    return publish(
        build_revision(parsed, document_id=document_id, revision_id=revision_id).revision
    )


def _chunks(revision: DocumentRevision) -> tuple[SearchChunk, ...]:
    return chunk_revision(revision, config=SMALL).chunks


def _edited(base: DocumentRevision, revision_id: str = "r2") -> DocumentRevision:
    """One paragraph of the second section edited (same length)."""
    target = next(
        b
        for b in base.blocks
        if b.section_id is not None and b.type.value == "text" and "물" in b.text
    )
    return publish(
        apply_edits(base, {target.id: target.text.replace("물", "비", 1)}, revision_id=revision_id)
    )


class CountingEmbedder(FakeEmbedder):
    """FakeEmbedder that counts embedded texts and can fail after ``fail_after`` texts."""

    def __init__(self, fail_after: int | None = None, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.embedded = 0
        self.fail_after = fail_after

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if self.fail_after is not None and self.embedded + len(texts) > self.fail_after:
            raise RuntimeError("embedding backend crashed")
        self.embedded += len(texts)
        return super().embed_documents(texts)


@pytest.fixture
def client() -> Iterator[QdrantClient]:
    qdrant = QdrantClient(":memory:")
    yield qdrant
    qdrant.close()


@pytest.fixture
def embedder() -> CountingEmbedder:
    return CountingEmbedder()


@pytest.fixture
def store(client: QdrantClient, embedder: CountingEmbedder) -> QdrantIndexStore:
    return QdrantIndexStore(client, embedder, batch_size=4)


def _scope(*revisions: str, workspace: str = WS) -> SearchScope:
    return SearchScope(workspace_id=workspace, revision_ids=revisions)


def _records(store: QdrantIndexStore, client: QdrantClient, revision: str) -> list[qm.Record]:
    flt = qm.Filter(
        must=[qm.FieldCondition(key="revision_id", match=qm.MatchValue(value=revision))]
    )
    records, _ = client.scroll(
        store.ensure_collection(), scroll_filter=flt, limit=1000, with_vectors=True
    )
    return records


# --- BM25 tokenisation -----------------------------------------------------------------------


def test_korean_runs_become_bigrams_so_particles_do_not_block_matches() -> None:
    assert tokenize("염소를") == ["염소", "소를"]
    assert set(tokenize("염소")) <= set(tokenize("정수장에서는 염소를 넣는다"))
    assert tokenize("물") == ["물"]


def test_english_words_are_casefolded_and_stopwords_dropped() -> None:
    assert tokenize("The Coagulant is added to WATER") == ["coagulant", "added", "water"]


def test_mixed_scripts_split_at_script_boundaries_and_nfkc() -> None:
    assert tokenize("Qdrant의 BM25검색") == ["qdrant", "의", "bm25", "검색"]
    assert tokenize("\uff21\uff22\uff23") == ["abc"]  # full-width folded by NFKC
    assert tokenize("snake_case") == ["snake", "case"]
    assert tokenize("... — !!") == []


def test_term_index_is_stable_uint32() -> None:
    assert term_index("염소") == term_index("염소")
    assert term_index("염소") != term_index("소독")
    assert 0 <= term_index("water") < 2**32


def test_bm25_document_weights_saturate_and_normalise_length() -> None:
    encoder = Bm25Encoder()
    once = encoder.encode_document("water")
    twice = encoder.encode_document("water water")
    assert list(once.indices) == sorted(once.indices) == [term_index("water")]
    assert once.values[0] < twice.values[0] < (encoder.k1 + 1)
    long_doc = encoder.encode_document("water " + "filler " * 400)
    assert long_doc.values[long_doc.indices.index(term_index("water"))] < once.values[0]
    assert encoder.encode_document("water") == once  # deterministic


def test_bm25_query_has_unit_weights_per_distinct_term() -> None:
    query = Bm25Encoder().encode_query("water water cloud")
    assert sorted(query.indices) == sorted({term_index("water"), term_index("cloud")})
    assert set(query.values) == {1.0}


def test_bm25_encoder_rejects_bad_parameters() -> None:
    with pytest.raises(ValueError, match="k1"):
        Bm25Encoder(b=2)


# --- naming ------------------------------------------------------------------------------------


def test_model_key_identifies_model_dimension_and_is_collection_safe() -> None:
    key = model_key("Qwen/Qwen3-Embedding-0.6B@abc/mrl-256", 256)
    assert key.startswith("qwen-qwen3-embedding-0-6b-abc-mrl-256-d256-")
    assert key == model_key("Qwen/Qwen3-Embedding-0.6B@abc/mrl-256", 256)
    assert key != model_key("Qwen/Qwen3-Embedding-0.6B@abc/mrl-256", 128)
    assert key != model_key("Qwen/Qwen3-Embedding-0.6B@abd/mrl-256", 256)
    assert all(ch.isalnum() or ch == "-" for ch in key)


def test_collection_names_alias_physical_and_prefix() -> None:
    names = CollectionNames(prefix="test_x_")
    assert names.alias == "test_x_documents_v1"
    assert names.physical("k") == "test_x_documents_v1__k"
    assert names.physical("k", 2) == "test_x_documents_v1__k__g2"
    assert names.owns("test_x_documents_v1__k__g2")
    assert CollectionNames().alias == "documents_v1"
    with pytest.raises(ValueError, match="letters"):
        CollectionNames(prefix="bad prefix")


# --- schema and payload ------------------------------------------------------------------------


def test_collection_schema_dense_sparse_metadata_and_alias(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    protocol: IndexStore = store  # QdrantIndexStore satisfies the protocol (mypy)
    assert protocol is store
    name = store.ensure_collection()
    assert name == f"documents_v1__{store.model_key}"
    assert alias_target(client, "documents_v1") == name
    params = client.get_collection(name).config.params
    assert isinstance(params.vectors, dict)
    dense = params.vectors[DENSE_VECTOR]
    assert (dense.size, dense.distance) == (64, qm.Distance.COSINE)
    assert params.sparse_vectors is not None
    assert params.sparse_vectors[SPARSE_VECTOR].modifier is qm.Modifier.IDF
    metadata = client.get_collection(name).config.metadata or {}
    assert metadata["model_key"] == store.model_key
    assert metadata["model_name"] == "fake-embedder"
    assert metadata["sparse"] == BM25_VERSION


def test_store_refuses_a_collection_of_another_vector_space(client: QdrantClient) -> None:
    first = QdrantIndexStore(client, FakeEmbedder(dimension=64))
    name = first.ensure_collection()
    other = QdrantIndexStore(client, FakeEmbedder(dimension=32), collection=name)
    with pytest.raises(IndexSchemaError, match="model key"):
        other.ensure_collection()
    # Without a pinned collection, another model gets its own physical collection.
    second = QdrantIndexStore(client, FakeEmbedder(dimension=32))
    assert second.ensure_collection() != name
    assert alias_target(client, "documents_v1") == name


def test_payload_and_vectors_children_dense_sparse_parents_context_only(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    chunks = _chunks(_revision("book-ko", "doc-ko"))
    report = store.index_revision(WS, "doc-ko", "r1", chunks)
    children = [c for c in chunks if c.level is ChunkLevel.CHILD]
    parents = [c for c in chunks if c.level is ChunkLevel.PARENT]
    assert (report.embedded, report.parents_written, report.reused) == (
        len(children),
        len(parents),
        0,
    )
    records = {str(r.id): r for r in _records(store, client, "r1")}
    assert len(records) == len(chunks)
    for chunk in chunks:
        record = records[point_id(store.model_key, WS, "doc-ko", "r1", chunk.id)]
        payload = record.payload or {}
        assert payload["workspace_id"] == WS
        assert payload["document_id"] == "doc-ko"
        assert payload["revision_id"] == "r1"
        assert payload["chunk_id"] == chunk.id
        assert payload["parent_id"] == chunk.parent_id
        assert payload["level"] == chunk.level.value
        assert payload["section_id"] == chunk.section_id
        assert payload["language"] == chunk.language == "ko"
        assert payload["block_ids"] == list(chunk.block_ids)
        assert payload["pages"] == sorted({loc.page for loc in chunk.locations})
        assert payload["content_hash"] == chunk.content_hash
        assert payload["model"] == "fake-embedder"
        assert payload["revision_size"] == len(chunks)
        assert payload["active"] is False
        assert chunk_from_payload(payload) == chunk
        vector = record.vector
        if chunk.level is ChunkLevel.PARENT:
            assert not vector
        else:
            assert isinstance(vector, dict)
            assert vector[DENSE_VECTOR] == pytest.approx(
                FakeEmbedder().embed_documents([chunk.search_text])[0], abs=1e-6
            )
            sparse = vector[SPARSE_VECTOR]
            assert isinstance(sparse, qm.SparseVector)
            expected = Bm25Encoder().encode_document(chunk.search_text)
            assert sorted(sparse.indices) == list(expected.indices)
    assert store.load_chunks(WS, "doc-ko", "r1") == [*parents, *children]


def test_index_rejects_chunks_of_another_revision_or_duplicates(store: QdrantIndexStore) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    with pytest.raises(ValueError, match="another document or revision"):
        store.index_revision(WS, "doc-en", "r2", chunks)
    with pytest.raises(ValueError, match="duplicate"):
        store.index_revision(WS, "doc-en", "r1", [chunks[0], chunks[0]])
    with pytest.raises(ValueError, match="workspace_id"):
        store.index_revision("", "doc-en", "r1", chunks)


# --- ids and idempotency -----------------------------------------------------------------------


def test_point_ids_are_deterministic_and_scoped() -> None:
    base = point_id("k", WS, "d", "r1", "c1")
    assert base == point_id("k", WS, "d", "r1", "c1")
    assert (
        len(
            {
                base,
                point_id("k2", WS, "d", "r1", "c1"),
                point_id("k", OTHER_WS, "d", "r1", "c1"),
                point_id("k", WS, "d2", "r1", "c1"),
                point_id("k", WS, "d", "r2", "c1"),
                point_id("k", WS, "d", "r1", "c2"),
            }
        )
        == 6
    )


def test_reindexing_the_same_revision_is_a_noop(
    client: QdrantClient, store: QdrantIndexStore, embedder: CountingEmbedder
) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    store.index_revision(WS, "doc-en", "r1", chunks)
    embedded = embedder.embedded
    before = {str(r.id): r for r in _records(store, client, "r1")}
    again = store.index_revision(WS, "doc-en", "r1", chunks)
    assert again.is_noop
    assert again.unchanged == len(chunks)
    assert embedder.embedded == embedded
    after = {str(r.id): r for r in _records(store, client, "r1")}
    assert after == before


def test_reindexing_refreshes_payload_only_where_it_differs(
    store: QdrantIndexStore, embedder: CountingEmbedder
) -> None:
    chunks = list(_chunks(_revision("book-en", "doc-en")))
    store.index_revision(WS, "doc-en", "r1", chunks)
    store.activate_revision(WS, "doc-en", "r1")
    embedded = embedder.embedded
    # Ordinal is excluded from content_hash: only the payload changes.
    shifted = [c.model_copy(update={"ordinal": (c.ordinal or 0) + 100}) for c in chunks]
    report = store.index_revision(WS, "doc-en", "r1", shifted)
    assert (report.refreshed, report.embedded, report.reused) == (len(chunks), 0, 0)
    assert embedder.embedded == embedded
    loaded = store.load_chunks(WS, "doc-en", "r1")
    assert {c.id: c.ordinal for c in loaded} == {c.id: c.ordinal for c in shifted}
    assert store.active_revision(WS, "doc-en") == "r1"  # active flag kept on refresh


def test_reindexing_with_fewer_chunks_deletes_stale_points(store: QdrantIndexStore) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    store.index_revision(WS, "doc-en", "r1", chunks)
    children = [c for c in chunks if c.level is ChunkLevel.CHILD]
    report = store.index_revision(WS, "doc-en", "r1", children)
    assert report.deleted_stale == len(chunks) - len(children)
    assert {c.id for c in store.load_chunks(WS, "doc-en", "r1")} == {c.id for c in children}


# --- incremental re-index, activation and rollback ---------------------------------------------


def test_new_revision_reuses_vectors_of_unchanged_chunks_and_keeps_the_old_revision(
    client: QdrantClient, store: QdrantIndexStore, embedder: CountingEmbedder
) -> None:
    base = _revision("book-ko", "doc-ko")
    old = _chunks(base)
    store.index_revision(WS, "doc-ko", "r1", old)
    store.activate_revision(WS, "doc-ko", "r1")
    new = _chunks(_edited(base))
    expected = diff_chunks(old, new)
    assert expected.changed
    assert expected.unchanged
    assert not expected.is_empty

    embedded = embedder.embedded
    report = store.index_revision(WS, "doc-ko", "r2", new)
    assert report.base_revision_id == "r1"
    assert report.diff == expected
    by_id = {c.id: c for c in new}
    changed_children = [i for i in expected.reindex_ids if by_id[i].level is ChunkLevel.CHILD]
    unchanged_children = [i for i in expected.unchanged if by_id[i].level is ChunkLevel.CHILD]
    assert embedder.embedded - embedded == report.embedded == len(changed_children)
    assert report.reused == len(unchanged_children)

    # Reused vectors are the base revision's vectors.
    old_records = {(r.payload or {})["chunk_id"]: r for r in _records(store, client, "r1")}
    new_records = {(r.payload or {})["chunk_id"]: r for r in _records(store, client, "r2")}
    for cid in unchanged_children:
        new_vector, old_vector = new_records[cid].vector, old_records[cid].vector
        assert isinstance(new_vector, dict)
        assert isinstance(old_vector, dict)
        assert new_vector[DENSE_VECTOR] == pytest.approx(old_vector[DENSE_VECTOR], abs=1e-6)
        assert new_vector[SPARSE_VECTOR] == old_vector[SPARSE_VECTOR]
        assert (new_records[cid].payload or {})["revision_id"] == "r2"
    # The old revision is untouched and still the active one.
    assert store.load_chunks(WS, "doc-ko", "r1") == sorted(
        old, key=lambda c: (c.level is ChunkLevel.CHILD, c.ordinal or 0, c.id)
    )
    assert store.active_revision(WS, "doc-ko") == "r1"
    assert all(not (r.payload or {})["active"] for r in new_records.values())


def test_activation_switches_flag_and_gc_keeps_requested_revisions(
    store: QdrantIndexStore,
) -> None:
    base = _revision("book-ko", "doc-ko")
    store.index_revision(WS, "doc-ko", "r1", _chunks(base))
    store.activate_revision(WS, "doc-ko", "r1")
    second = _edited(base, "r2")
    store.index_revision(WS, "doc-ko", "r2", _chunks(second))
    store.index_revision(WS, "doc-ko", "r3", _chunks(_edited(second, "r3")))

    # Searchable by explicit revision scope regardless of the flag.
    assert store.keyword_candidates(_scope("r2"), "염소", 3)
    store.activate_revision(WS, "doc-ko", "r2")
    assert store.active_revision(WS, "doc-ko") == "r2"
    assert all(
        c.chunk.revision_id != "r1" for c in store.keyword_candidates(_scope("r2"), "물", 50)
    )

    # Rollback path: previous revision retained, r3 (never activated) collected.
    store.delete_inactive_revisions(WS, "doc-ko", keep=("r1",))
    assert store.load_chunks(WS, "doc-ko", "r1")
    assert store.load_chunks(WS, "doc-ko", "r2")
    assert store.load_chunks(WS, "doc-ko", "r3") == []
    store.activate_revision(WS, "doc-ko", "r1")  # roll back
    assert store.active_revision(WS, "doc-ko") == "r1"
    store.delete_inactive_revisions(WS, "doc-ko")
    assert store.load_chunks(WS, "doc-ko", "r2") == []
    assert store.load_chunks(WS, "doc-ko", "r1")


def test_activation_refuses_missing_or_partial_revisions(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    with pytest.raises(RevisionNotReadyError, match="no indexed chunks"):
        store.activate_revision(WS, "doc-en", "r1")
    store.index_revision(WS, "doc-en", "r1", chunks)
    lost = point_id(store.model_key, WS, "doc-en", "r1", chunks[-1].id)
    client.delete(store.ensure_collection(), points_selector=qm.PointIdsList(points=[lost]))
    with pytest.raises(RevisionNotReadyError, match="partly"):
        store.activate_revision(WS, "doc-en", "r1")
    assert store.active_revision(WS, "doc-en") is None
    store.index_revision(WS, "doc-en", "r1", chunks)  # repairs the missing point
    store.activate_revision(WS, "doc-en", "r1")
    assert store.active_revision(WS, "doc-en") == "r1"


def test_mid_index_failure_keeps_previous_revision_and_resumes(client: QdrantClient) -> None:
    base = _revision("book-ko", "doc-ko")
    healthy = CountingEmbedder()
    store = QdrantIndexStore(client, healthy, batch_size=2)
    store.index_revision(WS, "doc-ko", "r1", _chunks(base))
    store.activate_revision(WS, "doc-ko", "r1")
    hits_before = store.keyword_candidates(_scope("r1"), "염소", 5)

    edits = {
        b.id: b.text + " 추가 문장."
        for b in base.blocks
        if b.section_id is not None and b.type.value == "text"
    }
    new = _chunks(publish(apply_edits(base, edits, revision_id="r2")))
    by_id = {c.id: c for c in new}
    to_embed = [
        i for i in diff_chunks(_chunks(base), new).reindex_ids if by_id[i].level is ChunkLevel.CHILD
    ]
    assert len(to_embed) > 4
    failing = CountingEmbedder(fail_after=3)
    broken = QdrantIndexStore(client, failing, batch_size=2)
    with pytest.raises(RuntimeError, match="crashed"):
        broken.index_revision(WS, "doc-ko", "r2", new)
    assert 0 < len(store.load_chunks(WS, "doc-ko", "r2")) < len(new)

    # Previous revision still active and searchable; the partial one cannot be activated.
    assert store.active_revision(WS, "doc-ko") == "r1"
    # Same hits (scores move: Qdrant's IDF statistics are collection-wide).
    hits_after = store.keyword_candidates(_scope("r1"), "염소", 5)
    assert [h.chunk for h in hits_after] == [h.chunk for h in hits_before]
    with pytest.raises(RevisionNotReadyError, match="partly"):
        store.activate_revision(WS, "doc-ko", "r2")

    # Re-running resumes: already written points are not embedded again.
    resumed = CountingEmbedder()
    report = QdrantIndexStore(client, resumed, batch_size=2).index_revision(WS, "doc-ko", "r2", new)
    assert failing.embedded == 2
    assert resumed.embedded == report.embedded == len(to_embed) - failing.embedded
    store.activate_revision(WS, "doc-ko", "r2")
    assert store.active_revision(WS, "doc-ko") == "r2"


# --- read scope ------------------------------------------------------------------------------


def test_search_scope_requires_workspace_and_published_revisions() -> None:
    with pytest.raises(ValueError, match="workspace_id"):
        SearchScope(workspace_id="", revision_ids=("r1",))
    with pytest.raises(ValueError, match="published revision"):
        SearchScope(workspace_id=WS, revision_ids=())
    with pytest.raises(ValueError, match="published revision"):
        SearchScope(workspace_id=WS, revision_ids="r1")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        scope_filter(None)  # type: ignore[arg-type]
    flt = scope_filter(
        SearchScope(workspace_id=WS, revision_ids=("r1",), document_ids=("d",), languages=("ko",))
    )
    keys = {c.key for c in flt.must or [] if isinstance(c, qm.FieldCondition)}
    assert keys == {"workspace_id", "revision_id", "level", "document_id", "language"}


def test_queries_never_cross_workspaces_or_revisions(store: QdrantIndexStore) -> None:
    ko = _chunks(_revision("book-ko", "doc-ko"))
    store.index_revision(WS, "doc-ko", "r1", ko)
    store.index_revision(OTHER_WS, "doc-ko", "r1", ko)  # same ids in another workspace
    hits = store.keyword_candidates(_scope("r1"), "염소", 50)
    dense = store.dense_candidates(_scope("r1"), "염소 소독", 50)
    assert hits
    assert dense
    assert {c.chunk.document_id for c in hits + dense} == {"doc-ko"}
    assert all(c.chunk.level is ChunkLevel.CHILD for c in hits + dense)
    # Only the scoped workspace's points: each chunk id at most once.
    assert len({c.chunk.id for c in dense}) == len(dense)
    assert store.keyword_candidates(_scope("r-unpublished"), "염소", 5) == []
    assert store.keyword_candidates(_scope("r1", workspace="ws-none"), "염소", 5) == []
    assert store.keyword_candidates(_scope("r1"), "!!!", 5) == []


def test_keyword_search_finds_korean_nouns_without_particles(store: QdrantIndexStore) -> None:
    chunks = _chunks(_revision("book-ko", "doc-ko"))
    store.index_revision(WS, "doc-ko", "r1", chunks)
    [top] = store.keyword_candidates(_scope("r1"), "염소", 1)
    assert "염소" in top.chunk.content
    assert top.score > 0


def test_get_chunks_returns_parents_for_context_within_scope(store: QdrantIndexStore) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    store.index_revision(WS, "doc-en", "r1", chunks)
    [hit] = store.keyword_candidates(_scope("r1"), "chlorine", 1)
    assert hit.chunk.parent_id is not None
    [parent] = store.get_chunks(_scope("r1"), [hit.chunk.parent_id])
    assert parent.level is ChunkLevel.PARENT
    assert store.get_chunks(_scope("r1", workspace=OTHER_WS), [hit.chunk.parent_id]) == []
    assert store.get_chunks(_scope("r1"), []) == []


def test_delete_document_is_workspace_scoped(store: QdrantIndexStore) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    store.index_revision(WS, "doc-en", "r1", chunks)
    store.index_revision(OTHER_WS, "doc-en", "r1", chunks)
    store.delete_document(OTHER_WS, "doc-en")
    assert store.load_chunks(OTHER_WS, "doc-en", "r1") == []
    assert len(store.load_chunks(WS, "doc-en", "r1")) == len(chunks)


# --- retries ---------------------------------------------------------------------------------


def _unexpected(status: int) -> UnexpectedResponse:
    return UnexpectedResponse(status, "x", b"", None)  # type: ignore[arg-type]


def test_transient_errors_are_classified() -> None:
    assert is_transient(ResponseHandlingException(ConnectionError("reset")))
    assert is_transient(_unexpected(503))
    assert is_transient(_unexpected(429))
    assert not is_transient(_unexpected(400))
    assert not is_transient(ValueError("bad"))


def test_retry_policy_backs_off_on_transient_errors_only() -> None:
    sleeps: list[float] = []
    policy = RetryPolicy(attempts=3, base_delay=0.1, max_delay=0.15, sleep=sleeps.append)
    calls = iter([_unexpected(503), _unexpected(502)])

    def flaky() -> str:
        exc = next(calls, None)
        if exc is not None:
            raise exc
        return "ok"

    assert policy.call(flaky) == "ok"
    assert sleeps == [0.1, 0.15]

    def always() -> None:
        raise _unexpected(503)

    with pytest.raises(UnexpectedResponse):
        policy.call(always)

    def bad_request() -> None:
        raise _unexpected(400)

    sleeps.clear()
    with pytest.raises(UnexpectedResponse):
        policy.call(bad_request)
    assert sleeps == []


# --- aliases and rebuild -----------------------------------------------------------------------


def test_switch_alias_is_atomic_and_returns_previous_target(client: QdrantClient) -> None:
    for name in ("a", "b"):
        client.create_collection(name, vectors_config={})
    assert switch_alias(client, "al", "a") is None
    assert switch_alias(client, "al", "b") == "a"
    assert alias_target(client, "al") == "b"
    assert switch_alias(client, "al", "b") == "b"
    assert switch_alias(client, "al", "a") == "b"  # rollback
    assert alias_target(client, "al") == "a"


def test_rebuild_builds_a_new_generation_and_switches_the_alias(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    ko = _revision("book-ko", "doc-ko")
    store.index_revision(WS, "doc-ko", "r1", _chunks(ko))
    current = store.ensure_collection()
    edited = _edited(ko)
    report = rebuild(
        client,
        FakeEmbedder(),
        [
            RevisionChunks(WS, "doc-ko", "r1", _chunks(ko), active=False),
            RevisionChunks(WS, "doc-ko", "r2", _chunks(edited), active=True),
            RevisionChunks(WS, "doc-en", "r1", _chunks(_revision("book-en", "doc-en"))),
        ],
    )
    assert report.collection == f"documents_v1__{store.model_key}__g2"
    assert report.previous == current
    assert report.revisions == 3
    assert alias_target(client, "documents_v1") == report.collection

    fresh = QdrantIndexStore(client, FakeEmbedder())
    assert fresh.ensure_collection() == report.collection  # follows the alias
    assert fresh.active_revision(WS, "doc-ko") == "r2"
    assert fresh.active_revision(WS, "doc-en") == "r1"
    assert fresh.load_chunks(WS, "doc-ko", "r1")

    # Rolling back the upgrade is one alias switch; the old collection was untouched.
    switch_alias(client, "documents_v1", current)
    assert QdrantIndexStore(client, FakeEmbedder()).active_revision(WS, "doc-ko") is None


def test_unpinned_store_follows_rebuild_and_survives_dropping_the_old_generation(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    ko = _revision("book-ko", "doc-ko")
    store.index_revision(WS, "doc-ko", "r1", _chunks(ko))
    store.activate_revision(WS, "doc-ko", "r1")
    old = store.ensure_collection()
    report = rebuild(
        client,
        FakeEmbedder(),
        [RevisionChunks(WS, "doc-ko", "r2", _chunks(_edited(ko)))],
    )
    # The long-lived store now reads the new generation...
    assert store.ensure_collection() == report.collection
    assert store.active_revision(WS, "doc-ko") == "r2"
    assert store.keyword_candidates(_scope("r2"), "염소", 1)
    # ...and writes to it.
    en = _chunks(_revision("book-en", "doc-en"))
    written = store.index_revision(WS, "doc-en", "r1", en)
    assert written.collection == report.collection
    assert client.count(report.collection, exact=True).count == report.points + len(en)
    assert client.count(old, exact=True).count == len(_chunks(ko))

    client.delete_collection(old)
    assert store.load_chunks(WS, "doc-en", "r1")
    store.activate_revision(WS, "doc-en", "r1")
    assert store.active_revision(WS, "doc-en") == "r1"


def test_operation_on_a_collection_dropped_meanwhile_is_resolved_again(
    client: QdrantClient, store: QdrantIndexStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    ko = _revision("book-ko", "doc-ko")
    store.index_revision(WS, "doc-ko", "r1", _chunks(ko))
    store.activate_revision(WS, "doc-ko", "r1")
    old = store.ensure_collection()
    report = rebuild(client, FakeEmbedder(), [RevisionChunks(WS, "doc-ko", "r1", _chunks(ko))])
    client.delete_collection(old)
    # The race: the collection was resolved just before it was dropped.
    stale = iter([old])
    real = QdrantIndexStore._resolve
    monkeypatch.setattr(store, "_resolve", lambda: next(stale, None) or real(store))
    assert store.active_revision(WS, "doc-ko") == "r1"
    assert store.ensure_collection() == report.collection


def test_pinned_store_never_moves(client: QdrantClient, store: QdrantIndexStore) -> None:
    store.index_revision(WS, "doc-en", "r1", _chunks(_revision("book-en", "doc-en")))
    old = store.ensure_collection()
    pinned = QdrantIndexStore(client, FakeEmbedder(), collection=old)
    rebuild(client, FakeEmbedder(), [])
    assert alias_target(client, "documents_v1") != old
    assert pinned.ensure_collection() == old
    assert pinned.load_chunks(WS, "doc-en", "r1")


def test_bm25_parameters_are_part_of_the_model_key() -> None:
    default = Bm25Encoder()
    assert default.config_id.startswith(BM25_VERSION)
    assert model_key("m", 8) == model_key("m", 8, default.config_id)
    encoders = (default, Bm25Encoder(k1=1.5), Bm25Encoder(b=0.5), Bm25Encoder(avg_doc_terms=80))
    assert len({model_key("m", 8, enc.config_id) for enc in encoders}) == 4


def test_collection_with_other_bm25_parameters_is_refused_and_rebuilt(
    client: QdrantClient, store: QdrantIndexStore
) -> None:
    chunks = _chunks(_revision("book-en", "doc-en"))
    store.index_revision(WS, "doc-en", "r1", chunks)
    store.activate_revision(WS, "doc-en", "r1")
    current = store.ensure_collection()
    tuned = Bm25Encoder(k1=1.6, avg_doc_terms=120)
    pinned = QdrantIndexStore(client, FakeEmbedder(), sparse=tuned, collection=current)
    with pytest.raises(IndexSchemaError, match="BM25"):
        pinned.ensure_collection()
    # Unpinned, the tuned store gets its own collection: no sparse vectors are reused across
    # BM25 settings.
    retuned = QdrantIndexStore(client, FakeEmbedder(), sparse=tuned)
    assert retuned.model_key != store.model_key
    assert retuned.ensure_collection() != current
    assert retuned.active_revision(WS, "doc-en") is None
    metadata = client.get_collection(retuned.ensure_collection()).config.metadata or {}
    assert metadata["sparse_config"] == tuned.config_id
    # The supported path: rebuild with the new settings and switch the alias.
    report = rebuild(
        client, FakeEmbedder(), [RevisionChunks(WS, "doc-en", "r1", chunks)], sparse=tuned
    )
    assert alias_target(client, "documents_v1") == report.collection
    assert retuned.ensure_collection() == report.collection
    assert retuned.active_revision(WS, "doc-en") == "r1"
    # A store with the old settings no longer matches the alias target: its own collection.
    assert store.ensure_collection() == current


@pytest.mark.parametrize("warm", [False, True], ids=["fresh-store", "cached-store"])
def test_alias_switch_and_drop_right_after_alias_lookup_is_retried(
    client: QdrantClient, monkeypatch: pytest.MonkeyPatch, warm: bool
) -> None:
    ko = _chunks(_revision("book-ko", "doc-ko"))
    seed = QdrantIndexStore(client, FakeEmbedder())
    seed.index_revision(WS, "doc-ko", "r1", ko)
    seed.activate_revision(WS, "doc-ko", "r1")
    old = seed.ensure_collection()
    new = rebuild(
        client, FakeEmbedder(), [RevisionChunks(WS, "doc-ko", "r1", ko)], switch=False
    ).collection

    store = QdrantIndexStore(client, FakeEmbedder())
    if warm:
        assert store.ensure_collection() == old  # caches the old generation as verified
    lookups: list[str | None] = []

    def racing_alias_target(*args: object, **kwargs: object) -> str | None:
        target = alias_target(*args, **kwargs)  # type: ignore[arg-type]
        lookups.append(target)
        if len(lookups) == 1:
            # Right after get_aliases(): the alias moves and the old target is dropped.
            client.update_collection_aliases(
                change_aliases_operations=[
                    qm.DeleteAliasOperation(delete_alias=qm.DeleteAlias(alias_name="documents_v1")),
                    qm.CreateAliasOperation(
                        create_alias=qm.CreateAlias(collection_name=new, alias_name="documents_v1")
                    ),
                ]
            )
            client.delete_collection(old)
        return target

    monkeypatch.setattr("book_core.indexing.store.alias_target", racing_alias_target)
    assert store.active_revision(WS, "doc-ko") == "r1"
    assert lookups == [old, new]
    assert store.ensure_collection() == new
    assert not client.collection_exists(old)  # the dropped generation is not re-created


def test_collection_vanishing_twice_is_not_retried_forever(
    client: QdrantClient, store: QdrantIndexStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.ensure_collection()
    calls = []

    def gone(collection: str) -> None:
        calls.append(collection)
        raise ValueError(f"Collection {collection} not found")

    with pytest.raises(ValueError, match="not found"):
        store._run(gone)
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("left", "right"),
    [
        (Bm25Encoder(avg_doc_terms=200), Bm25Encoder(avg_doc_terms=200.0)),
        (Bm25Encoder(avg_doc_terms=Decimal("200")), Bm25Encoder()),  # type: ignore[arg-type]
        (Bm25Encoder(k1=Decimal("1.2"), b=Fraction(3, 4)), Bm25Encoder()),  # type: ignore[arg-type]
        (Bm25Encoder(k1=0, b=-0.0), Bm25Encoder(k1=0.0, b=0.0)),
        (Bm25Encoder(b=1), Bm25Encoder(b=1.0)),
    ],
)
def test_equivalent_bm25_parameters_share_one_config_id(
    left: Bm25Encoder, right: Bm25Encoder
) -> None:
    assert left.config_id == right.config_id
    assert left == right
    assert left.encode_document("water water cloud") == right.encode_document("water water cloud")


def test_distinct_bm25_parameters_differ_and_bad_types_are_rejected() -> None:
    ids = {
        Bm25Encoder().config_id,
        Bm25Encoder(avg_doc_terms=200.0000001).config_id,
        Bm25Encoder(k1=1.2000000000000002).config_id,
        Bm25Encoder(b=0.7500001).config_id,
    }
    assert len(ids) == 4
    for bad in (True, "1.2", None):
        with pytest.raises(TypeError, match="real number"):
            Bm25Encoder(k1=bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="finite"):
        Bm25Encoder(avg_doc_terms=float("inf"))
