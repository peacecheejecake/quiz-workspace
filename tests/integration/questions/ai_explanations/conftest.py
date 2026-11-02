"""Fixtures for the AIEXPL-01 AI explanation contract tests (C01-C09).

Lives in its own directory because tests/integration/questions/conftest.py (M4 questions) builds
a different `seed`/`app_client`/`job_worker`; the fixtures here override those for this package
(the same layout as mock_exams/).

Builds on the sharing contract stack (tests/integration/sharing/conftest.py, which reuses the M3
stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are not
importable under `--import-mode=importlib`: the production app in-process, local Auth users, the
`quiz_api` DB role, share links / guest sessions / forks, and jobs drained in this process with
APP_ENV=test adapters. Request/response shapes, markers and labels mirror
tests/e2e/fixtures/ai-explanations.ts, whose header lists every EXPL.0 assumption (E1-E9); keep
both in sync.

The AI explanation feature (and the mock exams it explains, C09) is ON for this module's app and
worker (`WORKER_AI_EXPLANATIONS=true`, `WORKER_MOCK_EXAMS=true` while they are built and while the
tests run); `off_app` is a second app instance with AI explanations off (C02
`explanation-disabled`). The fake explainer's call log and hold barrier use per-module
directories (`WORKER_ASK_FAKE_LOG_DIR`, `WORKER_ASK_HOLD_DIR`, E6/E7). EXPL-B registers the
explanation job (`question.ai_explain`, mock kind included) in the M4 `JobWorker` (as MOCK-B did for
`mock_exam.generate`) and exposes its dependencies as `JobWorker.explain_deps`, whose `llm` is the
APP_ENV=test fake explainer recording `calls` as (markers, LLMRequest) like the mock exam fake
(K5). Until then the AI explanation routes are not implemented and every test fails on the first
request ("… not implemented (404)").

The `postgres` superuser reads `question_ai_explanations`, `mock_exam_question_ai_explanations`,
`llm_feature_usage`, `jobs` and `activity_events` for guarantees no API exposes.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from quiz_api.main import create_app
from quiz_api.settings import Settings

_SHARING_CONFTEST = Path(__file__).resolve().parents[2] / "sharing" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_sharing_contract_conftest_expl", _SHARING_CONFTEST)
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

_LOG_DIR = Path(tempfile.mkdtemp(prefix="it-expl-calls-"))
_HOLD_DIR = Path(tempfile.mkdtemp(prefix="it-expl-hold-"))
EXPL_ON = {
    "WORKER_AI_EXPLANATIONS": "true",
    "WORKER_MOCK_EXAMS": "true",
    "WORKER_ASK_FAKE_LOG_DIR": str(_LOG_DIR),
    "WORKER_ASK_HOLD_DIR": str(_HOLD_DIR),
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
def expl_env() -> Iterator[None]:
    """Feature on (and the fake's directories set) for the whole module (E6-E8)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in EXPL_ON.items():
            mp.setenv(key, value)
        yield


@pytest.fixture(scope="module")
def job_worker(stack: Any, expl_env: None) -> Iterator[Any]:
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
    """The same app with AI explanations off (C02 `explanation-disabled`)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WORKER_AI_EXPLANATIONS", "false")
        client = _app(job_worker._names.prefix)
    with client:
        yield client


@pytest.fixture
def calls() -> Callable[[str], int]:
    """LLM calls the fake explainer answered for a question / mock exam question id (E6)."""

    def count(target_id: str) -> int:
        folder = _LOG_DIR / "ai_explanation" / target_id
        return len(list(folder.glob("*.json"))) if folder.is_dir() else 0

    return count


@pytest.fixture
def hold_dir() -> Path:
    """The fake's hold barrier directory (E7): `<token>.held` / `<token>.release`."""
    return _HOLD_DIR


@pytest.fixture
def prompts() -> Callable[[Any], list[str]]:
    """Prompts (system + user text) of every call the in-process fake explainer answered."""

    def read(worker: Any) -> list[str]:
        deps = getattr(worker, "explain_deps", None)
        if deps is None:
            return []  # before EXPL-B: no call yet; the request then fails on the missing route
        return [f"{request.system or ''}\n{request.prompt}" for _, request in deps.llm.calls]

    return read


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(_m3.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


@pytest.fixture
def db() -> Callable[..., list[tuple[Any, ...]]]:
    """Superuser reads (see the module docstring)."""
    return admin
