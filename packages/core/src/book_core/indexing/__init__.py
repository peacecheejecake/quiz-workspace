"""Qdrant dense + BM25 sparse indexing and active-revision switching: Task M2.2.

``QdrantIndexStore`` writes one revision of a document (children with dense + sparse vectors,
parents as vector-less context points), activates it only after it is completely written, and
garbage-collects older revisions on request. ``SearchScope`` is the mandatory read filter
(workspace + DB-known published revision ids). ``rebuild`` builds a fresh physical collection and
switches the ``documents_v1`` alias atomically.
"""

from book_core.indexing.naming import (
    DOCUMENTS_ALIAS,
    PAYLOAD_SCHEMA_VERSION,
    CollectionNames,
    embedder_model_key,
    model_key,
)
from book_core.indexing.retry import RetryPolicy, is_transient
from book_core.indexing.sparse import BM25_VERSION, Bm25Encoder, SparseVector, tokenize
from book_core.indexing.store import (
    DENSE_VECTOR,
    SPARSE_VECTOR,
    Candidate,
    IndexReport,
    IndexSchemaError,
    IndexStore,
    IndexStoreError,
    QdrantIndexStore,
    RebuildReport,
    RevisionChunks,
    RevisionNotReadyError,
    SearchScope,
    alias_target,
    chunk_from_payload,
    chunk_payload,
    point_id,
    rebuild,
    scope_filter,
    switch_alias,
)

__all__ = [
    "BM25_VERSION",
    "DENSE_VECTOR",
    "DOCUMENTS_ALIAS",
    "PAYLOAD_SCHEMA_VERSION",
    "SPARSE_VECTOR",
    "Bm25Encoder",
    "Candidate",
    "CollectionNames",
    "IndexReport",
    "IndexSchemaError",
    "IndexStore",
    "IndexStoreError",
    "QdrantIndexStore",
    "RebuildReport",
    "RetryPolicy",
    "RevisionChunks",
    "RevisionNotReadyError",
    "SearchScope",
    "SparseVector",
    "alias_target",
    "chunk_from_payload",
    "chunk_payload",
    "embedder_model_key",
    "is_transient",
    "model_key",
    "point_id",
    "rebuild",
    "scope_filter",
    "switch_alias",
    "tokenize",
]
