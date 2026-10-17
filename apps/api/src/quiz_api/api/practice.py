"""Practice API (M5.2, QPLAY-01; docs/questions.md §2/§4, architecture.md §6).

    POST  /questions/{id}/practice-sessions      member (viewer included); CONFIRMED questions;
                                                 201 PracticeSession; `Idempotency-Key` aware
    GET   /practice-sessions/{id}                the session's owner; resume (answers only once
                                                 submitted, in `outcome`)
    POST  /practice-sessions/{id}/submit         the session's owner; grade, 200 SubmitResult
    POST  /practice-sessions/{id}/self-grade     the session's owner; pending sessions only
    PATCH /questions/{id}/my-state               member; the caller's favorite / retry flags
    GET   /questions/{id}/attempts               member; the caller's own attempts, newest first

No answers before submission: `PracticeSession` (the open/resume shape) is a separate model with
no answer, explanation, rubric or accepted-answer field at all, so neither the JSON nor the
OpenAPI schema can carry one (apps/api/tests/test_practice_api_schema.py). Answers are revealed
only by `SubmitResult` (the submit response, and `outcome` of a submitted session).

Sessions: opening one pins the question's active revision and, for an MCQ, a displayed option
order drawn from a CSPRNG seed (both stored: `displayed_option_ids`, `shuffle_seed`). Opening is
the only study view: it writes `first_viewed_at`/`last_viewed_at` (reading the overview, the bank
or a question never does). Grading compares stable option ids of the pinned revision, never
positions, so an edit after opening does not change how the session is graded. A session is
submitted once (second submit → 409 `practice-session-submitted`, also for a concurrent double
submit: the session row is locked). Ungradable answers (essay, short answer without accepted
answers) are `pending` until the user's self-grade, which appends a new attempt pointing at the
pending one (`grades_attempt_id`); attempts are never changed.

Study state: a graded result (auto or self) sets `last_graded_result`; a pending one does not.
Grading never clears `needs_retry` (questions.md §2.1); only my-state does. A favorite/retry
change is recorded as an actor-private activity event (repositories/practice.py).

Authorization: practice is the caller's own write (`Action.PRACTICE`, every role, rejected in an
archived workspace with 403 `workspace-archived`, implementation-plan §7). Reads (GET session,
attempts) stay allowed when archived. Unknown, soft-deleted and foreign questions, and sessions
that are unknown or belong to someone else, all answer the same 404 body.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    Strict,
    TypeAdapter,
    ValidationError,
    field_validator,
)
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

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
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.practice_grading import (
    AttemptResult,
    grade_mcq,
    grade_short_answer,
    new_shuffle_seed,
    shuffled_option_ids,
)
from quiz_api.question_rules import MAX_LONG_TEXT, MAX_OPTIONS, Issues, QuestionType, storable
from quiz_api.question_status import (
    DotStatus,
    LastGradedResult,
    StudyState,
    derive_dot_status,
)
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.practice import (
    AttemptCursor,
    AttemptRecord,
    PracticeRepository,
    SessionRecord,
    StateRecord,
)
from quiz_api.repositories.questions import QuestionRepository

router = APIRouter(tags=["practice"], responses=problem_responses(503))

# The question routes' uniform 404 body (quiz_api.api.questions.NOT_FOUND).
NOT_FOUND = "Not found."
MAX_ANSWER_TEXT = MAX_LONG_TEXT
DEFAULT_ATTEMPTS_PAGE = 200
MAX_ATTEMPTS_PAGE = 500
MAX_CURSOR = 200

SessionState = Literal["open", "pending_grade", "graded"]
GradingMethod = Literal["auto", "self", "reviewer"]


# --- schemas ------------------------------------------------------------------------------------


class PracticeOption(BaseModel):
    id: str = Field(description="Stable option id; submit it, never a position.")
    text: str


class PracticeSession(BaseModel):
    """What the practice panel needs to show a question. Never carries answers, explanations,
    rubrics or accepted answers (a new field here is a reviewed change)."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    question_id: uuid.UUID
    question_revision_id: uuid.UUID = Field(description="The revision this session is graded on.")
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    question_number: int | None
    stem: str
    is_multi_answer: bool
    options: list[PracticeOption] = Field(description="MCQ options in displayed order.")
    displayed_option_ids: list[str] = Field(description="The displayed order (MCQ), as ids.")
    state: SessionState
    opened_at: datetime


class PracticeSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SubmitBody(BaseModel):
    """`selected_option_ids` for an MCQ (one id unless multi-answer), `answer_text` otherwise."""

    model_config = ConfigDict(extra="forbid")

    selected_option_ids: list[str] | None = Field(default=None, max_length=MAX_OPTIONS)
    answer_text: str | None = Field(default=None, max_length=MAX_ANSWER_TEXT)


class SubmitResult(BaseModel):
    """The graded (or pending) submission with the pinned revision's answers revealed."""

    attempt_id: uuid.UUID = Field(description="The attempt that holds the current result.")
    practice_session_id: uuid.UUID
    question_revision_id: uuid.UUID
    state: SessionState
    result: AttemptResult
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    rubric: str | None


class PracticeSessionDetail(PracticeSession):
    submitted_at: datetime | None
    graded_at: datetime | None
    outcome: SubmitResult | None = Field(
        description="null while the session is open (no answers before submission)."
    )


class SelfGradeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result: Literal["correct", "incorrect"]


class SelfGradeResult(BaseModel):
    attempt_id: uuid.UUID
    practice_session_id: uuid.UUID
    result: Literal["correct", "incorrect"]
    grades_attempt_id: uuid.UUID = Field(description="The pending attempt this grade settles.")


_Flag = Annotated[bool | None, Strict()]


class MyStateUpdate(BaseModel):
    """Omitted flags are kept; at least one is required."""

    model_config = ConfigDict(extra="forbid")

    is_favorite: _Flag = None
    needs_retry: _Flag = Field(
        default=None, description="Never cleared by a correct answer; only by the user."
    )

    @field_validator("is_favorite", "needs_retry", mode="before")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("may be omitted but not null")
        return value


class MyState(BaseModel):
    question_id: uuid.UUID
    status: DotStatus
    is_favorite: bool
    needs_retry: bool
    last_graded_result: LastGradedResult | None


class SubmittedAnswer(BaseModel):
    selected_option_ids: list[str] | None = None
    answer_text: str | None = None


class Attempt(BaseModel):
    id: uuid.UUID
    question_revision_id: uuid.UUID = Field(description="Graded against this revision.")
    revision_version: int
    practice_session_id: uuid.UUID
    displayed_option_ids: list[str] = Field(description="The order the options were shown in.")
    submitted_answer: SubmittedAnswer
    result: AttemptResult
    grading_method: GradingMethod | None = Field(description="null while pending.")
    grades_attempt_id: uuid.UUID | None = Field(
        description="For a self/reviewer grade: the pending attempt it settles."
    )
    submitted_at: datetime
    graded_at: datetime | None


class AttemptList(BaseModel):
    items: list[Attempt]
    next_cursor: str | None = Field(description="Pass as `cursor` for older attempts.")


# --- dependencies -------------------------------------------------------------------------------


def get_practice_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> PracticeRepository:
    return PracticeRepository(session)


def get_question_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionRepository:
    return QuestionRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


PracticeRepo = Annotated[PracticeRepository, Depends(get_practice_repository)]
QuestionRepo = Annotated[QuestionRepository, Depends(get_question_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _question(action: Action) -> Any:
    def dependency(
        question_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        try:
            return authorize_resource(repo, user.id, ResourceType.QUESTION, question_id, action)
        except HTTPException as exc:
            raise (_not_found() if exc.status_code == 404 else exc) from None

    return Depends(dependency)


PracticeQuestion = Annotated[ResourceAccess, _question(Action.PRACTICE)]
ReadQuestion = Annotated[ResourceAccess, _question(Action.READ)]


def _own_session(
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    access_repo: AccessRepository,
    practice: PracticeRepository,
    action: Action,
) -> tuple[WorkspaceAccess, SessionRecord]:
    """The caller's session, authorized for `action` in its workspace. Ownership is checked
    before membership, so a foreign session is indistinguishable from an unknown id (404, same
    body) whatever the caller's role or the workspace's state. Writes lock the session row."""
    workspace_id = practice.session_owner_workspace(session_id, user_id)
    if workspace_id is None:
        raise _not_found()
    access = authorize_workspace(
        access_repo, user_id, workspace_id, action, not_found_detail=NOT_FOUND
    )
    found = practice.get_session(session_id, user_id, lock=action is Action.PRACTICE)
    if found is None:  # the question was soft-deleted
        raise _not_found()
    return access, found


# --- helpers ------------------------------------------------------------------------------------


def _session_out(s: SessionRecord) -> PracticeSession:
    texts = {o["id"]: o["text"] for o in s.revision.options}
    return PracticeSession(
        id=s.id,
        workspace_id=s.workspace_id,
        question_id=s.question_id,
        question_revision_id=s.revision.id,
        question_type=s.question_type,
        chapter_id=s.chapter_id,
        question_number=s.question_number,
        stem=s.revision.stem,
        is_multi_answer=s.revision.is_multi_answer,
        options=[PracticeOption(id=oid, text=texts[oid]) for oid in s.displayed_option_ids],
        displayed_option_ids=s.displayed_option_ids,
        state=s.state,  # type: ignore[arg-type]
        opened_at=s.opened_at,
    )


def _result_out(s: SessionRecord, attempt_id: uuid.UUID, result: AttemptResult) -> SubmitResult:
    rev = s.revision
    return SubmitResult(
        attempt_id=attempt_id,
        practice_session_id=s.id,
        question_revision_id=rev.id,
        state=s.state,  # type: ignore[arg-type]
        result=result,
        correct_option_ids=rev.correct_option_ids,
        accepted_answers=rev.accepted_answers,
        explanation=rev.explanation,
        rubric=rev.rubric,
    )


def _attempt_out(a: AttemptRecord) -> Attempt:
    return Attempt(
        id=a.id,
        question_revision_id=a.question_revision_id,
        revision_version=a.revision_version,
        practice_session_id=a.practice_session_id,
        displayed_option_ids=a.displayed_option_ids,
        submitted_answer=SubmittedAnswer.model_validate(a.submitted_answer),
        result=a.result,
        grading_method=a.grading_method,  # type: ignore[arg-type]
        grades_attempt_id=a.grades_attempt_id,
        submitted_at=a.submitted_at,
        graded_at=a.graded_at,
    )


def _my_state(question_id: uuid.UUID, s: StateRecord) -> MyState:
    study = StudyState(
        first_viewed_at=s.first_viewed_at,
        last_graded_result=s.last_graded_result,
        needs_retry=s.needs_retry,
        is_favorite=s.is_favorite,
    )
    return MyState(
        question_id=question_id,
        status=derive_dot_status(study),
        is_favorite=s.is_favorite,
        needs_retry=s.needs_retry,
        last_graded_result=s.last_graded_result,
    )


def _unstorable() -> RequestValidationError:
    return RequestValidationError(
        [
            {
                "loc": ("body",),
                "msg": "The request contains data that cannot be stored.",
                "type": "value_error",
            }
        ]
    )


def _answer(session: SessionRecord, body: SubmitBody) -> tuple[dict[str, Any], AttemptResult]:
    """Validate the submission against the pinned revision; returns (stored answer, result).
    Messages never mention which option is correct."""
    issues = Issues()
    rev = session.revision
    if session.question_type == "MCQ":
        ids = body.selected_option_ids
        if body.answer_text is not None:
            issues.add(("answer_text",), "A multiple-choice question takes selected_option_ids.")
        if not ids:
            issues.add(("selected_option_ids",), "Select at least one option.", "missing")
        else:
            known = {o["id"] for o in rev.options}
            for i, oid in enumerate(ids):
                if oid not in known:
                    issues.add(("selected_option_ids", i), "Not an option of this question.")
            if len(set(ids)) != len(ids):
                issues.add(("selected_option_ids",), "Option ids must be distinct.")
            if not rev.is_multi_answer and len(ids) > 1:
                issues.add(("selected_option_ids",), "Select exactly one option.")
        issues.raise_if_any()
        assert ids is not None  # noqa: S101 - checked above
        return {"selected_option_ids": ids}, grade_mcq(ids, rev.correct_option_ids)

    text = body.answer_text
    if body.selected_option_ids is not None:
        issues.add(("selected_option_ids",), "This question takes answer_text.")
    if text is None or not text.strip():
        issues.add(("answer_text",), "Write an answer.", "missing")
    elif not storable(text):
        issues.add(("answer_text",), "Text must not contain NUL characters or invalid code points.")
    issues.raise_if_any()
    assert text is not None  # noqa: S101 - checked above
    if session.question_type == "SHORT_ANSWER":
        return {"answer_text": text}, grade_short_answer(text, rev.accepted_answers)
    return {"answer_text": text}, "pending"


def _encode_cursor(cursor: AttemptCursor) -> str:
    raw = json.dumps([cursor.submitted_at.isoformat(), str(cursor.id)], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


_CURSOR = TypeAdapter(tuple[AwareDatetime, uuid.UUID])


def _decode_cursor(value: str) -> AttemptCursor:
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii") + b"=" * (-len(value) % 4))
        submitted_at, attempt_id = _CURSOR.validate_json(raw)
    except (binascii.Error, UnicodeError, ValueError, ValidationError):
        raise RequestValidationError(
            [{"loc": ("query", "cursor"), "msg": "Invalid cursor.", "type": "value_error"}]
        ) from None
    return AttemptCursor(submitted_at, attempt_id)


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/questions/{question_id}/practice-sessions",
    status_code=status.HTTP_201_CREATED,
    response_model=PracticeSession,
    operation_id="startPracticeSession",
    responses=problem_responses(409),
)
def start_practice_session(
    access: PracticeQuestion,
    practice: PracticeRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    user: CurrentUser,
    body: PracticeSessionCreate | None = None,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Open the practice panel on a CONFIRMED question: pins its active revision, shuffles MCQ
    options, records the caller's view. No answers in the response."""
    scope = f"POST /questions/{access.resource_id}/practice-sessions"
    body_hash = request_hash((body or PracticeSessionCreate()).model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user.id, scope, idempotency_key)
        stored = idempotency.find(user.id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)

    question = questions.get(access.resource_id)
    if question is None:  # soft-deleted after the authorization lookup
        raise _not_found()
    if question.publication_status != "CONFIRMED":
        raise ProblemException(
            409,
            ProblemType.QUESTION_NOT_CONFIRMED,
            detail="Only confirmed questions can be practised.",
        )
    seed: int | None = None
    displayed: list[str] = []
    if question.question_type == "MCQ":
        seed = new_shuffle_seed()
        displayed = shuffled_option_ids([o["id"] for o in question.revision.options], seed)

    session_id = practice.open_session(
        workspace_id=question.workspace_id,
        question_id=question.id,
        revision_id=question.revision.id,
        user_id=user.id,
        displayed_option_ids=displayed,
        shuffle_seed=seed,
    )
    practice.record_view(question.workspace_id, question.id, user.id)
    opened = practice.get_session(session_id, user.id)
    assert opened is not None  # noqa: S101 - inserted above in this transaction
    result = _session_out(opened)
    if idempotency_key is not None:
        idempotency.save(
            user.id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_201_CREATED,
            result.model_dump(mode="json"),
        )
    practice.commit()
    return result


@router.get("/practice-sessions/{session_id}", operation_id="getPracticeSession")
def get_practice_session(
    session_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    access_repo: AccessRepo,
    practice: PracticeRepo,
) -> PracticeSessionDetail:
    """Resume one of the caller's sessions. `outcome` (with answers) only once submitted."""
    _, found = _own_session(session_id, user.id, access_repo, practice, Action.READ)
    outcome: SubmitResult | None = None
    if found.state != "open":
        latest = practice.latest_attempt(found.id, user.id)
        if latest is not None:
            outcome = _result_out(found, latest.id, latest.result)
    return PracticeSessionDetail(
        **_session_out(found).model_dump(),
        submitted_at=found.submitted_at,
        graded_at=found.graded_at,
        outcome=outcome,
    )


@router.post(
    "/practice-sessions/{session_id}/submit",
    operation_id="submitPracticeSession",
    responses=problem_responses(409),
)
def submit_practice_session(
    session_id: Annotated[uuid.UUID, Path()],
    body: SubmitBody,
    user: CurrentUser,
    access_repo: AccessRepo,
    practice: PracticeRepo,
) -> SubmitResult:
    """Grade the answer on the server against the session's revision (option ids, never
    positions); append the attempt; reveal answers and explanation. Once per session."""
    access, found = _own_session(session_id, user.id, access_repo, practice, Action.PRACTICE)
    if found.state != "open":
        raise ProblemException(
            409,
            ProblemType.PRACTICE_SESSION_SUBMITTED,
            detail="This practice session was already submitted. Start a new one to retry.",
        )
    answer, result = _answer(found, body)
    try:
        attempt_id = practice.add_attempt(found, submitted_answer=answer, result=result)
        practice.finish_session(found.id, graded=result != "pending")
        if result != "pending":
            practice.record_graded(
                access.workspace_id, found.question_id, user.id, attempt_id, result
            )
        updated = practice.get_session(found.id, user.id)
        assert updated is not None  # noqa: S101 - locked above in this transaction
        out = _result_out(updated, attempt_id, result)
        practice.commit()
    except (IntegrityError, DataError):
        practice.rollback()
        raise _unstorable() from None
    return out


@router.post(
    "/practice-sessions/{session_id}/self-grade",
    operation_id="selfGradePracticeSession",
    responses=problem_responses(409),
)
def self_grade_practice_session(
    session_id: Annotated[uuid.UUID, Path()],
    body: SelfGradeBody,
    user: CurrentUser,
    access_repo: AccessRepo,
    practice: PracticeRepo,
) -> SelfGradeResult:
    """The user's own grade of a pending (essay / ungradable short answer) submission. Appends
    a grade attempt referencing the pending one; the session becomes graded. Once."""
    access, found = _own_session(session_id, user.id, access_repo, practice, Action.PRACTICE)
    pending = (
        practice.pending_attempt(found.id, user.id) if found.state == "pending_grade" else None
    )
    if pending is None:
        raise ProblemException(
            409,
            ProblemType.PRACTICE_SESSION_NOT_PENDING,
            detail="Only a submitted answer that awaits grading can be self-graded.",
        )
    attempt_id = practice.add_grade(
        found, pending, result=body.result, method="self", graded_by=user.id
    )
    practice.grade_session(found.id)
    practice.record_graded(access.workspace_id, found.question_id, user.id, attempt_id, body.result)
    practice.commit()
    return SelfGradeResult(
        attempt_id=attempt_id,
        practice_session_id=found.id,
        result=body.result,
        grades_attempt_id=pending.id,
    )


@router.patch("/questions/{question_id}/my-state", operation_id="updateMyQuestionState")
def update_my_state(
    access: PracticeQuestion, body: MyStateUpdate, practice: PracticeRepo
) -> MyState:
    """Toggle the caller's favorite / retry flags (independent of each other and of results)."""
    flags = {
        k: v
        for k, v in body.model_dump(include={"is_favorite", "needs_retry"}).items()
        if k in body.model_fields_set
    }
    if not flags:
        raise RequestValidationError(
            [{"loc": ("body",), "msg": "Give is_favorite and/or needs_retry.", "type": "missing"}]
        )
    ws = access.workspace
    before = practice.lock_state(ws.workspace_id, access.resource_id, ws.user_id)
    changed = {k: v for k, v in flags.items() if getattr(before, k) != v}
    if changed:
        practice.set_flags(ws.workspace_id, access.resource_id, ws.user_id, changed)
        practice.record_activity(
            ws.workspace_id, ws.user_id, access.resource_id, {"changed": changed}
        )
    after = practice.get_state(access.resource_id, ws.user_id)
    practice.commit()
    return _my_state(access.resource_id, after)


@router.get("/questions/{question_id}/attempts", operation_id="listMyQuestionAttempts")
def list_my_attempts(
    access: ReadQuestion,
    practice: PracticeRepo,
    limit: Annotated[int, Query(ge=1, le=MAX_ATTEMPTS_PAGE)] = DEFAULT_ATTEMPTS_PAGE,
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR)] = None,
) -> AttemptList:
    """The caller's own attempts on the question, newest first, each pinned to the revision it
    was graded on (its content: GET /questions/{id}/revisions/{revision_id})."""
    after = _decode_cursor(cursor) if cursor else None
    items, next_cursor = practice.attempts(
        access.resource_id, access.workspace.user_id, limit=limit, after=after
    )
    return AttemptList(
        items=[_attempt_out(a) for a in items],
        next_cursor=_encode_cursor(next_cursor) if next_cursor else None,
    )
