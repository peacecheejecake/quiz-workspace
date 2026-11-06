"""Range practice runs API (QVIEW-B; docs/screens/question-viewer.md QVIEW-01-C01~C05/C07,
docs/questions.md §12, architecture.md §6).

    POST /workspaces/{id}/practice-runs             member (viewer included; archived workspace
                                                    included); resolve a range into a fixed run;
                                                    201 PracticeRun; `Idempotency-Key` aware
    GET  /practice-runs/{id}                        the run's creator; counts, progress, summary
    GET  /practice-runs/{id}/items/{position}       the run's creator; one position (1-based)
    GET  /practice-runs/{id}/results?offset&limit   the run's creator; one page (limit <= 200)
    POST /practice-runs/{id}/finish                 the run's creator; fix the summary
    GET  /workspaces/{id}/practice-runs/unfinished  member; the caller's own unfinished bank runs
                                                    (UX12-RESUME); no content, at most 20
    POST /practice-runs/{id}/dismiss                the run's creator (bank); out of that list only

A position is practised through the practice API (quiz_api.api.practice): POST
/questions/{id}/practice-sessions with `{practice_run_id, run_position}`, then the usual submit /
self-grade. One session per position, so one submission per position (409 `already-submitted`).

Range and order (C01/C02): `quiz_api.question_ranges` resolves the range on the server into the
workspace's live CONFIRMED questions in Heatmap order (filters on the caller's merged study
state). More than 5,000 → 422 `practice-run-too-large`; none → 409 `no-matching-questions`; ids
that are not live CONFIRMED questions of this workspace → 422 `range-invalid`. With
`random_order` the order is `random.Random(seed).shuffle` of the Heatmap order. The seed is the
request's, else chosen by the server (a CSPRNG; under APP_ENV=test the fixed PRACTICE_RUN_TEST_SEED,
QVIEW-01-AC03 "fake seed 고정") and stored; a run's ids and seed never change. Body fields other
than the documented ones (e.g. a client `workspace_id`/`user_id`) are ignored: the workspace is
the path's, the user the verified JWT's.

Option shuffle (UX12-CHAPTERRUN-C03): `shuffle_options` is a bank run's setting, kept in the
`practice_runs.range` jsonb (`run_range`; no key means off, as on every older run). A position of
such a run shows `shuffled_option_ids` under `run_option_seed(seed, position)` whether or not its
session is open yet, the session stores that order and grading stays on option ids. A retry of a
position draws a new shuffle. A mock run has its own question copies and refuses the field (422).

No answers (C03): `PracticeRun` and `RunResults` carry no question content and no answers.
`RunItem` carries the question without answers; the answers of a position appear only in its
`attempt`, which exists only once that position was submitted.

Authorization (C05): runs are personal. Every run route looks the run up by (id, caller) together
with the caller's membership: another user's run, an unknown id, a non-member and a deleted
workspace all answer the same 404. Creating, reading and finishing are allowed in an archived
workspace (personal, no workspace content changes); practising is not (403 `workspace-archived`
from the practice API). Share-session guests have no user JWT (401).

Mock exam runs (MOCK-P, `source=mock` + `mock_exam_id`): the range is resolved against the questions
the mock exam lists now — its shown generation (`current_generation_id`), questions taken out of
it excluded — in mock exam order (`select_mock_range`): `all`, `question_ids` and
`excluded_question_ids` of mock exam question ids and the `type` filter. Chapters and the personal
state filters (`status`, `favorite`, `retry`) do not apply to mock exam questions (no Heatmap, no
study state) and are 422 `range-invalid`, as are ids the mock exam does not list. The run stores
the generation it started on; a later 다시 만들기 or 삭제 leaves it as it is (decision n), while a
question taken out of the mock exam becomes unavailable (skipped). An unknown, deleted or foreign
mock exam is 404; one without questions yet is 409 `no-matching-questions`. Positions are practised
through POST /mock-exam-questions/{id}/practice-sessions (quiz_api.api.mock_practice) and recorded
only in the mock exam practice tables.

Summary: `correct`/`incorrect`/`pending` count submitted positions by their current result;
`skipped` counts positions without a submission — all of them once the run is finished, and
while it is open those before the furthest position opened (`reached`). A position whose question
is no longer available (archived, merged away or deleted) counts as not submitted wherever it is
read — item, summary, results — through one condition
(quiz_api.repositories.practice_runs.eligible_question); its attempts stay as they were. A
finished run takes no new session and no new submission (409 `practice-run-finished`); a pending
answer can still be self-graded.
"""

from __future__ import annotations

import hashlib
import random
import secrets
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from quiz_api.api.question_overview import chapter_number, preview_text
from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    LockMode,
    ResourceType,
    WorkspaceAccess,
    authorize_resource,
    authorize_workspace,
    decide,
    get_access_repository,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.practice_grading import AttemptResult, run_option_seed, shuffled_option_ids
from quiz_api.question_ranges import (
    MAX_RANGE_QUESTIONS,
    QuestionRange,
    QuestionRangeResolver,
    no_matching_questions,
    range_invalid,
    stored_range,
)
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.mock_practice import (
    MockPracticeRepository,
    MockRunCandidate,
    MockSessionRecord,
)
from quiz_api.repositories.practice import PracticeRepository, SessionRecord
from quiz_api.repositories.practice_runs import (
    PracticeRunRepository,
    ResultRow,
    RunProgress,
    RunRecord,
)
from quiz_api.repositories.question_overview import QuestionOverviewRepository
from quiz_api.settings import Environment, Settings
from quiz_api.stem_tables import STEM_TABLES_DESCRIPTION, StemTable, stem_tables_out

router = APIRouter(tags=["practice"], responses=problem_responses(503))

NOT_FOUND = "Not found."
MAX_RUN = MAX_RANGE_QUESTIONS
MAX_SEED = 2**53 - 1  # a JSON-safe integer
# QVIEW-01-AC03 (tests/e2e/fixtures/practice-runs.ts P6): the server seed under APP_ENV=test.
PRACTICE_RUN_TEST_SEED = 20261101
DEFAULT_RESULTS_PAGE = 200
MAX_RESULTS_PAGE = 200
MAX_UNFINISHED = 20

RunSource = Literal["bank", "mock"]
PositionResult = Literal["correct", "incorrect", "pending", "skipped", "reset"]
SessionState = Literal["open", "pending_grade", "graded"]


# --- schemas ------------------------------------------------------------------------------------


class PracticeRunCreate(BaseModel):
    """`source=bank`: the workspace's questions. `source=mock` (with `mock_exam_id`): the
    questions the mock exam lists now. Unknown body fields are ignored (never a workspace or user
    override)."""

    source: RunSource
    mock_exam_id: uuid.UUID | None = None
    range: QuestionRange
    random_order: bool = False
    shuffle_options: bool = Field(
        default=False, description="Shuffle each MCQ's options for this run (bank only)."
    )
    question_count: int | None = Field(default=None, ge=1, le=MAX_RUN)
    seed: int | None = Field(
        default=None, ge=0, le=MAX_SEED, description="Shuffle seed; the server picks one if absent."
    )

    @model_validator(mode="after")
    def _mock_exam_matches_source(self) -> PracticeRunCreate:
        if (self.source == "mock") != (self.mock_exam_id is not None):
            raise ValueError("mock_exam_id is required for source=mock and only for it.")
        if self.source == "mock" and self.question_count is not None:
            raise ValueError("question_count is only supported for source=bank.")
        if self.source == "mock" and self.shuffle_options:
            raise ValueError("shuffle_options is only supported for source=bank.")
        return self


class RetrySession(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    question_id: uuid.UUID
    question_revision_id: uuid.UUID
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    question_number: int | None
    stem: str
    stem_tables: list[StemTable | None] | None = Field(
        default=None, description=STEM_TABLES_DESCRIPTION
    )
    is_multi_answer: bool
    options: list[RunOption]
    displayed_option_ids: list[str]
    state: SessionState
    opened_at: datetime
    practice_run_id: uuid.UUID | None = None
    run_position: int | None = None


class RetrySessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_reset_epoch: int | None = Field(default=None, ge=0)


class RunSummary(BaseModel):
    correct: int
    incorrect: int
    pending: int
    skipped: int


class PracticeRun(BaseModel):
    """Counts, progress and summary only: never the item list or question content."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    source: RunSource
    mock_exam_id: uuid.UUID | None
    random_order: bool
    shuffle_options: bool
    seed: int
    total: int = Field(description="Positions 1..total.")
    answered: int = Field(description="Positions submitted.")
    reached: int = Field(description="The furthest position opened (0: none yet).")
    created_at: datetime
    finished_at: datetime | None
    summary: RunSummary


class RunOption(BaseModel):
    id: str = Field(description="Stable option id; submit it, never a position.")
    text: str


class RunSubmittedAnswer(BaseModel):
    selected_option_ids: list[str] | None = None
    answer_text: str | None = None


class RunAttempt(BaseModel):
    """The submitted position's result with its answers (present only after submission)."""

    attempt_id: uuid.UUID
    result: AttemptResult
    submitted_answer: RunSubmittedAnswer
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    rubric: str | None


class RunItem(BaseModel):
    """One position. `available=false` (deleted or archived since the run started): no content.
    Before submission no answer field exists anywhere outside `attempt` (null)."""

    position: int
    total: int
    available: bool
    question_id: uuid.UUID | None
    question_type: QuestionType | None
    chapter_id: uuid.UUID | None
    chapter_number: int | None = Field(description="For `3장 12번` labels, if known.")
    chapter_title: str | None
    question_number: int | None
    stem: str | None
    stem_tables: list[StemTable | None] | None = Field(
        default=None, description=STEM_TABLES_DESCRIPTION
    )
    is_multi_answer: bool | None
    options: list[RunOption] = Field(
        description="MCQ options; in the session's displayed order once a session is open."
    )
    practice_session_id: uuid.UUID | None = Field(description="This position's session, if any.")
    session_state: SessionState | None
    reset_epoch: int | None = None
    attempt: RunAttempt | None


class RunResultItem(BaseModel):
    position: int
    question_id: uuid.UUID | None
    available: bool
    question_type: QuestionType | None
    chapter_id: uuid.UUID | None
    chapter_number: int | None
    chapter_title: str | None
    question_number: int | None
    preview: str | None = Field(description="First lines of the stem; never the answer.")
    result: PositionResult | None = Field(description="null: not reached yet (open run).")


class RunResults(BaseModel):
    total: int
    offset: int
    limit: int
    items: list[RunResultItem]


class UnfinishedRun(BaseModel):
    """A row of the `이어 풀기` list: progress and where to resume, never question content."""

    id: uuid.UUID
    total: int = Field(description="Positions 1..total.")
    answered: int = Field(description="Positions submitted.")
    next_position: int = Field(description="The first position still answerable.")
    chapter_title: str | None = Field(description="Set when the live questions share a chapter.")
    created_at: datetime
    last_touched_at: datetime


class UnfinishedRunList(BaseModel):
    items: list[UnfinishedRun]


# --- dependencies -------------------------------------------------------------------------------


def get_run_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> PracticeRunRepository:
    return PracticeRunRepository(session)


def get_resolver(session: Annotated[Session, Depends(get_db_session)]) -> QuestionRangeResolver:
    return QuestionRangeResolver(session)


def get_practice_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> PracticeRepository:
    return PracticeRepository(session)


def get_mock_practice_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> MockPracticeRepository:
    return MockPracticeRepository(session)


def get_overview_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionOverviewRepository:
    return QuestionOverviewRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


RunRepo = Annotated[PracticeRunRepository, Depends(get_run_repository)]
ResolverDep = Annotated[QuestionRangeResolver, Depends(get_resolver)]
PracticeRepo = Annotated[PracticeRepository, Depends(get_practice_repository)]
OverviewRepo = Annotated[QuestionOverviewRepository, Depends(get_overview_repository)]
MockRepo = Annotated[MockPracticeRepository, Depends(get_mock_practice_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _create_workspace(
    workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> WorkspaceAccess:
    # A run is the caller's own data: allowed for every role and in an archived workspace.
    return authorize_workspace(
        repo, user.id, workspace_id, Action.READ, LockMode.SHARE, not_found_detail=NOT_FOUND
    )


def _read_workspace(
    workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> WorkspaceAccess:
    # The caller's own runs: every role, archived workspace included.
    return authorize_workspace(
        repo, user.id, workspace_id, Action.READ, LockMode.NONE, not_found_detail=NOT_FOUND
    )


def _own_run(lock: LockMode) -> Any:
    def dependency(
        run_id: Annotated[uuid.UUID, Path()], user: CurrentUser, runs: RunRepo
    ) -> RunRecord:
        record = runs.run_membership(run_id, user.id, lock)
        decide(record, Action.READ, not_found_detail=NOT_FOUND)
        run = runs.get(run_id, user.id)
        if run is None:  # pragma: no cover - the membership lookup found it
            raise _not_found()
        return run

    return Depends(dependency)


ReadRun = Annotated[RunRecord, _own_run(LockMode.NONE)]
WriteRun = Annotated[RunRecord, _own_run(LockMode.SHARE)]


# --- helpers ------------------------------------------------------------------------------------


def server_seed(settings: Settings) -> int:
    """The seed of a run whose request named none (stored, so the order can be reproduced)."""
    if settings.app_env is Environment.TEST:
        return PRACTICE_RUN_TEST_SEED
    return secrets.randbelow(MAX_SEED + 1)


def run_order(heatmap_ids: list[uuid.UUID], random_order: bool, seed: int) -> list[uuid.UUID]:
    """Heatmap order, or `random.Random(seed).shuffle` of it (QVIEW-01-C02)."""
    out = list(heatmap_ids)
    if random_order:
        random.Random(seed).shuffle(out)  # noqa: S311 - a reproducible order, not a secret
    return out


def run_range(body: PracticeRunCreate) -> dict[str, Any]:
    """`practice_runs.range`: the range as sent, plus `shuffle_options` when the run has it."""
    stored = stored_range(body.range)
    return {**stored, "shuffle_options": True} if body.shuffle_options else stored


def position_options(run: RunRecord, position: int, options: list[Any]) -> list[RunOption]:
    """The options of a position without a session, in the order its session will show."""
    by_id = {o["id"]: o["text"] for o in options}
    ids = list(by_id)
    if run.shuffle_options:
        ids = shuffled_option_ids(ids, run_option_seed(run.seed, position))
    return [RunOption(id=i, text=by_id[i]) for i in ids]


def select_mock_range(candidates: list[MockRunCandidate], range_: QuestionRange) -> list[uuid.UUID]:
    """The mock exam questions a range selects, in mock exam order (pure; see the module
    docstring). Raises `range-invalid` for chapters, personal state filters and ids the mock exam
    does not list, never dropping them silently."""
    f = range_.filters
    if range_.chapter_ids or f.status is not None or f.favorite is not None or f.retry is not None:
        raise range_invalid()
    listed = {c.id for c in candidates}
    if any(i not in listed for i in (*range_.question_ids, *range_.excluded_question_ids)):
        raise range_invalid()
    picked = set(range_.question_ids)
    excluded = set(range_.excluded_question_ids)
    return [
        c.id
        for c in candidates
        if (range_.all or c.id in picked)
        and c.id not in excluded
        and (f.types is None or c.question_type in f.types)
    ]


def run_summary(run: RunRecord, progress: RunProgress) -> RunSummary:
    if run.finished_at is not None:
        skipped = run.total - progress.submitted
    else:
        skipped = max(progress.reached - 1, 0) - progress.submitted_before_reached
    return RunSummary(
        correct=progress.correct,
        incorrect=progress.incorrect,
        pending=progress.pending,
        skipped=skipped,
    )


def position_result(
    run: RunRecord, reached: int, position: int, state: str | None, result: str | None
) -> PositionResult | None:
    if state == "reset":
        return "reset"
    if state == "pending_grade":
        return "pending"
    if state == "graded" and result in ("correct", "incorrect"):
        return result  # type: ignore[return-value]
    if run.finished_at is not None or position < reached:
        return "skipped"
    return None


def _run_out(run: RunRecord, progress: RunProgress) -> PracticeRun:
    return PracticeRun(
        id=run.id,
        workspace_id=run.workspace_id,
        source=run.source,  # type: ignore[arg-type]
        mock_exam_id=run.mock_exam_id,
        random_order=run.random_order,
        shuffle_options=run.shuffle_options,
        seed=run.seed,
        total=run.total,
        answered=progress.submitted,
        reached=progress.reached,
        created_at=run.created_at,
        finished_at=run.finished_at,
        summary=run_summary(run, progress),
    )


def _chapter_numbers(
    overview: QuestionOverviewRepository, ids: list[uuid.UUID | None]
) -> dict[uuid.UUID, int | None]:
    lineage = overview.chapter_lineage(i for i in ids if i is not None)
    return {cid: chapter_number(titles) for cid, titles in lineage.items()}


def _attempt_out(
    session: SessionRecord | MockSessionRecord,
    practice: PracticeRepository | MockPracticeRepository,
) -> RunAttempt | None:
    if session.state == "open":
        return None
    latest = practice.latest_attempt(session.id, session.user_id)
    if latest is None:  # pragma: no cover - a submitted session has an attempt
        return None
    rev = session.revision
    return RunAttempt(
        attempt_id=latest.id,
        result=latest.result,
        submitted_answer=RunSubmittedAnswer.model_validate(latest.submitted_answer),
        correct_option_ids=rev.correct_option_ids,
        accepted_answers=rev.accepted_answers,
        explanation=rev.explanation,
        rubric=rev.rubric,
    )


def _unavailable(position: int, total: int) -> RunItem:
    return RunItem(
        position=position,
        total=total,
        available=False,
        question_id=None,
        question_type=None,
        chapter_id=None,
        chapter_number=None,
        chapter_title=None,
        question_number=None,
        stem=None,
        is_multi_answer=None,
        options=[],
        practice_session_id=None,
        session_state=None,
        attempt=None,
    )


def _mock_item(
    run: RunRecord, position: int, question_id: uuid.UUID | None, mocks: MockPracticeRepository
) -> RunItem:
    """A mock run position: the mock exam question unless it was taken out of the mock exam.
    Mock exam questions have no chapter or bank number (labels are "문제 k")."""
    live = mocks.live_question(run.workspace_id, question_id) if question_id else None
    if live is None:
        return _unavailable(position, run.total)
    session = mocks.run_session(run.id, position, run.user_id)
    if session is not None:
        texts = {o["id"]: o["text"] for o in session.revision.options}
        options = [RunOption(id=i, text=texts[i]) for i in session.displayed_option_ids]
        stem, multi = session.revision.stem, session.revision.is_multi_answer
        stem_tables = session.revision.stem_tables
    else:
        options = [RunOption(id=o["id"], text=o["text"]) for o in live.options]
        stem, multi = live.stem, live.is_multi_answer
        stem_tables = live.stem_tables
    return RunItem(
        position=position,
        total=run.total,
        available=True,
        question_id=live.id,
        question_type=live.question_type,
        chapter_id=None,
        chapter_number=None,
        chapter_title=None,
        question_number=None,
        stem=stem,
        stem_tables=stem_tables_out(stem_tables),
        is_multi_answer=multi,
        options=options,
        practice_session_id=session.id if session else None,
        session_state=session.state if session else None,  # type: ignore[arg-type]
        attempt=_attempt_out(session, mocks) if session else None,
    )


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/practice-runs",
    status_code=status.HTTP_201_CREATED,
    response_model=PracticeRun,
    operation_id="createPracticeRun",
    responses=problem_responses(409),
)
def create_practice_run(
    access: Annotated[WorkspaceAccess, Depends(_create_workspace)],
    body: PracticeRunCreate,
    runs: RunRepo,
    resolver: ResolverDep,
    mocks: MockRepo,
    idempotency: IdempotencyStoreDep,
    settings: SettingsDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Resolve the range on the server into a fixed, ordered run of at most 5,000 questions.
    The response carries counts only (read positions through /items/{position})."""
    user_id, workspace_id = access.user_id, access.workspace_id
    scope = f"POST /workspaces/{workspace_id}/practice-runs"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)

    generation_id: uuid.UUID | None = None
    if body.source == "mock":
        assert body.mock_exam_id is not None  # noqa: S101 - the model validator
        exam = mocks.run_source(body.mock_exam_id, workspace_id)
        if exam is None:
            raise _not_found()
        if exam.current_generation_id is None:
            raise no_matching_questions()
        generation_id = exam.current_generation_id
        ids = select_mock_range(mocks.run_candidates(generation_id), body.range)
        if not ids:
            raise no_matching_questions()
    else:
        ids = resolver.resolve(workspace_id, user_id, body.range)
    if len(ids) > MAX_RUN:
        raise ProblemException(
            422,
            ProblemType.PRACTICE_RUN_TOO_LARGE,
            detail=f"A practice run holds at most {MAX_RUN} questions.",
        )
    if body.question_count is not None and body.question_count > len(ids):
        raise ProblemException(
            422, ProblemType.RANGE_INVALID, detail="Question count exceeds the selected range."
        )
    seed = body.seed if body.seed is not None else server_seed(settings)
    ordered = run_order(ids, body.random_order, seed)
    if body.question_count is not None:
        ordered = ordered[: body.question_count]
    run = runs.create(
        workspace_id=workspace_id,
        user_id=user_id,
        source=body.source,
        mock_exam_id=body.mock_exam_id if body.source == "mock" else None,
        mock_exam_generation_id=generation_id,
        range_=run_range(body),
        random_order=body.random_order,
        seed=seed,
        item_ids=ordered,
    )
    empty = RunProgress(0, 0, 0, 0, 0, 0)
    result = _run_out(run, empty)
    if idempotency_key is not None:
        idempotency.save(
            user_id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_201_CREATED,
            result.model_dump(mode="json"),
        )
    runs.commit()
    return result


def _progress(run: RunRecord, runs: PracticeRunRepository, mocks: MockPracticeRepository) -> Any:
    return mocks.progress(run) if run.source == "mock" else runs.progress(run)


@router.get("/practice-runs/{run_id}", operation_id="getPracticeRun")
def get_practice_run(run: ReadRun, runs: RunRepo, mocks: MockRepo) -> PracticeRun:
    """The run's counts, progress and summary (no items, no content)."""
    return _run_out(run, _progress(run, runs, mocks))


@router.post(
    "/practice-runs/{run_id}/items/{position}/retry-session",
    status_code=status.HTTP_201_CREATED,
    response_model=RetrySession,
    operation_id="startRunItemRetrySession",
    responses=problem_responses(409),
)
def start_run_item_retry_session(
    run: WriteRun,
    position: Annotated[int, Path(ge=1)],
    runs: RunRepo,
    practice: PracticeRepo,
    mocks: MockRepo,
    db: Annotated[Session, Depends(get_db_session)],
    access_repo: AccessRepo,
    idempotency: IdempotencyStoreDep,
    user: CurrentUser,
    body: RetrySessionCreate | None = None,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    from quiz_api.api.mock_practice import session_out
    from quiz_api.api.practice import PracticeSessionCreate, start_practice_session
    from quiz_api.repositories.questions import QuestionRepository

    if position > run.total:
        raise _not_found()
    question_id = runs.question_at(run.id, position)
    if question_id is None:
        raise _not_found()
    authorize_workspace(
        access_repo,
        user.id,
        run.workspace_id,
        Action.PRACTICE,
        LockMode.SHARE,
        not_found_detail=NOT_FOUND,
    )
    body = body or RetrySessionCreate()
    if run.source == "bank":
        if runs.live_question(run.workspace_id, question_id) is None:
            raise _not_found()
        epoch = practice.lock_epoch(user.id, question_id)
        origin_session = practice.run_session(run.id, position, user.id)
        if origin_session is not None and origin_session.reset_epoch != epoch:
            raise ProblemException(
                409,
                ProblemType.PRACTICE_SESSION_RESET,
                detail="This practice session was reset. Start a new run.",
            )
        access = authorize_resource(
            access_repo, user.id, ResourceType.QUESTION, question_id, Action.PRACTICE
        )
        scoped_key = (
            hashlib.sha256(f"run-retry:{run.id}:{position}:{idempotency_key}".encode()).hexdigest()
            if idempotency_key is not None
            else None
        )
        return start_practice_session(
            access,
            practice,
            QuestionRepository(db),
            runs,
            idempotency,
            user,
            PracticeSessionCreate(
                expected_reset_epoch=body.expected_reset_epoch,
                shuffle_options=run.shuffle_options,
            ),
            scoped_key,
        )

    target = mocks.target(question_id)
    if (
        target is None
        or target.removed
        or target.exam_deleted
        or target.workspace_id != run.workspace_id
        or not mocks.valid_retry_origin(run.id, position, user.id, question_id)
    ):
        raise _not_found()
    scope = f"POST /practice-runs/{run.id}/items/{position}/retry-session"
    body_hash = request_hash(body.model_dump(mode="json", exclude_none=True))
    if idempotency_key is not None:
        idempotency.lock(user.id, scope, idempotency_key)
        stored = idempotency.find(user.id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)
    displayed = (
        [option["id"] for option in target.revision.options]
        if target.question_type == "MCQ"
        else []
    )
    opened = mocks.open_session(
        target,
        user.id,
        displayed_option_ids=displayed,
        shuffle_seed=None,
        retry_origin_run_id=run.id,
        retry_origin_position=position,
    )
    session = mocks.get_session(opened.id, user.id)
    if session is None:
        raise _not_found()
    mock = session_out(session)
    result = RetrySession(
        id=mock.id,
        workspace_id=mock.workspace_id,
        question_id=mock.mock_exam_question_id,
        question_revision_id=mock.revision_id,
        question_type=mock.question_type,
        chapter_id=None,
        question_number=None,
        stem=mock.stem,
        stem_tables=mock.stem_tables,
        is_multi_answer=mock.is_multi_answer,
        options=[RunOption(id=o.id, text=o.text) for o in mock.options],
        displayed_option_ids=mock.displayed_option_ids,
        state=mock.state,
        opened_at=mock.opened_at,
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
    mocks.commit()
    return result


@router.get("/practice-runs/{run_id}/items/{position}", operation_id="getPracticeRunItem")
def get_practice_run_item(
    run: ReadRun,
    runs: RunRepo,
    practice: PracticeRepo,
    mocks: MockRepo,
    overview: OverviewRepo,
    position: Annotated[int, Path(ge=1, description="1-based; past the end is 404.")],
) -> RunItem:
    """One position of the run: the question without answers, or — once submitted — the
    submitted answer, its result and the answers (`attempt`)."""
    if position > run.total:
        raise _not_found()
    question_id = runs.question_at(run.id, position)
    if run.source == "mock":
        return _mock_item(run, position, question_id, mocks)
    live = runs.live_question(run.workspace_id, question_id) if question_id else None
    if live is None:
        return _unavailable(position, run.total)
    epoch = practice.lock_epoch(run.user_id, live.id)
    session = practice.run_session(run.id, position, run.user_id)
    if session is not None and session.reset_epoch != epoch:
        raise ProblemException(
            409,
            ProblemType.PRACTICE_SESSION_RESET,
            detail="This practice session was reset. Start a new run.",
        )
    if session is not None:
        texts = {o["id"]: o["text"] for o in session.revision.options}
        options = [RunOption(id=i, text=texts[i]) for i in session.displayed_option_ids]
        stem, multi = session.revision.stem, session.revision.is_multi_answer
        stem_tables = session.revision.stem_tables
    else:
        options = position_options(run, position, live.options)
        stem, multi = live.stem, live.is_multi_answer
        stem_tables = live.stem_tables
    numbers = _chapter_numbers(overview, [live.chapter_id])
    return RunItem(
        position=position,
        total=run.total,
        available=True,
        question_id=live.id,
        question_type=live.question_type,
        chapter_id=live.chapter_id,
        chapter_number=numbers.get(live.chapter_id) if live.chapter_id else None,
        chapter_title=live.chapter_title,
        question_number=live.question_number,
        stem=stem,
        stem_tables=stem_tables_out(stem_tables),
        is_multi_answer=multi,
        options=options,
        practice_session_id=session.id if session else None,
        session_state=session.state if session else None,  # type: ignore[arg-type]
        reset_epoch=epoch,
        attempt=_attempt_out(session, practice) if session else None,
    )


@router.get("/practice-runs/{run_id}/results", operation_id="listPracticeRunResults")
def list_practice_run_results(
    run: ReadRun,
    runs: RunRepo,
    mocks: MockRepo,
    overview: OverviewRepo,
    offset: Annotated[int, Query(ge=0, le=MAX_RUN)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_RESULTS_PAGE)] = DEFAULT_RESULTS_PAGE,
) -> RunResults:
    """Positions offset+1 .. offset+limit with their result (no answers)."""
    reached = _progress(run, runs, mocks).reached
    rows: list[ResultRow] = []
    if offset < run.total:
        source = mocks if run.source == "mock" else runs
        rows = source.results(run, offset, limit)
    numbers = _chapter_numbers(overview, [r.chapter_id for r in rows])
    return RunResults(
        total=run.total,
        offset=offset,
        limit=limit,
        items=[
            RunResultItem(
                position=r.position,
                question_id=r.question_id,
                available=r.available,
                question_type=r.question_type,
                chapter_id=r.chapter_id,
                chapter_number=numbers.get(r.chapter_id) if r.chapter_id else None,
                chapter_title=r.chapter_title,
                question_number=r.question_number,
                preview=preview_text(r.stem_head) if r.stem_head is not None else None,
                result=position_result(run, reached, r.position, r.state, r.result),
            )
            for r in rows
        ],
    )


@router.post("/practice-runs/{run_id}/finish", operation_id="finishPracticeRun")
def finish_practice_run(run: WriteRun, runs: RunRepo, mocks: MockRepo) -> PracticeRun:
    """End the run: unsubmitted positions count as skipped and no position can be submitted
    any more. Finishing a finished run returns it unchanged."""
    runs.finish(run.id)
    finished = runs.get(run.id, run.user_id)
    if finished is None:  # pragma: no cover - locked by the membership lookup
        raise _not_found()
    out = _run_out(finished, _progress(finished, runs, mocks))
    runs.commit()
    return out


@router.get(
    "/workspaces/{workspace_id}/practice-runs/unfinished",
    operation_id="listUnfinishedPracticeRuns",
)
def list_unfinished_practice_runs(
    access: Annotated[WorkspaceAccess, Depends(_read_workspace)], runs: RunRepo
) -> UnfinishedRunList:
    """The caller's own unfinished bank runs in this workspace, most recently touched first:
    runs not finished, not dismissed and with a position left to answer (UX12-RESUME)."""
    rows = runs.unfinished(access.workspace_id, access.user_id, MAX_UNFINISHED)
    return UnfinishedRunList(
        items=[
            UnfinishedRun(
                id=r.id,
                total=r.total,
                answered=r.answered,
                next_position=r.next_position,
                chapter_title=r.chapter_title,
                created_at=r.created_at,
                last_touched_at=r.last_touched_at,
            )
            for r in rows
        ]
    )


@router.post(
    "/practice-runs/{run_id}/dismiss",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="dismissPracticeRun",
)
def dismiss_practice_run(run: WriteRun, runs: RunRepo) -> None:
    """Take the run out of the `이어 풀기` list. The run, its sessions and attempts stay as they
    are, and it still opens by its URL. A mock run is not in that list (404)."""
    if run.source != "bank":
        raise _not_found()
    runs.dismiss(run.id)
    runs.commit()


# --- the practice API's run link (quiz_api.api.practice) ----------------------------------------


def run_finished() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.PRACTICE_RUN_FINISHED,
        detail="This practice run is finished. Start a new run to practise again.",
    )


def already_submitted() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.ALREADY_SUBMITTED,
        detail="This position of the practice run was already submitted.",
    )


def wrong_position() -> RequestValidationError:
    return RequestValidationError(
        [
            {
                "loc": ("body", "run_position"),
                "msg": "This position of the run holds another question.",
                "type": "value_error",
            }
        ]
    )
