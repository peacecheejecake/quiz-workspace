"""Questions overview read model (M5.1, QOV-01): the caller's study state for every CONFIRMED,
live question of a workspace, in heatmap order. Read-only: nothing here ever writes a view.

One statement (`overview_statement`) returns every row of the requested scope with the caller's
study state and the "pending grading" flag of the caller's latest submitted practice session
(correlated lookup on `practice_sessions_user_question_idx`). Both include the question's merged
duplicates (UX7-DEDUP, docs/questions.md §10.2): a lateral fold of the caller's
`question_user_states` rows of the question and of its actively merged duplicates (the same fold
as the `question_merged_user_states` view, looked up per question on the state primary key
`(user_id, question_id)` so it stays index-bounded by the caller), and the pending flag looks at
the sessions of the same questions. Index use: the questions side is served by the partial
`questions_overview_idx (workspace_id, publication_status, chapter_id, sort_order, created_at,
id) where deleted_at is null`; tests/integration/questions/test_overview_api.py checks the plan.

Heatmap order (docs/questions.md §3.1): chapter groups first in outline order (the chapter's
document by registration order, then `chapters.sort_order`, which is the outline's pre-order
index inside a document revision), the "no chapter" group last; inside a group the bank order
(`questions.sort_order`, question number with unnumbered last, registration order, id). Filters
only remove rows, so a question keeps its relative position whatever the filter.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import ColumnElement, Select, and_, any_, false, func, literal, select, true
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.orm import Session

from quiz_api.question_rules import QuestionType
from quiz_api.question_status import LastGradedResult
from quiz_api.repositories.practice_epoch import current_session
from quiz_api.repositories.questions import UNNUMBERED
from quiz_api.repositories.tables import (
    chapters,
    documents,
    practice_sessions,
    question_attempts,
    question_merges,
    question_revisions,
    question_user_states,
    questions,
)

# Characters of the stem fetched for the preview (the preview itself is shorter).
STEM_HEAD = 1000


@dataclass(frozen=True)
class OverviewFilter:
    """Scope filters (they also scope the counts). `chapter_id` with `no_chapter=False` keeps one
    chapter; `no_chapter=True` keeps the questions without a chapter."""

    chapter_id: uuid.UUID | None = None
    no_chapter: bool = False
    question_types: tuple[QuestionType, ...] = ()
    text: str | None = None


@dataclass(frozen=True)
class OverviewRow:
    question_id: uuid.UUID
    question_type: QuestionType
    question_number: int | None
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    chapter_document_id: uuid.UUID | None
    stem_head: str
    first_viewed_at: datetime | None
    last_graded_result: LastGradedResult | None
    needs_retry: bool
    is_favorite: bool
    is_pending_grading: bool


def _like_pattern(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def merged_members(workspace_id: uuid.UUID) -> Any:
    """`array[questions.id, <its actively merged duplicates>]`, correlated to the enclosing
    `questions` row (UX7-DEDUP): `x = any(...)` keeps an index lookup on `x`."""
    duplicates = select(question_merges.c.duplicate_question_id).where(
        question_merges.c.workspace_id == workspace_id,
        question_merges.c.kept_question_id == questions.c.id,
        question_merges.c.ended_at.is_(None),
    )
    return func.array_prepend(
        questions.c.id, func.array(duplicates.correlate(questions).scalar_subquery())
    )


def merged_state(workspace_id: uuid.UUID, user_id: uuid.UUID) -> Any:
    """LATERAL: the caller's state of the enclosing question folded with its merged duplicates'
    (earliest view, latest graded result by graded_at, OR of the flags), one row."""
    s, a = question_user_states, question_attempts
    order = (a.c.graded_at.desc().nulls_last(), a.c.submitted_at.desc(), a.c.id.desc())
    graded = func.array_agg(aggregate_order_by(s.c.last_graded_result, *order)).filter(
        s.c.last_graded_result.is_not(None)
    )
    return (
        select(
            func.min(s.c.first_viewed_at).label("first_viewed_at"),
            graded[1].label("last_graded_result"),
            func.bool_or(s.c.is_favorite).label("is_favorite"),
            func.bool_or(s.c.needs_retry).label("needs_retry"),
        )
        .select_from(s.outerjoin(a, a.c.id == s.c.last_graded_attempt_id))
        .where(
            s.c.user_id == user_id,
            s.c.question_id == any_(merged_members(workspace_id)),
        )
        .correlate(questions)
        .lateral("states")
    )


def overview_statement(
    workspace_id: uuid.UUID, user_id: uuid.UUID, flt: OverviewFilter
) -> Select[Any]:
    """The overview rows of `user_id` in `workspace_id`, in heatmap order."""
    latest_submitted = (
        select(practice_sessions.c.state == "pending_grade")
        .where(
            practice_sessions.c.user_id == user_id,
            practice_sessions.c.question_id == any_(merged_members(workspace_id)),
            practice_sessions.c.submitted_at.is_not(None),
            current_session(),
        )
        .order_by(practice_sessions.c.submitted_at.desc(), practice_sessions.c.id.desc())
        .limit(1)
        .correlate(questions)
        .scalar_subquery()
    )
    states = merged_state(workspace_id, user_id)
    conditions = heatmap_conditions(workspace_id)
    if flt.no_chapter:
        conditions.append(chapters.c.id.is_(None))
    elif flt.chapter_id is not None:
        conditions.append(chapters.c.id == flt.chapter_id)
    if flt.question_types:
        conditions.append(questions.c.question_type.in_(flt.question_types))
    if flt.text:
        conditions.append(question_revisions.c.stem.ilike(_like_pattern(flt.text), "\\"))

    return (
        select(
            questions.c.id.label("question_id"),
            questions.c.question_type,
            questions.c.question_number,
            chapters.c.id.label("chapter_id"),
            chapters.c.title.label("chapter_title"),
            chapters.c.document_id.label("chapter_document_id"),
            func.left(question_revisions.c.stem, STEM_HEAD).label("stem_head"),
            states.c.first_viewed_at,
            states.c.last_graded_result,
            func.coalesce(states.c.needs_retry, false()).label("needs_retry"),
            func.coalesce(states.c.is_favorite, false()).label("is_favorite"),
            func.coalesce(latest_submitted, false()).label("is_pending_grading"),
        )
        .select_from(heatmap_source().outerjoin(states, true()))
        .where(*conditions)
        .order_by(*heatmap_order())
    )


def heatmap_source() -> Any:
    """Live questions with their active revision, chapter and the chapter's document: the FROM
    of the Heatmap (also `quiz_api.question_ranges`, so a range is the Heatmap's set)."""
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


def heatmap_conditions(workspace_id: uuid.UUID) -> list[ColumnElement[bool]]:
    """The Heatmap's questions: CONFIRMED and not deleted (drafts and archived ones — merged
    duplicates included — never appear)."""
    return [
        questions.c.workspace_id == workspace_id,
        questions.c.publication_status == "CONFIRMED",
        questions.c.deleted_at.is_(None),
    ]


def heatmap_order() -> tuple[ColumnElement[Any], ...]:
    """Heatmap order over `heatmap_source()` (docs/questions.md §3.1, module docstring)."""
    return (
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


class QuestionOverviewRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def rows(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, flt: OverviewFilter
    ) -> list[OverviewRow]:
        result = self._session.execute(overview_statement(workspace_id, user_id, flt))
        return [
            OverviewRow(
                question_id=r.question_id,
                question_type=cast(QuestionType, r.question_type),
                question_number=r.question_number,
                chapter_id=r.chapter_id,
                chapter_title=r.chapter_title,
                chapter_document_id=r.chapter_document_id,
                stem_head=r.stem_head,
                first_viewed_at=r.first_viewed_at,
                last_graded_result=cast("LastGradedResult | None", r.last_graded_result),
                needs_retry=bool(r.needs_retry),
                is_favorite=bool(r.is_favorite),
                is_pending_grading=bool(r.is_pending_grading),
            )
            for r in result
        ]

    def chapter_ancestors(
        self, chapter_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, list[tuple[uuid.UUID, str]]]:
        """chapter id -> (id, title) of its ancestors, top level first, without itself."""
        ids = list(set(chapter_ids))
        if not ids:
            return {}
        base = select(
            chapters.c.id.label("start_id"),
            chapters.c.parent_id,
            literal(1).label("depth"),
        ).where(chapters.c.id.in_(ids), chapters.c.parent_id.is_not(None))
        path = base.cte("chapter_ancestors", recursive=True)
        parent = chapters.alias("ancestor")
        path = path.union_all(
            select(path.c.start_id, parent.c.parent_id, path.c.depth + 1).where(
                parent.c.id == path.c.parent_id,
                parent.c.parent_id.is_not(None),
                path.c.depth < 32,
            )
        )
        rows = self._session.execute(
            select(path.c.start_id, chapters.c.id, chapters.c.title)
            .join(chapters, chapters.c.id == path.c.parent_id)
            .order_by(path.c.start_id, path.c.depth.desc())
        )
        out: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {i: [] for i in ids}
        for r in rows:
            out[r.start_id].append((r.id, r.title))
        return out

    def chapter_lineage(self, chapter_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
        """chapter id -> titles from its top-level ancestor down to itself (outline path)."""
        ids = list(set(chapter_ids))
        if not ids:
            return {}
        base = select(
            chapters.c.id.label("start_id"),
            chapters.c.parent_id,
            chapters.c.title,
            literal(0).label("depth"),
        ).where(chapters.c.id.in_(ids))
        path = base.cte("chapter_path", recursive=True)
        parent = chapters.alias("parent")
        path = path.union_all(
            select(
                path.c.start_id,
                parent.c.parent_id,
                parent.c.title,
                path.c.depth + 1,
            ).where(parent.c.id == path.c.parent_id, path.c.depth < 32)
        )
        rows = self._session.execute(
            select(path.c.start_id, path.c.title).order_by(path.c.start_id, path.c.depth.desc())
        )
        out: dict[uuid.UUID, list[str]] = {i: [] for i in ids}
        for r in rows:
            out[r.start_id].append(r.title)
        return out
