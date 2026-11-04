"""Shared (guest) AI explanations (EXPL-B; docs/workspace-sharing.md §10, AIEXPL-01-C02).

    GET /shared/{shareId}/questions/{questionId}/ai-explanation    the explanation (read-only)

A guest reads the newest succeeded, not superseded explanation of a published (CONFIRMED)
question's active revision — one that a member already made: a guest never starts one (no cost).
Same share checks as every guest read (quiz_api.api.shared: the session cookie of this link,
re-validated per request, so a revoked link stops at once) and the shared routes' one 404 body
for unknown ids, other workspaces, unpublished questions and questions without an explanation.
Never returned: ids, status, version, error codes, usage or job ids. Mock exam questions have no
shared route (mock exams are not shared).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from book_core.explain import PROMPT_VERSION
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from quiz_api.api.ai_explanations import ExplanationBody, ExplanationSource
from quiz_api.api.shared import Shared
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.repositories.ai_explanations import ExplanationRepository
from quiz_api.repositories.search import SearchRepository
from quiz_api.settings import Settings

router = APIRouter(prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503))

NOT_FOUND = "Not found."  # the shared routes' one 404 body


class SharedExplanation(BaseModel):
    body: ExplanationBody
    sources: list[ExplanationSource]
    created_at: datetime


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


@router.get(
    "/questions/{question_id}/ai-explanation", operation_id="getSharedQuestionAiExplanation"
)
def get_shared_question_explanation(
    link: Shared,
    question_id: Annotated[str, Path(max_length=64)],
    request: Request,
    session: Annotated[Session, Depends(get_db_session)],
) -> SharedExplanation:
    """The AI explanation of one published question, as members see it (read-only)."""
    settings: Settings = request.app.state.settings
    repo = ExplanationRepository(session)
    qid = _uuid(question_id)
    target = repo.bank_question(qid) if qid else None
    if (
        target is None
        or target.workspace_id != link.workspace_id
        or target.publication_status != "CONFIRMED"
    ):
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    row = repo.current(
        "question", target.revision_id, PROMPT_VERSION, settings.ai_explanation_model
    )
    if row is None or row.body is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    visible = {d.id for d in SearchRepository(session).searchable_documents(link.workspace_id)}
    return SharedExplanation(
        body=ExplanationBody.model_validate(row.body),
        sources=[
            ExplanationSource(
                n=s.number,
                document_id=s.document_id,
                document_title=s.document_title,
                chapter_title=s.chapter_title,
                page=s.page,
                block_id=s.block_id,
                block_ids=list(s.block_ids),
                revision_id=s.revision_id,
                outdated=s.outdated,
            )
            for s in repo.source_views(link.workspace_id, row.sources, visible)
        ],
        created_at=row.created_at,
    )
