"""AI questions over the workspace's documents (ASK-B, ASK-01; docs/questions.md §13).

    GET    /workspaces/{id}/ask                    state: available, reason, limits (any member)
    GET    /workspaces/{id}/ask/conversations      the caller's own conversations, newest first
    POST   /workspaces/{id}/ask/conversations      new conversation (scope, optional attachment)
    GET    /ask/conversations/{id}                 one conversation with every message
    DELETE /ask/conversations/{id}                 delete it (messages, sources, feedback)
    DELETE /ask/conversations/{id}/attachment      detach the question (later messages: none)
    POST   /ask/conversations/{id}/messages        ask (202 + the answer's stream URL and job)
    GET    /ask/messages/{id}                      one message (polling: the text so far)
    GET    /ask/messages/{id}/stream               Server-Sent Events of an answer
    POST   /ask/messages/{id}/cancel               stop an unfinished answer (idempotent)
    POST   /ask/messages/{id}/retry                a new answer for a failed / stopped one
    POST   /ask/messages/{id}/regenerate           a new answer version of the last question
    PUT    /ask/messages/{id}/feedback             "도움이 안 됨" reason code

Authorization (C01): every route needs the JWT `sub`; a share session reaches nothing (401). The
workspace routes need membership (any role; the unknown-workspace 404 otherwise). A
conversation and its messages belong to their creator only: anybody else (the workspace Owner
included) gets the same 404 as an unknown id, and the creator must still be a member of the
conversation's live workspace. Asking (messages, retry, regenerate) and creating need an active
workspace (403 `workspace-archived`); reading, deleting, detaching, stopping and feedback work
on an archived one.

Attachments are checked on the server from the DB: a live question of this workspace (`detail`,
any status — the 문제 상세 rights), the caller's own practice session of that question
(`practice`), a mock exam question still in its live mock exam with the caller's own mock
session (`practice`) or edit rights (`manage`, C10). The disclosure level is computed for every
message from the DB (`practice`: has the session an attempt? `hint` / `full`; `detail` /
`manage`: `full`); a client's `disclosure` is ignored. The API pins ids only (plus the session's
option order and, for `full`, the caller's own submission) and never reads an answer,
explanation, rubric or source passage: the worker builds the LLM context (C03). No response
returns that context.

Asking runs the evidence retrieval here (`quiz_api.ask_retrieval`), pins the references and
creates the question, the queued answer and its `ask.answer` job in one transaction. Limits
(C06): question length (422 `question-too-long`), questions per conversation (409
`ask-turn-limit`), one unfinished answer per user (409 `ask-answer-running`, also a partial
unique index), answer versions per question (409 `ask-regenerate-limit`, last question only:
409 `ask-not-last-answer`), the feature switch (409 `ask-disabled`), the per-user daily count
(Asia/Seoul, DB: 429 `ask-daily-limit`), the environment's monthly token cap (409
`ask-budget-exceeded`) and the per-user rate (in-process token bucket: 429 + Retry-After; a
token is taken only by a request that passed every other check). A repeated `Idempotency-Key`
returns the first response before any limit is checked.

Nothing here logs a question, answer or passage (C07).
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

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.search import get_search_engine
from quiz_api.ask_retrieval import (
    AskRetrieval,
    RetrievalResult,
    RetrievalScope,
    RetrievalUnavailableError,
    relevance_scorer,
)
from quiz_api.ask_stream import AskStreamReader, StreamEntry, build_redis
from quiz_api.auth import CurrentUser
from quiz_api.authz import Action, WorkspaceAccess, require_workspace_access
from quiz_api.authz.dependencies import authorize_workspace
from quiz_api.authz.permissions import LockMode, Role
from quiz_api.authz.repository import SqlAccessRepository
from quiz_api.db import Database, get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.jobs import JobMessage, JobPublisher
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.ask import (
    ASK_JOB_SCHEMA_VERSION,
    ASK_JOB_TYPE,
    AskRepository,
    AttachmentPin,
    ConversationRow,
    MessageRow,
    SourceRow,
    stem_head,
)
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.search_engine import SearchEngine
from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ask"])

CONVERSATION_NOT_FOUND = "Conversation not found."
MESSAGE_NOT_FOUND = "Message not found."
ATTACHMENT_NOT_FOUND = "The question to attach was not found."
PAGE_SIZE = 30
MAX_SCOPE_IDS = 200
TITLE_QUESTION_CHARS = 40
SEOUL = ZoneInfo("Asia/Seoul")
EDIT_ROLES = frozenset({Role.OWNER, Role.EDITOR})


# --- schemas ------------------------------------------------------------------------------------


class AskLimits(BaseModel):
    max_question_chars: int
    max_turns: int
    max_regenerations: int


class AskState(BaseModel):
    available: bool = Field(description="New questions can be asked here now.")
    reason: Literal["disabled", "archived"] | None = Field(
        description="Why not: the feature is off in this environment, or the workspace is "
        "archived (stored conversations stay readable either way)."
    )
    limits: AskLimits


class AskScope(BaseModel):
    model_config = ConfigDict(extra="ignore")

    document_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_SCOPE_IDS)
    chapter_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_SCOPE_IDS)


class AttachmentInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["question", "mock_exam_question"]
    view: Literal["practice", "detail", "manage"]
    question_id: uuid.UUID | None = None
    practice_session_id: uuid.UUID | None = None
    mock_exam_question_id: uuid.UUID | None = None
    mock_practice_session_id: uuid.UUID | None = None
    selected_option_ids: list[str] = Field(default_factory=list, max_length=50)


class ConversationCreate(BaseModel):
    """Extra fields (e.g. a `disclosure` value) are ignored."""

    model_config = ConfigDict(extra="ignore")

    scope: AskScope | None = None
    attachment: AttachmentInput | None = None


class Attachment(BaseModel):
    kind: Literal["question", "mock_exam_question"]
    view: Literal["practice", "detail", "manage"]
    label: str = Field(description="`<n>장 <m>번 · <발문 앞 40자>` / `문제 k · …`.")
    disclosure: Literal["hint", "full"] = Field(
        description="What the next message will use (from the DB)."
    )
    available: bool = Field(
        description="False once the question, session or mock exam is gone (no context then)."
    )


class Source(BaseModel):
    number: int = Field(description="The footnote number `[n]` in the answer text.")
    document_id: uuid.UUID
    document_title: str
    revision_id: uuid.UUID = Field(description="The published revision the passage was read in.")
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    block_ids: list[str]
    page_from: int
    page_to: int
    document_type: str
    outdated: bool = Field(description="The revision is no longer the published one.")


class Message(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    role: Literal["user", "assistant"]
    status: Literal[
        "queued", "retrieving", "streaming", "succeeded", "no_sources", "stopped", "failed"
    ]
    text: str = Field(
        description="Markdown: the finished, validated answer (footnotes `[1]`…), or the text "
        "streamed so far."
    )
    sources: list[Source] = Field(description="Cited passages of a finished answer.")
    searched_sources: list[Source] = Field(
        description='The passages searched for a `no_sources` answer ("검색한 구절").'
    )
    disclosure: Literal["none", "hint", "full"]
    error_code: str | None
    uncited: bool
    truncated: bool
    degraded: list[Literal["dense_unavailable", "attachment_only"]]
    question_message_id: uuid.UUID | None
    retry_of_message_id: uuid.UUID | None
    regenerated_from_message_id: uuid.UUID | None
    feedback: Literal["source_mismatch", "made_up", "revealed_answer", "other"] | None
    created_at: datetime


class Conversation(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str | None
    scope: AskScope
    attachment: Attachment | None
    messages: list[Message]
    created_at: datetime
    last_message_at: datetime


class ConversationSummary(BaseModel):
    id: uuid.UUID
    title: str | None
    last_message_at: datetime
    attachment: Attachment | None


class ConversationPage(BaseModel):
    items: list[ConversationSummary]
    next_cursor: str | None


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    question: str = Field(min_length=1, max_length=20_000)
    scope: AskScope | None = None
    selected_option_ids: list[str] | None = Field(default=None, max_length=50)


class MessageAccepted(BaseModel):
    user_message: Message
    answer: Message
    stream_url: str
    job_id: uuid.UUID


class FeedbackInput(BaseModel):
    reason: Literal["source_mismatch", "made_up", "revealed_answer", "other"]


class Feedback(BaseModel):
    message_id: uuid.UUID
    reason: Literal["source_mismatch", "made_up", "revealed_answer", "other"]


# --- dependencies -------------------------------------------------------------------------------


def get_ask_repository(session: Annotated[Session, Depends(get_db_session)]) -> AskRepository:
    return AskRepository(session)


def get_ask_reader(request: Request) -> AskStreamReader | None:
    state = request.app.state
    if not hasattr(state, "ask_reader"):
        url = state.settings.redis_url
        state.ask_reader = AskStreamReader(build_redis(url.get_secret_value())) if url else None
    reader: AskStreamReader | None = state.ask_reader
    return reader


def get_ask_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(request.app.state, "ask_limiter", None)
    if limiter is None:
        rate = request.app.state.settings.ask_rate_per_minute
        limiter = request.app.state.ask_limiter = TokenBucketLimiter(rate, max(1, rate))
    return limiter


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


Repo = Annotated[AskRepository, Depends(get_ask_repository)]
Reader = Annotated[AskStreamReader | None, Depends(get_ask_reader)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
ReadAccess = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.READ))]
AskAccess = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.PRACTICE))]


@dataclass(frozen=True)
class AskDeps:
    settings: Settings
    engine: SearchEngine
    publisher: JobPublisher | None
    limiter: TokenBucketLimiter
    reader: AskStreamReader | None


def get_ask_deps(
    request: Request,
    engine: Annotated[SearchEngine, Depends(get_search_engine)],
    publisher: Annotated[JobPublisher | None, Depends(get_job_publisher)],
    limiter: Annotated[TokenBucketLimiter, Depends(get_ask_limiter)],
    reader: Reader,
) -> AskDeps:
    return AskDeps(request.app.state.settings, engine, publisher, limiter, reader)


Deps = Annotated[AskDeps, Depends(get_ask_deps)]


# --- ownership ----------------------------------------------------------------------------------


def _owned_conversation(
    repo: AskRepository,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    action: Action,
    lock: LockMode | None = None,
) -> tuple[ConversationRow, WorkspaceAccess]:
    conversation = repo.conversation(conversation_id, user_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail=CONVERSATION_NOT_FOUND)
    access = authorize_workspace(
        SqlAccessRepository(repo.session),
        user_id,
        conversation.workspace_id,
        action,
        lock,
        not_found_detail=CONVERSATION_NOT_FOUND,
    )
    return conversation, access


def _owned_message(
    repo: AskRepository, user_id: uuid.UUID, message_id: uuid.UUID, action: Action
) -> tuple[MessageRow, ConversationRow, WorkspaceAccess]:
    message = repo.message(message_id, user_id)
    if message is None:
        raise HTTPException(status_code=404, detail=MESSAGE_NOT_FOUND)
    conversation = repo.conversation(message.conversation_id, user_id)
    if conversation is None:  # pragma: no cover - the FK cascades
        raise HTTPException(status_code=404, detail=MESSAGE_NOT_FOUND)
    access = authorize_workspace(
        SqlAccessRepository(repo.session),
        user_id,
        conversation.workspace_id,
        action,
        not_found_detail=MESSAGE_NOT_FOUND,
    )
    return message, conversation, access


# --- attachments --------------------------------------------------------------------------------


def _pin(
    repo: AskRepository,
    conversation: ConversationRow,
    role: Role,
    selected: list[str] | None = None,
) -> AttachmentPin | None:
    """The attachment as the next message uses it, from the DB; None = nothing usable."""
    kind, view = conversation.attachment_kind, conversation.attachment_view
    chosen = list(selected if selected is not None else conversation.selected_option_ids)
    if kind == "question" and conversation.question_id is not None:
        target = repo.bank_question(conversation.workspace_id, conversation.question_id)
        if target is None:
            return None
        if view == "detail":
            return AttachmentPin(
                kind="question",
                disclosure="full",
                question_id=target.question_id,
                question_revision_id=target.revision_id,
                query_text=target.query_text,
            )
        if conversation.practice_session_id is None:
            return None
        session = repo.bank_session(
            conversation.practice_session_id, conversation.user_id, target.question_id
        )
        if session is None:
            return None
        return AttachmentPin(
            kind="question",
            disclosure="full" if session.submitted else "hint",
            question_id=target.question_id,
            question_revision_id=session.revision_id,
            practice_session_id=session.id,
            displayed_option_ids=session.displayed_option_ids,
            selected_option_ids=chosen,
            attempt=repo.bank_attempt(session.id, conversation.user_id)
            if session.submitted
            else None,
            query_text=repo.revision_query_text(session.revision_id, mock=False),
        )
    if kind == "mock_exam_question" and conversation.mock_exam_question_id is not None:
        target = repo.mock_question(conversation.workspace_id, conversation.mock_exam_question_id)
        if target is None:
            return None
        if view == "manage":
            if role not in EDIT_ROLES:
                return None
            return AttachmentPin(
                kind="mock_exam_question",
                disclosure="full",
                mock_exam_question_id=target.question_id,
                mock_exam_question_revision_id=target.revision_id,
                query_text=target.query_text,
            )
        if conversation.mock_practice_session_id is None:
            return None
        session = repo.mock_session(
            conversation.mock_practice_session_id, conversation.user_id, target.question_id
        )
        if session is None:
            return None
        return AttachmentPin(
            kind="mock_exam_question",
            disclosure="full" if session.submitted else "hint",
            mock_exam_question_id=target.question_id,
            mock_exam_question_revision_id=session.revision_id,
            mock_practice_session_id=session.id,
            displayed_option_ids=session.displayed_option_ids,
            selected_option_ids=chosen,
            attempt=repo.mock_attempt(session.id, conversation.user_id)
            if session.submitted
            else None,
            query_text=repo.revision_query_text(session.revision_id, mock=True),
        )
    return None


def _attachment_out(
    repo: AskRepository, conversation: ConversationRow, role: Role
) -> Attachment | None:
    if conversation.attachment_kind is None or conversation.attachment_view is None:
        return None
    pin = _pin(repo, conversation, role)
    fixed = conversation.attachment_view in ("detail", "manage")
    disclosure = pin.disclosure if pin is not None else ("full" if fixed else "hint")
    return Attachment(
        kind=conversation.attachment_kind,  # type: ignore[arg-type]
        view=conversation.attachment_view,  # type: ignore[arg-type]
        label=conversation.attachment_label or "",
        disclosure=disclosure,  # type: ignore[arg-type]
        available=pin is not None,
    )


def _check_attachment(
    repo: AskRepository, access: WorkspaceAccess, body: AttachmentInput
) -> tuple[str, dict[str, uuid.UUID | None]]:
    """(label, refs) of an attachment the caller may make, else 404 / 403 / 422."""
    ws, user = access.workspace_id, access.user_id
    if body.kind == "question":
        if body.view not in ("practice", "detail") or body.question_id is None:
            raise HTTPException(status_code=422, detail="Invalid attachment for a question.")
        target = repo.bank_question(ws, body.question_id)
        if target is None:
            raise HTTPException(status_code=404, detail=ATTACHMENT_NOT_FOUND)
        refs: dict[str, uuid.UUID | None] = {"question_id": target.question_id}
        if body.view == "practice":
            if body.practice_session_id is None:
                raise HTTPException(status_code=422, detail="practice_session_id is required.")
            session = repo.bank_session(body.practice_session_id, user, target.question_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Practice session not found.")
            refs["practice_session_id"] = session.id
        return target.label, refs
    if body.view not in ("practice", "manage") or body.mock_exam_question_id is None:
        raise HTTPException(status_code=422, detail="Invalid attachment for a mock exam question.")
    mock_target = repo.mock_question(ws, body.mock_exam_question_id)
    if mock_target is None:
        raise HTTPException(status_code=404, detail=ATTACHMENT_NOT_FOUND)
    refs = {"mock_exam_question_id": mock_target.question_id}
    if body.view == "manage":
        if access.role not in EDIT_ROLES:
            raise ProblemException(
                403,
                ProblemType.INSUFFICIENT_ROLE,
                detail="Your role in this workspace does not allow this action.",
            )
        return mock_target.label, refs
    if body.mock_practice_session_id is None:
        raise HTTPException(status_code=422, detail="mock_practice_session_id is required.")
    mock_session = repo.mock_session(body.mock_practice_session_id, user, mock_target.question_id)
    if mock_session is None:
        raise HTTPException(status_code=404, detail="Practice session not found.")
    refs["mock_practice_session_id"] = mock_session.id
    return mock_target.label, refs


# --- serialization ------------------------------------------------------------------------------


def _source_out(row: SourceRow, number: int) -> Source:
    return Source(
        number=number,
        document_id=row.document_id,
        document_title=row.document_title,
        revision_id=row.revision_id,
        chapter_id=row.chapter_id,
        chapter_title=row.chapter_title,
        block_ids=row.block_ids,
        page_from=row.page_from,
        page_to=row.page_to,
        document_type=row.document_type,
        outdated=row.outdated,
    )


def _message_out(
    row: MessageRow, sources: list[SourceRow], reader: AskStreamReader | None
) -> Message:
    cited: list[Source] = []
    searched: list[Source] = []
    if row.status == "succeeded":
        cited = [
            _source_out(s, s.number)
            for s in sorted(
                (s for s in sources if s.cited and s.number), key=lambda s: s.number or 0
            )
            if s.number is not None
        ]
    elif row.status == "no_sources":
        searched = [_source_out(s, s.tag) for s in sources]
    text = row.text
    if not row.terminal and row.role == "assistant" and reader is not None:
        try:
            text = reader.text_so_far(row.id)
        except Exception as exc:  # Redis down: the polling client sees no text yet
            logger.warning("ask: stream read failed (%s)", type(exc).__name__)
            text = ""
    return Message(
        id=row.id,
        conversation_id=row.conversation_id,
        role=row.role,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        text=text,
        sources=cited,
        searched_sources=searched,
        disclosure=row.disclosure,  # type: ignore[arg-type]
        error_code=row.error_code,
        uncited=row.uncited,
        truncated=row.truncated,
        degraded=row.degraded,  # type: ignore[arg-type]
        question_message_id=row.question_message_id,
        retry_of_message_id=row.retry_of_message_id,
        regenerated_from_message_id=row.regenerated_from_message_id,
        feedback=row.feedback,  # type: ignore[arg-type]
        created_at=row.created_at,
    )


def _scope_out(raw: dict[str, Any]) -> AskScope:
    try:
        return AskScope.model_validate(raw)
    except ValueError:
        return AskScope()


def _conversation_out(
    repo: AskRepository,
    conversation: ConversationRow,
    role: Role,
    reader: AskStreamReader | None,
) -> Conversation:
    messages = repo.messages(conversation.id)
    sources = repo.sources([m.id for m in messages if m.role == "assistant"])
    return Conversation(
        id=conversation.id,
        workspace_id=conversation.workspace_id,
        title=conversation.title,
        scope=_scope_out(conversation.scope),
        attachment=_attachment_out(repo, conversation, role),
        messages=[_message_out(m, sources.get(m.id, []), reader) for m in messages],
        created_at=conversation.created_at,
        last_message_at=conversation.last_message_at,
    )


def _scope_json(scope: AskScope | None) -> dict[str, list[str]]:
    scope = scope or AskScope()
    return {
        "document_ids": [str(i) for i in scope.document_ids],
        "chapter_ids": [str(i) for i in scope.chapter_ids],
    }


# --- routes: state and conversations ------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/ask", operation_id="getAskState")
def get_ask_state(access: ReadAccess, settings: SettingsDep) -> AskState:
    """Whether new AI questions can be asked here, and the limits the panel shows."""
    reason: Literal["disabled", "archived"] | None = None
    if not settings.ask_available:
        reason = "disabled"
    elif access.status == "archived":
        reason = "archived"
    return AskState(
        available=reason is None,
        reason=reason,
        limits=AskLimits(
            max_question_chars=settings.ask_max_question_chars,
            max_turns=settings.ask_max_turns,
            max_regenerations=settings.ask_max_regenerations,
        ),
    )


def _cursor(value: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not value:
        return None
    try:
        at, ident = value.split("|", 1)
        return datetime.fromisoformat(at), uuid.UUID(ident)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid cursor.") from None


@router.get("/workspaces/{workspace_id}/ask/conversations", operation_id="listAskConversations")
def list_conversations(
    access: ReadAccess,
    repo: Repo,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> ConversationPage:
    """The caller's own conversations of this workspace, most recent first (30 per page)."""
    rows = repo.list_conversations(
        access.workspace_id, access.user_id, limit=PAGE_SIZE + 1, after=_cursor(cursor)
    )
    more = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]
    return ConversationPage(
        items=[
            ConversationSummary(
                id=r.id,
                title=r.title,
                last_message_at=r.last_message_at,
                attachment=_attachment_out(repo, r, access.role),
            )
            for r in rows
        ],
        next_cursor=f"{rows[-1].last_message_at.isoformat()}|{rows[-1].id}" if more else None,
    )


@router.post(
    "/workspaces/{workspace_id}/ask/conversations",
    operation_id="createAskConversation",
    status_code=201,
)
def create_conversation(
    access: AskAccess, body: ConversationCreate, repo: Repo, reader: Reader
) -> Conversation:
    """A new (personal) conversation, optionally with one attached question."""
    label: str | None = None
    refs: dict[str, uuid.UUID | None] = {}
    selected: list[str] = []
    if body.attachment is not None:
        label, refs = _check_attachment(repo, access, body.attachment)
        if body.attachment.view == "practice":
            selected = list(dict.fromkeys(body.attachment.selected_option_ids))
    conversation_id = repo.create_conversation(
        workspace_id=access.workspace_id,
        user_id=access.user_id,
        scope=_scope_json(body.scope),
        kind=body.attachment.kind if body.attachment else None,
        view=body.attachment.view if body.attachment else None,
        label=label,
        question_id=refs.get("question_id"),
        practice_session_id=refs.get("practice_session_id"),
        mock_exam_question_id=refs.get("mock_exam_question_id"),
        mock_practice_session_id=refs.get("mock_practice_session_id"),
        selected_option_ids=selected,
    )
    repo.commit()
    conversation = repo.conversation(conversation_id, access.user_id)
    assert conversation is not None  # noqa: S101 - just committed
    return _conversation_out(repo, conversation, access.role, reader)


@router.get("/ask/conversations/{conversation_id}", operation_id="getAskConversation")
def get_conversation(
    conversation_id: uuid.UUID, user: CurrentUser, repo: Repo, reader: Reader
) -> Conversation:
    conversation, access = _owned_conversation(repo, user.id, conversation_id, Action.READ)
    return _conversation_out(repo, conversation, access.role, reader)


@router.delete(
    "/ask/conversations/{conversation_id}", operation_id="deleteAskConversation", status_code=204
)
def delete_conversation(conversation_id: uuid.UUID, user: CurrentUser, repo: Repo) -> Response:
    """Deletes the conversation with its messages, sources and feedback (usage counts stay)."""
    conversation, _access = _owned_conversation(repo, user.id, conversation_id, Action.READ)
    repo.delete_conversation(conversation.id)
    repo.commit()
    return Response(status_code=204)


@router.delete("/ask/conversations/{conversation_id}/attachment", operation_id="detachAskQuestion")
def detach_question(
    conversation_id: uuid.UUID, user: CurrentUser, repo: Repo, reader: Reader
) -> Conversation:
    """Later messages carry no question context; earlier answers stay."""
    conversation, access = _owned_conversation(repo, user.id, conversation_id, Action.READ)
    repo.clear_attachment(conversation.id)
    repo.commit()
    fresh = repo.conversation(conversation.id, user.id)
    assert fresh is not None  # noqa: S101 - just updated
    return _conversation_out(repo, fresh, access.role, reader)


# --- routes: asking -----------------------------------------------------------------------------


def _start_of_day(now: datetime) -> datetime:
    local = now.astimezone(SEOUL)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_month(now: datetime) -> datetime:
    return _start_of_day(now).replace(day=1)


def _check_budgets(repo: AskRepository, settings: Settings, user_id: uuid.UUID) -> None:
    if repo.running_answer(user_id):
        raise ProblemException(
            409,
            ProblemType.ASK_ANSWER_RUNNING,
            detail="An answer is still being written. Wait for it or stop it.",
        )
    now = datetime.now(UTC)
    if repo.answers_since(user_id, _start_of_day(now)) >= settings.ask_daily_limit_per_user:
        tomorrow = _start_of_day(now) + timedelta(days=1)
        raise ProblemException(
            429,
            ProblemType.ASK_DAILY_LIMIT,
            detail="Today's AI questions are used up.",
            headers={"Retry-After": retry_after_header((tomorrow - now).total_seconds())},
        )
    cap = settings.ask_monthly_token_cap
    if cap > 0 and repo.tokens_since(_start_of_month(now)) >= cap:
        raise ProblemException(
            409,
            ProblemType.ASK_BUDGET_EXCEEDED,
            detail="This month's AI question usage is used up.",
        )


def _take_rate_token(limiter: TokenBucketLimiter, user_id: uuid.UUID) -> None:
    wait = limiter.acquire(f"ask:{user_id}")
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many questions. Wait a moment and ask again.",
            headers={"Retry-After": retry_after_header(wait)},
        )


def _retrieve(
    repo: AskRepository,
    deps: AskDeps,
    workspace_id: uuid.UUID,
    query: str,
    scope: dict[str, Any],
) -> RetrievalResult:
    settings = deps.settings
    parsed = _scope_out(scope)
    retrieval = AskRetrieval(
        repo.session,
        deps.engine,
        scorer=relevance_scorer(settings),
        min_relevance=settings.ask_min_relevance,
    )
    try:
        return retrieval.retrieve(
            workspace_id,
            query,
            RetrievalScope(tuple(parsed.document_ids), tuple(parsed.chapter_ids)),
            top_k=settings.ask_top_k,
            max_context_chars=settings.ask_max_context_chars,
        )
    except RetrievalUnavailableError:
        raise HTTPException(
            status_code=503, detail="Search is temporarily unavailable. Try again shortly."
        ) from None
    finally:
        repo.rollback()


def _publish(
    repo: AskRepository,
    publisher: JobPublisher | None,
    accepted: MessageAccepted,
    conversation: ConversationRow,
) -> None:
    if publisher is None:
        return
    try:
        publisher.publish(
            JobMessage(
                job_id=accepted.job_id,
                job_type=ASK_JOB_TYPE,
                schema_version=ASK_JOB_SCHEMA_VERSION,
                workspace_id=conversation.workspace_id,
                created_by=conversation.user_id,
                idempotency_key=None,
                payload={"message_id": str(accepted.answer.id)},
            )
        )
    except Exception as exc:
        logger.warning("job publish failed (reconciler will retry): %s", type(exc).__name__)
        return
    repo.session.execute(
        text(
            "update public.async_jobs set published_at = now() "
            "where id = :j and status = 'queued' and published_at is null"
        ),
        {"j": accepted.job_id},
    )
    repo.commit()


@dataclass(frozen=True)
class _Ask:
    """What one accepted request writes."""

    question: str | None  # a new question (None: a new answer to `question_message_id`)
    question_message_id: uuid.UUID | None
    scope: dict[str, Any]
    selected: list[str] | None
    retry_of: uuid.UUID | None = None
    regenerated_from: uuid.UUID | None = None
    scope_changed: bool = False


def _write_answer(
    repo: AskRepository,
    settings: Settings,
    conversation: ConversationRow,
    ask: _Ask,
    pin: AttachmentPin | None,
    retrieval: RetrievalResult,
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """The question (when new), the queued answer, its job and pins; flushed, so a violated
    one-running-answer index raises IntegrityError here."""
    title: str | None = None
    question_message_id = ask.question_message_id
    if ask.question is not None:
        question_message_id = repo.insert_question(conversation, ask.question, ask.scope)
        if conversation.title is None:
            prefix = ""
            if conversation.attachment_label and " · " in conversation.attachment_label:
                prefix = conversation.attachment_label.split(" · ", 1)[0] + " · "
            title = (prefix + stem_head(ask.question, TITLE_QUESTION_CHARS))[:200]
    assert question_message_id is not None  # noqa: S101 - set above or by the caller
    degraded = list(retrieval.degraded)
    if pin is not None and not retrieval.sources:
        degraded.append("attachment_only")
    answer_id, job_id = repo.insert_answer(
        conversation,
        question_message_id=question_message_id,
        scope=ask.scope,
        pin=pin,
        context_char_limit=settings.ask_max_context_chars,
        degraded=degraded,
        retry_of=ask.retry_of,
        regenerated_from=ask.regenerated_from,
    )
    repo.insert_sources(answer_id, conversation.workspace_id, retrieval.sources)
    repo.touch(
        conversation.id,
        title=title,
        scope=ask.scope if ask.scope_changed else None,
        selected_option_ids=ask.selected,
    )
    repo.session.flush()
    return answer_id, job_id, question_message_id


def _accept(
    repo: AskRepository,
    deps: AskDeps,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    ask: _Ask,
    *,
    idempotency: tuple[str, str, str] | None,
    precheck: Callable[[], None],
) -> JSONResponse:
    """Checks, retrieval, then one write transaction (module docstring)."""
    settings = deps.settings
    conversation, access = _owned_conversation(repo, user_id, conversation_id, Action.PRACTICE)
    store = IdempotencyStore(repo.session)
    if idempotency is not None:
        scope_name, key, body_hash = idempotency
        stored = store.find(user_id, scope_name, key)
        if stored is not None:
            return replay(stored, body_hash)
    if not settings.ask_available:
        raise ProblemException(
            409, ProblemType.ASK_DISABLED, detail="AI questions are off in this environment."
        )
    precheck()
    _check_budgets(repo, settings, user_id)
    _take_rate_token(deps.limiter, user_id)
    pin = _pin(repo, conversation, access.role, ask.selected)
    if ask.question is not None:
        query_question = ask.question
    else:
        prior = repo.message(ask.question_message_id, user_id) if ask.question_message_id else None
        query_question = prior.text if prior is not None else ""
    query = " ".join(p for p in (query_question, pin.query_text if pin else "") if p)
    repo.rollback()
    retrieval = _retrieve(repo, deps, conversation.workspace_id, query, ask.scope)

    # The write transaction: re-authorize under the row locks, replay a concurrent duplicate.
    conversation, access = _owned_conversation(
        repo, user_id, conversation_id, Action.PRACTICE, LockMode.SHARE
    )
    if idempotency is not None:
        scope_name, key, body_hash = idempotency
        store.lock(user_id, scope_name, key)
        stored = store.find(user_id, scope_name, key)
        if stored is not None:
            return replay(stored, body_hash)
    try:
        answer_id, job_id, question_message_id = _write_answer(
            repo, settings, conversation, ask, pin, retrieval
        )
    except IntegrityError:
        # A concurrent request of the same user won the one-running-answer index.
        repo.rollback()
        raise ProblemException(
            409,
            ProblemType.ASK_ANSWER_RUNNING,
            detail="An answer is still being written. Wait for it or stop it.",
        ) from None
    question_row = repo.message(question_message_id, user_id)
    answer_row = repo.message(answer_id, user_id)
    assert question_row is not None  # noqa: S101 - just inserted
    assert answer_row is not None  # noqa: S101 - just inserted
    accepted = MessageAccepted(
        user_message=_message_out(question_row, [], None),
        answer=_message_out(answer_row, [], None),
        stream_url=f"/api/v1/ask/messages/{answer_id}/stream",
        job_id=job_id,
    )
    body = accepted.model_dump(mode="json")
    if idempotency is not None:
        scope_name, key, body_hash = idempotency
        store.save(user_id, scope_name, key, body_hash, 202, body)
    try:
        repo.commit()
    except IntegrityError:
        repo.rollback()
        raise ProblemException(
            409,
            ProblemType.ASK_ANSWER_RUNNING,
            detail="An answer is still being written. Wait for it or stop it.",
        ) from None
    _publish(repo, deps.publisher, accepted, conversation)
    return JSONResponse(body, status_code=202)


_ACCEPTED: dict[int | str, dict[str, Any]] = {
    202: {"model": MessageAccepted, "description": "Accepted: the answer is being made."}
}


@router.post(
    "/ask/conversations/{conversation_id}/messages",
    operation_id="askQuestion",
    status_code=202,
    response_model=MessageAccepted,
    responses={**_ACCEPTED, **problem_responses(409, 429, 503)},
)
def ask_question(
    conversation_id: uuid.UUID,
    body: MessageCreate,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    """Ask a question in the conversation; stream the answer from `stream_url`."""
    settings = deps.settings
    question = body.question.strip()

    def precheck() -> None:
        if not question:
            raise HTTPException(status_code=422, detail="The question must not be blank.")
        if len(question) > settings.ask_max_question_chars:
            raise ProblemException(
                422,
                ProblemType.QUESTION_TOO_LONG,
                detail=f"A question has at most {settings.ask_max_question_chars} characters.",
            )
        if repo.question_count(conversation_id) >= settings.ask_max_turns:
            raise ProblemException(
                409,
                ProblemType.ASK_TURN_LIMIT,
                detail=f"A conversation holds at most {settings.ask_max_turns} questions.",
            )

    conversation = repo.conversation(conversation_id, user.id)
    scope = (
        _scope_json(body.scope)
        if body.scope is not None
        else (conversation.scope if conversation is not None else _scope_json(None))
    )
    selected = (
        list(dict.fromkeys(body.selected_option_ids))
        if body.selected_option_ids is not None
        else None
    )
    idempotency = (
        (
            f"POST /ask/conversations/{conversation_id}/messages",
            idempotency_key,
            request_hash(body.model_dump(mode="json")),
        )
        if idempotency_key
        else None
    )
    return _accept(
        repo,
        deps,
        user.id,
        conversation_id,
        _Ask(
            question=question,
            question_message_id=None,
            scope=scope,
            selected=selected,
            scope_changed=body.scope is not None,
        ),
        idempotency=idempotency,
        precheck=precheck,
    )


def _again(
    message_id: uuid.UUID,
    user_id: uuid.UUID,
    repo: AskRepository,
    deps: AskDeps,
    idempotency_key: str | None,
    *,
    retry: bool,
) -> JSONResponse:
    message, conversation, _access = _owned_message(repo, user_id, message_id, Action.PRACTICE)
    settings = deps.settings

    def precheck() -> None:
        if message.role != "assistant" or message.question_message_id is None:
            raise HTTPException(status_code=422, detail="Only an answer can be made again.")
        if retry and message.status not in ("failed", "stopped"):
            raise ProblemException(
                409,
                ProblemType.ASK_NOT_RETRYABLE,
                detail="Only a failed or stopped answer can be retried.",
            )
        if repo.last_question_id(conversation.id) != message.question_message_id:
            raise ProblemException(
                409,
                ProblemType.ASK_NOT_LAST_ANSWER,
                detail="Only the last question of a conversation can be answered again.",
            )
        if repo.answer_versions(message.question_message_id) >= settings.ask_max_regenerations:
            raise ProblemException(
                409,
                ProblemType.ASK_REGENERATE_LIMIT,
                detail=f"A question has at most {settings.ask_max_regenerations} answers.",
            )

    action = "retry" if retry else "regenerate"
    idempotency = (
        (f"POST /ask/messages/{message_id}/{action}", idempotency_key, request_hash({}))
        if idempotency_key
        else None
    )
    return _accept(
        repo,
        deps,
        user_id,
        conversation.id,
        _Ask(
            question=None,
            question_message_id=message.question_message_id,
            scope=message.scope,
            selected=None,
            retry_of=message.id if retry else None,
            regenerated_from=None if retry else message.id,
        ),
        idempotency=idempotency,
        precheck=precheck,
    )


@router.post(
    "/ask/messages/{message_id}/retry",
    operation_id="retryAskAnswer",
    status_code=202,
    response_model=MessageAccepted,
    responses={**_ACCEPTED, **problem_responses(409, 429, 503)},
)
def retry_answer(
    message_id: uuid.UUID,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    """A new answer to the question of a failed or stopped answer (which stays)."""
    return _again(message_id, user.id, repo, deps, idempotency_key, retry=True)


@router.post(
    "/ask/messages/{message_id}/regenerate",
    operation_id="regenerateAskAnswer",
    status_code=202,
    response_model=MessageAccepted,
    responses={**_ACCEPTED, **problem_responses(409, 429, 503)},
)
def regenerate_answer(
    message_id: uuid.UUID,
    user: CurrentUser,
    repo: Repo,
    deps: Deps,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    """A new answer version of the conversation's last question (evidence searched again)."""
    return _again(message_id, user.id, repo, deps, idempotency_key, retry=False)


# --- routes: messages ---------------------------------------------------------------------------


@router.get("/ask/messages/{message_id}", operation_id="getAskMessage")
def get_message(message_id: uuid.UUID, user: CurrentUser, repo: Repo, reader: Reader) -> Message:
    """One message; while an answer streams, its text so far (the SSE fallback)."""
    message, _conversation, _access = _owned_message(repo, user.id, message_id, Action.READ)
    return _message_out(message, repo.sources([message.id]).get(message.id, []), reader)


@router.post("/ask/messages/{message_id}/cancel", operation_id="cancelAskAnswer")
def cancel_answer(message_id: uuid.UUID, user: CurrentUser, repo: Repo, reader: Reader) -> Message:
    """Stops an unfinished answer, keeping the text streamed so far (idempotent)."""
    message, _conversation, _access = _owned_message(repo, user.id, message_id, Action.READ)
    if message.role == "assistant" and not message.terminal:
        locked = repo.message(message_id, user.id, lock=True)
        if locked is not None and not locked.terminal:
            partial = ""
            if reader is not None:
                try:
                    partial = reader.text_so_far(message_id)
                except Exception as exc:
                    logger.warning("ask: stream read failed (%s)", type(exc).__name__)
            repo.cancel(message_id, partial)
            repo.commit()
    fresh = repo.message(message_id, user.id)
    assert fresh is not None  # noqa: S101 - owned above
    return _message_out(fresh, repo.sources([fresh.id]).get(fresh.id, []), reader)


@router.put("/ask/messages/{message_id}/feedback", operation_id="setAskFeedback")
def set_feedback(
    message_id: uuid.UUID, body: FeedbackInput, user: CurrentUser, repo: Repo
) -> Feedback:
    """ "도움이 안 됨" with one reason code (no free text), for the caller's own answer."""
    message, _conversation, _access = _owned_message(repo, user.id, message_id, Action.READ)
    if message.role != "assistant":
        raise HTTPException(status_code=422, detail="Feedback is for answers.")
    repo.set_feedback(message_id, user.id, body.reason)
    repo.commit()
    return Feedback(message_id=message_id, reason=body.reason)


# --- SSE ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AskStreamConfig:
    block_ms: int = 1000
    max_seconds: float = 600.0
    retry_ms: int = 1000


def get_ask_stream_config() -> AskStreamConfig:
    return AskStreamConfig()


@dataclass(frozen=True)
class _Polled:
    status: str
    error_code: str | None
    message: dict[str, Any] | None


StreamPoller = Callable[[uuid.UUID, uuid.UUID, bool], _Polled | None]


def get_ask_poller(request: Request) -> StreamPoller:
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")

    def poll(user_id: uuid.UUID, message_id: uuid.UUID, full: bool) -> _Polled | None:
        """The message if the caller may still read it (its own, a member); short session."""
        with database.read_sessionmaker() as session:
            repo = AskRepository(session)
            try:
                message, _c, _a = _owned_message(repo, user_id, message_id, Action.READ)
            except (HTTPException, ProblemException):
                return None
            body = None
            if full and message.terminal:
                sources = repo.sources([message.id]).get(message.id, [])
                body = _message_out(message, sources, None).model_dump(mode="json")
            return _Polled(message.status, message.error_code, body)

    return poll


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


async def _answer_events(
    request: Request,
    poll: StreamPoller,
    reader: AskStreamReader | None,
    config: AskStreamConfig,
    user_id: uuid.UUID,
    message_id: uuid.UUID,
    last_seq: int,
) -> AsyncIterator[str]:
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
            data = {
                "seq": entry.seq,
                **({"text": entry.data.get("text", "")} if entry.event == "delta" else {}),
            }
            out.append(_sse(entry.event, data, entry.seq))
        return out, None

    async def final(seq: int | None) -> str:
        polled = await run_in_threadpool(poll, user_id, message_id, True)
        if polled is None:
            return _sse("error", {"code": "not_found"}, seq)
        if polled.status == "failed":
            return _sse("error", {"code": polled.error_code or "ask_failed"}, seq)
        return _sse("done", {"message": polled.message or {}}, seq)

    while True:
        polled = await run_in_threadpool(poll, user_id, message_id, False)
        if polled is None:
            yield _sse("error", {"code": "not_found"}, None)
            return
        terminal = polled.status in ("succeeded", "no_sources", "stopped", "failed")
        # A message already finished when the client connects is one event from Postgres; one
        # that finishes while it is followed first gets the deltas still in the stream.
        if reader is None or (terminal and stream_id == "0-0" and last_seq == first_seq):
            if terminal:
                yield await final(None)
                return
            await asyncio.sleep(config.block_ms / 1000)
            continue
        try:
            entries = await run_in_threadpool(
                reader.read_after,
                message_id,
                stream_id,
                block_ms=0 if terminal else config.block_ms,
            )
        except Exception as exc:
            logger.warning("ask: stream read failed (%s)", type(exc).__name__)
            entries = []
            await asyncio.sleep(config.block_ms / 1000)
        events, end = deliver(entries)
        for event in events:
            yield event
        if end is not None or terminal:
            if terminal or end is None or end.event == "done":
                yield await final(end.seq if end is not None else None)
            else:
                yield _sse("error", {"code": str(end.data.get("code") or "ask_failed")}, end.seq)
            return
        if time.monotonic() - started >= config.max_seconds:
            return
        if await request.is_disconnected():
            return


@router.get(
    "/ask/messages/{message_id}/stream",
    operation_id="streamAskAnswer",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": (
                "Server-Sent Events: `delta {seq, text}` (the SSE `id` is `seq`; send "
                "`Last-Event-ID` to resume after it), `reset` (drop the text received so far), "
                "then one `done {message}` or `error {code}`. A finished answer is a single "
                "`done`/`error` from the database. Send the Bearer token in the Authorization "
                "header (fetch streaming, not EventSource); never in the URL."
            ),
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
)
async def stream_answer(
    message_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    poll: Annotated[StreamPoller, Depends(get_ask_poller)],
    reader: Reader,
    config: Annotated[AskStreamConfig, Depends(get_ask_stream_config)],
) -> StreamingResponse:
    """The answer's text as it is written (re-authorized on every poll)."""
    if await run_in_threadpool(poll, user.id, message_id, False) is None:
        raise HTTPException(status_code=404, detail=MESSAGE_NOT_FOUND)
    return StreamingResponse(
        _answer_events(request, poll, reader, config, user.id, message_id, _last_event_id(request)),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no"},
    )
