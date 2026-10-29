"""Chapter notes (CHNOTE-B) over `chapter_notes` (20261029130000_chapter_notes.sql) and the
chapter / question tables they are computed from.

A chapter here is an outline node of a live document's *active* revision (`chapters.id` is the
questions' `chapter_id`, the Heatmap group); its notes are the rows with the same
`(document_id, section_key)`, so they survive corrected revisions. The API creates queued rows and
their `chapter_note.generate` jobs; the worker moves them. Routes commit once.

Job idempotency: the job of a row has the key `chapter_note:<note id>:1`.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, insert, literal, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.chapter_notes import Ref, parse_refs
from quiz_api.repositories.question_overview import QuestionOverviewRepository
from quiz_api.repositories.questions import UNNUMBERED
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    chapter_notes,
    chapters,
    documents,
    question_revisions,
    questions,
)

NOTE_JOB_TYPE = "chapter_note.generate"
NOTE_JOB_SCHEMA_VERSION = 1
ACTIVE_STATUSES = ("queued", "running")


def note_job_key(note_id: uuid.UUID) -> str:
    return f"chapter_note:{note_id}:1"


@dataclass(frozen=True)
class ChapterRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID
    section_key: str
    title: str
    sort_order: int


@dataclass(frozen=True)
class ChapterQuestion:
    """A live CONFIRMED question of the chapter (Heatmap order) and its active revision."""

    question_id: uuid.UUID
    revision_id: uuid.UUID
    question_number: int | None
    stem: str


@dataclass(frozen=True)
class NoteRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_id: uuid.UUID
    section_key: str
    version: int | None
    status: str
    job_id: uuid.UUID | None
    job_status: str | None
    job_error: str | None
    input_fingerprint: str
    refs: list[Ref]
    body: Any
    usage: dict[str, Any] | None
    error_code: str | None
    batches_total: int | None
    batches_done: int | None
    created_at: datetime
    finished_at: datetime | None
    superseded_at: datetime | None

    @property
    def question_count(self) -> int:
        return len(self.refs)


@dataclass(frozen=True)
class LiveQuestion:
    """Current state of a question a note cites."""

    question_id: uuid.UUID
    chapter_id: uuid.UUID | None
    publication_status: str
    active_revision_id: uuid.UUID | None
    deleted: bool
    stem: str | None


_NOTE_COLUMNS = (
    chapter_notes.c.id,
    chapter_notes.c.workspace_id,
    chapter_notes.c.document_id,
    chapter_notes.c.section_key,
    chapter_notes.c.version,
    chapter_notes.c.status,
    chapter_notes.c.job_id,
    chapter_notes.c.input_fingerprint,
    chapter_notes.c.question_refs,
    chapter_notes.c.usage,
    chapter_notes.c.error_code,
    chapter_notes.c.batches_total,
    chapter_notes.c.batches_done,
    chapter_notes.c.created_at,
    chapter_notes.c.finished_at,
    chapter_notes.c.superseded_at,
    async_jobs.c.status.label("job_status"),
    async_jobs.c.last_error.label("job_error"),
)


def _note(row: Any, *, body: bool) -> NoteRow:
    return NoteRow(
        id=row.id,
        workspace_id=row.workspace_id,
        document_id=row.document_id,
        section_key=row.section_key,
        version=row.version,
        status=row.status,
        job_id=row.job_id,
        job_status=row.job_status,
        job_error=row.job_error,
        input_fingerprint=row.input_fingerprint,
        refs=parse_refs(row.question_refs),
        body=row.body if body else None,
        usage=dict(row.usage) if isinstance(row.usage, dict) else None,
        error_code=row.error_code,
        batches_total=row.batches_total,
        batches_done=row.batches_done,
        created_at=row.created_at,
        finished_at=row.finished_at,
        superseded_at=row.superseded_at,
    )


def _notes_select(*, body: bool) -> Any:
    columns = (*_NOTE_COLUMNS, chapter_notes.c.body) if body else _NOTE_COLUMNS
    return select(*columns).select_from(
        chapter_notes.outerjoin(
            async_jobs,
            and_(
                async_jobs.c.id == chapter_notes.c.job_id,
                async_jobs.c.workspace_id == chapter_notes.c.workspace_id,
            ),
        )
    )


def _chapter_select() -> Any:
    return select(
        chapters.c.id,
        chapters.c.workspace_id,
        chapters.c.document_id,
        chapters.c.document_revision_id,
        chapters.c.section_key,
        chapters.c.title,
        chapters.c.sort_order,
    ).join(
        documents,
        and_(
            documents.c.id == chapters.c.document_id,
            documents.c.workspace_id == chapters.c.workspace_id,
            documents.c.active_revision_id == chapters.c.document_revision_id,
            documents.c.deleted_at.is_(None),
        ),
    )


def _chapter(row: Any) -> ChapterRecord:
    return ChapterRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        document_id=row.document_id,
        revision_id=row.document_revision_id,
        section_key=row.section_key,
        title=row.title,
        sort_order=int(row.sort_order),
    )


class ChapterNoteRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- chapters and their questions -----------------------------------------------------------

    def chapter(self, chapter_id: uuid.UUID, workspace_id: uuid.UUID) -> ChapterRecord | None:
        """A chapter of a live document's active revision in `workspace_id`."""
        row = self._session.execute(
            _chapter_select().where(
                chapters.c.id == chapter_id, chapters.c.workspace_id == workspace_id
            )
        ).one_or_none()
        return _chapter(row) if row is not None else None

    def chapter_numbers(self, chapter_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
        """chapter id -> outline path titles (top-level first), for `<n>장` labels."""
        return QuestionOverviewRepository(self._session).chapter_lineage(chapter_ids)

    def chapter_questions(
        self, workspace_id: uuid.UUID, chapter_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, list[ChapterQuestion]]:
        """chapter id -> its live CONFIRMED questions in Heatmap (bank) order."""
        if not chapter_ids:
            return {}
        rows = self._session.execute(
            select(
                questions.c.chapter_id,
                questions.c.id,
                questions.c.question_number,
                question_revisions.c.id.label("revision_id"),
                question_revisions.c.stem,
            )
            .join(
                question_revisions,
                and_(
                    question_revisions.c.id == questions.c.active_revision_id,
                    question_revisions.c.question_id == questions.c.id,
                ),
            )
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.chapter_id.in_(list(chapter_ids)),
                questions.c.publication_status == "CONFIRMED",
                questions.c.deleted_at.is_(None),
            )
            .order_by(
                questions.c.chapter_id,
                questions.c.sort_order,
                func.coalesce(questions.c.question_number, literal(UNNUMBERED)),
                questions.c.created_at,
                questions.c.id,
            )
        )
        out: dict[uuid.UUID, list[ChapterQuestion]] = {c: [] for c in chapter_ids}
        for r in rows:
            out[r.chapter_id].append(
                ChapterQuestion(
                    question_id=r.id,
                    revision_id=r.revision_id,
                    question_number=r.question_number,
                    stem=r.stem,
                )
            )
        return out

    def workspace_chapters(self, workspace_id: uuid.UUID) -> list[ChapterRecord]:
        """Chapters of the Heatmap (with a CONFIRMED question) or with a note, in outline order
        (document registration order, then outline pre-order)."""
        has_question = (
            select(questions.c.id)
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.chapter_id == chapters.c.id,
                questions.c.publication_status == "CONFIRMED",
                questions.c.deleted_at.is_(None),
            )
            .exists()
        )
        has_note = (
            select(chapter_notes.c.id)
            .where(
                chapter_notes.c.workspace_id == workspace_id,
                chapter_notes.c.document_id == chapters.c.document_id,
                chapter_notes.c.section_key == chapters.c.section_key,
            )
            .exists()
        )
        rows = self._session.execute(
            _chapter_select()
            .where(chapters.c.workspace_id == workspace_id, has_question | has_note)
            .order_by(documents.c.created_at, documents.c.id, chapters.c.sort_order, chapters.c.id)
        )
        return [_chapter(r) for r in rows]

    def body_hash(self, revision_id: uuid.UUID, section_key: str) -> str:
        value = self._session.execute(
            text("select public.chapter_note_body_hash(:r, :s)"),
            {"r": revision_id, "s": section_key},
        ).scalar_one()
        return str(value)

    def live_questions(
        self, workspace_id: uuid.UUID, question_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, LiveQuestion]:
        ids = list(set(question_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            select(
                questions.c.id,
                questions.c.chapter_id,
                questions.c.publication_status,
                questions.c.active_revision_id,
                questions.c.deleted_at,
                question_revisions.c.stem,
            )
            .outerjoin(
                question_revisions,
                and_(
                    question_revisions.c.id == questions.c.active_revision_id,
                    question_revisions.c.question_id == questions.c.id,
                ),
            )
            .where(questions.c.workspace_id == workspace_id, questions.c.id.in_(ids))
        )
        return {
            r.id: LiveQuestion(
                question_id=r.id,
                chapter_id=r.chapter_id,
                publication_status=r.publication_status,
                active_revision_id=r.active_revision_id,
                deleted=r.deleted_at is not None,
                stem=r.stem,
            )
            for r in rows
        }

    # --- notes ----------------------------------------------------------------------------------

    def _chapter_rows(self, chapter: ChapterRecord) -> Any:
        return and_(
            chapter_notes.c.workspace_id == chapter.workspace_id,
            chapter_notes.c.document_id == chapter.document_id,
            chapter_notes.c.section_key == chapter.section_key,
        )

    def latest_generation(self, chapter: ChapterRecord) -> NoteRow | None:
        row = self._session.execute(
            _notes_select(body=False)
            .where(self._chapter_rows(chapter))
            .order_by(chapter_notes.c.created_at.desc(), chapter_notes.c.id.desc())
            .limit(1)
        ).one_or_none()
        return _note(row, body=False) if row is not None else None

    def versions(self, chapter: ChapterRecord) -> list[NoteRow]:
        """Succeeded rows, newest version first (no bodies)."""
        rows = self._session.execute(
            _notes_select(body=False)
            .where(self._chapter_rows(chapter), chapter_notes.c.status == "succeeded")
            .order_by(chapter_notes.c.version.desc())
        )
        return [_note(r, body=False) for r in rows]

    def note(self, chapter: ChapterRecord, version: int | None) -> NoteRow | None:
        """Version `version`, or the newest succeeded version, with its body."""
        stmt = _notes_select(body=True).where(
            self._chapter_rows(chapter), chapter_notes.c.status == "succeeded"
        )
        if version is not None:
            stmt = stmt.where(chapter_notes.c.version == version)
        row = self._session.execute(
            stmt.order_by(chapter_notes.c.version.desc()).limit(1)
        ).one_or_none()
        return _note(row, body=True) if row is not None else None

    def workspace_notes(self, workspace_id: uuid.UUID) -> list[NoteRow]:
        """Every row of the workspace without bodies (for the per-chapter list)."""
        rows = self._session.execute(
            _notes_select(body=False)
            .where(chapter_notes.c.workspace_id == workspace_id)
            .order_by(chapter_notes.c.created_at.desc(), chapter_notes.c.id.desc())
        )
        return [_note(r, body=False) for r in rows]

    def lock_chapter(self, chapter: ChapterRecord) -> None:
        """Serialises note requests of one chapter (transaction-scoped)."""
        self._session.execute(
            select(
                func.pg_advisory_xact_lock(
                    func.hashtextextended(
                        f"quiz.chapter_note:{chapter.document_id}:{chapter.section_key}", 0
                    )
                )
            )
        )

    def active_generation(self, chapter: ChapterRecord) -> NoteRow | None:
        row = self._session.execute(
            _notes_select(body=False).where(
                self._chapter_rows(chapter), chapter_notes.c.status.in_(ACTIVE_STATUSES)
            )
        ).one_or_none()
        return _note(row, body=False) if row is not None else None

    def settle(self, note_id: uuid.UUID, error_code: str) -> None:
        """Marks a queued/running row whose job already ended as failed."""
        self._session.execute(
            update(chapter_notes)
            .where(chapter_notes.c.id == note_id, chapter_notes.c.status.in_(ACTIVE_STATUSES))
            .values(status="failed", error_code=error_code, finished_at=func.now())
        )

    def create(
        self,
        *,
        chapter: ChapterRecord,
        actor_id: uuid.UUID,
        refs: list[dict[str, str]],
        body_hash: str,
        fingerprint: str,
    ) -> uuid.UUID:
        """The queued row (pinned input) + its job + activity (ids and counts only)."""
        note_id = uuid.uuid4()
        key = note_job_key(note_id)
        self._session.execute(
            pg_insert(async_jobs)
            .values(
                id=uuid.uuid4(),
                workspace_id=chapter.workspace_id,
                created_by=actor_id,
                job_type=NOTE_JOB_TYPE,
                schema_version=NOTE_JOB_SCHEMA_VERSION,
                idempotency_key=key,
                payload={"note_id": str(note_id)},
            )
            .on_conflict_do_nothing()
        )
        job_id: uuid.UUID = self._session.execute(
            select(async_jobs.c.id).where(
                async_jobs.c.workspace_id == chapter.workspace_id,
                async_jobs.c.created_by == actor_id,
                async_jobs.c.job_type == NOTE_JOB_TYPE,
                async_jobs.c.idempotency_key == key,
            )
        ).scalar_one()
        self._session.execute(
            insert(chapter_notes).values(
                id=note_id,
                workspace_id=chapter.workspace_id,
                document_id=chapter.document_id,
                document_revision_id=chapter.revision_id,
                section_key=chapter.section_key,
                status="queued",
                job_id=job_id,
                input_fingerprint=fingerprint,
                body_hash=body_hash,
                question_refs=refs,
                created_by=actor_id,
            )
        )
        self._session.execute(
            insert(activity_events).values(
                workspace_id=chapter.workspace_id,
                actor_id=actor_id,
                event_type="chapter_note.requested",
                target_type="chapter_note",
                target_id=note_id,
                metadata={
                    "document_id": str(chapter.document_id),
                    "chapter_id": str(chapter.id),
                    "question_count": len(refs),
                },
            )
        )
        return note_id
