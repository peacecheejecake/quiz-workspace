"""Session-level advisory lock serialising the jobs (and cleanups) of one question run.

Shared by `question.import` (M4.4a) and `question.generate` (M6.2). The lock lives on a dedicated
connection, so a dead worker's connection drops and releases it.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, text

from quiz_worker.document_store import DocumentBusyError

_LOCK_POLL_SECONDS = 0.5


@contextmanager
def advisory_run_lock(
    engine: Engine,
    key: str,
    *,
    wait_seconds: float,
    check: Callable[[], None],
    busy_message: str,
) -> Iterator[None]:
    """Hold `pg_advisory_lock(hashtextextended(key))`; `DocumentBusyError` (retryable) after
    `wait_seconds`. `check` runs between polls (cancellation)."""
    with engine.connect() as conn:
        deadline = time.monotonic() + wait_seconds
        while not conn.execute(
            text("select pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
        ).scalar_one():
            conn.commit()
            if time.monotonic() >= deadline:
                raise DocumentBusyError(busy_message)
            check()
            time.sleep(_LOCK_POLL_SECONDS)
        conn.commit()
        try:
            yield
        finally:
            try:
                conn.execute(text("select pg_advisory_unlock(hashtextextended(:k, 0))"), {"k": key})
                conn.commit()
            except Exception:
                conn.invalidate()
