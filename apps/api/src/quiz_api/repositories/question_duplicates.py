"""Duplicate questions (UX7-DEDUP, docs/questions.md §10): the content the fingerprint reads and
the merge writes (archive + `question_merges` links) over the M4.1 tables.

Runs in the request session after the route's authorization locked the workspace/membership rows
(`LockMode.SHARE` for writes). The merge locks every named question FOR UPDATE in id order (one
lock order for every merger) before it checks and writes anything.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import and_, func, insert, literal, select, update
from sqlalchemy.orm import Session

from quiz_api.question_fingerprint import answer_key, fingerprint
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.questions import UNNUMBERED
from quiz_api.repositories.tables import (
    activity_events,
    chapters,
    documents,
    question_merges,
    question_revisions,
    questions,
)


@dataclass(frozen=True)
class CandidateRecord:
    """A live question with the content of its active revision (no explanation or rubric)."""

    id: uuid.UUID
    question_type: QuestionType
    question_number: int | None
    publication_status: str
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    created_at: datetime
    revision_id: uuid.UUID
    revision_version: int
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None

    @property
    def fingerprint(self) -> str:
        return fingerprint(self.question_type, self.stem, [o["text"] for o in self.options])

    @property
    def answer_key(self) -> tuple[str, ...] | None:
        return answer_key(
            [(o["id"], o["text"]) for o in self.options],
            self.correct_option_ids,
            self.accepted_answers,
        )


@dataclass(frozen=True)
class LinkRecord:
    id: uuid.UUID
    duplicate_question_id: uuid.UUID
    kept_question_id: uuid.UUID


_COLUMNS = (
    questions.c.id,
    questions.c.question_type,
    questions.c.question_number,
    questions.c.publication_status,
    questions.c.created_at,
    chapters.c.id.label("chapter_id"),
    chapters.c.title.label("chapter_title"),
    question_revisions.c.id.label("revision_id"),
    question_revisions.c.version.label("revision_version"),
    question_revisions.c.stem,
    question_revisions.c.options,
    question_revisions.c.correct_option_ids,
    question_revisions.c.accepted_answers,
)


def _source() -> Any:
    return (
        questions.join(
            question_revisions,
            and_(
                question_revisions.c.id == questions.c.active_revision_id,
                question_revisions.c.question_id == questions.c.id,
            ),
        )
        .outerjoin(
            chapters,
            and_(
                chapters.c.id == questions.c.chapter_id,
                chapters.c.workspace_id == questions.c.workspace_id,
            ),
        )
        .outerjoin(
            documents,
            and_(
                documents.c.id == chapters.c.document_id,
                documents.c.workspace_id == chapters.c.workspace_id,
            ),
        )
    )


def _candidate(row: Any) -> CandidateRecord:
    return CandidateRecord(
        id=row.id,
        question_type=cast(QuestionType, row.question_type),
        question_number=row.question_number,
        publication_status=row.publication_status,
        chapter_id=row.chapter_id,
        chapter_title=row.chapter_title,
        created_at=row.created_at,
        revision_id=row.revision_id,
        revision_version=row.revision_version,
        stem=row.stem,
        options=[{"id": o["id"], "text": o["text"]} for o in row.options],
        correct_option_ids=list(row.correct_option_ids)
        if row.correct_option_ids is not None
        else None,
        accepted_answers=list(row.accepted_answers) if row.accepted_answers is not None else None,
    )


class QuestionDuplicateRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    def confirmed(self, workspace_id: uuid.UUID) -> list[CandidateRecord]:
        """The workspace's live CONFIRMED questions in heatmap order (question_overview)."""
        stmt = (
            select(*_COLUMNS)
            .select_from(_source())
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.publication_status == "CONFIRMED",
                questions.c.deleted_at.is_(None),
            )
            .order_by(
                chapters.c.id.is_(None),
                documents.c.created_at,
                documents.c.id,
                chapters.c.sort_order,
                chapters.c.id,
                questions.c.sort_order,
                func.coalesce(questions.c.question_number, literal(UNNUMBERED)),
                questions.c.created_at,
                questions.c.id,
            )
        )
        return [_candidate(r) for r in self._session.execute(stmt)]

    def lock(self, workspace_id: uuid.UUID, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Any]:
        """The live questions of the workspace among `ids`, locked FOR UPDATE in id order."""
        wanted = sorted(set(ids))
        if not wanted:
            return {}
        locked = self._session.execute(
            select(questions.c.id)
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.id.in_(wanted),
                questions.c.deleted_at.is_(None),
            )
            .order_by(questions.c.id)
            .with_for_update(of=questions)
        ).scalars()
        found = list(locked)
        if not found:
            return {}
        rows = self._session.execute(
            select(*_COLUMNS).select_from(_source()).where(questions.c.id.in_(found))
        )
        return {r.id: _candidate(r) for r in rows}

    def active_links(
        self,
        workspace_id: uuid.UUID,
        *,
        duplicates: Iterable[uuid.UUID] = (),
        kept: Iterable[uuid.UUID] = (),
    ) -> list[LinkRecord]:
        """Active links whose duplicate is in `duplicates` or whose kept question is in `kept`."""
        dup_ids, kept_ids = list(set(duplicates)), list(set(kept))
        if not dup_ids and not kept_ids:
            return []
        m = question_merges
        rows = self._session.execute(
            select(m.c.id, m.c.duplicate_question_id, m.c.kept_question_id)
            .where(
                m.c.workspace_id == workspace_id,
                m.c.ended_at.is_(None),
                m.c.duplicate_question_id.in_(dup_ids) | m.c.kept_question_id.in_(kept_ids),
            )
            .order_by(m.c.duplicate_question_id)
            .with_for_update()
        )
        return [LinkRecord(r.id, r.duplicate_question_id, r.kept_question_id) for r in rows]

    def end_links(self, link_ids: Iterable[uuid.UUID], actor_id: uuid.UUID, reason: str) -> None:
        ids = list(link_ids)
        if ids:
            self._session.execute(
                update(question_merges)
                .where(question_merges.c.id.in_(ids), question_merges.c.ended_at.is_(None))
                .values(ended_at=func.now(), ended_by=actor_id, end_reason=reason)
            )

    def link(
        self,
        workspace_id: uuid.UUID,
        duplicate_id: uuid.UUID,
        kept_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> None:
        self._session.execute(
            insert(question_merges).values(
                workspace_id=workspace_id,
                duplicate_question_id=duplicate_id,
                kept_question_id=kept_id,
                created_by=actor_id,
            )
        )

    def archive(self, question_id: uuid.UUID) -> None:
        self._session.execute(
            update(questions)
            .where(questions.c.id == question_id)
            .values(publication_status="ARCHIVED")
        )

    def record_activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: str,
        question_id: uuid.UUID,
        metadata: dict[str, Any],
    ) -> None:
        """Audit event: ids, versions and statuses only, never question text."""
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
