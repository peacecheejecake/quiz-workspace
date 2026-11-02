"""AI explanations of a question after submission (EXPL-B, AIEXPL-01; docs/questions.md §13).

    GET  /questions/{id}/ai-explanation                 state + the current explanation
    POST /questions/{id}/ai-explanation                 make it (cache hit: 200, no job)
    POST /questions/{id}/ai-explanation/regenerate      a new version (owner/editor)
    GET  /ai-explanations/{id}/stream                   Server-Sent Events while it is made
    GET  /mock-exam-questions/{id}/ai-explanation        the same for a mock exam question
    POST /mock-exam-questions/{id}/ai-explanation       (its own rows: never the source
    POST /mock-exam-questions/{id}/ai-explanation/regenerate    question's, C09)
    GET  /mock-ai-explanations/{id}/stream

The gate (C01, C09), decided from the DB on every request, never from client values: a bank
request names `practice_session_id` — the caller's own session of that question (range-run
positions included) with a submitted attempt (pending grading included) — or `view: detail` (the
문제 상세 dialog: any member; a DRAFT question has no AI explanation: 409
`explanation-unavailable`). A mock request names `mock_practice_session_id` (the caller's own
mock session with a `mock_exam_attempts` row) or `view: manage` (owner/editor only, 403
`insufficient-role`). Anything else is 409 `explanation-before-submit` with no row, job or LLM
call; another user's session is the unknown-session 404. GET carries the gate in the query
string, POST in the body.

Authorization (C02): the question (resource → workspace → membership) decides 404s; reading works
on an archived workspace, creating needs an active one (403 `workspace-archived`), regenerating
owner/editor of an active one. The key is (revision, prompt version, model): the session's
revision for a practice gate, the active one for `detail` / `manage`. A cache hit (a current
success) and an explanation already being made are answered before every limit; creating needs
the feature (409 `explanation-disabled`), then the environment's monthly token cap (409
`explanation-budget-exceeded`), the user's daily count (Asia/Seoul, 429
`explanation-daily-limit`) and the per-user rate (in-process token bucket: 429 `rate-limited` +
Retry-After). Regenerating is capped at 3 per revision per day (409
`explanation-regenerate-limit`).

Creating pins the passages here — the question's own published book sources first, then the ASK
retrieval (`quiz_api.ask_retrieval`: books only, no question paper, a `mixed` book's question
part left out, no summary or note) for the stem plus the answer, ids and pages only — and then,
under a per-revision advisory lock, inserts the queued row and its `question.ai_explain` job
(`INSERT … ON CONFLICT DO NOTHING`; a concurrent request gets the same row). The worker writes
the text to the Redis Stream `explain:<id>`; the stream routes relay it, re-authorizing every
poll (C05).

Nothing here logs question, answer or explanation text (C06); responses never carry prompts, raw
LLM output or usage.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from book_core.explain import PROMPT_VERSION
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.search import get_search_engine
from quiz_api.ask_retrieval import (
    AskRetrieval,
    RetrievalScope,
    RetrievalUnavailableError,
    relevance_scorer,
)
from quiz_api.ask_stream import AskStreamReader, StreamEntry, build_redis
from quiz_api.auth import CurrentUser
from quiz_api.authz import Action, WorkspaceAccess
from quiz_api.authz.dependencies import authorize_resource
from quiz_api.authz.permissions import LockMode, Role
from quiz_api.authz.repository import ResourceType, SqlAccessRepository
from quiz_api.db import Database, get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.jobs import JobMessage, JobPublisher
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.ai_explanations import (
    EXPLAIN_JOB_SCHEMA_VERSION,
    EXPLAIN_JOB_TYPE,
    ExplanationRepository,
    ExplanationRow,
    QuestionTarget,
)
from quiz_api.repositories.ask import AskRepository
from quiz_api.search_engine import SearchEngine
from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai-explanations"])

SEOUL = ZoneInfo("Asia/Seoul")
EDIT_ROLES = frozenset({Role.OWNER, Role.EDITOR})
REGENERATIONS_PER_DAY = 3
MAX_CONTEXT_CHARS = 8000
STREAM_KEY_PREFIX = "explain:"
EXPLANATION_NOT_FOUND = "AI explanation not found."
SESSION_NOT_FOUND = "Practice session not found."
Kind = Literal["question", "mock_exam_question"]


# --- schemas ------------------------------------------------------------------------------------


class OptionWhy(BaseModel):
    option_id: str
    why_md: str


class ExplanationBody(BaseModel):
    correct_option_ids: list[str] = Field(description="The server's answer (MCQ); [] otherwise.")
    summary_md: str
    options: list[OptionWhy] = Field(description="Every option exactly once, in stored order.")
    concepts_md: str
    points_md: str | None = Field(
        default=None, description="Short answer / essay: the rubric's core, common wrong answers."
    )


class ExplanationSource(BaseModel):
    n: int = Field(description="The footnote number `[n]` in the body.")
    document_id: uuid.UUID
    document_title: str
    chapter_title: str | None
    page: int
    block_id: str | None
    outdated: bool = Field(description="The document was published again since.")


class _ExplanationBase(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID | None
    status: Literal["queued", "running", "succeeded", "failed"]
    version: int
    error_code: str | None
    created_at: datetime
    finished_at: datetime | None
    body: ExplanationBody | None = Field(description="Succeeded only.")
    sources: list[ExplanationSource] = Field(description="The cited sources (succeeded only).")
    truncated: bool


class Explanation(_ExplanationBase):
    question_revision_id: uuid.UUID


class MockExplanation(_ExplanationBase):
    mock_exam_question_revision_id: uuid.UUID


class _StateBase(BaseModel):
    available: bool = Field(description="This environment can make AI explanations.")
    can_create: bool = Field(description="available, active workspace, none for this revision.")
    can_regenerate: bool = Field(description="An owner/editor of an active workspace, a success.")


class ExplanationState(_StateBase):
    explanation: Explanation | None = Field(
        description="The newest explanation of this revision that is not superseded, or null."
    )


class MockExplanationState(_StateBase):
    explanation: MockExplanation | None


class ExplanationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    practice_session_id: uuid.UUID | None = Field(
        default=None, description="The caller's submitted practice session of this question."
    )
    view: Literal["detail"] | None = Field(
        default=None, description="`detail`: the 문제 상세 dialog (no submission needed)."
    )


class MockExplanationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mock_practice_session_id: uuid.UUID | None = Field(
        default=None, description="The caller's submitted mock practice session of this question."
    )
    view: Literal["manage"] | None = Field(
        default=None, description="`manage`: 모의고사 문제 관리 (owner/editor, no submission)."
    )


# --- dependencies -------------------------------------------------------------------------------


def get_explanation_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ExplanationRepository:
    return ExplanationRepository(session)


def get_explanation_reader(request: Request) -> AskStreamReader | None:
    state = request.app.state
    if not hasattr(state, "explain_reader"):
        url = state.settings.redis_url
        state.explain_reader = (
            AskStreamReader(build_redis(url.get_secret_value()), key_prefix=STREAM_KEY_PREFIX)
            if url
            else None
        )
    reader: AskStreamReader | None = state.explain_reader
    return reader


def get_explanation_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(request.app.state, "explain_limiter", None)
    if limiter is None:
        rate = request.app.state.settings.ai_explanation_rate_per_minute
        limiter = request.app.state.explain_limiter = TokenBucketLimiter(rate, max(1, rate))
    return limiter


@dataclass(frozen=True)
class ExplainDeps:
    settings: Settings
    engine: SearchEngine
    publisher: JobPublisher | None
    limiter: TokenBucketLimiter


def get_explain_deps(
    request: Request,
    engine: Annotated[SearchEngine, Depends(get_search_engine)],
    publisher: Annotated[JobPublisher | None, Depends(get_job_publisher)],
    limiter: Annotated[TokenBucketLimiter, Depends(get_explanation_limiter)],
) -> ExplainDeps:
    return ExplainDeps(request.app.state.settings, engine, publisher, limiter)


Repo = Annotated[ExplanationRepository, Depends(get_explanation_repository)]
Deps = Annotated[ExplainDeps, Depends(get_explain_deps)]
Reader = Annotated[AskStreamReader | None, Depends(get_explanation_reader)]


# --- the gate -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Kind:
    name: Kind
    resource: ResourceType
    stream_prefix: str


BANK = _Kind("question", ResourceType.QUESTION, "/api/v1/ai-explanations")
MOCK = _Kind("mock_exam_question", ResourceType.MOCK_EXAM_QUESTION, "/api/v1/mock-ai-explanations")


@dataclass(frozen=True)
class _Gate:
    session_id: uuid.UUID | None
    view: bool


def _before_submit() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.EXPLANATION_BEFORE_SUBMIT,
        detail="Submit an answer in this practice session first.",
    )


def _authorize(
    repo: ExplanationRepository,
    user_id: uuid.UUID,
    kind: _Kind,
    target_id: uuid.UUID,
    action: Action,
    lock: LockMode | None = None,
) -> WorkspaceAccess:
    return authorize_resource(
        SqlAccessRepository(repo.session), user_id, kind.resource, target_id, action, lock=lock
    ).workspace


def _target(repo: ExplanationRepository, kind: _Kind, target_id: uuid.UUID) -> QuestionTarget:
    target = repo.bank_question(target_id) if kind is BANK else repo.mock_question(target_id)
    if target is None:  # deleted between the authorization query and this read
        raise HTTPException(
            status_code=404, detail=f"{kind.resource.value.capitalize()} not found."
        )
    return target


def _revision(
    repo: ExplanationRepository,
    kind: _Kind,
    access: WorkspaceAccess,
    target: QuestionTarget,
    gate: _Gate,
) -> uuid.UUID:
    """The revision the caller may see the explanation of, or the gate's 409 / 404 / 403."""
    if gate.session_id is not None:
        ask = AskRepository(repo.session)
        session = (
            ask.bank_session(gate.session_id, access.user_id, target.id)
            if kind is BANK
            else ask.mock_session(gate.session_id, access.user_id, target.id)
        )
        if session is None:
            raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
        if not session.submitted:
            raise _before_submit()
        revision_id = session.revision_id
    elif gate.view:
        if kind is MOCK and access.role not in EDIT_ROLES:
            raise ProblemException(
                403,
                ProblemType.INSUFFICIENT_ROLE,
                detail="Your role in this workspace does not allow this action.",
            )
        revision_id = target.revision_id
    else:
        raise _before_submit()
    if kind is BANK and target.publication_status == "DRAFT":
        raise ProblemException(
            409,
            ProblemType.EXPLANATION_UNAVAILABLE,
            detail="Draft questions have no AI explanation.",
        )
    return revision_id


def _require_active(access: WorkspaceAccess) -> None:
    if access.status != "active":
        raise ProblemException(
            403,
            ProblemType.WORKSPACE_ARCHIVED,
            detail="This workspace is archived and read-only. Restore it to make changes.",
        )


# --- serialization ------------------------------------------------------------------------------


def _explanation_out(
    repo: ExplanationRepository, row: ExplanationRow | None
) -> dict[str, Any] | None:
    if row is None:
        return None
    succeeded = row.status == "succeeded"
    sources = (
        [
            ExplanationSource(
                n=s.number,
                document_id=s.document_id,
                document_title=s.document_title,
                chapter_title=s.chapter_title,
                page=s.page,
                block_id=s.block_id,
                outdated=s.outdated,
            )
            for s in repo.source_views(row.workspace_id, row.sources)
        ]
        if succeeded
        else []
    )
    body = ExplanationBody.model_validate(row.body) if succeeded and row.body else None
    out: dict[str, Any] = {
        "id": row.id,
        "job_id": row.job_id,
        "status": row.status,
        "version": row.version,
        "error_code": row.error_code,
        "created_at": row.created_at,
        "finished_at": row.finished_at,
        "body": body,
        "sources": sources,
        "truncated": row.truncated,
    }
    if row.kind == "question":
        out["question_revision_id"] = row.revision_id
    else:
        out["mock_exam_question_revision_id"] = row.revision_id
    return out


def _state(
    repo: ExplanationRepository,
    settings: Settings,
    kind: _Kind,
    access: WorkspaceAccess,
    revision_id: uuid.UUID,
) -> dict[str, Any]:
    model = settings.ai_explanation_model
    newest = repo.newest(kind.name, revision_id, PROMPT_VERSION, model)
    live = repo.live(kind.name, revision_id, PROMPT_VERSION, model)
    current = repo.current(kind.name, revision_id, PROMPT_VERSION, model)
    available = settings.ai_explanations_available and model is not None
    active = access.status == "active"
    state: dict[str, Any] = {
        "available": available,
        "can_create": available and active and live is None and current is None,
        "can_regenerate": available
        and active
        and access.role in EDIT_ROLES
        and live is None
        and current is not None,
        "explanation": _explanation_out(repo, newest),
    }
    model_type = ExplanationState if kind is BANK else MockExplanationState
    return model_type.model_validate(state).model_dump(mode="json")


# --- creating -----------------------------------------------------------------------------------


def _start_of_day(now: datetime) -> datetime:
    return now.astimezone(SEOUL).replace(hour=0, minute=0, second=0, microsecond=0)


def _check_limits(repo: ExplanationRepository, deps: ExplainDeps, user_id: uuid.UUID) -> None:
    settings = deps.settings
    now = datetime.now(UTC)
    cap = settings.ai_explanation_monthly_token_cap
    if cap > 0 and repo.tokens_since(_start_of_day(now).replace(day=1)) >= cap:
        raise ProblemException(
            409,
            ProblemType.EXPLANATION_BUDGET_EXCEEDED,
            detail="This month's AI explanation usage is used up.",
        )
    today = _start_of_day(now)
    if repo.created_since(user_id, today) >= settings.ai_explanation_daily_limit_per_user:
        tomorrow = today + timedelta(days=1)
        raise ProblemException(
            429,
            ProblemType.EXPLANATION_DAILY_LIMIT,
            detail="Today's new AI explanations are used up.",
            headers={"Retry-After": retry_after_header((tomorrow - now).total_seconds())},
        )
    wait = deps.limiter.acquire(f"explain:{user_id}")
    if wait is not None:
        raise ProblemException(
            429,
            ProblemType.RATE_LIMITED,
            detail="Too many new AI explanations. Wait a moment and try again.",
            headers={"Retry-After": retry_after_header(wait)},
        )


def _pins(
    repo: ExplanationRepository,
    deps: ExplainDeps,
    kind: _Kind,
    target: QuestionTarget,
    revision_id: uuid.UUID,
) -> list[dict[str, Any]]:
    """The passages the explanation may use: the question's own published book sources first,
    then the evidence retrieval (ids and pages only)."""
    refs = repo.source_refs(kind.name, target.id, revision_id)
    books = repo.live_books(target.workspace_id, [r.document_id for r in refs])
    pins: list[dict[str, Any]] = []
    seen: set[tuple[str, tuple[str, ...], int, int]] = set()
    for ref in refs:
        book = books.get(ref.document_id)
        if book is None:
            continue
        located = repo.located(book.revision_id, ref)
        if located is None:
            continue
        blocks, page_from, page_to, chapter_id = located
        key = (str(book.revision_id), tuple(blocks), page_from, page_to)
        if key in seen:
            continue
        seen.add(key)
        pins.append(
            {
                "document_id": str(book.id),
                "document_revision_id": str(book.revision_id),
                "chapter_id": str(chapter_id) if chapter_id else None,
                "block_ids": blocks,
                "page_from": page_from,
                "page_to": page_to,
                "from_question": True,
            }
        )
    query = repo.revision_query_text(kind.name, revision_id)
    repo.rollback()
    settings = deps.settings
    retrieval = AskRetrieval(
        repo.session,
        deps.engine,
        scorer=relevance_scorer(settings),
        min_relevance=settings.ask_min_relevance,
    )
    try:
        found = retrieval.retrieve(
            target.workspace_id,
            query,
            RetrievalScope(),
            top_k=settings.ai_explanation_top_k,
            max_context_chars=MAX_CONTEXT_CHARS,
        ).sources
    except RetrievalUnavailableError:
        found = ()  # the question's own sources still ground it (degraded, logged by retrieval)
    finally:
        repo.rollback()

    def covered(source: Any) -> bool:
        for pin in pins:
            if pin["document_revision_id"] != str(source.revision_id):
                continue
            if pin["block_ids"]:
                if set(source.block_ids) <= set(pin["block_ids"]):
                    return True
            elif pin["page_from"] <= source.page_from and source.page_to <= pin["page_to"]:
                return True
        return False

    for source in found:
        if covered(source):
            continue
        pins.append(
            {
                "document_id": str(source.document_id),
                "document_revision_id": str(source.revision_id),
                "chapter_id": str(source.chapter_id) if source.chapter_id else None,
                "block_ids": list(source.block_ids),
                "page_from": source.page_from,
                "page_to": source.page_to,
                "from_question": False,
            }
        )
    return [{"tag": n, **pin} for n, pin in enumerate(pins, start=1)]


def _publish(
    repo: ExplanationRepository,
    publisher: JobPublisher | None,
    *,
    job_id: uuid.UUID,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: dict[str, Any],
) -> None:
    if publisher is None:
        return
    try:
        publisher.publish(
            JobMessage(
                job_id=job_id,
                job_type=EXPLAIN_JOB_TYPE,
                schema_version=EXPLAIN_JOB_SCHEMA_VERSION,
                workspace_id=workspace_id,
                created_by=user_id,
                idempotency_key=None,
                payload=payload,
            )
        )
    except Exception as exc:
        logger.warning("job publish failed (reconciler will retry): %s", type(exc).__name__)
        return
    repo.mark_published(job_id)
    repo.commit()


def _answer(
    repo: ExplanationRepository,
    settings: Settings,
    kind: _Kind,
    access: WorkspaceAccess,
    revision_id: uuid.UUID,
    status_code: int,
) -> JSONResponse:
    body = _state(repo, settings, kind, access, revision_id)
    repo.commit()
    return JSONResponse(body, status_code=status_code)


def _create(
    repo: ExplanationRepository,
    deps: ExplainDeps,
    user_id: uuid.UUID,
    kind: _Kind,
    target_id: uuid.UUID,
    gate: _Gate,
    *,
    regenerate: bool,
) -> JSONResponse:
    settings = deps.settings
    action = Action.QUESTION_EDIT if regenerate else Action.READ
    access = _authorize(repo, user_id, kind, target_id, action)
    target = _target(repo, kind, target_id)
    revision_id = _revision(repo, kind, access, target, gate)
    _require_active(access)
    model = settings.ai_explanation_model
    current: ExplanationRow | None = None
    if model is not None:
        live = repo.live(kind.name, revision_id, PROMPT_VERSION, model)
        current = repo.current(kind.name, revision_id, PROMPT_VERSION, model)
        if live is not None:
            return _answer(repo, settings, kind, access, revision_id, 202)
        if current is not None and not regenerate:
            return _answer(repo, settings, kind, access, revision_id, 200)  # cache hit
    if not settings.ai_explanations_available or model is None:
        raise ProblemException(
            409,
            ProblemType.EXPLANATION_DISABLED,
            detail="AI explanations are off in this environment.",
        )
    regenerating = regenerate and current is not None
    if regenerating:
        today = _start_of_day(datetime.now(UTC))
        if repo.regenerations_since(kind.name, revision_id, today) >= REGENERATIONS_PER_DAY:
            raise ProblemException(
                409,
                ProblemType.EXPLANATION_REGENERATE_LIMIT,
                detail="This question's AI explanation cannot be regenerated again today.",
            )
    _check_limits(repo, deps, user_id)
    sources = _pins(repo, deps, kind, target, revision_id)

    # The write transaction: re-authorize under the row locks, then one row per key.
    write = Action.QUESTION_EDIT if regenerate else Action.PRACTICE
    access = _authorize(repo, user_id, kind, target_id, write, LockMode.SHARE)
    repo.lock_key(kind.name, revision_id)
    live = repo.live(kind.name, revision_id, PROMPT_VERSION, model)
    now_current = repo.current(kind.name, revision_id, PROMPT_VERSION, model)
    if live is not None:
        return _answer(repo, settings, kind, access, revision_id, 202)
    if now_current is not None and (
        not regenerating or current is None or now_current.id != current.id
    ):
        return _answer(repo, settings, kind, access, revision_id, 200)
    inserted = repo.insert(
        kind.name,
        workspace_id=target.workspace_id,
        target_id=target.id,
        revision_id=revision_id,
        version=now_current.version + 1 if now_current is not None else 1,
        regenerated=now_current is not None,
        prompt_version=PROMPT_VERSION,
        model=model,
        sources=sources,
        created_by=user_id,
    )
    if inserted is None:  # a concurrent request won the live-row index
        return _answer(repo, settings, kind, access, revision_id, 202)
    explanation_id, job_id = inserted
    body = _state(repo, settings, kind, access, revision_id)
    repo.commit()
    _publish(
        repo,
        deps.publisher,
        job_id=job_id,
        workspace_id=target.workspace_id,
        user_id=user_id,
        payload={
            "kind": kind.name,
            "explanation_id": str(explanation_id),
            "target_id": str(target.id),
        },
    )
    return JSONResponse(body, status_code=202)


def _read(
    repo: ExplanationRepository,
    settings: Settings,
    user_id: uuid.UUID,
    kind: _Kind,
    target_id: uuid.UUID,
    gate: _Gate,
) -> dict[str, Any]:
    access = _authorize(repo, user_id, kind, target_id, Action.READ)
    target = _target(repo, kind, target_id)
    revision_id = _revision(repo, kind, access, target, gate)
    return _state(repo, settings, kind, access, revision_id)


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


SettingsDep = Annotated[Settings, Depends(_settings)]
_STATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    202: {"description": "Accepted: the explanation is being made (stream it)."},
    **problem_responses(409, 429),
}


# --- routes: bank questions ---------------------------------------------------------------------


@router.get(
    "/questions/{question_id}/ai-explanation",
    operation_id="getQuestionAiExplanation",
    responses=problem_responses(409),
)
def get_question_explanation(
    question_id: uuid.UUID,
    user: CurrentUser,
    repo: Repo,
    settings: SettingsDep,
    practice_session_id: Annotated[uuid.UUID | None, Query()] = None,
    view: Annotated[Literal["detail"] | None, Query()] = None,
) -> ExplanationState:
    """The AI explanation of this question's revision for a submitted session or `view=detail`."""
    gate = _Gate(practice_session_id, view is not None)
    return ExplanationState.model_validate(_read(repo, settings, user.id, BANK, question_id, gate))


@router.post(
    "/questions/{question_id}/ai-explanation",
    operation_id="createQuestionAiExplanation",
    response_model=ExplanationState,
    responses=_STATE_RESPONSES,
)
def create_question_explanation(
    question_id: uuid.UUID,
    body: ExplanationRequest,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
) -> JSONResponse:
    """Make the explanation (202), or return the cached one (200) / the one being made (202)."""
    gate = _Gate(body.practice_session_id, body.view is not None)
    return _create(repo, deps, user.id, BANK, question_id, gate, regenerate=False)


@router.post(
    "/questions/{question_id}/ai-explanation/regenerate",
    operation_id="regenerateQuestionAiExplanation",
    response_model=ExplanationState,
    responses=_STATE_RESPONSES,
)
def regenerate_question_explanation(
    question_id: uuid.UUID,
    body: ExplanationRequest,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
) -> JSONResponse:
    """A new version of the explanation (owner/editor; 3 per revision per day)."""
    gate = _Gate(body.practice_session_id, body.view is not None)
    return _create(repo, deps, user.id, BANK, question_id, gate, regenerate=True)


# --- routes: mock exam questions ----------------------------------------------------------------


@router.get(
    "/mock-exam-questions/{mock_exam_question_id}/ai-explanation",
    operation_id="getMockExamQuestionAiExplanation",
    responses=problem_responses(409),
)
def get_mock_explanation(
    mock_exam_question_id: uuid.UUID,
    user: CurrentUser,
    repo: Repo,
    settings: SettingsDep,
    mock_practice_session_id: Annotated[uuid.UUID | None, Query()] = None,
    view: Annotated[Literal["manage"] | None, Query()] = None,
) -> MockExplanationState:
    """The AI explanation of this mock exam question's revision (its own, never the source's)."""
    gate = _Gate(mock_practice_session_id, view is not None)
    return MockExplanationState.model_validate(
        _read(repo, settings, user.id, MOCK, mock_exam_question_id, gate)
    )


@router.post(
    "/mock-exam-questions/{mock_exam_question_id}/ai-explanation",
    operation_id="createMockExamQuestionAiExplanation",
    response_model=MockExplanationState,
    responses=_STATE_RESPONSES,
)
def create_mock_explanation(
    mock_exam_question_id: uuid.UUID,
    body: MockExplanationRequest,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
) -> JSONResponse:
    gate = _Gate(body.mock_practice_session_id, body.view is not None)
    return _create(repo, deps, user.id, MOCK, mock_exam_question_id, gate, regenerate=False)


@router.post(
    "/mock-exam-questions/{mock_exam_question_id}/ai-explanation/regenerate",
    operation_id="regenerateMockExamQuestionAiExplanation",
    response_model=MockExplanationState,
    responses=_STATE_RESPONSES,
)
def regenerate_mock_explanation(
    mock_exam_question_id: uuid.UUID,
    body: MockExplanationRequest,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
) -> JSONResponse:
    gate = _Gate(body.mock_practice_session_id, body.view is not None)
    return _create(repo, deps, user.id, MOCK, mock_exam_question_id, gate, regenerate=True)


# --- SSE ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ExplainStreamConfig:
    block_ms: int = 1000
    max_seconds: float = 600.0
    retry_ms: int = 1000


def get_explain_stream_config() -> ExplainStreamConfig:
    return ExplainStreamConfig()


@dataclass(frozen=True)
class _Polled:
    status: str
    error_code: str | None
    explanation: dict[str, Any] | None


# (user, explanation id, gate, full) -> the row's state if the caller may still read it.
StreamPoller = Callable[[uuid.UUID, uuid.UUID, _Gate, bool], _Polled | None]


def _poller(request: Request, kind: _Kind) -> StreamPoller:
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")

    def poll(
        user_id: uuid.UUID, explanation_id: uuid.UUID, gate: _Gate, full: bool
    ) -> _Polled | None:
        with database.read_sessionmaker() as session:
            repo = ExplanationRepository(session)
            try:
                row = _readable(repo, user_id, kind, explanation_id, gate)
            except (HTTPException, ProblemException):
                return None
            body = _explanation_out(repo, row) if full and row.terminal else None
            if body is not None:
                model = Explanation if kind is BANK else MockExplanation
                body = model.model_validate(body).model_dump(mode="json")
            return _Polled(row.status, row.error_code, body)

    return poll


def _readable(
    repo: ExplanationRepository,
    user_id: uuid.UUID,
    kind: _Kind,
    explanation_id: uuid.UUID,
    gate: _Gate,
) -> ExplanationRow:
    """The explanation if the gate opens *its* revision: a session submitted on another revision
    of the question (or `view` on an older revision's explanation) is the unknown-id 404."""
    row = repo.get(kind.name, explanation_id)
    if row is None:
        raise HTTPException(status_code=404, detail=EXPLANATION_NOT_FOUND)
    access = _authorize(repo, user_id, kind, row.target_id, Action.READ)
    target = _target(repo, kind, row.target_id)
    if _revision(repo, kind, access, target, gate) != row.revision_id:
        raise HTTPException(status_code=404, detail=EXPLANATION_NOT_FOUND)
    return row


def get_bank_poller(request: Request) -> StreamPoller:
    return _poller(request, BANK)


def get_mock_poller(request: Request) -> StreamPoller:
    return _poller(request, MOCK)


def _sse(event: str, data: dict[str, Any], event_id: int | None) -> str:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {body}\n\n"


def _last_event_id(request: Request) -> int:
    raw = request.headers.get("last-event-id", "")
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


async def _events(
    request: Request,
    poll: StreamPoller,
    reader: AskStreamReader | None,
    config: ExplainStreamConfig,
    user_id: uuid.UUID,
    explanation_id: uuid.UUID,
    gate: _Gate,
    last_seq: int,
) -> AsyncIterator[str]:
    """`delta {seq, text}` (seq from 0; the SSE id is the stream's event number), `reset`, then
    one `done {explanation}` / `error {code}`; re-authorized on every poll."""
    yield f"retry: {config.retry_ms}\n\n"
    stream_id = "0-0"
    first_seq = last_seq
    started = time.monotonic()

    def deliver(entries: list[StreamEntry]) -> tuple[list[str], StreamEntry | None]:
        nonlocal stream_id, last_seq
        out: list[str] = []
        for entry in entries:
            stream_id = entry.stream_id
            if entry.seq <= last_seq:
                continue
            if entry.event in ("done", "error"):
                return out, entry
            last_seq = entry.seq
            if entry.event == "delta":
                data = {"seq": entry.data.get("seq", 0), "text": entry.data.get("text", "")}
            else:
                data = {}
            out.append(_sse(entry.event, data, entry.seq))
        return out, None

    async def final(seq: int | None) -> str:
        polled = await run_in_threadpool(poll, user_id, explanation_id, gate, True)
        if polled is None:
            return _sse("error", {"code": "not_found"}, seq)
        if polled.status == "failed":
            return _sse("error", {"code": polled.error_code or "explanation_failed"}, seq)
        return _sse("done", {"explanation": polled.explanation or {}}, seq)

    while True:
        polled = await run_in_threadpool(poll, user_id, explanation_id, gate, False)
        if polled is None:
            yield _sse("error", {"code": "not_found"}, None)
            return
        terminal = polled.status in ("succeeded", "failed")
        if reader is None or (terminal and stream_id == "0-0" and last_seq == first_seq):
            if terminal:
                yield await final(None)
                return
            await asyncio.sleep(config.block_ms / 1000)
            continue
        try:
            entries = await run_in_threadpool(
                reader.read_after,
                explanation_id,
                stream_id,
                block_ms=0 if terminal else config.block_ms,
            )
        except Exception as exc:
            logger.warning("explain: stream read failed (%s)", type(exc).__name__)
            entries = []
            await asyncio.sleep(config.block_ms / 1000)
        events, end = deliver(entries)
        for event in events:
            yield event
        if end is not None or terminal:
            if terminal or end is None or end.event == "done":
                yield await final(end.seq if end is not None else None)
            else:
                code = str(end.data.get("code") or "explanation_failed")
                yield _sse("error", {"code": code}, end.seq)
            return
        if time.monotonic() - started >= config.max_seconds:
            return
        if await request.is_disconnected():
            return


_STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": (
            "Server-Sent Events: `delta {seq, text}` (seq counts deltas from 0, again from 0 "
            "after a `reset`; the SSE `id` is the event number: send `Last-Event-ID` to resume), "
            "`reset` (drop the text received so far), then one `done {explanation}` or "
            "`error {code}`. A finished explanation is a single `done`/`error`. Send the Bearer "
            "token in the Authorization header, never in the URL."
        ),
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    },
    **problem_responses(409),
}


async def _stream(
    request: Request,
    poll: StreamPoller,
    reader: AskStreamReader | None,
    config: ExplainStreamConfig,
    user_id: uuid.UUID,
    explanation_id: uuid.UUID,
    gate: _Gate,
    kind: _Kind,
) -> StreamingResponse:
    def check() -> None:
        database: Database = request.app.state.database
        with database.read_sessionmaker() as session:
            _readable(ExplanationRepository(session), user_id, kind, explanation_id, gate)

    try:
        await run_in_threadpool(check)
    except HTTPException as exc:
        if exc.status_code == 404 and not isinstance(exc, ProblemException):
            raise HTTPException(status_code=404, detail=EXPLANATION_NOT_FOUND) from None
        raise
    return StreamingResponse(
        _events(
            request,
            poll,
            reader,
            config,
            user_id,
            explanation_id,
            gate,
            _last_event_id(request),
        ),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no"},
    )


@router.get(
    "/ai-explanations/{explanation_id}/stream",
    operation_id="streamQuestionAiExplanation",
    response_class=StreamingResponse,
    responses=_STREAM_RESPONSES,
)
async def stream_question_explanation(
    explanation_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    poll: Annotated[StreamPoller, Depends(get_bank_poller)],
    reader: Reader,
    config: Annotated[ExplainStreamConfig, Depends(get_explain_stream_config)],
    practice_session_id: Annotated[uuid.UUID | None, Query()] = None,
    view: Annotated[Literal["detail"] | None, Query()] = None,
) -> StreamingResponse:
    """The explanation's text as it is written (same gate as GET …/ai-explanation)."""
    gate = _Gate(practice_session_id, view is not None)
    return await _stream(request, poll, reader, config, user.id, explanation_id, gate, BANK)


@router.get(
    "/mock-ai-explanations/{mock_explanation_id}/stream",
    operation_id="streamMockExamQuestionAiExplanation",
    response_class=StreamingResponse,
    responses=_STREAM_RESPONSES,
)
async def stream_mock_explanation(
    mock_explanation_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    poll: Annotated[StreamPoller, Depends(get_mock_poller)],
    reader: Reader,
    config: Annotated[ExplainStreamConfig, Depends(get_explain_stream_config)],
    mock_practice_session_id: Annotated[uuid.UUID | None, Query()] = None,
    view: Annotated[Literal["manage"] | None, Query()] = None,
) -> StreamingResponse:
    gate = _Gate(mock_practice_session_id, view is not None)
    return await _stream(request, poll, reader, config, user.id, mock_explanation_id, gate, MOCK)
