"""The one seam between mock exams and the shared range resolver (MOCK-B ↔ QVIEW-B).

A mock exam's range is resolved by `quiz_api.question_ranges` (QVIEW-B, shared with QVIEW-01
practice runs): the workspace's live CONFIRMED questions (archived, drafts and merged duplicates
excluded; filters judged on the merged study state), in Heatmap order; ids of another workspace,
drafts or unknown ids are 422 `range-invalid`. MOCK-B does not build its own resolver: until
QVIEW-B is merged, `resolve_candidates` answers 503 and the range wiring lands in MOCK-B-2.
"""

from __future__ import annotations

import uuid
from typing import Any

from book_core.mock_exam import PlanCandidate
from fastapi import HTTPException
from sqlalchemy.orm import Session


def resolve_candidates(
    session: Session, workspace_id: uuid.UUID, user_id: uuid.UUID, range_: dict[str, Any]
) -> list[PlanCandidate]:
    """The range's questions in Heatmap order, each with its pinned active revision and its
    chapter's Heatmap rank. Raises the resolver's 422 `range-invalid`."""
    raise HTTPException(
        status_code=503,
        detail="Question ranges are not available yet.",
    )
