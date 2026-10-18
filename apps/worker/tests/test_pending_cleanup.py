"""Persisted cleanup of failed/cancelled jobs: survives crashes and cleanup errors."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from pydantic import BaseModel
from quiz_worker.reconcile import ReconcileReport, reconcile_jobs
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import (
    CleanupOutcome,
    CleanupPolicy,
    JobContext,
    JobDefinition,
    JobResult,
    JobRunner,
    RunOutcome,
    TerminalReason,
    perform_cleanup,
)
from quiz_worker.store import JobRecord, JobStatus, TransactionalJobStore

from .conftest import BOOK_TEXT, TOKEN, EnvelopeFactory, FakeClock

LEASE = 100
POLICY = CleanupPolicy(
    retry=RetryPolicy(max_attempts=3, base_delay_seconds=60, max_delay_seconds=600),
    lease_seconds=300,
)


class Payload(BaseModel):
    message: str


class Cleaner:
    """Cleanup that fails its first `failures` calls, then succeeds; idempotent."""

    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.calls: list[TerminalReason] = []
        self.artifacts = {"tmp/copy-1"}

    def __call__(self, ctx: JobContext, reason: TerminalReason) -> None:
        self.calls.append(reason)
        if self.failures > 0:
            self.failures -= 1
            raise OSError(f"storage rejected {BOOK_TEXT} token={TOKEN}")
        self.artifacts.discard("tmp/copy-1")  # deleting twice is a no-op


def job(cleaner: Cleaner, *, fail: bool = True) -> JobDefinition[Payload]:
    def handler(ctx: JobContext, payload: Payload) -> JobResult:
        if fail:
            raise ValueError("permanent")  # retried until max_attempts, then failed
        return None

    return JobDefinition(
        job_type="echo",
        payload_models={1: Payload},
        handler=handler,
        retry_policy=RetryPolicy(max_attempts=1),
        cleanup=cleaner,
    )


@pytest.fixture
def runner(store: TransactionalJobStore, clock: FakeClock) -> JobRunner:
    return JobRunner(store, worker_id="w1", lease_seconds=LEASE, clock=clock, cleanup_policy=POLICY)


def reconcile(store: TransactionalJobStore, definition: JobDefinition[Any]) -> ReconcileReport:
    published: list[JobRecord] = []
    return reconcile_jobs(
        store,
        published.append,
        {definition.job_type: definition},
        unpublished_grace_seconds=60,
        stale_after_seconds=10_000,
        cleanup_policy=POLICY,
    )


def get(store: TransactionalJobStore, record_id: Any) -> JobRecord:
    record = store.get(record_id)
    assert record is not None
    return record


def test_terminal_transition_persists_the_cleanup_obligation_atomically(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)

    failed = store.fail(envelope.job_id, attempt=1, error="boom")

    assert (failed.status, failed.cleanup_pending, failed.cleanup_attempts) == (
        JobStatus.FAILED,
        True,
        0,
    )
    assert get(store, envelope.job_id) == failed


def test_crash_between_terminal_commit_and_cleanup_is_cleaned_up_by_the_reconciler(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    cleaner = Cleaner()
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)
    # The worker commits `failed` and dies before running cleanup.
    store.fail(envelope.job_id, attempt=1, error="boom")

    report = reconcile(store, job(cleaner))

    assert report.cleaned == 1
    assert cleaner.calls == ["failed"]
    assert cleaner.artifacts == set()
    assert get(store, envelope.job_id).cleanup_pending is False


def test_crash_during_cleanup_is_retried_after_its_lease(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    cleaner = Cleaner()
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)
    store.fail(envelope.job_id, attempt=1, error="boom")
    # A cleaner took the cleanup and died mid-way.
    assert store.claim_cleanup(envelope.job_id, lease_seconds=300, max_attempts=3) is not None

    assert reconcile(store, job(cleaner)).cleaned == 0  # still leased
    clock.advance(300)
    assert reconcile(store, job(cleaner)).cleaned == 1

    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (False, 2)
    assert cleaner.calls == ["failed"]


def test_raising_cleanup_is_retried_with_backoff_until_it_succeeds(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    cleaner = Cleaner(failures=2)
    definition = job(cleaner)
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    caplog.set_level(logging.INFO)

    # The runner fails the job and its first cleanup try raises.
    assert runner.run(definition, envelope).outcome is RunOutcome.FAILED
    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (True, 1)
    assert record.cleanup_last_error == "unexpected_error: OSError"

    assert reconcile(store, definition).cleanup_failed == 0  # backing off (60s)
    clock.advance(60)
    assert reconcile(store, definition).cleanup_failed == 1  # try 2 raises
    clock.advance(119)
    assert reconcile(store, definition).cleaned == 0  # next try after 120s
    clock.advance(1)
    assert reconcile(store, definition).cleaned == 1  # try 3 succeeds

    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (False, 3)
    assert cleaner.calls == ["failed"] * 3
    assert cleaner.artifacts == set()
    assert BOOK_TEXT not in caplog.text
    assert TOKEN not in caplog.text


def test_exhausted_cleanup_stays_flagged_and_is_reported(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    cleaner = Cleaner(failures=99)
    definition = job(cleaner)
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    caplog.set_level(logging.WARNING)

    runner.run(definition, envelope)  # try 1
    clock.advance(60)
    reconcile(store, definition)  # try 2
    clock.advance(120)
    report = reconcile(store, definition)  # try 3, the last one
    clock.advance(10_000)
    later = reconcile(store, definition)

    assert report.cleanup_gave_up == 1
    assert later.as_dict() == ReconcileReport().as_dict()
    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (True, 3)
    assert store.find_pending_cleanups(max_attempts=3, limit=10) == []
    assert len(cleaner.calls) == 3
    assert "job stays flagged cleanup_pending" in caplog.text


def test_redelivery_of_a_terminal_job_runs_its_pending_cleanup(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    cleaner = Cleaner()
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)
    store.cancel(envelope.job_id, attempt=1)  # committed, then the worker died

    result = runner.run(job(cleaner), envelope)

    assert result.outcome is RunOutcome.DUPLICATE_FINISHED
    assert cleaner.calls == ["cancelled"]
    assert get(store, envelope.job_id).cleanup_pending is False


def test_cleanup_runs_once_however_often_it_is_triggered(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    cleaner = Cleaner()
    definition = job(cleaner)
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)

    runner.run(definition, envelope)  # fails and cleans up
    for _ in range(3):
        clock.advance(10_000)
        runner.run(definition, envelope)  # redelivery
        reconcile(store, definition)

    assert cleaner.calls == ["failed"]
    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (False, 1)


def test_concurrent_cleaners_and_stale_tries_are_fenced(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)
    store.fail(envelope.job_id, attempt=1, error="boom")

    first = store.claim_cleanup(envelope.job_id, lease_seconds=300, max_attempts=3)
    assert first is not None
    assert store.claim_cleanup(envelope.job_id, lease_seconds=300, max_attempts=3) is None
    clock.advance(300)
    second = store.claim_cleanup(envelope.job_id, lease_seconds=300, max_attempts=3)
    assert second is not None

    # The first (timed-out) try can no longer settle the cleanup.
    assert store.finish_cleanup(envelope.job_id, cleanup_attempt=first.cleanup_attempts) is None
    assert (
        store.fail_cleanup(
            envelope.job_id,
            cleanup_attempt=first.cleanup_attempts,
            error="x",
            retry_after_seconds=1,
        )
        is None
    )
    assert store.finish_cleanup(envelope.job_id, cleanup_attempt=second.cleanup_attempts)


def test_successful_and_never_started_jobs_owe_no_cleanup(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    cleaner = Cleaner()
    ok = make_envelope(payload={"message": "x"})
    cancelled_early = make_envelope(payload={"message": "y"})
    for envelope in (ok, cancelled_early):
        store.create(envelope, max_attempts=1)
    store.request_cancel(cancelled_early.job_id)

    runner.run(job(cleaner, fail=False), ok)
    runner.run(job(cleaner, fail=False), cancelled_early)

    assert get(store, ok.job_id).cleanup_pending is False
    assert get(store, cancelled_early.job_id).cleanup_pending is False
    assert cleaner.calls == []


def test_missing_definition_keeps_the_cleanup_pending(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(payload={"message": "x"})
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)
    store.fail(envelope.job_id, attempt=1, error="boom")

    outcome = perform_cleanup(store, None, envelope.job_id, POLICY)

    assert outcome is CleanupOutcome.SKIPPED
    record = get(store, envelope.job_id)
    assert (record.cleanup_pending, record.cleanup_attempts) == (True, 0)
