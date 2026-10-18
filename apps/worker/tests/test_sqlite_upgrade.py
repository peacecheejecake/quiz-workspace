"""An existing SQLite job store from an older worker is upgraded in place."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import BaseModel
from quiz_worker.reconcile import reconcile_jobs
from quiz_worker.runner import JobContext, JobDefinition, JobResult, JobRunner, RunOutcome
from quiz_worker.store import (
    LEASE_EXPIRED_ERROR,
    SQLITE_SCHEMA_VERSION,
    JobRecord,
    JobStatus,
    SqliteJobStore,
)

from .conftest import WORKSPACE_ID, FakeClock

# The layout written by the first SqliteJobStore (P0.7 fix, commit 2620d19).
V1_SCHEMA = """
CREATE TABLE async_jobs (
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
    UNIQUE (workspace_id, job_type, idempotency_key)
);
CREATE INDEX async_jobs_status ON async_jobs (status, updated_at);
"""


class Payload(BaseModel):
    message: str


def _v1_row(
    job_id: UUID, status: str, *, attempts: int, now: float, lease_expires_at: float | None
) -> tuple[object, ...]:
    return (
        str(job_id), "echo", str(WORKSPACE_ID), f"key-{job_id.hex}", 1, status, attempts, 3,
        now, now, json.dumps({"message": "hi"}), None, None, None,
        "w-old" if status == "running" else None, lease_expires_at, now,
        now if status == "running" else None, None,
    )  # fmt: skip


def _create_v1_store(path: Path, clock: FakeClock) -> tuple[UUID, UUID]:
    queued, running = uuid4(), uuid4()
    now = clock.now.timestamp()
    conn = sqlite3.connect(path)
    try:
        conn.executescript(V1_SCHEMA)
        conn.execute("PRAGMA user_version = 1")
        insert = f"INSERT INTO async_jobs VALUES ({', '.join('?' * 19)})"  # noqa: S608
        conn.execute(insert, _v1_row(queued, "queued", attempts=0, now=now, lease_expires_at=None))
        conn.execute(
            insert, _v1_row(running, "running", attempts=1, now=now, lease_expires_at=now + 10)
        )
        conn.commit()
    finally:
        conn.close()
    return queued, running


def _columns(path: Path) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        return {row[1] for row in conn.execute("PRAGMA table_info(async_jobs)")}
    finally:
        conn.close()


def test_v1_store_is_upgraded_and_its_jobs_still_run(tmp_path: Path) -> None:
    clock = FakeClock()
    path = tmp_path / "jobs.sqlite3"
    queued_id, running_id = _create_v1_store(path, clock)

    store = SqliteJobStore(path, clock=clock)
    SqliteJobStore(path, clock=clock)  # reopening is a no-op

    assert {"cleanup_pending", "cleanup_attempts", "cleanup_next_at", "created_by"} <= _columns(
        path
    )
    queued = store.get(queued_id)
    assert queued is not None
    assert (queued.status, queued.cleanup_pending, queued.cleanup_attempts) == (
        JobStatus.QUEUED,
        False,
        0,
    )
    # v3 rebuilt the table: old rows keep their key, have no creator (deduplicated by id only).
    assert (queued.idempotency_key, queued.created_by) == (f"key-{queued_id.hex}", None)
    assert store.create(queued.to_envelope(), max_attempts=3) == queued

    calls: list[int] = []

    def handler(ctx: JobContext, payload: Payload) -> JobResult:
        calls.append(ctx.attempt)
        return {"ok": True}

    definition: JobDefinition[Payload] = JobDefinition(
        job_type="echo", payload_models={1: Payload}, handler=handler
    )
    runner = JobRunner(store, worker_id="w-new", lease_seconds=100, clock=clock)
    assert runner.run(definition, queued.to_envelope()).outcome is RunOutcome.SUCCEEDED

    # The old worker's running job had its lease run out: the reconciler requeues it.
    clock.advance(11)
    published: list[JobRecord] = []
    report = reconcile_jobs(
        store,
        published.append,
        {"echo": definition},
        unpublished_grace_seconds=60,
        stale_after_seconds=1000,
    )
    assert (report.requeued, [r.job_id for r in published]) == (1, [running_id])
    recovered = store.get(running_id)
    assert recovered is not None
    assert (recovered.status, recovered.last_error) == (JobStatus.QUEUED, LEASE_EXPIRED_ERROR)
    assert runner.run(definition, published[0].to_envelope()).outcome is RunOutcome.SUCCEEDED
    assert calls == [1, 2]


def test_fresh_store_records_the_current_schema_version(tmp_path: Path) -> None:
    path = tmp_path / "jobs.sqlite3"
    SqliteJobStore(path)

    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SQLITE_SCHEMA_VERSION
    finally:
        conn.close()


def test_store_refuses_a_newer_schema(tmp_path: Path) -> None:
    path = tmp_path / "jobs.sqlite3"
    SqliteJobStore(path)
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {SQLITE_SCHEMA_VERSION + 1}")
    conn.close()

    with pytest.raises(RuntimeError, match="newer than this worker"):
        SqliteJobStore(path)
