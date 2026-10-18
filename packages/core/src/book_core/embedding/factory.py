"""Embedder selection shared by every process that reads or writes the document index.

The worker (indexing) and the API (query embedding for search) must embed with the same model:
the Qdrant collection is keyed by the embedder's model key, and a query vector from another model
is meaningless. Both call ``select_embedder`` with the same settings (``WORKER_EMBEDDER``,
``APP_ENV``, ``WORKER_MODELS_OFFLINE``, ``CLOUDFLARE_*``), so the choice lives in one place.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING

from book_core.embedding.base import Embedder, EmbeddingAuthError
from book_core.embedding.fake import FakeEmbedder

if TYPE_CHECKING:
    from book_core.embedding.workers_ai import WorkersAIConfig


class EmbedderMode(StrEnum):
    """``auto``: ``FakeEmbedder`` in the test environment, local Qwen3-Embedding elsewhere.
    ``qwen3``: local Qwen3-Embedding (``models`` extra). ``workers_ai``: the same model on
    Cloudflare Workers AI (staging/production, M7.4b). ``fake``: local/test only."""

    AUTO = "auto"
    QWEN3 = "qwen3"
    WORKERS_AI = "workers_ai"
    FAKE = "fake"


def uses_fake_embedder(mode: EmbedderMode | str, *, test_env: bool) -> bool:
    mode = EmbedderMode(mode)
    return mode is EmbedderMode.FAKE or (mode is EmbedderMode.AUTO and test_env)


def uses_local_model(mode: EmbedderMode | str, *, test_env: bool) -> bool:
    """Whether ``mode`` loads Qwen3 weights in this process (needs torch/transformers)."""
    mode = EmbedderMode(mode)
    return mode is EmbedderMode.QWEN3 or (mode is EmbedderMode.AUTO and not test_env)


def select_embedder(
    mode: EmbedderMode | str,
    *,
    test_env: bool,
    local_files_only: bool = False,
    workers_ai: WorkersAIConfig | None = None,
) -> Embedder:
    """The embedder for ``mode``. Qwen3 weights load lazily on first use (or when its
    ``dimension`` is first read); ``workers_ai`` needs ``workers_ai`` (credentials) and never
    calls the API before the first embedding."""
    if uses_fake_embedder(mode, test_env=test_env):
        return FakeEmbedder()
    if EmbedderMode(mode) is EmbedderMode.WORKERS_AI:
        if workers_ai is None:
            raise EmbeddingAuthError(
                "WORKER_EMBEDDER=workers_ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
            )
        from book_core.embedding.workers_ai import WorkersAIEmbedder

        return WorkersAIEmbedder(workers_ai)
    from book_core.embedding.qwen3 import Qwen3Embedder, Qwen3EmbedderConfig

    return Qwen3Embedder(Qwen3EmbedderConfig(local_files_only=local_files_only))


__all__ = ["EmbedderMode", "select_embedder", "uses_fake_embedder", "uses_local_model"]
