"""PostgresJobStore against the local Supabase Postgres, acting as `quiz_worker`.

The shared store suites (test_runner, test_recovery, test_pending_cleanup, broker transport)
already run against Postgres through the `store` fixture; this file covers what only a real
database can show: concurrent workers racing on row locks, the database clock, rows written by
the API with column defaults, and that the reconciler scans are index scans.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from datetime import UTC, timedelta
from functools import partial
from typing import Any
from uuid import UUID, uuid4

import pytest
from quiz_worker.pg_store import PostgresJobStore
from quiz_worker.store import (
    ClaimOutcome,
    ClaimResult,
    JobRecord,
    JobStatus,
    StaleClaimError,
)
from sqlalchemy import event, text

from .conftest import EnvelopeFactory, FakeClock, PgEngines, Tenancy

pytestmark = pytest.mark.infra

LEASE = 100
RACERS = 6
SCAN_INDEXES = frozenset(
    {
        "async_jobs_active_idx",
        "async_jobs_status_lease_idx",
        "async_jobs_status_published_idx",
        "async_jobs_cleanup_due_idx",
    }
)


@pytest.fixture
def pg(pg_engines: PgEngines, pg_tenancy: Tenancy, clock: FakeClock) -> PostgresJobStore:
    return PostgresJobStore(pg_engines.worker, clock=clock)


@pytest.fixture
def tenancy(pg_tenancy: Tenancy) -> Tenancy:
    # `make_envelope` creates jobs in this test's real workspace, owned by its real user.
    return pg_tenancy


def race[T](calls: list[Callable[[], T]]) -> list[T]:
    """Run the calls in parallel threads released at the same moment."""
    barrier = threading.Barrier(len(calls))
    results: list[Any] = [None] * len(calls)
    errors: list[BaseException] = []

    def run(i: int) -> None:
        barrier.wait()
        try:
            results[i] = calls[i]()
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(calls))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    if errors:
        raise errors[0]
    return results


def test_concurrent_claims_of_one_job_have_exactly_one_winner(
    pg_engines: PgEngines, pg_tenancy: Tenancy, make_envelope: EnvelopeFactory
) -> None:
    # Each racer is its own store instance (separate pooled connections), on the DB clock.
    stores = [PostgresJobStore(pg_engines.worker) for _ in range(RACERS)]
    for _ in range(5):
        envelope = make_envelope()
        stores[0].create(envelope, max_attempts=3)

        results: list[ClaimResult] = race(
            [
                partial(s.claim, envelope, worker_id=f"w{i}", lease_seconds=LEASE)
                for i, s in enumerate(stores)
            ]
        )

        outcomes = sorted(r.outcome for r in results)
        assert outcomes == sorted([ClaimOutcome.CLAIMED] + [ClaimOutcome.IN_PROGRESS] * 5)
        winner = next(r.record for r in results if r.outcome is ClaimOutcome.CLAIMED)
        stored = stores[0].get(envelope.job_id)
        assert stored is not None
        assert winner is not None
        assert (stored.status, stored.attempts, stored.locked_by) == (
            JobStatus.RUNNING,
            1,
            winner.locked_by,
        )


def test_expired_lease_is_recovered_once_under_concurrent_claims_and_reconcilers(
    pg: PostgresJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    envelope = make_envelope()
    pg.create(envelope, max_attempts=3)
    lost = pg.claim(envelope, worker_id="dead", lease_seconds=LEASE).record
    assert lost is not None
    clock.advance(LEASE + 1)

    calls: list[Callable[[], object]] = []
    for i in range(RACERS // 2):
        calls.append(partial(pg.claim, envelope, worker_id=f"w{i}", lease_seconds=LEASE))
        calls.append(partial(pg.recover_expired, envelope.job_id, attempt=1))
    results = race(calls)

    claims = [r for r in results if isinstance(r, ClaimResult)]
    recovered = [r for r in results if isinstance(r, JobRecord)]
    assert [c.outcome for c in claims].count(ClaimOutcome.CLAIMED) == 1
    assert len(recovered) <= 1  # the lease is settled at most once
    record = pg.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.RUNNING, 2)
    with pytest.raises(StaleClaimError):
        pg.complete(envelope.job_id, attempt=lost.attempts, result=None)


def _failed_with_cleanup(pg: PostgresJobStore, make_envelope: EnvelopeFactory) -> UUID:
    envelope = make_envelope()
    pg.create(envelope, max_attempts=1)
    pg.claim(envelope, worker_id="w", lease_seconds=LEASE)
    failed = pg.fail(envelope.job_id, attempt=1, error="boom")
    assert failed.cleanup_pending
    return envelope.job_id


def test_concurrent_cleanup_claims_are_fenced(
    pg: PostgresJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    job_id = _failed_with_cleanup(pg, make_envelope)

    claimed = race([lambda: pg.claim_cleanup(job_id, lease_seconds=300, max_attempts=3)] * RACERS)

    winners = [c for c in claimed if c is not None]
    assert [w.cleanup_attempts for w in winners] == [1]

    # The first try's lease runs out while it is still finishing: either it settles first
    # (then nobody re-claims), or the second try takes over (then the first is fenced off).
    clock.advance(300)
    finished, second = race(
        [
            lambda: pg.finish_cleanup(job_id, cleanup_attempt=1),
            lambda: pg.claim_cleanup(job_id, lease_seconds=300, max_attempts=3),
        ]
    )
    record = pg.get(job_id)
    assert record is not None
    assert (finished is None) != (second is None)
    if finished is not None:
        assert (record.cleanup_pending, record.cleanup_attempts) == (False, 1)
    else:
        assert (record.cleanup_pending, record.cleanup_attempts) == (True, 2)
        assert pg.fail_cleanup(job_id, cleanup_attempt=1, error="x", retry_after_seconds=1) is None


def test_reconciler_scans_are_bounded_and_ordered(
    pg: PostgresJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    running = []
    for _ in range(3):
        envelope = make_envelope()
        pg.create(envelope, max_attempts=3)
        pg.mark_published(envelope.job_id)
        pg.claim(envelope, worker_id="w", lease_seconds=LEASE)
        running.append(envelope.job_id)
        clock.advance(1)
    unpublished = make_envelope()
    pg.create(unpublished, max_attempts=3)
    cleanups = []
    for _ in range(3):
        cleanups.append(_failed_with_cleanup(pg, make_envelope))
        clock.advance(1)

    assert pg.find_expired_leases(limit=10) == []
    clock.advance(LEASE + 1)

    assert [r.job_id for r in pg.find_expired_leases(limit=2)] == running[:2]
    assert [r.job_id for r in pg.find_republish_candidates(
        unpublished_grace_seconds=60, stale_after_seconds=10_000, limit=10
    )] == [unpublished.job_id]  # fmt: skip
    assert [r.job_id for r in pg.find_pending_cleanups(max_attempts=3, limit=2)] == cleanups[:2]
    assert pg.find_pending_cleanups(max_attempts=0, limit=10) == []
    for record in pg.find_expired_leases(limit=10):
        assert record.lease_expires_at is not None
        assert record.lease_expires_at.tzinfo is not None
        assert record.lease_expires_at.utcoffset() == timedelta(0)


@pytest.fixture
def captured_sql(pg_engines: PgEngines) -> Iterator[list[tuple[str, Any]]]:
    statements: list[tuple[str, Any]] = []

    def capture(
        conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, many: bool
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT") and "async_jobs" in statement:
            statements.append((statement, parameters))

    event.listen(pg_engines.worker, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(pg_engines.worker, "before_cursor_execute", capture)


@pytest.mark.parametrize(
    ("scan", "index"),
    [
        (lambda s: s.find_expired_leases(limit=10), "async_jobs_status_lease_idx"),
        (
            lambda s: s.find_republish_candidates(
                unpublished_grace_seconds=60, stale_after_seconds=600, limit=10
            ),
            "async_jobs_status_published_idx",
        ),
        (
            lambda s: s.find_pending_cleanups(max_attempts=3, limit=10),
            "async_jobs_cleanup_due_idx",
        ),
    ],
)
def test_reconciler_scans_use_their_indexes(
    pg: PostgresJobStore,
    pg_engines: PgEngines,
    captured_sql: list[tuple[str, Any]],
    scan: Callable[[PostgresJobStore], object],
    index: str,
) -> None:
    scan(pg)
    assert captured_sql
    raw = pg_engines.admin.raw_connection()
    try:
        cursor = raw.cursor()
        # All rolled back below. Tiny test tables are always seq-scanned and the planner may
        # pick any index on the status prefix, so forbid seq scans and hide the other scan
        # indexes: the plan then shows that the scan's own index serves its predicate.
        cursor.execute("set local lock_timeout = '2s'")
        cursor.execute("set local enable_seqscan = off")
        for name in sorted(SCAN_INDEXES - {index}):
            cursor.execute(f"drop index public.{name}")
        for statement, parameters in captured_sql:
            cursor.execute(f"explain {statement}", parameters)
            plan = "\n".join(row[0] for row in cursor.fetchall())
            assert index in plan, plan
            assert "Seq Scan" not in plan, plan
    finally:
        raw.rollback()
        raw.close()


def test_database_clock_drives_leases_when_no_clock_is_injected(
    pg_engines: PgEngines, pg_tenancy: Tenancy, make_envelope: EnvelopeFactory
) -> None:
    store = PostgresJobStore(pg_engines.worker)
    with pg_engines.admin.connect() as conn:
        db_now = conn.execute(text("select clock_timestamp()")).scalar_one()
    envelope = make_envelope()

    created = store.create(envelope, max_attempts=3)
    claimed = store.claim(envelope, worker_id="w", lease_seconds=LEASE).record

    assert claimed is not None
    assert claimed.lease_expires_at is not None
    assert abs((created.created_at - db_now).total_seconds()) < 30
    assert claimed.lease_expires_at - claimed.updated_at == timedelta(seconds=LEASE)
    assert claimed.lease_expires_at.tzinfo is UTC


def test_a_job_inserted_by_the_api_with_column_defaults_is_claimable(
    pg: PostgresJobStore, pg_engines: PgEngines, pg_tenancy: Tenancy, make_envelope: EnvelopeFactory
) -> None:
    # The API (quiz_api) inserts only the identity columns and relies on the defaults.
    envelope = make_envelope(payload={"message": "hi"})
    with pg_engines.admin.begin() as conn:
        conn.execute(
            text(
                "insert into public.async_jobs "
                "(id, workspace_id, created_by, job_type, idempotency_key, payload) "
                "values (:id, :ws, :by, :type, :key, cast(:payload as jsonb))"
            ),
            {
                "id": envelope.job_id,
                "ws": envelope.workspace_id,
                "by": envelope.created_by,
                "type": envelope.job_type,
                "key": envelope.idempotency_key,
                "payload": '{"message": "hi"}',
            },
        )

    stored = pg.get(envelope.job_id)
    assert stored is not None
    assert (stored.status, stored.max_attempts, stored.published_at) == (JobStatus.QUEUED, 3, None)
    assert stored.to_envelope() == envelope
    # A worker re-submitting the same key gets the API's row, not a second job.
    duplicate = make_envelope(idempotency_key=envelope.idempotency_key, payload={"message": "x"})
    assert pg.create(duplicate, max_attempts=3).job_id == envelope.job_id
    assert pg.claim(envelope, worker_id="w", lease_seconds=LEASE).outcome is ClaimOutcome.CLAIMED


def test_unknown_job_and_identity_clash(
    pg: PostgresJobStore, make_envelope: EnvelopeFactory
) -> None:
    assert pg.get(uuid4()) is None
    envelope = make_envelope()
    pg.create(envelope, max_attempts=3)
    with pytest.raises(ValueError, match="job_id already used"):
        pg.create(make_envelope("workspace.fork", job_id=envelope.job_id), max_attempts=3)
