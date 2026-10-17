from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from quiz_worker.envelope import JobEnvelope
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore

# Synthetic stand-ins for data that must never reach logs or `last_error`.
TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"  # noqa: S105 - fake JWT
BOOK_TEXT = "Chapter 7 synthetic passage: the quick brown fox jumps over the lazy dog"
WORKSPACE_ID = UUID("00000000-0000-4000-8000-000000000001")

EnvelopeFactory = Callable[..., JobEnvelope]


class FakeClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def store(clock: FakeClock) -> InMemoryJobStore:
    return InMemoryJobStore(clock=clock)


@pytest.fixture
def make_envelope() -> EnvelopeFactory:
    def factory(
        job_type: str = "echo",
        payload: dict[str, Any] | None = None,
        *,
        schema_version: int = 1,
        idempotency_key: str | None = None,
        workspace_id: UUID = WORKSPACE_ID,
        job_id: UUID | None = None,
    ) -> JobEnvelope:
        return JobEnvelope(
            job_id=job_id or uuid4(),
            job_type=job_type,
            schema_version=schema_version,
            idempotency_key=idempotency_key or f"key-{uuid4().hex}",
            workspace_id=workspace_id,
            payload=payload if payload is not None else {"message": BOOK_TEXT},
        )

    return factory


@pytest.fixture
def eager_settings() -> WorkerSettings:
    # model_construct: defaults only, independent of the developer's env / .env.
    return WorkerSettings.model_construct(task_always_eager=True)
