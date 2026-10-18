"""Practice sessions, immutable attempts and per-user study state (M5.2) over the M4.1 tables.

Runs in the request session after the route's authorization locked the workspace/membership
rows (`LockMode.SHARE` for writes). Submit and self-grade additionally lock the session row
(`FOR UPDATE`) so its state check and transition are atomic: of two concurrent submits of one
session, the second waits, then sees a non-open state and is refused.

Timestamps come from the database clock (`now()`), never from the client. Every row is scoped by
the caller's `user_id` (the verified JWT `sub`); nothing here reads another user's rows.

`question_user_states` (questions.md §2.1):
  * `first_viewed_at`/`last_viewed_at` are written only when a practice session opens.
  * `last_graded_result`/`last_graded_attempt_id` change only for a graded (correct/incorrect)
    attempt; a pending submission leaves them as they were.
  * `is_favorite`/`needs_retry` change only through my-state; grading never clears `needs_retry`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import and_, func, insert, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.practice_grading import AttemptResult, GradedResult
from quiz_api.question_rules import QuestionType
from quiz_api.question_status import LastGradedResult
from quiz_api.repositories.questions import RevisionRecord
from quiz_api.repositories.tables import (
    activity_events,
    practice_sessions,
    question_attempts,
    question_revisions,
    question_user_states,
    questions,
)

SessionState = str  # open | pending_grade | graded


@dataclass(frozen=True)
class SessionRecord:
    """A practice session joined with its live question and the revision it pins."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    question_id: uuid.UUID
    user_id: uuid.UUID
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    question_number: int | None
    displayed_option_ids: list[str]
    state: SessionState
    opened_at: datetime
    submitted_at: datetime | None
    graded_at: datetime | None
    revision: RevisionRecord


@dataclass(frozen=True)
class AttemptRecord:
    id: uuid.UUID
    question_revision_id: uuid.UUID
    revision_version: int
    practice_session_id: uuid.UUID
    displayed_option_ids: list[str]
    submitted_answer: dict[str, Any]
    result: AttemptResult
    grading_method: str | None
    grades_attempt_id: uuid.UUID | None
    submitted_at: datetime
    graded_at: datetime | None


@dataclass(frozen=True)
class StateRecord:
    first_viewed_at: datetime | None
    last_graded_result: LastGradedResult | None
    is_favorite: bool
    needs_retry: bool


@dataclass(frozen=True)
class AttemptCursor:
    submitted_at: datetime
    id: uuid.UUID


_SESSION_COLUMNS = (
    practice_sessions.c.id,
    practice_sessions.c.workspace_id,
    practice_sessions.c.question_id,
    practice_sessions.c.user_id,
    practice_sessions.c.displayed_option_ids,
    practice_sessions.c.state,
    practice_sessions.c.opened_at,
    practice_sessions.c.submitted_at,
    practice_sessions.c.graded_at,
    questions.c.question_type,
    questions.c.chapter_id,
    questions.c.question_number,
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

_ATTEMPT_COLUMNS = (
    question_attempts.c.id,
    question_attempts.c.question_revision_id,
    question_revisions.c.version.label("revision_version"),
    question_attempts.c.practice_session_id,
    question_attempts.c.displayed_option_ids,
    question_attempts.c.submitted_answer,
    question_attempts.c.result,
    question_attempts.c.grading_method,
    question_attempts.c.grades_attempt_id,
    question_attempts.c.submitted_at,
    question_attempts.c.graded_at,
)


def _session(row: Any) -> SessionRecord:
    return SessionRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        question_id=row.question_id,
        user_id=row.user_id,
        question_type=cast(QuestionType, row.question_type),
        chapter_id=row.chapter_id,
        question_number=row.question_number,
        displayed_option_ids=list(row.displayed_option_ids),
        state=row.state,
        opened_at=row.opened_at,
        submitted_at=row.submitted_at,
        graded_at=row.graded_at,
        revision=RevisionRecord(
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
        ),
    )


def _attempt(row: Any) -> AttemptRecord:
    return AttemptRecord(
        id=row.id,
        question_revision_id=row.question_revision_id,
        revision_version=row.revision_version,
        practice_session_id=row.practice_session_id,
        displayed_option_ids=list(row.displayed_option_ids),
        submitted_answer=dict(row.submitted_answer),
        result=cast(AttemptResult, row.result),
        grading_method=row.grading_method,
        grades_attempt_id=row.grades_attempt_id,
        submitted_at=row.submitted_at,
        graded_at=row.graded_at,
    )


class PracticeRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- sessions --------------------------------------------------------------------------------

    def session_owner_workspace(
        self, session_id: uuid.UUID, user_id: uuid.UUID
    ) -> uuid.UUID | None:
        """The workspace of the caller's own session; `None` for unknown and foreign sessions
        alike (the route answers both with the same 404)."""
        workspace_id: uuid.UUID | None = self._session.execute(
            select(practice_sessions.c.workspace_id).where(
                practice_sessions.c.id == session_id, practice_sessions.c.user_id == user_id
            )
        ).scalar_one_or_none()
        return workspace_id

    def get_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> SessionRecord | None:
        """The caller's session whose question is still live; `lock` = FOR UPDATE of the session
        row only (the submit/self-grade path)."""
        stmt = (
            select(*_SESSION_COLUMNS)
            .select_from(
                practice_sessions.join(
                    questions,
                    and_(
                        questions.c.id == practice_sessions.c.question_id,
                        questions.c.workspace_id == practice_sessions.c.workspace_id,
                    ),
                ).join(
                    question_revisions,
                    question_revisions.c.id == practice_sessions.c.question_revision_id,
                )
            )
            .where(
                practice_sessions.c.id == session_id,
                practice_sessions.c.user_id == user_id,
                questions.c.deleted_at.is_(None),
            )
        )
        if lock:
            stmt = stmt.with_for_update(of=practice_sessions)
        row = self._session.execute(stmt).one_or_none()
        return _session(row) if row is not None else None

    def open_session(
        self,
        *,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        revision_id: uuid.UUID,
        user_id: uuid.UUID,
        displayed_option_ids: list[str],
        shuffle_seed: int | None,
    ) -> uuid.UUID:
        session_id: uuid.UUID = self._session.execute(
            insert(practice_sessions)
            .values(
                workspace_id=workspace_id,
                question_id=question_id,
                question_revision_id=revision_id,
                user_id=user_id,
                displayed_option_ids=displayed_option_ids,
                shuffle_seed=shuffle_seed,
                state="open",
            )
            .returning(practice_sessions.c.id)
        ).scalar_one()
        return session_id

    def finish_session(self, session_id: uuid.UUID, *, graded: bool) -> None:
        """open -> graded (auto-graded) or open -> pending_grade (awaits a self-grade)."""
        self._session.execute(
            update(practice_sessions)
            .where(practice_sessions.c.id == session_id, practice_sessions.c.state == "open")
            .values(
                state="graded" if graded else "pending_grade",
                submitted_at=func.now(),
                graded_at=func.now() if graded else None,
            )
        )

    def grade_session(self, session_id: uuid.UUID) -> None:
        """pending_grade -> graded."""
        self._session.execute(
            update(practice_sessions)
            .where(
                practice_sessions.c.id == session_id, practice_sessions.c.state == "pending_grade"
            )
            .values(state="graded", graded_at=func.now())
        )

    # --- attempts --------------------------------------------------------------------------------

    def _attempt_select(self) -> Any:
        return select(*_ATTEMPT_COLUMNS).select_from(
            question_attempts.join(
                question_revisions,
                question_revisions.c.id == question_attempts.c.question_revision_id,
            )
        )

    def get_attempt(self, attempt_id: uuid.UUID) -> AttemptRecord:
        row = self._session.execute(
            self._attempt_select().where(question_attempts.c.id == attempt_id)
        ).one()
        return _attempt(row)

    def add_attempt(
        self,
        session: SessionRecord,
        *,
        submitted_answer: dict[str, Any],
        result: AttemptResult,
    ) -> uuid.UUID:
        graded = result != "pending"
        attempt_id: uuid.UUID = self._session.execute(
            insert(question_attempts)
            .values(
                workspace_id=session.workspace_id,
                question_id=session.question_id,
                question_revision_id=session.revision.id,
                practice_session_id=session.id,
                user_id=session.user_id,
                displayed_option_ids=session.displayed_option_ids,
                submitted_answer=submitted_answer,
                result=result,
                grading_method="auto" if graded else None,
                graded_at=func.now() if graded else None,
            )
            .returning(question_attempts.c.id)
        ).scalar_one()
        return attempt_id

    def pending_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> AttemptRecord | None:
        """The session's ungraded submission (at most one: a session is submitted once)."""
        row = self._session.execute(
            self._attempt_select().where(
                question_attempts.c.practice_session_id == session_id,
                question_attempts.c.user_id == user_id,
                question_attempts.c.result == "pending",
            )
        ).one_or_none()
        return _attempt(row) if row is not None else None

    def latest_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> AttemptRecord | None:
        """The session's current outcome: its grade if graded, else its pending submission."""
        row = self._session.execute(
            self._attempt_select()
            .where(
                question_attempts.c.practice_session_id == session_id,
                question_attempts.c.user_id == user_id,
            )
            .order_by(question_attempts.c.submitted_at.desc(), question_attempts.c.id.desc())
            .limit(1)
        ).one_or_none()
        return _attempt(row) if row is not None else None

    def add_grade(
        self,
        session: SessionRecord,
        pending: AttemptRecord,
        *,
        result: GradedResult,
        method: str,
        graded_by: uuid.UUID,
    ) -> uuid.UUID:
        """A new attempt grading `pending` (the pending row itself never changes). It copies the
        pending submission; `submitted_at` is the grading time so it sorts as the newest."""
        attempt_id: uuid.UUID = self._session.execute(
            insert(question_attempts)
            .values(
                workspace_id=session.workspace_id,
                question_id=session.question_id,
                question_revision_id=pending.question_revision_id,
                practice_session_id=session.id,
                user_id=session.user_id,
                displayed_option_ids=pending.displayed_option_ids,
                submitted_answer=pending.submitted_answer,
                result=result,
                grading_method=method,
                grades_attempt_id=pending.id,
                graded_by=graded_by,
                graded_at=func.now(),
            )
            .returning(question_attempts.c.id)
        ).scalar_one()
        return attempt_id

    def attempts(
        self,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        limit: int,
        after: AttemptCursor | None = None,
    ) -> tuple[list[AttemptRecord], AttemptCursor | None]:
        """The caller's attempts on a question, newest first (keyset on submitted_at, id)."""
        stmt = self._attempt_select().where(
            question_attempts.c.user_id == user_id,
            question_attempts.c.question_id == question_id,
        )
        if after is not None:
            stmt = stmt.where(
                tuple_(question_attempts.c.submitted_at, question_attempts.c.id)
                < tuple_(after.submitted_at, after.id)
            )
        rows = self._session.execute(
            stmt.order_by(
                question_attempts.c.submitted_at.desc(), question_attempts.c.id.desc()
            ).limit(limit + 1)
        ).all()
        items = [_attempt(r) for r in rows[:limit]]
        more = len(rows) > limit
        cursor = AttemptCursor(items[-1].submitted_at, items[-1].id) if more and items else None
        return items, cursor

    # --- study state -----------------------------------------------------------------------------

    def _upsert_state(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        insert_values: dict[str, Any],
        update_values: dict[str, Any],
    ) -> None:
        stmt = pg_insert(question_user_states).values(
            user_id=user_id, question_id=question_id, workspace_id=workspace_id, **insert_values
        )
        self._session.execute(
            stmt.on_conflict_do_update(
                index_elements=[question_user_states.c.user_id, question_user_states.c.question_id],
                set_=update_values,
            )
        )

    def record_view(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        """Opening a practice session is the only study view (questions.md §2.1)."""
        first = func.coalesce(question_user_states.c.first_viewed_at, func.now())
        self._upsert_state(
            workspace_id,
            question_id,
            user_id,
            {"first_viewed_at": func.now(), "last_viewed_at": func.now()},
            {"first_viewed_at": first, "last_viewed_at": func.greatest(first, func.now())},
        )

    def record_graded(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        attempt_id: uuid.UUID,
        result: GradedResult,
    ) -> None:
        values = {"last_graded_result": result, "last_graded_attempt_id": attempt_id}
        self._upsert_state(workspace_id, question_id, user_id, values, values)

    def set_flags(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        flags: dict[str, bool],
    ) -> None:
        self._upsert_state(workspace_id, question_id, user_id, dict(flags), dict(flags))

    def lock_state(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> StateRecord:
        """The caller's state row, created with defaults if missing, locked FOR UPDATE until the
        transaction ends, so read-compare-write callers (my-state) serialize even on the very
        first update: a concurrent creator waits on the speculative insert, then the SELECT
        (a new READ COMMITTED snapshot) sees and locks the committed row. The single-statement
        upserts (`record_view`, `record_graded`) compute their values in SQL and need no lock."""
        self._session.execute(
            pg_insert(question_user_states)
            .values(user_id=user_id, question_id=question_id, workspace_id=workspace_id)
            .on_conflict_do_nothing(
                index_elements=[question_user_states.c.user_id, question_user_states.c.question_id]
            )
        )
        return self.get_state(question_id, user_id, lock=True)

    def get_state(
        self, question_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> StateRecord:
        stmt = select(
            question_user_states.c.first_viewed_at,
            question_user_states.c.last_graded_result,
            question_user_states.c.is_favorite,
            question_user_states.c.needs_retry,
        ).where(
            question_user_states.c.user_id == user_id,
            question_user_states.c.question_id == question_id,
        )
        if lock:
            stmt = stmt.with_for_update()
        row = self._session.execute(stmt).one_or_none()
        if row is None:
            return StateRecord(None, None, False, False)
        return StateRecord(
            first_viewed_at=row.first_viewed_at,
            last_graded_result=cast("LastGradedResult | None", row.last_graded_result),
            is_favorite=row.is_favorite,
            needs_retry=row.needs_retry,
        )

    def record_activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        question_id: uuid.UUID,
        metadata: dict[str, Any],
    ) -> None:
        """History of a favorite/retry toggle (questions.md §4.7). Personal study state: the
        event is marked `visibility: actor`, and the activity feed (M7.1) must show
        `question.study_state_changed` events to their actor only (workspace-sharing.md §1:
        personal favorites/retry are private). Metadata carries the changed flags only."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type="question.study_state_changed",
                target_type="question",
                target_id=question_id,
                metadata={"visibility": "actor", **metadata},
            )
        )
