"""Publishing `async_jobs` rows to the worker (P0.7 envelope contract, apps/worker).

The API owns job *creation*: it inserts the `async_jobs` row in the same transaction as the
domain rows the job works on (`created_by` = verified JWT sub, idempotency scope
`(workspace_id, created_by, job_type, idempotency_key)`), commits, and only then publishes the
message and records `published_at`. A publish that fails (or a process that dies before it)
leaves the row queued and unpublished; the worker's reconciler publishes it after its grace
period, so the job is never lost.

The message is exactly what `quiz_worker.celery_app.publish_record` sends: task
`quiz.jobs.<job_type>` on queue `quiz.jobs`, `task_id` = job id, one positional argument = the
JSON `JobEnvelope`. The argument repr is replaced so the envelope never reaches broker events or
logs. These names are mirrored (not imported) so the API does not depend on the worker package;
`apps/api/tests/test_jobs.py` checks they match.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from celery import Celery

from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

TASK_NAME_PREFIX = "quiz.jobs."
DEFAULT_QUEUE = "quiz.jobs"


@dataclass(frozen=True)
class JobMessage:
    """Mirror of `quiz_worker.envelope.JobEnvelope`."""

    job_id: uuid.UUID
    job_type: str
    schema_version: int
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    idempotency_key: str | None
    payload: dict[str, Any] = field(repr=False)

    def to_message(self) -> dict[str, Any]:
        return {
            "job_id": str(self.job_id),
            "job_type": self.job_type,
            "schema_version": self.schema_version,
            "idempotency_key": self.idempotency_key,
            "workspace_id": str(self.workspace_id),
            "created_by": str(self.created_by) if self.created_by else None,
            "payload": self.payload,
        }


def task_name(job_type: str) -> str:
    return f"{TASK_NAME_PREFIX}{job_type}"


class JobPublisher(Protocol):
    def publish(self, message: JobMessage) -> None:
        """Hand the message to the broker; raises on failure."""
        ...


class CeleryJobPublisher:
    """Producer-only Celery app on the worker's broker (`REDIS_URL`)."""

    def __init__(self, broker_url: str) -> None:
        self._app = Celery("quiz_api", set_as_current=False)
        self._app.conf.update(
            broker_url=broker_url,
            task_serializer="json",
            accept_content=["json"],
            broker_connection_timeout=3,
            broker_connection_retry_on_startup=False,
        )

    def publish(self, message: JobMessage) -> None:
        self._app.send_task(
            task_name(message.job_type),
            args=(message.to_message(),),
            task_id=str(message.job_id),
            queue=DEFAULT_QUEUE,
            argsrepr=f"(<job {message.job_id}>,)",
            kwargsrepr="{}",
            retry=True,
            retry_policy={
                "max_retries": 2,
                "interval_start": 0,
                "interval_step": 0.5,
                "interval_max": 1,
            },
        )

    def close(self) -> None:
        self._app.close()


def build_job_publisher(settings: Settings) -> CeleryJobPublisher | None:
    """`None` without a broker: jobs stay queued for the reconciler to publish."""
    if settings.redis_url is None:
        return None
    return CeleryJobPublisher(settings.redis_url.get_secret_value())
