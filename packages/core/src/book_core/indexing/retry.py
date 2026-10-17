"""Retries for transient Qdrant errors. Every store operation is idempotent (deterministic point
ids, payload writes by id or filter, deletes by filter), so retrying a call is always safe."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse

_TRANSIENT_STATUS = frozenset({408, 429, 500, 502, 503, 504})


def is_transient(exc: BaseException) -> bool:
    if isinstance(exc, UnexpectedResponse):
        return exc.status_code in _TRANSIENT_STATUS
    return isinstance(
        exc, ResponseHandlingException | httpx.TransportError | ConnectionError | TimeoutError
    )


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Exponential backoff: ``attempts`` calls in total, delays ``base_delay * 2**n`` capped at
    ``max_delay``. Only ``is_transient`` errors are retried."""

    attempts: int = 4
    base_delay: float = 0.2
    max_delay: float = 5.0
    sleep: Callable[[float], None] = field(default=time.sleep, compare=False)

    def __post_init__(self) -> None:
        if self.attempts < 1 or self.base_delay < 0 or self.max_delay < 0:
            raise ValueError("require attempts >= 1 and non-negative delays")

    def call[T](self, operation: Callable[[], T]) -> T:
        for attempt in range(self.attempts):
            try:
                return operation()
            except Exception as exc:
                if attempt + 1 >= self.attempts or not is_transient(exc):
                    raise
                self.sleep(min(self.max_delay, self.base_delay * 2**attempt))
        raise AssertionError("unreachable")  # pragma: no cover
