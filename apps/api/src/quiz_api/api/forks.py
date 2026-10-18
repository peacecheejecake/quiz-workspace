"""Workspace fork API (S3a, WS-FORK-01; docs/workspace-sharing.md §3, §5, §6).

    POST /shared/{shareId}/forks   start a fork of the shared workspace: 202 + Fork (job id)
    GET  /me/forks/{forkId}        the caller's own fork: status, progress, new workspace id

Starting a fork needs BOTH capabilities: a Supabase user (Bearer JWT; the copy is owned by
`sub`) and a guest share session of this link (`quiz_share_session` cookie, re-validated in the
DB), plus an allowlisted `Origin` (CSRF). Order of checks:
  1. no / invalid JWT                                                  → 401
  2. missing or foreign `Origin`                                       → 403
  3. no / malformed / forged share session                             → 403 share-session-required
  4. session of another link, unknown / revoked / expired link,
     deleted source workspace                                          → 404 share-unavailable
  5. the link does not allow forking                                   → 403 fork-not-allowed
  6. more than SHARE_FORK_RATE_LIMIT_PER_MINUTE starts per user        → 429 + Retry-After
  7. `Idempotency-Key`: same key + same body → the same fork (202, current state); same key +
     another body → 409 idempotency-key-reused
  8. snapshot over MAX_FORK_DOCUMENTS / MAX_FORK_QUESTIONS, or a manifest over the
     column's 4 MiB (measured as JSONB in the DB)                      → 409 fork-too-large

The request pins the published snapshot and enqueues the `workspace.fork` job
(`quiz_api.repositories.forks`); the worker copies it and re-checks the link right before its
commit, so a revoke / expiry / fork OFF / source delete before that commit ends the fork
CANCELLED without leaving data. `target_workspace_id` is null until COMPLETED. The fork job is
not visible through `/jobs/{id}` (it lives in the source workspace); `/me/forks/{id}` is the only
status route, and only for the user who forked.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.shared import (
    SessionKey,
    SharedRepo,
    ShareIdPath,
    allowed_origin,
    verify_share_session,
)
from quiz_api.api.workspaces import WorkspaceName
from quiz_api.auth import CurrentUser
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import REPLAYED_HEADER, IdempotencyKey, request_hash
from quiz_api.jobs import JobMessage, JobPublisher
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.forks import (
    ForkJob,
    ForkRecord,
    ForkRepository,
    ForkStatus,
    ForkTooLargeError,
)
from quiz_api.repositories.idempotency import IdempotencyStore

logger = logging.getLogger(__name__)

router = APIRouter(tags=["forks"], responses=problem_responses(503))

FORK_NOT_FOUND = "Fork not found."
MAX_FORK_DOCUMENTS = 500
MAX_FORK_QUESTIONS = 20_000
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ForkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: WorkspaceName = Field(description="Name of the new workspace.")


class Fork(BaseModel):
    """A fork request of the caller (never the source owner, manifest or link)."""

    id: uuid.UUID
    job_id: uuid.UUID | None = Field(description="The `workspace.fork` job (202 Accepted).")
    status: ForkStatus = Field(description="PENDING | COPYING | COMPLETED | FAILED | CANCELLED")
    progress: int = Field(ge=0, le=100, description="0-100 (100 once COMPLETED).")
    name: str = Field(description="Name of the new workspace.")
    target_workspace_id: uuid.UUID | None = Field(
        description="The new workspace, owned by the caller; null until COMPLETED."
    )
    error_code: str | None = Field(
        description=(
            "Why a fork ended FAILED or CANCELLED, e.g. `share_unavailable` (the link was "
            "revoked, expired, set to no-fork or its workspace deleted while copying)."
        )
    )
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


# --- dependencies -------------------------------------------------------------------------------


def get_fork_repository(session: Annotated[Session, Depends(get_db_session)]) -> ForkRepository:
    return ForkRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


def get_fork_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(request.app.state, "share_fork_limiter", None)
    if limiter is None:
        rate = request.app.state.settings.share_fork_rate_per_minute
        limiter = request.app.state.share_fork_limiter = TokenBucketLimiter(rate, max(1, rate))
    return limiter


ForkRepo = Annotated[ForkRepository, Depends(get_fork_repository)]
IdempotencyDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
LimiterDep = Annotated[TokenBucketLimiter, Depends(get_fork_limiter)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]


# --- helpers ------------------------------------------------------------------------------------


def _error_code(fork: ForkRecord) -> str | None:
    if fork.status not in ("FAILED", "CANCELLED"):
        return None
    code = (fork.last_error or "").split(":", 1)[0].strip()
    if _CODE.fullmatch(code):
        return code
    return "cancelled" if fork.status == "CANCELLED" else "fork_failed"


def _out(fork: ForkRecord) -> Fork:
    return Fork(
        id=fork.id,
        job_id=fork.async_job_id,
        status=fork.status,
        progress=fork.progress,
        name=fork.name,
        target_workspace_id=fork.target_workspace_id,
        error_code=_error_code(fork),
        created_at=fork.created_at,
        updated_at=fork.updated_at,
        completed_at=fork.completed_at,
    )


def _publish(repo: ForkRepository, publisher: JobPublisher | None, job: ForkJob | None) -> None:
    """Hand a queued, unpublished job to the broker; on failure the reconciler publishes it."""
    if job is None or publisher is None or job.status != "queued" or job.published_at is not None:
        return
    message = JobMessage(
        job_id=job.id,
        job_type=job.job_type,
        schema_version=job.schema_version,
        workspace_id=job.workspace_id,
        created_by=job.created_by,
        idempotency_key=job.idempotency_key,
        payload=job.payload,
    )
    try:
        publisher.publish(message)
    except Exception as exc:
        logger.warning("job publish failed (reconciler will retry): %s", type(exc).__name__)
        return
    repo.mark_published(job.id)
    repo.commit()


def _too_large() -> ProblemException:
    return ProblemException(
        409, ProblemType.FORK_TOO_LARGE, detail="This workspace is too large to fork."
    )


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/shared/{share_id}/forks",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="startWorkspaceFork",
    responses=problem_responses(409, 429),
)
def start_fork(
    share_id: ShareIdPath,
    body: ForkCreate,
    request: Request,
    response: Response,
    user: CurrentUser,
    shared_repo: SharedRepo,
    key: SessionKey,
    repo: ForkRepo,
    idempotency: IdempotencyDep,
    limiter: LimiterDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Fork:
    """Fork the shared workspace into a new workspace of the caller (WS-FORK-01-AC02/AC04).

    Needs the user's Bearer JWT and the share session cookie of this link, and the link must
    allow forking. Copies the published documents, questions, answers and explanations; never
    drafts, other people's progress, activity or share links. 202 with the fork; poll
    `GET /me/forks/{id}`.
    """
    if not allowed_origin(request):
        raise HTTPException(status_code=403, detail="Origin not allowed.")
    link = verify_share_session(share_id, request, shared_repo, key, session_required_status=403)
    if not link.allow_fork:
        raise ProblemException(
            403, ProblemType.FORK_NOT_ALLOWED, detail="This share link does not allow forking."
        )
    wait = limiter.acquire(f"fork:{user.id}")
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many forks. Wait a moment and try again.",
            headers={"Retry-After": retry_after_header(wait)},
        )

    scope = f"POST /shared/{link.id}/forks"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user.id, scope, idempotency_key)
        stored = idempotency.find(user.id, scope, idempotency_key)
        if stored is not None:
            if stored.request_hash != body_hash:
                raise ProblemException(
                    409,
                    ProblemType.IDEMPOTENCY_KEY_REUSED,
                    detail="This Idempotency-Key was already used with a different request body.",
                )
            body_id = stored.body.get("id") if isinstance(stored.body, dict) else None
            fork_id = _uuid(str(body_id)) if body_id else None
            existing = repo.get_for_user(fork_id, user.id) if fork_id else None
            if existing is not None:
                job = repo.job(existing.async_job_id) if existing.async_job_id else None
                repo.rollback()
                _publish(repo, publisher, job)  # recovers a publish that failed the first time
                response.headers[REPLAYED_HEADER] = "true"
                return _out(existing)

    snapshot = repo.snapshot(link.workspace_id)
    if len(snapshot.documents) > MAX_FORK_DOCUMENTS or len(snapshot.questions) > MAX_FORK_QUESTIONS:
        raise _too_large()
    try:
        fork, job = repo.create(
            source_workspace_id=link.workspace_id,
            source_workspace_name=link.workspace_name,
            share_link_id=link.id,
            user_id=user.id,
            name=body.name,
            snapshot=snapshot,
        )
    except ForkTooLargeError:
        raise _too_large() from None
    if idempotency_key is not None:
        idempotency.save(user.id, scope, idempotency_key, body_hash, 202, {"id": str(fork.id)})
    repo.commit()
    _publish(repo, publisher, job)
    return _out(fork)


@router.get("/me/forks/{fork_id}", operation_id="getMyFork")
def get_my_fork(
    fork_id: Annotated[str, Path(max_length=64)], user: CurrentUser, repo: ForkRepo
) -> Fork:
    """Status of one of the caller's forks (WS-FORK-01-AC04); anyone else's is 404."""
    fid = _uuid(fork_id)
    fork = repo.get_for_user(fid, user.id) if fid else None
    if fork is None:
        raise HTTPException(status_code=404, detail=FORK_NOT_FOUND)
    return _out(fork)
