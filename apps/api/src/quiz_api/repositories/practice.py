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
  * `is_favorite`/`needs_retry` change through my-state; only an incorrect grading clears
    `needs_retry` (the question_user_states trigger, questions.md §17).

Merged duplicates (UX7-DEDUP, docs/questions.md §10.2): reads of a question's state and attempts
include its actively merged (archived) duplicates — the state through the
`question_merged_user_states` view, the attempts by question id. Writes go to the question's own
rows, except that clearing a flag also clears it on the caller's merged duplicates (the merged
flag is their OR). Attempts are never rewritten.

Round trips (PERF-1): opening a session and submitting an answer each write several rows; every
group of writes that belongs together is one statement (data-modifying CTEs), so the request
costs one database round trip per step instead of one per row.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import and_, func, insert, literal, select, true, tuple_, union_all, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.authz.permissions import LockMode, Role
from quiz_api.authz.repository import MembershipRecord, membership_select
from quiz_api.practice_grading import AttemptResult, GradedResult
from quiz_api.question_rules import QuestionType
from quiz_api.question_status import LastGradedResult
from quiz_api.repositories.practice_epoch import current_session
from quiz_api.repositories.questions import RevisionRecord
from quiz_api.repositories.tables import (
    activity_events,
    practice_reset_epochs,
    practice_sessions,
    question_attempts,
    question_merged_user_states,
    question_merges,
    question_revisions,
    question_user_states,
    questions,
    workspaces,
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
    # QVIEW-B: the run position this session practises (None outside a run).
    practice_run_id: uuid.UUID | None = None
    run_position: int | None = None
    reset_epoch: int = 0


@dataclass(frozen=True)
class OpenedSession:
    id: uuid.UUID
    state: SessionState
    opened_at: datetime


# Below every real epoch: submit and reuse compare a session's epoch with the current one, so a
# session given this value is refused like one from before a reset (UX12-SOLVEDOPEN).
RETIRED_SESSION_EPOCH = -1


@dataclass(frozen=True)
class SubmittedSession:
    attempt_id: uuid.UUID
    state: SessionState
    submitted_at: datetime | None
    graded_at: datetime | None


@dataclass(frozen=True)
class LatestOutcome:
    """The caller's latest submitted session with its current and first attempts."""

    session: SessionRecord
    latest_attempt_id: uuid.UUID | None
    latest_result: AttemptResult | None
    submitted_answer: dict[str, Any] | None


@dataclass(frozen=True)
class AttemptRecord:
    id: uuid.UUID
    question_id: uuid.UUID
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
    practice_sessions.c.reset_epoch,
    practice_sessions.c.state,
    practice_sessions.c.opened_at,
    practice_sessions.c.submitted_at,
    practice_sessions.c.graded_at,
    practice_sessions.c.practice_run_id,
    practice_sessions.c.run_position,
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
    question_revisions.c.stem_tables.label("rev_stem_tables"),
    question_revisions.c.created_at.label("rev_created_at"),
)

_ATTEMPT_COLUMNS = (
    question_attempts.c.id,
    question_attempts.c.question_id,
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
            stem_tables=row.rev_stem_tables,
        ),
        practice_run_id=row.practice_run_id,
        run_position=row.run_position,
        reset_epoch=row.reset_epoch,
    )


def _attempt(row: Any) -> AttemptRecord:
    return AttemptRecord(
        id=row.id,
        question_id=row.question_id,
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

    def lock_reset(self, user_id: uuid.UUID, question_id: uuid.UUID) -> None:
        key = f"practice-reset:{user_id}:{question_id}"
        self._session.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(key, 0))))

    def lock_epoch_with_reset(self, user_id: uuid.UUID, question_id: uuid.UUID) -> tuple[int, bool]:
        """Take the transaction lock before reading an epoch in a fresh statement snapshot."""
        self.lock_reset(user_id, question_id)
        row = self._session.execute(
            select(
                practice_reset_epochs.c.epoch,
                practice_reset_epochs.c.reset_at > func.transaction_timestamp(),
            ).where(
                practice_reset_epochs.c.user_id == user_id,
                practice_reset_epochs.c.question_id == question_id,
            )
        ).one_or_none()
        return (int(row[0]), bool(row[1])) if row is not None else (0, False)

    def lock_epoch(self, user_id: uuid.UUID, question_id: uuid.UUID) -> int:
        return self.lock_epoch_with_reset(user_id, question_id)[0]

    def reset(self, user_id: uuid.UUID, question_id: uuid.UUID) -> dict[str, int]:
        members = sorted(set(self._session.execute(self._members(question_id)).scalars()), key=str)
        for member in members:
            self.lock_epoch(user_id, member)
        epochs = self._session.execute(
            pg_insert(practice_reset_epochs)
            .values(
                [
                    {
                        "user_id": user_id,
                        "question_id": member,
                        "epoch": 1,
                        "reset_at": func.clock_timestamp(),
                    }
                    for member in members
                ]
            )
            .on_conflict_do_update(
                index_elements=[
                    practice_reset_epochs.c.user_id,
                    practice_reset_epochs.c.question_id,
                ],
                set_={
                    "epoch": practice_reset_epochs.c.epoch + 1,
                    "reset_at": func.clock_timestamp(),
                },
            )
            .returning(practice_reset_epochs.c.question_id, practice_reset_epochs.c.epoch)
        ).all()
        self._session.execute(
            update(question_user_states)
            .where(
                question_user_states.c.user_id == user_id,
                question_user_states.c.question_id.in_(members),
            )
            .values(
                first_viewed_at=None,
                last_viewed_at=None,
                last_graded_result=None,
                last_graded_attempt_id=None,
                is_favorite=False,
                needs_retry=False,
            )
        )

        return {str(question_id): epoch for question_id, epoch in epochs}

    def session_membership(
        self, session_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> tuple[MembershipRecord, uuid.UUID] | None:
        """The caller's membership in the workspace of the caller's own session, in one query
        (ownership and membership, with the membership lock of the action); `None` for unknown
        and foreign sessions and for non-members alike (the route answers all with one 404)."""
        stmt = (
            membership_select(user_id, lock)
            .add_columns(practice_sessions.c.question_id.label("session_question_id"))
            .join(practice_sessions, practice_sessions.c.workspace_id == workspaces.c.id)
            .where(practice_sessions.c.id == session_id, practice_sessions.c.user_id == user_id)
        )
        row = self._session.execute(stmt).mappings().one_or_none()
        if row is None:
            return None
        return (
            MembershipRecord(
                workspace_id=row["id"],
                user_id=user_id,
                role=Role(row["role"]),
                status=row["status"],
                archived_at=row["archived_at"],
            ),
            row["session_question_id"],
        )

    def get_session_epoch(
        self, session_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> tuple[SessionRecord, int] | None:
        epoch = (
            select(practice_reset_epochs.c.epoch)
            .where(
                practice_reset_epochs.c.user_id == user_id,
                practice_reset_epochs.c.question_id == practice_sessions.c.question_id,
            )
            .scalar_subquery()
        )
        stmt = (
            self._session_select()
            .add_columns(func.coalesce(epoch, 0).label("current_epoch"))
            .where(
                practice_sessions.c.id == session_id,
                practice_sessions.c.user_id == user_id,
                questions.c.deleted_at.is_(None),
            )
        )
        if lock:
            stmt = stmt.with_for_update(of=practice_sessions)
        row = self._session.execute(stmt).one_or_none()
        return (_session(row), int(row.current_epoch)) if row is not None else None

    def get_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> SessionRecord | None:
        """The caller's session whose question is still live; `lock` = FOR UPDATE of the session
        row only (the submit/self-grade path)."""
        stmt = self._session_select().where(
            practice_sessions.c.id == session_id,
            practice_sessions.c.user_id == user_id,
            questions.c.deleted_at.is_(None),
        )
        if lock:
            stmt = stmt.with_for_update(of=practice_sessions)
        row = self._session.execute(stmt).one_or_none()
        return _session(row) if row is not None else None

    def run_session(
        self, run_id: uuid.UUID, position: int, user_id: uuid.UUID
    ) -> SessionRecord | None:
        """The caller's session of a run position (at most one), whatever its question's state."""
        row = self._session.execute(
            self._session_select().where(
                practice_sessions.c.practice_run_id == run_id,
                practice_sessions.c.run_position == position,
                practice_sessions.c.user_id == user_id,
            )
        ).one_or_none()
        return _session(row) if row is not None else None

    def initial_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> AttemptRecord | None:
        row = self._session.execute(
            self._attempt_select()
            .where(
                question_attempts.c.practice_session_id == session_id,
                question_attempts.c.user_id == user_id,
                question_attempts.c.grades_attempt_id.is_(None),
            )
            .order_by(question_attempts.c.submitted_at, question_attempts.c.id)
            .limit(1)
        ).one_or_none()
        return _attempt(row) if row is not None else None

    def latest_submitted_session(
        self, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> SessionRecord | None:
        row = self._session.execute(
            self._session_select()
            .where(
                practice_sessions.c.question_id == question_id,
                practice_sessions.c.user_id == user_id,
                practice_sessions.c.submitted_at.is_not(None),
                current_session(),
            )
            .order_by(practice_sessions.c.submitted_at.desc(), practice_sessions.c.id.desc())
            .limit(1)
        ).one_or_none()
        return _session(row) if row is not None else None

    def latest_outcome(self, question_id: uuid.UUID, user_id: uuid.UUID) -> LatestOutcome | None:
        """`latest_submitted_session` with `latest_attempt` and `initial_attempt` in one
        statement: opening a question must not spend three round trips on them (UX12-OPEN)."""
        session_attempts = and_(
            question_attempts.c.practice_session_id == practice_sessions.c.id,
            question_attempts.c.user_id == user_id,
        )
        latest = (
            select(question_attempts.c.id, question_attempts.c.result)
            .where(session_attempts)
            .order_by(question_attempts.c.submitted_at.desc(), question_attempts.c.id.desc())
            .limit(1)
            .lateral("latest_attempt")
        )
        initial = (
            select(question_attempts.c.submitted_answer)
            .where(session_attempts, question_attempts.c.grades_attempt_id.is_(None))
            .order_by(question_attempts.c.submitted_at, question_attempts.c.id)
            .limit(1)
            .lateral("initial_attempt")
        )
        row = self._session.execute(
            select(
                *_SESSION_COLUMNS,
                latest.c.id.label("latest_attempt_id"),
                latest.c.result.label("latest_result"),
                initial.c.submitted_answer.label("initial_answer"),
            )
            .select_from(
                self._session_tables().outerjoin(latest, true()).outerjoin(initial, true())
            )
            .where(
                practice_sessions.c.question_id == question_id,
                practice_sessions.c.user_id == user_id,
                practice_sessions.c.submitted_at.is_not(None),
                current_session(),
            )
            .order_by(practice_sessions.c.submitted_at.desc(), practice_sessions.c.id.desc())
            .limit(1)
        ).one_or_none()
        if row is None:
            return None
        return LatestOutcome(
            session=_session(row),
            latest_attempt_id=row.latest_attempt_id,
            latest_result=cast(AttemptResult | None, row.latest_result),
            submitted_answer=dict(row.initial_answer) if row.initial_answer is not None else None,
        )

    def retire_open_sessions(self, question_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """The caller's open sessions of the question can no longer be submitted: their answers
        were just revealed (UX12-SOLVEDOPEN). Run positions are the run's own record and stay."""
        self._session.execute(
            update(practice_sessions)
            .where(
                practice_sessions.c.question_id == question_id,
                practice_sessions.c.user_id == user_id,
                practice_sessions.c.state == "open",
                practice_sessions.c.practice_run_id.is_(None),
            )
            .values(reset_epoch=RETIRED_SESSION_EPOCH)
        )

    def record_view(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        """Re-opening a run position's open session is a study view like opening one."""
        self._session.execute(self._view_upsert(workspace_id, question_id, user_id))

    @staticmethod
    def _session_tables() -> Any:
        return practice_sessions.join(
            questions,
            and_(
                questions.c.id == practice_sessions.c.question_id,
                questions.c.workspace_id == practice_sessions.c.workspace_id,
            ),
        ).join(
            question_revisions,
            question_revisions.c.id == practice_sessions.c.question_revision_id,
        )

    @classmethod
    def _session_select(cls) -> Any:
        return select(*_SESSION_COLUMNS).select_from(cls._session_tables())

    def open_session(
        self,
        *,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        revision_id: uuid.UUID,
        user_id: uuid.UUID,
        displayed_option_ids: list[str],
        shuffle_seed: int | None,
        practice_run_id: uuid.UUID | None = None,
        run_position: int | None = None,
        reset_epoch: int = 0,
    ) -> OpenedSession:
        """Insert the session and record the caller's view (`record_view`) in one statement."""
        opened = (
            insert(practice_sessions)
            .values(
                workspace_id=workspace_id,
                question_id=question_id,
                question_revision_id=revision_id,
                user_id=user_id,
                displayed_option_ids=displayed_option_ids,
                shuffle_seed=shuffle_seed,
                reset_epoch=reset_epoch,
                state="open",
                practice_run_id=practice_run_id,
                run_position=run_position,
            )
            .returning(
                practice_sessions.c.id, practice_sessions.c.state, practice_sessions.c.opened_at
            )
            .cte("opened")
        )
        viewed = self._view_upsert(workspace_id, question_id, user_id).cte("viewed")
        row = self._session.execute(
            select(opened.c.id, opened.c.state, opened.c.opened_at).add_cte(viewed)
        ).one()
        return OpenedSession(row.id, row.state, row.opened_at)

    def submit(
        self,
        session: SessionRecord,
        *,
        submitted_answer: dict[str, Any],
        result: AttemptResult,
    ) -> SubmittedSession:
        """One statement: append the attempt, move the (locked, open) session to graded or
        pending_grade, and for a graded result record it in the caller's study state
        (`record_graded`)."""
        graded = result != "pending"
        attempt = (
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
            .cte("attempt")
        )
        finished = (
            update(practice_sessions)
            .where(practice_sessions.c.id == session.id, practice_sessions.c.state == "open")
            .values(
                state="graded" if graded else "pending_grade",
                submitted_at=func.now(),
                graded_at=func.now() if graded else None,
            )
            .returning(
                practice_sessions.c.state,
                practice_sessions.c.submitted_at,
                practice_sessions.c.graded_at,
            )
            .cte("finished")
        )
        stmt = select(
            attempt.c.id, finished.c.state, finished.c.submitted_at, finished.c.graded_at
        ).select_from(attempt.join(finished, true()))
        if graded:
            state = pg_insert(question_user_states).from_select(
                [
                    "user_id",
                    "question_id",
                    "workspace_id",
                    "last_graded_result",
                    "last_graded_attempt_id",
                ],
                select(
                    literal(session.user_id, question_user_states.c.user_id.type),
                    literal(session.question_id, question_user_states.c.question_id.type),
                    literal(session.workspace_id, question_user_states.c.workspace_id.type),
                    literal(result, question_user_states.c.last_graded_result.type),
                    attempt.c.id,
                ),
            )
            stmt = stmt.add_cte(
                state.on_conflict_do_update(
                    index_elements=[
                        question_user_states.c.user_id,
                        question_user_states.c.question_id,
                    ],
                    set_={
                        "last_graded_result": state.excluded.last_graded_result,
                        "last_graded_attempt_id": state.excluded.last_graded_attempt_id,
                    },
                ).cte("graded")
            )
        row = self._session.execute(stmt).one()
        return SubmittedSession(row.id, row.state, row.submitted_at, row.graded_at)

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
        """The caller's attempts on a question and on its merged duplicates (UX7-DEDUP), newest
        first (keyset on submitted_at, id)."""
        stmt = self._attempt_select().where(
            question_attempts.c.user_id == user_id,
            question_attempts.c.question_id.in_(self._members(question_id)),
            select(practice_sessions.c.id)
            .where(
                practice_sessions.c.id == question_attempts.c.practice_session_id,
                current_session(),
            )
            .exists(),
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

    @staticmethod
    def _merged_duplicates(question_id: uuid.UUID) -> Any:
        return select(question_merges.c.duplicate_question_id).where(
            question_merges.c.kept_question_id == question_id,
            question_merges.c.ended_at.is_(None),
        )

    def _members(self, question_id: uuid.UUID) -> Any:
        """The question and its actively merged duplicates (UX7-DEDUP)."""
        return union_all(
            select(literal(question_id, question_attempts.c.question_id.type)),
            self._merged_duplicates(question_id),
        )

    @staticmethod
    def _upsert(
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        insert_values: dict[str, Any],
        update_values: dict[str, Any],
    ) -> Any:
        stmt = pg_insert(question_user_states).values(
            user_id=user_id, question_id=question_id, workspace_id=workspace_id, **insert_values
        )
        return stmt.on_conflict_do_update(
            index_elements=[question_user_states.c.user_id, question_user_states.c.question_id],
            set_=update_values,
        )

    def _upsert_state(
        self,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        insert_values: dict[str, Any],
        update_values: dict[str, Any],
    ) -> None:
        self._session.execute(
            self._upsert(workspace_id, question_id, user_id, insert_values, update_values)
        )

    def _view_upsert(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> Any:
        """Opening a practice session is the only study view (questions.md §2.1)."""
        first = func.coalesce(question_user_states.c.first_viewed_at, func.now())
        return self._upsert(
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
        """Writes the flags on the question's own state row. A flag turned off is also turned off
        on the caller's merged duplicates (UX7-DEDUP): the merged flag is their OR."""
        self._upsert_state(workspace_id, question_id, user_id, dict(flags), dict(flags))
        cleared = {k: False for k, v in flags.items() if not v}
        if cleared:
            self._session.execute(
                update(question_user_states)
                .where(
                    question_user_states.c.user_id == user_id,
                    question_user_states.c.workspace_id == workspace_id,
                    question_user_states.c.question_id.in_(self._merged_duplicates(question_id)),
                )
                .values(**cleared)
            )

    def lock_state(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, user_id: uuid.UUID
    ) -> StateRecord:
        """The caller's state row, created with defaults if missing, locked FOR UPDATE until the
        transaction ends, so read-compare-write callers (my-state) serialize even on the very
        first update: a concurrent creator waits on the speculative insert, then the SELECT
        (a new READ COMMITTED snapshot) sees and locks the committed row. The single-statement
        upserts (session open, `record_graded`) compute their values in SQL and need no lock."""
        self._session.execute(
            pg_insert(question_user_states)
            .values(user_id=user_id, question_id=question_id, workspace_id=workspace_id)
            .on_conflict_do_nothing(
                index_elements=[question_user_states.c.user_id, question_user_states.c.question_id]
            )
        )
        return self.get_state(question_id, user_id, lock=True, workspace_id=workspace_id)

    def get_state(
        self,
        question_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        lock: bool = False,
        workspace_id: uuid.UUID | None = None,
    ) -> StateRecord:
        """The caller's state of the question folded with its merged duplicates' (UX7-DEDUP).
        `lock` = FOR UPDATE of the question's own row (see lock_state), in the same statement
        (PERF-1 round trips): the read hangs off the locked row."""
        merged = question_merged_user_states
        on = [merged.c.user_id == user_id, merged.c.question_id == question_id]
        if workspace_id is not None:
            on.append(merged.c.workspace_id == workspace_id)
        columns = (
            merged.c.first_viewed_at,
            merged.c.last_graded_result,
            merged.c.is_favorite,
            merged.c.needs_retry,
        )
        if lock:
            own = (
                select(question_user_states.c.user_id)
                .where(
                    question_user_states.c.user_id == user_id,
                    question_user_states.c.question_id == question_id,
                )
                .with_for_update()
                .cte("own")
            )
            stmt = select(*columns).select_from(own.outerjoin(merged, and_(*on)))
        else:
            stmt = select(*columns).where(*on)
        row = self._session.execute(stmt).one_or_none()
        if row is None:
            return StateRecord(None, None, False, False)
        return StateRecord(
            first_viewed_at=row.first_viewed_at,
            last_graded_result=cast("LastGradedResult | None", row.last_graded_result),
            is_favorite=bool(row.is_favorite),
            needs_retry=bool(row.needs_retry),
        )

    def latest_submission_pending(self, question_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        """The caller's most recent submission on the question (or its merged duplicates) waits
        for self-grading: the overview's `is_pending_grading` (RETRY-CORRECT: `다시 풀기` is not
        offered until it is graded)."""
        row = self._session.execute(
            select(practice_sessions.c.state)
            .where(
                practice_sessions.c.user_id == user_id,
                practice_sessions.c.question_id.in_(self._members(question_id)),
                practice_sessions.c.submitted_at.is_not(None),
                current_session(),
            )
            .order_by(practice_sessions.c.submitted_at.desc(), practice_sessions.c.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        return row == "pending_grade"

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
