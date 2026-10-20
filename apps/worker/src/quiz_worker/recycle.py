"""Replace a prefork child after N *job* tasks, never because of maintenance tasks (WRK-RECYCLE).

`WORKER_MAX_TASKS_PER_CHILD` exists to return the models' memory (Docling, a local embedder,
clients) a job leaves in its pool process. Celery's own `worker_max_tasks_per_child` counts
every task, so the beat-scheduled `quiz.maintenance.reconcile_jobs` (every minute) replaced the
child every minute and each new child warmed the PDF parser up again. The worker therefore
runs Celery's prefork pool with `worker_max_tasks_per_child` unset and this pool instead:

- job tasks (`quiz.jobs.*`, `IdempotentJobTask`) call `job_task_finished` when they return or
  raise, in the child that ran them; maintenance tasks never do;
- once a child has finished N job tasks, its next wait for work exits with `EX_RECYCLE`.

That is the same point and exit path billiard uses for its own max-tasks recycling: the result
of the last task has been sent (and `_ensure_messages_consumed` waits until the main process
has read it), so the task is acknowledged and stored, never reported lost or re-delivered. A
job the main process had already written to the exiting child's pipe is unread, so the pool
puts it back for another child, as with billiard's own recycling.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from billiard import pool as billiard_pool
from celery.concurrency import asynpool, prefork

logger = logging.getLogger(__name__)

EX_RECYCLE: int = billiard_pool.EX_RECYCLE


class JobTaskBudget:
    """Job tasks finished by this (pool child) process and whether it should be replaced."""

    def __init__(self) -> None:
        self.finished = 0
        self.recycle_requested = False

    def task_finished(self, max_tasks_per_child: int) -> None:
        self.finished += 1
        if max_tasks_per_child > 0 and self.finished >= max_tasks_per_child:
            self.recycle_requested = True

    def reset(self) -> None:
        self.finished = 0
        self.recycle_requested = False


# One per process: a pool child starts from zero (spawned children import this afresh; a forked
# child is created by the main process, which never runs job tasks).
budget = JobTaskBudget()


def job_task_finished(max_tasks_per_child: int) -> None:
    """Count a finished job task in this process (`0` = never recycle)."""
    budget.task_finished(max_tasks_per_child)


class _RecyclingWorkerMixin:
    """Pool child loop that exits once `budget` asks for it, before it takes more work."""

    wait_for_job: Any

    def _make_child_methods(self, *args: Any, **kwargs: Any) -> None:
        super()._make_child_methods(*args, **kwargs)  # type: ignore[misc]
        receive = self.wait_for_job

        def wait_for_job(*a: Any, **kw: Any) -> Any:
            if budget.recycle_requested:
                logger.info("replacing pool process after %d job tasks", budget.finished)
                # billiard's child patches `sys.exit` to record the exit code: the main process
                # sees EX_RECYCLE (a planned replacement, not a crash) and starts a new child.
                sys.exit(EX_RECYCLE)
            return receive(*a, **kw)

        self.wait_for_job = wait_for_job


class RecyclingAsynPoolWorker(_RecyclingWorkerMixin, asynpool.Worker):
    pass


class RecyclingBlockingPoolWorker(_RecyclingWorkerMixin, billiard_pool.Worker):
    pass


class RecyclingAsynPool(asynpool.AsynPool):
    Worker = RecyclingAsynPoolWorker


class RecyclingBlockingPool(billiard_pool.Pool):
    Worker = RecyclingBlockingPoolWorker


class TaskPool(prefork.TaskPool):
    """Celery's prefork pool whose children recycle after N job tasks (`worker_pool`)."""

    Pool = RecyclingAsynPool
    BlockingPool = RecyclingBlockingPool


POOL_CLS = f"{__name__}:TaskPool"
