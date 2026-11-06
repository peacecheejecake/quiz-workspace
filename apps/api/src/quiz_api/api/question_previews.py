"""Footnote question previews (UX9-NOTE-B, CHNOTE-02-C01/C02; docs/screens/chapter-note-tools.md).

    GET /questions/{id}/preview                          any member (archived workspace included)
    GET /shared/{shareId}/questions/{questionId}/preview share guest

A chapter-note footnote shows its question's stem and options on hover/focus. The DTO is closed:
`{question_id, number_label, chapter_title, question_type, stem, options: [{id, text}]}`
(options in their original order). It never carries correct option ids, accepted answers,
explanations, rubrics, AI explanations, highlights or sources, so a preview never reveals an
answer before submission.

Only a live CONFIRMED question at its active revision is served; drafts, archived, deleted,
foreign and unknown questions answer one 404 body. Guests get the share's published scope (the
link's workspace, CONFIRMED questions; same rule as `GET /shared/{shareId}/questions/{id}` and the
shared note footnote links, CHNOTE-01-C05), after the usual share-session checks
(quiz_api.api.shared). A chapter whose document is not shared is not named to a guest.

Reading records nothing: no view (`question_user_states`), practice session, attempt or activity
(hover is not a view, docs/questions.md §2.1).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

from quiz_api.api.questions import NOT_FOUND, QuestionRepo, ReadQuestion
from quiz_api.api.shared import QuestionRepo as SharedQuestionRepo
from quiz_api.api.shared import SearchRepo, Shared, _published
from quiz_api.chapter_notes import question_label
from quiz_api.errors import problem_responses
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.questions import QuestionRecord
from quiz_api.stem_tables import STEM_TABLES_DESCRIPTION, StemTable, stem_tables_out

router = APIRouter(tags=["questions"], responses=problem_responses(503))
shared_router = APIRouter(
    prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503)
)


class PreviewOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str


class QuestionPreview(BaseModel):
    """Stem and options only: no answer, explanation, rubric, source or per-user field."""

    model_config = ConfigDict(extra="forbid")

    question_id: uuid.UUID
    number_label: str = Field(description='"<번호>번" or "번호 없음".')
    chapter_title: str | None
    question_type: QuestionType
    stem: str = Field(description="The active revision's stem, unaltered.")
    stem_tables: list[StemTable | None] | None = Field(
        default=None, description=STEM_TABLES_DESCRIPTION
    )
    options: list[PreviewOption] = Field(description="Original order; empty for text answers.")


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def preview_out(q: QuestionRecord, *, chapter_visible: bool) -> QuestionPreview:
    title = q.chapter.title if q.chapter is not None and chapter_visible else None
    return QuestionPreview(
        question_id=q.id,
        number_label=question_label(q.question_number),
        chapter_title=title,
        question_type=q.question_type,
        stem=q.revision.stem,
        stem_tables=stem_tables_out(q.revision.stem_tables),
        options=[PreviewOption(id=o["id"], text=o["text"]) for o in q.revision.options],
    )


@router.get("/questions/{question_id}/preview", operation_id="getQuestionPreview")
def get_question_preview(access: ReadQuestion, questions: QuestionRepo) -> QuestionPreview:
    """A chapter-note footnote preview (CHNOTE-02-C01): stem and options of a live CONFIRMED
    question, no answer or explanation. Records no view."""
    found = questions.get(access.resource_id, with_sources=False)
    if (
        found is None
        or found.workspace_id != access.workspace.workspace_id
        or found.publication_status != "CONFIRMED"
    ):
        raise _not_found()
    return preview_out(found, chapter_visible=True)


@shared_router.get("/questions/{question_id}/preview", operation_id="getSharedQuestionPreview")
def get_shared_question_preview(
    link: Shared,
    question_id: Annotated[str, Path(max_length=64)],
    questions: SharedQuestionRepo,
    search_repo: SearchRepo,
) -> QuestionPreview:
    """The member preview's DTO for a question in the share's published scope (CHNOTE-02-C02);
    anything else is the same 404."""
    try:
        qid = uuid.UUID(question_id)
    except ValueError:
        raise _not_found() from None
    found = questions.get(qid, with_sources=False)
    if (
        found is None
        or found.workspace_id != link.workspace_id
        or found.publication_status != "CONFIRMED"
    ):
        raise _not_found()
    visible = found.chapter is not None and found.chapter.document_id in set(
        _published(search_repo, link)
    )
    return preview_out(found, chapter_visible=visible)
