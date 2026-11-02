"""Mock exam practice API (MOCK-P; docs/screens/mock-exams.md MOCK-01-C01/C04/C08,
docs/screens/question-viewer.md QVIEW-01-C03/C04, docs/questions.md §11).

    POST /mock-exam-questions/{id}/practice-sessions   member (viewer included); 201
                                                       MockPracticeSession; `Idempotency-Key`
    POST /mock-practice-sessions/{id}/submit           the session's owner; grade, 200
    POST /mock-practice-sessions/{id}/self-grade       the session's owner; pending only

The same flow as bank practice (quiz_api.api.practice) on a mock exam question: opening pins the
question's active revision and a CSPRNG-seeded displayed option order; the open shape has no
answer, explanation, rubric or accepted-answer field at all (MockPracticeSession, an allowlist);
submit grades on the server by stable option ids (`grade_submission`, `practice_grading`) and is
the only response that reveals the answers; a session is submitted once; an ungradable answer is
`pending` until the user's self-grade, which appends a new attempt. Attempts are append-only.

Records go only to `mock_exam_practice_sessions` / `mock_exam_attempts`: no `question_*` row, no
study state, no Heatmap change, no view record (MOCK-01-C01, QVIEW-01-C04).

Which questions can be opened:
  * without a run: a question the mock exam lists now (its shown generation, not taken out, the
    mock exam not deleted);
  * with `{practice_run_id, run_position}`: the caller's `source = mock` run of this workspace
    must hold this question at that position, and the question must not have been taken out of
    the mock exam. A 다시 만들기 or 삭제 after the run started does not matter: the run keeps the
    questions it started with (decision n). One session per position: the position's open session
    is resumed, a submitted one is 409 `already-submitted`; a finished run takes no new session
    or submission (409 `practice-run-finished`).

Authorization: practising is the caller's own write (`Action.PRACTICE`, every role; an archived
workspace answers 403 `workspace-archived`). Unknown, taken-out and foreign questions, questions
the mock exam no longer lists, and sessions that are unknown or another user's all answer the
same 404. Share-session guests have no user JWT (401).
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.practice import (
    PracticeOption,
    PracticeSessionCreate,
    SelfGradeBody,
    SelfGradeResult,
    SubmitBody,
    grade_submission,
    unstorable,
)
from quiz_api.api.practice_runs import already_submitted, run_finished, wrong_position
from quiz_api.auth import CurrentUser
from quiz_api.authz import Action, WorkspaceAccess, decide
from quiz_api.authz.permissions import policy_for
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.practice_grading import AttemptResult, new_shuffle_seed, shuffled_option_ids
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.mock_practice import MockPracticeRepository, MockSessionRecord
from quiz_api.repositories.practice_runs import PracticeRunRepository

router = APIRouter(tags=["mock-exams"], responses=problem_responses(503))

NOT_FOUND = "Not found."

SessionState = Literal["open", "pending_grade", "graded"]


# --- schemas ------------------------------------------------------------------------------------


class MockPracticeSession(BaseModel):
    """What a viewer needs to show a mock exam question. Never carries answers, explanations,
    rubrics or accepted answers (a new field here is a reviewed change)."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    mock_exam_id: uuid.UUID
    mock_exam_question_id: uuid.UUID
    revision_id: uuid.UUID = Field(description="The mock exam question revision graded on.")
    question_type: QuestionType
    stem: str
    is_multi_answer: bool
    options: list[PracticeOption] = Field(description="MCQ options in displayed order.")
    displayed_option_ids: list[str] = Field(description="The displayed order (MCQ), as ids.")
    state: SessionState
    opened_at: datetime
    practice_run_id: uuid.UUID | None = Field(
        default=None, description="The practice run this session practises a position of."
    )
    run_position: int | None = Field(default=None, description="That run position (1-based).")


class MockSubmitResult(BaseModel):
    """The graded (or pending) submission with the pinned revision's answers revealed."""

    attempt_id: uuid.UUID = Field(description="The attempt that holds the current result.")
    practice_session_id: uuid.UUID
    mock_exam_question_id: uuid.UUID
    revision_id: uuid.UUID
    state: SessionState
    result: AttemptResult
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    rubric: str | None


# --- dependencies -------------------------------------------------------------------------------


def get_mock_practice_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> MockPracticeRepository:
    return MockPracticeRepository(session)


def get_run_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> PracticeRunRepository:
    return PracticeRunRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


MockRepo = Annotated[MockPracticeRepository, Depends(get_mock_practice_repository)]
RunRepo = Annotated[PracticeRunRepository, Depends(get_run_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _practise_question(
    mock_exam_question_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: MockRepo
) -> WorkspaceAccess:
    record = repo.question_membership(
        mock_exam_question_id, user.id, policy_for(Action.PRACTICE).lock
    )
    return decide(record, Action.PRACTICE, not_found_detail=NOT_FOUND)


PractiseQuestion = Annotated[WorkspaceAccess, Depends(_practise_question)]


def _own_session(
    session_id: uuid.UUID, user_id: uuid.UUID, repo: MockPracticeRepository
) -> tuple[WorkspaceAccess, MockSessionRecord]:
    """The caller's session, authorized for practice in its workspace (ownership and membership
    in one query, so a foreign session is an unknown one), its row locked."""
    record = repo.session_membership(session_id, user_id, policy_for(Action.PRACTICE).lock)
    access = decide(record, Action.PRACTICE, not_found_detail=NOT_FOUND)
    found = repo.get_session(session_id, user_id, lock=True)
    if found is None:  # the question was taken out of its mock exam
        raise _not_found()
    return access, found


# --- helpers ------------------------------------------------------------------------------------


def session_out(s: MockSessionRecord) -> MockPracticeSession:
    texts = {o["id"]: o["text"] for o in s.revision.options}
    return MockPracticeSession(
        id=s.id,
        workspace_id=s.workspace_id,
        mock_exam_id=s.mock_exam_id,
        mock_exam_question_id=s.mock_exam_question_id,
        revision_id=s.revision.id,
        question_type=s.question_type,
        stem=s.revision.stem,
        is_multi_answer=s.revision.is_multi_answer,
        options=[PracticeOption(id=oid, text=texts[oid]) for oid in s.displayed_option_ids],
        displayed_option_ids=s.displayed_option_ids,
        state=s.state,  # type: ignore[arg-type]
        opened_at=s.opened_at,
        practice_run_id=s.practice_run_id,
        run_position=s.run_position,
    )


def result_out(
    s: MockSessionRecord, attempt_id: uuid.UUID, result: AttemptResult
) -> MockSubmitResult:
    rev = s.revision
    return MockSubmitResult(
        attempt_id=attempt_id,
        practice_session_id=s.id,
        mock_exam_question_id=s.mock_exam_question_id,
        revision_id=rev.id,
        state=s.state,  # type: ignore[arg-type]
        result=result,
        correct_option_ids=rev.correct_option_ids,
        accepted_answers=rev.accepted_answers,
        explanation=rev.explanation,
        rubric=rev.rubric,
    )


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/mock-exam-questions/{mock_exam_question_id}/practice-sessions",
    status_code=status.HTTP_201_CREATED,
    response_model=MockPracticeSession,
    operation_id="startMockPracticeSession",
    responses=problem_responses(409),
)
def start_mock_practice_session(
    mock_exam_question_id: Annotated[uuid.UUID, Path()],
    access: PractiseQuestion,
    repo: MockRepo,
    runs: RunRepo,
    idempotency: IdempotencyStoreDep,
    user: CurrentUser,
    body: PracticeSessionCreate | None = None,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Open a mock exam question: pins its active revision and shuffles MCQ options. No answers
    in the response, nothing recorded outside the mock exam tables. With a run position the
    caller's mock run of this workspace must hold this question there; the position's open
    session is resumed, a submitted one is 409 `already-submitted`."""
    body = body or PracticeSessionCreate()
    scope = f"POST /mock-exam-questions/{mock_exam_question_id}/practice-sessions"
    body_hash = request_hash(body.model_dump(mode="json", exclude_none=True))
    if idempotency_key is not None:
        idempotency.lock(user.id, scope, idempotency_key)
        stored = idempotency.find(user.id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)

    target = repo.target(mock_exam_question_id)
    if target is None or target.removed or target.workspace_id != access.workspace_id:
        raise _not_found()
    run_id, position = body.practice_run_id, body.run_position
    if run_id is not None and position is not None:
        run = runs.get_in_workspace(run_id, user.id, access.workspace_id)
        if run is None:
            raise _not_found()
        if run.finished_at is not None:
            raise run_finished()
        if (
            run.source != "mock"
            or position > run.total
            or runs.question_at(run.id, position) != target.id
        ):
            raise wrong_position()
        existing = repo.run_session(run.id, position, user.id)
        if existing is not None:
            if existing.state != "open":
                raise already_submitted()
            resumed = session_out(existing)
            if idempotency_key is not None:
                idempotency.save(
                    user.id,
                    scope,
                    idempotency_key,
                    body_hash,
                    status.HTTP_201_CREATED,
                    resumed.model_dump(mode="json"),
                )
            repo.commit()
            return resumed
    elif not target.shown:
        # Outside a run only what the mock exam lists now can be practised.
        raise _not_found()

    seed: int | None = None
    displayed: list[str] = []
    if target.question_type == "MCQ":
        seed = new_shuffle_seed()
        displayed = shuffled_option_ids([o["id"] for o in target.revision.options], seed)
    opened = repo.open_session(
        target,
        user.id,
        displayed_option_ids=displayed,
        shuffle_seed=seed,
        practice_run_id=run_id,
        run_position=position,
    )
    result = session_out(
        MockSessionRecord(
            id=opened.id,
            workspace_id=target.workspace_id,
            mock_exam_id=target.mock_exam_id,
            mock_exam_question_id=target.id,
            user_id=user.id,
            question_type=target.question_type,
            variation_type=target.variation_type,
            displayed_option_ids=displayed,
            state=opened.state,
            opened_at=opened.opened_at,
            submitted_at=None,
            graded_at=None,
            revision=target.revision,
            practice_run_id=run_id,
            run_position=position,
        )
    )
    if idempotency_key is not None:
        idempotency.save(
            user.id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_201_CREATED,
            result.model_dump(mode="json"),
        )
    repo.commit()
    return result


@router.post(
    "/mock-practice-sessions/{mock_practice_session_id}/submit",
    operation_id="submitMockPracticeSession",
    responses=problem_responses(409),
)
def submit_mock_practice_session(
    mock_practice_session_id: Annotated[uuid.UUID, Path()],
    body: SubmitBody,
    user: CurrentUser,
    repo: MockRepo,
    runs: RunRepo,
) -> MockSubmitResult:
    """Grade the answer on the server against the session's revision (option ids, never
    positions); append the attempt; reveal answers and explanation. Once per session — for a run
    position once per position (409 `already-submitted`), and not after the run finished."""
    _, found = _own_session(mock_practice_session_id, user.id, repo)
    if found.practice_run_id is not None:
        if found.state != "open":
            raise already_submitted()
        run = runs.get(found.practice_run_id, user.id, lock=True)
        if run is None or run.finished_at is not None:
            raise run_finished()
    if found.state != "open":
        raise ProblemException(
            409,
            ProblemType.PRACTICE_SESSION_SUBMITTED,
            detail="This practice session was already submitted. Start a new one to retry.",
        )
    answer, result = grade_submission(found.question_type, found.revision, body)
    try:
        submitted = repo.submit(found, submitted_answer=answer, result=result)
        updated = replace(
            found,
            state=submitted.state,
            submitted_at=submitted.submitted_at,
            graded_at=submitted.graded_at,
        )
        out = result_out(updated, submitted.attempt_id, result)
        repo.commit()
    except (IntegrityError, DataError):
        repo.rollback()
        raise unstorable() from None
    return out


@router.post(
    "/mock-practice-sessions/{mock_practice_session_id}/self-grade",
    operation_id="selfGradeMockPracticeSession",
    responses=problem_responses(409),
)
def self_grade_mock_practice_session(
    mock_practice_session_id: Annotated[uuid.UUID, Path()],
    body: SelfGradeBody,
    user: CurrentUser,
    repo: MockRepo,
) -> SelfGradeResult:
    """The user's own grade of a pending (essay / ungradable short answer) submission: appends a
    grade attempt referencing the pending one; the session becomes graded. Once."""
    _, found = _own_session(mock_practice_session_id, user.id, repo)
    pending = repo.pending_attempt(found.id, user.id) if found.state == "pending_grade" else None
    if pending is None:
        raise ProblemException(
            409,
            ProblemType.PRACTICE_SESSION_NOT_PENDING,
            detail="Only a submitted answer that awaits grading can be self-graded.",
        )
    attempt_id = repo.add_grade(found, pending, result=body.result, graded_by=user.id)
    repo.commit()
    return SelfGradeResult(
        attempt_id=attempt_id,
        practice_session_id=found.id,
        result=body.result,
        grades_attempt_id=pending.id,
    )
