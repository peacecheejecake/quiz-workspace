"""Celery app factory and the idempotent job task base.

Delivery is at-least-once (docs/deployment.md §7): `task_acks_late` +
`task_reject_on_worker_lost` re-deliver a message whose worker died, and the `JobStore` claim
makes every re-delivery safe (finished -> no-op, live lease -> deferred, expired lease -> new
attempt). Only JSON is accepted on the wire.

Nothing sensitive reaches Celery's own logs, events or result backend: the message argument
is hidden behind `argsrepr`, task return values are `RunResult.summary()`, and failures are
re-raised as `JobOutcomeError` carrying only the sanitized error.
"""

from __future__ import annotations

import contextlib
import socket
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from uuid import UUID

from celery import Celery, Task, signals

from quiz_worker.envelope import JobEnvelope
from quiz_worker.errors import JobOutcomeError, JobRetryError
from quiz_worker.jobs import ECHO_JOB
from quiz_worker.logging_config import configure_logging
from quiz_worker.runner import JobDefinition, JobRunner, RunOutcome, RunResult
from quiz_worker.settings import Environment, WorkerSettings, get_settings
from quiz_worker.store import InMemoryJobStore, JobRecord, JobStore

TASK_NAME_PREFIX = "quiz.jobs."
DEFAULT_QUEUE = "quiz.jobs"


class QuizCelery(Celery):
    """Celery app that also owns the job store and worker settings its tasks use."""

    def __init__(self, *, worker_settings: WorkerSettings, job_store: JobStore) -> None:
        super().__init__("quiz_worker")
        self.worker_settings = worker_settings
        self.job_store = job_store
        self.job_definitions: dict[str, JobDefinition[Any]] = {}

    def __reduce__(self) -> tuple[Any, ...]:
        # Prefork children started with spawn (macOS) unpickle the app; Celery's default
        # reduce would call __init__ with Celery's own kwargs. Rebuild from the environment
        # instead, like a freshly started worker process.
        return (app_from_environment, ())


if TYPE_CHECKING:
    # celery-types makes Task generic; the runtime class is not subscriptable.
    _TaskBase = Task[[dict[str, Any]], dict[str, Any]]
else:
    _TaskBase = Task


class IdempotentJobTask(_TaskBase):
    """Base for every job task; `register_job` sets `job_definition` per task class."""

    job_definition: JobDefinition[Any]
    # Attempts are bounded by `async_jobs.max_attempts`, not Celery's retry counter (whose
    # MaxRetriesExceededError message would include the task arguments).
    max_retries = None
    acks_late = True
    reject_on_worker_lost = True
    typing = True

    def apply_async(  # type: ignore[override]
        self, args: Any = None, kwargs: Any = None, **options: Any
    ) -> Any:
        # Every publish, including Celery's own retries (which do not carry argsrepr over),
        # replaces the logged/evented argument repr so the envelope never shows up there.
        options["argsrepr"] = safe_argsrepr(args)
        options["kwargsrepr"] = "{}"
        return super().apply_async(args, kwargs, **options)

    def execute_job(self, raw_envelope: object) -> dict[str, Any]:
        app = self.app
        if not isinstance(app, QuizCelery):
            raise TypeError("job tasks must be registered on a QuizCelery app")
        runner = JobRunner(
            app.job_store,
            worker_id=self._worker_id(),
            lease_seconds=app.worker_settings.lease_seconds,
        )
        result = runner.run(self.job_definition, raw_envelope)
        return self._to_celery(result)

    def _to_celery(self, result: RunResult) -> dict[str, Any]:
        job_id = str(result.job_id) if result.job_id else None
        match result.outcome:
            case RunOutcome.RETRY:
                raise self.retry(
                    countdown=result.countdown, exc=JobRetryError(job_id, result.error or "")
                )
            case RunOutcome.DUPLICATE_RUNNING if not self.request.is_eager:
                # Re-check once the live lease has run out: either the other attempt finished
                # (then this is a no-op) or its worker died (then this re-claims the job).
                raise self.retry(
                    countdown=result.countdown,
                    exc=JobRetryError(job_id, "duplicate delivery while running"),
                )
            case RunOutcome.FAILED | RunOutcome.REJECTED:
                raise JobOutcomeError(job_id, result.error or result.outcome.value) from None
            case _:
                return result.summary()

    def _worker_id(self) -> str:
        hostname = self.request.hostname
        return hostname or f"eager@{socket.gethostname()}"


def install_logging_hooks(settings: WorkerSettings) -> None:
    """Keep the redacting root handler in this process and stop Celery from replacing it.

    Connecting any `setup_logging` receiver disables Celery's own logging configuration.
    """
    configure_logging(settings.log_level)
    signals.setup_logging.connect(_on_setup_logging, weak=False)


def _on_setup_logging(**_: Any) -> None:
    configure_logging(get_settings().log_level)


def app_from_environment() -> QuizCelery:
    """The worker app as configured by the environment (worker processes and children)."""
    settings = get_settings()
    install_logging_hooks(settings)
    return create_celery_app(settings)


def create_celery_app(
    settings: WorkerSettings,
    *,
    job_store: JobStore | None = None,
    definitions: list[JobDefinition[Any]] | None = None,
) -> QuizCelery:
    store = job_store if job_store is not None else build_job_store(settings)
    app = QuizCelery(worker_settings=settings, job_store=store)
    app.conf.update(build_celery_config(settings))
    for definition in definitions if definitions is not None else default_definitions():
        register_job(app, definition)
    return app


def build_celery_config(settings: WorkerSettings) -> dict[str, Any]:
    if settings.task_always_eager:
        broker_url: str | None = "memory://"
        result_backend: str | None = None
    elif settings.redis_url is None:
        raise ValueError("REDIS_URL is required unless WORKER_TASK_ALWAYS_EAGER is set")
    else:
        broker_url = result_backend = settings.redis_url.get_secret_value()

    visibility = {"visibility_timeout": settings.broker_visibility_timeout_seconds}
    return {
        "broker_url": broker_url,
        "result_backend": result_backend,
        "broker_connection_retry_on_startup": True,
        "broker_transport_options": visibility,
        "result_backend_transport_options": visibility,
        # JSON only: never unpickle broker input.
        "task_serializer": "json",
        "result_serializer": "json",
        "accept_content": ["json"],
        "result_accept_content": ["json"],
        # At-least-once delivery; JobStore claims make re-delivery idempotent.
        "task_acks_late": True,
        "task_reject_on_worker_lost": True,
        "task_acks_on_failure_or_timeout": True,
        "worker_prefetch_multiplier": 1,
        "worker_concurrency": settings.concurrency,
        "worker_cancel_long_running_tasks_on_connection_loss": True,
        "task_soft_time_limit": settings.task_soft_time_limit_seconds,
        "task_time_limit": settings.task_time_limit_seconds,
        "task_default_queue": DEFAULT_QUEUE,
        # No task arguments in the result backend or task events.
        "result_extended": False,
        "result_expires": 24 * 3600,
        "worker_send_task_events": False,
        "task_send_sent_event": False,
        # Logging is configured by quiz_worker.serve (redacting root handler).
        "worker_hijack_root_logger": False,
        "task_always_eager": settings.task_always_eager,
        # Must stay False: with propagation Celery re-raises `Retry` instead of re-applying
        # the task, so eager retries would never run. Failures land in the job row / result.
        "task_eager_propagates": False,
        "timezone": "UTC",
        "enable_utc": True,
    }


def build_job_store(settings: WorkerSettings) -> JobStore:
    if settings.app_env in {Environment.LOCAL, Environment.TEST}:
        return InMemoryJobStore()
    # The Postgres JobStore on `async_jobs` lands once P0.9's migration exists.
    raise RuntimeError(f"no persistent JobStore configured for APP_ENV={settings.app_env}")


def safe_argsrepr(args: Any) -> str:
    """`(<job <uuid>>,)` for a job message; never any payload content."""
    job_id = "?"
    if isinstance(args, list | tuple) and args and isinstance(args[0], Mapping):
        candidate = args[0].get("job_id")
        if isinstance(candidate, str | UUID):
            with contextlib.suppress(ValueError):
                job_id = str(UUID(str(candidate)))
    return f"(<job {job_id}>,)"


def task_name(job_type: str) -> str:
    return f"{TASK_NAME_PREFIX}{job_type}"


def register_job(app: QuizCelery, definition: JobDefinition[Any]) -> IdempotentJobTask:
    if definition.job_type in app.job_definitions:
        raise ValueError(f"job type already registered: {definition.job_type}")

    def run(self: IdempotentJobTask, envelope: dict[str, Any]) -> dict[str, Any]:
        return self.execute_job(envelope)

    task = app.task(
        bind=True,
        base=IdempotentJobTask,
        name=task_name(definition.job_type),
        job_definition=definition,
        shared=False,
    )(run)
    app.job_definitions[definition.job_type] = definition
    assert isinstance(task, IdempotentJobTask)  # noqa: S101 - base= guarantees the class
    return task


def submit_job(app: QuizCelery, envelope: JobEnvelope) -> JobRecord:
    """Create the job row (idempotent) and publish its message.

    Models the API-side contract used by later Tasks: insert `async_jobs` first, then send
    the envelope with `task_id = job_id`. A repeated idempotency key returns the existing row
    and publishes nothing.
    """
    definition = app.job_definitions.get(envelope.job_type)
    if definition is None:
        raise ValueError(f"unknown job type: {envelope.job_type}")
    existing = app.job_store.get(envelope.job_id)
    if existing is not None:
        return existing
    record = app.job_store.create(envelope, max_attempts=definition.retry_policy.max_attempts)
    if record.job_id != envelope.job_id:
        return record
    # apply_async (not send_task) so eager mode runs the job in-process.
    app.tasks[task_name(envelope.job_type)].apply_async(
        args=(envelope.to_message(),),
        task_id=str(envelope.job_id),
    )
    return app.job_store.get(envelope.job_id) or record


def default_definitions() -> list[JobDefinition[Any]]:
    return [ECHO_JOB]
