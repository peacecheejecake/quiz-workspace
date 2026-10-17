"""Per-user question study status (docs/questions.md §2.1, §7), the Python twin of
packages/ui/src/questions/status.ts (`deriveDotStatus`, `summarizeStatuses`).

Both implementations are checked against the same truth table,
contracts/question-status.truth.json (apps/api/tests/test_question_status.py and
packages/ui/test/question-status-parity.test.ts): change the rule in both places and the table.

Priority: retry > last graded incorrect > last graded correct > viewed > unseen. Favorite never
affects the status (it only swaps the marker shape) and is counted separately, overlapping the
mutually exclusive status counts. A pending (ungraded) submission is not a graded result: the
status stays `viewed` (or the previous graded result) and only `is_pending_grading` says so.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

DotStatus = Literal["unseen", "viewed", "incorrect", "correct", "retry"]
LastGradedResult = Literal["correct", "incorrect"]

# Legend / summary order (matches @quiz/design-tokens `questionStatuses`).
DOT_STATUSES: tuple[DotStatus, ...] = ("unseen", "viewed", "incorrect", "correct", "retry")


@dataclass(frozen=True)
class StudyState:
    """`question_user_states` of one user and question; no row = all defaults."""

    first_viewed_at: datetime | str | None = None
    last_graded_result: LastGradedResult | None = None
    needs_retry: bool = False
    is_favorite: bool = False


def derive_dot_status(state: StudyState) -> DotStatus:
    if state.needs_retry:
        return "retry"
    if state.last_graded_result == "incorrect":
        return "incorrect"
    if state.last_graded_result == "correct":
        return "correct"
    if state.first_viewed_at:
        return "viewed"
    return "unseen"


def summarize(items: Iterable[tuple[DotStatus, bool]]) -> dict[str, int]:
    """Header counts from `(status, is_favorite)` pairs: `total`, one count per status (each item
    counted exactly once) and an overlapping `favorite` count."""
    counts: dict[str, int] = {"total": 0, "favorite": 0, **dict.fromkeys(DOT_STATUSES, 0)}
    for status, is_favorite in items:
        counts["total"] += 1
        counts[status] += 1
        if is_favorite:
            counts["favorite"] += 1
    return counts
