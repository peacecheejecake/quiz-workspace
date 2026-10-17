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
