from __future__ import annotations

import math
from collections.abc import Sequence

from book_core._fake_text import features, stable_digest


class FakeEmbedder:
    """Deterministic feature-hashing embedder for tests and E2E (no model, no network).

    Each feature (word token / character bigram) is hashed with SHA-256 to a signed bucket; the
    bucket counts are L2-normalised. Texts sharing words therefore get a higher cosine
    similarity, which keeps fixture rankings meaningful. Queries and documents use the same
    mapping. Text without any word characters falls back to hashing the raw text, so every vector
    has unit length.
    """

    def __init__(self, dimension: int = 64, model_name: str = "fake-embedder") -> None:
        if dimension < 1:
            raise ValueError("dimension must be >= 1")
        self._dimension = dimension
        self._model_name = model_name

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)

    def _embed(self, text: str) -> list[float]:
        counts = [0] * self._dimension
        for feature in features(text) or [f"raw:{text}"]:
            digest = stable_digest(feature)
            bucket = int.from_bytes(digest[:8], "big") % self._dimension
            counts[bucket] += 1 if digest[8] & 1 else -1
        norm = math.sqrt(sum(c * c for c in counts))
        if norm == 0:
            # Signed counts cancelled out exactly; use a fixed one-hot vector to stay unit length.
            bucket = int.from_bytes(stable_digest(f"raw:{text}")[:8], "big") % self._dimension
            counts[bucket] = 1
            norm = 1.0
        return [c / norm for c in counts]
