from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm, RSAAlgorithm
from quiz_api.auth.jwks import JwksCache
from quiz_api.auth.verifier import TokenVerifier
from quiz_api.health import ReadinessChecker
from quiz_api.main import create_app
from quiz_api.settings import Settings

AppFactory = Callable[..., FastAPI]
CheckerFactory = Callable[..., ReadinessChecker]


def healthy(name: str) -> ReadinessChecker:
    async def check() -> None:
        return None

    return ReadinessChecker(name, check)


def failing(name: str, exc: Exception) -> ReadinessChecker:
    async def check() -> None:
        raise exc

    return ReadinessChecker(name, check)


@pytest.fixture(name="healthy")
def healthy_fixture() -> CheckerFactory:
    return healthy


@pytest.fixture(name="failing")
def failing_fixture() -> CheckerFactory:
    return failing


@pytest.fixture
def settings() -> Settings:
    # model_construct: defaults only, independent of the developer's env / .env.
    return Settings.model_construct(readiness_timeout_seconds=0.2)


@pytest.fixture
def make_app(settings: Settings) -> AppFactory:
    def factory(checkers: Sequence[ReadinessChecker] | None = None) -> FastAPI:
        if checkers is None:
            checkers = [healthy("database"), healthy("redis"), healthy("qdrant")]
        return create_app(settings, readiness_checkers=checkers)

    return factory


@pytest.fixture
def client(make_app: AppFactory) -> Iterator[TestClient]:
    with TestClient(make_app()) as test_client:
        yield test_client


# --- Auth test support: locally generated signing keys and an in-memory JWKS endpoint --------

TEST_ISSUER = "https://auth.test.invalid/auth/v1"
TEST_JWKS_URL = f"{TEST_ISSUER}/.well-known/jwks.json"
TEST_AUDIENCE = "authenticated"


@dataclass(frozen=True)
class SigningKey:
    kid: str
    alg: str
    private_key: Any = field(repr=False)

    @classmethod
    def generate(cls, alg: str = "ES256", kid: str | None = None) -> SigningKey:
        private: Any
        if alg == "ES256":
            private = ec.generate_private_key(ec.SECP256R1())
        elif alg == "RS256":
            private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        else:  # pragma: no cover - test helper misuse
            raise ValueError(alg)
        return cls(kid=kid or str(uuid.uuid4()), alg=alg, private_key=private)

    def public_jwk(self) -> dict[str, Any]:
        public = self.private_key.public_key()
        if self.alg == "ES256":
            jwk: dict[str, Any] = ECAlgorithm.to_jwk(public, as_dict=True)
        else:
            jwk = RSAAlgorithm.to_jwk(public, as_dict=True)
        return {**jwk, "kid": self.kid, "alg": self.alg, "use": "sig"}

    def sign(self, claims: dict[str, Any], **header: Any) -> str:
        headers = {"kid": self.kid, **header}
        alg = headers.pop("alg", self.alg)
        return jwt.encode(claims, self.private_key, algorithm=alg, headers=headers)


def token_claims(user_id: uuid.UUID | str | None = None, **overrides: Any) -> dict[str, Any]:
    """Claims shaped like a Supabase Auth access token; an override of `None` drops the claim."""
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": TEST_ISSUER,
        "aud": TEST_AUDIENCE,
        "sub": str(user_id or uuid.uuid4()),
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "session_id": str(uuid.uuid4()),
    }
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not None}


class FakeJwksEndpoint:
    """httpx transport serving a mutable JWKS; counts requests and can simulate outages."""

    def __init__(self, keys: list[SigningKey]) -> None:
        self.keys = list(keys)
        self.status = 200
        self.error: Exception | None = None
        self.body: Any = None
        self.stream: httpx.AsyncByteStream | None = None
        self.calls = 0
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        assert str(request.url) == TEST_JWKS_URL
        if self.error is not None:
            raise self.error
        if self.stream is not None:
            return httpx.Response(self.status, stream=self.stream)
        body = self.body
        if body is None:
            body = {"keys": [k.public_jwk() for k in self.keys]}
        return httpx.Response(self.status, json=body)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class AuthKit:
    """Helpers handed to tests as a fixture (test modules cannot import conftest)."""

    issuer = TEST_ISSUER
    audience = TEST_AUDIENCE
    jwks_url = TEST_JWKS_URL
    claims = staticmethod(token_claims)
    new_key = staticmethod(SigningKey.generate)


@pytest.fixture
def auth_kit() -> type[AuthKit]:
    return AuthKit


@pytest.fixture
def signing_key() -> SigningKey:
    return SigningKey.generate("ES256")


@pytest.fixture
def jwks_endpoint(signing_key: SigningKey) -> FakeJwksEndpoint:
    return FakeJwksEndpoint([signing_key])


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


VerifierFactory = Callable[..., TokenVerifier]


@pytest.fixture
def make_verifier(jwks_endpoint: FakeJwksEndpoint, clock: FakeClock) -> VerifierFactory:
    def factory(**cache_options: Any) -> TokenVerifier:
        options: dict[str, Any] = {
            "ttl_seconds": 600.0,
            "min_refresh_interval_seconds": 30.0,
            "max_stale_seconds": 3600.0,
            "timeout_seconds": 1.0,
            **cache_options,
        }
        cache = JwksCache(TEST_JWKS_URL, transport=jwks_endpoint.transport, clock=clock, **options)
        return TokenVerifier(cache, issuer=TEST_ISSUER, audience=TEST_AUDIENCE)

    return factory
