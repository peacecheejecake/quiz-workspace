"""Shared (guest) chapter notes (CHNOTE-B; docs/workspace-sharing.md §8, CHNOTE-01-C05/C08).

    GET /shared/{shareId}/chapter-notes                     chapters with a shareable note
    GET /shared/{shareId}/chapters/{chapterId}/note         that note (read-only)

A guest reads only the newest succeeded version of a chapter's note, and only while it is
*source-matched*: every question it cites is alive, CONFIRMED and still at the revision the note
was made from. A note citing a deleted, archived or edited question may hold answers or
explanations that are no longer published, so it is withheld (404, left out of the list) until a
member regenerates it; a question merely added to the chapter does not withhold it (`stale`).
Older versions are never served instead.

Same share checks as every guest read (quiz_api.api.shared: the session cookie of this link,
re-validated per request, so a revoked link stops at once) and one 404 body for unknown ids,
chapters of other workspaces, chapters without a shareable note and withheld notes. Never
returned: versions, generation state, error codes, usage, job ids, input fingerprints or question
revision ids.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.api.chapter_notes import NoteFootnote, NoteItem, NoteSection, current_fingerprint
from quiz_api.api.shared import Shared
from quiz_api.chapter_notes import present_body
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.repositories.chapter_notes import ChapterNoteRepository, ChapterRecord, NoteRow

router = APIRouter(prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503))

NOT_FOUND = "Not found."  # the shared routes' one 404 body


class SharedChapterNoteSummary(BaseModel):
    chapter_id: uuid.UUID
    chapter_title: str


class SharedChapterNoteList(BaseModel):
    items: list[SharedChapterNoteSummary] = Field(
        description="Chapters whose newest note can be shown, in outline order."
    )


class SharedChapterNote(BaseModel):
    chapter_id: uuid.UUID
    chapter_title: str
    created_at: datetime
    question_count: int
    stale: bool = Field(description="Questions were added to the chapter since the note.")
    sections: list[NoteSection]
    footnotes: list[NoteFootnote] = Field(
        description="`question_id` links a published question (the shared question panel)."
    )


def get_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ChapterNoteRepository:
    return ChapterNoteRepository(session)


Repo = Annotated[ChapterNoteRepository, Depends(get_repository)]


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _shareable(
    repo: ChapterNoteRepository, chapter: ChapterRecord
) -> tuple[NoteRow, dict[uuid.UUID, str]] | None:
    """The newest version when it is source-matched, with the stems of its cited questions."""
    note = repo.note(chapter, None)
    if note is None or not note.refs:
        return None
    live = repo.live_questions(chapter.workspace_id, (r.question_id for r in note.refs))
    stems: dict[uuid.UUID, str] = {}
    for ref in note.refs:
        q = live.get(ref.question_id)
        if (
            q is None
            or q.deleted
            or q.publication_status != "CONFIRMED"
            or q.active_revision_id != ref.question_revision_id
            or q.stem is None
        ):
            return None
        stems[q.question_id] = q.stem
    return note, stems


@router.get("/chapter-notes", operation_id="listSharedChapterNotes")
def list_shared_chapter_notes(link: Shared, repo: Repo) -> SharedChapterNoteList:
    """Chapters of published documents whose newest note is source-matched."""
    items = [
        SharedChapterNoteSummary(chapter_id=c.id, chapter_title=c.title)
        for c in repo.workspace_chapters(link.workspace_id)
        if _shareable(repo, c) is not None
    ]
    return SharedChapterNoteList(items=items)


@router.get("/chapters/{chapter_id}/note", operation_id="getSharedChapterNote")
def get_shared_chapter_note(
    link: Shared,
    chapter_id: Annotated[str, Path(max_length=64)],
    repo: Repo,
) -> SharedChapterNote:
    """The chapter's newest note, read-only, when it is source-matched (else 404)."""
    try:
        parsed = uuid.UUID(chapter_id)
    except ValueError:
        raise _not_found() from None
    chapter = repo.chapter(parsed, link.workspace_id)
    if chapter is None:
        raise _not_found()
    found = _shareable(repo, chapter)
    if found is None:
        raise _not_found()
    note, stems = found
    current = repo.chapter_questions(chapter.workspace_id, [chapter.id])[chapter.id]
    sections, footnotes = present_body(note.body, note.refs, stems)
    return SharedChapterNote(
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        created_at=note.finished_at or note.created_at,
        question_count=note.question_count,
        stale=note.input_fingerprint != current_fingerprint(repo, chapter, current),
        sections=[
            NoteSection(
                heading=s.heading,
                items=[NoteItem(text=i.text, footnotes=i.footnotes) for i in s.items],
            )
            for s in sections
        ],
        footnotes=[
            NoteFootnote(
                number=f.number,
                question_id=f.question_id,
                label=f.label,
                stem_preview=f.stem_preview,
            )
            for f in footnotes
        ],
    )
