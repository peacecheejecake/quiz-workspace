"""Liveness and readiness endpoints (docs/deployment.md §7).

Readiness runs every dependency checker concurrently, each bounded by a timeout. The
response only carries dependency names and coarse statuses: never URLs, hosts or exception
text, which could contain credentials.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import text

from quiz_api.db import Database
from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

CheckFn = Callable[[], Awaitable[None]]


class NotConfiguredError(RuntimeError):
    """The dependency has no connection settings."""


@dataclass(frozen=True)
class ReadinessChecker:
    """A named async probe; it raises on failure and returns `None` when healthy."""

    name: str
    check: CheckFn


class CheckStatus(StrEnum):
    OK = "ok"
    ERROR = "error"
    TIMEOUT = "timeout"
    NOT_CONFIGURED = "not_configured"


class DependencyStatus(BaseModel):
    status: CheckStatus


class LivenessReport(BaseModel):
    status: Literal["ok"]


class ReadinessReport(BaseModel):
    status: Literal["ok", "unavailable"]
    checks: dict[str, DependencyStatus]


async def _run_check(checker: ReadinessChecker, timeout_seconds: float) -> CheckStatus:
    try:
        async with asyncio.timeout(timeout_seconds):
            await checker.check()
    except NotConfiguredError:
        return CheckStatus.NOT_CONFIGURED
    except TimeoutError:
        logger.warning("Readiness check %s timed out after %.1fs", checker.name, timeout_seconds)
        return CheckStatus.TIMEOUT
    except Exception as exc:
        # Exception text may include connection strings; log the type only.
        logger.warning("Readiness check %s failed: %s", checker.name, type(exc).__name__)
        return CheckStatus.ERROR
    return CheckStatus.OK


async def run_readiness(
    checkers: Sequence[ReadinessChecker], timeout_seconds: float
) -> ReadinessReport:
    statuses = await asyncio.gather(*(_run_check(c, timeout_seconds) for c in checkers))
    checks = {c.name: DependencyStatus(status=s) for c, s in zip(checkers, statuses, strict=True)}
    healthy = all(s is CheckStatus.OK for s in statuses)
    return ReadinessReport(status="ok" if healthy else "unavailable", checks=checks)


# --- Default checkers ---------------------------------------------------------------------


def database_checker(database: Database | None) -> ReadinessChecker:
    def ping() -> None:
        if database is None:
            raise NotConfiguredError
        with database.engine.connect() as conn:
            conn.execute(text("SELECT 1"))

    async def check() -> None:
        await asyncio.to_thread(ping)

    return ReadinessChecker("database", check)


def redis_checker(settings: Settings) -> ReadinessChecker:
    async def check() -> None:
        if settings.redis_url is None:
            raise NotConfiguredError
        from redis.asyncio import Redis

        timeout = settings.readiness_timeout_seconds
        client = Redis.from_url(
            settings.redis_url.get_secret_value(),
            socket_timeout=timeout,
            socket_connect_timeout=timeout,
        )
        try:
            await client.ping()
        finally:
            await client.aclose()

    return ReadinessChecker("redis", check)


def qdrant_checker(settings: Settings) -> ReadinessChecker:
    """Probe Qdrant's REST API. `GET /collections` also validates the API key."""

    async def check() -> None:
        if settings.qdrant_url is None:
            raise NotConfiguredError
        headers = {}
        if settings.qdrant_api_key is not None:
            headers["api-key"] = settings.qdrant_api_key.get_secret_value()
        async with httpx.AsyncClient(
            base_url=settings.qdrant_url,
            headers=headers,
            timeout=settings.readiness_timeout_seconds,
        ) as client:
            response = await client.get("/collections")
            response.raise_for_status()

    return ReadinessChecker("qdrant", check)


def default_readiness_checkers(
    settings: Settings, database: Database | None
) -> list[ReadinessChecker]:
    return [database_checker(database), redis_checker(settings), qdrant_checker(settings)]


# --- Routes ---------------------------------------------------------------------------------


def get_readiness_checkers(request: Request) -> Sequence[ReadinessChecker]:
    """Dependency so tests (or later tasks) can override the checker set."""
    checkers: Sequence[ReadinessChecker] = request.app.state.readiness_checkers
    return checkers


def get_readiness_timeout(request: Request) -> float:
    settings: Settings = request.app.state.settings
    return settings.readiness_timeout_seconds


router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live", operation_id="getLiveness")
async def live() -> LivenessReport:
    """Process is up. Never touches external dependencies."""
    return LivenessReport(status="ok")


@router.get(
    "/ready",
    operation_id="getReadiness",
    responses={503: {"model": ReadinessReport, "description": "A dependency is not ready."}},
)
async def ready(
    response: Response,
    checkers: Annotated[Sequence[ReadinessChecker], Depends(get_readiness_checkers)],
    timeout_seconds: Annotated[float, Depends(get_readiness_timeout)],
) -> ReadinessReport:
    """All required dependencies (DB, Redis, Qdrant) answer within the timeout."""
    report = await run_readiness(checkers, timeout_seconds)
    if report.status != "ok":
        response.status_code = 503
    response.headers["Cache-Control"] = "no-store"
    return report
