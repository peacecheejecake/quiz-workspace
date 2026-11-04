"""Question source regions (QSRC-API, QSRC-01 C01-C05; docs/questions.md §16).

    GET /questions/{id}/source-region                  any member (archived workspace included)
    GET /mock-exam-questions/{id}/source-region        `보기 섞기` mock question, by its origin

The response says where a question sits in its import PDF: per-page bbox unions of the
`question_sources` rows with an import run, in page order. It carries no text, answer,
explanation or block id. A question without such a region (manual, book-only, bbox-less, deleted
source document), a DRAFT or deleted question, and any non-member get one 404. Mock questions
follow their origin question and never use the mock's own evidence. Reading records nothing.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from quiz_api.api.questions import NOT_FOUND
from quiz_api.api.related_sources import MockAccess, QuestionAccess
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.repositories.source_region import Region, SourceRegionRepository

router = APIRouter(tags=["questions"], responses=problem_responses(503))


class RegionBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x0: float
    y0: float
    x1: float
    y1: float


class SourceRegionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: uuid.UUID
    document_revision_id: uuid.UUID | None
    page: int
    bbox: RegionBox


class QuestionSourceRegion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: uuid.UUID
    regions: list[SourceRegionItem]


class MockQuestionSourceRegion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mock_exam_question_id: uuid.UUID
    regions: list[SourceRegionItem]


def get_repo(session: Annotated[Session, Depends(get_db_session)]) -> SourceRegionRepository:
    return SourceRegionRepository(session)


Repo = Annotated[SourceRegionRepository, Depends(get_repo)]


def _items(regions: list[Region]) -> list[SourceRegionItem]:
    if not regions:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return [
        SourceRegionItem(
            document_id=r.document_id,
            document_revision_id=r.document_revision_id,
            page=r.page,
            bbox=RegionBox(x0=r.x0, y0=r.y0, x1=r.x1, y1=r.y1),
        )
        for r in regions
    ]


@router.get("/questions/{question_id}/source-region", operation_id="getQuestionSourceRegion")
def get_question_source_region(
    access: QuestionAccess, repo: Repo, response: Response
) -> QuestionSourceRegion:
    """Where the question sits in its import PDF (QSRC-01-C01); 404 when it has no region."""
    response.headers["Cache-Control"] = "private, no-store"
    workspace_id = access.workspace.workspace_id
    if not repo.question_is_readable(workspace_id, access.resource_id):
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return QuestionSourceRegion(
        question_id=access.resource_id,
        regions=_items(repo.question_regions(workspace_id, access.resource_id)),
    )


@router.get(
    "/mock-exam-questions/{mock_exam_question_id}/source-region",
    operation_id="getMockExamQuestionSourceRegion",
)
def get_mock_exam_question_source_region(
    access: MockAccess, repo: Repo, response: Response
) -> MockQuestionSourceRegion:
    """The origin question's regions for a `보기 섞기` mock question (QSRC-01-C04)."""
    response.headers["Cache-Control"] = "private, no-store"
    workspace_id = access.workspace.workspace_id
    origin = repo.mock_origin(workspace_id, access.resource_id)
    if origin is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return MockQuestionSourceRegion(
        mock_exam_question_id=access.resource_id,
        regions=_items(repo.question_regions(workspace_id, origin)),
    )
