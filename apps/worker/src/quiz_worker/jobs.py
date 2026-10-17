"""Job definitions registered on the default worker app.

`echo` is the wiring example: it validates a versioned payload, honours cancellation (also
while it waits `delay_seconds`, which lets tests hold a job running) and returns a small
non-sensitive result. Real jobs (parse/index, import, generation, fork) follow
the same shape in their own modules and are added to `celery_app.default_definitions()`.
"""

from __future__ import annotations

import time

from pydantic import BaseModel, ConfigDict, Field

from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult


class EchoPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    message: str = Field(max_length=1000)
    delay_seconds: float = Field(default=0, ge=0, le=60)


def echo(ctx: JobContext, payload: EchoPayloadV1) -> JobResult:
    ctx.check_cancelled()
    deadline = time.monotonic() + payload.delay_seconds
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(0.1, remaining))
        ctx.check_cancelled()
    # Return a derived value only: job results are stored and logged by Celery.
    return {"length": len(payload.message)}


ECHO_JOB: JobDefinition[EchoPayloadV1] = JobDefinition(
    job_type="echo",
    payload_models={1: EchoPayloadV1},
    handler=echo,
    retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=1.0, max_delay_seconds=10.0),
)
