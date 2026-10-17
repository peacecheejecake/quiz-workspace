from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
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
