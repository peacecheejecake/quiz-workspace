from __future__ import annotations

from collections.abc import Sequence

from book_core._fake_text import features


class FakeReranker:
    """Deterministic reranker: fraction of distinct query features present in the passage.

    Scores are in ``[0, 1]``, depend only on the two texts, and need no model or network.
    """

    def __init__(self, model_name: str = "fake-reranker") -> None:
        self._model_name = model_name

    @property
    def model_name(self) -> str:
        return self._model_name

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        query_features = set(features(query))
        if not query_features:
            return [0.0] * len(passages)
        return [
            len(query_features & set(features(passage))) / len(query_features)
            for passage in passages
        ]
