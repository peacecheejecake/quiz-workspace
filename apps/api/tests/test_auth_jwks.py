"""JWKS cache: TTL, refresh on unknown kid, rate-limited refetch, outage handling (no infra)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from quiz_api.auth.jwks import JwksUnavailableError
from quiz_api.auth.verifier import InvalidTokenError, TokenVerifier

VerifierFactory = Callable[..., TokenVerifier]


def _verify(verifier: TokenVerifier, token: str) -> None:
    asyncio.run(verifier.verify(token))


def test_keys_are_cached_within_ttl(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(ttl_seconds=600)
    for _ in range(5):
        _verify(verifier, signing_key.sign(auth_kit.claims()))
        clock.advance(60)
    assert jwks_endpoint.calls == 1
    assert verifier.jwks.metrics.counts["jwks_fetch_success"] == 1


def test_cache_is_refreshed_after_ttl(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(ttl_seconds=600)
    _verify(verifier, signing_key.sign(auth_kit.claims()))
    clock.advance(601)
    _verify(verifier, signing_key.sign(auth_kit.claims()))
    assert jwks_endpoint.calls == 2


def test_rotated_key_is_picked_up_via_unknown_kid_refresh(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(min_refresh_interval_seconds=30)
    _verify(verifier, signing_key.sign(auth_kit.claims()))

    rotated = auth_kit.new_key("ES256")
    jwks_endpoint.keys.append(rotated)
    clock.advance(31)
    _verify(verifier, rotated.sign(auth_kit.claims()))
    assert jwks_endpoint.calls == 2


def test_unknown_kid_refetch_is_rate_limited(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(min_refresh_interval_seconds=30)
    _verify(verifier, signing_key.sign(auth_kit.claims()))

    for _ in range(20):  # a flood of random kids costs at most one refetch per interval
        stranger = auth_kit.new_key("ES256")
        with pytest.raises(InvalidTokenError):
            _verify(verifier, stranger.sign(auth_kit.claims()))
    assert jwks_endpoint.calls == 1

    clock.advance(31)
    with pytest.raises(InvalidTokenError):
        _verify(verifier, auth_kit.new_key("ES256").sign(auth_kit.claims()))
    assert jwks_endpoint.calls == 2


@pytest.mark.parametrize(
    "outage",
    [
        {"error": httpx.ConnectError("connection refused")},
        {"error": httpx.ReadTimeout("timed out")},
        {"status": 500},
        {"status": 404},
        {"body": {"not": "a jwks"}},
    ],
    ids=["connect", "timeout", "http-500", "http-404", "malformed"],
)
def test_first_fetch_failure_is_unavailable_and_backs_off(
    make_verifier: VerifierFactory,
    jwks_endpoint: Any,
    signing_key: Any,
    clock: Any,
    auth_kit: Any,
    outage: dict[str, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    for name, value in outage.items():
        setattr(jwks_endpoint, name, value)
    verifier = make_verifier(min_refresh_interval_seconds=30)
    token = signing_key.sign(auth_kit.claims())

    with caplog.at_level(logging.WARNING), pytest.raises(JwksUnavailableError):
        _verify(verifier, token)
    with pytest.raises(JwksUnavailableError):
        _verify(verifier, token)  # within the back-off window: no new request
    assert jwks_endpoint.calls == 1
    assert verifier.jwks.metrics.counts["jwks_fetch_failure"] == 1
    assert "JWKS fetch failed" in caplog.text
    assert token not in caplog.text
    assert "auth.test.invalid" not in caplog.text  # URL not logged

    # Recovery after the back-off window.
    jwks_endpoint.error, jwks_endpoint.status, jwks_endpoint.body = None, 200, None
    clock.advance(31)
    _verify(verifier, token)
    assert jwks_endpoint.calls == 2


def test_stale_keys_are_served_during_outage_then_expire(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(ttl_seconds=600, max_stale_seconds=3600)
    _verify(verifier, signing_key.sign(auth_kit.claims()))

    jwks_endpoint.error = httpx.ConnectError("down")
    clock.advance(700)  # past TTL: refresh fails, last good keys still verify
    _verify(verifier, signing_key.sign(auth_kit.claims()))
    # Unknown kid while the issuer is unreachable: cannot tell rotation from forgery → 503.
    with pytest.raises(JwksUnavailableError):
        _verify(verifier, auth_kit.new_key("ES256").sign(auth_kit.claims()))

    clock.advance(3600)  # beyond max staleness: no trustworthy keys left
    with pytest.raises(JwksUnavailableError):
        _verify(verifier, signing_key.sign(auth_kit.claims()))


def test_concurrent_requests_share_one_fetch(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    verifier = make_verifier()
    tokens = [signing_key.sign(auth_kit.claims()) for _ in range(10)]

    async def run() -> None:
        await asyncio.gather(*(verifier.verify(t) for t in tokens))

    asyncio.run(run())
    assert jwks_endpoint.calls == 1


def test_oversized_jwks_is_rejected(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    jwks_endpoint.body = {"keys": [signing_key.public_jwk()], "padding": "x" * 70_000}
    with pytest.raises(JwksUnavailableError):
        _verify(make_verifier(), signing_key.sign(auth_kit.claims()))
