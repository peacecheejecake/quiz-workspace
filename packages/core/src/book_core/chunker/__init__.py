"""Parent/child chunking with block/page provenance into ``SearchChunk``: Task M1.4.

``chunk_revision`` turns a canonical ``DocumentRevision`` into section-scoped parent chunks
(context) and retrieval-sized child chunks with stable ids, contextual ``search_text``
(breadcrumb + content), content hashes and page/bbox provenance. ``diff_chunks`` compares the
chunks of two revisions for incremental re-indexing.
"""

from book_core.chunker.diff import ChunkDiff, diff_chunks
from book_core.chunker.hierarchical import (
    ChunkedRevision,
    ChunkerConfig,
    ChunkingError,
    bound_breadcrumb,
    chunk_revision,
    detect_language,
)
from book_core.chunker.sentences import (
    oversized_spans,
    sentence_spans,
    split_oversized,
    split_sentences,
)
from book_core.chunker.tokens import ApproxTokenizer, Tokenizer

__all__ = [
    "ApproxTokenizer",
    "ChunkDiff",
    "ChunkedRevision",
    "ChunkerConfig",
    "ChunkingError",
    "Tokenizer",
    "bound_breadcrumb",
    "chunk_revision",
    "detect_language",
    "diff_chunks",
    "oversized_spans",
    "sentence_spans",
    "split_oversized",
    "split_sentences",
]
