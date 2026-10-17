"""Dense embeddings (M2.1). The Qwen3-Embedding adapter ships with the ``models`` extra."""

from book_core.embedding.base import Embedder
from book_core.embedding.fake import FakeEmbedder

__all__ = ["Embedder", "FakeEmbedder"]
