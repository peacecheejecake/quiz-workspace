"""Fixtures for the DOCSUM-01 document summary contract tests (C01-C07).

Builds on the sharing contract stack (tests/integration/sharing/conftest.py, which itself reuses
the M3 stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are not
importable under `--import-mode=importlib`: the production app in-process, local Auth users, the
`quiz_api` DB role, share links / guest sessions / forks, and jobs drained in this process with
APP_ENV=test adapters. Request/response shapes, markers and labels mirror
tests/e2e/fixtures/summary.ts, whose header lists every DOCSUM.0 assumption (D1-D8); keep both in
sync.

The summary feature is ON for this module's app and worker (`WORKER_DOCUMENT_SUMMARY=true` in
the environment while they are built). `worker_with(**env)` builds an extra in-process worker
under other settings (feature off, small input limits) and `off_app` is a second app instance
with the feature off. `WORKER_SUMMARY_HOLD_DIR` points the APP_ENV=test fake summarizer's hold
barrier (D7 `E2E-HOLD-SUMMARY-<token>`) at a per-module temp directory. DOCSUM-B registers
`document.summarize` in the M4 `JobWorker` (as M6.2 did for `question.generate`); until then
draining a summary job fails with "JobWorker has no in-process handler for job type
document.summarize".

The `postgres` superuser reads `document_summary_runs` / `document_summary_units` /
`document_summary_run_units` / `activity_events` (docs/architecture.md §5) for guarantees no API
exposes (one run per revision, supersession, unit reuse, payloads without text).
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
_spec = importlib.util.spec_from_file_location(
    "_sharing_contract_conftest_docsum", _SHARING_CONFTEST
)
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

SUMMARY_ON = {"WORKER_DOCUMENT_SUMMARY": "true"}


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
def summary_env(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Feature on, plus the hold barrier directory of the fake summarizer (D7, C03)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in SUMMARY_ON.items():
            mp.setenv(key, value)
        mp.setenv("WORKER_SUMMARY_HOLD_DIR", str(tmp_path_factory.mktemp("summary-hold")))
        yield


@pytest.fixture(scope="module")
def job_worker(stack: Any, summary_env: None) -> Iterator[Any]:
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
    """The same app with the summary feature off (DOCSUM-01-AC05, C05 `summary-disabled`)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WORKER_DOCUMENT_SUMMARY", "false")
        client = _app(job_worker._names.prefix)
    with client:
        yield client


@pytest.fixture
def worker_with(stack: Any) -> Iterator[Callable[..., Any]]:
    """Builds an extra in-process worker under `env` (e.g. WORKER_DOCUMENT_SUMMARY="false",
    WORKER_SUMMARY_MAX_INPUT_CHARS="500"); settings are read while it is built."""
    built: list[Any] = []

    def build(**env: str) -> Any:
        worker = _sh.ForkJobWorker()
        with pytest.MonkeyPatch.context() as mp:
            for key, value in {**SUMMARY_ON, **env}.items():
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


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(_m3.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


@pytest.fixture
def db() -> Callable[..., list[tuple[Any, ...]]]:
    """Superuser reads (see the module docstring)."""
    return admin
