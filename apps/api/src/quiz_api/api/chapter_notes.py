"""Chapter notes API (CHNOTE-B, CHNOTE-01; docs/questions.md §9, architecture.md §6).

    GET  /workspaces/{id}/chapter-notes      any member (archived included): per Heatmap chapter
                                             the newest version, stale, generating
    GET  /chapters/{chapterId}/note          any member: the chapter's note state (`version=k`
                                             for an older version)
    POST /chapters/{chapterId}/note          owner/editor, active workspace: a new version
                                             (`chapter_note.generate`); `Idempotency-Key`

`chapterId` is the questions' `chapter_id` (an outline node of a live document's active revision);
unknown, foreign and deleted chapters answer one 404. A note belongs to `(document_id,
section_key)`, so it follows its chapter across corrected revisions.

The input of a generation is pinned at request time: the chapter's live CONFIRMED questions in
Heatmap order (`question_refs`: tag Q1..Qn, question and revision ids, "<n>장 <번호>번") and the
fingerprint of those revisions plus the chapter's text (`input_fingerprint`). `stale` compares the
shown note's fingerprint with the chapter's current one on every read (questions added, edited,
deleted, archived or moved; the chapter text corrected). Every generation is a new version;
older versions are kept and readable.

Problems: 409 `note-generation-disabled` (WORKER_CHAPTER_NOTES off; stored notes stay readable),
409 `note-generation-running` (a queued/running generation of the chapter exists; the same
Idempotency-Key replays the first response), 409 `no-chapter-questions`.

Notes are visible to every member at once (`AI 생성`, read-only). They are never part of the
practice API (answers and explanations before submission). Responses carry no prompt, LLM output
or provider message; job results hold counts and codes only.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.question_imports import _publish_job
from quiz_api.api.question_overview import chapter_number
from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    ResourceAccess,
    ResourceType,
    WorkspaceAccess,
    authorize_resource,
    authorize_workspace,
    get_access_repository,
)
from quiz_api.chapter_notes import input_fingerprint, present_body, question_label
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.jobs import JobPublisher
from quiz_api.repositories.chapter_notes import (
    ChapterNoteRepository,
    ChapterQuestion,
    ChapterRecord,
    NoteRow,
)
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.jobs import error_code
from quiz_api.repositories.question_imports import QuestionImportRepository
from quiz_api.settings import Settings

router = APIRouter(tags=["chapter-notes"], responses=problem_responses(503))

NOT_FOUND = "Not found."
GenerationStatus = Literal["queued", "running", "succeeded", "failed"]
TERMINAL_JOB = frozenset({"succeeded", "failed", "cancelled"})


# --- schemas ------------------------------------------------------------------------------------


class NoteProgress(BaseModel):
    batches_done: int
    batches_total: int


class NoteGeneration(BaseModel):
    id: uuid.UUID
    status: GenerationStatus
    job_id: uuid.UUID | None = Field(description="Job `chapter_note.generate`.")
    error_code: str | None = Field(
        description="Why it failed (stable code): `llm_unavailable`, `llm_timeout`, "
        "`note_citation_invalid`, `llm_invalid_output`, ..."
    )
    progress: NoteProgress | None = Field(description="Batches of a large chapter while running.")


class NoteQuestionRef(BaseModel):
    tag: str = Field(description="Input tag (`Q1`..`Qn`).")
    question_id: uuid.UUID
    question_revision_id: uuid.UUID = Field(description="The revision the note was made from.")
    label: str = Field(description="`<n>장 <번호>번` (the Heatmap's numbering).")


class NoteItem(BaseModel):
    text: str
    footnotes: list[int] = Field(description="Footnote numbers (at least one).")


class NoteSection(BaseModel):
    heading: str
    items: list[NoteItem]


class NoteFootnote(BaseModel):
    number: int
    question_id: uuid.UUID | None = Field(
        description="null: no longer a CONFIRMED question of the chapter (deleted or moved)."
    )
    label: str
    stem_preview: str | None = Field(description="First 40 characters of the current stem.")


class NoteUsage(BaseModel):
    llm_calls: int = 0
    batches: int = 0
    items: int = 0
    dropped_items: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


class ChapterNote(BaseModel):
    id: uuid.UUID
    version: int
    created_at: datetime
    question_count: int
    input_fingerprint: str
    question_refs: list[NoteQuestionRef]
    sections: list[NoteSection]
    footnotes: list[NoteFootnote]
    usage: NoteUsage | None = Field(description="null for a copied (forked) note.")


class NoteVersion(BaseModel):
    version: int
    note_id: uuid.UUID
    created_at: datetime
    question_count: int


class ChapterNoteState(BaseModel):
    chapter_id: uuid.UUID
    chapter_title: str
    available: bool = Field(description="This environment can create notes.")
    confirmed_question_count: int
    generation: NoteGeneration | None = Field(description="The chapter's newest generation.")
    note: ChapterNote | None = Field(description="The newest version, or `version=k`.")
    versions: list[NoteVersion] = Field(description="Newest first.")
    stale: bool = Field(description="The chapter's confirmed questions changed since the note.")


class ChapterNoteSummary(BaseModel):
    chapter_id: uuid.UUID
    chapter_title: str
    latest_version: int | None
    stale: bool
    generating: bool


class ChapterNoteList(BaseModel):
    available: bool
    items: list[ChapterNoteSummary]


# --- dependencies -------------------------------------------------------------------------------


def get_chapter_note_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ChapterNoteRepository:
    return ChapterNoteRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


def get_import_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionImportRepository:
    return QuestionImportRepository(session)


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


NoteRepo = Annotated[ChapterNoteRepository, Depends(get_chapter_note_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
JobRepo = Annotated[QuestionImportRepository, Depends(get_import_repository)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def _uniform(call: Callable[[], ResourceAccess]) -> ResourceAccess:
    try:
        return call()
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None
        raise


def _chapter(action: Action) -> Any:
    def dependency(
        chapter_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return _uniform(
            lambda: authorize_resource(repo, user.id, ResourceType.CHAPTER, chapter_id, action)
        )

    return Depends(dependency)


def _read_workspace(
    workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> WorkspaceAccess:
    return authorize_workspace(repo, user.id, workspace_id, Action.READ, not_found_detail=NOT_FOUND)


ReadChapter = Annotated[ResourceAccess, _chapter(Action.READ)]
EditChapter = Annotated[ResourceAccess, _chapter(Action.QUESTION_EDIT)]
ReadWorkspace = Annotated[WorkspaceAccess, Depends(_read_workspace)]


# --- helpers ------------------------------------------------------------------------------------


def _load_chapter(repo: ChapterNoteRepository, access: ResourceAccess) -> ChapterRecord:
    chapter = repo.chapter(access.resource_id, access.workspace.workspace_id)
    if chapter is None:  # the document was deleted or re-published after the lookup
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return chapter


def _number(repo: ChapterNoteRepository, chapter: ChapterRecord) -> int | None:
    return chapter_number(repo.chapter_numbers([chapter.id]).get(chapter.id, []))


def current_fingerprint(
    repo: ChapterNoteRepository, chapter: ChapterRecord, current: list[ChapterQuestion]
) -> str:
    body_hash = repo.body_hash(chapter.revision_id, chapter.section_key)
    return input_fingerprint(((q.question_id, q.revision_id) for q in current), body_hash)


def generation_out(row: NoteRow) -> NoteGeneration:
    status_value: str = row.status
    code = row.error_code
    if row.status in {"queued", "running"} and row.job_status in {"failed", "cancelled"}:
        # The job ended without the worker settling the row (e.g. lost): show it as failed.
        status_value = "failed"
        code = error_code(row.job_status, row.job_error)
    if status_value == "failed" and not code:
        code = "job_failed"
    progress = (
        NoteProgress(batches_done=row.batches_done or 0, batches_total=row.batches_total)
        if status_value == "running" and row.batches_total
        else None
    )
    return NoteGeneration(
        id=row.id,
        status=status_value,  # type: ignore[arg-type]
        job_id=row.job_id,
        error_code=code if status_value == "failed" else None,
        progress=progress,
    )


def _usage(raw: dict[str, Any] | None) -> NoteUsage | None:
    if not raw:
        return None
    fields = NoteUsage.model_fields
    return NoteUsage.model_validate({k: v for k, v in raw.items() if k in fields})


def note_out(row: NoteRow, linkable: dict[uuid.UUID, str]) -> ChapterNote:
    sections, footnotes = present_body(row.body, row.refs, linkable)
    return ChapterNote(
        id=row.id,
        version=row.version or 0,
        created_at=row.finished_at or row.created_at,
        question_count=row.question_count,
        input_fingerprint=row.input_fingerprint,
        question_refs=[
            NoteQuestionRef(
                tag=r.tag,
                question_id=r.question_id,
                question_revision_id=r.question_revision_id,
                label=r.label,
            )
            for r in row.refs
        ],
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
        usage=_usage(row.usage),
    )


def note_state(
    repo: ChapterNoteRepository,
    chapter: ChapterRecord,
    settings: Settings,
    version: int | None = None,
) -> ChapterNoteState:
    current = repo.chapter_questions(chapter.workspace_id, [chapter.id])[chapter.id]
    note = repo.note(chapter, version)
    if version is not None and note is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    latest = repo.latest_generation(chapter)
    linkable = {q.question_id: q.stem for q in current}
    stale = False
    if note is not None:
        stale = note.input_fingerprint != current_fingerprint(repo, chapter, current)
    return ChapterNoteState(
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        available=settings.chapter_notes_available,
        confirmed_question_count=len(current),
        generation=generation_out(latest) if latest is not None else None,
        note=note_out(note, linkable) if note is not None else None,
        versions=[
            NoteVersion(
                version=v.version or 0,
                note_id=v.id,
                created_at=v.finished_at or v.created_at,
                question_count=v.question_count,
            )
            for v in repo.versions(chapter)
        ],
        stale=stale,
    )


# --- routes -------------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/chapter-notes", operation_id="listChapterNotes")
def list_chapter_notes(
    access: ReadWorkspace, repo: NoteRepo, settings: SettingsDep
) -> ChapterNoteList:
    """Per Heatmap chapter (a chapter with a CONFIRMED question or a note), in outline order:
    the newest version, whether it is stale and whether a generation is queued/running."""
    chapters = repo.workspace_chapters(access.workspace_id)
    rows = repo.workspace_notes(access.workspace_id)
    latest: dict[tuple[uuid.UUID, str], NoteRow] = {}
    newest: dict[tuple[uuid.UUID, str], NoteRow] = {}
    for row in rows:  # newest first
        key = (row.document_id, row.section_key)
        latest.setdefault(key, row)
        if row.status == "succeeded" and (
            key not in newest or (row.version or 0) > (newest[key].version or 0)
        ):
            newest[key] = row
    current = repo.chapter_questions(access.workspace_id, [c.id for c in chapters])
    items: list[ChapterNoteSummary] = []
    for chapter in chapters:
        key = (chapter.document_id, chapter.section_key)
        note = newest.get(key)
        generation = latest.get(key)
        stale = note is not None and note.input_fingerprint != current_fingerprint(
            repo, chapter, current[chapter.id]
        )
        generating = generation is not None and generation_out(generation).status in {
            "queued",
            "running",
        }
        items.append(
            ChapterNoteSummary(
                chapter_id=chapter.id,
                chapter_title=chapter.title,
                latest_version=note.version if note is not None else None,
                stale=stale,
                generating=generating,
            )
        )
    return ChapterNoteList(available=settings.chapter_notes_available, items=items)


@router.get("/chapters/{chapter_id}/note", operation_id="getChapterNote")
def get_chapter_note(
    access: ReadChapter,
    repo: NoteRepo,
    settings: SettingsDep,
    version: Annotated[int | None, Query(ge=1, le=1_000_000, description="An older version.")] = (
        None
    ),
) -> ChapterNoteState:
    """The chapter's note (newest version or `version=k`), its versions, newest generation and
    whether it is stale. Read-only: never records a view."""
    return note_state(repo, _load_chapter(repo, access), settings, version)


@router.post(
    "/chapters/{chapter_id}/note",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ChapterNoteState,
    operation_id="createChapterNote",
    responses=problem_responses(409),
)
def create_chapter_note(
    access: EditChapter,
    repo: NoteRepo,
    jobs: JobRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    settings: SettingsDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Make (or remake) the chapter's note from its CONFIRMED questions and explanations: a new
    version; the previous ones are kept. The questions and explanations are sent to the LLM
    provider."""
    user_id = access.workspace.user_id
    chapter = _load_chapter(repo, access)
    scope = f"POST /chapters/{chapter.id}/note"
    body_hash = request_hash({})
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            repo.rollback()
            return response
    if not settings.chapter_notes_available:
        raise ProblemException(
            409,
            ProblemType.NOTE_GENERATION_DISABLED,
            detail="Chapter notes are not available in this environment.",
        )
    repo.lock_chapter(chapter)
    active = repo.active_generation(chapter)
    if active is not None:
        if active.job_id is None or active.job_status in TERMINAL_JOB:
            # Its job ended without settling the row: release the chapter.
            repo.settle(
                active.id,
                error_code(active.job_status or "failed", active.job_error) or "job_failed",
            )
        else:
            raise ProblemException(
                409,
                ProblemType.NOTE_GENERATION_RUNNING,
                detail="This chapter's note is already being generated.",
            )
    current = repo.chapter_questions(chapter.workspace_id, [chapter.id])[chapter.id]
    if not current:
        raise ProblemException(
            409,
            ProblemType.NO_CHAPTER_QUESTIONS,
            detail="The chapter has no confirmed questions.",
        )
    number = _number(repo, chapter)
    refs = [
        {
            "tag": f"Q{position}",
            "question_id": str(q.question_id),
            "question_revision_id": str(q.revision_id),
            "label": question_label(number, chapter.title, q.question_number, position),
        }
        for position, q in enumerate(current, start=1)
    ]
    body_text_hash = repo.body_hash(chapter.revision_id, chapter.section_key)
    repo.create(
        chapter=chapter,
        actor_id=user_id,
        refs=refs,
        body_hash=body_text_hash,
        fingerprint=input_fingerprint(
            ((q.question_id, q.revision_id) for q in current), body_text_hash
        ),
    )
    result = note_state(repo, chapter, settings)
    if idempotency_key is not None:
        idempotency.save(
            user_id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_202_ACCEPTED,
            result.model_dump(mode="json"),
        )
    repo.commit()
    _publish_job(jobs, publisher, result.generation.job_id if result.generation else None)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)
