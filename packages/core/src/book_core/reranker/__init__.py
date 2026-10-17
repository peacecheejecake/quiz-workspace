"""Reranking of search candidates (M2.4).

``FakeReranker`` is deterministic and model-free (tests, E2E). ``Qwen3Reranker`` needs the
``models`` extra; torch/transformers are imported only when it first scores, so importing this
package stays light.
"""

from book_core.reranker.base import Reranker
from book_core.reranker.fake import FakeReranker
from book_core.reranker.qwen3 import (
    DEFAULT_RERANK_INSTRUCTION,
    DEFAULT_RERANKER_MODEL_ID,
    DEFAULT_RERANKER_REVISION,
    Qwen3Reranker,
    Qwen3RerankerConfig,
)

__all__ = [
    "DEFAULT_RERANKER_MODEL_ID",
    "DEFAULT_RERANKER_REVISION",
    "DEFAULT_RERANK_INSTRUCTION",
    "FakeReranker",
    "Qwen3Reranker",
    "Qwen3RerankerConfig",
    "Reranker",
]
