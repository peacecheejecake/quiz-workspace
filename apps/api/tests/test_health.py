from __future__ import annotations

import asyncio
from collections.abc import Callable

from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.health import NotConfiguredError, ReadinessChecker, get_readiness_checkers
from quiz_api.main import create_app
from quiz_api.settings import Settings

CheckerFactory = Callable[..., ReadinessChecker]


def test_live_returns_ok(client: TestClient) -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_returns_ok_when_all_dependencies_are_healthy(client: TestClient) -> None:
    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {
            "database": {"status": "ok"},
            "redis": {"status": "ok"},
            "qdrant": {"status": "ok"},
        },
    }
    assert response.headers["cache-control"] == "no-store"


def test_ready_returns_503_with_per_dependency_status_when_one_fails(
    make_app: Callable[..., FastAPI], healthy: CheckerFactory, failing: CheckerFactory
) -> None:
    secret_url = "redis://admin:hunter2@redis.internal:6379/0"  # noqa: S105 - fake
    app = make_app(
        [
            healthy("database"),
            failing("redis", ConnectionError(f"cannot connect to {secret_url}")),
            healthy("qdrant"),
        ]
    )
    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {
            "database": {"status": "ok"},
            "redis": {"status": "error"},
            "qdrant": {"status": "ok"},
        },
    }
    assert "hunter2" not in response.text
    assert "redis.internal" not in response.text


def test_ready_reports_timeout_and_not_configured(
    make_app: Callable[..., FastAPI], healthy: CheckerFactory
) -> None:
    async def hang() -> None:
        await asyncio.sleep(5)

    async def unconfigured() -> None:
        raise NotConfiguredError

    app = make_app(
        [
            ReadinessChecker("database", hang),
            ReadinessChecker("redis", unconfigured),
            healthy("qdrant"),
        ]
    )
    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": {"status": "timeout"},
        "redis": {"status": "not_configured"},
        "qdrant": {"status": "ok"},
    }


def test_readiness_checkers_can_be_overridden_by_dependency(
    make_app: Callable[..., FastAPI], failing: CheckerFactory
) -> None:
    app = make_app()
    app.dependency_overrides[get_readiness_checkers] = lambda: [
        failing("database", RuntimeError("down"))
    ]
    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {"database": {"status": "error"}}


def test_default_checkers_report_not_configured_without_settings() -> None:
    app = create_app(Settings.model_construct())
    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {
            "database": {"status": "not_configured"},
            "redis": {"status": "not_configured"},
            "qdrant": {"status": "not_configured"},
        },
    }
