"""Job state store: the worker's view of the `async_jobs` table.

State machine (statuses mirror `async_jobs.status`)::

    queued --claim--> running --complete--> succeeded
       ^                 |  \\--fail-------> failed
       |                 |   \\-cancel-----> cancelled
       +--release_for_retry / recover_expired (attempts < max_attempts)

    queued + cancel requested --claim--> cancelled (the handler never runs)
    running + lease expired --claim / recover_expired--> queued | failed | cancelled

Guarantees every implementation must provide:
- `claim` is atomic. A job in a terminal state is never claimed again (duplicate delivery
  after success is a no-op). A `running` job whose lease has not expired cannot be claimed
  (a concurrent duplicate cannot run twice). A `running` job whose lease expired (worker lost,
  hard time limit) is re-claimed as a new attempt, or failed once `max_attempts` is used up.
- Every transition out of `running` is fenced by `attempt`: a stale attempt (its lease
  expired and another attempt took over) gets `StaleClaimError` and changes nothing.
- `published_at` records the last hand-off of a message for the job's current queued state,
  so a row that exists without a message (publish failed, message lost or acked by a hard
  time limit) is found by `find_republish_candidates` and re-published.
- `last_error` only ever receives `errors.sanitize_error()` output or the constants below.
- Every transition that makes a job `failed` or `cancelled` after an attempt was claimed sets
  `cleanup_pending` in the same write. The flag is cleared only by `finish_cleanup`, so
  cleanup of artifacts left by earlier attempts survives crashes and cleanup errors: it is
  claimed with a lease (`claim_cleanup`), retried with backoff (`fail_cleanup`) by the
  reconciler and on redelivery, and stays flagged (never dropped) once retries run out.

All transitions are pure functions of (row, now) in this module; a store only has to run them
atomically (`_atomic`): a lock for the in-memory store, `BEGIN IMMEDIATE` for SQLite, and
`SELECT ... FOR UPDATE` for the Postgres store that lands on top of P0.9's `async_jobs`.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field, fields, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
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
# last_error written when a lost worker's attempt is handed back to the queue.
LEASE_EXPIRED_ERROR = "worker_lost: lease expired"


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
    # The envelope payload (IDs and options only), kept so the job can be re-published.
    payload: Mapping[str, JsonValue] = field(default_factory=dict, repr=False)
    last_error: str | None = None
    result: Mapping[str, JsonValue] | None = None
    cancel_requested_at: datetime | None = None
    locked_by: str | None = None
    lease_expires_at: datetime | None = None
    published_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # Cleanup owed by a failed/cancelled job (see module docstring).
    cleanup_pending: bool = False
    cleanup_attempts: int = 0
    cleanup_last_error: str | None = None
    # Earliest next cleanup try; doubles as the lease of a cleanup in progress.
    cleanup_next_at: datetime | None = None

    def matches(self, envelope: JobEnvelope) -> bool:
        return (
            self.job_type == envelope.job_type
            and self.workspace_id == envelope.workspace_id
            and self.idempotency_key == envelope.idempotency_key
            and self.schema_version == envelope.schema_version
        )

    def to_envelope(self) -> JobEnvelope:
        return JobEnvelope(
            job_id=self.job_id,
            job_type=self.job_type,
            schema_version=self.schema_version,
            idempotency_key=self.idempotency_key,
            workspace_id=self.workspace_id,
            payload=dict(self.payload),
        )


class ClaimOutcome(StrEnum):
    CLAIMED = "claimed"
    # Duplicate delivery of a job that already reached succeeded/failed/cancelled.
    ALREADY_FINISHED = "already_finished"
    # Another attempt holds a live lease.
    IN_PROGRESS = "in_progress"
    # Cancel was requested (while queued, or before a lost attempt was re-claimed): the job
    # is now `cancelled` and nothing ran in this delivery.
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
        """Insert a `queued`, unpublished job; idempotent on (workspace_id, job_type, key).

        Returns the existing row for a repeated idempotency key or job id. In production the
        API owns this insert (same transaction as the resource it belongs to).
        """
        ...

    def get(self, job_id: UUID) -> JobRecord | None: ...

    def mark_published(self, job_id: UUID) -> JobRecord | None:
        """Record a message hand-off; only applies while the job is still `queued`."""
        ...

    def claim(
        self, envelope: JobEnvelope, *, worker_id: str, lease_seconds: int
    ) -> ClaimResult: ...

    def complete(
        self, job_id: UUID, *, attempt: int, result: Mapping[str, JsonValue] | None
    ) -> JobRecord: ...

    def fail(
        self, job_id: UUID, *, attempt: int, error: str, cleanup: bool | None = None
    ) -> JobRecord:
        """running -> failed. `cleanup` overrides the default (pending if any attempt ran)."""
        ...

    def release_for_retry(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord:
        """running -> queued; also marks the job published (Celery re-sends it right after)."""
        ...

    def cancel(self, job_id: UUID, *, attempt: int, cleanup: bool | None = None) -> JobRecord:
        """running -> cancelled, after the attempt observed the cancel request."""
        ...

    def request_cancel(self, job_id: UUID) -> JobRecord:
        """API side: flag a job for cancellation (no-op on terminal jobs)."""
        ...

    def is_cancel_requested(self, job_id: UUID) -> bool: ...

    def find_expired_leases(self, *, limit: int) -> list[JobRecord]:
        """`running` jobs whose lease has expired (their worker is gone)."""
        ...

    def recover_expired(self, job_id: UUID, *, attempt: int) -> JobRecord | None:
        """If attempt `attempt` still holds an expired lease: requeue it (unpublished), or
        fail it when attempts are exhausted, or cancel it when cancel was requested.
        Returns None when the row moved on (a live worker or another reconciler won)."""
        ...

    def claim_cleanup(
        self, job_id: UUID, *, lease_seconds: float, max_attempts: int
    ) -> JobRecord | None:
        """Take the pending cleanup if it is due and has tries left; counts one try and
        leases it for `lease_seconds`. None when nothing is due (or someone else holds it)."""
        ...

    def finish_cleanup(self, job_id: UUID, *, cleanup_attempt: int) -> JobRecord | None:
        """Clear `cleanup_pending` if try `cleanup_attempt` still owns the cleanup."""
        ...

    def fail_cleanup(
        self, job_id: UUID, *, cleanup_attempt: int, error: str, retry_after_seconds: float
    ) -> JobRecord | None:
        """Keep the cleanup pending, record the sanitized error and when to retry."""
        ...

    def find_pending_cleanups(self, *, max_attempts: int, limit: int) -> list[JobRecord]:
        """Terminal jobs whose cleanup is due and still has tries left."""
        ...

    def find_republish_candidates(
        self, *, unpublished_grace_seconds: float, stale_after_seconds: float, limit: int
    ) -> list[JobRecord]:
        """`queued` jobs never published for longer than the grace period, or published
        longer ago than `stale_after_seconds` without being claimed."""
        ...


def utc_now() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------------------------
# Pure transitions: (current row, now, ...) -> (return value, row to save or None)
# --------------------------------------------------------------------------------------------


def new_record(envelope: JobEnvelope, *, max_attempts: int, now: datetime) -> JobRecord:
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    return JobRecord(
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
        payload=dict(envelope.payload),
    )


def _finish(
    record: JobRecord,
    status: JobStatus,
    now: datetime,
    *,
    error: str | None = None,
    result: Mapping[str, JsonValue] | None = None,
    cleanup: bool | None = None,
) -> JobRecord:
    """Terminal row. `cleanup` defaults to "an attempt was ever claimed" for failed/cancelled."""
    if cleanup is None:
        cleanup = status is not JobStatus.SUCCEEDED and record.attempts > 0
    return replace(
        record,
        status=status,
        cleanup_pending=cleanup,
        cleanup_next_at=now if cleanup else None,
        last_error=error if error is not None else record.last_error,
        result=dict(result) if result is not None else None,
        locked_by=None,
        lease_expires_at=None,
        finished_at=now,
        updated_at=now,
    )


def _lease_expired(record: JobRecord, now: datetime) -> bool:
    return (
        record.status is JobStatus.RUNNING
        and record.lease_expires_at is not None
        and record.lease_expires_at <= now
    )


def _owned(record: JobRecord | None, job_id: UUID, attempt: int) -> JobRecord:
    if record is None:
        raise JobNotFoundError(str(job_id))
    if record.status is not JobStatus.RUNNING or record.attempts != attempt:
        raise StaleClaimError(str(job_id))
    return record


def _settle_expired(record: JobRecord, now: datetime) -> JobRecord:
    """Terminal or requeued row for a running attempt whose lease expired."""
    if record.cancel_requested_at is not None:
        return _finish(record, JobStatus.CANCELLED, now)
    if record.attempts >= record.max_attempts:
        return _finish(record, JobStatus.FAILED, now, error=WORKER_LOST_ERROR)
    return replace(
        record,
        status=JobStatus.QUEUED,
        last_error=LEASE_EXPIRED_ERROR,
        locked_by=None,
        lease_expires_at=None,
        published_at=None,
        updated_at=now,
    )


def claim_transition(
    record: JobRecord | None,
    now: datetime,
    *,
    envelope: JobEnvelope,
    worker_id: str,
    lease_seconds: int,
) -> tuple[ClaimResult, JobRecord | None]:
    if record is None:
        return ClaimResult(ClaimOutcome.NOT_FOUND), None
    if not record.matches(envelope):
        return ClaimResult(ClaimOutcome.MISMATCH, record), None
    if record.status in TERMINAL_STATUSES:
        return ClaimResult(ClaimOutcome.ALREADY_FINISHED, record), None
    if record.status is JobStatus.RUNNING:
        if not _lease_expired(record, now):
            return ClaimResult(ClaimOutcome.IN_PROGRESS, record), None
        settled = _settle_expired(record, now)
        if settled.status is JobStatus.FAILED:
            return ClaimResult(ClaimOutcome.EXHAUSTED, settled), settled
        record = settled
    if record.cancel_requested_at is not None:
        cancelled = _finish(record, JobStatus.CANCELLED, now)
        return ClaimResult(ClaimOutcome.CANCELLED, cancelled), cancelled
    claimed = replace(
        record,
        status=JobStatus.RUNNING,
        attempts=record.attempts + 1,
        locked_by=worker_id,
        lease_expires_at=now + timedelta(seconds=lease_seconds),
        started_at=record.started_at or now,
        updated_at=now,
    )
    return ClaimResult(ClaimOutcome.CLAIMED, claimed), claimed


def _cleanup_due(record: JobRecord, now: datetime, max_attempts: int) -> bool:
    return (
        record.cleanup_pending
        and record.cleanup_attempts < max_attempts
        and (record.cleanup_next_at is None or record.cleanup_next_at <= now)
    )


def needs_republish(
    record: JobRecord,
    now: datetime,
    *,
    unpublished_grace_seconds: float,
    stale_after_seconds: float,
) -> bool:
    if record.status is not JobStatus.QUEUED:
        return False
    if record.published_at is None:
        return record.updated_at <= now - timedelta(seconds=unpublished_grace_seconds)
    return record.published_at <= now - timedelta(seconds=stale_after_seconds)


# --------------------------------------------------------------------------------------------
# Shared store logic over an atomic read-modify-write primitive
# --------------------------------------------------------------------------------------------

type Mutation[T] = Callable[[JobRecord | None, datetime], tuple[T, JobRecord | None]]


class TransactionalJobStore:
    """Implements `JobStore` given `_atomic`, `_insert` and two scans."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        self._clock = clock

    # -- storage primitives -------------------------------------------------------------
    def _atomic[T](self, job_id: UUID, mutate: Mutation[T]) -> T:
        raise NotImplementedError

    def _insert_or_get(self, record: JobRecord) -> JobRecord:
        """Insert unless a row with the same id or idempotency scope exists; return the row."""
        raise NotImplementedError

    def get(self, job_id: UUID) -> JobRecord | None:
        raise NotImplementedError

    def _scan(self, status: JobStatus) -> list[JobRecord]:
        raise NotImplementedError

    # -- JobStore ------------------------------------------------------------------------
    def create(self, envelope: JobEnvelope, *, max_attempts: int) -> JobRecord:
        record = new_record(envelope, max_attempts=max_attempts, now=self._clock())
        stored = self._insert_or_get(record)
        if stored.job_id == envelope.job_id and not stored.matches(envelope):
            raise ValueError("job_id already used by a different job")
        return stored

    def mark_published(self, job_id: UUID) -> JobRecord | None:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord | None, JobRecord | None]:
            if r is None or r.status is not JobStatus.QUEUED:
                return r, None
            updated = replace(r, published_at=now, updated_at=now)
            return updated, updated

        return self._atomic(job_id, mutate)

    def claim(self, envelope: JobEnvelope, *, worker_id: str, lease_seconds: int) -> ClaimResult:
        return self._atomic(
            envelope.job_id,
            lambda r, now: claim_transition(
                r, now, envelope=envelope, worker_id=worker_id, lease_seconds=lease_seconds
            ),
        )

    def complete(
        self, job_id: UUID, *, attempt: int, result: Mapping[str, JsonValue] | None
    ) -> JobRecord:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord, JobRecord]:
            done = _finish(_owned(r, job_id, attempt), JobStatus.SUCCEEDED, now, result=result)
            return done, done

        return self._atomic(job_id, mutate)

    def fail(
        self, job_id: UUID, *, attempt: int, error: str, cleanup: bool | None = None
    ) -> JobRecord:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord, JobRecord]:
            failed = _finish(
                _owned(r, job_id, attempt), JobStatus.FAILED, now, error=error, cleanup=cleanup
            )
            return failed, failed

        return self._atomic(job_id, mutate)

    def release_for_retry(self, job_id: UUID, *, attempt: int, error: str) -> JobRecord:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord, JobRecord]:
            released = replace(
                _owned(r, job_id, attempt),
                status=JobStatus.QUEUED,
                last_error=error,
                locked_by=None,
                lease_expires_at=None,
                published_at=now,
                updated_at=now,
            )
            return released, released

        return self._atomic(job_id, mutate)

    def cancel(self, job_id: UUID, *, attempt: int, cleanup: bool | None = None) -> JobRecord:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord, JobRecord]:
            cancelled = _finish(
                _owned(r, job_id, attempt), JobStatus.CANCELLED, now, cleanup=cleanup
            )
            return cancelled, cancelled

        return self._atomic(job_id, mutate)

    def request_cancel(self, job_id: UUID) -> JobRecord:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord, JobRecord | None]:
            if r is None:
                raise JobNotFoundError(str(job_id))
            if r.status in TERMINAL_STATUSES or r.cancel_requested_at is not None:
                return r, None
            flagged = replace(r, cancel_requested_at=now, updated_at=now)
            return flagged, flagged

        return self._atomic(job_id, mutate)

    def is_cancel_requested(self, job_id: UUID) -> bool:
        record = self.get(job_id)
        return record is not None and record.cancel_requested_at is not None

    def find_expired_leases(self, *, limit: int) -> list[JobRecord]:
        now = self._clock()
        expired = [r for r in self._scan(JobStatus.RUNNING) if _lease_expired(r, now)]
        return sorted(expired, key=lambda r: r.updated_at)[:limit]

    def recover_expired(self, job_id: UUID, *, attempt: int) -> JobRecord | None:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord | None, JobRecord | None]:
            if r is None or r.attempts != attempt or not _lease_expired(r, now):
                return None, None
            settled = _settle_expired(r, now)
            return settled, settled

        return self._atomic(job_id, mutate)

    def claim_cleanup(
        self, job_id: UUID, *, lease_seconds: float, max_attempts: int
    ) -> JobRecord | None:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord | None, JobRecord | None]:
            if r is None or not _cleanup_due(r, now, max_attempts):
                return None, None
            claimed = replace(
                r,
                cleanup_attempts=r.cleanup_attempts + 1,
                cleanup_next_at=now + timedelta(seconds=lease_seconds),
                updated_at=now,
            )
            return claimed, claimed

        return self._atomic(job_id, mutate)

    def finish_cleanup(self, job_id: UUID, *, cleanup_attempt: int) -> JobRecord | None:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord | None, JobRecord | None]:
            if r is None or not r.cleanup_pending or r.cleanup_attempts != cleanup_attempt:
                return None, None
            done = replace(r, cleanup_pending=False, cleanup_next_at=None, updated_at=now)
            return done, done

        return self._atomic(job_id, mutate)

    def fail_cleanup(
        self, job_id: UUID, *, cleanup_attempt: int, error: str, retry_after_seconds: float
    ) -> JobRecord | None:
        def mutate(r: JobRecord | None, now: datetime) -> tuple[JobRecord | None, JobRecord | None]:
            if r is None or not r.cleanup_pending or r.cleanup_attempts != cleanup_attempt:
                return None, None
            failed = replace(
                r,
                cleanup_last_error=error,
                cleanup_next_at=now + timedelta(seconds=retry_after_seconds),
                updated_at=now,
            )
            return failed, failed

        return self._atomic(job_id, mutate)

    def find_pending_cleanups(self, *, max_attempts: int, limit: int) -> list[JobRecord]:
        now = self._clock()
        due = [
            r
            for status in (JobStatus.FAILED, JobStatus.CANCELLED)
            for r in self._scan(status)
            if _cleanup_due(r, now, max_attempts)
        ]
        return sorted(due, key=lambda r: r.updated_at)[:limit]

    def find_republish_candidates(
        self, *, unpublished_grace_seconds: float, stale_after_seconds: float, limit: int
    ) -> list[JobRecord]:
        now = self._clock()
        due = [
            r
            for r in self._scan(JobStatus.QUEUED)
            if needs_republish(
                r,
                now,
                unpublished_grace_seconds=unpublished_grace_seconds,
                stale_after_seconds=stale_after_seconds,
            )
        ]
        return sorted(due, key=lambda r: r.updated_at)[:limit]


class InMemoryJobStore(TransactionalJobStore):
    """Thread-safe `JobStore` for tests and the local in-process worker."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        super().__init__(clock)
        self._lock = threading.Lock()
        self._jobs: dict[UUID, JobRecord] = {}
        self._by_key: dict[tuple[UUID, str, str], UUID] = {}

    def _atomic[T](self, job_id: UUID, mutate: Mutation[T]) -> T:
        with self._lock:
            value, updated = mutate(self._jobs.get(job_id), self._clock())
            if updated is not None:
                self._jobs[job_id] = updated
            return value

    def _insert_or_get(self, record: JobRecord) -> JobRecord:
        key = (record.workspace_id, record.job_type, record.idempotency_key)
        with self._lock:
            existing_id = self._by_key.get(key)
            if existing_id is not None:
                return self._jobs[existing_id]
            if record.job_id in self._jobs:
                return self._jobs[record.job_id]
            self._jobs[record.job_id] = record
            self._by_key[key] = record.job_id
            return record

    def get(self, job_id: UUID) -> JobRecord | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _scan(self, status: JobStatus) -> list[JobRecord]:
        with self._lock:
            return [r for r in self._jobs.values() if r.status is status]


# --------------------------------------------------------------------------------------------
# SQLite: a cross-process store for local multi-process runs and prefork worker tests
# --------------------------------------------------------------------------------------------

# Local/test schema only. The production `async_jobs` table is owned by supabase/migrations;
# this file-backed copy upgrades itself in place (additive columns) when the store evolves.
#
# user_version 1: P0.7 fix layout (published_at, no cleanup columns).
# user_version 2: + cleanup_pending, cleanup_attempts, cleanup_last_error, cleanup_next_at.
SQLITE_SCHEMA_VERSION = 2

# Columns added after version 1, with the DDL used to add them to an existing table.
_SQLITE_ADDED_COLUMNS: dict[str, str] = {
    "cleanup_pending": "INTEGER NOT NULL DEFAULT 0",
    "cleanup_attempts": "INTEGER NOT NULL DEFAULT 0",
    "cleanup_last_error": "TEXT",
    "cleanup_next_at": "REAL",
}

_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS async_jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    payload TEXT NOT NULL,
    last_error TEXT,
    result TEXT,
    cancel_requested_at REAL,
    locked_by TEXT,
    lease_expires_at REAL,
    published_at REAL,
    started_at REAL,
    finished_at REAL,
    cleanup_pending INTEGER NOT NULL DEFAULT 0,
    cleanup_attempts INTEGER NOT NULL DEFAULT 0,
    cleanup_last_error TEXT,
    cleanup_next_at REAL,
    UNIQUE (workspace_id, job_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS async_jobs_status ON async_jobs (status, updated_at);
"""

_COLUMNS = tuple(f.name for f in fields(JobRecord))
_TIME_COLUMNS = frozenset(
    {
        "created_at",
        "updated_at",
        "cancel_requested_at",
        "lease_expires_at",
        "published_at",
        "started_at",
        "finished_at",
        "cleanup_next_at",
    }
)


def _to_row(record: JobRecord) -> tuple[Any, ...]:
    values: list[Any] = []
    for name in _COLUMNS:
        value = getattr(record, name)
        if value is None:
            values.append(None)
        elif name in _TIME_COLUMNS:
            values.append(value.timestamp())
        elif name in {"payload", "result"}:
            values.append(json.dumps(value))
        elif isinstance(value, UUID | StrEnum):
            values.append(str(value))
        else:
            values.append(value)
    return tuple(values)


def _from_row(row: sqlite3.Row) -> JobRecord:
    data: dict[str, Any] = dict(row)
    for name in _TIME_COLUMNS:
        if data[name] is not None:
            data[name] = datetime.fromtimestamp(data[name], UTC)
    data["job_id"] = UUID(data["job_id"])
    data["workspace_id"] = UUID(data["workspace_id"])
    data["status"] = JobStatus(data["status"])
    data["cleanup_pending"] = bool(data["cleanup_pending"])
    data["payload"] = json.loads(data["payload"])
    data["result"] = json.loads(data["result"]) if data["result"] is not None else None
    return JobRecord(**data)


class SqliteJobStore(TransactionalJobStore):
    """File-backed `JobStore` shared by processes on one host (local/test only).

    Each operation opens its own connection and serialises writers with `BEGIN IMMEDIATE`.
    """

    def __init__(self, path: str | Path, clock: Callable[[], datetime] = utc_now) -> None:
        super().__init__(clock)
        self._path = str(path)
        with self._connect() as conn:
            conn.executescript(_SQLITE_SCHEMA)
        self._upgrade_schema()

    def _upgrade_schema(self) -> None:
        """Bring an existing file up to `SQLITE_SCHEMA_VERSION` (idempotent, additive)."""
        with self._transaction() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SQLITE_SCHEMA_VERSION:
                raise RuntimeError(
                    f"job store schema version {version} is newer than this worker "
                    f"({SQLITE_SCHEMA_VERSION})"
                )
            existing = {row["name"] for row in conn.execute("PRAGMA table_info(async_jobs)")}
            for name, ddl in _SQLITE_ADDED_COLUMNS.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE async_jobs ADD COLUMN {name} {ddl}")
            if version != SQLITE_SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version = {SQLITE_SCHEMA_VERSION}")

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self._path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")

    def _save(self, conn: sqlite3.Connection, record: JobRecord) -> None:
        placeholders = ", ".join("?" for _ in _COLUMNS)
        conn.execute(
            f"INSERT OR REPLACE INTO async_jobs ({', '.join(_COLUMNS)}) "  # noqa: S608 - fixed columns
            f"VALUES ({placeholders})",
            _to_row(record),
        )

    def _atomic[T](self, job_id: UUID, mutate: Mutation[T]) -> T:
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM async_jobs WHERE job_id = ?", (str(job_id),))
            found = row.fetchone()
            value, updated = mutate(_from_row(found) if found else None, self._clock())
            if updated is not None:
                self._save(conn, updated)
            return value

    def _insert_or_get(self, record: JobRecord) -> JobRecord:
        with self._transaction() as conn:
            found = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id = ? OR "
                "(workspace_id = ? AND job_type = ? AND idempotency_key = ?)",
                (
                    str(record.job_id),
                    str(record.workspace_id),
                    record.job_type,
                    record.idempotency_key,
                ),
            ).fetchone()
            if found is not None:
                return _from_row(found)
            self._save(conn, record)
            return record

    def get(self, job_id: UUID) -> JobRecord | None:
        with self._connect() as conn:
            found = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id = ?", (str(job_id),)
            ).fetchone()
            return _from_row(found) if found else None

    def _scan(self, status: JobStatus) -> list[JobRecord]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM async_jobs WHERE status = ?", (status.value,))
            return [_from_row(r) for r in rows.fetchall()]
