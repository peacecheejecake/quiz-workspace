"""Mock exams API (MOCK-B, MOCK-01; docs/questions.md §11, architecture.md §6).

    GET    /workspaces/{id}/mock-exams          any member (archived included), newest first
    POST   /workspaces/{id}/mock-exams          owner/editor, active workspace; `Idempotency-Key`
    GET    /mock-exams/{id}                     any member
    PATCH  /mock-exams/{id}                     owner/editor: rename
    DELETE /mock-exams/{id}                     owner/editor: soft delete (cancels a generation)
    POST   /mock-exams/{id}/generations         owner/editor: 다시 만들기 / 설정 바꾸기 / 다시 시도
    GET    /mock-exams/{id}/questions           any member; `include=answers` for editors only
    PATCH  /mock-exam-questions/{id}            owner/editor: edit (a new revision)
    DELETE /mock-exam-questions/{id}            owner/editor: take it out of the mock exam

Unknown, deleted, foreign-workspace mock exams and questions answer one 404; share sessions
reach none of these routes. Mock exam questions live outside the bank: no route here (or
anywhere) registers one as a question (MOCK-01-C01).

A generation pins its plan at request time: the range resolved to the workspace's live
CONFIRMED questions (`quiz_api.mock_exam_ranges`, the QVIEW-B resolver), `min(문항 수, range)`
sources picked by the seed and their variation types (`book_core.mock_exam.make_plan`).

Limits (MOCK-01-C06): 문항 수 1..100 with an AI variation type, 1..min(range, 5,000) (or null =
the whole range) with 보기 섞기 only (422); AI types need WORKER_MOCK_EXAMS and an LLM (409
`mock-llm-disabled`); one queued/running generation per mock exam (409
`mock-generation-running`); at most MOCK_EXAM_MAX_RUNNING_PER_WORKSPACE in the workspace (409
`generation-busy`); MOCK_EXAM_GENERATION_RATE_LIMIT_PER_MINUTE starts per user (429 +
Retry-After). A retry with the same `Idempotency-Key` returns the first response before any
limit is checked.

Viewers never get answers or explanations (MOCK-01-C05); responses carry no prompt or LLM output,
activities ids and counts only (MOCK-01-C07).
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from book_core.contracts import VariationType
from book_core.mock_exam import (
    MAX_AI_QUESTIONS,
    MAX_RANGE_QUESTIONS,
    MAX_SEED,
    make_plan,
    uses_llm,
)
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.question_imports import _publish_job
from quiz_api.api.question_overview import chapter_number
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
from quiz_api.authz.permissions import Role
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.jobs import JobPublisher
from quiz_api.mock_exam_ranges import resolve_candidates
from quiz_api.question_ranges import QuestionRange
from quiz_api.question_rules import (
    MAX_ACCEPTED_ANSWERS,
    MAX_LONG_TEXT,
    MAX_OPTIONS,
    MAX_STEM,
    QuestionContent,
    validate_content,
)
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.jobs import error_code
from quiz_api.repositories.mock_exams import (
    ExamRecord,
    GenerationRecord,
    MockExamRepository,
    QuestionRecord,
)
from quiz_api.repositories.question_imports import QuestionImportRepository
from quiz_api.repositories.question_overview import QuestionOverviewRepository
from quiz_api.settings import Settings

router = APIRouter(tags=["mock-exams"], responses=problem_responses(503))

NOT_FOUND = "Not found."
TERMINAL_JOB = frozenset({"succeeded", "failed", "cancelled"})
VariationName = Literal["OPTION_SHUFFLE", "PARAPHRASE", "INVERT_POLARITY", "ANALOGOUS_CONCEPT"]
GenerationStatus = Literal["queued", "running", "succeeded", "partial", "failed", "cancelled"]
ExamStatus = Literal["generating", "ready", "partial", "failed"]
DELETED_SOURCE = "원본 삭제됨"


# --- schemas ------------------------------------------------------------------------------------


class MockExamConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variation_types: list[VariationName] = Field(
        min_length=1, max_length=4, description="Distinct variation types (one or more)."
    )
    question_count: int | None = Field(
        ge=1,
        le=MAX_RANGE_QUESTIONS,
        description="Questions to make: 1..100 with an AI type; with 보기 섞기 only 1..range "
        "(null = the whole range).",
    )
    difficulty: Literal["easy", "medium", "hard"] | None = Field(
        default=None, description="null = like the source."
    )

    @field_validator("variation_types")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("variation types must be distinct")
        return value


class MockExamCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=100)
    config: MockExamConfig
    range: QuestionRange
    seed: int | None = Field(default=None, ge=0, le=MAX_SEED)


class MockExamUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=100)


class MockExamGenerationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: MockExamConfig | None = Field(default=None, description="설정 바꾸기: new settings.")
    range: QuestionRange | None = None
    seed: int | None = Field(default=None, ge=0, le=MAX_SEED)


class MockExamProgress(BaseModel):
    done: int
    total: int


class MockExamGeneration(BaseModel):
    id: uuid.UUID
    version: int
    status: GenerationStatus
    job_id: uuid.UUID | None = Field(description="Job `mock_exam.generate`.")
    requested_count: int
    created_count: int
    skipped_count: int
    error_code: str | None = Field(
        description="`llm_unavailable`, `llm_timeout`, `no_valid_questions`, "
        "`mock_exam_unavailable`, ..."
    )
    progress: MockExamProgress | None = Field(description="While queued or running.")
    seed: int
    created_at: datetime
    finished_at: datetime | None


class MockExam(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    version: int
    status: ExamStatus
    config: MockExamConfig
    range: QuestionRange
    question_count_current: int
    current_generation: MockExamGeneration | None = Field(
        description="The generation whose questions are shown."
    )
    latest_generation: MockExamGeneration | None
    created_at: datetime
    updated_at: datetime


class MockExamList(BaseModel):
    llm_available: bool = Field(description="This environment can use the AI variation types.")
    items: list[MockExam]


class MockExamOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=256)
    text: str = Field(max_length=5000)


class MockExamRevisionRef(BaseModel):
    id: uuid.UUID
    version: int


class MockExamSourceRef(BaseModel):
    question_id: uuid.UUID | None = Field(description="null: the source was deleted.")
    label: str = Field(description='"<n>장 <m>번", "<m>번" or "원본 삭제됨".')


class MockExamValidationNote(BaseModel):
    code: str
    severity: Literal["error", "warning"]


class MockExamQuestion(BaseModel):
    id: uuid.UUID
    position: int
    question_type: Literal["MCQ", "SHORT_ANSWER", "ESSAY"]
    variation_type: VariationName
    stem: str
    options: list[MockExamOption]
    is_multi_answer: bool
    revision: MockExamRevisionRef
    edited: bool
    source: MockExamSourceRef
    # Editors with include=answers only (never for viewers).
    correct_option_ids: list[str] | None = None
    accepted_answers: list[str] | None = None
    explanation: str | None = None
    rubric: str | None = None
    validation_issues: list[MockExamValidationNote] | None = None


class MockExamQuestionList(BaseModel):
    items: list[MockExamQuestion]


class MockExamQuestionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision_id: uuid.UUID
    stem: str | None = Field(default=None, max_length=MAX_STEM)
    options: list[MockExamOption] | None = Field(default=None, max_length=MAX_OPTIONS)
    correct_option_ids: list[str] | None = Field(default=None, max_length=MAX_OPTIONS)
    is_multi_answer: bool | None = None
    accepted_answers: list[str] | None = Field(default=None, max_length=MAX_ACCEPTED_ANSWERS)
    explanation: str | None = Field(default=None, max_length=MAX_LONG_TEXT)
    rubric: str | None = Field(default=None, max_length=MAX_LONG_TEXT)


# --- dependencies -------------------------------------------------------------------------------


def get_mock_exam_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> MockExamRepository:
    return MockExamRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


def get_import_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionImportRepository:
    return QuestionImportRepository(session)


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_mock_exam_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(request.app.state, "mock_exam_limiter", None)
    if limiter is None:
        rate = request.app.state.settings.mock_exam_generation_rate_per_minute
        limiter = request.app.state.mock_exam_limiter = TokenBucketLimiter(rate, max(1, rate))
    return limiter


Repo = Annotated[MockExamRepository, Depends(get_mock_exam_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
JobRepo = Annotated[QuestionImportRepository, Depends(get_import_repository)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
LimiterDep = Annotated[TokenBucketLimiter, Depends(get_mock_exam_limiter)]


def _uniform(call: Callable[[], ResourceAccess]) -> ResourceAccess:
    try:
        return call()
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None
        raise


def _exam(action: Action) -> Any:
    def dependency(
        mock_exam_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return _uniform(
            lambda: authorize_resource(repo, user.id, ResourceType.MOCK_EXAM, mock_exam_id, action)
        )

    return Depends(dependency)


def _question(action: Action) -> Any:
    def dependency(
        mock_exam_question_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return _uniform(
            lambda: authorize_resource(
                repo, user.id, ResourceType.MOCK_EXAM_QUESTION, mock_exam_question_id, action
            )
        )

    return Depends(dependency)


def _workspace(action: Action) -> Any:
    def dependency(
        workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> WorkspaceAccess:
        return authorize_workspace(repo, user.id, workspace_id, action, not_found_detail=NOT_FOUND)

    return Depends(dependency)


ReadExam = Annotated[ResourceAccess, _exam(Action.READ)]
EditExam = Annotated[ResourceAccess, _exam(Action.QUESTION_EDIT)]
EditQuestion = Annotated[ResourceAccess, _question(Action.QUESTION_EDIT)]
ReadWorkspace = Annotated[WorkspaceAccess, _workspace(Action.READ)]
EditWorkspace = Annotated[WorkspaceAccess, _workspace(Action.QUESTION_EDIT)]


# --- presentation -------------------------------------------------------------------------------


def generation_out(row: GenerationRecord) -> MockExamGeneration:
    status_value: str = row.status
    code = row.error_code
    if row.status in {"queued", "running"} and row.job_status in {"failed", "cancelled"}:
        # The job ended without the worker settling the generation (e.g. lost): show it failed.
        status_value = "failed"
        code = error_code(row.job_status, row.job_error) or "job_failed"
    if status_value == "failed" and not code:
        code = "job_failed"
    active = status_value in {"queued", "running"}
    return MockExamGeneration(
        id=row.id,
        version=row.version,
        status=status_value,  # type: ignore[arg-type]
        job_id=row.job_id,
        requested_count=row.requested_count,
        created_count=row.created_count,
        skipped_count=row.skipped_count,
        error_code=code if status_value in {"failed", "cancelled"} else None,
        progress=MockExamProgress(done=row.progress_done, total=row.requested_count)
        if active
        else None,
        seed=row.seed,
        created_at=row.created_at,
        finished_at=row.finished_at,
    )


def _exam_status(latest: MockExamGeneration | None) -> ExamStatus:
    if latest is None or latest.status in {"queued", "running"}:
        return "generating"
    if latest.status == "succeeded":
        return "ready"
    if latest.status == "partial":
        return "partial"
    return "failed"


def exams_out(repo: MockExamRepository, exams: list[ExamRecord]) -> list[MockExam]:
    generations = repo.generations([e.id for e in exams])
    latest: dict[uuid.UUID, GenerationRecord] = {}
    for g in generations.values():
        if g.mock_exam_id not in latest or g.version > latest[g.mock_exam_id].version:
            latest[g.mock_exam_id] = g
    counts = repo.question_counts(e.current_generation_id for e in exams if e.current_generation_id)
    out = []
    for exam in exams:
        current = (
            generations.get(exam.current_generation_id) if exam.current_generation_id else None
        )
        newest = latest.get(exam.id)
        newest_out = generation_out(newest) if newest is not None else None
        out.append(
            MockExam(
                id=exam.id,
                workspace_id=exam.workspace_id,
                title=exam.title,
                version=exam.version,
                status=_exam_status(newest_out),
                config=MockExamConfig.model_validate(exam.config),
                range=QuestionRange.model_validate(exam.range),
                question_count_current=counts.get(current.id, 0) if current else 0,
                current_generation=generation_out(current) if current is not None else None,
                latest_generation=newest_out,
                created_at=exam.created_at,
                updated_at=exam.updated_at,
            )
        )
    return out


def exam_out(repo: MockExamRepository, exam: ExamRecord) -> MockExam:
    return exams_out(repo, [exam])[0]


def source_labels(
    repo: MockExamRepository, questions: list[QuestionRecord]
) -> dict[uuid.UUID, MockExamSourceRef]:
    chapters = {q.source_chapter_id for q in questions if q.source_chapter_id is not None}
    lineage = QuestionOverviewRepository(repo.session).chapter_lineage(chapters)
    out: dict[uuid.UUID, MockExamSourceRef] = {}
    for q in questions:
        if q.source_question_id is None or q.source_deleted:
            out[q.id] = MockExamSourceRef(question_id=None, label=DELETED_SOURCE)
            continue
        number = (
            chapter_number(lineage.get(q.source_chapter_id, []))
            if q.source_chapter_id is not None
            else None
        )
        tail = f"{q.source_number}번" if q.source_number is not None else "번호 없음"
        label = f"{number}장 {tail}" if number is not None else tail
        out[q.id] = MockExamSourceRef(question_id=q.source_question_id, label=label)
    return out


def question_out(
    q: QuestionRecord, source: MockExamSourceRef, *, answers: bool
) -> MockExamQuestion:
    out = MockExamQuestion(
        id=q.id,
        position=q.position,
        question_type=q.question_type,  # type: ignore[arg-type]
        variation_type=q.variation_type,  # type: ignore[arg-type]
        stem=q.stem,
        options=[MockExamOption(id=o["id"], text=o["text"]) for o in q.options],
        is_multi_answer=q.is_multi_answer,
        revision=MockExamRevisionRef(id=q.revision_id, version=q.revision_version),
        edited=q.revision_version > 1,
        source=source,
    )
    if answers:
        out.correct_option_ids = q.correct_option_ids
        out.accepted_answers = q.accepted_answers
        out.explanation = q.explanation
        out.rubric = q.rubric
        out.validation_issues = [
            MockExamValidationNote(
                code=str(i.get("code", "")), severity=i.get("severity", "warning")
            )
            for i in q.validation_issues
            if i.get("severity") in {"error", "warning"}
        ]
    return out


def _is_editor(access: WorkspaceAccess) -> bool:
    return access.role in {Role.OWNER, Role.EDITOR}


def _question_json(q: MockExamQuestion, *, answers: bool) -> dict[str, Any]:
    if answers:
        return q.model_dump(mode="json")
    return q.model_dump(
        mode="json",
        exclude={
            "correct_option_ids",
            "accepted_answers",
            "explanation",
            "rubric",
            "validation_issues",
        },
    )


# --- generation start ---------------------------------------------------------------------------


def _invalid(loc: tuple[str | int, ...], message: str) -> RequestValidationError:
    return RequestValidationError([{"loc": ("body", *loc), "msg": message, "type": "value_error"}])


def _check_config(config: MockExamConfig, settings: Settings) -> None:
    types = [VariationType(v) for v in config.variation_types]
    if uses_llm(types):
        if config.question_count is None or config.question_count > MAX_AI_QUESTIONS:
            raise _invalid(
                ("config", "question_count"),
                f"With an AI variation type make 1..{MAX_AI_QUESTIONS} questions.",
            )
        if not settings.mock_exam_llm_available:
            raise ProblemException(
                409,
                ProblemType.MOCK_LLM_DISABLED,
                detail="AI variation types are not available in this environment.",
            )


def _start(
    repo: MockExamRepository,
    settings: Settings,
    limiter: TokenBucketLimiter,
    exam: ExamRecord,
    actor_id: uuid.UUID,
    config: MockExamConfig,
    range_: QuestionRange,
    seed: int | None,
    *,
    new_config: bool,
    saved_range: bool = False,
) -> uuid.UUID:
    """Resolve, plan, enforce the start limits and queue the generation (no commit). A count
    over the range is refused when the settings are new (create / 설정 바꾸기); a plain remake
    of a range that shrank since makes `min(count, range)` like the AI types. A `saved_range`
    (다시 만들기 of the stored range) drops questions gone since instead of 422 (C08). A whole
    range (`question_count` null) over 5,000 questions is 422 however it starts (C06)."""
    repo.lock_workspace_generations(exam.workspace_id)
    candidates = resolve_candidates(
        repo.session, exam.workspace_id, actor_id, range_, saved=saved_range
    )
    if not candidates:
        raise ProblemException(
            409,
            ProblemType.NO_MATCHING_QUESTIONS,
            detail="The range has no confirmed question.",
        )
    types = [VariationType(v) for v in config.variation_types]
    if (
        new_config
        and not uses_llm(types)
        and config.question_count is not None
        and config.question_count > len(candidates)
    ):
        raise _invalid(
            ("config", "question_count"),
            "With 보기 섞기 only make at most as many questions as the range holds.",
        )
    if config.question_count is None and len(candidates) > MAX_RANGE_QUESTIONS:
        # The whole range (보기 섞기 only), on create, 설정 바꾸기 or a saved range grown since.
        raise _invalid(
            ("config", "question_count"),
            f"A mock exam holds at most {MAX_RANGE_QUESTIONS:,} questions: the range has "
            f"{len(candidates):,}. Choose a question count or a smaller range.",
        )
    if repo.running_count(exam.workspace_id) >= settings.mock_exam_max_running_per_workspace:
        raise ProblemException(
            409,
            ProblemType.GENERATION_BUSY,
            detail="Too many mock exams of this workspace are being made. Wait for them to "
            "finish, then try again.",
        )
    wait = limiter.acquire(f"mock_exam:{actor_id}")
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many mock exams started. Wait a moment and try again.",
            headers={"Retry-After": retry_after_header(wait)},
        )
    chosen = seed if seed is not None else secrets.randbelow(MAX_SEED + 1)
    plan = make_plan(candidates, config.question_count, types, chosen)
    return repo.create_generation(
        exam,
        actor_id,
        config=config.model_dump(mode="json"),
        range_=range_.model_dump(mode="json"),
        plan=[p.as_json() for p in plan],
        seed=chosen,
    )


def _replayed(
    idempotency: IdempotencyStore,
    repo: MockExamRepository,
    jobs: QuestionImportRepository,
    publisher: JobPublisher | None,
    user_id: uuid.UUID,
    scope: str,
    key: str | None,
    body_hash: str,
) -> JSONResponse | None:
    if key is None:
        return None
    idempotency.lock(user_id, scope, key)
    stored = idempotency.find(user_id, scope, key)
    if stored is None:
        return None
    response = replay(stored, body_hash)
    repo.rollback()
    latest = stored.body.get("latest_generation") if isinstance(stored.body, dict) else None
    job_id = latest.get("job_id") if isinstance(latest, dict) else None
    if job_id:
        _publish_job(jobs, publisher, uuid.UUID(str(job_id)))
    return response


def _accepted(
    repo: MockExamRepository,
    idempotency: IdempotencyStore,
    jobs: QuestionImportRepository,
    publisher: JobPublisher | None,
    exam_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: str,
    key: str | None,
    body_hash: str,
) -> JSONResponse:
    exam = repo.exam(exam_id)
    assert exam is not None  # noqa: S101 - created/locked in this transaction
    result = exam_out(repo, exam)
    payload = result.model_dump(mode="json")
    if key is not None:
        idempotency.save(user_id, scope, key, body_hash, status.HTTP_202_ACCEPTED, payload)
    repo.commit()
    job_id = result.latest_generation.job_id if result.latest_generation else None
    _publish_job(jobs, publisher, job_id)
    return JSONResponse(payload, status_code=status.HTTP_202_ACCEPTED)


# --- routes -------------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/mock-exams", operation_id="listMockExams")
def list_mock_exams(access: ReadWorkspace, repo: Repo, settings: SettingsDep) -> MockExamList:
    """The workspace's mock exams, newest first, with their generation state."""
    return MockExamList(
        llm_available=settings.mock_exam_llm_available,
        items=exams_out(repo, repo.exams(access.workspace_id)),
    )


@router.post(
    "/workspaces/{workspace_id}/mock-exams",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MockExam,
    operation_id="createMockExam",
    responses=problem_responses(409, 429),
)
def create_mock_exam(
    access: EditWorkspace,
    body: MockExamCreate,
    repo: Repo,
    jobs: JobRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    settings: SettingsDep,
    limiter: LimiterDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Save a mock exam and start its first generation. With an AI variation type the range's
    questions, answers, explanations and related book text are sent to the LLM provider."""
    user_id, workspace_id = access.user_id, access.workspace_id
    scope = f"POST /workspaces/{workspace_id}/mock-exams"
    body_hash = request_hash(body.model_dump(mode="json"))
    replayed = _replayed(
        idempotency, repo, jobs, publisher, user_id, scope, idempotency_key, body_hash
    )
    if replayed is not None:
        return replayed
    if not body.title.strip():
        raise _invalid(("title",), "Give the mock exam a name.")
    _check_config(body.config, settings)
    exam_id = repo.create_exam(
        workspace_id=workspace_id,
        actor_id=user_id,
        title=body.title.strip(),
        config=body.config.model_dump(mode="json"),
        range_=body.range.model_dump(mode="json"),
    )
    exam = repo.exam(exam_id)
    assert exam is not None  # noqa: S101 - inserted above
    _start(
        repo, settings, limiter, exam, user_id, body.config, body.range, body.seed, new_config=True
    )
    return _accepted(
        repo, idempotency, jobs, publisher, exam_id, user_id, scope, idempotency_key, body_hash
    )


def _load(repo: MockExamRepository, access: ResourceAccess, *, lock: bool = False) -> ExamRecord:
    exam = repo.exam(access.resource_id, lock=lock)
    if exam is None or exam.workspace_id != access.workspace.workspace_id:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return exam


@router.get("/mock-exams/{mock_exam_id}", operation_id="getMockExam")
def get_mock_exam(access: ReadExam, repo: Repo) -> MockExam:
    """Settings, current and newest generation (status, progress, counts)."""
    return exam_out(repo, _load(repo, access))


@router.patch("/mock-exams/{mock_exam_id}", operation_id="renameMockExam")
def rename_mock_exam(access: EditExam, body: MockExamUpdate, repo: Repo) -> MockExam:
    """이름 바꾸기 (1-100 characters; names may repeat in a workspace)."""
    if not body.title.strip():
        raise _invalid(("title",), "Give the mock exam a name.")
    exam = _load(repo, access, lock=True)
    if body.title.strip() != exam.title:
        repo.update_exam(exam, access.workspace.user_id, title=body.title.strip())
    result = exam_out(repo, _load(repo, access))
    repo.commit()
    return result


@router.delete(
    "/mock-exams/{mock_exam_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteMockExam",
)
def delete_mock_exam(access: EditExam, repo: Repo) -> Response:
    """Soft delete: the mock exam leaves the list (attempts stay); a running generation is
    cancelled."""
    exam = _load(repo, access, lock=True)
    repo.delete_exam(exam, access.workspace.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/mock-exams/{mock_exam_id}/generations",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MockExam,
    operation_id="createMockExamGeneration",
    responses=problem_responses(409, 429),
)
def create_mock_exam_generation(
    access: EditExam,
    body: MockExamGenerationCreate,
    repo: Repo,
    jobs: JobRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    settings: SettingsDep,
    limiter: LimiterDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """다시 만들기 (empty body), 설정 바꾸기 (`config` / `range`: saved as a new revision) or
    다시 시도: a new generation; on success it replaces the shown questions (earlier ones and
    their attempts are kept)."""
    user_id = access.workspace.user_id
    scope = f"POST /mock-exams/{access.resource_id}/generations"
    body_hash = request_hash(body.model_dump(mode="json"))
    replayed = _replayed(
        idempotency, repo, jobs, publisher, user_id, scope, idempotency_key, body_hash
    )
    if replayed is not None:
        return replayed
    exam = _load(repo, access, lock=True)
    config = body.config or MockExamConfig.model_validate(exam.config)
    range_ = body.range or QuestionRange.model_validate(exam.range)
    _check_config(config, settings)
    active = repo.active(exam.id)
    if active is not None:
        if active.job_id is None or active.job_status in TERMINAL_JOB:
            repo.settle(
                active.id,
                "failed",
                error_code(active.job_status or "failed", active.job_error) or "job_failed",
            )
        else:
            raise ProblemException(
                409,
                ProblemType.MOCK_GENERATION_RUNNING,
                detail="This mock exam is already being made.",
            )
    if body.config is not None or body.range is not None:
        repo.update_exam(
            exam,
            user_id,
            config=config.model_dump(mode="json"),
            range_=range_.model_dump(mode="json"),
        )
        exam = _load(repo, access)
    _start(
        repo,
        settings,
        limiter,
        exam,
        user_id,
        config,
        range_,
        body.seed,
        new_config=body.config is not None or body.range is not None,
        saved_range=body.range is None,
    )
    return _accepted(
        repo, idempotency, jobs, publisher, exam.id, user_id, scope, idempotency_key, body_hash
    )


@router.get("/mock-exams/{mock_exam_id}/questions", operation_id="listMockExamQuestions")
def list_mock_exam_questions(
    access: ReadExam,
    repo: Repo,
    include: Annotated[
        Literal["answers"] | None,
        Query(description="`answers`: answers, explanations and checks (editors only)."),
    ] = None,
) -> Any:
    """The shown generation's questions by position (removed ones excluded). Viewers never get
    answers or explanations, also with `include=answers`."""
    exam = _load(repo, access)
    answers = include == "answers" and _is_editor(access.workspace)
    if exam.current_generation_id is None:
        return JSONResponse({"items": []})
    questions = repo.questions(exam.current_generation_id)
    labels = source_labels(repo, questions)
    items = [
        _question_json(question_out(q, labels[q.id], answers=answers), answers=answers)
        for q in questions
    ]
    return JSONResponse({"items": items})


@router.patch(
    "/mock-exam-questions/{mock_exam_question_id}",
    response_model=MockExamQuestion,
    operation_id="updateMockExamQuestion",
    responses=problem_responses(409),
)
def update_mock_exam_question(
    access: EditQuestion, body: MockExamQuestionUpdate, repo: Repo
) -> Any:
    """Edit (a new revision; earlier attempts keep pointing at theirs). A stale
    `base_revision_id` is 409 `stale-revision`."""
    current = repo.question(access.resource_id, lock=True)
    if current is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if body.base_revision_id != current.revision_id:
        raise ProblemException(
            409,
            ProblemType.STALE_REVISION,
            detail="The question changed since this edit started. Reload it and try again.",
        )
    sent = body.model_fields_set

    def pick(name: str, value: Any) -> Any:
        return getattr(body, name) if name in sent else value

    options = (
        [(o.id, o.text) for o in body.options]
        if "options" in sent and body.options is not None
        else [(o["id"], o["text"]) for o in current.options]
    )
    content = QuestionContent(
        question_type=current.question_type,  # type: ignore[arg-type]
        stem=body.stem if "stem" in sent and body.stem is not None else current.stem,
        options=tuple(options),
        correct_option_ids=tuple(c)
        if (c := pick("correct_option_ids", current.correct_option_ids)) is not None
        else None,
        is_multi_answer=bool(
            body.is_multi_answer
            if "is_multi_answer" in sent and body.is_multi_answer is not None
            else current.is_multi_answer
        ),
        accepted_answers=tuple(a)
        if (a := pick("accepted_answers", current.accepted_answers)) is not None
        else None,
        explanation=pick("explanation", current.explanation),
        rubric=pick("rubric", current.rubric),
    )
    validate_content(content, "CONFIRMED")
    repo.edit_question(
        current,
        access.workspace.workspace_id,
        access.workspace.user_id,
        {
            "stem": content.stem,
            "options": content.options_json(),
            "correct_option_ids": list(content.correct_option_ids)
            if content.correct_option_ids is not None
            else None,
            "accepted_answers": list(content.accepted_answers)
            if content.accepted_answers is not None
            else None,
            "is_multi_answer": content.is_multi_answer,
            "explanation": content.explanation,
            "rubric": content.rubric,
        },
    )
    updated = repo.question(access.resource_id)
    assert updated is not None  # noqa: S101 - edited in this transaction
    result = question_out(updated, source_labels(repo, [updated])[updated.id], answers=True)
    repo.commit()
    return JSONResponse(result.model_dump(mode="json"))


@router.delete(
    "/mock-exam-questions/{mock_exam_question_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="removeMockExamQuestion",
)
def remove_mock_exam_question(access: EditQuestion, repo: Repo) -> Response:
    """이 모의고사에서 빼기: the question leaves the list and later 풀기 (attempts stay)."""
    current = repo.question(access.resource_id, lock=True)
    if current is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    repo.remove_question(current, access.workspace.workspace_id, access.workspace.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
