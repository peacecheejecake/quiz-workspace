"""Qdrant document index: dense + BM25 sparse vectors per child chunk, revision activation.

Design (docs/architecture.md §4 indexing flow steps 5-7):

- One point per (workspace, document, revision, chunk). Point ids are UUIDv5 of the model key,
  workspace, document, revision and chunk id, so re-running an index is an idempotent upsert and
  every revision's points are separate: indexing revision N+1 never touches revision N, which
  stays searchable until the caller switches to N+1 and garbage-collects N.
- Children carry a named dense vector (``dense``, cosine) and a sparse BM25 vector (``bm25``,
  IDF modifier). Parents are stored without vectors: they are section context for rerankers,
  excerpts and generation, fetched by id, never retrieval units, and embedding them would double
  the embedding cost for nothing the search flow uses.
- The payload is the full ``SearchChunk`` (so chunks can be read back for context retrieval and
  incremental diffs) plus ``workspace_id``, ``pages``, the embedding ``model``, ``revision_size``
  (chunk count of the revision; activation refuses a partially written revision) and ``active``.
- Incremental re-index: chunks unchanged since a base revision (same id and ``content_hash``)
  reuse its stored vectors instead of being embedded again; only added/changed children are
  embedded. Re-indexing a revision that is already (partly) indexed only writes missing points
  and refreshes payloads that differ.
- The ``active`` payload flag mirrors the published revision for tools without a database (CLI).
  The authority is the database (M3.4): servers must build their read filter from the
  DB-known published revision ids with ``SearchScope``, which refuses unscoped queries.
"""

from __future__ import annotations

import uuid
import warnings
from collections.abc import Collection, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from typing import Any, Final, Protocol

from qdrant_client import QdrantClient
from qdrant_client import models as qm
from qdrant_client.http.exceptions import UnexpectedResponse

from book_core.chunker import ChunkDiff, diff_chunks
from book_core.contracts import ChunkLevel, SearchChunk
from book_core.embedding import Embedder
from book_core.indexing.naming import (
    PAYLOAD_SCHEMA_VERSION,
    CollectionNames,
    embedder_model_key,
)
from book_core.indexing.retry import RetryPolicy
from book_core.indexing.sparse import BM25_VERSION, Bm25Encoder, SparseVector

DENSE_VECTOR: Final = "dense"
SPARSE_VECTOR: Final = "bm25"
_POINT_NAMESPACE = uuid.UUID("6f0f8a52-3f7e-5d1c-9a43-6b1f3c2e9d10")
_KEYWORD_FIELDS = (
    "document_id",
    "revision_id",
    "chunk_id",
    "parent_id",
    "section_id",
    "level",
    "language",
)
_SCROLL_PAGE = 256
# A child whose text has no BM25 terms is stored without a sparse vector.
_EMPTY_SPARSE = qm.SparseVector(indices=[], values=[])


class IndexStoreError(RuntimeError):
    """Base class for index store errors."""


class IndexSchemaError(IndexStoreError):
    """The target collection exists with an incompatible vector space or schema."""


class RevisionNotReadyError(IndexStoreError):
    """Activation of a revision that is not (completely) indexed."""


def point_id(
    model_key: str, workspace_id: str, document_id: str, revision_id: str, chunk_id: str
) -> str:
    name = "\x1f".join((model_key, workspace_id, document_id, revision_id, chunk_id))
    return str(uuid.uuid5(_POINT_NAMESPACE, name))


def _require(value: str, what: str) -> str:
    if not value or value != value.strip():
        raise ValueError(f"{what} must be a non-empty identifier")
    return value


# --- Read scope -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SearchScope:
    """Server-enforced read filter. ``revision_ids`` are the published (active) revisions the
    caller resolved from the database for the documents it may read; both they and
    ``workspace_id`` are mandatory, so no query can run across workspaces or reach a stale
    or unpublished revision."""

    workspace_id: str
    revision_ids: tuple[str, ...]
    document_ids: tuple[str, ...] = ()
    section_ids: tuple[str, ...] = ()
    languages: tuple[str, ...] = ()
    level: ChunkLevel = ChunkLevel.CHILD

    def __post_init__(self) -> None:
        _require(self.workspace_id, "workspace_id")
        if isinstance(self.revision_ids, str) or not self.revision_ids:
            raise ValueError("a search scope needs at least one published revision id")
        for value in (*self.revision_ids, *self.document_ids, *self.section_ids):
            _require(value, "scope id")


def scope_filter(scope: SearchScope, *, any_level: bool = False) -> qm.Filter:
    """Qdrant filter for a scope; ``any_level`` drops the level condition (context lookups)."""
    if not isinstance(scope, SearchScope):
        raise TypeError("scope_filter requires a SearchScope")
    must: list[qm.Condition] = [
        _match("workspace_id", scope.workspace_id),
        _match_any("revision_id", scope.revision_ids),
    ]
    if not any_level:
        must.append(_match("level", scope.level.value))
    if scope.document_ids:
        must.append(_match_any("document_id", scope.document_ids))
    if scope.section_ids:
        must.append(_match_any("section_id", scope.section_ids))
    if scope.languages:
        must.append(_match_any("language", scope.languages))
    return qm.Filter(must=must)


def _match(key: str, value: str | bool) -> qm.FieldCondition:
    return qm.FieldCondition(key=key, match=qm.MatchValue(value=value))


def _match_any(key: str, values: Iterable[str]) -> qm.FieldCondition:
    return qm.FieldCondition(key=key, match=qm.MatchAny(any=list(values)))


def _revision_filter(workspace_id: str, document_id: str, *more: qm.Condition) -> qm.Filter:
    return qm.Filter(
        must=[_match("workspace_id", workspace_id), _match("document_id", document_id), *more]
    )


# --- Payload --------------------------------------------------------------------------------


def chunk_payload(
    workspace_id: str, chunk: SearchChunk, *, model_name: str, revision_size: int, active: bool
) -> dict[str, Any]:
    data = chunk.model_dump(mode="json")
    data["chunk_schema_version"] = data.pop("schema_version")
    data["chunk_id"] = data.pop("id")
    data.update(
        payload_version=PAYLOAD_SCHEMA_VERSION,
        workspace_id=workspace_id,
        pages=sorted({loc.page for loc in chunk.locations}),
        model=model_name,
        revision_size=revision_size,
        active=active,
    )
    return data


def chunk_from_payload(payload: Mapping[str, Any]) -> SearchChunk:
    data = {
        k: v
        for k, v in payload.items()
        if k not in {"payload_version", "workspace_id", "pages", "model", "revision_size", "active"}
    }
    data["schema_version"] = data.pop("chunk_schema_version")
    data["id"] = data.pop("chunk_id")
    return SearchChunk.model_validate(data)


# --- Results --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class IndexReport:
    """What ``index_revision`` wrote. ``diff`` compares against ``base_revision_id``."""

    collection: str
    workspace_id: str
    document_id: str
    revision_id: str
    base_revision_id: str | None
    embedded: int
    reused: int
    refreshed: int
    unchanged: int
    parents_written: int
    deleted_stale: int
    diff: ChunkDiff | None

    @property
    def is_noop(self) -> bool:
        return not (
            self.embedded
            or self.reused
            or self.refreshed
            or self.parents_written
            or self.deleted_stale
        )


@dataclass(frozen=True, slots=True)
class Candidate:
    chunk: SearchChunk
    score: float


class IndexStore(Protocol):
    """Document index operations used by workers (indexing) and search (candidates)."""

    def index_revision(
        self,
        workspace_id: str,
        document_id: str,
        revision_id: str,
        chunks: Sequence[SearchChunk],
        *,
        base_revision_id: str | None = None,
    ) -> IndexReport: ...

    def activate_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None: ...

    def active_revision(self, workspace_id: str, document_id: str) -> str | None: ...

    def delete_inactive_revisions(
        self, workspace_id: str, document_id: str, *, keep: Collection[str] = ()
    ) -> None: ...

    def delete_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None: ...

    def delete_document(self, workspace_id: str, document_id: str) -> None: ...

    def load_chunks(
        self, workspace_id: str, document_id: str, revision_id: str
    ) -> list[SearchChunk]: ...

    def get_chunks(self, scope: SearchScope, chunk_ids: Collection[str]) -> list[SearchChunk]: ...

    def keyword_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]: ...

    def dense_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]: ...


@dataclass(frozen=True, slots=True)
class _Stored:
    point_id: str
    payload: dict[str, Any]


@dataclass(slots=True)
class _Plan:
    embed: list[tuple[str, SearchChunk, dict[str, Any]]] = field(default_factory=list)
    reuse: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    parents: list[qm.PointStruct] = field(default_factory=list)
    refresh: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    unchanged: int = 0


class QdrantIndexStore:
    """``IndexStore`` on Qdrant for one embedder (one vector space = one physical collection).

    By default the store writes to the alias target when it holds this embedder's vector space,
    else to ``names.physical(model_key)`` (created on first use; the alias is created too when
    missing). ``collection`` pins an explicit physical collection (rebuilds).
    """

    def __init__(
        self,
        client: QdrantClient,
        embedder: Embedder,
        *,
        names: CollectionNames | None = None,
        collection: str | None = None,
        sparse: Bm25Encoder | None = None,
        batch_size: int = 64,
        retry: RetryPolicy | None = None,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        self._client = client
        self._embedder = embedder
        self._names = names or CollectionNames()
        self._pinned = collection
        self._sparse = sparse or Bm25Encoder()
        self._batch_size = batch_size
        self._retry = retry or RetryPolicy()
        self._model_key = embedder_model_key(embedder)
        self._collection: str | None = None

    # -- collection management -----------------------------------------------------------

    @property
    def model_key(self) -> str:
        return self._model_key

    @property
    def names(self) -> CollectionNames:
        return self._names

    def collection_metadata(self) -> dict[str, Any]:
        return {
            "kind": "documents",
            "payload_version": PAYLOAD_SCHEMA_VERSION,
            "model_key": self._model_key,
            "model_name": self._embedder.model_name,
            "dimension": self._embedder.dimension,
            "sparse": BM25_VERSION,
        }

    def ensure_collection(self) -> str:
        """Resolve (and create if needed) the physical collection this store writes to."""
        if self._collection is not None:
            return self._collection
        if self._pinned is not None:
            name = self._pinned
        else:
            target = alias_target(self._client, self._names.alias, retry=self._retry)
            if target is not None and self._key_of(target) == self._model_key:
                name = target
            else:
                name = self._names.physical(self._model_key)
        if not self._retry.call(lambda: self._client.collection_exists(name)):
            self._create(name)
        info = self._retry.call(lambda: self._client.get_collection(name))
        found = (info.config.metadata or {}).get("model_key")
        if found != self._model_key:
            raise IndexSchemaError(
                f"collection {name!r} holds model key {found!r}, expected {self._model_key!r}"
            )
        self._ensure_payload_indexes(name, set(info.payload_schema))
        if self._pinned is None and alias_target(self._client, self._names.alias) is None:
            try:
                switch_alias(self._client, self._names.alias, name, retry=self._retry)
            except UnexpectedResponse:
                # Another writer created the alias concurrently; keep its target.
                if alias_target(self._client, self._names.alias) is None:
                    raise
        self._collection = name
        return name

    def _key_of(self, collection: str) -> str | None:
        info = self._retry.call(lambda: self._client.get_collection(collection))
        key = (info.config.metadata or {}).get("model_key")
        return key if isinstance(key, str) else None

    def _create(self, name: str) -> None:
        try:
            self._retry.call(
                lambda: self._client.create_collection(
                    name,
                    vectors_config={
                        DENSE_VECTOR: qm.VectorParams(
                            size=self._embedder.dimension, distance=qm.Distance.COSINE
                        )
                    },
                    sparse_vectors_config={
                        SPARSE_VECTOR: qm.SparseVectorParams(modifier=qm.Modifier.IDF)
                    },
                    metadata=self.collection_metadata(),
                )
            )
        except UnexpectedResponse as exc:
            # 409: created concurrently by another writer; the schema is checked by the caller.
            if exc.status_code != 409:
                raise

    def _ensure_payload_indexes(self, name: str, present: set[str]) -> None:
        indexes: list[tuple[str, qm.PayloadSchemaType | qm.KeywordIndexParams]] = [
            # Tenant index: every query filters by workspace first.
            (
                "workspace_id",
                qm.KeywordIndexParams(type=qm.KeywordIndexType.KEYWORD, is_tenant=True),
            ),
            *((f, qm.PayloadSchemaType.KEYWORD) for f in _KEYWORD_FIELDS),
            ("active", qm.PayloadSchemaType.BOOL),
            ("revision_size", qm.PayloadSchemaType.INTEGER),
        ]
        for field_name, schema in indexes:
            if field_name in present:
                continue
            with warnings.catch_warnings():
                # Local mode (tests) ignores payload indexes and warns about it.
                warnings.filterwarnings("ignore", "Payload indexes have no effect")
                self._retry.call(
                    partial(
                        self._client.create_payload_index,
                        name,
                        field_name,
                        field_schema=schema,
                        wait=True,
                    )
                )

    # -- writing ---------------------------------------------------------------------------

    def index_revision(
        self,
        workspace_id: str,
        document_id: str,
        revision_id: str,
        chunks: Sequence[SearchChunk],
        *,
        base_revision_id: str | None = None,
    ) -> IndexReport:
        """Write every chunk of one revision; the revision is *not* activated.

        ``base_revision_id`` (default: the currently active revision, if another one) is the
        revision whose stored vectors are reused for unchanged chunks. A failure part-way leaves
        earlier revisions untouched and this revision inactive; calling again resumes it.
        """
        for value, what in (
            (workspace_id, "workspace_id"),
            (document_id, "document_id"),
            (revision_id, "revision_id"),
        ):
            _require(value, what)
        _check_chunks(document_id, revision_id, chunks)
        collection = self.ensure_collection()
        active = self.active_revision(workspace_id, document_id)
        if base_revision_id is None and active != revision_id:
            base_revision_id = active
        if base_revision_id == revision_id:
            base_revision_id = None

        existing = self._stored(workspace_id, document_id, revision_id)
        base = self._stored(workspace_id, document_id, base_revision_id) if base_revision_id else {}
        plan = self._plan(
            workspace_id, document_id, revision_id, chunks, existing, base, active == revision_id
        )

        for batch in _batches(plan.parents, self._batch_size):
            self._upsert(collection, batch)
        for reuse_batch in _batches(plan.reuse, self._batch_size):
            self._reuse(collection, reuse_batch)
        for embed_batch in _batches(plan.embed, self._batch_size):
            self._embed(collection, embed_batch)
        for refresh_batch in _batches(plan.refresh, self._batch_size):
            ops = [
                qm.OverwritePayloadOperation(
                    overwrite_payload=qm.SetPayload(payload=payload, points=[pid])
                )
                for pid, payload in refresh_batch
            ]
            self._retry.call(partial(self._client.batch_update_points, collection, ops, wait=True))
        new_ids = {c.id for c in chunks}
        stale = [s.point_id for cid, s in existing.items() if cid not in new_ids]
        for stale_batch in _batches(stale, self._batch_size):
            selector = qm.PointIdsList(points=list(stale_batch))
            self._retry.call(
                partial(self._client.delete, collection, points_selector=selector, wait=True)
            )

        diff = None
        if base_revision_id is not None:
            diff = diff_chunks([chunk_from_payload(s.payload) for s in base.values()], chunks)
        return IndexReport(
            collection=collection,
            workspace_id=workspace_id,
            document_id=document_id,
            revision_id=revision_id,
            base_revision_id=base_revision_id,
            embedded=len(plan.embed),
            reused=len(plan.reuse),
            refreshed=len(plan.refresh),
            unchanged=plan.unchanged,
            parents_written=len(plan.parents),
            deleted_stale=len(stale),
            diff=diff,
        )

    def _plan(
        self,
        workspace_id: str,
        document_id: str,
        revision_id: str,
        chunks: Sequence[SearchChunk],
        existing: Mapping[str, _Stored],
        base: Mapping[str, _Stored],
        is_active: bool,
    ) -> _Plan:
        plan = _Plan()
        model_name = self._embedder.model_name
        for chunk in chunks:
            pid = point_id(self._model_key, workspace_id, document_id, revision_id, chunk.id)
            payload = chunk_payload(
                workspace_id,
                chunk,
                model_name=model_name,
                revision_size=len(chunks),
                active=is_active,
            )
            current = existing.get(chunk.id)
            if current is not None and _same_vectors(current.payload, chunk, model_name):
                if current.payload == payload:
                    plan.unchanged += 1
                else:
                    plan.refresh.append((pid, payload))
                continue
            if chunk.level is ChunkLevel.PARENT:
                plan.parents.append(qm.PointStruct(id=pid, vector={}, payload=payload))
                continue
            source = base.get(chunk.id)
            if source is not None and _same_vectors(source.payload, chunk, model_name):
                plan.reuse.append((pid, source.point_id, payload))
            else:
                plan.embed.append((pid, chunk, payload))
        return plan

    def _upsert(self, collection: str, points: Sequence[qm.PointStruct]) -> None:
        self._retry.call(lambda: self._client.upsert(collection, points=list(points), wait=True))

    def _reuse(self, collection: str, batch: Sequence[tuple[str, str, dict[str, Any]]]) -> None:
        records = self._retry.call(
            lambda: self._client.retrieve(
                collection, ids=[src for _, src, _ in batch], with_payload=False, with_vectors=True
            )
        )
        vectors = {str(r.id): r.vector for r in records}
        points = []
        for pid, src, payload in batch:
            vector = vectors.get(src)
            dense = vector.get(DENSE_VECTOR) if isinstance(vector, dict) else None
            sparse = vector.get(SPARSE_VECTOR, _EMPTY_SPARSE) if isinstance(vector, dict) else None
            if not isinstance(dense, list) or not isinstance(sparse, qm.SparseVector):
                raise IndexStoreError(f"base point {src} has no stored vectors")
            stored: qm.VectorStruct = {DENSE_VECTOR: dense, SPARSE_VECTOR: sparse}
            points.append(qm.PointStruct(id=pid, vector=stored, payload=payload))
        self._upsert(collection, points)

    def _embed(
        self, collection: str, batch: Sequence[tuple[str, SearchChunk, dict[str, Any]]]
    ) -> None:
        texts = [chunk.search_text for _, chunk, _ in batch]
        dense = self._embedder.embed_documents(texts)
        if len(dense) != len(batch) or any(len(v) != self._embedder.dimension for v in dense):
            raise IndexStoreError("embedder returned vectors of the wrong count or dimension")
        points = [
            qm.PointStruct(
                id=pid,
                vector=_vectors(vector, self._sparse.encode_document(chunk.search_text)),
                payload=payload,
            )
            for (pid, chunk, payload), vector in zip(batch, dense, strict=True)
        ]
        self._upsert(collection, points)

    # -- activation and garbage collection -------------------------------------------------

    def activate_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None:
        """Mark ``revision_id`` active and every other revision of the document inactive.

        Refuses a revision that has no points or was only partly written. The new revision is
        flagged first, so a reader filtering on the flag briefly sees both, never neither.
        """
        collection = self.ensure_collection()
        own = _match("revision_id", _require(revision_id, "revision_id"))
        total = self._count(collection, _revision_filter(workspace_id, document_id, own))
        if total == 0:
            raise RevisionNotReadyError(f"revision {revision_id!r} has no indexed chunks")
        sized = qm.FieldCondition(key="revision_size", match=qm.MatchValue(value=total))
        if (
            self._count(collection, _revision_filter(workspace_id, document_id, own, sized))
            != total
        ):
            raise RevisionNotReadyError(f"revision {revision_id!r} is only partly indexed")
        self._set_active(collection, _revision_filter(workspace_id, document_id, own), True)
        others = qm.Filter(
            must=_as_list(_revision_filter(workspace_id, document_id, _match("active", True)).must),
            must_not=[own],
        )
        self._set_active(collection, others, False)

    def active_revision(self, workspace_id: str, document_id: str) -> str | None:
        collection = self.ensure_collection()
        flt = _revision_filter(workspace_id, document_id, _match("active", True))
        records, _ = self._retry.call(
            lambda: self._client.scroll(
                collection, scroll_filter=flt, limit=1, with_payload=["revision_id"]
            )
        )
        if not records or records[0].payload is None:
            return None
        value = records[0].payload.get("revision_id")
        return value if isinstance(value, str) else None

    def delete_inactive_revisions(
        self, workspace_id: str, document_id: str, *, keep: Collection[str] = ()
    ) -> None:
        """Garbage-collect inactive revisions of a document except ``keep`` (e.g. the previous
        revision, for a quick rollback). Call only after the database switched the published
        revision, and never while another revision of the document is being indexed."""
        collection = self.ensure_collection()
        flt = _revision_filter(workspace_id, document_id, _match("active", False))
        if keep:
            flt = qm.Filter(must=flt.must, must_not=[_match_any("revision_id", keep)])
        self._delete(collection, flt)

    def delete_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None:
        collection = self.ensure_collection()
        self._delete(
            collection,
            _revision_filter(workspace_id, document_id, _match("revision_id", revision_id)),
        )

    def delete_document(self, workspace_id: str, document_id: str) -> None:
        collection = self.ensure_collection()
        self._delete(collection, _revision_filter(workspace_id, document_id))

    # -- reading ---------------------------------------------------------------------------

    def load_chunks(
        self, workspace_id: str, document_id: str, revision_id: str
    ) -> list[SearchChunk]:
        """Stored chunks of one revision: parents then children, each in reading order."""
        stored = self._stored(workspace_id, document_id, revision_id)
        chunks = [chunk_from_payload(s.payload) for s in stored.values()]
        return sorted(chunks, key=lambda c: (c.level is ChunkLevel.CHILD, c.ordinal or 0, c.id))

    def get_chunks(self, scope: SearchScope, chunk_ids: Collection[str]) -> list[SearchChunk]:
        """Chunks by id within a scope (any level), e.g. parents of retrieved children."""
        if not chunk_ids:
            return []
        scoped = scope_filter(scope, any_level=True)
        flt = qm.Filter(must=[*_as_list(scoped.must), _match_any("chunk_id", chunk_ids)])
        records = self._scroll(self.ensure_collection(), flt, True)
        return [chunk_from_payload(r.payload or {}) for r in records]

    def keyword_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        vector = self._sparse.encode_query(query)
        if not vector.indices:
            return []
        return self._query(scope, _to_qdrant(vector), SPARSE_VECTOR, limit)

    def dense_candidates(self, scope: SearchScope, query: str, limit: int) -> list[Candidate]:
        return self._query(scope, self._embedder.embed_query(query), DENSE_VECTOR, limit)

    def _query(
        self, scope: SearchScope, query: qm.SparseVector | list[float], using: str, limit: int
    ) -> list[Candidate]:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        flt = scope_filter(scope)
        collection = self.ensure_collection()
        response = self._retry.call(
            lambda: self._client.query_points(
                collection,
                query=query,
                using=using,
                query_filter=flt,
                limit=limit,
                with_payload=True,
            )
        )
        return [
            Candidate(chunk=chunk_from_payload(p.payload or {}), score=p.score)
            for p in response.points
        ]

    # -- helpers ---------------------------------------------------------------------------

    def _stored(self, workspace_id: str, document_id: str, revision_id: str) -> dict[str, _Stored]:
        collection = self.ensure_collection()
        flt = _revision_filter(workspace_id, document_id, _match("revision_id", revision_id))
        result: dict[str, _Stored] = {}
        for record in self._scroll(collection, flt, True):
            payload = dict(record.payload or {})
            result[str(payload["chunk_id"])] = _Stored(str(record.id), payload)
        return result

    def _scroll(self, collection: str, flt: qm.Filter, with_payload: bool) -> Iterator[qm.Record]:
        offset: qm.ExtendedPointId | None = None
        while True:
            records, offset = self._retry.call(
                partial(
                    self._client.scroll,
                    collection,
                    scroll_filter=flt,
                    limit=_SCROLL_PAGE,
                    offset=offset,
                    with_payload=with_payload,
                    with_vectors=False,
                )
            )
            yield from records
            if offset is None:
                return

    def _count(self, collection: str, flt: qm.Filter) -> int:
        result = self._retry.call(
            lambda: self._client.count(collection, count_filter=flt, exact=True)
        )
        return result.count

    def _set_active(self, collection: str, flt: qm.Filter, value: bool) -> None:
        self._retry.call(
            lambda: self._client.set_payload(
                collection, payload={"active": value}, points=flt, wait=True
            )
        )

    def _delete(self, collection: str, flt: qm.Filter) -> None:
        self._retry.call(
            lambda: self._client.delete(
                collection, points_selector=qm.FilterSelector(filter=flt), wait=True
            )
        )


def _as_list(conditions: Any) -> list[Any]:
    if conditions is None:
        return []
    return list(conditions) if isinstance(conditions, list) else [conditions]


def _same_vectors(payload: Mapping[str, Any], chunk: SearchChunk, model_name: str) -> bool:
    return (
        payload.get("content_hash") == chunk.content_hash
        and payload.get("model") == model_name
        and payload.get("level") == chunk.level.value
    )


def _check_chunks(document_id: str, revision_id: str, chunks: Sequence[SearchChunk]) -> None:
    seen: set[str] = set()
    for chunk in chunks:
        if chunk.document_id != document_id or chunk.revision_id != revision_id:
            raise ValueError(f"chunk {chunk.id} belongs to another document or revision")
        if chunk.id in seen:
            raise ValueError(f"duplicate chunk id {chunk.id}")
        seen.add(chunk.id)


def _batches[T](items: Sequence[T], size: int) -> Iterator[Sequence[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _vectors(dense: Sequence[float], sparse: SparseVector) -> qm.VectorStruct:
    return {DENSE_VECTOR: list(dense), SPARSE_VECTOR: _to_qdrant(sparse)}


def _to_qdrant(vector: SparseVector) -> qm.SparseVector:
    return qm.SparseVector(indices=list(vector.indices), values=list(vector.values))


# --- Alias management and rebuild -------------------------------------------------------------


def alias_target(
    client: QdrantClient, alias: str, *, retry: RetryPolicy | None = None
) -> str | None:
    response = (retry or RetryPolicy()).call(client.get_aliases)
    for description in response.aliases:
        if description.alias_name == alias:
            return description.collection_name
    return None


def switch_alias(
    client: QdrantClient, alias: str, collection: str, *, retry: RetryPolicy | None = None
) -> str | None:
    """Point ``alias`` at ``collection`` in one atomic alias update; returns the previous target
    (pass it back to roll back)."""
    policy = retry or RetryPolicy()
    previous = alias_target(client, alias, retry=policy)
    if previous == collection:
        return previous
    operations: list[qm.AliasOperations] = []
    if previous is not None:
        operations.append(qm.DeleteAliasOperation(delete_alias=qm.DeleteAlias(alias_name=alias)))
    operations.append(
        qm.CreateAliasOperation(
            create_alias=qm.CreateAlias(collection_name=collection, alias_name=alias)
        )
    )
    policy.call(lambda: client.update_collection_aliases(change_aliases_operations=operations))
    return previous


@dataclass(frozen=True, slots=True)
class RevisionChunks:
    """One revision to (re)build: its chunks and whether it is the published revision."""

    workspace_id: str
    document_id: str
    revision_id: str
    chunks: Sequence[SearchChunk]
    active: bool = True


@dataclass(frozen=True, slots=True)
class RebuildReport:
    alias: str
    collection: str
    previous: str | None
    revisions: int
    points: int


def rebuild(
    client: QdrantClient,
    embedder: Embedder,
    revisions: Iterable[RevisionChunks],
    *,
    names: CollectionNames | None = None,
    switch: bool = True,
    sparse: Bm25Encoder | None = None,
    batch_size: int = 64,
    retry: RetryPolicy | None = None,
) -> RebuildReport:
    """Build a fresh physical collection from canonical chunks and (by default) switch the alias.

    The previous alias target is left in place for rollback (``switch_alias`` back to
    ``RebuildReport.previous``) and must be dropped by the operator afterwards. Readers keep
    using the old collection until the switch. Qdrant is derived: ``revisions`` come from the
    database / chunk artifacts (``core index`` CLI, M2.6).
    """
    names = names or CollectionNames()
    policy = retry or RetryPolicy()
    key = embedder_model_key(embedder)
    existing = {c.name for c in policy.call(client.get_collections).collections}
    generation = 1
    while names.physical(key, generation) in existing:
        generation += 1
    target = names.physical(key, generation)
    store = QdrantIndexStore(
        client,
        embedder,
        names=names,
        collection=target,
        sparse=sparse,
        batch_size=batch_size,
        retry=policy,
    )
    store.ensure_collection()
    count = points = 0
    for item in revisions:
        store.index_revision(item.workspace_id, item.document_id, item.revision_id, item.chunks)
        if item.active:
            store.activate_revision(item.workspace_id, item.document_id, item.revision_id)
        count += 1
        points += len(item.chunks)
    previous = switch_alias(client, names.alias, target, retry=policy) if switch else None
    return RebuildReport(
        alias=names.alias, collection=target, previous=previous, revisions=count, points=points
    )
