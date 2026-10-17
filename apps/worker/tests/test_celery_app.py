"""Celery wiring in eager mode: config, submit, retries and duplicate delivery."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel, SecretStr
from quiz_worker.celery_app import (
    IdempotentJobTask,
    QuizCelery,
    build_celery_config,
    build_job_store,
    create_celery_app,
    register_job,
    submit_job,
    task_name,
)
from quiz_worker.errors import JobOutcomeError, JobRetryError, NonRetryableJobError
from quiz_worker.jobs import ECHO_JOB
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, RunOutcome, RunResult
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import BOOK_TEXT, TOKEN, EnvelopeFactory

REDIS_URL = "redis://:s3cret-pass@redis.internal:6379/0"


class FlakyPayload(BaseModel):
    fail_times: int


def flaky_job(max_attempts: int) -> tuple[JobDefinition[FlakyPayload], list[int]]:
    attempts: list[int] = []

    def handler(ctx: JobContext, payload: FlakyPayload) -> JobResult:
        attempts.append(ctx.attempt)
        if ctx.attempt <= payload.fail_times:
            raise RuntimeError(f"transient failure near {BOOK_TEXT}")
        return {"attempt": ctx.attempt}

    definition: JobDefinition[FlakyPayload] = JobDefinition(
        job_type="test.flaky",
        payload_models={1: FlakyPayload},
        handler=handler,
        retry_policy=RetryPolicy(
            max_attempts=max_attempts, base_delay_seconds=0, max_delay_seconds=0
        ),
    )
    return definition, attempts


@pytest.fixture
def store() -> InMemoryJobStore:
    return InMemoryJobStore()


@pytest.fixture
def app(eager_settings: WorkerSettings, store: InMemoryJobStore) -> QuizCelery:
    return create_celery_app(eager_settings, job_store=store)


def test_config_is_json_only_late_ack_and_single_prefetch() -> None:
    settings = WorkerSettings.model_construct(redis_url=SecretStr(REDIS_URL))

    conf = build_celery_config(settings)

    assert conf["broker_url"] == REDIS_URL
    assert conf["result_backend"] == REDIS_URL
    assert conf["task_serializer"] == conf["result_serializer"] == "json"
    assert conf["accept_content"] == conf["result_accept_content"] == ["json"]
    assert conf["task_acks_late"] is True
    assert conf["task_reject_on_worker_lost"] is True
    # Hard-time-limit kills re-queue the message instead of acking it away.
    assert conf["task_acks_on_failure_or_timeout"] is False
    assert conf["beat_schedule"]["reconcile-jobs"]["task"] == "quiz.maintenance.reconcile_jobs"
    assert conf["worker_prefetch_multiplier"] == 1
    assert conf["worker_concurrency"] == 1
    assert conf["task_soft_time_limit"] < conf["task_time_limit"]
    assert conf["result_extended"] is False
    assert conf["task_always_eager"] is False
    # Unacked messages are only re-delivered after any live lease has run out.
    assert conf["broker_transport_options"]["visibility_timeout"] > settings.lease_seconds
    assert settings.lease_seconds > conf["task_time_limit"]


def test_app_applies_the_config_and_registers_job_tasks(app: QuizCelery) -> None:
    assert app.conf.task_serializer == "json"
    assert app.conf.accept_content == ["json"]
    assert app.conf.task_acks_late is True
    task = app.tasks[task_name("echo")]
    assert isinstance(task, IdempotentJobTask)
    assert task.job_definition is ECHO_JOB
    assert task.max_retries is None


def test_redis_url_is_required_and_kept_secret() -> None:
    with pytest.raises(ValueError, match="REDIS_URL is required"):
        build_celery_config(WorkerSettings.model_construct())

    settings = WorkerSettings.model_construct(redis_url=SecretStr(REDIS_URL))
    assert "s3cret-pass" not in repr(settings)


def test_deployed_environments_refuse_the_in_memory_store() -> None:
    assert isinstance(build_job_store(WorkerSettings.model_construct()), InMemoryJobStore)
    for env in (Environment.PREVIEW, Environment.PRODUCTION):
        with pytest.raises(RuntimeError, match="no persistent JobStore"):
            build_job_store(WorkerSettings.model_construct(app_env=env))


def test_echo_job_runs_eagerly_and_duplicate_delivery_is_a_noop(
    app: QuizCelery, store: InMemoryJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(payload={"message": "hello"})

    record = submit_job(app, envelope)

    assert record.status is JobStatus.SUCCEEDED
    assert record.result == {"length": 5}
    task = app.tasks[task_name("echo")]
    redelivered = task.apply(args=(envelope.to_message(),), task_id=str(envelope.job_id))
    assert redelivered.get() == {"job_id": str(envelope.job_id), "outcome": "duplicate_finished"}
    assert store.get(envelope.job_id) == record


def test_repeated_idempotency_key_returns_the_existing_job(
    app: QuizCelery, make_envelope: EnvelopeFactory
) -> None:
    first = submit_job(app, make_envelope(idempotency_key="upload-1", payload={"message": "a"}))
    second = submit_job(app, make_envelope(idempotency_key="upload-1", payload={"message": "bb"}))

    assert second.job_id == first.job_id
    assert second.result == {"length": 1}


def test_transient_failures_are_retried_through_celery(
    eager_settings: WorkerSettings, store: InMemoryJobStore, make_envelope: EnvelopeFactory
) -> None:
    definition, attempts = flaky_job(max_attempts=3)
    app = create_celery_app(eager_settings, job_store=store, definitions=[definition])

    record = submit_job(app, make_envelope("test.flaky", {"fail_times": 2}))

    assert attempts == [1, 2, 3]
    assert record.status is JobStatus.SUCCEEDED
    assert record.attempts == 3
    assert record.last_error == "unexpected_error: RuntimeError"


def test_exhausted_retries_fail_with_a_sanitized_celery_error(
    eager_settings: WorkerSettings, store: InMemoryJobStore, make_envelope: EnvelopeFactory
) -> None:
    definition, attempts = flaky_job(max_attempts=2)
    app = create_celery_app(eager_settings, job_store=store, definitions=[definition])
    envelope = make_envelope("test.flaky", {"fail_times": 5})
    store.create(envelope, max_attempts=2)

    result = app.tasks[task_name("test.flaky")].apply(args=(envelope.to_message(),))

    assert attempts == [1, 2]
    assert result.state == "FAILURE"
    error = result.result
    assert isinstance(error, JobOutcomeError)
    assert str(error) == f"job {envelope.job_id} unexpected_error: RuntimeError"
    assert error.__cause__ is None
    assert error.__suppress_context__ is True
    assert BOOK_TEXT not in str(result.traceback or "")
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.FAILED, 2)


def test_non_retryable_error_fails_after_one_attempt(
    eager_settings: WorkerSettings, store: InMemoryJobStore, make_envelope: EnvelopeFactory
) -> None:
    calls: list[int] = []

    def handler(ctx: JobContext, payload: FlakyPayload) -> JobResult:
        calls.append(ctx.attempt)
        raise NonRetryableJobError("unsupported file type")

    definition: JobDefinition[FlakyPayload] = JobDefinition(
        job_type="test.permanent", payload_models={1: FlakyPayload}, handler=handler
    )
    app = create_celery_app(eager_settings, job_store=store, definitions=[definition])
    envelope = make_envelope("test.permanent", {"fail_times": 0})

    record = submit_job(app, envelope)

    assert calls == [1]
    assert (record.status, record.attempts) == (JobStatus.FAILED, 1)
    assert record.last_error == "non_retryable: unsupported file type"


def test_unknown_schema_version_is_rejected_through_celery(
    app: QuizCelery, store: InMemoryJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(schema_version=2, payload={"message": TOKEN})
    store.create(envelope, max_attempts=3)

    result = app.tasks[task_name("echo")].apply(args=(envelope.to_message(),))

    assert result.state == "FAILURE"
    assert "unsupported_schema_version" in str(result.result)
    assert TOKEN not in str(result.result)
    record = store.get(envelope.job_id)
    assert record is not None
    assert (record.status, record.attempts) == (JobStatus.FAILED, 1)


def test_malformed_message_is_rejected(app: QuizCelery) -> None:
    task = app.tasks[task_name("echo")]

    result = task.apply(args=({"job_id": f"Bearer {TOKEN}"},))

    assert result.state == "FAILURE"
    assert isinstance(result.result, JobOutcomeError)
    assert "invalid_envelope" in str(result.result)
    assert TOKEN not in str(result.result)


def test_duplicate_while_running_is_deferred_past_the_lease(app: QuizCelery) -> None:
    task = app.tasks[task_name("echo")]
    assert isinstance(task, IdempotentJobTask)
    retried: dict[str, Any] = {}

    def fake_retry(*, countdown: float, exc: Exception) -> Exception:
        retried.update(countdown=countdown, exc=exc)
        return exc

    task.retry = fake_retry  # type: ignore[assignment,method-assign]
    result = RunResult(RunOutcome.DUPLICATE_RUNNING, countdown=42.0)

    with pytest.raises(JobRetryError):
        task._to_celery(result)
    assert retried["countdown"] == 42.0


def test_job_types_cannot_be_registered_twice(app: QuizCelery) -> None:
    with pytest.raises(ValueError, match="already registered"):
        register_job(app, ECHO_JOB)
