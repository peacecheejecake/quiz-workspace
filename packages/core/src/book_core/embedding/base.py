from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable


@runtime_checkable
class Embedder(Protocol):
    """Dense text embedder.

    Queries and documents are embedded separately because instruction-tuned models (e.g.
    Qwen3-Embedding) prefix queries with a task instruction. Every vector has ``dimension``
    components.
    """

    @property
    def model_name(self) -> str: ...

    @property
    def dimension(self) -> int: ...

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class EmbeddingUnavailableError(RuntimeError):
    """The embedder cannot produce vectors right now (hosted API down, rate-limited, timed out,
    misconfigured or answering out of contract).

    Messages are written by the adapter (status codes, counts, dimensions) and never carry input
    text, credentials or account identifiers. ``code`` is a stable machine-readable reason; jobs
    store it and decide on retries with ``retryable``. Search treats any of these as "dense side
    unavailable" and falls back to BM25 (SEARCH-01-AC06).
    """

    code = "embedding_unavailable"
    retryable = True


class EmbeddingQuotaExceededError(EmbeddingUnavailableError):
    """Rate limit or plan quota exhausted (e.g. the Workers Free daily neuron allocation)."""

    code = "embedding_quota_exceeded"


class EmbeddingAuthError(EmbeddingUnavailableError):
    """Credentials missing or rejected: retrying cannot help until the operator fixes them."""

    code = "embedding_not_configured"
    retryable = False


class EmbeddingResponseError(EmbeddingUnavailableError):
    """The provider refused the input or answered out of contract (count, dimension, JSON)."""

    code = "embedding_invalid_response"
    retryable = False
