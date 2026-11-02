"""Job reconciler: recovers jobs whose message is gone.

A job row can outlive its broker message:
- the publish after the row insert failed or the process died in between (row `queued`,
  `published_at` null);
- the message was lost (broker data loss, a retry publish that failed) or a hard time limit /
  lost worker left the row `running` with nobody holding the message any more.

`reconcile_jobs` (run periodically by Celery beat, or called directly) settles running rows
whose lease expired through the store's conditional `recover_expired` (requeue as a new
attempt, or fail / cancel with cleanup marked pending), retries pending cleanups of terminal
jobs with backoff, then re-publishes queued rows that are unpublished
past a grace period or were published long ago without being claimed. Every step is a
conditional transition, so a live worker or a concurrent reconciler cannot be overridden;
re-publishing a job whose message still exists only yields a duplicate delivery, which the
claim makes a no-op.

A job type the worker no longer runs (RETIRED_JOB_TYPES) would be re-published forever with no
task to take it: its queued rows (including the expired running ones requeued above) are failed
with `job_retired` instead, and a cleanup left pending on one of its terminal rows is dropped,
since the code that would run it is gone.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from quiz_worker.errors import sanitize_error
from quiz_worker.logging_config import job_id_var
from quiz_worker.runner import (
    CleanupOutcome,
    CleanupPolicy,
    JobDefinition,
    TerminalReason,
    perform_cleanup,
)
from quiz_worker.store import JOB_RETIRED_ERROR, JobRecord, JobStatus, JobStore

logger = logging.getLogger(__name__)

Publisher = Callable[[JobRecord], None]

# Job types whose task was removed: `question.generate` went with 변형 출제 (QGEN-01, QGEN-RM).
RETIRED_JOB_TYPES: frozenset[str] = frozenset({"question.generate"})


@dataclass(frozen=True)
class ReconcileReport:
    requeued: int = 0
    failed: int = 0
    cancelled: int = 0
    republished: int = 0
    publish_errors: int = 0
    cleaned: int = 0
    cleanup_failed: int = 0
    cleanup_gave_up: int = 0
    retired: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "requeued": self.requeued,
            "failed": self.failed,
            "cancelled": self.cancelled,
            "republished": self.republished,
            "publish_errors": self.publish_errors,
            "cleaned": self.cleaned,
            "cleanup_failed": self.cleanup_failed,
            "cleanup_gave_up": self.cleanup_gave_up,
            "retired": self.retired,
        }


def reconcile_jobs(
    store: JobStore,
    publish: Publisher,
    definitions: Mapping[str, JobDefinition[Any]],
    *,
    unpublished_grace_seconds: float,
    stale_after_seconds: float,
    cleanup_policy: CleanupPolicy | None = None,
    limit: int = 100,
    retired_job_types: Collection[str] = RETIRED_JOB_TYPES,
) -> ReconcileReport:
    policy = cleanup_policy or CleanupPolicy()
    counts = {"requeued": 0, "failed": 0, "cancelled": 0}
    to_publish: dict[UUID, JobRecord] = {}

    for expired in store.find_expired_leases(limit=limit):
        settled = store.recover_expired(expired.job_id, attempt=expired.attempts)
        if settled is None:
            continue  # a live worker or another reconciler moved it on
        token = job_id_var.set(str(settled.job_id))
        try:
            match settled.status:
                case JobStatus.QUEUED:
                    counts["requeued"] += 1
                    to_publish[settled.job_id] = settled
                    logger.warning("lost job attempt %d requeued", expired.attempts)
                case JobStatus.FAILED | JobStatus.CANCELLED as status:
                    reason: TerminalReason = "failed" if status is JobStatus.FAILED else "cancelled"
                    counts[reason] += 1
                    # Its cleanup is persisted as pending and run by the cleanup pass below.
                    logger.error("lost job attempt %d settled as %s", expired.attempts, reason)
                case _:
                    pass
        finally:
            job_id_var.reset(token)

    republished = publish_errors = retired = 0
    candidates = store.find_republish_candidates(
        unpublished_grace_seconds=unpublished_grace_seconds,
        stale_after_seconds=stale_after_seconds,
        limit=limit,
    )
    for record in candidates:
        to_publish.setdefault(record.job_id, record)
    for record in to_publish.values():
        token = job_id_var.set(str(record.job_id))
        try:
            if record.job_type in retired_job_types and record.job_type not in definitions:
                if store.retire(record.job_id, error=JOB_RETIRED_ERROR) is not None:
                    retired += 1
                    logger.warning("queued job of a retired job_type failed as job_retired")
                continue
            if record.job_type not in definitions:
                logger.error("cannot republish job: no task for its job_type")
                publish_errors += 1
                continue
            publish(record)
            store.mark_published(record.job_id)
            republished += 1
            logger.info("job re-published")
        except Exception as exc:
            publish_errors += 1
            logger.error("job re-publish failed: %s", sanitize_error(exc))
        finally:
            job_id_var.reset(token)

    cleanup_counts = dict.fromkeys(CleanupOutcome, 0)
    for record in store.find_pending_cleanups(max_attempts=policy.retry.max_attempts, limit=limit):
        token = job_id_var.set(str(record.job_id))
        try:
            if record.job_type in retired_job_types and record.job_type not in definitions:
                outcome = _drop_retired_cleanup(store, record, policy)
                cleanup_counts[outcome] += 1
                continue
            outcome = perform_cleanup(
                store, definitions.get(record.job_type), record.job_id, policy
            )
        except Exception as exc:
            outcome = CleanupOutcome.FAILED
            logger.error("job cleanup bookkeeping failed: %s", sanitize_error(exc))
        finally:
            job_id_var.reset(token)
        cleanup_counts[outcome] += 1

    report = ReconcileReport(
        requeued=counts["requeued"],
        failed=counts["failed"],
        cancelled=counts["cancelled"],
        republished=republished,
        publish_errors=publish_errors,
        cleaned=cleanup_counts[CleanupOutcome.DONE],
        cleanup_failed=cleanup_counts[CleanupOutcome.FAILED],
        cleanup_gave_up=cleanup_counts[CleanupOutcome.GAVE_UP],
        retired=retired,
    )
    if any(report.as_dict().values()):
        logger.info("reconcile_jobs: %s", report.as_dict())
    return report


def _drop_retired_cleanup(
    store: JobStore, record: JobRecord, policy: CleanupPolicy
) -> CleanupOutcome:
    """Clear the pending cleanup of a retired job type's terminal row without running anything."""
    claimed = store.claim_cleanup(
        record.job_id, lease_seconds=policy.lease_seconds, max_attempts=policy.retry.max_attempts
    )
    if claimed is None:
        return CleanupOutcome.SKIPPED
    store.finish_cleanup(record.job_id, cleanup_attempt=claimed.cleanup_attempts)
    logger.warning("pending cleanup of a retired job_type dropped")
    return CleanupOutcome.DONE
