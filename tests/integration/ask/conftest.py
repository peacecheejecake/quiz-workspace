"""Fixtures for the ASK-01 AI question contract tests (C01-C11).

Lives in its own directory because the other integration packages build their own
`seed`/`app_client`/`job_worker`; the fixtures here override those for this package.

Builds on the sharing contract stack (tests/integration/sharing/conftest.py, which itself reuses
the M3 stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are not
importable under `--import-mode=importlib`: the production app in-process, local Auth users, the
`quiz_api` DB role, share links / guest sessions / forks, and jobs drained in this process with
APP_ENV=test adapters. Request/response shapes, markers and labels mirror
tests/e2e/fixtures/ask.ts, whose header lists every ASK.0 assumption (Q1-Q9); keep both in sync.

The AI question feature is ON for this module's app and worker (`WORKER_ASK_LLM=true` in the
environment while they are built). `off_app` is a second app with it off and `limits_app` one
with small limits (ASK_MAX_TURNS=2, ASK_RATE_LIMIT_PER_MINUTE=3, ASK_MAX_REGENERATIONS=2,
ASK_TOP_K=2, ASK_MAX_CONTEXT_CHARS=600, ASK_MAX_QUESTION_CHARS=50); `app_with(**env)` builds more
(daily limit, monthly token cap); all share the database. `WORKER_ASK_FAKE_LOG_DIR` and
`WORKER_ASK_HOLD_DIR` point the fake's call record (Q8) and hold barrier (Q7) at per-module temp
directories.

ASK-B registers `ask.answer` (and the `ask.purge` beat task) in the M4 `JobWorker` (as MOCK-B
did for `mock_exam.generate`) and exposes their dependencies as `JobWorker.ask_deps`, whose `llm`
is the APP_ENV=test streaming fake (ASK-01-C11): it records `calls` as (markers, request) — the
request being the exact `book_core.ask.build_request` output the provider would get — and
`ask_deps.purge(now)` runs one `ask.purge` pass. The 202 of POST …/messages (Q4) also carries the
answer's `job_id` so a test can drain it here. Until ASK-B the ask routes are missing (404) and
draining an ask job fails with "JobWorker has no in-process handler for job type ask.answer".

The `postgres` superuser reads `ask_conversations` / `ask_messages` / `ask_message_sources` /
`ask_message_feedback` / `llm_feature_usage` / `activity_events` (docs/architecture.md §5) for
guarantees no API exposes (no copied passage text, usage rows, append-only, purge).
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

_SHARING_CONFTEST = Path(__file__).resolve().parents[1] / "sharing" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_sharing_contract_conftest_ask", _SHARING_CONFTEST)
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

ASK_ON = {"WORKER_ASK_LLM": "true"}
SMALL_LIMITS = {
    "ASK_MAX_TURNS": "2",
    "ASK_RATE_LIMIT_PER_MINUTE": "3",
    "ASK_MAX_REGENERATIONS": "2",
    "ASK_TOP_K": "2",
    "ASK_MAX_CONTEXT_CHARS": "600",
    "ASK_MAX_QUESTION_CHARS": "50",
}


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
def ask_env(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Path]]:
    """Feature on, plus the fake's record and hold directories (Q7, Q8)."""
    dirs = {
        "log": tmp_path_factory.mktemp("ask-fake-log"),
        "hold": tmp_path_factory.mktemp("ask-hold"),
    }
    with pytest.MonkeyPatch.context() as mp:
        for key, value in ASK_ON.items():
            mp.setenv(key, value)
        mp.setenv("WORKER_ASK_FAKE_LOG_DIR", str(dirs["log"]))
        mp.setenv("WORKER_ASK_HOLD_DIR", str(dirs["hold"]))
        yield dirs


@pytest.fixture(scope="module")
def job_worker(stack: Any, ask_env: dict[str, Path]) -> Iterator[Any]:
    worker = _sh.ForkJobWorker()
    try:
        yield worker
    finally:
        worker.join()
        worker.close()


@pytest.fixture(scope="module")
def app_client(stack: Any, job_worker: Any) -> Iterator[TestClient]:
    with _app(job_worker._names.prefix) as client:
        yield client


@pytest.fixture(scope="module")
def off_app(stack: Any, job_worker: Any) -> Iterator[TestClient]:
    """The same app with the AI question feature off (ASK-01-AC08, `ask-disabled`)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WORKER_ASK_LLM", "false")
        client = _app(job_worker._names.prefix)
    with client:
        yield client


@pytest.fixture(scope="module")
def limits_app(stack: Any, job_worker: Any) -> Iterator[TestClient]:
    """The same app with SMALL_LIMITS (C06)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in SMALL_LIMITS.items():
            mp.setenv(key, value)
        client = _app(job_worker._names.prefix)
    with client:
        yield client


@pytest.fixture
def app_with(stack: Any, job_worker: Any) -> Iterator[Callable[..., TestClient]]:
    """Builds an extra app under `env` (e.g. ASK_DAILY_LIMIT_PER_USER="2")."""
    built: list[TestClient] = []

    def build(**env: str) -> TestClient:
        with pytest.MonkeyPatch.context() as mp:
            for key, value in env.items():
                mp.setenv(key, value)
            client = _app(job_worker._names.prefix)
        client.__enter__()
        built.append(client)
        return client

    try:
        yield build
    finally:
        for client in built:
            client.__exit__(None, None, None)


@pytest.fixture
def worker_with(stack: Any, ask_env: dict[str, Path]) -> Iterator[Callable[..., Any]]:
    """Builds an extra in-process worker under `env` (e.g. ASK_MAX_OUTPUT_TOKENS="300",
    LLM_MAX_RETRIES="2"); settings are read while it is built."""
    built: list[Any] = []

    def build(**env: str) -> Any:
        worker = _sh.ForkJobWorker()
        with pytest.MonkeyPatch.context() as mp:
            for key, value in {**ASK_ON, **env}.items():
                mp.setenv(key, value)
            worker._build()
        built.append(worker)
        return worker

    try:
        yield build
    finally:
        for worker in built:
            worker.join()
            worker.close()


def fake_llm(worker: Any) -> Any:
    """The streaming fake of `worker` (ASK-01-C11)."""
    deps = getattr(worker, "ask_deps", None)
    assert deps is not None, "JobWorker exposes no ask_deps (ASK-B)"
    return deps.llm


@pytest.fixture
def fake() -> Callable[[Any], Any]:
    return fake_llm


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(_m3.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


@pytest.fixture
def db() -> Callable[..., list[tuple[Any, ...]]]:
    """Superuser reads (see the module docstring)."""
    return admin
