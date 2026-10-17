"""Bounded retry policy with exponential backoff."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """`max_attempts` counts every run, the first one included (1 = never retry).

    The delay before attempt `n + 1` is `base_delay * 2 ** (n - 1)`, capped at `max_delay`.
    Keep `max_delay` well below the broker visibility timeout: Redis holds ETA messages
    unacked in the worker until they are due.
    """

    max_attempts: int = 3
    base_delay_seconds: float = 30.0
    max_delay_seconds: float = 600.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("need 0 <= base_delay_seconds <= max_delay_seconds")

    def should_retry(self, attempt: int, max_attempts: int | None = None) -> bool:
        return attempt < (self.max_attempts if max_attempts is None else max_attempts)

    def countdown(self, attempt: int) -> float:
        """Seconds to wait after failed attempt `attempt` (1-based)."""
        if attempt < 1:
            raise ValueError("attempt is 1-based")
        return float(min(self.max_delay_seconds, self.base_delay_seconds * 2 ** (attempt - 1)))
