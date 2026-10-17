"""Framework-free job execution: claim -> run -> complete / retry / fail / cancel.

`JobRunner.run` turns one delivered message into one `RunResult`; the Celery adapter
(`quiz_worker.celery_app`) only maps that result onto Celery's retry/failure mechanics. Keeping
the state machine here makes the idempotency rules testable without a broker.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, JsonValue, ValidationError

from quiz_worker.envelope import JobEnvelope, describe_validation_error, parse_envelope
from quiz_worker.errors import (
    InvalidEnvelopeError,
    InvalidPayloadError,
    JobCancelledError,
    JobError,
    UnsupportedSchemaVersionError,
    is_retryable,
    safe_traceback,
    sanitize_error,
)
from quiz_worker.logging_config import job_id_var
from quiz_worker.retry import RetryPolicy
from quiz_worker.store import ClaimOutcome, JobRecord, JobStore, StaleClaimError, utc_now

logger = logging.getLogger(__name__)

JobResult = Mapping[str, JsonValue] | None
TerminalReason = Literal["failed", "cancelled"]


@dataclass(frozen=True)
class JobContext:
    """What a handler may know about its job. Never carries the raw payload."""

    job_id: UUID
    job_type: str
    workspace_id: UUID
    idempotency_key: str
    schema_version: int
    attempt: int
    max_attempts: int
    _store: JobStore = field(repr=False, compare=False)

    @property
    def is_final_attempt(self) -> bool:
        return self.attempt >= self.max_attempts

    def cancel_requested(self) -> bool:
        return self._store.is_cancel_requested(self.job_id)

    def check_cancelled(self) -> None:
        """Call between units of work (and right before committing); raises if cancelled."""
        if self.cancel_requested():
            raise JobCancelledError()


Cleanup = Callable[[JobContext, TerminalReason], None]


@dataclass(frozen=True)
class JobDefinition[P: BaseModel]:
    """One job type: its payload model per schema version, handler and retry policy.

    `cleanup` runs when the job ends `failed` or `cancelled` after any attempt may have
    started work (e.g. S3a removes temporary Storage copies), including terminal transitions
    that happen without a running handler: cancel during a retry countdown, a lost worker's
    final attempt, and the reconciler's recovery. It must be idempotent and tolerate finding
    nothing to clean. It does not run between retries: handlers must be idempotent so a retry
    can resume or redo partial work.
    """

    job_type: str
    payload_models: Mapping[int, type[P]]
    handler: Callable[[JobContext, P], JobResult]
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    cleanup: Cleanup | None = None

    def __post_init__(self) -> None:
        if not self.payload_models or min(self.payload_models) < 1:
            raise ValueError("payload_models needs schema versions >= 1")

    @property
    def latest_schema_version(self) -> int:
        return max(self.payload_models)

    def parse_payload(self, envelope: JobEnvelope) -> P:
        model = self.payload_models.get(envelope.schema_version)
        if model is None:
            newest = self.latest_schema_version
            kind = "newer than" if envelope.schema_version > newest else "not one of"
            raise UnsupportedSchemaVersionError(
                f"schema_version {envelope.schema_version} is {kind} the supported "
                f"versions {sorted(self.payload_models)}"
            )
        try:
            return model.model_validate(envelope.payload)
        except ValidationError as exc:
            raise InvalidPayloadError(describe_validation_error(exc)) from None


class RunOutcome(StrEnum):
    SUCCEEDED = "succeeded"
    # Duplicate delivery of a finished job: nothing ran.
    DUPLICATE_FINISHED = "duplicate_finished"
    # Another attempt holds the lease: nothing ran; re-check after `countdown`.
    DUPLICATE_RUNNING = "duplicate_running"
    CANCELLED = "cancelled"
    RETRY = "retry"
    FAILED = "failed"
    # Message refused without touching the job row (bad envelope, unknown/mismatched job).
    REJECTED = "rejected"
    # This attempt lost ownership mid-run; its writes were discarded.
    STALE = "stale"


@dataclass(frozen=True)
class RunResult:
    outcome: RunOutcome
    job_id: UUID | None = None
    error: str | None = None
    countdown: float | None = None
    record: JobRecord | None = field(default=None, repr=False)

    def summary(self) -> dict[str, Any]:
        """Small, non-sensitive dict: Celery logs and stores the task return value."""
        return {
            "job_id": str(self.job_id) if self.job_id else None,
            "outcome": self.outcome.value,
        }


class JobRunner:
    def __init__(
        self,
        store: JobStore,
        *,
        worker_id: str,
        lease_seconds: int,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._store = store
        self._worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._clock = clock

    def run(self, definition: JobDefinition[Any], raw_envelope: object) -> RunResult:
        try:
            envelope = parse_envelope(raw_envelope)
        except InvalidEnvelopeError as exc:
            error = sanitize_error(exc)
            logger.error("job message rejected: %s", error)
            return RunResult(RunOutcome.REJECTED, error=error)

        token = job_id_var.set(str(envelope.job_id))
        try:
            return self._run(definition, envelope)
        finally:
            job_id_var.reset(token)

    def _run(self, definition: JobDefinition[Any], envelope: JobEnvelope) -> RunResult:
        job_id = envelope.job_id
        if envelope.job_type != definition.job_type:
            error = f"invalid_envelope: job_type does not match task {definition.job_type}"
            logger.error("job message rejected: %s", error)
            return RunResult(RunOutcome.REJECTED, job_id, error=error)

        claim = self._store.claim(
            envelope, worker_id=self._worker_id, lease_seconds=self._lease_seconds
        )
        match claim.outcome:
            case ClaimOutcome.NOT_FOUND | ClaimOutcome.MISMATCH:
                error = f"invalid_envelope: {claim.outcome.value}"
                logger.error("job message rejected: %s", error)
                return RunResult(RunOutcome.REJECTED, job_id, error=error, record=claim.record)
            case ClaimOutcome.ALREADY_FINISHED:
                logger.info("duplicate delivery of a finished job ignored")
                return RunResult(RunOutcome.DUPLICATE_FINISHED, job_id, record=claim.record)
            case ClaimOutcome.IN_PROGRESS:
                return RunResult(
                    RunOutcome.DUPLICATE_RUNNING,
                    job_id,
                    countdown=self._lease_remaining(claim.record),
                    record=claim.record,
                )
            case ClaimOutcome.CANCELLED:
                assert claim.record is not None  # noqa: S101 - cancelled returns the row
                logger.info("job cancelled before this delivery started")
                run_cleanup(definition, context_for(claim.record, self._store), "cancelled")
                return RunResult(RunOutcome.CANCELLED, job_id, record=claim.record)
            case ClaimOutcome.EXHAUSTED:
                assert claim.record is not None  # noqa: S101 - exhausted returns the row
                logger.error("job failed: %s", claim.record.last_error)
                run_cleanup(definition, context_for(claim.record, self._store), "failed")
                return RunResult(
                    RunOutcome.FAILED, job_id, error=claim.record.last_error, record=claim.record
                )
            case ClaimOutcome.CLAIMED:
                pass

        record = claim.record
        assert record is not None  # noqa: S101 - claimed returns the row
        ctx = context_for(record, self._store)
        logger.info("job attempt %d/%d started", ctx.attempt, ctx.max_attempts)
        # Earlier attempts (retried or lost) may have left partial work behind.
        started = ctx.attempt > 1
        try:
            payload = definition.parse_payload(envelope)
            ctx.check_cancelled()
            started = True
            result = definition.handler(ctx, payload)
        except Exception as exc:
            return self._handle_error(definition, ctx, exc, started=started)

        try:
            done = self._store.complete(job_id, attempt=ctx.attempt, result=result)
        except StaleClaimError:
            return self._stale(job_id)
        logger.info("job succeeded on attempt %d", ctx.attempt)
        return RunResult(RunOutcome.SUCCEEDED, job_id, record=done)

    def _handle_error(
        self, definition: JobDefinition[Any], ctx: JobContext, exc: Exception, *, started: bool
    ) -> RunResult:
        error = sanitize_error(exc)
        try:
            if isinstance(exc, JobCancelledError):
                self._cleanup(definition, ctx, "cancelled", started=started)
                record = self._store.cancel(ctx.job_id, attempt=ctx.attempt)
                logger.info("job cancelled on attempt %d", ctx.attempt)
                return RunResult(RunOutcome.CANCELLED, ctx.job_id, record=record)

            if is_retryable(exc) and definition.retry_policy.should_retry(
                ctx.attempt, ctx.max_attempts
            ):
                record = self._store.release_for_retry(ctx.job_id, attempt=ctx.attempt, error=error)
                countdown = definition.retry_policy.countdown(ctx.attempt)
                logger.warning(
                    "job attempt %d/%d failed, retrying in %.0fs: %s",
                    ctx.attempt,
                    ctx.max_attempts,
                    countdown,
                    error,
                )
                self._log_traceback(exc)
                return RunResult(
                    RunOutcome.RETRY, ctx.job_id, error=error, countdown=countdown, record=record
                )

            self._cleanup(definition, ctx, "failed", started=started)
            record = self._store.fail(ctx.job_id, attempt=ctx.attempt, error=error)
            logger.error("job failed on attempt %d/%d: %s", ctx.attempt, ctx.max_attempts, error)
            self._log_traceback(exc)
            return RunResult(RunOutcome.FAILED, ctx.job_id, error=error, record=record)
        except StaleClaimError:
            return self._stale(ctx.job_id)

    @staticmethod
    def _cleanup(
        definition: JobDefinition[Any],
        ctx: JobContext,
        reason: TerminalReason,
        *,
        started: bool,
    ) -> None:
        if started:
            run_cleanup(definition, ctx, reason)

    def _lease_remaining(self, record: JobRecord | None) -> float:
        if record is None or record.lease_expires_at is None:
            return float(self._lease_seconds)
        remaining = (record.lease_expires_at - self._clock()).total_seconds()
        return max(1.0, remaining + 1.0)

    @staticmethod
    def _log_traceback(exc: Exception) -> None:
        if not isinstance(exc, JobError):
            logger.warning("%s", safe_traceback(exc))

    @staticmethod
    def _stale(job_id: UUID) -> RunResult:
        logger.warning("job attempt lost ownership; result discarded")
        return RunResult(RunOutcome.STALE, job_id)


def context_for(record: JobRecord, store: JobStore) -> JobContext:
    return JobContext(
        job_id=record.job_id,
        job_type=record.job_type,
        workspace_id=record.workspace_id,
        idempotency_key=record.idempotency_key,
        schema_version=record.schema_version,
        attempt=record.attempts,
        max_attempts=record.max_attempts,
        _store=store,
    )


def run_cleanup(definition: JobDefinition[Any], ctx: JobContext, reason: TerminalReason) -> None:
    """Run the job's cleanup if any attempt was ever claimed (`ctx.attempt > 0`)."""
    if definition.cleanup is None or ctx.attempt < 1:
        return
    try:
        definition.cleanup(ctx, reason)
    except Exception as exc:
        logger.error("job cleanup failed: %s", sanitize_error(exc))
