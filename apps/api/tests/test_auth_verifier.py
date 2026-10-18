"""Access-token verification against locally generated keys (no infra)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import jwt
import pytest
from quiz_api.auth.jwks import JwksUnavailableError, parse_jwks
from quiz_api.auth.verifier import InvalidTokenError, TokenVerifier


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64json(value: dict[str, Any]) -> str:
    return _b64(json.dumps(value).encode())


def _rejected(verifier: TokenVerifier, token: str) -> str:
    with pytest.raises(InvalidTokenError) as info:
        asyncio.run(verifier.verify(token))
    return info.value.reason


def test_valid_es256_token_yields_the_sub(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    user_id = uuid.uuid4()
    claims = auth_kit.claims(user_id)
    user = asyncio.run(make_verifier().verify(signing_key.sign(claims)))
    assert user.id == user_id
    assert user.session_id == claims["session_id"]


def test_valid_rs256_token_is_accepted(
    make_verifier: Callable[..., TokenVerifier], jwks_endpoint: Any, auth_kit: Any
) -> None:
    rsa_key = auth_kit.new_key("RS256")
    jwks_endpoint.keys.append(rsa_key)
    user_id = uuid.uuid4()
    user = asyncio.run(make_verifier().verify(rsa_key.sign(auth_kit.claims(user_id))))
    assert user.id == user_id


def test_audience_list_containing_ours_is_accepted(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    token = signing_key.sign(auth_kit.claims(aud=["other", auth_kit.audience]))
    asyncio.run(make_verifier().verify(token))


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"exp": int(time.time()) - 120}, "expired"),
        ({"iat": int(time.time()) + 600, "exp": int(time.time()) + 4000}, "not_yet_valid"),
        ({"nbf": int(time.time()) + 600}, "not_yet_valid"),
        ({"aud": "not-authenticated"}, "invalid_audience"),
        ({"iss": "https://evil.example/auth/v1"}, "invalid_issuer"),
        ({"sub": None}, "missing_claim"),
        ({"exp": None}, "missing_claim"),
        ({"aud": None}, "missing_claim"),
        ({"iss": None}, "missing_claim"),
        ({"sub": "not-a-uuid"}, "invalid_sub"),
        ({"sub": "6F9619FF8B86D011B42D00C04FC964FF"}, "invalid_sub"),
        ({"sub": 42}, "invalid"),
        ({"role": "anon"}, "invalid_role"),
        ({"role": "service_role"}, "invalid_role"),
        ({"role": None}, "invalid_role"),
    ],
)
def test_claim_violations_are_rejected(
    make_verifier: Callable[..., TokenVerifier],
    signing_key: Any,
    auth_kit: Any,
    overrides: dict[str, Any],
    reason: str,
) -> None:
    token = signing_key.sign(auth_kit.claims(**overrides))
    assert _rejected(make_verifier(), token) == reason


def test_small_clock_skew_is_tolerated(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    token = signing_key.sign(auth_kit.claims(exp=int(time.time()) - 5))
    asyncio.run(make_verifier().verify(token))


def test_alg_none_is_rejected(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    header = {"alg": "none", "typ": "JWT", "kid": signing_key.kid}
    token = f"{_b64json(header)}.{_b64json(auth_kit.claims())}."
    assert _rejected(make_verifier(), token) == "algorithm_not_allowed"


def test_hs256_is_rejected_even_with_the_public_key_as_secret(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    # Classic alg-confusion: HMAC keyed with the published public key.
    secret = json.dumps(signing_key.public_jwk()).encode()
    header = {"alg": "HS256", "typ": "JWT", "kid": signing_key.kid}
    signing_input = f"{_b64json(header)}.{_b64json(auth_kit.claims())}"
    sig = hmac.new(secret, signing_input.encode(), hashlib.sha256).digest()
    assert _rejected(make_verifier(), f"{signing_input}.{_b64(sig)}") == "algorithm_not_allowed"


def test_alg_must_match_the_published_key(
    make_verifier: Callable[..., TokenVerifier], jwks_endpoint: Any, auth_kit: Any
) -> None:
    rsa_key = auth_kit.new_key("RS256")
    jwks_endpoint.keys.append(rsa_key)
    # RSA key published under its kid, token claims ES256 for that kid.
    ec_key = auth_kit.new_key("ES256", kid=rsa_key.kid)
    assert _rejected(make_verifier(), ec_key.sign(auth_kit.claims())) == "algorithm_key_mismatch"


def test_missing_kid_is_rejected(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    token = jwt.encode(auth_kit.claims(), signing_key.private_key, algorithm="ES256")
    assert _rejected(make_verifier(), token) == "missing_kid"


def test_unknown_kid_is_rejected(
    make_verifier: Callable[..., TokenVerifier], auth_kit: Any
) -> None:
    stranger = auth_kit.new_key("ES256")
    assert _rejected(make_verifier(), stranger.sign(auth_kit.claims())) == "unknown_kid"


def test_foreign_key_reusing_a_known_kid_fails_signature(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    forged = auth_kit.new_key("ES256", kid=signing_key.kid)
    assert _rejected(make_verifier(), forged.sign(auth_kit.claims())) == "invalid_signature"


def test_tampered_payload_fails_signature(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    header, _payload, sig = signing_key.sign(auth_kit.claims()).split(".")
    tampered = f"{header}.{_b64json(auth_kit.claims())}.{sig}"
    assert _rejected(make_verifier(), tampered) == "invalid_signature"


@pytest.mark.parametrize("token", ["", "not-a-jwt", "a.b.c", "x" * 9000, "a.b.c.d"])
def test_malformed_tokens_are_rejected(
    make_verifier: Callable[..., TokenVerifier], token: str
) -> None:
    assert _rejected(make_verifier(), token) == "malformed"


def test_reason_never_contains_token_material(
    make_verifier: Callable[..., TokenVerifier], signing_key: Any, auth_kit: Any
) -> None:
    token = signing_key.sign(auth_kit.claims(aud="nope"))
    with pytest.raises(InvalidTokenError) as info:
        asyncio.run(make_verifier().verify(token))
    for part in token.split("."):
        assert part not in str(info.value)
    assert info.value.__cause__ is None


def test_jwks_outage_raises_unavailable_not_invalid(
    make_verifier: Callable[..., TokenVerifier],
    jwks_endpoint: Any,
    signing_key: Any,
    auth_kit: Any,
) -> None:
    jwks_endpoint.error = httpx.ConnectError("boom")
    with pytest.raises(JwksUnavailableError):
        asyncio.run(make_verifier().verify(signing_key.sign(auth_kit.claims())))


def test_parse_jwks_keeps_only_asymmetric_signing_keys(auth_kit: Any) -> None:
    ec_key, rsa_key = auth_kit.new_key("ES256"), auth_kit.new_key("RS256")
    no_alg = {k: v for k, v in auth_kit.new_key("ES256").public_jwk().items() if k != "alg"}
    document = {
        "keys": [
            ec_key.public_jwk(),
            rsa_key.public_jwk(),
            no_alg,
            {"kty": "oct", "kid": "hs", "alg": "HS256", "k": "c2VjcmV0"},
            {**auth_kit.new_key("ES256").public_jwk(), "kid": ""},
            {**auth_kit.new_key("ES256").public_jwk(), "use": "enc"},
            {**auth_kit.new_key("ES256").public_jwk(), "alg": "ES384"},
            {**auth_kit.new_key("ES256").public_jwk(), "alg": "RS256"},
            {"kty": "EC", "kid": "broken", "alg": "ES256", "crv": "P-256", "x": "AA", "y": "AA"},
            "not-a-key",
        ]
    }
    keys = parse_jwks(document)
    assert set(keys) == {ec_key.kid, rsa_key.kid, no_alg["kid"]}
    assert keys[no_alg["kid"]].algorithm_name == "ES256"


@pytest.mark.parametrize("document", [None, [], {"keys": "nope"}, {}])
def test_parse_jwks_rejects_malformed_documents(document: Any) -> None:
    with pytest.raises(JwksUnavailableError):
        parse_jwks(document)
