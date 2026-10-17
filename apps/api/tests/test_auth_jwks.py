"""JWKS cache: TTL, refresh on unknown kid, rate-limited refetch, outage handling (no infra)."""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections.abc import AsyncIterator, Callable, Iterable
from typing import Any

import httpx
import pytest
from quiz_api.auth.jwks import MAX_JWKS_BYTES, JwksUnavailableError, parse_jwks
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


class _ChunkStream(httpx.AsyncByteStream):
    """Response body yielding `chunks`, sleeping `delay` seconds before each one."""

    def __init__(self, chunks: Iterable[bytes], delay: float = 0.0) -> None:
        self._chunks = chunks
        self._delay = delay
        self.sent = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            if self._delay:
                await asyncio.sleep(self._delay)
            self.sent += len(chunk)
            yield chunk


def _trickle() -> _ChunkStream:
    # Each byte arrives well within any per-read timeout, but the body never finishes.
    return _ChunkStream(itertools.repeat(b" ", 100_000), delay=0.02)


def test_trickling_response_hits_the_overall_deadline(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    jwks_endpoint.stream = _trickle()
    verifier = make_verifier(timeout_seconds=0.3)

    started = time.monotonic()
    with pytest.raises(JwksUnavailableError):
        _verify(verifier, signing_key.sign(auth_kit.claims()))
    assert time.monotonic() - started < 2
    assert verifier.jwks.metrics.counts["jwks_fetch_failure"] == 1


def test_slow_failure_keeps_serving_stale_keys(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, clock: Any, auth_kit: Any
) -> None:
    verifier = make_verifier(ttl_seconds=600, timeout_seconds=0.2)
    _verify(verifier, signing_key.sign(auth_kit.claims()))

    jwks_endpoint.stream = _trickle()
    clock.advance(700)
    _verify(verifier, signing_key.sign(auth_kit.claims()))  # deadline hit → stale keys used
    assert verifier.jwks.metrics.counts["jwks_fetch_failure"] == 1


def test_streamed_body_over_the_cap_is_abandoned(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    stream = _ChunkStream(itertools.repeat(b"x" * 4096, 10_000))  # ~40 MB if fully read
    jwks_endpoint.stream = stream
    verifier = make_verifier()

    with pytest.raises(JwksUnavailableError):
        _verify(verifier, signing_key.sign(auth_kit.claims()))
    assert stream.sent <= MAX_JWKS_BYTES + 4096
    assert verifier.jwks.metrics.counts["jwks_fetch_failure"] == 1


def test_declared_oversized_content_length_is_rejected_before_reading(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    stream = _ChunkStream([b"{}"])
    jwks_endpoint.transport = httpx.MockTransport(
        lambda _req: httpx.Response(
            200, headers={"Content-Length": str(MAX_JWKS_BYTES + 1)}, stream=stream
        )
    )
    with pytest.raises(JwksUnavailableError):
        _verify(make_verifier(), signing_key.sign(auth_kit.claims()))
    assert stream.sent == 0


def test_non_json_body_is_a_fetch_failure(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    jwks_endpoint.stream = _ChunkStream([b"<html>not json"])
    with pytest.raises(JwksUnavailableError):
        _verify(make_verifier(), signing_key.sign(auth_kit.claims()))


MALFORMED_ENTRIES: list[Any] = [
    {"kid": "a", "kty": "EC", "alg": []},
    {"kid": "b", "kty": "EC", "alg": {"x": 1}},
    {"kid": ["c"], "kty": "EC", "alg": "ES256"},
    {"kid": "d", "kty": ["EC"], "alg": "ES256"},
    {"kid": "e", "kty": "EC", "alg": "ES256", "use": ["sig"]},
    {"kid": "f", "kty": "EC", "alg": "ES256", "key_ops": "verify"},
    {"kid": "g", "kty": "EC", "alg": "ES256", "key_ops": [1]},
    {"kid": "h", "kty": "EC", "alg": "ES256", "crv": "P-256", "x": 1, "y": None},
    {"kid": "i", "kty": "EC", "alg": "ES256", "crv": "P-256", "x": "!!", "y": "??"},
    {"kid": "j", "kty": "RSA", "alg": "RS256", "n": "", "e": ""},
    {"kid": "k", "kty": "EC", "alg": "ES256", "crv": ["P-256"], "x": "AA", "y": "AA"},
    None,
    42,
    [],
]


def test_malformed_entries_are_skipped_and_good_keys_kept(auth_kit: Any) -> None:
    good = auth_kit.new_key("ES256")
    signing_only = {**auth_kit.new_key("ES256").public_jwk(), "key_ops": ["sign"]}
    keys = parse_jwks({"keys": [*MALFORMED_ENTRIES, signing_only, good.public_jwk()]})
    assert set(keys) == {good.kid}


@pytest.mark.parametrize("entry", MALFORMED_ENTRIES)
def test_malformed_entry_mixed_with_a_good_key_still_verifies(
    make_verifier: VerifierFactory,
    jwks_endpoint: Any,
    signing_key: Any,
    auth_kit: Any,
    entry: Any,
) -> None:
    jwks_endpoint.body = {"keys": [entry, signing_key.public_jwk()]}
    _verify(make_verifier(), signing_key.sign(auth_kit.claims()))


@pytest.mark.parametrize(
    "body",
    [{"keys": {"kid": "x"}}, {"keys": None}, ["not", "a", "jwks"], "string", 7],
)
def test_entirely_malformed_document_falls_back_to_stale_keys(
    make_verifier: VerifierFactory,
    jwks_endpoint: Any,
    signing_key: Any,
    clock: Any,
    auth_kit: Any,
    body: Any,
) -> None:
    verifier = make_verifier(ttl_seconds=600, min_refresh_interval_seconds=30)
    _verify(verifier, signing_key.sign(auth_kit.claims()))

    jwks_endpoint.body = body
    clock.advance(700)
    _verify(verifier, signing_key.sign(auth_kit.claims()))  # stale keys still verify
    assert verifier.jwks.metrics.counts["jwks_fetch_failure"] == 1
    assert jwks_endpoint.calls == 2


def test_document_of_only_malformed_entries_yields_no_keys(
    make_verifier: VerifierFactory, jwks_endpoint: Any, signing_key: Any, auth_kit: Any
) -> None:
    jwks_endpoint.body = {"keys": MALFORMED_ENTRIES}
    with pytest.raises(InvalidTokenError):  # fetched fine, but nothing can verify the token
        _verify(make_verifier(), signing_key.sign(auth_kit.claims()))
