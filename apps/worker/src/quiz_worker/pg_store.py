"""Postgres `JobStore` on `public.async_jobs` (schema owned by supabase/migrations).

Runs the shared pure transitions of `quiz_worker.store` inside short transactions:
`SELECT ... FOR UPDATE` on the job row, compute the next row, `UPDATE` its state columns,
commit. Concurrent claims of one job serialise on the row lock, and the second one sees the
first one's committed lease (so exactly one wins). Nothing else (no handler code, no network
call) runs while a row lock is held.

Only the state columns are ever updated (the columns `quiz_worker` has UPDATE on); a job's
identity (workspace, creator, type, key, schema version, payload) is written once by `create`.

Time comes from the database (`clock_timestamp()`) unless a clock is injected (tests), so every
worker and the reconciler compare leases against one clock. Every transition writes its own
`updated_at` and sets the transaction-local `quiz.explicit_updated_at` signal so the table's
trigger keeps that value: the persisted row is exactly the record the store returns.
"""

from __future__ import annotations

import os
import weakref
from collections.abc import Callable, Collection, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from pydantic import SecretStr
from sqlalchemy import (
    Boolean,
    Column,
    Connection,
    DateTime,
    Engine,
    Integer,
    MetaData,
    Select,
    Table,
    Text,
    Uuid,
    create_engine,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.engine import RowMapping, make_url

from quiz_worker.envelope import JobEnvelope
from quiz_worker.store import (
    JobRecord,
    JobStatus,
    Mutation,
    TransactionalJobStore,
    new_record,
)

_TS = DateTime(timezone=True)

ASYNC_JOBS = Table(
    "async_jobs",
    MetaData(schema="public"),
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("created_by", Uuid),
    Column("job_type", Text, nullable=False),
    Column("schema_version", Integer, nullable=False),
    Column("status", Text, nullable=False),
    Column("attempts", Integer, nullable=False),
    Column("max_attempts", Integer, nullable=False),
    Column("idempotency_key", Text),
    Column("payload", JSONB, nullable=False),
    Column("result", JSONB),
    Column("last_error", Text),
    Column("started_at", _TS),
    Column("finished_at", _TS),
    Column("created_at", _TS, nullable=False),
    Column("updated_at", _TS, nullable=False),
    Column("cancel_requested_at", _TS),
    Column("locked_by", Text),
    Column("lease_expires_at", _TS),
    Column("published_at", _TS),
    Column("cleanup_pending", Boolean, nullable=False),
    Column("cleanup_attempts", Integer, nullable=False),
    Column("cleanup_last_error", Text),
    Column("cleanup_next_at", _TS),
)
_T = ASYNC_JOBS.c

# Written once by `create`.
_IDENTITY_COLUMNS = (
    "workspace_id",
    "created_by",
    "job_type",
    "schema_version",
    "idempotency_key",
    "payload",
    "max_attempts",
    "created_at",
)
# Written by transitions; exactly the columns the migration grants quiz_worker UPDATE on.
STATE_COLUMNS = (
    "status",
    "attempts",
    "result",
    "last_error",
    "started_at",
    "finished_at",
    "updated_at",
    "cancel_requested_at",
    "locked_by",
    "lease_expires_at",
    "published_at",
    "cleanup_pending",
    "cleanup_attempts",
    "cleanup_last_error",
    "cleanup_next_at",
)
_TERMINAL_WITH_CLEANUP = (JobStatus.FAILED.value, JobStatus.CANCELLED.value)
# Read by the async_jobs updated_at trigger (supabase/migrations/20261017170000).
EXPLICIT_UPDATED_AT_SETTING = "quiz.explicit_updated_at"

# Every engine `create_job_store_engine` built in this process (weakly: a dropped engine goes).
_ENGINES: weakref.WeakSet[Engine] = weakref.WeakSet()


def create_job_store_engine(
    url: SecretStr | str, *, pool_size: int = 5, connect_timeout_seconds: float = 5
) -> Engine:
    """Engine for the worker's role (no connection is opened here)."""
    raw = url.get_secret_value() if isinstance(url, SecretStr) else url
    sa_url = make_url(raw)
    if sa_url.drivername in {"postgres", "postgresql"}:
        # Plain `postgresql://` URLs (Supabase style) use psycopg 3, as in apps/api.
        sa_url = sa_url.set(drivername="postgresql+psycopg")
    engine = create_engine(
        sa_url,
        pool_size=pool_size,
        pool_pre_ping=True,
        hide_parameters=True,
        connect_args={
            "connect_timeout": max(1, int(connect_timeout_seconds)),
            "application_name": "quiz_worker",
            # No server-side prepared statements: safe behind a transaction-mode pooler.
            "prepare_threshold": None,
        },
    )
    _ENGINES.add(engine)
    return engine


def dispose_inherited_engines() -> int:
    """In a freshly forked process: give every engine a new, empty pool (WRK-FORKDB).

    A forked child inherits the parent's pooled connections, i.e. the same server sockets; the
    worker's main process uses the job store (`release_lost`) before the pool forks the
    replacement child. `dispose(close=False)` drops those connections in the child without
    closing them (closing would send a Terminate on the parent's socket), so the parent keeps
    using them and the child opens its own ("Using Connection Pools with Multiprocessing",
    SQLAlchemy docs). psycopg never finishes a connection from a process other than the one that
    opened it, so the dropped objects are safe to garbage collect. Returns the engine count.
    """
    engines = list(_ENGINES)
    for engine in engines:
        engine.dispose(close=False)
    return len(engines)


def _utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None else None


def _from_row(row: RowMapping) -> JobRecord:
    def ts(name: str) -> datetime | None:
        return _utc(row[name])

    return JobRecord(
        job_id=row["id"],
        job_type=row["job_type"],
        workspace_id=row["workspace_id"],
        created_by=row["created_by"],
        idempotency_key=row["idempotency_key"],
        schema_version=row["schema_version"],
        status=JobStatus(row["status"]),
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
        created_at=row["created_at"].astimezone(UTC),
        updated_at=row["updated_at"].astimezone(UTC),
        payload=row["payload"],
        last_error=row["last_error"],
        result=row["result"],
        cancel_requested_at=ts("cancel_requested_at"),
        locked_by=row["locked_by"],
        lease_expires_at=ts("lease_expires_at"),
        published_at=ts("published_at"),
        started_at=ts("started_at"),
        finished_at=ts("finished_at"),
        cleanup_pending=row["cleanup_pending"],
        cleanup_attempts=row["cleanup_attempts"],
        cleanup_last_error=row["cleanup_last_error"],
        cleanup_next_at=ts("cleanup_next_at"),
    )


def _values(record: JobRecord, columns: tuple[str, ...]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for name in columns:
        value: Any = getattr(record, name)
        if name == "status":
            value = record.status.value
        elif name in {"payload", "result"} and value is not None:
            value = dict(value)
        values[name] = value
    return values


class PostgresJobStore(TransactionalJobStore):
    """`JobStore` over `public.async_jobs`, for every environment with a database."""

    def __init__(
        self,
        engine: Engine,
        clock: Callable[[], datetime] | None = None,
        *,
        scan_workspaces: Collection[UUID] | None = None,
    ) -> None:
        """`scan_workspaces` limits the reconciler/cleanup scans to those workspaces (read at
        every scan). Deployed workers leave it None; tests sharing one database use it so a
        scan never picks up another test session's rows."""
        super().__init__(clock or _no_clock)
        self._engine = engine
        self._db_clock = clock is None
        self._pid = os.getpid()
        self._scan_workspaces = scan_workspaces

    @property
    def engine(self) -> Engine:
        return self._engine

    def dispose(self) -> None:
        self._engine.dispose()

    # -- plumbing ------------------------------------------------------------------------
    @contextmanager
    def _begin(self) -> Iterator[Connection]:
        if os.getpid() != self._pid:
            # Forked worker child: never reuse the parent's pooled connections.
            self._engine.dispose(close=False)
            self._pid = os.getpid()
        with self._engine.begin() as conn:
            yield conn

    def _now(self, conn: Connection) -> datetime:
        if not self._db_clock:
            return self._clock()
        now = conn.execute(select(func.clock_timestamp(type_=_TS))).scalar_one()
        return now.astimezone(UTC)

    def _fetch(self, conn: Connection, stmt: Select[Any]) -> list[JobRecord]:
        if self._scan_workspaces is not None:
            stmt = stmt.where(_T.workspace_id.in_(list(self._scan_workspaces)))
        return [_from_row(row) for row in conn.execute(stmt).mappings()]

    # -- TransactionalJobStore primitives ------------------------------------------------
    def _atomic[T](self, job_id: UUID, mutate: Mutation[T]) -> T:
        with self._begin() as conn:
            found = (
                conn.execute(select(ASYNC_JOBS).where(_T.id == job_id).with_for_update())
                .mappings()
                .first()
            )
            value, updated = mutate(_from_row(found) if found else None, self._now(conn))
            if updated is not None:
                # Transaction-local: keep the updated_at this transition computed instead of
                # letting the trigger stamp now() (migration 20261017170000).
                conn.execute(select(func.set_config(EXPLICIT_UPDATED_AT_SETTING, "on", True)))
                conn.execute(
                    update(ASYNC_JOBS)
                    .where(_T.id == job_id)
                    .values(**_values(updated, STATE_COLUMNS))
                )
            return value

    def create(self, envelope: JobEnvelope, *, max_attempts: int) -> JobRecord:
        with self._begin() as conn:
            record = new_record(envelope, max_attempts=max_attempts, now=self._now(conn))
            values = {
                "id": record.job_id,
                **_values(record, _IDENTITY_COLUMNS),
                **_values(record, STATE_COLUMNS),
            }
            # No conflict target: a clash on the primary key or on the idempotency index
            # (which waits for a concurrent inserter to commit) both return nothing.
            inserted = (
                conn.execute(
                    insert(ASYNC_JOBS)
                    .values(**values)
                    .on_conflict_do_nothing()
                    .returning(ASYNC_JOBS)
                )
                .mappings()
                .first()
            )
            if inserted is not None:
                stored = _from_row(inserted)
            else:
                stored = self._find_existing(conn, record)
        if stored.job_id == envelope.job_id and not stored.matches(envelope):
            raise ValueError("job_id already used by a different job")
        return stored

    @staticmethod
    def _find_existing(conn: Connection, record: JobRecord) -> JobRecord:
        """The row `record` clashed with: same idempotency scope first, else same id."""
        clauses = [_T.id == record.job_id]
        key = record.dedupe_key
        if key is not None:
            workspace_id, created_by, job_type, idempotency_key = key
            clauses.append(
                (_T.workspace_id == workspace_id)
                & (_T.created_by == created_by)
                & (_T.job_type == job_type)
                & (_T.idempotency_key == idempotency_key)
            )
        found = (
            conn.execute(
                select(ASYNC_JOBS).where(or_(*clauses)).order_by(_T.id == record.job_id).limit(1)
            )
            .mappings()
            .first()
        )
        if found is None:
            # The clashing row was deleted in between; the caller may simply retry.
            raise RuntimeError("async_jobs insert conflicted with a row that no longer exists")
        return _from_row(found)

    def get(self, job_id: UUID) -> JobRecord | None:
        with self._begin() as conn:
            found = conn.execute(select(ASYNC_JOBS).where(_T.id == job_id)).mappings().first()
            return _from_row(found) if found else None

    # -- scans (indexed, bounded) --------------------------------------------------------
    def find_expired_leases(self, *, limit: int) -> list[JobRecord]:
        with self._begin() as conn:
            now = self._now(conn)
            # async_jobs_status_lease_idx
            return self._fetch(
                conn,
                select(ASYNC_JOBS)
                .where(_T.status == JobStatus.RUNNING.value, _T.lease_expires_at <= now)
                .order_by(_T.lease_expires_at, _T.id)
                .limit(limit),
            )

    def find_pending_cleanups(self, *, max_attempts: int, limit: int) -> list[JobRecord]:
        with self._begin() as conn:
            now = self._now(conn)
            # async_jobs_cleanup_due_idx (partial on cleanup_pending)
            return self._fetch(
                conn,
                select(ASYNC_JOBS)
                .where(
                    _T.cleanup_pending,
                    or_(_T.cleanup_next_at.is_(None), _T.cleanup_next_at <= now),
                    _T.cleanup_attempts < max_attempts,
                    _T.status.in_(_TERMINAL_WITH_CLEANUP),
                )
                .order_by(_T.cleanup_next_at.asc().nulls_first(), _T.id)
                .limit(limit),
            )

    def find_republish_candidates(
        self, *, unpublished_grace_seconds: float, stale_after_seconds: float, limit: int
    ) -> list[JobRecord]:
        with self._begin() as conn:
            now = self._now(conn)
            queued = _T.status == JobStatus.QUEUED.value
            # Both use async_jobs_status_published_idx.
            never_published = self._fetch(
                conn,
                select(ASYNC_JOBS)
                .where(
                    queued,
                    _T.published_at.is_(None),
                    _T.updated_at <= now - timedelta(seconds=unpublished_grace_seconds),
                )
                .order_by(_T.updated_at, _T.id)
                .limit(limit),
            )
            stale = self._fetch(
                conn,
                select(ASYNC_JOBS)
                .where(queued, _T.published_at <= now - timedelta(seconds=stale_after_seconds))
                .order_by(_T.published_at, _T.id)
                .limit(limit),
            )
        merged = sorted(never_published + stale, key=lambda r: (r.updated_at, str(r.job_id)))
        return merged[:limit]


def _no_clock() -> datetime:
    raise RuntimeError("PostgresJobStore reads the time from the database")
