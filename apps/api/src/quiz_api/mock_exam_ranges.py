"""The one seam between mock exams and the shared range resolver (MOCK-01-C03, C08).

A mock exam's range is resolved by `quiz_api.question_ranges` (QVIEW-B, shared with QVIEW-01
practice runs): the workspace's live CONFIRMED questions (archived, drafts and merged duplicates
excluded; filters judged on the caller's merged study state), in Heatmap order.

A range the person sends (create, 설정 바꾸기 with a range) is checked: ids of another workspace,
drafts, archived or unknown questions and unknown chapters are 422 `range-invalid`. A saved range
re-resolved by 다시 만들기 is resolved "with the questions of the time": questions deleted or
archived since (a picked duplicate merged away included) simply drop out and are not replaced, so
a range left with nothing is the caller's 409 `no-matching-questions` (C08).
"""

from __future__ import annotations

import uuid

from book_core.mock_exam import PlanCandidate
from sqlalchemy.orm import Session

from quiz_api.question_ranges import QuestionRange, QuestionRangeResolver, RangeRow


def chapter_ranks(rows: list[RangeRow]) -> list[int]:
    """Each row's chapter rank in Heatmap order: chapters numbered as they first appear,
    questions without a chapter after every chapter."""
    ranks: dict[uuid.UUID, int] = {}
    for r in rows:
        if r.chapter_id is not None and r.chapter_id not in ranks:
            ranks[r.chapter_id] = len(ranks)
    return [ranks[r.chapter_id] if r.chapter_id is not None else len(ranks) for r in rows]


def resolve_candidates(
    session: Session,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    range_: QuestionRange,
    *,
    saved: bool = False,
) -> list[PlanCandidate]:
    """The range's questions in Heatmap order, each with its pinned active revision and its
    chapter's Heatmap rank (possibly empty). Raises the resolver's 422 `range-invalid` unless
    `saved` (a stored range re-resolved, see the module docstring)."""
    rows = QuestionRangeResolver(session).resolve_rows(
        workspace_id, user_id, range_, drop_unknown=saved
    )
    out: list[PlanCandidate] = []
    for row, rank in zip(rows, chapter_ranks(rows), strict=True):
        out.append(
            PlanCandidate(
                question_id=str(row.question_id),
                question_revision_id=str(row.revision_id),
                chapter_rank=rank,
            )
        )
    return out
