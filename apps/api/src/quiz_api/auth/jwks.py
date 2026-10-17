"""JWKS discovery for Supabase Auth access tokens (docs/auth.md §3).

Keys are cached for `ttl_seconds`. A token whose `kid` is not cached triggers one refetch (key
rotation), but refetches are rate-limited to one per `min_refresh_interval_seconds` so forged
`kid`s cannot turn the API into a JWKS amplifier. A fetch (connect + whole body) has one overall
deadline, and the body is streamed with a byte cap, so a slow or huge response cannot hold the
refresh lock.

When the JWKS cannot be fetched, the last good key set keeps being served for up to
`max_stale_seconds`; beyond that (or before the first successful fetch) `JwksUnavailableError`
is raised, which the API maps to 503 so an Auth outage is never reported as a bad token (401).
Every fetch or parse failure takes that path (never a 500) and is logged by exception type or
status only: URLs and response bodies are not logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx
from jwt import PyJWK

logger = logging.getLogger(__name__)

# Asymmetric algorithms only: `none` and HS* (shared secret) are never accepted.
ALLOWED_ALGORITHMS: frozenset[str] = frozenset({"ES256", "RS256"})
_ALLOWED_KEY_TYPES = {"ES256": "EC", "RS256": "RSA"}
MAX_JWKS_BYTES = 64 * 1024


class JwksUnavailableError(RuntimeError):
    """The signing keys could not be obtained (Auth outage, timeout, malformed JWKS)."""


@dataclass
class JwksMetrics:
    """In-process counters (exported by a metrics endpoint/exporter in a later task)."""

    counts: Counter[str] = field(default_factory=Counter)

    def incr(self, name: str) -> None:
        self.counts[name] += 1


# Members copied into the key handed to PyJWT; every one must be a string when present.
_STRING_MEMBERS = ("kty", "kid", "alg", "use", "crv", "x", "y", "n", "e")


def _sanitize_jwk(jwk: Any) -> dict[str, Any] | None:
    """A copy of the public-key members of `jwk`, or `None` if any member has a wrong type."""
    if not isinstance(jwk, Mapping):
        return None
    clean: dict[str, Any] = {}
    for name in _STRING_MEMBERS:
        value = jwk.get(name)
        if value is None:
            continue
        if not isinstance(value, str):
            return None
        clean[name] = value
    key_ops = jwk.get("key_ops")
    if key_ops is not None:
        if not isinstance(key_ops, list) or not all(isinstance(op, str) for op in key_ops):
            return None
        if "verify" not in key_ops:
            return None
    return clean


def parse_jwks(document: Any) -> dict[str, PyJWK]:
    """Usable signing keys by `kid`. Entries with a wrong member type, without a kid, with a
    symmetric/unknown type or an algorithm outside the allowlist, or not meant for verifying
    signatures, are dropped; one bad entry never invalidates the others."""
    if not isinstance(document, Mapping) or not isinstance(document.get("keys"), list):
        raise JwksUnavailableError("JWKS document has no `keys` list")
    keys: dict[str, PyJWK] = {}
    for entry in document["keys"]:
        jwk = _sanitize_jwk(entry)
        if jwk is None:
            continue
        kid, kty = jwk.get("kid"), jwk.get("kty")
        if not kid or jwk.get("use", "sig") != "sig":
            continue
        alg = jwk.get("alg") or {"EC": "ES256", "RSA": "RS256"}.get(kty or "")
        if alg not in ALLOWED_ALGORITHMS or _ALLOWED_KEY_TYPES[alg] != kty:
            continue
        try:
            key = PyJWK(jwk, algorithm=alg)
        except Exception:  # malformed key material in any form: skip the entry
            logger.warning("Ignoring malformed JWKS entry (kty=%s)", kty)
            continue
        if key.algorithm_name != alg:
            continue
        keys[kid] = key
    return keys


class JwksCache:
    def __init__(
        self,
        url: str,
        *,
        ttl_seconds: float = 600.0,
        min_refresh_interval_seconds: float = 30.0,
        max_stale_seconds: float = 3600.0,
        timeout_seconds: float = 3.0,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        metrics: JwksMetrics | None = None,
    ) -> None:
        self._url = url
        self._ttl = ttl_seconds
        self._min_refresh_interval = min_refresh_interval_seconds
        self._max_stale = max_stale_seconds
        self._timeout = timeout_seconds
        self._transport = transport
        self._clock = clock
        self.metrics = metrics or JwksMetrics()
        self._keys: dict[str, PyJWK] = {}
        self._fetched_at: float | None = None
        self._last_attempt_at: float | None = None
        self._last_attempt_failed = False
        self._lock = asyncio.Lock()

    async def get_key(self, kid: str) -> PyJWK | None:
        """The verification key for `kid`, or `None` if the issuer does not publish it.

        Raises `JwksUnavailableError` when no trustworthy key set is available.
        """
        if self._is_fresh() and kid in self._keys:
            return self._keys[kid]
        async with self._lock:
            # Another request may have refreshed while we waited for the lock.
            if self._is_fresh() and kid in self._keys:
                return self._keys[kid]
            if self._may_refetch():
                await self._refresh()
            elif self._last_attempt_failed and not self._is_usable():
                raise JwksUnavailableError("JWKS unavailable (refetch rate-limited)")
            if not self._is_usable():
                raise JwksUnavailableError("JWKS unavailable")
            if kid not in self._keys and self._last_attempt_failed:
                # Cannot tell a rotated key from a forged kid while the issuer is unreachable.
                raise JwksUnavailableError("JWKS unavailable for unknown kid")
            return self._keys.get(kid)

    def _age(self) -> float | None:
        return None if self._fetched_at is None else self._clock() - self._fetched_at

    def _is_fresh(self) -> bool:
        age = self._age()
        return age is not None and age < self._ttl

    def _is_usable(self) -> bool:
        age = self._age()
        return age is not None and age < self._ttl + self._max_stale

    def _may_refetch(self) -> bool:
        if self._last_attempt_at is None:
            return True
        if not self._is_fresh() and not self._last_attempt_failed:
            return True  # TTL expiry: always refresh a healthy cache
        return self._clock() - self._last_attempt_at >= self._min_refresh_interval

    async def _refresh(self) -> None:
        self._last_attempt_at = self._clock()
        try:
            async with asyncio.timeout(self._timeout):
                keys = await self._fetch()
        except JwksUnavailableError as exc:
            self._record_failure(str(exc))
            return
        except Exception as exc:
            # Network errors, the overall deadline, bad JSON or anything unexpected in parsing:
            # all take the same back-off / stale-keys path, never a 500.
            self._record_failure(type(exc).__name__)
            return
        self._keys = keys
        self._fetched_at = self._clock()
        self._last_attempt_failed = False
        self.metrics.incr("jwks_fetch_success")
        if not keys:
            logger.warning("JWKS contains no usable asymmetric signing keys")

    def _record_failure(self, reason: str) -> None:
        self._last_attempt_failed = True
        self.metrics.incr("jwks_fetch_failure")
        logger.warning("JWKS fetch failed: %s", reason)

    async def _fetch(self) -> dict[str, PyJWK]:
        """Fetch and parse the JWKS. The caller bounds the total duration; the body is streamed
        and abandoned as soon as it exceeds `MAX_JWKS_BYTES`."""
        async with (
            httpx.AsyncClient(
                timeout=self._timeout, follow_redirects=False, transport=self._transport
            ) as client,
            client.stream("GET", self._url, headers={"Accept": "application/json"}) as response,
        ):
            if response.status_code != 200:
                raise JwksUnavailableError(f"JWKS endpoint answered HTTP {response.status_code}")
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > MAX_JWKS_BYTES:
                raise JwksUnavailableError("JWKS document too large")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_JWKS_BYTES:
                    raise JwksUnavailableError("JWKS document too large")
        return parse_jwks(json.loads(body))
