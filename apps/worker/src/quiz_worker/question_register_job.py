"""`question.import_register` v1: approve and register a submitted selection of import drafts on
the server (QIMP-JOB, QIMPORT-01-AC07, docs/questions.md §6).

Payload (written by apps/api `POST /question-imports/{id}/registrations`): `{import_id}`. The
selection itself is not in the payload (no question text in broker messages): the API recorded it
as `question_import_registration_items` rows of this job (draft, selected version, chapter), with
the drafts it already refused or found registered marked as such.

The handler, serialised per job by an advisory lock, calls the SECURITY DEFINER
`public.worker_register_import_drafts(job, batch)` until no item is pending (supabase/migrations/
20261023120000_question_import_registration.sql). Each call is one transaction that re-checks the
workspace (rows locked FOR SHARE), approves and registers the next batch in position order and
moves those items to `registered` / `skipped` / `refused`. The items are the job's durable
progress: a retried or re-delivered job continues with the pending ones, so a draft is never
registered twice (the function also skips drafts already linked to a question). quiz_worker has
no privilege of its own on drafts or questions.

Failure: an archived/deleted workspace or a user who lost the editor role is
`workspace_unavailable` (not retried; the remaining items stay pending and unregistered). Database
errors are retried by the runner's policy; each retry resumes. There is nothing to clean up.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, ConfigDict
from sqlalchemy import Engine, text

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.errors import NonRetryableJobError
from quiz_worker.retry import RetryPolicy
from quiz_worker.run_lock import advisory_run_lock
from quiz_worker.runner import JobContext, JobDefinition, JobResult
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

JOB_TYPE = "question.import_register"
# Drafts per transaction: short row locks, steady progress (750 drafts = 8 batches).
DEFAULT_BATCH_SIZE = 100


class RegistrationNotFoundError(NonRetryableJobError):
    code = "registration_not_found"


class RegistrationNotRunningError(NonRetryableJobError):
    """The job row is not `running` (its claim was lost); the runner's state wins."""

    code = "registration_superseded"


class QuestionRegisterPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    import_id: uuid.UUID


@dataclass(frozen=True)
class BatchOutcome:
    outcome: str
    registered: int
    skipped: int
    refused: int
    remaining: int


@dataclass(frozen=True)
class RegistrationCounts:
    total: int
    pending: int
    registered: int
    skipped: int
    refused: int


class RegisterStore(Protocol):
    def job_lock(
        self, job_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]: ...

    def register_batch(self, job_id: uuid.UUID, limit: int) -> BatchOutcome:
        """`worker_register_import_drafts`: one transaction."""
        ...

    def counts(self, job_id: uuid.UUID) -> RegistrationCounts: ...

    def report_progress(
        self, job_id: uuid.UUID, attempt: int, stage: str, percent: int
    ) -> None: ...


class PostgresRegisterStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def job_lock(
        self, job_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]:
        return advisory_run_lock(
            self._engine,
            f"quiz.question_import_register:{job_id}",
            wait_seconds=wait_seconds,
            check=check,
            busy_message="another worker is processing this registration",
        )

    def register_batch(self, job_id: uuid.UUID, limit: int) -> BatchOutcome:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "select outcome, registered, skipped, refused, remaining "
                        "from public.worker_register_import_drafts(:j, :n)"
                    ),
                    {"j": job_id, "n": limit},
                )
                .mappings()
                .one()
            )
        return BatchOutcome(
            outcome=str(row["outcome"]),
            registered=int(row["registered"]),
            skipped=int(row["skipped"]),
            refused=int(row["refused"]),
            remaining=int(row["remaining"]),
        )

    def counts(self, job_id: uuid.UUID) -> RegistrationCounts:
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    "select state, count(*) from public.question_import_registration_items "
                    "where job_id = :j group by state"
                ),
                {"j": job_id},
            ).all()
        found: dict[str, int] = {str(state): int(n) for state, n in rows}
        return RegistrationCounts(
            total=sum(found.values()),
            pending=found.get("pending", 0),
            registered=found.get("registered", 0),
            skipped=found.get("skipped", 0),
            refused=found.get("refused", 0),
        )

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.async_jobs "
                    "set result = jsonb_build_object('progress', jsonb_build_object("
                    "      'stage', cast(:s as text), 'percent', cast(:p as int))) "
                    "where id = :j and status = 'running' and attempts = :a"
                ),
                {"j": job_id, "a": attempt, "s": stage, "p": percent},
            )


@dataclass
class RegisterJobDeps:
    store: RegisterStore
    batch_size: int = DEFAULT_BATCH_SIZE
    lock_wait_seconds: float = 60


def _percent(counts: RegistrationCounts) -> int:
    if counts.total == 0:
        return 99
    return min(99, (counts.total - counts.pending) * 100 // counts.total)


def run_registration(
    deps: RegisterJobDeps, ctx: JobContext, payload: QuestionRegisterPayloadV1
) -> JobResult:
    with deps.store.job_lock(
        ctx.job_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
    ):
        while True:
            ctx.check_cancelled()
            batch = deps.store.register_batch(ctx.job_id, deps.batch_size)
            if batch.outcome == "workspace_unavailable":
                raise WorkspaceUnavailableError("the workspace is no longer writable")
            if batch.outcome == "not_found":
                raise RegistrationNotFoundError("registration job or import run not found")
            if batch.outcome == "not_running":
                raise RegistrationNotRunningError("the registration job is not running")
            counts = deps.store.counts(ctx.job_id)
            try:
                deps.store.report_progress(ctx.job_id, ctx.attempt, "registering", _percent(counts))
            except Exception as exc:  # best effort
                logger.warning("progress update failed: %s", type(exc).__name__)
            processed = batch.registered + batch.skipped + batch.refused
            if batch.remaining == 0 or processed == 0:
                break
    # Counts only (never text).
    return {
        "import_id": str(payload.import_id),
        "total": counts.total,
        "registered": counts.registered,
        "skipped": counts.skipped,
        "refused": counts.refused,
        "pending": counts.pending,
    }


DepsProvider = Callable[[], RegisterJobDeps]


def question_register_definition(
    provider: DepsProvider,
) -> JobDefinition[QuestionRegisterPayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: QuestionRegisterPayloadV1},
        handler=lambda ctx, payload: run_registration(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts; every attempt resumes.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=5, max_delay_seconds=120),
    )


def deps_from_settings(settings: WorkerSettings) -> RegisterJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return RegisterJobDeps(
        store=PostgresRegisterStore(engine),
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


class LazyRegisterDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: RegisterJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> RegisterJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
