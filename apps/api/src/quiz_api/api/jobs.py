"""Async job status (M3.2b; docs/architecture.md §6).

    GET /jobs/{id}         any member of the job's workspace; status, progress, error code
    GET /jobs/{id}/events  same access; Server-Sent Events until the job is terminal

Both read `async_jobs` (the worker's durable state), never Celery's result backend. A job of a
workspace the caller cannot see answers the same 404 as a missing one (ResourceType.JOB).

Streaming auth: the stream uses the same `Authorization: Bearer` header as every other route, so
browsers consume it with `fetch()` + a stream reader (EventSource cannot send headers). No token
or ticket ever goes into a URL (URLs end up in logs, history and Referer), and no second
credential type exists to leak or revoke. Because one request can outlive the checks of a normal
request, the stream re-runs the authorization query on every poll (a removed membership or a
deleted workspace ends it) and closes after `max_seconds`; the client then reconnects with a
fresh access token (`retry:` hint). The stream holds no DB connection between polls.

Events (`text/event-stream`):
    event: job   data: <Job JSON>   on connect and whenever status/progress/error change
    : keep-alive                    comment every `heartbeat_seconds` without a change
    event: gone  data: {}           the job stopped being visible (stream ends)
The stream ends after sending a terminal status (succeeded, failed, cancelled).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    Action,
    ResourceAccess,
    ResourceType,
    SqlAccessRepository,
    authorize_resource,
    require_resource_access,
)
from quiz_api.db import Database, get_db_session
from quiz_api.errors import ProblemException
from quiz_api.repositories.jobs import JobRepository, JobStatus, JobView

router = APIRouter(tags=["jobs"])

JOB_NOT_FOUND = "Job not found."


class Job(BaseModel):
    id: uuid.UUID
    job_type: str = Field(description="e.g. `document.parse`.")
    status: JobStatus = Field(description="queued | running | succeeded | failed | cancelled")
    progress: int | None = Field(
        description="0-100 while running (100 once succeeded); null when unknown.", ge=0, le=100
    )
    stage: str | None = Field(
        description="Current step while running, e.g. `parsing`, `indexing`; null otherwise."
    )
    error_code: str | None = Field(
        description="Stable reason of a failed (or `cancelled`) job, e.g. `parse_failed`."
    )
    attempts: int
    max_attempts: int
    cancel_requested: bool
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


def _job(view: JobView) -> Job:
    return Job(
        id=view.id,
        job_type=view.job_type,
        status=view.status,
        progress=view.progress,
        stage=view.stage,
        error_code=view.error_code,
        attempts=view.attempts,
        max_attempts=view.max_attempts,
        cancel_requested=view.cancel_requested,
        created_at=view.created_at,
        updated_at=view.updated_at,
        started_at=view.started_at,
        finished_at=view.finished_at,
    )


# --- dependencies -------------------------------------------------------------------------------


def get_job_repository(session: Annotated[Session, Depends(get_db_session)]) -> JobRepository:
    return JobRepository(session)


# (user_id, job_id) -> the job if the user may still read it, else None. Opens its own short
# session per call, so a long stream never pins a pooled connection.
JobPoller = Callable[[uuid.UUID, uuid.UUID], JobView | None]


def get_job_poller(request: Request) -> JobPoller:
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")

    def poll(user_id: uuid.UUID, job_id: uuid.UUID) -> JobView | None:
        with database.sessionmaker() as session:
            try:
                authorize_resource(
                    SqlAccessRepository(session), user_id, ResourceType.JOB, job_id, Action.READ
                )
            except (HTTPException, ProblemException):
                return None
            return JobRepository(session).get(job_id)

    return poll


@dataclass(frozen=True)
class JobEventsConfig:
    poll_seconds: float = 1.0
    heartbeat_seconds: float = 15.0
    # Upper bound of one stream; the client reconnects (with a current access token).
    max_seconds: float = 300.0
    retry_ms: int = 2000


def get_job_events_config() -> JobEventsConfig:
    return JobEventsConfig()


def get_session_release(
    session: Annotated[Session, Depends(get_db_session)],
) -> Callable[[], None]:
    """Ends the request session (and its transaction) before a long response starts streaming:
    request-scoped dependencies are only torn down after the response has been sent."""
    return session.close


JobAccess = Annotated[
    ResourceAccess, Depends(require_resource_access(ResourceType.JOB, Action.READ, param="job_id"))
]


# --- routes -------------------------------------------------------------------------------------


@router.get("/jobs/{job_id}", operation_id="getJob")
def get_job(access: JobAccess, repo: Annotated[JobRepository, Depends(get_job_repository)]) -> Job:
    """Current status of an async job (poll this, or stream `/jobs/{id}/events`)."""
    view = repo.get(access.resource_id)
    if view is None:  # deleted between the authorization query and this read
        raise HTTPException(status_code=404, detail=JOB_NOT_FOUND)
    return _job(view)


@router.get(
    "/jobs/{job_id}/events",
    operation_id="streamJobEvents",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": (
                "Server-Sent Events: `event: job` with a `Job` JSON body on connect and on every "
                "change, `: keep-alive` comments, `event: gone` if access ends. The stream ends "
                "after a terminal status or after a few minutes (reconnect). Send the Bearer "
                "token in the Authorization header (use fetch streaming, not EventSource)."
            ),
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
)
async def stream_job_events(
    access: JobAccess,
    request: Request,
    user: CurrentUser,
    poller: Annotated[JobPoller, Depends(get_job_poller)],
    config: Annotated[JobEventsConfig, Depends(get_job_events_config)],
    release_session: Annotated[Callable[[], None], Depends(get_session_release)],
) -> StreamingResponse:
    """Status transitions and progress of a job as Server-Sent Events."""
    job_id = access.resource_id
    release_session()
    return StreamingResponse(
        _events(request, poller, config, user.id, job_id),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no"},
    )


def _event(name: str, data: dict[str, Any], event_id: int) -> str:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"id: {event_id}\nevent: {name}\ndata: {body}\n\n"


async def _events(
    request: Request,
    poller: JobPoller,
    config: JobEventsConfig,
    user_id: uuid.UUID,
    job_id: uuid.UUID,
) -> AsyncIterator[str]:
    yield f"retry: {config.retry_ms}\n\n"
    started = last_sent = time.monotonic()
    previous: dict[str, Any] | None = None
    event_id = 0
    while True:
        view = await run_in_threadpool(poller, user_id, job_id)
        if view is None:
            event_id += 1
            yield _event("gone", {}, event_id)
            return
        current = _job(view).model_dump(mode="json")
        changed = previous is None or {k: v for k, v in current.items() if k != "updated_at"} != {
            k: v for k, v in previous.items() if k != "updated_at"
        }
        now = time.monotonic()
        if changed:
            event_id += 1
            yield _event("job", current, event_id)
            previous, last_sent = current, now
        elif now - last_sent >= config.heartbeat_seconds:
            yield ": keep-alive\n\n"
            last_sent = now
        if view.terminal or now - started >= config.max_seconds:
            return
        await asyncio.sleep(config.poll_seconds)
        if await request.is_disconnected():
            return
