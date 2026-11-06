"""The owner's records, read only, through a link that opts in (UX12-SHARE-2; docs/workspace-sharing
.md §12, docs/screens/ux12-share-scope.md).

    GET /shared/{shareId}/owner-attempts      the owner's attempts, newest first
    GET /shared/{shareId}/owner-highlights    the owner's highlights, newest first

Same share checks as every guest read (quiz_api.api.shared). `include_owner_records` off answers
the shared routes' one 404 body. The records are those of `workspaces.owner_id`, from the link's
row: no request can name another user, so another member's records are out of reach here.

These routes only read, and they stay inside what a guest can already read:

- attempts: live CONFIRMED questions. Result and time only: never the submitted answer, the
  displayed options, the practice session or the revision (an answer may be the owner's own text,
  and an older revision is outside the share). Mock exam attempts are a separate table.
- highlights: an explanation highlight of a live CONFIRMED question whose quote is still in the
  current explanation; a note highlight of the very version the guest reads now, while the link
  includes notes. A quote from an older text is outside the share (§8).

Never returned: user ids, names, emails, anchors or context around a quote.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.api.highlights import Color, _Context
from quiz_api.api.history import decode_cursor, encode_cursor
from quiz_api.api.shared import NOT_FOUND, Shared
from quiz_api.api.shared_chapter_notes import _shareable
from quiz_api.chapter_notes import question_label, stem_preview
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.practice_grading import AttemptResult
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.chapter_notes import ChapterNoteRepository
from quiz_api.repositories.highlights import HighlightRepository, HighlightRow, QuestionText
from quiz_api.repositories.history import Cursor, HistoryRepository
from quiz_api.repositories.shared import SharedLink

router = APIRouter(prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503))

DEFAULT_PAGE = 50
MAX_PAGE = 100
MAX_CURSOR = 200
PUBLISHED = "CONFIRMED"

Limit = Annotated[int, Query(ge=1, le=MAX_PAGE)]
CursorParam = Annotated[str | None, Query(max_length=MAX_CURSOR)]


class OwnerRecordQuestion(BaseModel):
    question_id: uuid.UUID
    number_label: str = Field(description="`<번호>번` or `번호 없음` (the printed number).")
    stem_preview: str = Field(description="First 40 characters of the current stem.")


class SharedOwnerAttempt(BaseModel):
    id: uuid.UUID
    question: OwnerRecordQuestion
    question_type: QuestionType
    result: AttemptResult
    submitted_at: datetime


class SharedOwnerAttemptPage(BaseModel):
    items: list[SharedOwnerAttempt]
    next_cursor: str | None


class SharedOwnerHighlight(BaseModel):
    id: uuid.UUID
    kind: Literal["note", "explanation"]
    color: Color
    quote: str = Field(description="The highlighted text, as it stands in the shared text.")
    question: OwnerRecordQuestion | None = Field(description="Explanation highlights only.")
    chapter_title: str | None = Field(description="Note highlights only.")
    created_at: datetime


class SharedOwnerHighlightPage(BaseModel):
    items: list[SharedOwnerHighlight]
    next_cursor: str | None = Field(
        description="A page can hold fewer than `limit` items: rows outside the share are left out."
    )


def _records_of(link: SharedLink) -> uuid.UUID:
    if not link.include_owner_records or link.owner_id is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return link.owner_id


def _question(q: QuestionText) -> OwnerRecordQuestion:
    return OwnerRecordQuestion(
        question_id=q.question_id,
        number_label=question_label(q.question_number),
        stem_preview=stem_preview(q.stem),
    )


def get_history_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> HistoryRepository:
    return HistoryRepository(session)


def get_highlight_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> HighlightRepository:
    return HighlightRepository(session)


def get_note_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ChapterNoteRepository:
    return ChapterNoteRepository(session)


@router.get("/owner-attempts", operation_id="listSharedOwnerAttempts")
def list_shared_owner_attempts(
    link: Shared,
    repo: Annotated[HistoryRepository, Depends(get_history_repository)],
    limit: Limit = DEFAULT_PAGE,
    cursor: CursorParam = None,
) -> SharedOwnerAttemptPage:
    """The owner's attempts on published questions: result and time (UX12-SHARE-AC07/AC08)."""
    owner_id = _records_of(link)
    after = decode_cursor(cursor) if cursor else None
    items, next_cursor = repo.owner_attempts(link.workspace_id, owner_id, limit=limit, after=after)
    return SharedOwnerAttemptPage(
        items=[
            SharedOwnerAttempt(
                id=a.id,
                question=OwnerRecordQuestion(
                    question_id=a.question_id,
                    number_label=question_label(a.question_number),
                    stem_preview=stem_preview(a.stem),
                ),
                question_type=a.question_type,  # type: ignore[arg-type]
                result=a.result,
                submitted_at=a.submitted_at,
            )
            for a in items
        ],
        next_cursor=encode_cursor(next_cursor) if next_cursor else None,
    )


def _readable_notes(link: SharedLink, notes: ChapterNoteRepository) -> dict[uuid.UUID, str]:
    """Note versions a guest reads now (id → chapter title); none while notes are left out."""
    if not link.include_notes:
        return {}
    readable: dict[uuid.UUID, str] = {}
    for chapter in notes.workspace_chapters(link.workspace_id):
        found = _shareable(notes, chapter)
        if found is not None:
            readable[found[0].id] = chapter.title
    return readable


def _published_questions(
    link: SharedLink, repo: HighlightRepository, rows: list[HighlightRow]
) -> dict[uuid.UUID, QuestionText]:
    ids = [r.question_id for r in rows if r.target_kind == "explanation" and r.question_id]
    found = repo.questions(link.workspace_id, ids)
    return {qid: q for qid, q in found.items() if q.publication_status == PUBLISHED}


def _highlight(
    row: HighlightRow,
    ctx: _Context,
    questions: dict[uuid.UUID, QuestionText],
    notes: dict[uuid.UUID, str],
) -> SharedOwnerHighlight | None:
    """The guest's view of one row, or None when its text is outside the share."""
    if row.target_kind == "note":
        title = notes.get(row.chapter_note_id) if row.chapter_note_id else None
        if title is None:
            return None
        question, chapter_title = None, title
    elif row.target_kind == "explanation":
        text = questions.get(row.question_id) if row.question_id else None
        if text is None or ctx.current(row)[0] == "missing":
            return None
        question, chapter_title = _question(text), None
    else:  # AI explanation highlights are not available yet; never guess their scope.
        return None
    return SharedOwnerHighlight(
        id=row.id,
        kind=row.target_kind,  # type: ignore[arg-type]
        color=row.color,  # type: ignore[arg-type]
        quote=row.quote,
        question=question,
        chapter_title=chapter_title,
        created_at=row.created_at,
    )


@router.get("/owner-highlights", operation_id="listSharedOwnerHighlights")
def list_shared_owner_highlights(
    link: Shared,
    repo: Annotated[HighlightRepository, Depends(get_highlight_repository)],
    notes: Annotated[ChapterNoteRepository, Depends(get_note_repository)],
    limit: Limit = DEFAULT_PAGE,
    cursor: CursorParam = None,
) -> SharedOwnerHighlightPage:
    """The owner's highlights on text a guest can read now (UX12-SHARE-AC07/AC08)."""
    owner_id = _records_of(link)
    after = decode_cursor(cursor) if cursor else None
    rows = repo.live_page(
        owner_id,
        link.workspace_id,
        limit=limit + 1,
        after=(after.at, after.id) if after else None,
    )
    page = rows[:limit]
    questions = _published_questions(link, repo, page)
    readable = _readable_notes(link, notes) if any(r.target_kind == "note" for r in page) else {}
    ctx = _Context(repo, link.workspace_id)
    for text in questions.values():
        ctx.pin(text)
    items = [_highlight(r, ctx, questions, readable) for r in page]
    last = page[-1] if len(rows) > limit and page else None
    return SharedOwnerHighlightPage(
        items=[i for i in items if i is not None],
        next_cursor=encode_cursor(Cursor(last.created_at, last.id)) if last else None,
    )
