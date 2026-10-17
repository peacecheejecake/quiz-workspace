"""In-process per-key token bucket (M3.6a search stopgap).

docs/deployment.md §6 asks for separate rate limits on search. This limiter lives in one API
process: with several replicas the effective limit is multiplied by their number, and a restart
resets it. It is a stopgap until a shared limiter (Redis or the edge) replaces it; it bounds
accidental floods from one signed-in user, not a distributed attack.
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    updated: float


class TokenBucketLimiter:
    """`rate_per_minute` tokens refill continuously up to `burst`; each request takes one.

    `rate_per_minute=0` disables the limiter. Memory is bounded: once more than `max_keys`
    buckets exist, buckets that have refilled completely (idle keys) are dropped.
    """

    def __init__(
        self,
        rate_per_minute: int,
        burst: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 10_000,
    ) -> None:
        if rate_per_minute < 0 or burst < 1:
            raise ValueError("rate_per_minute must be >= 0 and burst >= 1")
        self._rate = rate_per_minute / 60.0
        self._burst = float(burst)
        self._clock = clock
        self._max_keys = max_keys
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self._rate > 0

    def acquire(self, key: str) -> float | None:
        """Take a token for `key`: None when allowed, else seconds until the next token."""
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                if len(self._buckets) >= self._max_keys:
                    self._prune(now)
                bucket = self._buckets[key] = _Bucket(self._burst, now)
            else:
                bucket.tokens = min(
                    self._burst, bucket.tokens + (now - bucket.updated) * self._rate
                )
                bucket.updated = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return None
            return (1.0 - bucket.tokens) / self._rate

    def _prune(self, now: float) -> None:
        full = [
            key
            for key, b in self._buckets.items()
            if b.tokens + (now - b.updated) * self._rate >= self._burst
        ]
        for key in full:
            del self._buckets[key]


def retry_after_header(seconds: float) -> str:
    return str(max(1, math.ceil(seconds)))
