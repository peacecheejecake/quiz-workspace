from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable


@runtime_checkable
class Reranker(Protocol):
    """Cross-encoder style relevance scorer.

    ``score`` returns one score per passage, in input order; higher is more relevant. Ordering,
    tie-breaking and candidate counts are the caller's (search) responsibility.
    """

    @property
    def model_name(self) -> str: ...

    def score(self, query: str, passages: Sequence[str]) -> list[float]: ...
