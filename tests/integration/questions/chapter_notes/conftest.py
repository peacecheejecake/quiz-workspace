"""Fixtures for the CHNOTE-01 chapter note contract tests (C01-C08).

Lives in its own directory because tests/integration/questions/conftest.py (M4 questions) builds
a different `seed`/`app_client`/`job_worker`; the fixtures here override those for this package.

Builds on the sharing contract stack (tests/integration/sharing/conftest.py, which itself reuses
the M3 stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are not
importable under `--import-mode=importlib`: the production app in-process, local Auth users, the
`quiz_api` DB role, share links / guest sessions / forks, and jobs drained in this process with
APP_ENV=test adapters. Request/response shapes, markers and labels mirror
tests/e2e/fixtures/chapter-notes.ts, whose header lists every CHNOTE.0 assumption (N1-N9); keep
both in sync.

The chapter note feature is ON for this module's app and worker (`WORKER_CHAPTER_NOTES=true` in
the environment while they are built); `off_app` is a second app instance with it off. CHNOTE-B
registers `chapter_note.generate` in the M4 `JobWorker` (as M6.2 did for `question.generate`) and
exposes its dependencies as `JobWorker.chapter_note_deps` whose `llm` is the APP_ENV=test
`ScenarioLLMClient` over tests/fixtures/llm/chapter-note-scenarios.json (N6; it records
`calls` as (marker, LLMRequest)); `note_prompts(token)` reads the prompts of this module's calls
that carry `token`. Until then POST /chapters/{id}/note is not implemented and draining a note
job fails with "JobWorker has no in-process handler for job type chapter_note.generate".

The `postgres` superuser reads `chapter_notes` (version rows, `superseded_at`, `usage`,
`error_code`; docs/architecture.md §5) and `activity_events` for guarantees no API exposes.
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
_spec = importlib.util.spec_from_file_location(
    "_sharing_contract_conftest_chnote", _SHARING_CONFTEST
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

NOTES_ON = {"WORKER_CHAPTER_NOTES": "true"}


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
def note_env() -> Iterator[None]:
    """Feature on while this module's app and worker are built (N9)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in NOTES_ON.items():
            mp.setenv(key, value)
        yield


@pytest.fixture(scope="module")
def job_worker(stack: Any, note_env: None) -> Iterator[Any]:
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
    """The same app with the chapter note feature off (C05 `note-generation-disabled`)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WORKER_CHAPTER_NOTES", "false")
        client = _app(job_worker._names.prefix)
    with client:
        yield client


@pytest.fixture
def note_prompts(job_worker: Any) -> Callable[[str], list[str]]:
    """Prompts (system + user text) of this module's chapter note LLM calls carrying `token`."""

    def prompts(token: str) -> list[str]:
        deps = getattr(job_worker, "chapter_note_deps", None)
        assert deps is not None, "JobWorker exposes no chapter_note_deps (CHNOTE-B)"
        texts = [f"{request.system or ''}\n{request.prompt}" for _, request in deps.llm.calls]
        return [t for t in texts if token in t]

    return prompts


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(_m3.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


@pytest.fixture
def db() -> Callable[..., list[tuple[Any, ...]]]:
    """Superuser reads (see the module docstring)."""
    return admin
