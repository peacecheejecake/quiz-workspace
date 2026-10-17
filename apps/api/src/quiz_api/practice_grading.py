"""Server-side grading and option shuffling for practice sessions (M5.2, docs/questions.md §4).

Pure functions, no I/O:

* `shuffled_option_ids`: the displayed order of an MCQ's options for one session, from a seed
  drawn with the OS CSPRNG (`new_shuffle_seed`). The session stores both the seed and the
  resulting id list; grading never looks at positions, only at the stable option ids.
* `grade_mcq`: set equality of the selected ids and the revision's correct ids (order-free,
  single and multi answer alike). An MCQ without a known answer is not auto-gradable.
* `grade_short_answer`: the answer matches an accepted answer after `normalize_answer`
  (NFKC, case folding, whitespace collapse, trim; tests/e2e/fixtures/questions.ts A11). Without
  accepted answers the question is not auto-gradable.
* ESSAY questions are never auto-graded.

Not auto-gradable → `pending`: the user grades it themself (`self-grade`).
"""

from __future__ import annotations

import random
import re
import secrets
import unicodedata
from collections.abc import Sequence
from typing import Literal

AttemptResult = Literal["correct", "incorrect", "pending"]
GradedResult = Literal["correct", "incorrect"]

# practice_sessions.shuffle_seed is a signed bigint.
_SEED_BITS = 63
_WHITESPACE = re.compile(r"\s+")


def new_shuffle_seed() -> int:
    return secrets.randbits(_SEED_BITS)


def shuffled_option_ids(option_ids: Sequence[str], seed: int) -> list[str]:
    """Deterministic permutation of `option_ids` for `seed` (reproducible from the stored seed)."""
    out = list(option_ids)
    random.Random(seed).shuffle(out)  # noqa: S311 - display order only; the seed is CSPRNG-drawn
    return out


def normalize_answer(text: str) -> str:
    """NFKC, case-folded (NFKC again: folding can denormalize), whitespace collapsed, trimmed."""
    folded = unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", text).casefold())
    return _WHITESPACE.sub(" ", folded).strip()


def grade_mcq(selected: Sequence[str], correct: Sequence[str] | None) -> AttemptResult:
    if not correct:
        return "pending"
    return "correct" if set(selected) == set(correct) else "incorrect"


def grade_short_answer(answer: str, accepted: Sequence[str] | None) -> AttemptResult:
    if not accepted:
        return "pending"
    given = normalize_answer(answer)
    return "correct" if any(given == normalize_answer(a) for a in accepted) else "incorrect"
