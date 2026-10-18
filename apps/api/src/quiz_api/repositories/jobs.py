"""Job status reads for `GET /jobs/{id}` and its SSE stream (M3.2b).

The status comes from `async_jobs` (the worker's JobStore writes it), never from Celery's result
backend. Only presentable fields leave this module: `last_error` is reduced to its stable code
(`<code>: ...` as written by the worker's sanitizer) and the running job's progress is read from
`result.progress` (`{"stage", "percent"}`, apps/worker document_store); the result itself and the
payload are internal.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import async_jobs

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
TERMINAL_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})

_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_STAGE = re.compile(r"^[a-z][a-z_]{0,31}$")
FALLBACK_ERROR_CODE = "job_failed"


@dataclass(frozen=True)
class JobView:
    id: uuid.UUID
    job_type: str
    status: JobStatus
    progress: int | None
    stage: str | None
    error_code: str | None
    attempts: int
    max_attempts: int
    cancel_requested: bool
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES


def error_code(status: str, last_error: str | None) -> str | None:
    if status == "cancelled":
        return "cancelled"
    if status != "failed":
        return None
    code = (last_error or "").split(":", 1)[0].strip()
    return code if _CODE.fullmatch(code) else FALLBACK_ERROR_CODE


def progress_of(status: str, result: Any) -> tuple[int | None, str | None]:
    if status == "succeeded":
        return 100, None
    if status != "running" or not isinstance(result, dict):
        return None, None
    progress = result.get("progress")
    if not isinstance(progress, dict):
        return None, None
    percent, stage = progress.get("percent"), progress.get("stage")
    percent_value: int | None = None
    if isinstance(percent, int) and not isinstance(percent, bool):
        # 100 is reserved for "succeeded".
        percent_value = min(max(percent, 0), 99)
    stage_value = stage if isinstance(stage, str) and _STAGE.fullmatch(stage) else None
    return percent_value, stage_value


_COLUMNS = (
    async_jobs.c.id,
    async_jobs.c.job_type,
    async_jobs.c.status,
    async_jobs.c.result,
    async_jobs.c.last_error,
    async_jobs.c.attempts,
    async_jobs.c.max_attempts,
    async_jobs.c.cancel_requested_at,
    async_jobs.c.created_at,
    async_jobs.c.updated_at,
    async_jobs.c.started_at,
    async_jobs.c.finished_at,
)


class JobRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, job_id: uuid.UUID) -> JobView | None:
        row = self._session.execute(
            select(*_COLUMNS).where(async_jobs.c.id == job_id)
        ).one_or_none()
        if row is None:
            return None
        progress, stage = progress_of(row.status, row.result)
        return JobView(
            id=row.id,
            job_type=row.job_type,
            status=cast(JobStatus, row.status),
            progress=progress,
            stage=stage,
            error_code=error_code(row.status, row.last_error),
            attempts=row.attempts,
            max_attempts=row.max_attempts,
            cancel_requested=row.cancel_requested_at is not None,
            created_at=row.created_at,
            updated_at=row.updated_at,
            started_at=row.started_at,
            finished_at=row.finished_at,
        )
