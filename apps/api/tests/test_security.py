"""A3: CORS allowlist, Origin guard, security headers and deployed-config guards."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from quiz_api.health import ReadinessChecker
from quiz_api.main import create_app
from quiz_api.settings import (
    LOCAL_CORS_ORIGINS,
    Environment,
    InsecureConfigurationError,
    Settings,
)

WEB = "https://app.example.com"
EVIL = "https://evil.example"


async def _ok() -> None:
    return None


def _app(**overrides: Any) -> FastAPI:
    settings = Settings.model_construct(readiness_timeout_seconds=0.2, **overrides)
    return create_app(settings, readiness_checkers=[ReadinessChecker("database", _ok)])


@pytest.fixture
def web_client() -> Iterator[TestClient]:
    with TestClient(_app(cors_allowed_origins=(WEB,))) as client:
        yield client


def _preflight(client: TestClient, origin: str, method: str = "POST") -> Any:
    return client.options(
        "/api/v1/me",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
    )


# --- CORS ------------------------------------------------------------------------------------


def test_preflight_from_allowlisted_origin_is_answered(web_client: TestClient) -> None:
    response = _preflight(web_client, WEB)

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == WEB
    assert "access-control-allow-credentials" not in response.headers
    assert response.headers["access-control-max-age"] == "600"
    allowed = response.headers["access-control-allow-headers"].lower()
    assert {"authorization", "content-type", "idempotency-key"} <= set(allowed.split(", "))


def test_preflight_from_unknown_origin_is_rejected(web_client: TestClient) -> None:
    response = _preflight(web_client, EVIL)

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["content-type"] == "application/problem+json"


@pytest.mark.parametrize("origin", [EVIL, "null", "https://app.example.com.evil.example"])
def test_actual_request_from_unknown_origin_is_rejected_before_the_route(
    web_client: TestClient, origin: str
) -> None:
    # Without a guard the route would run (and only the browser would hide the response).
    response = web_client.post("/api/v1/workspaces", headers={"Origin": origin}, json={})

    assert response.status_code == 403
    assert response.json()["detail"] == "Origin not allowed."
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"


def test_allowlisted_origin_reaches_the_route_with_cors_headers(web_client: TestClient) -> None:
    response = web_client.get("/api/v1/me", headers={"Origin": WEB})

    assert response.status_code == 503  # verifier not configured: past the guard, at the route
    assert response.headers["access-control-allow-origin"] == WEB
    assert "x-request-id" in response.headers["access-control-expose-headers"].lower()


def test_requests_without_origin_are_not_affected(web_client: TestClient) -> None:
    # Server-to-server calls (the Next.js server) send no Origin.
    assert web_client.get("/health/live").status_code == 200


def test_same_origin_requests_are_allowed(web_client: TestClient) -> None:
    response = web_client.get("/health/live", headers={"Origin": "http://testserver"})
    assert response.status_code == 200


def test_local_defaults_allow_the_dev_web_server_on_both_loopback_names() -> None:
    with TestClient(_app()) as client:
        for origin in LOCAL_CORS_ORIGINS:
            response = _preflight(client, origin, "GET")
            assert response.headers["access-control-allow-origin"] == origin
        assert _preflight(client, "http://127.0.0.1:3001").status_code == 403


# --- Security headers ------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/health/live", "/api/v1/me", "/api/v1/nope"])
def test_every_response_carries_security_headers(web_client: TestClient, path: str) -> None:
    response = web_client.get(path)

    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"
    csp = response.headers["content-security-policy"]
    assert csp == "default-src 'none'; frame-ancestors 'none'"
    assert "server" not in response.headers
    assert "strict-transport-security" not in response.headers  # plain http, local


def test_hsts_is_sent_in_production_and_over_https() -> None:
    production = _app(
        app_env=Environment.PRODUCTION,
        cors_allowed_origins=(WEB,),
        supabase_jwt_issuer="https://proj.supabase.co/auth/v1",
        supabase_jwks_url="https://proj.supabase.co/auth/v1/.well-known/jwks.json",
    )
    with TestClient(production) as client:
        assert "max-age=" in client.get("/health/live").headers["strict-transport-security"]
    with TestClient(_app(), base_url="https://api.local") as client:
        assert "strict-transport-security" in client.get("/health/live").headers


def test_unhandled_errors_also_carry_security_headers() -> None:
    app = _app()

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("boom")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_docs_page_keeps_working_without_the_api_csp() -> None:
    with TestClient(_app()) as client:
        response = client.get("/api/v1/docs")
    assert response.status_code == 200
    assert "content-security-policy" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"


# --- Settings guards -------------------------------------------------------------------------

SECURE_PROD = {
    "APP_ENV": "production",
    "SUPABASE_JWT_ISSUER": "https://proj.supabase.co/auth/v1",
    "SUPABASE_JWKS_URL": "https://proj.supabase.co/auth/v1/.well-known/jwks.json",
    "CORS_ALLOWED_ORIGINS": "https://app.example.com, https://preview.example.com/",
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> pytest.MonkeyPatch:
    # No developer `.env`, no inherited values.
    monkeypatch.chdir(tmp_path)
    for name in (*SECURE_PROD, "CORS_MAX_AGE_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _settings(env: pytest.MonkeyPatch, **values: str) -> Settings:
    for name, value in values.items():
        env.setenv(name, value)
    return Settings().ensure_secure_deployment()


def test_secure_production_config_is_accepted(env: pytest.MonkeyPatch) -> None:
    settings = _settings(env, **SECURE_PROD)

    assert settings.effective_cors_origins == (
        "https://app.example.com",
        "https://preview.example.com",
    )
    assert settings.is_deployed


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"SUPABASE_JWT_ISSUER": "http://proj.supabase.co/auth/v1"}, "SUPABASE_JWT_ISSUER must be"),
        ({"SUPABASE_JWKS_URL": "http://x/jwks.json"}, "SUPABASE_JWKS_URL must be an https"),
        ({"SUPABASE_JWKS_URL": ""}, "SUPABASE_JWKS_URL is required"),
        ({"CORS_ALLOWED_ORIGINS": ""}, "CORS_ALLOWED_ORIGINS must list"),
        ({"CORS_ALLOWED_ORIGINS": "http://app.example.com"}, "only https:// origins"),
    ],
)
def test_insecure_deployed_config_refuses_to_start(
    env: pytest.MonkeyPatch, override: dict[str, str], message: str
) -> None:
    for app_env in ("production", "preview"):
        with pytest.raises(InsecureConfigurationError, match=message):
            _settings(env, **{**SECURE_PROD, "APP_ENV": app_env, **override})


def test_create_app_refuses_an_insecure_deployed_config() -> None:
    settings = Settings.model_construct(app_env=Environment.PRODUCTION)
    with pytest.raises(InsecureConfigurationError, match="CORS_ALLOWED_ORIGINS must list"):
        create_app(settings)


@pytest.mark.parametrize(
    ("origins", "message"),
    [
        ("*", "wildcard origin"),
        ("https://*.example.com", "no wildcard or path"),
        ("https://app.example.com/path", "no wildcard or path"),
        ("ftp://app.example.com", "http\\(s\\)://host"),
    ],
)
def test_malformed_origins_are_refused(env: pytest.MonkeyPatch, origins: str, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        _settings(env, **{**SECURE_PROD, "CORS_ALLOWED_ORIGINS": origins})


def test_wildcard_origin_is_refused_locally_too(env: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="wildcard origin"):
        _settings(env, CORS_ALLOWED_ORIGINS="http://127.0.0.1:3000,*")


def test_local_config_may_use_http_and_defaults(env: pytest.MonkeyPatch) -> None:
    settings = _settings(env)
    assert settings.effective_cors_origins == LOCAL_CORS_ORIGINS
    assert not settings.is_deployed
    custom = _settings(env, CORS_ALLOWED_ORIGINS="HTTP://127.0.0.1:3160/")
    assert custom.effective_cors_origins == ("http://127.0.0.1:3160",)


def test_preflight_cache_is_bounded(env: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match=r"CORS_MAX_AGE_SECONDS|cors_max_age"):
        _settings(env, CORS_MAX_AGE_SECONDS="86400")


def test_error_never_echoes_configured_values(env: pytest.MonkeyPatch) -> None:
    secret_looking = "http://user:hunter2@proj.supabase.co/auth/v1"  # noqa: S105 - fake
    env.setenv("DATABASE_URL", "postgresql://u:db-hunter2@db/postgres")
    with pytest.raises(InsecureConfigurationError) as info:
        _settings(env, **{**SECURE_PROD, "SUPABASE_JWT_ISSUER": secret_looking})
    assert "hunter2" not in str(info.value)


# --- Origin serialization (the browser's `Origin` header form) -------------------------------


@pytest.mark.parametrize(
    ("configured", "serialized"),
    [
        ("https://app.example.com:443", "https://app.example.com"),
        ("http://127.0.0.1:80/", "http://127.0.0.1"),
        ("https://app.example.com:80", "https://app.example.com:80"),
        ("HTTPS://APP.Example.COM", "https://app.example.com"),
        ("http://[::1]:3000", "http://[::1]:3000"),
        ("http://[::1]:80", "http://[::1]"),
        ("https://Bücher.example", "https://xn--bcher-kva.example"),
    ],
)
def test_configured_origins_use_browser_serialization(
    env: pytest.MonkeyPatch, configured: str, serialized: str
) -> None:
    assert _settings(env, CORS_ALLOWED_ORIGINS=configured).effective_cors_origins == (serialized,)


def test_non_numeric_port_is_refused(env: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="numeric port"):
        _settings(env, CORS_ALLOWED_ORIGINS="https://app.example.com:abc")


@pytest.mark.parametrize(
    ("configured", "sent"),
    [
        ("https://app.example.com:443", "https://app.example.com"),
        ("http://[::1]:3000", "http://[::1]:3000"),
        ("https://bücher.example", "https://xn--bcher-kva.example"),
        ("https://app.example.com", "HTTPS://APP.EXAMPLE.COM"),
    ],
)
def test_guard_and_cors_match_the_browser_origin(
    env: pytest.MonkeyPatch, configured: str, sent: str
) -> None:
    settings = _settings(env, CORS_ALLOWED_ORIGINS=configured)
    with TestClient(create_app(settings, readiness_checkers=[])) as client:
        guarded = client.post("/api/v1/nope", headers={"Origin": sent})
        assert guarded.status_code == 404  # past the guard
        preflight = _preflight(client, sent.lower() if sent.isascii() else sent)
        assert preflight.status_code == 200


def test_same_origin_check_ignores_default_ports_and_keeps_ipv6(web_client: TestClient) -> None:
    def call(origin: str, host: str) -> int:
        response = web_client.get("/health/live", headers={"Origin": origin, "Host": host})
        return int(response.status_code)

    assert call("http://testserver", "testserver:80") == 200
    assert call("http://[::1]:8000", "[::1]:8000") == 200
    assert call("http://[::1]:8001", "[::1]:8000") == 403
    assert call("http://testserver:8080", "testserver") == 403
