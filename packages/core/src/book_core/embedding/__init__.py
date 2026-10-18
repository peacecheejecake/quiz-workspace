"""Dense embeddings (M2.1).

``FakeEmbedder`` is deterministic and model-free (tests, E2E). ``Qwen3Embedder`` and the chunker
tokenizer ``Qwen3Tokenizer`` need the ``models`` extra; torch/transformers are imported only when a
model is first used, so importing this package stays light.
"""

from book_core.embedding.base import Embedder
from book_core.embedding.factory import EmbedderMode, select_embedder, uses_fake_embedder
from book_core.embedding.fake import FakeEmbedder
from book_core.embedding.qwen3 import (
    DEFAULT_MODEL_ID,
    DEFAULT_QUERY_INSTRUCTION,
    DEFAULT_REVISION,
    ModelUnavailableError,
    Qwen3Embedder,
    Qwen3EmbedderConfig,
    Qwen3Tokenizer,
)

__all__ = [
    "DEFAULT_MODEL_ID",
    "DEFAULT_QUERY_INSTRUCTION",
    "DEFAULT_REVISION",
    "Embedder",
    "EmbedderMode",
    "FakeEmbedder",
    "ModelUnavailableError",
    "Qwen3Embedder",
    "Qwen3EmbedderConfig",
    "Qwen3Tokenizer",
    "select_embedder",
    "uses_fake_embedder",
]
