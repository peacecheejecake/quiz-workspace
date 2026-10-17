"""Job state store: the worker's view of the `async_jobs` table.

State machine (statuses mirror `async_jobs.status`)::

    queued --claim--> running --complete--> succeeded
       ^                 |  \\--fail-------> failed
       |                 |   \\-cancel-----> cancelled
       +--release_for_retry (attempts < max_attempts)

    queued + cancel requested --claim--> cancelled (the handler never runs)

Guarantees every implementation must provide:
- `claim` is atomic. A job in a terminal state is never claimed again (duplicate delivery
  after success is a no-op). A `running` job whose lease has not expired cannot be claimed
  (a concurrent duplicate cannot run twice). A `running` job whose lease expired (worker lost)
  is re-claimed as a new attempt, or failed once `max_attempts` is used up.
- Every transition out of `running` is fenced by `attempt`: a stale attempt (its lease
  expired and another attempt took over) gets `StaleClaimError` and changes nothing.
- `last_error` only ever receives `errors.sanitize_error()` output.

The Postgres implementation (on top of P0.9's `async_jobs`) maps `claim` to a single
`UPDATE ... WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < now())
RETURNING ...` and every other transition to `UPDATE ... WHERE status = 'running' AND
attempts = :attempt`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from pydantic import JsonValue

from quiz_worker.envelope import JobEnvelope


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATUSES = frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED})

# last_error written when a lost worker's attempt was the final one.
WORKER_LOST_ERROR = "worker_lost: attempts exhausted"


@dataclass(frozen=True, slots=True)
class JobRecord:
    job_id: UUID
    job_type: str
    workspace_id: UUID
    idempotency_key: str
    schema_version: int
    status: JobStatus
    attempts: int
    max_attempts: int
    created_at: datetime
    updated_at: datetime
    last_error: str | None = None
    result: Mapping[str, JsonValue] | None = None
    cancel_requested_at: datetime | None = None
    locked_by: str | None = None
    lease_expires_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None

    def matches(self, envelope: JobEnvelope) -> bool:
        return (
            self.job_type == envelope.job_type
            and self.workspace_id == envelope.workspace_id
            and self.idempotency_key == envelope.idempotency_key
            and self.schema_version == envelope.schema_version
        )


class ClaimOutcome(StrEnum):
    CLAIMED = "claimed"
    # Duplicate delivery of a job that already reached succeeded/failed/cancelled.
    ALREADY_FINISHED = "already_finished"
    # Another attempt holds a live lease.
    IN_PROGRESS = "in_progress"
    # Cancel was requested while queued: the job is now `cancelled`, nothing ran.
    CANCELLED = "cancelled"
    # A lost worker's lease expired on the final attempt: the job is now `failed`.
    EXHAUSTED = "exhausted"
    NOT_FOUND = "not_found"
    # The message's identity differs from the stored row; the row is left untouched.
    MISMATCH = "mismatch"


@dataclass(frozen=True, slots=True)
class ClaimResult:
    outcome: ClaimOutcome
    record: JobRecord | None = None


class StaleClaimError(Exception):
    """The attempt no longer owns the job (lease taken over, or job already terminal)."""


class JobNotFoundError(LookupError):
    pass


class JobStore(Protocol):
    def create(self, envelope: JobEnvelope, *, max_attempts: int) -> JobRecord:
        """Insert a `queued` job; idempotent on (workspace_id, job_type, idempotency_key).

        Returns the existing row for a repeated idempotency key. In production the API owns
        this insert (same transaction as the resource it belongs to).
        """
        ...

    def get(self, job_id: UUID) -> JobRecord | None: ...

    def claim(
        self, envelope: JobEnvelope, *, worker_id: str, lease_seconds: int
    ) -> ClaimResult: ...

    def complete(
        self, job_id: UUID, *, attempt: int, result: Mapping[str, JsonValue] | None
    ) -> JobRecord: ...

    def fail(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord: ...

    def release_for_retry(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord: ...

    def cancel(self, job_id: UUID, *, attempt: int) -> JobRecord:
        """running -> cancelled, after the attempt observed the cancel request."""
        ...

    def request_cancel(self, job_id: UUID) -> JobRecord:
        """API side: flag a job for cancellation (no-op on terminal jobs)."""
        ...

    def is_cancel_requested(self, job_id: UUID) -> bool: ...


def utc_now() -> datetime:
    return datetime.now(UTC)


class InMemoryJobStore:
    """Thread-safe `JobStore` for tests and the local in-process worker."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs: dict[UUID, JobRecord] = {}
        self._by_key: dict[tuple[UUID, str, str], UUID] = {}

    def create(self, envelope: JobEnvelope, *, max_attempts: int) -> JobRecord:
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        key = (envelope.workspace_id, envelope.job_type, envelope.idempotency_key)
        with self._lock:
            existing_id = self._by_key.get(key)
            if existing_id is not None:
                return self._jobs[existing_id]
            if envelope.job_id in self._jobs:
                raise ValueError("job_id already used by a different job")
            now = self._clock()
            record = JobRecord(
                job_id=envelope.job_id,
                job_type=envelope.job_type,
                workspace_id=envelope.workspace_id,
                idempotency_key=envelope.idempotency_key,
                schema_version=envelope.schema_version,
                status=JobStatus.QUEUED,
                attempts=0,
                max_attempts=max_attempts,
                created_at=now,
                updated_at=now,
            )
            self._jobs[record.job_id] = record
            self._by_key[key] = record.job_id
            return record

    def get(self, job_id: UUID) -> JobRecord | None:
        with self._lock:
            return self._jobs.get(job_id)

    def claim(self, envelope: JobEnvelope, *, worker_id: str, lease_seconds: int) -> ClaimResult:
        with self._lock:
            record = self._jobs.get(envelope.job_id)
            if record is None:
                return ClaimResult(ClaimOutcome.NOT_FOUND)
            if not record.matches(envelope):
                return ClaimResult(ClaimOutcome.MISMATCH, record)
            if record.status in TERMINAL_STATUSES:
                return ClaimResult(ClaimOutcome.ALREADY_FINISHED, record)
            now = self._clock()
            if record.status is JobStatus.RUNNING:
                assert record.lease_expires_at is not None  # noqa: S101 - running implies lease
                if record.lease_expires_at > now:
                    return ClaimResult(ClaimOutcome.IN_PROGRESS, record)
                if record.attempts >= record.max_attempts:
                    failed = self._finish(record, JobStatus.FAILED, now, error=WORKER_LOST_ERROR)
                    return ClaimResult(ClaimOutcome.EXHAUSTED, failed)
            if record.cancel_requested_at is not None:
                cancelled = self._finish(record, JobStatus.CANCELLED, now)
                return ClaimResult(ClaimOutcome.CANCELLED, cancelled)
            claimed = replace(
                record,
                status=JobStatus.RUNNING,
                attempts=record.attempts + 1,
                locked_by=worker_id,
                lease_expires_at=now + timedelta(seconds=lease_seconds),
                started_at=record.started_at or now,
                updated_at=now,
            )
            self._jobs[record.job_id] = claimed
            return ClaimResult(ClaimOutcome.CLAIMED, claimed)

    def complete(
        self, job_id: UUID, *, attempt: int, result: Mapping[str, JsonValue] | None
    ) -> JobRecord:
        with self._lock:
            record = self._owned(job_id, attempt)
            return self._finish(record, JobStatus.SUCCEEDED, self._clock(), result=result)

    def fail(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord:
        with self._lock:
            record = self._owned(job_id, attempt)
            return self._finish(record, JobStatus.FAILED, self._clock(), error=error)

    def release_for_retry(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord:
        with self._lock:
            record = self._owned(job_id, attempt)
            released = replace(
                record,
                status=JobStatus.QUEUED,
                last_error=error,
                locked_by=None,
                lease_expires_at=None,
                updated_at=self._clock(),
            )
            self._jobs[job_id] = released
            return released

    def cancel(self, job_id: UUID, *, attempt: int) -> JobRecord:
        with self._lock:
            record = self._owned(job_id, attempt)
            return self._finish(record, JobStatus.CANCELLED, self._clock())

    def request_cancel(self, job_id: UUID) -> JobRecord:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                raise JobNotFoundError(str(job_id))
            if record.status in TERMINAL_STATUSES or record.cancel_requested_at is not None:
                return record
            now = self._clock()
            flagged = replace(record, cancel_requested_at=now, updated_at=now)
            self._jobs[job_id] = flagged
            return flagged

    def is_cancel_requested(self, job_id: UUID) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            return record is not None and record.cancel_requested_at is not None

    def _owned(self, job_id: UUID, attempt: int) -> JobRecord:
        record = self._jobs.get(job_id)
        if record is None:
            raise JobNotFoundError(str(job_id))
        if record.status is not JobStatus.RUNNING or record.attempts != attempt:
            raise StaleClaimError(str(job_id))
        return record

    def _finish(
        self,
        record: JobRecord,
        status: JobStatus,
        now: datetime,
        *,
        error: str | None = None,
        result: Mapping[str, JsonValue] | None = None,
    ) -> JobRecord:
        finished = replace(
            record,
            status=status,
            last_error=error if error is not None else record.last_error,
            result=dict(result) if result is not None else None,
            locked_by=None,
            lease_expires_at=None,
            finished_at=now,
            updated_at=now,
        )
        self._jobs[record.job_id] = finished
        return finished
