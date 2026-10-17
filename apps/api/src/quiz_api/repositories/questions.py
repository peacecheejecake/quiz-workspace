"""Question bank reads and writes (M4.2a) over the M4.1 question domain tables.

Writes run in the request session after the route's authorization dependency locked the
workspace/membership rows (`LockMode.SHARE`); edits additionally lock the question row
(`FOR UPDATE`) so the base-revision check, the new revision and the pointer move are atomic.
Every write records an `activity_events` row in the same transaction; the route commits once.

Revisions are append-only (quiz_api has no UPDATE/DELETE on `question_revisions`): an edit
inserts version n+1 and moves `questions.active_revision_id`; attempts keep pointing at the
revision they were graded against.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import (
    ColumnElement,
    and_,
    delete,
    exists,
    func,
    insert,
    literal,
    select,
    tuple_,
    update,
)
from sqlalchemy.orm import Session

from quiz_api.question_rules import PublicationStatus, QuestionContent, QuestionType
from quiz_api.repositories.tables import (
    activity_events,
    chapters,
    documents,
    question_lineage,
    question_revisions,
    question_sources,
    questions,
)

# Sort key for questions without a display number (int4 max): they follow numbered ones.
UNNUMBERED = 2147483647

ActivityEventType = Literal[
    "question.created", "question.updated", "question.status_changed", "question.deleted"
]


@dataclass(frozen=True)
class RevisionRecord:
    id: uuid.UUID
    version: int
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    rubric: str | None
    created_at: datetime


@dataclass(frozen=True)
class RevisionSummaryRecord:
    id: uuid.UUID
    version: int
    created_at: datetime


@dataclass(frozen=True)
class ChapterRecord:
    id: uuid.UUID
    document_id: uuid.UUID
    title: str


@dataclass(frozen=True)
class SourceRecord:
    document_id: uuid.UUID | None
    document_revision_id: uuid.UUID | None
    page_start: int | None
    page_end: int | None


@dataclass(frozen=True)
class QuestionRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    question_type: QuestionType
    publication_status: PublicationStatus
    origin: str
    chapter_id: uuid.UUID | None
    chapter: ChapterRecord | None
    question_number: int | None
    sort_order: int
    created_at: datetime
    updated_at: datetime
    revision: RevisionRecord
    sources: list[SourceRecord]

    def content(self) -> QuestionContent:
        rev = self.revision
        return QuestionContent(
            question_type=self.question_type,
            stem=rev.stem,
            options=tuple((o["id"], o["text"]) for o in rev.options),
            correct_option_ids=tuple(rev.correct_option_ids)
            if rev.correct_option_ids is not None
            else None,
            is_multi_answer=rev.is_multi_answer,
            accepted_answers=tuple(rev.accepted_answers)
            if rev.accepted_answers is not None
            else None,
            explanation=rev.explanation,
            rubric=rev.rubric,
        )


@dataclass(frozen=True)
class LineageRecord:
    """A generated question's parent (M6.2, `question_lineage`)."""

    parent_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID
    variation_type: str
    generation_run_id: uuid.UUID | None


@dataclass(frozen=True)
class SourceInputRecord:
    document_id: uuid.UUID
    page_start: int | None
    page_end: int | None


@dataclass(frozen=True)
class ListCursor:
    """Keyset position: (sort_order, question_number or UNNUMBERED, created_at, id)."""

    sort_order: int
    number: int
    created_at: datetime
    id: uuid.UUID


@dataclass(frozen=True)
class QuestionFilter:
    statuses: Sequence[PublicationStatus]
    question_type: QuestionType | None = None
    chapter_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    text: str | None = None


_REVISION_COLUMNS = (
    question_revisions.c.id.label("rev_id"),
    question_revisions.c.version.label("rev_version"),
    question_revisions.c.stem.label("rev_stem"),
    question_revisions.c.options.label("rev_options"),
    question_revisions.c.correct_option_ids.label("rev_correct_option_ids"),
    question_revisions.c.accepted_answers.label("rev_accepted_answers"),
    question_revisions.c.is_multi_answer.label("rev_is_multi_answer"),
    question_revisions.c.explanation.label("rev_explanation"),
    question_revisions.c.rubric.label("rev_rubric"),
    question_revisions.c.created_at.label("rev_created_at"),
)

_QUESTION_COLUMNS = (
    questions.c.id,
    questions.c.workspace_id,
    questions.c.question_type,
    questions.c.publication_status,
    questions.c.origin,
    questions.c.chapter_id,
    questions.c.question_number,
    questions.c.sort_order,
    questions.c.created_at,
    questions.c.updated_at,
    chapters.c.document_id.label("chapter_document_id"),
    chapters.c.title.label("chapter_title"),
    *_REVISION_COLUMNS,
)

_NUMBER_KEY = func.coalesce(questions.c.question_number, literal(UNNUMBERED))


def _base_select() -> Any:
    return select(*_QUESTION_COLUMNS).select_from(
        questions.join(
            question_revisions,
            and_(
                question_revisions.c.id == questions.c.active_revision_id,
                question_revisions.c.question_id == questions.c.id,
            ),
        ).outerjoin(
            chapters,
            and_(
                chapters.c.id == questions.c.chapter_id,
                chapters.c.workspace_id == questions.c.workspace_id,
            ),
        )
    )


def _revision(row: Any) -> RevisionRecord:
    return RevisionRecord(
        id=row.rev_id,
        version=row.rev_version,
        stem=row.rev_stem,
        options=list(row.rev_options),
        correct_option_ids=list(row.rev_correct_option_ids)
        if row.rev_correct_option_ids is not None
        else None,
        accepted_answers=list(row.rev_accepted_answers)
        if row.rev_accepted_answers is not None
        else None,
        is_multi_answer=row.rev_is_multi_answer,
        explanation=row.rev_explanation,
        rubric=row.rev_rubric,
        created_at=row.rev_created_at,
    )


def _question(row: Any, sources: list[SourceRecord]) -> QuestionRecord:
    chapter = (
        ChapterRecord(row.chapter_id, row.chapter_document_id, row.chapter_title)
        if row.chapter_id is not None and row.chapter_title is not None
        else None
    )
    return QuestionRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        question_type=cast(QuestionType, row.question_type),
        publication_status=cast(PublicationStatus, row.publication_status),
        origin=row.origin,
        chapter_id=row.chapter_id,
        chapter=chapter,
        question_number=row.question_number,
        sort_order=row.sort_order,
        created_at=row.created_at,
        updated_at=row.updated_at,
        revision=_revision(row),
        sources=sources,
    )


def _like_pattern(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class QuestionRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def savepoint(self) -> Any:
        """A SAVEPOINT context: rolled back (with the locks taken inside it) on an exception."""
        return self._session.begin_nested()

    def rollback(self) -> None:
        self._session.rollback()

    # --- reads -----------------------------------------------------------------------------------

    def _sources(self, question_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, list[SourceRecord]]:
        ids = list(question_ids)
        out: dict[uuid.UUID, list[SourceRecord]] = {qid: [] for qid in ids}
        if not ids:
            return out
        rows = self._session.execute(
            select(
                question_sources.c.question_id,
                question_sources.c.document_id,
                question_sources.c.document_revision_id,
                question_sources.c.page_start,
                question_sources.c.page_end,
            )
            .where(question_sources.c.question_id.in_(ids))
            .order_by(question_sources.c.created_at, question_sources.c.id)
        )
        for row in rows:
            out[row.question_id].append(
                SourceRecord(
                    row.document_id, row.document_revision_id, row.page_start, row.page_end
                )
            )
        return out

    def get(self, question_id: uuid.UUID, *, lock: bool = False) -> QuestionRecord | None:
        """A live (not soft-deleted) question with its active revision; `lock` = FOR UPDATE of
        the question row (the edit path)."""
        if lock:
            locked = self._session.execute(
                select(questions.c.id)
                .where(questions.c.id == question_id, questions.c.deleted_at.is_(None))
                .with_for_update()
            ).scalar_one_or_none()
            if locked is None:
                return None
        row = self._session.execute(
            _base_select().where(questions.c.id == question_id, questions.c.deleted_at.is_(None))
        ).one_or_none()
        if row is None:
            return None
        return _question(row, self._sources([question_id])[question_id])

    def list_page(
        self,
        workspace_id: uuid.UUID,
        flt: QuestionFilter,
        *,
        limit: int,
        after: ListCursor | None = None,
    ) -> tuple[list[QuestionRecord], ListCursor | None]:
        """One page in bank order (sort_order, question number, registration order)."""
        conditions: list[ColumnElement[bool]] = [
            questions.c.workspace_id == workspace_id,
            questions.c.deleted_at.is_(None),
            questions.c.publication_status.in_(list(flt.statuses)),
        ]
        if flt.question_type is not None:
            conditions.append(questions.c.question_type == flt.question_type)
        if flt.chapter_id is not None:
            conditions.append(questions.c.chapter_id == flt.chapter_id)
        if flt.document_id is not None:
            conditions.append(
                exists().where(
                    question_sources.c.workspace_id == questions.c.workspace_id,
                    question_sources.c.question_id == questions.c.id,
                    question_sources.c.document_id == flt.document_id,
                )
            )
        if flt.text:
            conditions.append(question_revisions.c.stem.ilike(_like_pattern(flt.text), "\\"))
        key = tuple_(questions.c.sort_order, _NUMBER_KEY, questions.c.created_at, questions.c.id)
        if after is not None:
            conditions.append(
                key
                > tuple_(
                    literal(after.sort_order),
                    literal(after.number),
                    literal(after.created_at),
                    literal(after.id),
                )
            )
        stmt = (
            _base_select()
            .where(*conditions)
            .order_by(questions.c.sort_order, _NUMBER_KEY, questions.c.created_at, questions.c.id)
            .limit(limit + 1)
        )
        rows = list(self._session.execute(stmt))
        more = len(rows) > limit
        rows = rows[:limit]
        sources = self._sources(r.id for r in rows)
        items = [_question(r, sources[r.id]) for r in rows]
        cursor = None
        if more and items:
            last = items[-1]
            cursor = ListCursor(
                last.sort_order,
                last.question_number if last.question_number is not None else UNNUMBERED,
                last.created_at,
                last.id,
            )
        return items, cursor

    def revisions(self, question_id: uuid.UUID) -> list[RevisionSummaryRecord]:
        rows = self._session.execute(
            select(
                question_revisions.c.id,
                question_revisions.c.version,
                question_revisions.c.created_at,
            )
            .where(question_revisions.c.question_id == question_id)
            .order_by(question_revisions.c.version.desc())
        )
        return [RevisionSummaryRecord(r.id, r.version, r.created_at) for r in rows]

    def lineage_of(self, question_id: uuid.UUID) -> LineageRecord | None:
        row = self._session.execute(
            select(
                question_lineage.c.parent_question_id,
                question_lineage.c.source_question_revision_id,
                question_lineage.c.variation_type,
                question_lineage.c.generation_run_id,
            ).where(question_lineage.c.child_question_id == question_id)
        ).one_or_none()
        if row is None:
            return None
        return LineageRecord(
            row.parent_question_id,
            row.source_question_revision_id,
            row.variation_type,
            row.generation_run_id,
        )

    def get_revision(self, question_id: uuid.UUID, revision_id: uuid.UUID) -> RevisionRecord | None:
        row = self._session.execute(
            select(*_REVISION_COLUMNS).where(
                question_revisions.c.question_id == question_id,
                question_revisions.c.id == revision_id,
            )
        ).one_or_none()
        return _revision(row) if row is not None else None

    def chapter_is_current(self, workspace_id: uuid.UUID, chapter_id: uuid.UUID) -> bool:
        """The chapter is an outline node of the active revision of a live document here."""
        found = self._session.execute(
            select(literal(1))
            .select_from(
                chapters.join(
                    documents,
                    and_(
                        documents.c.workspace_id == chapters.c.workspace_id,
                        documents.c.id == chapters.c.document_id,
                    ),
                )
            )
            .where(
                chapters.c.workspace_id == workspace_id,
                chapters.c.id == chapter_id,
                documents.c.deleted_at.is_(None),
                documents.c.active_revision_id == chapters.c.document_revision_id,
            )
        ).first()
        return found is not None

    def lock_documents(
        self,
        workspace_id: uuid.UUID,
        *,
        chapter_ids: Iterable[uuid.UUID | None] = (),
        document_ids: Iterable[uuid.UUID] = (),
    ) -> None:
        """FOR SHARE on the documents of these chapters plus the given (source) documents of this
        workspace, all in one statement in document id order.

        Lock order for question writes: documents first, then the question row. A publish holds
        the document FOR UPDATE and then (remap trigger, 20261018003400) updates the questions of
        its chapters; taking the document before the question means the two never wait on each
        other in opposite orders. Holding it also makes everything read from the document atomic
        with the save: `chapter_is_current` and the active revision a source cites
        (`live_documents`) are read after a publish either committed (and are then the new
        revision) or while it waits until this question is saved (and then remaps it).
        """
        wanted = {c for c in chapter_ids if c is not None}
        ids = set(document_ids)
        if wanted:
            ids.update(
                self._session.execute(
                    select(chapters.c.document_id).where(
                        chapters.c.workspace_id == workspace_id, chapters.c.id.in_(wanted)
                    )
                ).scalars()
            )
        if not ids:
            return
        self._session.execute(
            select(documents.c.id)
            .where(documents.c.workspace_id == workspace_id, documents.c.id.in_(sorted(ids)))
            .order_by(documents.c.id)
            .with_for_update(read=True)
        ).all()

    def chapter_of(self, question_id: uuid.UUID) -> uuid.UUID | None:
        """The question's current chapter (unlocked read, to choose the locks to take first;
        a remap never moves a question to another document's chapter)."""
        found = self._session.execute(
            select(questions.c.chapter_id).where(questions.c.id == question_id)
        ).scalar_one_or_none()
        return cast(uuid.UUID | None, found)

    def live_documents(
        self, workspace_id: uuid.UUID, document_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, uuid.UUID | None]:
        """document id -> active revision id, for the live documents of this workspace."""
        ids = list(set(document_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            select(documents.c.id, documents.c.active_revision_id).where(
                documents.c.workspace_id == workspace_id,
                documents.c.id.in_(ids),
                documents.c.deleted_at.is_(None),
            )
        )
        return {r.id: r.active_revision_id for r in rows}

    # --- writes (caller commits) ----------------------------------------------------------------

    def _insert_revision(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        version: int,
        content: QuestionContent,
        actor_id: uuid.UUID,
    ) -> uuid.UUID:
        revision_id = uuid.uuid4()
        self._session.execute(
            insert(question_revisions).values(
                id=revision_id,
                workspace_id=workspace_id,
                question_id=question_id,
                version=version,
                stem=content.stem,
                options=content.options_json(),
                correct_option_ids=list(content.correct_option_ids)
                if content.correct_option_ids is not None
                else None,
                accepted_answers=list(content.accepted_answers)
                if content.accepted_answers is not None
                else None,
                is_multi_answer=content.is_multi_answer,
                explanation=content.explanation,
                rubric=content.rubric,
                created_by=actor_id,
            )
        )
        return revision_id

    def replace_sources(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        sources: Sequence[SourceInputRecord],
        revisions: dict[uuid.UUID, uuid.UUID | None],
    ) -> None:
        """Sources are question metadata (not revisioned): an edit replaces the rows. Each row
        pins the document's active revision at save time (provenance)."""
        self._session.execute(
            delete(question_sources).where(
                question_sources.c.workspace_id == workspace_id,
                question_sources.c.question_id == question_id,
            )
        )
        if not sources:
            return
        self._session.execute(
            insert(question_sources),
            [
                {
                    "id": uuid.uuid4(),
                    "workspace_id": workspace_id,
                    "question_id": question_id,
                    "document_id": s.document_id,
                    "document_revision_id": revisions.get(s.document_id),
                    "page_start": s.page_start,
                    "page_end": s.page_end,
                }
                for s in sources
            ],
        )

    def create(
        self,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        content: QuestionContent,
        status: PublicationStatus,
        chapter_id: uuid.UUID | None,
        question_number: int | None,
        sources: Sequence[SourceInputRecord],
        source_revisions: dict[uuid.UUID, uuid.UUID | None],
        origin: Literal["manual", "import", "generation"] = "manual",
    ) -> uuid.UUID:
        """Question + revision 1 (+ sources) + `question.created`.

        The question is inserted as DRAFT without content first (the active-revision FK needs
        the revision row, which needs the question row), then pointed at revision 1 and given
        its status, all in this transaction.
        """
        question_id = uuid.uuid4()
        self._session.execute(
            insert(questions).values(
                id=question_id,
                workspace_id=workspace_id,
                chapter_id=chapter_id,
                question_type=content.question_type,
                origin=origin,
                question_number=question_number,
                publication_status="DRAFT",
                created_by=actor_id,
            )
        )
        revision_id = self._insert_revision(workspace_id, question_id, 1, content, actor_id)
        self._session.execute(
            update(questions)
            .where(questions.c.id == question_id)
            .values(active_revision_id=revision_id, publication_status=status)
        )
        self.replace_sources(workspace_id, question_id, sources, source_revisions)
        self.record_activity(
            workspace_id,
            actor_id,
            "question.created",
            question_id,
            {
                "question_type": content.question_type,
                "publication_status": status,
                "version": 1,
                "origin": origin,
            },
        )
        return question_id

    def append_revision(
        self, current: QuestionRecord, content: QuestionContent, actor_id: uuid.UUID
    ) -> int:
        """Insert version n+1 and move the active pointer; returns the new version."""
        version = current.revision.version + 1
        revision_id = self._insert_revision(
            current.workspace_id, current.id, version, content, actor_id
        )
        self._session.execute(
            update(questions)
            .where(questions.c.id == current.id)
            .values(active_revision_id=revision_id)
        )
        return version

    def update_metadata(self, question_id: uuid.UUID, **values: Any) -> None:
        if values:
            self._session.execute(
                update(questions).where(questions.c.id == question_id).values(**values)
            )

    def touch(self, question_id: uuid.UUID) -> None:
        """Bump `updated_at` (trigger) when only child rows changed."""
        self._session.execute(
            update(questions).where(questions.c.id == question_id).values(updated_at=func.now())
        )

    def soft_delete(self, question: QuestionRecord, actor_id: uuid.UUID) -> None:
        self._session.execute(
            update(questions)
            .where(questions.c.id == question.id, questions.c.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )
        self.record_activity(
            question.workspace_id,
            actor_id,
            "question.deleted",
            question.id,
            {"publication_status": question.publication_status},
        )

    def record_activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: ActivityEventType,
        question_id: uuid.UUID,
        metadata: dict[str, Any],
    ) -> None:
        """Audit event. Metadata carries ids, versions, statuses and field names only: never
        question text, answers or explanations."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="question",
                target_id=question_id,
                metadata=metadata,
            )
        )
