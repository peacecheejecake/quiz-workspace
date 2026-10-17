"""Worker entrypoint: `python -m quiz_worker.serve` (never bare `celery worker`).

Installs the redacting root log handler before Celery starts and stops Celery from
replacing it, so Celery's own log lines (and redirected stdout) go through redaction too.
Prefork children rebuild the app through `app_from_environment`, which installs the same
hooks in each child.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence

import billiard

from quiz_worker.celery_app import DEFAULT_QUEUE, app_from_environment
from quiz_worker.settings import get_settings

logger = logging.getLogger(__name__)


def build_worker_argv(concurrency: int, log_level: str, *, beat: bool = True) -> list[str]:
    argv = [
        "worker",
        f"--concurrency={concurrency}",
        f"--loglevel={log_level.upper()}",
        f"--queues={DEFAULT_QUEUE}",
        # No gossip/mingle broadcast traffic; a single small deployment does not need it.
        "--without-gossip",
        "--without-mingle",
    ]
    if beat:
        # Embedded beat schedules reconcile_jobs; the in-memory scheduler writes no files.
        argv += ["--beat", "--scheduler=celery.beat:Scheduler"]
    return argv


def prepare_pool_start_method() -> str:
    """Make prefork children work when billiard spawns them (macOS default; Linux forks).

    Spawned children re-import Celery; without `FORKED_BY_MULTIPROCESSING` Celery skips the
    per-child trace setup and every task fails in `fast_trace_task`. Children inherit the
    variable from this process.
    """
    method = billiard.get_start_method()
    if method != "fork":
        os.environ["FORKED_BY_MULTIPROCESSING"] = "1"
    return str(method)


def main(argv: Sequence[str] | None = None) -> None:
    settings = get_settings()
    if settings.task_always_eager:
        raise SystemExit("WORKER_TASK_ALWAYS_EAGER is for tests; unset it to run a worker")
    prepare_pool_start_method()
    app = app_from_environment()
    logger.info("starting worker (env=%s, concurrency=%d)", settings.app_env, settings.concurrency)
    worker_argv = build_worker_argv(
        settings.concurrency, settings.log_level, beat=settings.embedded_beat
    )
    app.worker_main([*worker_argv, *(argv or [])])


if __name__ == "__main__":
    import sys

    main(sys.argv[1:])
