"""The seed-reproducible plan of one mock exam generation (MOCK-01-C03).

From the range's candidates (the workspace's live CONFIRMED questions in Heatmap order) the plan
picks ``min(count, candidates)`` sources with ``random.Random(seed)`` (all of them when the count
covers the range) and assigns each one of the chosen variation types, rotated evenly and shuffled
by the same seed. Plan items keep Heatmap order (``position`` 0, 1, ...), so the same seed and
the same candidates always give the same sources, types and positions.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass

from book_core.contracts import VariationType

MAX_SEED = 2**31 - 1
"""``mock_exam_generations.seed`` range (0..MAX_SEED)."""

MAX_AI_QUESTIONS = 100
"""문항 수 with an AI variation type (MOCK-01-C06)."""

MAX_RANGE_QUESTIONS = 5000
"""보기 섞기 only: the range size, at most the practice run limit."""

DEFAULT_QUESTION_COUNT = 20

AI_VARIATION_TYPES: frozenset[VariationType] = frozenset(
    {VariationType.PARAPHRASE, VariationType.INVERT_POLARITY, VariationType.ANALOGOUS_CONCEPT}
)


@dataclass(frozen=True, slots=True)
class PlanCandidate:
    """A question the range resolves to, in Heatmap order."""

    question_id: str
    question_revision_id: str
    chapter_rank: int
    """Rank of the question's chapter in Heatmap order (questions without one last)."""


@dataclass(frozen=True, slots=True)
class PlanItem:
    position: int
    question_id: str
    question_revision_id: str
    variation_type: VariationType
    chapter_rank: int

    def as_json(self) -> dict[str, object]:
        return {
            "position": self.position,
            "question_id": self.question_id,
            "question_revision_id": self.question_revision_id,
            "variation_type": self.variation_type.value,
            "chapter_rank": self.chapter_rank,
        }

    @classmethod
    def from_json(cls, raw: dict[str, object]) -> PlanItem:
        return cls(
            position=int(str(raw["position"])),
            question_id=str(raw["question_id"]),
            question_revision_id=str(raw["question_revision_id"]),
            variation_type=VariationType(str(raw["variation_type"])),
            chapter_rank=int(str(raw.get("chapter_rank", 0))),
        )


def uses_llm(variation_types: Sequence[VariationType]) -> bool:
    return any(v in AI_VARIATION_TYPES for v in variation_types)


def make_plan(
    candidates: Sequence[PlanCandidate],
    count: int | None,
    variation_types: Sequence[VariationType],
    seed: int,
) -> list[PlanItem]:
    """The generation's plan; ``count`` None = every candidate (보기 섞기 only)."""
    if not variation_types:
        raise ValueError("at least one variation type")
    if not 0 <= seed <= MAX_SEED:
        raise ValueError("seed out of range")
    types = list(dict.fromkeys(variation_types))
    rng = random.Random(seed)  # noqa: S311 - reproducible selection, not security
    total = len(candidates)
    wanted = total if count is None else min(count, total)
    chosen = list(range(total)) if wanted >= total else sorted(rng.sample(range(total), wanted))
    assigned = [types[i % len(types)] for i in range(len(chosen))]
    rng.shuffle(assigned)
    return [
        PlanItem(
            position=position,
            question_id=candidates[index].question_id,
            question_revision_id=candidates[index].question_revision_id,
            variation_type=assigned[position],
            chapter_rank=candidates[index].chapter_rank,
        )
        for position, index in enumerate(chosen)
    ]
