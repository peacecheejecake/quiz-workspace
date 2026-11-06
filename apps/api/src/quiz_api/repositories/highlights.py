"""Personal highlights (UX9-HL-B) over `user_highlights` (20261103140000_user_highlights.sql)
and the note / question rows they point at.

Every highlight query is keyed by the caller's `user_id` (the verified JWT `sub`) and the
workspace the route authorized; rows of other users are never read. Writes of one user on one
target (a note version or a question) are serialised by a transaction-scoped advisory lock, under
which the API checks overlaps and the 500-row limit. The API commits once per request.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, insert, literal, select, text, update
from sqlalchemy.orm import Session

from quiz_api.chapter_notes import Ref, parse_refs
from quiz_api.repositories.question_overview import (
    heatmap_conditions,
    heatmap_order,
    heatmap_source,
)
from quiz_api.repositories.tables import (
    chapter_notes,
    chapters,
    question_revisions,
    questions,
    user_highlights,
)

RESTORE_WINDOW = "10 minutes"


@dataclass(frozen=True)
class HighlightRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    target_kind: str
    chapter_note_id: uuid.UUID | None
    question_id: uuid.UUID | None
    question_revision_id: uuid.UUID | None
    anchor: dict[str, Any]
    quote: str
    prefix: str
    suffix: str
    color: str
    version: int
    replaced_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    # Deleted within the restore window (computed with the database clock).
    recently_deleted: bool
    note_version: int | None

    @property
    def target_id(self) -> uuid.UUID:
        target = self.chapter_note_id if self.target_kind == "note" else self.question_id
        if target is None:  # excluded by user_highlights_target_columns
            raise ValueError(f"highlight {self.id} has no target")
        return target


@dataclass(frozen=True)
class NoteTarget:
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: str
    version: int | None
    body: Any
    refs: list[Ref]


@dataclass(frozen=True)
class QuestionText:
    """A question with its active revision's explanation and stem (never sent as such)."""

    question_id: uuid.UUID
    workspace_id: uuid.UUID
    chapter_id: uuid.UUID | None
    publication_status: str
    question_number: int | None
    revision_id: uuid.UUID | None
    explanation: str | None
    stem: str


@dataclass(frozen=True)
class QuestionGroup:
    """The Heatmap group of a question: its chapter (None = "챕터 없음")."""

    chapter_id: uuid.UUID | None
    chapter_title: str | None


def _row_columns() -> tuple[Any, ...]:
    recent = and_(
        user_highlights.c.deleted_at.is_not(None),
        user_highlights.c.deleted_at > func.now() - text(f"interval '{RESTORE_WINDOW}'"),
    )
    return (
        *user_highlights.c,
        recent.label("recently_deleted"),
        chapter_notes.c.version.label("note_version"),
    )


def _select() -> Any:
    return select(*_row_columns()).select_from(
        user_highlights.outerjoin(
            chapter_notes,
            and_(
                chapter_notes.c.id == user_highlights.c.chapter_note_id,
                chapter_notes.c.workspace_id == user_highlights.c.workspace_id,
            ),
        )
    )


def _row(r: Any) -> HighlightRow:
    return HighlightRow(
        id=r.id,
        workspace_id=r.workspace_id,
        user_id=r.user_id,
        target_kind=r.target_kind,
        chapter_note_id=r.chapter_note_id,
        question_id=r.question_id,
        question_revision_id=r.question_revision_id,
        anchor=dict(r.anchor),
        quote=r.quote,
        prefix=r.prefix,
        suffix=r.suffix,
        color=r.color,
        version=r.version,
        replaced_by=r.replaced_by,
        created_at=r.created_at,
        updated_at=r.updated_at,
        deleted_at=r.deleted_at,
        recently_deleted=bool(r.recently_deleted),
        note_version=r.note_version,
    )


def _question_text_select() -> Any:
    return select(
        questions.c.id,
        questions.c.workspace_id,
        questions.c.chapter_id,
        questions.c.publication_status,
        questions.c.question_number,
        question_revisions.c.id.label("revision_id"),
        question_revisions.c.explanation,
        question_revisions.c.stem,
    )


def _question_text(r: Any) -> QuestionText:
    return QuestionText(
        question_id=r.id,
        workspace_id=r.workspace_id,
        chapter_id=r.chapter_id,
        publication_status=r.publication_status,
        question_number=r.question_number,
        revision_id=r.revision_id,
        explanation=r.explanation,
        stem=r.stem or "",
    )


class HighlightRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- targets --------------------------------------------------------------------------------

    def note(self, note_id: uuid.UUID, workspace_id: uuid.UUID) -> NoteTarget | None:
        r = self._session.execute(
            select(
                chapter_notes.c.id,
                chapter_notes.c.workspace_id,
                chapter_notes.c.status,
                chapter_notes.c.version,
                chapter_notes.c.body,
                chapter_notes.c.question_refs,
            ).where(chapter_notes.c.id == note_id, chapter_notes.c.workspace_id == workspace_id)
        ).one_or_none()
        if r is None:
            return None
        return NoteTarget(
            id=r.id,
            workspace_id=r.workspace_id,
            status=r.status,
            version=r.version,
            body=r.body,
            refs=parse_refs(r.question_refs),
        )

    def questions(
        self, workspace_id: uuid.UUID, question_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, QuestionText]:
        """Live (not soft-deleted) questions with their active revision."""
        ids = list(set(question_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            _question_text_select()
            .select_from(
                questions.outerjoin(
                    question_revisions,
                    and_(
                        question_revisions.c.id == questions.c.active_revision_id,
                        question_revisions.c.question_id == questions.c.id,
                    ),
                )
            )
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.id.in_(ids),
                questions.c.deleted_at.is_(None),
            )
        )
        return {r.id: _question_text(r) for r in rows}

    def group_of(self, workspace_id: uuid.UUID, question_id: uuid.UUID) -> QuestionGroup:
        """The question's Heatmap group (its chapter row exists) or "챕터 없음"."""
        r = self._session.execute(
            select(chapters.c.id, chapters.c.title)
            .select_from(
                questions.join(
                    chapters,
                    and_(
                        chapters.c.id == questions.c.chapter_id,
                        chapters.c.workspace_id == questions.c.workspace_id,
                    ),
                )
            )
            .where(questions.c.workspace_id == workspace_id, questions.c.id == question_id)
        ).one_or_none()
        if r is None:
            return QuestionGroup(None, None)
        return QuestionGroup(r.id, r.title)

    def heatmap_group(
        self, workspace_id: uuid.UUID, chapter_id: uuid.UUID | None
    ) -> list[QuestionText]:
        """The live CONFIRMED questions of one Heatmap group in Heatmap order."""
        group = chapters.c.id.is_(None) if chapter_id is None else chapters.c.id == chapter_id
        rows = self._session.execute(
            _question_text_select()
            .select_from(heatmap_source())
            .where(*heatmap_conditions(workspace_id), group)
            .order_by(*heatmap_order())
        )
        return [_question_text(r) for r in rows]

    # --- highlights -----------------------------------------------------------------------------

    def lock_target(self, user_id: uuid.UUID, target_id: uuid.UUID) -> None:
        """Serialises one user's writes on one target (transaction-scoped)."""
        self._session.execute(
            select(
                func.pg_advisory_xact_lock(
                    func.hashtextextended(f"quiz.user_highlight:{user_id}:{target_id}", 0)
                )
            )
        )

    def own(
        self, highlight_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> HighlightRow | None:
        stmt = _select().where(
            user_highlights.c.id == highlight_id, user_highlights.c.user_id == user_id
        )
        if lock:
            stmt = stmt.with_for_update(of=user_highlights)
        r = self._session.execute(stmt).one_or_none()
        return _row(r) if r is not None else None

    def own_required(self, highlight_id: uuid.UUID, user_id: uuid.UUID) -> HighlightRow:
        """A row this transaction just wrote."""
        row = self.own(highlight_id, user_id)
        if row is None:
            raise LookupError(f"highlight {highlight_id} vanished inside its transaction")
        return row

    def live_on_target(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID, kind: str, target_id: uuid.UUID
    ) -> list[HighlightRow]:
        column = (
            user_highlights.c.chapter_note_id if kind == "note" else user_highlights.c.question_id
        )
        rows = self._session.execute(
            _select().where(
                user_highlights.c.user_id == user_id,
                user_highlights.c.workspace_id == workspace_id,
                user_highlights.c.target_kind == kind,
                column == target_id,
                user_highlights.c.deleted_at.is_(None),
            )
        )
        return [_row(r) for r in rows]

    def live_on_chapter_notes(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID, document_id: uuid.UUID, section_key: str
    ) -> list[HighlightRow]:
        """Live note highlights of every version of a chapter (`(document_id, section_key)`)."""
        rows = self._session.execute(
            _select().where(
                user_highlights.c.user_id == user_id,
                user_highlights.c.workspace_id == workspace_id,
                user_highlights.c.target_kind == "note",
                user_highlights.c.deleted_at.is_(None),
                chapter_notes.c.document_id == document_id,
                chapter_notes.c.section_key == section_key,
                chapter_notes.c.status == "succeeded",
            )
        )
        return [_row(r) for r in rows]

    def live_on_questions(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> list[HighlightRow]:
        if not question_ids:
            return []
        rows = self._session.execute(
            _select().where(
                user_highlights.c.user_id == user_id,
                user_highlights.c.workspace_id == workspace_id,
                user_highlights.c.target_kind == "explanation",
                user_highlights.c.question_id.in_(list(question_ids)),
                user_highlights.c.deleted_at.is_(None),
            )
        )
        return [_row(r) for r in rows]

    def insert(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        kind: str,
        chapter_note_id: uuid.UUID | None,
        question_id: uuid.UUID | None,
        question_revision_id: uuid.UUID | None,
        anchor: dict[str, Any],
        quote: str,
        prefix: str,
        suffix: str,
        color: str,
    ) -> uuid.UUID:
        highlight_id = uuid.uuid4()
        self._session.execute(
            insert(user_highlights).values(
                id=highlight_id,
                workspace_id=workspace_id,
                user_id=user_id,
                target_kind=kind,
                chapter_note_id=chapter_note_id,
                question_id=question_id,
                question_revision_id=question_revision_id,
                anchor=anchor,
                quote=quote,
                prefix=prefix,
                suffix=suffix,
                color=color,
            )
        )
        return highlight_id

    def replace(
        self, highlight_ids: Sequence[uuid.UUID], by: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        if not highlight_ids:
            return
        self._session.execute(
            update(user_highlights)
            .where(
                user_highlights.c.id.in_(list(highlight_ids)),
                user_highlights.c.user_id == user_id,
                user_highlights.c.deleted_at.is_(None),
            )
            .values(deleted_at=func.now(), replaced_by=by)
        )

    def set_color(self, highlight_id: uuid.UUID, color: str) -> None:
        self._session.execute(
            update(user_highlights)
            .where(user_highlights.c.id == highlight_id)
            .values(color=color, version=user_highlights.c.version + literal(1))
        )

    def soft_delete(self, highlight_id: uuid.UUID) -> None:
        self._session.execute(
            update(user_highlights)
            .where(user_highlights.c.id == highlight_id, user_highlights.c.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )

    def restore(self, highlight_id: uuid.UUID) -> None:
        self._session.execute(
            update(user_highlights)
            .where(user_highlights.c.id == highlight_id)
            .values(deleted_at=None, version=user_highlights.c.version + literal(1))
        )
