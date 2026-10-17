"""Guest share session and shared read API (S1b, WS-VIEW-01; docs/workspace-sharing.md §2-§5).

    POST /shared/{shareId}/sessions               exchange the link secret (from the URL
                                                  fragment) for a share session cookie; 204
    GET  /shared/{shareId}                        workspace name, fork policy, published documents
    GET  /shared/{shareId}/documents/{docId}      published revision: outline + blocks (paged)
    GET  /shared/{shareId}/documents/{docId}/pdf  the original PDF, proxied (no signed URL leaves
                                                  the server)
    POST /shared/{shareId}/search                 search over the published documents
    GET  /shared/{shareId}/questions              CONFIRMED questions, answers included
    GET  /shared/{shareId}/questions/{questionId} one CONFIRMED question

Share session (`quiz_api.share_sessions`): `quiz_share_session` cookie, `HttpOnly; Secure;
SameSite=Lax; Path=/api/v1/shared/{shareId}`, `Max-Age` = SHARE_SESSION_TTL_SECONDS (≤ 8 h). It
is a separate capability, never a Supabase login and never a membership: the member API answers
401 to it, and these routes ignore any `Authorization` header (everything here is the same for
signed-in and anonymous guests).

Order of checks on every read (the share check runs before anything else, path and body
validation included):
  1. no / malformed / expired / forged session cookie                 → 401 share-session-required
  2. a session of another link, or a link that is unknown, revoked,
     expired, or whose workspace is (being) deleted                     → 404 share-unavailable
     (one body: the session is over; the guest needs a new link)
  3. the resource: the link's workspace only (never a client-supplied workspace id); documents
     with a *published* active revision, CONFIRMED live questions. Anything else, including ids
     of other workspaces, drafts, archived/deleted questions and import drafts, is a 404 with the
     same body as a random id.

Exchange: an allowlisted `Origin` is required (403 otherwise; CSRF), then the per-client and link
rate limit (429 + Retry-After), then unknown id / wrong secret / unusable link → the same 404
share-unavailable body (constant-time digest comparison; no existence oracle).

Never exposed: drafts and unpublished revisions, per-user study state, attempts, practice
sessions, owner identity (ids, email), share-link secrets or digests, Storage keys or signed URLs.
Every response is `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow` (`NoStoreMiddleware`). The secret and the cookie value are never
logged; the access log records the path only.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.orm import Session

from quiz_api.api.document_revisions import (
    MAX_PAGE_SIZE as MAX_BLOCK_PAGE,
)
from quiz_api.api.document_revisions import (
    ContentBlock,
    OutlineItem,
    _block,
    _outline_item,
)
from quiz_api.api.documents import StorageDep
from quiz_api.api.questions import (
    MAX_CURSOR,
    ChapterRef,
    QuestionRevision,
    QuestionSource,
    _decode_cursor,
    _encode_cursor,
    _revision_out,
)
from quiz_api.api.search import (
    CHAPTER_NOT_FOUND,
    DOCUMENT_NOT_FOUND,
    Engine,
    SearchItem,
    SearchRequest,
    get_search_limiter,
    run_search,
)
from quiz_api.db import get_db_session
from quiz_api.document_content import outline_tree
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.question_rules import QuestionType
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.relay_client import client_key, relay_configured
from quiz_api.repositories.document_content import DocumentContentRepository
from quiz_api.repositories.questions import QuestionFilter, QuestionRecord, QuestionRepository
from quiz_api.repositories.search import SearchableDocument, SearchRepository
from quiz_api.repositories.shared import SharedLink, SharedRepository
from quiz_api.settings import Settings, normalize_origin
from quiz_api.share_secrets import DIGEST_BYTES, secret_matches
from quiz_api.share_sessions import (
    SHARE_COOKIE,
    ShareSessionKey,
    issue_token,
    parse_token,
    verify_token,
)
from quiz_api.storage import SOURCE_BUCKET, StorageUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503))

# Where the share cookie is sent (the API's /shared routes of this link only).
SHARED_PATH_PREFIX = "/api/v1/shared"
SHARE_UNAVAILABLE = "This share link is not available."
SESSION_REQUIRED = "Open the share link again to start a session."
NOT_FOUND = "Not found."
DEFAULT_BLOCK_PAGE = MAX_BLOCK_PAGE
DEFAULT_QUESTION_PAGE = 100
MAX_QUESTION_PAGE = 200
MAX_SECRET_CHARS = 256
_DUMMY_DIGEST = bytes(DIGEST_BYTES)

ShareIdPath = Annotated[str, Path(max_length=64, description="The share link id (`/share/{id}`).")]


# --- schemas ------------------------------------------------------------------------------------


class SessionExchange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    secret: Annotated[str, StringConstraints(max_length=MAX_SECRET_CHARS)] = Field(
        description="The `k` value of the share URL fragment (`#k=…`), sent once."
    )


class SharedWorkspaceInfo(BaseModel):
    name: str
    archived: bool = Field(description="Archived workspaces stay readable through the link.")


class SharedDocumentSummary(BaseModel):
    id: uuid.UUID
    title: str
    document_type: str = Field(description="`book` or `question_paper`.")
    revision_id: uuid.UUID = Field(description="The published revision shown to guests.")


class SharedWorkspace(BaseModel):
    workspace: SharedWorkspaceInfo
    allow_fork: bool = Field(description="Signed-in guests may fork (WS-VIEW-01-AC06).")
    expires_at: datetime | None = Field(description="When the link expires; null: never.")
    documents: list[SharedDocumentSummary] = Field(
        description="Documents with a published revision, oldest first."
    )


class SharedDocument(BaseModel):
    id: uuid.UUID
    title: str
    document_type: str
    revision_id: uuid.UUID
    outline: list[OutlineItem] = Field(description="Chapter/section tree of the revision.")
    blocks: list[ContentBlock] = Field(description="Blocks in reading order (one page).")
    next_after: int | None = Field(description="Pass as `after` for the next page of blocks.")


class SharedSearchResponse(BaseModel):
    mode: Literal["keyword", "semantic", "hybrid"]
    query_language: str | None = Field(description="Script hint: `ko`, `en`, `mixed` or null.")
    truncated: bool = Field(description="The query was cut to the maximum length.")
    warnings: list[str]
    items: list[SearchItem]


class SharedQuestion(BaseModel):
    """A published question with its answer and explanation; no per-user or owner fields."""

    id: uuid.UUID
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    chapter: ChapterRef | None
    question_number: int | None
    revision: QuestionRevision = Field(description="The active (published) revision.")
    sources: list[QuestionSource] = Field(description="Sources in shared documents only.")
    updated_at: datetime


class SharedQuestionList(BaseModel):
    items: list[SharedQuestion]
    next_cursor: str | None


# --- dependencies -------------------------------------------------------------------------------


def get_shared_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> SharedRepository:
    return SharedRepository(session)


SharedRepo = Annotated[SharedRepository, Depends(get_shared_repository)]


def get_session_key(request: Request) -> ShareSessionKey:
    state = request.app.state
    if state.settings.is_deployed and not relay_configured(state.settings):
        # Without the relay secret every guest would share the relay's rate-limit buckets.
        raise HTTPException(status_code=503, detail="Shared access is not configured.")
    key: ShareSessionKey | None = getattr(state, "share_session_key", None)
    if key is not None:
        return key
    settings: Settings = state.settings
    secret = settings.share_session_secret
    if secret is not None and secret.get_secret_value():
        key = ShareSessionKey.from_secret(secret.get_secret_value())
    elif settings.is_deployed:
        raise HTTPException(status_code=503, detail="Shared access is not configured.")
    else:
        key = ShareSessionKey.random()
    state.share_session_key = key
    return key


SessionKey = Annotated[ShareSessionKey, Depends(get_session_key)]


@dataclass(frozen=True)
class ExchangeLimiters:
    per_client: TokenBucketLimiter
    per_link: TokenBucketLimiter


def get_exchange_limiters(request: Request) -> ExchangeLimiters:
    state = request.app.state
    limiters: ExchangeLimiters | None = getattr(state, "share_exchange_limiters", None)
    if limiters is None:
        client_rate = state.settings.share_exchange_rate_per_minute
        link_rate = state.settings.share_exchange_link_rate_per_minute
        limiters = state.share_exchange_limiters = ExchangeLimiters(
            per_client=TokenBucketLimiter(client_rate, max(1, client_rate)),
            per_link=TokenBucketLimiter(link_rate, max(1, link_rate)),
        )
    return limiters


def _too_many(wait: float, detail: str) -> HTTPException:
    return HTTPException(
        status_code=429, detail=detail, headers={"Retry-After": retry_after_header(wait)}
    )


def _unavailable() -> ProblemException:
    return ProblemException(404, ProblemType.SHARE_UNAVAILABLE, detail=SHARE_UNAVAILABLE)


def _session_required() -> ProblemException:
    return ProblemException(401, ProblemType.SHARE_SESSION_REQUIRED, detail=SESSION_REQUIRED)


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def require_shared_link(
    share_id: ShareIdPath, request: Request, repo: SharedRepo, key: SessionKey
) -> SharedLink:
    """The share check of every read: a valid session of THIS link, re-validated in the DB."""
    raw = request.cookies.get(SHARE_COOKIE)
    claims = parse_token(raw)
    if raw is None or claims is None:
        raise _session_required()
    link = repo.link(claims.link_id)
    # MAC first (a forged token learns nothing about the link), against the dummy digest when the
    # id is unknown so both paths do the same work.
    if not verify_token(key, raw, claims, link.token_digest if link else _DUMMY_DIGEST):
        raise _session_required()
    if link is None or not link.usable or _uuid(share_id) != link.id:
        raise _unavailable()
    return link


Shared = Annotated[SharedLink, Depends(require_shared_link)]


def shared_search_rate_limit(
    link: Shared,
    request: Request,
    limiter: Annotated[TokenBucketLimiter, Depends(get_search_limiter)],
) -> None:
    wait = limiter.acquire(f"shared-search:{link.id}:{client_key(request)}")
    if wait is not None:
        raise _too_many(wait, "Too many searches. Wait a moment and try again.")


# --- helpers ------------------------------------------------------------------------------------


def _published(
    search_repo: SearchRepository, link: SharedLink
) -> dict[uuid.UUID, SearchableDocument]:
    return {d.id: d for d in search_repo.searchable_documents(link.workspace_id)}


def _shared_document(
    search_repo: SearchRepository, link: SharedLink, document_id: str
) -> SearchableDocument:
    doc_id = _uuid(document_id)
    doc = _published(search_repo, link).get(doc_id) if doc_id else None
    if doc is None:
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND)
    return doc


def _question_out(q: QuestionRecord, published: set[uuid.UUID]) -> SharedQuestion:
    chapter = q.chapter if q.chapter and q.chapter.document_id in published else None
    return SharedQuestion(
        id=q.id,
        question_type=q.question_type,
        chapter_id=chapter.id if chapter else None,
        chapter=ChapterRef(id=chapter.id, document_id=chapter.document_id, title=chapter.title)
        if chapter
        else None,
        question_number=q.question_number,
        revision=_revision_out(q.revision),
        sources=[
            QuestionSource(
                document_id=s.document_id,
                document_revision_id=s.document_revision_id,
                page_start=s.page_start,
                page_end=s.page_end,
            )
            for s in q.sources
            if s.document_id in published
        ],
        updated_at=q.updated_at,
    )


def get_search_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> SearchRepository:
    return SearchRepository(session)


def get_content_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> DocumentContentRepository:
    return DocumentContentRepository(session)


def get_question_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionRepository:
    return QuestionRepository(session)


SearchRepo = Annotated[SearchRepository, Depends(get_search_repository)]
ContentRepo = Annotated[DocumentContentRepository, Depends(get_content_repository)]
QuestionRepo = Annotated[QuestionRepository, Depends(get_question_repository)]


# --- session exchange ---------------------------------------------------------------------------


def _allowed_origin(request: Request) -> bool:
    raw = request.headers.get("origin")
    if raw is None or not raw.isascii():
        return False
    try:
        origin = normalize_origin(raw)
    except ValueError:
        return False
    settings: Settings = request.app.state.settings
    return origin in settings.effective_cors_origins


@router.post(
    "/sessions",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="createSharedSession",
    responses=problem_responses(429),
)
def create_shared_session(
    share_id: ShareIdPath,
    request: Request,
    repo: SharedRepo,
    key: SessionKey,
    limiters: Annotated[ExchangeLimiters, Depends(get_exchange_limiters)],
    body: SessionExchange,
) -> Response:
    """Exchange the link secret for a read-only share session cookie (WS-VIEW-01-AC01).

    Needs an allowlisted `Origin` (the web app). Unknown link, wrong secret, revoked or expired
    link and deleted workspace all answer the same 404. The secret is never stored or logged.
    """
    if not _allowed_origin(request):
        raise HTTPException(status_code=403, detail="Origin not allowed.")
    # Per client (behind the relay: the client it vouches for, quiz_api.relay_client) and a
    # ceiling per link across all clients.
    wait = limiters.per_client.acquire(f"share-exchange:{client_key(request)}:{share_id}")
    if wait is None:
        wait = limiters.per_link.acquire(f"share-exchange-link:{share_id}")
    if wait is not None:
        raise _too_many(wait, "Too many attempts. Wait a moment and try again.")
    link_id = _uuid(share_id)
    link = repo.link(link_id) if link_id else None
    matches = secret_matches(body.secret, link.token_digest if link else _DUMMY_DIGEST)
    if link is None or not matches or not link.usable:
        raise _unavailable()
    settings: Settings = request.app.state.settings
    ttl = settings.share_session_ttl_seconds
    value, _ = issue_token(key, link.id, link.token_digest, ttl)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.set_cookie(
        SHARE_COOKIE,
        value,
        max_age=ttl,
        path=f"{SHARED_PATH_PREFIX}/{link.id}",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


# --- reads --------------------------------------------------------------------------------------


@router.get("", operation_id="getSharedWorkspace")
def get_shared_workspace(link: Shared, search_repo: SearchRepo) -> SharedWorkspace:
    """The shared workspace: name, fork policy and published documents (WS-VIEW-01-AC01/AC06)."""
    docs = search_repo.searchable_documents(link.workspace_id)
    return SharedWorkspace(
        workspace=SharedWorkspaceInfo(name=link.workspace_name, archived=link.archived),
        allow_fork=link.allow_fork,
        expires_at=link.expires_at,
        documents=[
            SharedDocumentSummary(
                id=d.id, title=d.title, document_type=d.document_type, revision_id=d.revision_id
            )
            for d in docs
        ],
    )


@router.get("/documents/{document_id}", operation_id="getSharedDocument")
def get_shared_document(
    link: Shared,
    document_id: Annotated[str, Path(max_length=64)],
    search_repo: SearchRepo,
    content: ContentRepo,
    page: Annotated[int | None, Query(ge=1, description="Only blocks starting on this page.")] = (
        None
    ),
    after: Annotated[
        int | None, Query(ge=-1, description="`next_after` of the previous page.")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_BLOCK_PAGE)] = DEFAULT_BLOCK_PAGE,
) -> SharedDocument:
    """The published revision of a document: outline and blocks (WS-VIEW-01-AC01/AC02).

    Only the active published revision; drafts and older revisions are never reachable here.
    """
    doc = _shared_document(search_repo, link, document_id)
    rows = content.blocks(doc.revision_id, page=page, after=after, limit=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    return SharedDocument(
        id=doc.id,
        title=doc.title,
        document_type=doc.document_type,
        revision_id=doc.revision_id,
        outline=[_outline_item(n) for n in outline_tree(content.chapters(doc.revision_id))],
        blocks=[_block(row) for row in rows],
        next_after=rows[-1]["ordinal"] if more and rows else None,
    )


@router.get(
    "/documents/{document_id}/pdf",
    operation_id="getSharedDocumentPdf",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/pdf": {}}, "description": "The original PDF."}},
)
def get_shared_document_pdf(
    link: Shared,
    document_id: Annotated[str, Path(max_length=64)],
    search_repo: SearchRepo,
    repo: SharedRepo,
    storage: StorageDep,
) -> StreamingResponse:
    """The original PDF of a shared document, streamed through the API (WS-VIEW-01-AC02).

    The private bucket is read server-side after the share check; no signed Storage URL is
    handed to the guest.
    """
    doc = _shared_document(search_repo, link, document_id)
    object_key = repo.source_object_key(link.workspace_id, doc.id)
    repo.end_read()
    if object_key is None:  # pragma: no cover - deleted between the two reads
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND)
    try:
        stream = storage.open_read(SOURCE_BUCKET, object_key)
    except StorageUnavailableError:
        raise HTTPException(
            status_code=503, detail="File storage is temporarily unavailable."
        ) from None
    if stream is None:
        logger.warning("shared pdf: source object missing")
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND)

    def body() -> Iterator[bytes]:
        try:
            yield from stream.chunks
        finally:
            stream.close()

    headers = {"Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"}
    if stream.size is not None:
        headers["Content-Length"] = str(stream.size)
    return StreamingResponse(body(), media_type="application/pdf", headers=headers)


@router.post(
    "/search",
    operation_id="searchSharedWorkspace",
    responses=problem_responses(429),
    dependencies=[Depends(shared_search_rate_limit)],
)
def search_shared_workspace(
    link: Shared, body: SearchRequest, search_repo: SearchRepo, engine: Engine
) -> SharedSearchResponse:
    """Search the published documents of the shared workspace (WS-VIEW-01-AC02).

    Same request and result items as the member search; `document_ids` must name shared
    (published) documents. The query is not echoed back.
    """
    published = _published(search_repo, link)
    if body.document_ids and any(d not in published for d in body.document_ids):
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND)
    if body.chapter_ids:
        # Only outline ids of the shared (published, active) revisions; ids of drafts, older
        # revisions or other workspaces are the same 404 as unknown ids (no existence oracle).
        shared_chapters = {
            c.id for c in search_repo.chapters_of([d.revision_id for d in published.values()])
        }
        if any(c not in shared_chapters for c in body.chapter_ids):
            raise HTTPException(status_code=404, detail=CHAPTER_NOT_FOUND)
    result = run_search(search_repo, engine, link.workspace_id, body)
    return SharedSearchResponse(**result.model_dump(exclude={"query"}))


@router.get("/questions", operation_id="listSharedQuestions")
def list_shared_questions(
    link: Shared,
    questions: QuestionRepo,
    search_repo: SearchRepo,
    question_type: Annotated[QuestionType | None, Query()] = None,
    chapter_id: Annotated[uuid.UUID | None, Query()] = None,
    document_id: Annotated[
        uuid.UUID | None, Query(description="Questions with a source in this document.")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_QUESTION_PAGE)] = DEFAULT_QUESTION_PAGE,
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR)] = None,
) -> SharedQuestionList:
    """CONFIRMED questions in bank order, answers and explanations included (WS-VIEW-01-AC01).

    Reading records nothing (no view, favourite, retry or attempt state).
    """
    flt = QuestionFilter(
        statuses=["CONFIRMED"],
        question_type=question_type,
        chapter_id=chapter_id,
        document_id=document_id,
    )
    after = _decode_cursor(cursor) if cursor else None
    items, next_cursor = questions.list_page(link.workspace_id, flt, limit=limit, after=after)
    published = set(_published(search_repo, link))
    return SharedQuestionList(
        items=[_question_out(q, published) for q in items],
        next_cursor=_encode_cursor(next_cursor) if next_cursor else None,
    )


@router.get("/questions/{question_id}", operation_id="getSharedQuestion")
def get_shared_question(
    link: Shared,
    question_id: Annotated[str, Path(max_length=64)],
    questions: QuestionRepo,
    search_repo: SearchRepo,
) -> SharedQuestion:
    """One CONFIRMED question of the shared workspace; anything else is the same 404."""
    qid = _uuid(question_id)
    found = questions.get(qid) if qid else None
    if (
        found is None
        or found.workspace_id != link.workspace_id
        or found.publication_status != "CONFIRMED"
    ):
        raise _not_found()
    return _question_out(found, set(_published(search_repo, link)))
