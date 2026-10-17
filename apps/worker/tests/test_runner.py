"""JobRunner over both JobStores: the idempotency, retry and cancellation contract."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from pydantic import BaseModel
from quiz_worker.errors import JobError, NonRetryableJobError
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import (
    JobContext,
    JobDefinition,
    JobResult,
    JobRunner,
    RunOutcome,
    TerminalReason,
)
from quiz_worker.store import (
    WORKER_LOST_ERROR,
    JobStatus,
    StaleClaimError,
    TransactionalJobStore,
)

from .conftest import BOOK_TEXT, TOKEN, EnvelopeFactory, FakeClock, Tenancy

LEASE = 100


class TextPayload(BaseModel):
    message: str


Handler = Callable[[JobContext, TextPayload], JobResult]


def definition(
    handler: Handler,
    *,
    max_attempts: int = 3,
    cleanup: Callable[[JobContext, TerminalReason], None] | None = None,
) -> JobDefinition[TextPayload]:
    return JobDefinition(
        job_type="echo",
        payload_models={1: TextPayload},
        handler=handler,
        retry_policy=RetryPolicy(
            max_attempts=max_attempts, base_delay_seconds=10, max_delay_seconds=40
        ),
        cleanup=cleanup,
    )


@pytest.fixture
def runner(store: TransactionalJobStore, clock: FakeClock) -> JobRunner:
    return JobRunner(store, worker_id="w1", lease_seconds=LEASE, clock=clock)


class Calls:
    def __init__(self) -> None:
        self.count = 0
        self.cleanups: list[TerminalReason] = []

    def cleanup(self, ctx: JobContext, reason: TerminalReason) -> None:
        self.cleanups.append(reason)


def test_success_records_result_and_single_attempt(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    job = definition(lambda ctx, p: {"length": len(p.message)})
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)

    result = runner.run(job, envelope.to_message())

    assert result.outcome is RunOutcome.SUCCEEDED
    record = store.get(envelope.job_id)
    assert record is not None
    assert record.status is JobStatus.SUCCEEDED
    assert record.attempts == 1
    assert record.result == {"length": len(BOOK_TEXT)}
    assert result.summary() == {"job_id": str(envelope.job_id), "outcome": "succeeded"}


def test_duplicate_delivery_after_success_is_a_noop(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        return {"n": calls.count}

    job = definition(handler)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    runner.run(job, envelope.to_message())
    before = store.get(envelope.job_id)
    clock.advance(LEASE * 10)

    again = runner.run(job, envelope.to_message())

    assert again.outcome is RunOutcome.DUPLICATE_FINISHED
    assert calls.count == 1
    assert store.get(envelope.job_id) == before


def test_concurrent_duplicate_cannot_run_twice(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    entered = threading.Event()
    release = threading.Event()
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        entered.set()
        assert release.wait(5)
        return None

    job = definition(handler)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    first: dict[str, Any] = {}
    thread = threading.Thread(target=lambda: first.update(r=runner.run(job, envelope.to_message())))
    thread.start()
    assert entered.wait(5)

    duplicate = runner.run(job, envelope.to_message())
    release.set()
    thread.join(5)

    assert duplicate.outcome is RunOutcome.DUPLICATE_RUNNING
    # Re-check right after the live lease could have expired.
    assert duplicate.countdown == LEASE + 1
    assert first["r"].outcome is RunOutcome.SUCCEEDED
    assert calls.count == 1


def test_failure_records_sanitized_error_and_retries_up_to_the_limit(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        raise RuntimeError(f"parser choked on {payload.message!r} with token={TOKEN}")

    job = definition(handler, max_attempts=3, cleanup=calls.cleanup)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    caplog.set_level(logging.DEBUG)

    outcomes = [runner.run(job, envelope.to_message()) for _ in range(3)]

    assert [o.outcome for o in outcomes] == [RunOutcome.RETRY, RunOutcome.RETRY, RunOutcome.FAILED]
    assert [o.countdown for o in outcomes] == [10.0, 20.0, None]
    record = store.get(envelope.job_id)
    assert record is not None
    assert record.status is JobStatus.FAILED
    assert record.attempts == 3
    assert record.last_error == "unexpected_error: RuntimeError"
    assert calls.count == 3
    assert calls.cleanups == ["failed"]
    # A further delivery of the failed job is a no-op.
    assert runner.run(job, envelope.to_message()).outcome is RunOutcome.DUPLICATE_FINISHED
    assert calls.count == 3
    assert "Traceback (most recent call last)" in caplog.text
    assert BOOK_TEXT not in caplog.text
    assert TOKEN not in caplog.text


def test_job_error_keeps_its_safe_message(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    class PageLimitError(NonRetryableJobError):
        code = "page_limit"

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        raise PageLimitError(f"document has more than 2000 pages, token={TOKEN}")

    envelope = make_envelope()
    store.create(envelope, max_attempts=3)

    runner.run(definition(handler), envelope.to_message())

    record = store.get(envelope.job_id)
    assert record is not None
    assert record.last_error == "page_limit: document has more than 2000 pages, token=[REDACTED]"


def test_non_retryable_error_fails_immediately(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        raise NonRetryableJobError("source document was deleted")

    envelope = make_envelope()
    store.create(envelope, max_attempts=5)

    result = runner.run(definition(handler, cleanup=calls.cleanup), envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    assert result.error == "non_retryable: source document was deleted"
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.FAILED, 1)
    assert calls.count == 1
    assert calls.cleanups == ["failed"]


def test_retryable_job_error_is_retried(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    class UpstreamBusyError(JobError):
        code = "upstream_busy"

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        raise UpstreamBusyError()

    envelope = make_envelope()
    store.create(envelope, max_attempts=2)

    result = runner.run(definition(handler), envelope.to_message())

    assert result.outcome is RunOutcome.RETRY
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.last_error) == (JobStatus.QUEUED, "upstream_busy")


def test_cancellation_hook_stops_work_and_runs_cleanup(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    calls = Calls()
    processed: list[int] = []

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        for unit in range(10):
            ctx.check_cancelled()
            processed.append(unit)
            if unit == 2:
                store.request_cancel(ctx.job_id)  # e.g. the user pressed "cancel"
        return {"units": len(processed)}

    envelope = make_envelope()
    store.create(envelope, max_attempts=3)

    result = runner.run(definition(handler, cleanup=calls.cleanup), envelope.to_message())

    assert result.outcome is RunOutcome.CANCELLED
    assert processed == [0, 1, 2]
    assert calls.cleanups == ["cancelled"]
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.result) == (JobStatus.CANCELLED, None)


def test_cancel_requested_while_queued_never_runs_the_handler(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        return None

    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    store.request_cancel(envelope.job_id)

    result = runner.run(definition(handler, cleanup=calls.cleanup), envelope.to_message())

    assert result.outcome is RunOutcome.CANCELLED
    assert calls.count == 0
    assert calls.cleanups == []
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.CANCELLED, 0)


@pytest.mark.parametrize(("version", "kind"), [(2, "newer than"), (7, "newer than")])
def test_newer_schema_version_fails_the_job_explicitly(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    version: int,
    kind: str,
) -> None:
    calls = Calls()

    def handler(ctx: JobContext, payload: TextPayload) -> JobResult:
        calls.count += 1
        return None

    envelope = make_envelope(schema_version=version)
    store.create(envelope, max_attempts=3)

    result = runner.run(definition(handler), envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    assert result.error == (
        f"unsupported_schema_version: schema_version {version} is {kind} the supported versions [1]"
    )
    assert calls.count == 0
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.FAILED, 1)


def test_unknown_older_schema_version_is_rejected(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    job: JobDefinition[TextPayload] = JobDefinition(
        job_type="echo", payload_models={2: TextPayload, 3: TextPayload}, handler=lambda c, p: None
    )
    envelope = make_envelope(schema_version=1)
    store.create(envelope, max_attempts=3)

    result = runner.run(job, envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    assert result.error == (
        "unsupported_schema_version: schema_version 1 is not one of the supported versions [2, 3]"
    )


def test_invalid_payload_fails_without_retry(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(payload={"message": ["not", "text", BOOK_TEXT]})
    store.create(envelope, max_attempts=3)

    result = runner.run(definition(lambda c, p: None), envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    assert result.error == "invalid_payload: message: string_type"


def test_messages_that_do_not_match_a_stored_job_are_rejected_untouched(
    store: TransactionalJobStore, runner: JobRunner, make_envelope: EnvelopeFactory
) -> None:
    job = definition(lambda c, p: None)
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    before = store.get(envelope.job_id)

    forged = envelope.model_copy(update={"workspace_id": uuid4()})
    unknown = make_envelope()
    wrong_type = make_envelope(job_type="workspace.fork", job_id=envelope.job_id)

    assert runner.run(job, forged.to_message()).error == "invalid_envelope: mismatch"
    assert runner.run(job, unknown.to_message()).error == "invalid_envelope: not_found"
    assert runner.run(job, wrong_type.to_message()).outcome is RunOutcome.REJECTED
    assert runner.run(job, {"job_id": "x"}).outcome is RunOutcome.REJECTED
    assert store.get(envelope.job_id) == before


def test_lost_worker_lease_is_reclaimed_and_the_stale_attempt_is_fenced(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    envelope = make_envelope()
    store.create(envelope, max_attempts=3)
    # Attempt 1 claims and then its worker dies (no complete/fail).
    lost = store.claim(envelope, worker_id="dead", lease_seconds=LEASE).record
    assert lost is not None
    clock.advance(LEASE + 1)

    result = runner.run(definition(lambda c, p: {"ok": True}), envelope.to_message())

    assert result.outcome is RunOutcome.SUCCEEDED
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.SUCCEEDED, 2)
    with pytest.raises(StaleClaimError):
        store.complete(envelope.job_id, attempt=lost.attempts, result=None)


def test_lost_worker_on_final_attempt_fails_the_job(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    clock: FakeClock,
) -> None:
    envelope = make_envelope()
    store.create(envelope, max_attempts=1)
    store.claim(envelope, worker_id="dead", lease_seconds=LEASE)
    clock.advance(LEASE + 1)

    result = runner.run(definition(lambda c, p: None, max_attempts=1), envelope.to_message())

    assert result.outcome is RunOutcome.FAILED
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.last_error) == (JobStatus.FAILED, WORKER_LOST_ERROR)


def test_create_is_idempotent_on_the_idempotency_key(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory, tenancy: Tenancy
) -> None:
    first = make_envelope(idempotency_key="fork-1")
    again = make_envelope(idempotency_key="fork-1")
    other_workspace = make_envelope(idempotency_key="fork-1", workspace_id=tenancy.new_workspace())
    other_user = make_envelope(idempotency_key="fork-1", created_by=tenancy.new_user())
    other_type = make_envelope("workspace.fork", idempotency_key="fork-1")

    assert store.create(again, max_attempts=3) == store.create(again, max_attempts=3)
    assert store.create(first, max_attempts=3).job_id == again.job_id
    # The scope is (workspace_id, created_by, job_type, key), as async_jobs_idempotency_idx.
    for independent in (other_workspace, other_user, other_type):
        assert store.create(independent, max_attempts=3).job_id == independent.job_id


def test_jobs_without_a_creator_or_key_are_deduplicated_by_job_id_only(
    store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    system = make_envelope(idempotency_key="reindex-1", created_by=None)
    system_again = make_envelope(idempotency_key="reindex-1", created_by=None)
    keyless = make_envelope().model_copy(update={"idempotency_key": None})
    keyless_again = keyless.model_copy(update={"job_id": uuid4()})

    for envelope in (system, system_again, keyless, keyless_again):
        record = store.create(envelope, max_attempts=3)
        assert record.job_id == envelope.job_id
        assert record.matches(envelope)
    # A repeated job id still returns the stored row.
    assert store.create(system, max_attempts=3) == store.get(system.job_id)
    with pytest.raises(ValueError, match="job_id already used"):
        store.create(
            system.model_copy(update={"created_by": None, "job_type": "other"}), max_attempts=3
        )


def test_creator_is_part_of_the_job_identity(
    store: TransactionalJobStore,
    runner: JobRunner,
    make_envelope: EnvelopeFactory,
    tenancy: Tenancy,
) -> None:
    envelope = make_envelope()
    record = store.create(envelope, max_attempts=3)
    assert (record.created_by, record.to_envelope()) == (tenancy.user_id, envelope)

    forged = envelope.model_copy(update={"created_by": tenancy.new_user()})
    result = runner.run(definition(lambda c, p: None), forged.to_message())

    assert result.error == "invalid_envelope: mismatch"
    assert store.get(envelope.job_id) == record

    seen: list[object] = []
    runner.run(definition(lambda c, p: seen.append(c.created_by)), envelope.to_message())
    assert seen == [tenancy.user_id]
