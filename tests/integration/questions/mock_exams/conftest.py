"""Fixtures for the MOCK-01 mock exam contract tests (C01-C09).

Lives in its own directory because tests/integration/questions/conftest.py (M4 questions) builds
a different `seed`/`app_client`/`job_worker`; the fixtures here override those for this package.

Builds on the sharing contract stack (tests/integration/sharing/conftest.py, which itself reuses
the M3 stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are not
importable under `--import-mode=importlib`: the production app in-process, local Auth users, the
`quiz_api` DB role, share links / guest sessions / forks, and jobs drained in this process with
APP_ENV=test adapters. Request/response shapes, markers and labels mirror
tests/e2e/fixtures/mock-exams.ts, whose header lists every MOCK.0 assumption (K1-K9); keep both
in sync.

The mock exam feature is ON for this module's app and worker (`WORKER_MOCK_EXAMS=true` in the
environment while they are built); `off_app` is a second app instance with it off. MOCK-B
registers `mock_exam.generate` in the M4 `JobWorker` (as CHNOTE-B did for `chapter_note.generate`)
and exposes its dependencies as `JobWorker.mock_exam_deps`, whose `llm` is the APP_ENV=test
batched scenario fake over the `mock_exam` block of tests/fixtures/llm/generation-scenarios.json
(K5): it records `calls` as (markers, LLMRequest) and `max_in_flight` (the most calls it was
answering at once). Until then POST /workspaces/{id}/mock-exams is not implemented and draining a
mock exam job fails with "JobWorker has no in-process handler for job type mock_exam.generate".

Two more workers drain jobs with other settings (they read the same database, so any worker can
run any job): `tight_worker` (MOCK_EXAM_MAX_PROMPT_TOKENS=4000, C09-5) and `serial_worker`
(MOCK_EXAM_GENERATION_CONCURRENCY=1, C09-6/7). The `postgres` superuser reads the mock exam
tables (generation items, revisions, attempts; docs/architecture.md §5) and `activity_events`
for guarantees no API exposes.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from quiz_api.main import create_app
from quiz_api.settings import Settings

_SHARING_CONFTEST = Path(__file__).resolve().parents[2] / "sharing" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_sharing_contract_conftest_mock", _SHARING_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_sh = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _sh  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_sh)
_m3 = _sh._m3

# Re-exported fixtures (pytest collects fixtures from conftest attributes). `seed` requests
# `app_client` and `job_worker` by name and gets this module's versions below.
stack = _sh.stack
seed = _sh.seed

MOCK_ON = {"WORKER_MOCK_EXAMS": "true"}


def _app(prefix: str) -> TestClient:
    settings = Settings(
        DATABASE_URL=_m3.API_DATABASE_URL,
        SUPABASE_JWT_ISSUER=_m3.ISSUER,
        SUPABASE_JWKS_URL=_m3.JWKS_URL,
        APP_ENV="test",
        QDRANT_COLLECTION_PREFIX=prefix,
        WORKER_EMBEDDER="auto",
    )
    return TestClient(create_app(settings, readiness_checkers=[]), raise_server_exceptions=False)


@pytest.fixture(scope="module")
def mock_env() -> Iterator[None]:
    """Feature on while this module's app and worker are built (K8)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in MOCK_ON.items():
            mp.setenv(key, value)
        yield


def _worker(extra: dict[str, str]) -> Any:
    """A worker built (eagerly) with `extra` in the environment on top of MOCK_ON."""
    worker = _sh.ForkJobWorker()
    with pytest.MonkeyPatch.context() as mp:
        for key, value in {**MOCK_ON, **extra}.items():
            mp.setenv(key, value)
        worker._build()
    return worker


@pytest.fixture(scope="module")
def job_worker(stack: Any, mock_env: None) -> Iterator[Any]:
    worker = _sh.ForkJobWorker()
    try:
        yield worker
    finally:
        worker.join()
        worker.close()


@pytest.fixture(scope="module")
def tight_worker(stack: Any, job_worker: Any) -> Iterator[Any]:
    """C09-5: an input budget small enough for one oversized source to exceed it."""
    worker = _worker({"MOCK_EXAM_MAX_PROMPT_TOKENS": "4000"})
    try:
        yield worker
    finally:
        worker.close()


@pytest.fixture(scope="module")
def serial_worker(stack: Any, job_worker: Any) -> Iterator[Any]:
    """C09-6/7: one batch at a time, so a crash lands after the first batch's checkpoint."""
    worker = _worker({"MOCK_EXAM_GENERATION_CONCURRENCY": "1"})
    try:
        yield worker
    finally:
        worker.close()


@pytest.fixture(scope="module")
def app_client(stack: Any, job_worker: Any) -> Iterator[TestClient]:
    with _app(job_worker._names.prefix) as client:
        yield client


@pytest.fixture(scope="module")
def off_app(stack: Any, job_worker: Any) -> Iterator[TestClient]:
    """The same app with the mock exam feature off (C05 `mock-llm-disabled`, K8)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WORKER_MOCK_EXAMS", "false")
        client = _app(job_worker._names.prefix)
    with client:
        yield client


def fake_llm(worker: Any) -> Any:
    """The batched scenario fake of `worker` (K5)."""
    deps = getattr(worker, "mock_exam_deps", None)
    assert deps is not None, "JobWorker exposes no mock_exam_deps (MOCK-B)"
    return deps.llm


@pytest.fixture
def llm_calls() -> Callable[[Any], list[str]]:
    """Prompts (system + user text) of every call `worker`'s fake has answered so far."""

    def calls(worker: Any) -> list[str]:
        if getattr(worker, "mock_exam_deps", None) is None:
            return []  # before MOCK-B: no call yet; the request then fails on the missing route
        return [
            f"{request.system or ''}\n{request.prompt}" for _, request in fake_llm(worker).calls
        ]

    return calls


@pytest.fixture
def max_in_flight() -> Callable[[Any], int]:
    def peak(worker: Any) -> int:
        return int(fake_llm(worker).max_in_flight)

    return peak


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(_m3.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


@pytest.fixture
def db() -> Callable[..., list[tuple[Any, ...]]]:
    """Superuser reads (see the module docstring)."""
    return admin
