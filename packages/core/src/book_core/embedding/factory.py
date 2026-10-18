"""Embedder selection shared by every process that reads or writes the document index.

The worker (indexing) and the API (query embedding for search) must embed with the same model:
the Qdrant collection is keyed by the embedder's model key, and a query vector from another model
is meaningless. Both call ``select_embedder`` with the same settings (``WORKER_EMBEDDER``,
``APP_ENV``, ``WORKER_MODELS_OFFLINE``), so the choice lives in one place.
"""

from __future__ import annotations

from enum import StrEnum

from book_core.embedding.base import Embedder
from book_core.embedding.fake import FakeEmbedder


class EmbedderMode(StrEnum):
    """``auto``: ``FakeEmbedder`` in the test environment, Qwen3-Embedding elsewhere."""

    AUTO = "auto"
    QWEN3 = "qwen3"
    FAKE = "fake"


def uses_fake_embedder(mode: EmbedderMode | str, *, test_env: bool) -> bool:
    mode = EmbedderMode(mode)
    return mode is EmbedderMode.FAKE or (mode is EmbedderMode.AUTO and test_env)


def select_embedder(
    mode: EmbedderMode | str, *, test_env: bool, local_files_only: bool = False
) -> Embedder:
    """The embedder for ``mode``. Qwen3 weights load lazily on first use (or when its
    ``dimension`` is first read)."""
    if uses_fake_embedder(mode, test_env=test_env):
        return FakeEmbedder()
    from book_core.embedding.qwen3 import Qwen3Embedder, Qwen3EmbedderConfig

    return Qwen3Embedder(Qwen3EmbedderConfig(local_files_only=local_files_only))


__all__ = ["EmbedderMode", "select_embedder", "uses_fake_embedder"]
