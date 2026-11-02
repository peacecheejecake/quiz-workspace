"""`OPTION_SHUFFLE` mock exam questions (questions.md §11): the pinned source revision copied
as is, its options reordered by the generation's seed. No LLM. Option ids stay the source's, so
grading by option id is unchanged."""

from __future__ import annotations

import random
from collections.abc import Sequence


def shuffled_options[T](options: Sequence[T], seed: int, position: int) -> list[T]:
    """Deterministic order of one copy: the same seed and plan position, the same order. With
    two or more options the order always differs from the source's."""
    out = list(options)
    if len(out) < 2:
        return out
    rng = random.Random(f"mock_exam:{seed}:{position}")  # noqa: S311 - display order, not security
    for _ in range(8):
        rng.shuffle(out)
        if out != list(options):
            return out
    return out[1:] + out[:1]
