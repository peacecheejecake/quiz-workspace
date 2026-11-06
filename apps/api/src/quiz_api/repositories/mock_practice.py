"""Mock exam practice (MOCK-P) over `mock_exam_practice_sessions` / `mock_exam_attempts`
(20261102140000_mock_exams.sql, run link 20261102150000_mock_practice_runs.sql), and the
`source = mock` reads of practice runs (QVIEW-01-C02~C04).

Mock exam practice never reads or writes a `question_*` table, the Heatmap or a study state
(MOCK-01-C01, questions.md §11): a session pins the mock exam question's active revision and
its displayed option order, a submission appends a `mock_exam_attempts` row (append-only,
trigger) and moves the session on, a self-grade appends another attempt pointing at the pending
one. Every row is keyed by the caller's `user_id` (the verified JWT `sub`).

Mock runs: `practice_runs.item_ids` holds mock exam question ids of the generation the run started
on (`mock_exam_generation_id`). A position is available while its question has not been taken out
of the mock exam (`removed_at`) — a later 다시 만들기 or 삭제 of the mock exam does not change the
run (decision n, implementation-plan §7). Progress, items and results use that one condition, like
`eligible_question` for bank runs.

Timestamps come from the database clock. Writes that belong together are one statement.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.orm import Session

from quiz_api.authz.permissions import LockMode
from quiz_api.authz.repository import MembershipRecord, membership_record, membership_select
from quiz_api.practice_grading import AttemptResult, GradedResult
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.practice_runs import ResultRow, RunProgress, RunRecord
from quiz_api.repositories.tables import (
    mock_exam_practice_sessions,
    mock_exam_questions,
    workspaces,
)

# Characters of the stem fetched for a results preview (as for bank runs).
STEM_HEAD = 1000
# Its MCQ options are ordered per run or session, not by the copy (UX12-MOCKSHUFFLE-C03, C04).
OPTION_SHUFFLE = "OPTION_SHUFFLE"


@dataclass(frozen=True)
class MockRevision:
    id: uuid.UUID
    version: int
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    rubric: str | None
    stem_tables: list[Any] | None = None


@dataclass(frozen=True)
class MockQuestionTarget:
    """A mock exam question with its active revision and its mock exam's state."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    mock_exam_id: uuid.UUID
    generation_id: uuid.UUID
    question_type: QuestionType
    variation_type: str
    removed: bool
    exam_deleted: bool
    current_generation_id: uuid.UUID | None
    revision: MockRevision

    @property
    def shuffles_options(self) -> bool:
        return self.variation_type == OPTION_SHUFFLE

    @property
    def shown(self) -> bool:
        """Listed by its mock exam right now (the 풀기 / standalone practice set)."""
        return (
            not self.removed
            and not self.exam_deleted
            and self.generation_id == self.current_generation_id
        )


@dataclass(frozen=True)
class MockSessionRecord:
    """A mock practice session with the revision it pins."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    mock_exam_id: uuid.UUID
    mock_exam_question_id: uuid.UUID
    user_id: uuid.UUID
    question_type: QuestionType
    variation_type: str
    displayed_option_ids: list[str]
    state: str
    opened_at: datetime
    submitted_at: datetime | None
    graded_at: datetime | None
    revision: MockRevision
    practice_run_id: uuid.UUID | None
    run_position: int | None
    # The mock exam lists the session's question now (exam not deleted, shown generation, not
    # taken out): what a session outside a run needs to be submitted or self-graded.
    shown: bool = True
    retry_origin_valid: bool = False


@dataclass(frozen=True)
class OpenedMockSession:
    id: uuid.UUID
    state: str
    opened_at: datetime


@dataclass(frozen=True)
class SubmittedMockSession:
    attempt_id: uuid.UUID
    state: str
    submitted_at: datetime | None
    graded_at: datetime | None


@dataclass(frozen=True)
class MockAttemptRecord:
    id: uuid.UUID
    revision_id: uuid.UUID
    displayed_option_ids: list[str]
    submitted_answer: dict[str, Any]
    result: AttemptResult


@dataclass(frozen=True)
class MockExamRunSource:
    """The mock exam a run is started on (live, of the run's workspace)."""

    id: uuid.UUID
    current_generation_id: uuid.UUID | None


@dataclass(frozen=True)
class MockRunCandidate:
    """A question of the shown generation, in mock exam order."""

    id: uuid.UUID
    question_type: QuestionType


@dataclass(frozen=True)
class LiveMockQuestion:
    """A run position's mock exam question still in its mock exam (what an item shows)."""

    id: uuid.UUID
    question_type: QuestionType
    stem: str
    options: list[dict[str, str]]
    is_multi_answer: bool
    stem_tables: list[Any] | None = None
    shuffles_options: bool = False


def _revision(row: Any) -> MockRevision:
    return MockRevision(
        id=row.rev_id,
        version=int(row.rev_version),
        stem=row.rev_stem,
        options=list(row.rev_options or []),
        correct_option_ids=list(row.rev_correct_option_ids)
        if row.rev_correct_option_ids is not None
        else None,
        accepted_answers=list(row.rev_accepted_answers)
        if row.rev_accepted_answers is not None
        else None,
        is_multi_answer=bool(row.rev_is_multi_answer),
        explanation=row.rev_explanation,
        rubric=row.rev_rubric,
        stem_tables=row.rev_stem_tables,
    )


_TARGET = """
    select q.id, q.workspace_id, q.mock_exam_id, q.generation_id, q.question_type,
           q.variation_type, q.removed_at is not null as removed,
           e.deleted_at is not null as exam_deleted, e.current_generation_id,
           r.id as rev_id, r.version as rev_version, r.stem as rev_stem,
           r.options as rev_options, r.correct_option_ids as rev_correct_option_ids,
           r.accepted_answers as rev_accepted_answers, r.is_multi_answer as rev_is_multi_answer,
           r.explanation as rev_explanation, r.rubric as rev_rubric,
           r.stem_tables as rev_stem_tables
      from public.mock_exam_questions q
      join public.mock_exams e on e.id = q.mock_exam_id and e.workspace_id = q.workspace_id
      join public.mock_exam_question_revisions r
        on r.id = q.active_revision_id and r.mock_exam_question_id = q.id
     where q.id = :q
"""

_SESSION = """
    select s.id, s.workspace_id, q.mock_exam_id, s.mock_exam_question_id, s.user_id,
           q.question_type, q.variation_type, s.displayed_option_ids, s.state, s.opened_at,
           s.submitted_at, s.graded_at, s.practice_run_id, s.run_position,
           exists (select 1 from public.practice_runs origin
             where origin.id = s.retry_origin_run_id and origin.user_id = s.user_id
               and origin.workspace_id = s.workspace_id and origin.source = 'mock'
               and origin.mock_exam_id = q.mock_exam_id
               and origin.mock_exam_generation_id = q.generation_id
               and origin.item_ids[s.retry_origin_position] = q.id
               and q.removed_at is null and e.deleted_at is null) as retry_origin_valid,
           (q.removed_at is null and e.deleted_at is null
            and e.current_generation_id is not distinct from q.generation_id) as shown,
           r.id as rev_id, r.version as rev_version, r.stem as rev_stem,
           r.options as rev_options, r.correct_option_ids as rev_correct_option_ids,
           r.accepted_answers as rev_accepted_answers, r.is_multi_answer as rev_is_multi_answer,
           r.explanation as rev_explanation, r.rubric as rev_rubric,
           r.stem_tables as rev_stem_tables
      from public.mock_exam_practice_sessions s
      join public.mock_exam_questions q
        on q.id = s.mock_exam_question_id and q.workspace_id = s.workspace_id
      join public.mock_exams e on e.id = q.mock_exam_id and e.workspace_id = q.workspace_id
      join public.mock_exam_question_revisions r
        on r.id = s.mock_exam_question_revision_id and r.mock_exam_question_id = q.id
"""

_ATTEMPT = """
    select a.id, a.mock_exam_question_revision_id as revision_id, a.displayed_option_ids,
           a.submitted_answer, a.result
      from public.mock_exam_attempts a
"""

# The current result of a session: its newest attempt (a grade sorts after its pending one).
_LATEST_RESULT = """
    (select a.result from public.mock_exam_attempts a
      where a.practice_session_id = s.id
      order by a.submitted_at desc, a.id desc limit 1)
"""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _session(row: Any) -> MockSessionRecord:
    return MockSessionRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        mock_exam_id=row.mock_exam_id,
        mock_exam_question_id=row.mock_exam_question_id,
        user_id=row.user_id,
        question_type=cast(QuestionType, row.question_type),
        variation_type=row.variation_type,
        displayed_option_ids=list(row.displayed_option_ids or []),
        state=row.state,
        opened_at=row.opened_at,
        submitted_at=row.submitted_at,
        graded_at=row.graded_at,
        revision=_revision(row),
        practice_run_id=row.practice_run_id,
        run_position=row.run_position,
        shown=bool(row.shown),
        retry_origin_valid=bool(row.retry_origin_valid),
    )


def _attempt(row: Any) -> MockAttemptRecord:
    return MockAttemptRecord(
        id=row.id,
        revision_id=row.revision_id,
        displayed_option_ids=list(row.displayed_option_ids or []),
        submitted_answer=dict(row.submitted_answer),
        result=cast(AttemptResult, row.result),
    )


class MockPracticeRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- authorization lookups (one query each: resource + caller's membership) -----------------

    def question_membership(
        self, question_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        """The caller's membership in the workspace of a mock exam question that is still in its
        mock exam (not removed); `None` for unknown, removed and foreign questions alike."""
        stmt = (
            membership_select(user_id, lock)
            .join(mock_exam_questions, mock_exam_questions.c.workspace_id == workspaces.c.id)
            .where(
                mock_exam_questions.c.id == question_id,
                mock_exam_questions.c.removed_at.is_(None),
            )
        )
        return membership_record(self._session, stmt, user_id)

    def session_membership(
        self, session_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        """The caller's membership in the workspace of the caller's own mock session."""
        stmt = (
            membership_select(user_id, lock)
            .join(
                mock_exam_practice_sessions,
                mock_exam_practice_sessions.c.workspace_id == workspaces.c.id,
            )
            .where(
                mock_exam_practice_sessions.c.id == session_id,
                mock_exam_practice_sessions.c.user_id == user_id,
            )
        )
        return membership_record(self._session, stmt, user_id)

    # --- sessions --------------------------------------------------------------------------------

    def valid_retry_origin(
        self, run_id: uuid.UUID, position: int, user_id: uuid.UUID, question_id: uuid.UUID
    ) -> bool:
        return bool(
            self._session.execute(
                text(
                    "select exists (select 1 from public.practice_runs r "
                    "join public.mock_exam_questions q on q.id = :q "
                    "and q.workspace_id = r.workspace_id "
                    "join public.mock_exams e on e.id = q.mock_exam_id "
                    "and e.workspace_id = q.workspace_id "
                    "where r.id = :r and r.user_id = :u and r.source = 'mock' "
                    "and r.item_ids[:p] = q.id and r.mock_exam_id = q.mock_exam_id "
                    "and r.mock_exam_generation_id = q.generation_id "
                    "and q.removed_at is null and e.deleted_at is null)"
                ),
                {"q": question_id, "r": run_id, "u": user_id, "p": position},
            ).scalar_one()
        )

    def target(self, question_id: uuid.UUID) -> MockQuestionTarget | None:
        row = self._session.execute(text(_TARGET), {"q": question_id}).one_or_none()
        if row is None:
            return None
        return MockQuestionTarget(
            id=row.id,
            workspace_id=row.workspace_id,
            mock_exam_id=row.mock_exam_id,
            generation_id=row.generation_id,
            question_type=cast(QuestionType, row.question_type),
            variation_type=row.variation_type,
            removed=bool(row.removed),
            exam_deleted=bool(row.exam_deleted),
            current_generation_id=row.current_generation_id,
            revision=_revision(row),
        )

    def get_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> MockSessionRecord | None:
        """The caller's session whose question is still in its mock exam (`shown` says whether the
        mock exam lists it now); `lock` = FOR UPDATE of the session row (submit / self-grade)."""
        row = self._session.execute(
            text(
                _SESSION
                + " where s.id = :s and s.user_id = :u and q.removed_at is null"
                + (" for update of s" if lock else "")
            ),
            {"s": session_id, "u": user_id},
        ).one_or_none()
        return _session(row) if row is not None else None

    def run_session(
        self, run_id: uuid.UUID, position: int, user_id: uuid.UUID
    ) -> MockSessionRecord | None:
        """The caller's session of a run position (at most one), whatever its question's state."""
        row = self._session.execute(
            text(
                _SESSION + " where s.practice_run_id = :r and s.run_position = :p "
                "and s.user_id = :u"
            ),
            {"r": run_id, "p": position, "u": user_id},
        ).one_or_none()
        return _session(row) if row is not None else None

    def open_session(
        self,
        target: MockQuestionTarget,
        user_id: uuid.UUID,
        *,
        displayed_option_ids: list[str],
        shuffle_seed: int | None,
        practice_run_id: uuid.UUID | None = None,
        run_position: int | None = None,
        retry_origin_run_id: uuid.UUID | None = None,
        retry_origin_position: int | None = None,
    ) -> OpenedMockSession:
        row = self._session.execute(
            text(
                "insert into public.mock_exam_practice_sessions (workspace_id, "
                "mock_exam_question_id, mock_exam_question_revision_id, user_id, "
                "displayed_option_ids, shuffle_seed, state, practice_run_id, run_position, "
                "retry_origin_run_id, retry_origin_position) "
                "values (:w, :q, :r, :u, cast(:d as text[]), :seed, 'open', "
                ":run, :pos, :origin, :origin_pos) "
                "returning id, state, opened_at"
            ),
            {
                "w": target.workspace_id,
                "q": target.id,
                "r": target.revision.id,
                "u": user_id,
                "d": displayed_option_ids,
                "seed": shuffle_seed,
                "run": practice_run_id,
                "pos": run_position,
                "origin": retry_origin_run_id,
                "origin_pos": retry_origin_position,
            },
        ).one()
        return OpenedMockSession(row.id, row.state, row.opened_at)

    def submit(
        self,
        session: MockSessionRecord,
        *,
        submitted_answer: dict[str, Any],
        result: AttemptResult,
    ) -> SubmittedMockSession:
        """One statement: append the attempt and move the (locked, open) session to graded or
        pending_grade."""
        graded = result != "pending"
        row = self._session.execute(
            text(
                """
                with attempt as (
                  insert into public.mock_exam_attempts (workspace_id, mock_exam_question_id,
                    mock_exam_question_revision_id, practice_session_id, user_id,
                    displayed_option_ids, submitted_answer, result, grading_method, graded_at)
                  values (:w, :q, :r, :s, :u, cast(:d as text[]), cast(:answer as jsonb),
                          :result, case when :graded then 'auto' end,
                          case when :graded then now() end)
                  returning id
                ), finished as (
                  update public.mock_exam_practice_sessions
                     set state = case when :graded then 'graded' else 'pending_grade' end,
                         submitted_at = now(),
                         graded_at = case when :graded then now() end
                   where id = :s and state = 'open'
                  returning state, submitted_at, graded_at
                )
                select attempt.id, finished.state, finished.submitted_at, finished.graded_at
                  from attempt cross join finished
                """
            ),
            {
                "w": session.workspace_id,
                "q": session.mock_exam_question_id,
                "r": session.revision.id,
                "s": session.id,
                "u": session.user_id,
                "d": session.displayed_option_ids,
                "answer": _json(submitted_answer),
                "result": result,
                "graded": graded,
            },
        ).one()
        return SubmittedMockSession(row.id, row.state, row.submitted_at, row.graded_at)

    def pending_attempt(
        self, session_id: uuid.UUID, user_id: uuid.UUID
    ) -> MockAttemptRecord | None:
        row = self._session.execute(
            text(
                _ATTEMPT + " where a.practice_session_id = :s and a.user_id = :u "
                "and a.result = 'pending'"
            ),
            {"s": session_id, "u": user_id},
        ).one_or_none()
        return _attempt(row) if row is not None else None

    def latest_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> MockAttemptRecord | None:
        row = self._session.execute(
            text(
                _ATTEMPT + " where a.practice_session_id = :s and a.user_id = :u "
                "order by a.submitted_at desc, a.id desc limit 1"
            ),
            {"s": session_id, "u": user_id},
        ).one_or_none()
        return _attempt(row) if row is not None else None

    def add_grade(
        self,
        session: MockSessionRecord,
        pending: MockAttemptRecord,
        *,
        result: GradedResult,
        graded_by: uuid.UUID,
    ) -> uuid.UUID:
        """A self-grade: a new attempt settling `pending` (which never changes), and the session
        moves to graded — one statement."""
        attempt_id: uuid.UUID = self._session.execute(
            text(
                """
                with grade as (
                  insert into public.mock_exam_attempts (workspace_id, mock_exam_question_id,
                    mock_exam_question_revision_id, practice_session_id, user_id,
                    displayed_option_ids, submitted_answer, result, grading_method,
                    grades_attempt_id, graded_by, graded_at)
                  values (:w, :q, :r, :s, :u, cast(:d as text[]), cast(:answer as jsonb), :result,
                          'self', :pending, :by, now())
                  returning id
                ), graded as (
                  update public.mock_exam_practice_sessions
                     set state = 'graded', graded_at = now()
                   where id = :s and state = 'pending_grade'
                  returning id
                )
                select grade.id from grade left join graded on true
                """
            ),
            {
                "w": session.workspace_id,
                "q": session.mock_exam_question_id,
                "r": pending.revision_id,
                "s": session.id,
                "u": session.user_id,
                "d": pending.displayed_option_ids,
                "answer": _json(pending.submitted_answer),
                "result": result,
                "pending": pending.id,
                "by": graded_by,
            },
        ).scalar_one()
        return attempt_id

    # --- mock runs -------------------------------------------------------------------------------

    def run_source(
        self, mock_exam_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> MockExamRunSource | None:
        """The live mock exam of this workspace a run is started on (FOR SHARE: a concurrent
        다시 만들기 cannot switch the shown generation between the read and the run insert)."""
        row = self._session.execute(
            text(
                "select id, current_generation_id from public.mock_exams "
                "where id = :e and workspace_id = :w and deleted_at is null for share"
            ),
            {"e": mock_exam_id, "w": workspace_id},
        ).one_or_none()
        return MockExamRunSource(row.id, row.current_generation_id) if row is not None else None

    def run_candidates(self, generation_id: uuid.UUID) -> list[MockRunCandidate]:
        """The generation's questions still in the mock exam, in mock exam order."""
        rows = self._session.execute(
            text(
                "select id, question_type from public.mock_exam_questions "
                "where generation_id = :g and removed_at is null order by position"
            ),
            {"g": generation_id},
        )
        return [MockRunCandidate(r.id, cast(QuestionType, r.question_type)) for r in rows]

    def live_question(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID
    ) -> LiveMockQuestion | None:
        row = self._session.execute(
            text(
                "select q.id, q.question_type, q.variation_type, r.stem, r.options, "
                "r.is_multi_answer, r.stem_tables from public.mock_exam_questions q "
                "join public.mock_exam_question_revisions r "
                "on r.id = q.active_revision_id and r.mock_exam_question_id = q.id "
                "where q.id = :q and q.workspace_id = :w and q.removed_at is null"
            ),
            {"q": question_id, "w": workspace_id},
        ).one_or_none()
        if row is None:
            return None
        return LiveMockQuestion(
            id=row.id,
            question_type=cast(QuestionType, row.question_type),
            stem=row.stem,
            options=list(row.options or []),
            is_multi_answer=bool(row.is_multi_answer),
            stem_tables=row.stem_tables,
            shuffles_options=row.variation_type == OPTION_SHUFFLE,
        )

    def progress(self, run: RunRecord) -> RunProgress:
        """As `PracticeRunRepository.progress`: `reached` counts every opened position, the
        submissions only at positions still available."""
        row = self._session.execute(
            text(
                f"""
                with s as (
                  select s.run_position as position, s.state, {_LATEST_RESULT} as result,
                         q.id is not null as eligible
                    from public.mock_exam_practice_sessions s
                    left join public.mock_exam_questions q
                      on q.id = s.mock_exam_question_id and q.workspace_id = :w
                     and q.removed_at is null
                   where s.practice_run_id = :r
                ), m as (select coalesce(max(position), 0) as reached from s)
                select m.reached,
                       count(s.*) filter (where s.state <> 'open' and s.eligible) as submitted,
                       count(s.*) filter (where s.state <> 'open' and s.eligible
                                          and s.result = 'correct') as correct,
                       count(s.*) filter (where s.state <> 'open' and s.eligible
                                          and s.result = 'incorrect') as incorrect,
                       count(s.*) filter (where s.state = 'pending_grade' and s.eligible)
                         as pending,
                       count(s.*) filter (where s.state <> 'open' and s.eligible
                                          and s.position < m.reached) as submitted_before_reached
                  from m left join s on true
                 group by m.reached
                """  # noqa: S608 - constant SQL fragments only
            ),
            {"r": run.id, "w": run.workspace_id},
        ).one()
        return RunProgress(
            reached=int(row.reached),
            submitted=int(row.submitted),
            correct=int(row.correct),
            incorrect=int(row.incorrect),
            pending=int(row.pending),
            submitted_before_reached=int(row.submitted_before_reached),
        )

    def results(self, run: RunRecord, offset: int, limit: int) -> list[ResultRow]:
        """One page of positions offset+1 .. offset+limit (a slice of `item_ids`, never the whole
        array) with the question (if still in its mock exam) and the caller's result."""
        rows = self._session.execute(
            text(
                f"""
                with page as (
                  select (t.ord + cast(:offset as integer))::int as position, t.question_id
                    from public.practice_runs pr
                   cross join lateral
                         unnest(pr.item_ids[cast(:lo as integer) : cast(:hi as integer)])
                         with ordinality as t(question_id, ord)
                   where pr.id = :r
                )
                select page.position, page.question_id, q.id as live_id, q.question_type,
                       left(rev.stem, {STEM_HEAD}) as stem_head, res.state, res.result,
                       source.chapter_id, chapter.title as chapter_title, source.question_number
                  from page
                  left join public.mock_exam_questions q
                    on q.id = page.question_id and q.workspace_id = :w and q.removed_at is null
                  left join public.mock_exam_question_revisions rev
                    on rev.id = q.active_revision_id and rev.mock_exam_question_id = q.id
                  left join public.questions source
                    on source.id = q.source_question_id and source.workspace_id = q.workspace_id
                   and source.deleted_at is null
                  left join public.chapters chapter
                    on chapter.id = source.chapter_id and chapter.workspace_id = source.workspace_id
                  left join lateral (
                    select s.state, {_LATEST_RESULT} as result
                      from public.mock_exam_practice_sessions s
                     where s.practice_run_id = :r and s.run_position = page.position
                  ) res on q.id is not null
                 order by page.position
                """  # noqa: S608 - constant SQL fragments only
            ),
            {
                "r": run.id,
                "w": run.workspace_id,
                "offset": offset,
                "lo": offset + 1,
                "hi": offset + limit,
            },
        )
        out: list[ResultRow] = []
        for r in rows:
            available = r.live_id is not None
            out.append(
                ResultRow(
                    position=int(r.position),
                    question_id=r.question_id if available else None,
                    available=available,
                    question_type=cast("QuestionType | None", r.question_type),
                    chapter_id=r.chapter_id,
                    chapter_title=r.chapter_title,
                    question_number=r.question_number,
                    stem_head=r.stem_head,
                    state=r.state,
                    result=r.result,
                )
            )
        return out
