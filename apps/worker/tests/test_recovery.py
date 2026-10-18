"""Recovery paths: cleanup on terminal transitions without a handler, the reconciler, and
re-publishing jobs whose first publish failed."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID, uuid4

import pytest
from billiard.einfo import ExceptionWithTraceback  # type: ignore[attr-defined]  # no stub
from celery.exceptions import TimeLimitExceeded, WorkerLostError
from pydantic import BaseModel
from quiz_worker.celery_app import (
    QuizCelery,
    create_celery_app,
    release_lost_attempt,
    run_reconciler,
    settles_lost_attempt,
    submit_job,
    worker_id_for,
)
from quiz_worker.reconcile import ReconcileReport, reconcile_jobs
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import (
    JobContext,
    JobDefinition,
    JobResult,
    JobRunner,
    RunOutcome,
    TerminalReason,
)
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import (
    LEASE_EXPIRED_ERROR,
    WORKER_KILLED_ERROR,
    WORKER_LOST_ERROR,
    InMemoryJobStore,
    JobRecord,
    JobStatus,
    StaleClaimError,
    TransactionalJobStore,
)

from .conftest import BOOK_TEXT, TOKEN, EnvelopeFactory, FakeClock

LEASE = 100
GRACE = 60
STALE = 1000


class TextPayload(BaseModel):
    message: str


class Recorder:
    def __init__(self) -> None:
        self.cleanups: list[tuple[int, TerminalReason]] = []
        self.published: list[JobRecord] = []
        self.calls = 0

    def cleanup(self, ctx: JobContext, reason: TerminalReason) -> None:
        self.cleanups.append((ctx.attempt, reason))

    def publish(self, record: JobRecord) -> None:
        self.published.append(record)


def definition(
    recorder: Recorder, *, fail: bool = False, max_attempts: int = 3
) -> JobDefinition[TextPayload]:
    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        recorder.calls += 1
        if fail:
            raise RuntimeError(f"transient {payload.message}")
        return {"attempt": ctx.attempt}

    return JobDefinition(
        job_type="echo",
        payload_models={1: TextPayload},
        handler=handler,
        retry_policy=RetryPolicy(max_attempts=max_attempts, base_delay_seconds=5),
        cleanup=recorder.cleanup,
    )


@pytest.fixture
def runner(store: TransactionalJobStore, clock: FakeClock) -> JobRunner:
    return JobRunner(store, worker_id="w1", lease_seconds=LEASE, clock=clock)


def reconcile(store: TransactionalJobStore, recorder: Recorder, job: JobDefinition[Any]) -> Any:
    return reconcile_jobs(
        store,
        recorder.publish,
        {job.job_type: job},
        unpublished_grace_seconds=GRACE,
        stale_after_seconds=STALE,
    )


# -- cleanup on terminal transitions that happen without a running handler -------------------


def test_cancel_during_retry_countdown_cleans_up_earlier_attempts(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    assert runner.run(definition(recorder, fail=True), envelope).outcome is RunOutcome.RETRY

    store.request_cancel(envelope.job_id)  # while the retry message waits for its countdown
    result = runner.run(definition(recorder, fail=True), envelope.to_message())

    assert result.outcome is RunOutcome.CANCELLED
    assert recorder.calls == 1
    assert recorder.cleanups == [(1, "cancelled")]
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.CANCELLED, 1)


def test_cancel_before_any_attempt_needs_no_cleanup(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.request_cancel(envelope.job_id)

    assert runner.run(definition(recorder), envelope).outcome is RunOutcome.CANCELLED
    assert recorder.cleanups == []


def test_lost_worker_on_final_attempt_runs_cleanup(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="dead", lease_seconds=LEASE)
    clock.advance(LEASE + 1)

    result = runner.run(definition(recorder, max_attempts=1), envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    assert result.error == WORKER_LOST_ERROR
    assert recorder.cleanups == [(1, "failed")]


def test_cancelled_while_lost_runs_cleanup_on_redelivery(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.claim(envelope, worker_id="dead", lease_seconds=LEASE)
    store.request_cancel(envelope.job_id)
    clock.advance(LEASE + 1)

    result = runner.run(definition(recorder), envelope.to_message())

    assert result.outcome is RunOutcome.CANCELLED
    assert recorder.calls == 0
    assert recorder.cleanups == [(1, "cancelled")]


def test_cancel_at_the_start_of_a_later_attempt_still_cleans_up(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    recorder = Recorder()
    calls: list[int] = []

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.append(ctx.attempt)
        if ctx.attempt == 1:
            store.request_cancel(ctx.job_id)  # observed only at the next check
            raise RuntimeError("transient")
        return None

    job: JobDefinition[TextPayload] = JobDefinition(
        job_type="echo", payload_models={1: TextPayload}, handler=handler, cleanup=recorder.cleanup
    )
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    # Attempt 1 fails; the cancel flag is then seen by the claim of the next delivery.
    assert runner.run(job, envelope).outcome is RunOutcome.RETRY
    assert runner.run(job, envelope).outcome is RunOutcome.CANCELLED
    assert calls == [1]
    assert recorder.cleanups == [(1, "cancelled")]


# -- reconciler ----------------------------------------------------------------------------


def test_unpublished_job_is_published_after_the_grace_period(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    recorder = Recorder()
    job = definition(recorder)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)  # the publish after the insert never happened

    assert reconcile(store, recorder, job).republished == 0
    clock.advance(GRACE)
    report = reconcile(store, recorder, job)

    assert report.republished == 1
    assert [r.job_id for r in recorder.published] == [envelope.job_id]
    assert recorder.published[0].to_envelope() == envelope
    record = store.get(envelope.job_id)
    assert record is not None
    assert record.published_at == clock.now
    # Published now: nothing to do until it is stale.
    assert reconcile(store, recorder, job).republished == 0


def test_transitions_at_one_frozen_instant_persist_exactly_what_they_return(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    # create and request_cancel compute the same updated_at; the stored row must keep it
    # (Postgres: the trigger must not swap in its own now()), or the reconciler's grace-period
    # comparison runs against a different time than the worker's.
    envelope = make_envelope()
    created = store.create(envelope, max_attempts=3)
    flagged = store.request_cancel(envelope.job_id)

    assert flagged.updated_at == created.updated_at == clock.now
    assert store.get(envelope.job_id) == flagged
    assert store.find_republish_candidates(
        unpublished_grace_seconds=GRACE, stale_after_seconds=STALE, limit=10
    ) == []  # fmt: skip
    clock.advance(GRACE)
    candidates = store.find_republish_candidates(
        unpublished_grace_seconds=GRACE, stale_after_seconds=STALE, limit=10
    )
    assert candidates == [flagged]


def test_published_but_unclaimed_job_is_republished_when_stale(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    recorder = Recorder()
    job = definition(recorder)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.mark_published(envelope.job_id)

    clock.advance(STALE - 1)
    assert reconcile(store, recorder, job).republished == 0
    clock.advance(1)
    assert reconcile(store, recorder, job).republished == 1


def test_expired_lease_without_a_message_is_requeued_and_republished(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    recorder = Recorder()
    job = definition(recorder)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.mark_published(envelope.job_id)
    # Attempt 1 is killed by the hard time limit and its message acked: nothing re-delivers.
    lost = store.claim(envelope, worker_id="dead", lease_seconds=LEASE).record
    assert lost is not None

    clock.advance(LEASE - 1)
    assert reconcile(store, recorder, job).requeued == 0  # live lease is left alone
    clock.advance(2)
    report = reconcile(store, recorder, job)

    assert (report.requeued, report.republished) == (1, 1)
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.last_error) == (JobStatus.QUEUED, LEASE_EXPIRED_ERROR)
    assert record.published_at == clock.now
    assert recorder.cleanups == []
    # The republished message runs attempt 2; the stale attempt 1 can no longer write.
    assert runner.run(job, recorder.published[0].to_envelope()).outcome is RunOutcome.SUCCEEDED
    with pytest.raises(StaleClaimError):
        store.complete(envelope.job_id, attempt=lost.attempts, result=None)


@pytest.mark.parametrize(
    ("max_attempts", "cancel", "status", "reason"),
    [
        (1, False, JobStatus.FAILED, "failed"),
        (3, True, JobStatus.CANCELLED, "cancelled"),
    ],
)
def test_expired_lease_is_settled_with_cleanup_when_it_cannot_run_again(
    store: TransactionalJobStore,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
    max_attempts: int,
    cancel: bool,
    status: JobStatus,
    reason: TerminalReason,
) -> None:
    recorder = Recorder()
    job = definition(recorder, max_attempts=max_attempts)
    envelope = make_envelope()
    store.create(envelope, max_attempts=max_attempts)
    store.claim(envelope, worker_id="dead", lease_seconds=LEASE)
    if cancel:
        store.request_cancel(envelope.job_id)
    clock.advance(LEASE + 1)

    report = reconcile(store, recorder, job)

    assert report.republished == 0
    record = store.get(envelope.job_id)
    assert record is not None
    assert record.status is status
    assert recorder.cleanups == [(1, reason)]
    if status is JobStatus.FAILED:
        assert record.last_error == WORKER_LOST_ERROR


def test_recover_expired_is_conditional_on_the_attempt_and_the_lease(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, clock: FakeClock
) -> None:
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.claim(envelope, worker_id="w", lease_seconds=LEASE)

    assert store.recover_expired(envelope.job_id, attempt=1) is None  # lease still live
    clock.advance(LEASE + 1)
    assert store.recover_expired(envelope.job_id, attempt=2) is None  # wrong attempt
    assert store.recover_expired(envelope.job_id, attempt=1) is not None
    assert store.recover_expired(envelope.job_id, attempt=1) is None  # already settled


def test_publish_errors_are_logged_sanitized_and_retried_next_pass(
    store: TransactionalJobStore,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    recorder = Recorder()
    job = definition(recorder)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    clock.advance(GRACE)

    def broken(record: JobRecord) -> None:
        raise ConnectionError(f"redis://:{TOKEN}@redis rejected {BOOK_TEXT}")

    caplog.set_level(logging.INFO)
    report = reconcile_jobs(
        store,
        broken,
        {"echo": job},
        unpublished_grace_seconds=GRACE,
        stale_after_seconds=STALE,
    )

    assert (report.republished, report.publish_errors) == (0, 1)
    record = store.get(envelope.job_id)
    assert record is not None
    assert record.published_at is None
    assert TOKEN not in caplog.text
    assert BOOK_TEXT not in caplog.text
    assert reconcile(store, recorder, job).republished == 1


# -- submit_job after a failed publish ------------------------------------------------------


class FlakyPublisher:
    """Makes the first `failures` publishes of the echo task raise, like a broker outage."""

    def __init__(self, app: QuizCelery, monkeypatch: pytest.MonkeyPatch, failures: int) -> None:
        self.failures = failures
        task = app.tasks["quiz.jobs.echo"]
        original = task.apply_async

        def apply_async(*args: Any, **kwargs: Any) -> Any:
            if self.failures > 0:
                self.failures -= 1
                raise ConnectionError("broker unavailable")
            return original(*args, **kwargs)

        monkeypatch.setattr(task, "apply_async", apply_async)


@pytest.fixture
def eager_app(eager_settings: WorkerSettings, clock: FakeClock) -> QuizCelery:
    return create_celery_app(
        eager_settings.model_copy(update={"reconcile_unpublished_grace_seconds": GRACE}),
        job_store=InMemoryJobStore(clock=clock),
    )


def test_resubmitting_after_a_failed_publish_recovers_the_job(
    eager_app: QuizCelery, monkeypatch: pytest.MonkeyPatch, make_envelope: EnvelopeFactory
) -> None:
    FlakyPublisher(eager_app, monkeypatch, failures=1)
    envelope = make_envelope(payload={"message": "hello"}, idempotency_key="upload-9")

    with pytest.raises(ConnectionError):
        submit_job(eager_app, envelope)
    stranded = eager_app.job_store.get(envelope.job_id)
    assert stranded is not None
    assert (stranded.status, stranded.published_at) == (JobStatus.QUEUED, None)

    # The client retries with the same idempotency key (a fresh job id is ignored).
    retried = make_envelope(payload={"message": "hello"}, idempotency_key="upload-9")
    record = submit_job(eager_app, retried)

    assert record.job_id == envelope.job_id
    assert (record.status, record.result) == (JobStatus.SUCCEEDED, {"length": 5})
    # Further submits of a finished job publish nothing.
    assert submit_job(eager_app, envelope) == record


def test_reconciler_recovers_a_job_whose_publish_failed(
    eager_app: QuizCelery,
    monkeypatch: pytest.MonkeyPatch,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    FlakyPublisher(eager_app, monkeypatch, failures=1)
    envelope = make_envelope(payload={"message": "hello"})
    with pytest.raises(ConnectionError):
        submit_job(eager_app, envelope)

    assert run_reconciler(eager_app).republished == 0  # still within the grace period
    clock.advance(GRACE)
    report = run_reconciler(eager_app)

    assert report.republished == 1
    record = eager_app.job_store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.SUCCEEDED, 1)


def test_reconcile_task_is_registered_and_scheduled(eager_app: QuizCelery) -> None:
    task = eager_app.tasks["quiz.maintenance.reconcile_jobs"]

    assert task.apply().get() == ReconcileReport().as_dict()
    schedule = eager_app.conf.beat_schedule["reconcile-jobs"]
    assert schedule["task"] == "quiz.maintenance.reconcile_jobs"
    assert schedule["schedule"] == eager_app.worker_settings.reconcile_interval_seconds


def test_unknown_job_type_is_not_republished(make_envelope: EnvelopeFactory) -> None:
    clock = FakeClock()
    store = InMemoryJobStore(clock=clock)
    recorder = Recorder()
    store.create(make_envelope("legacy.job", job_id=uuid4()), max_attempts=1)
    clock.advance(GRACE)

    report = reconcile(store, recorder, definition(recorder))

    assert (report.republished, report.publish_errors) == (0, 1)
    assert recorder.published == []


# -- A worker process that died mid-attempt (M7.4c) ------------------------------------------


def test_lost_worker_process_is_requeued_without_waiting_for_the_lease(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    # An OOM-killed child used to leave the job `running` until its lease ran out (~32 min);
    # the worker now settles the attempt as soon as it sees the child die.
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.claim(envelope, worker_id="node:101", lease_seconds=LEASE)

    assert store.release_lost(envelope.job_id, worker_id="node:202") is None
    assert store.release_lost(envelope.job_id, worker_id="node") is None
    released = store.release_lost(envelope.job_id, worker_id="node:101")

    assert released is not None
    assert (released.status, released.attempts) == (JobStatus.QUEUED, 1)
    assert released.last_error == WORKER_KILLED_ERROR
    assert (released.locked_by, released.lease_expires_at) == (None, None)
    # The message is re-queued right after, so the reconciler must not publish a duplicate.
    assert released.published_at == clock()
    assert (
        store.find_republish_candidates(
            unpublished_grace_seconds=GRACE, stale_after_seconds=STALE, limit=10
        )
        == []
    )
    assert store.get(envelope.job_id) == released
    # The re-delivered message starts the next attempt at once (no lease left to wait out).
    result = runner.run(definition(recorder), envelope.to_message())
    assert result.outcome is RunOutcome.SUCCEEDED
    assert (recorder.calls, store.get(envelope.job_id).attempts) == (1, 2)  # type: ignore[union-attr]
    assert store.release_lost(envelope.job_id, worker_id="w1") is None


def test_lost_worker_process_on_the_final_attempt_fails_with_cleanup(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
) -> None:
    recorder = Recorder()
    envelope = make_envelope()
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="node:101", lease_seconds=LEASE)

    failed = store.release_lost(envelope.job_id, worker_id="node:101")

    assert failed is not None
    assert (failed.status, failed.last_error) == (JobStatus.FAILED, WORKER_LOST_ERROR)
    assert failed.cleanup_pending
    # The re-queued message finds the job finished and runs its cleanup.
    result = runner.run(definition(recorder, max_attempts=1), envelope.to_message())
    assert result.outcome is RunOutcome.DUPLICATE_FINISHED
    assert recorder.calls == 0
    assert recorder.cleanups == [(1, "failed")]


def test_lost_worker_process_with_a_cancel_request_is_cancelled(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.claim(envelope, worker_id="node:101", lease_seconds=LEASE)
    store.request_cancel(envelope.job_id)

    cancelled = store.release_lost(envelope.job_id, worker_id="node:101")

    assert cancelled is not None
    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.cleanup_pending


def test_release_of_a_lost_attempt_is_logged_and_never_raises(
    store: TransactionalJobStore,
    make_envelope: EnvelopeFactory,
    eager_settings: WorkerSettings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = create_celery_app(eager_settings, job_store=store)
    envelope = make_envelope(payload={"message": BOOK_TEXT})
    store.create(envelope, max_attempts=3)
    store.claim(envelope, worker_id=worker_id_for(4242), lease_seconds=LEASE)

    with caplog.at_level(logging.WARNING):
        release_lost_attempt(app, str(envelope.job_id), None)  # the child never accepted it
        release_lost_attempt(app, "not-a-job-id", 4242)
        release_lost_attempt(app, str(envelope.job_id), 4243)  # another child's claim
        assert store.get(envelope.job_id).status is JobStatus.RUNNING  # type: ignore[union-attr]
        release_lost_attempt(app, str(envelope.job_id), "4242")

    assert store.get(envelope.job_id).status is JobStatus.QUEUED  # type: ignore[union-attr]
    assert "lost with its worker process" in caplog.text
    assert BOOK_TEXT not in caplog.text

    class BrokenStore(InMemoryJobStore):
        def release_lost(self, job_id: UUID, *, worker_id: str) -> JobRecord | None:
            raise RuntimeError(f"db down {BOOK_TEXT}")

    broken = create_celery_app(eager_settings, job_store=BrokenStore())
    with caplog.at_level(logging.ERROR):
        release_lost_attempt(broken, str(envelope.job_id), 4242)
    assert "could not release a lost job attempt: unexpected_error: RuntimeError" in caplog.text
    assert "db down" not in caplog.text


def test_only_an_exited_worker_process_settles_its_attempt() -> None:
    # A hard TimeLimitExceeded is reported before billiard kills the child (it may still run).
    assert settles_lost_attempt(WorkerLostError("Worker exited prematurely: signal 9"))
    assert not settles_lost_attempt(TimeLimitExceeded(7200))
    assert not settles_lost_attempt(RuntimeError("handler failed"))
    # Failures from the child arrive wrapped (the original in `.exc`).
    assert settles_lost_attempt(ExceptionWithTraceback(WorkerLostError("lost"), "tb"))
    assert not settles_lost_attempt(ExceptionWithTraceback(TimeLimitExceeded(2), "tb"))
    assert not settles_lost_attempt(None)
