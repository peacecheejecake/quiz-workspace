"""Worker entrypoint: `python -m quiz_worker.serve` (never bare `celery worker`).

Installs the redacting root log handler before Celery starts and stops Celery from
replacing it, so Celery's own log lines (and redirected stdout) go through redaction too.
Prefork children rebuild the app through `app_from_environment`, which installs the same
hooks in each child.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from quiz_worker.celery_app import DEFAULT_QUEUE, app_from_environment
from quiz_worker.settings import get_settings

logger = logging.getLogger(__name__)


def build_worker_argv(concurrency: int, log_level: str) -> list[str]:
    return [
        "worker",
        f"--concurrency={concurrency}",
        f"--loglevel={log_level.upper()}",
        f"--queues={DEFAULT_QUEUE}",
        # No gossip/mingle broadcast traffic; a single small deployment does not need it.
        "--without-gossip",
        "--without-mingle",
    ]


def main(argv: Sequence[str] | None = None) -> None:
    settings = get_settings()
    if settings.task_always_eager:
        raise SystemExit("WORKER_TASK_ALWAYS_EAGER is for tests; unset it to run a worker")
    app = app_from_environment()
    logger.info("starting worker (env=%s, concurrency=%d)", settings.app_env, settings.concurrency)
    app.worker_main([*build_worker_argv(settings.concurrency, settings.log_level), *(argv or [])])


if __name__ == "__main__":
    import sys

    main(sys.argv[1:])
