"""S4: fault injection, fake adapters and the scripted LLM exist for APP_ENV=test only.

The E2E failure markers (`E2E-FAIL-…`, `E2E-FORK-PAUSE`) must be inert outside APP_ENV=test,
the scripted LLM must never answer in another environment, and a deployed worker refuses the
fake parser/embedder outright (implementation-plan §7: no test-only paths in production).
"""

from __future__ import annotations

from typing import Any

import pytest
from book_core.llm.scenarios import ScenarioLLMClient
from pydantic import ValidationError
from quiz_worker import fork_job, question_import_job
from quiz_worker.question_generation_job import build_generation_llm
from quiz_worker.settings import WorkerSettings

BASE = {
    "WORKER_DATABASE_URL": "postgresql://worker:pw@127.0.0.1:1/x",
    "SUPABASE_URL": "https://project.supabase.co",
    "SUPABASE_SECRET_KEY": "sb_secret_s4",
    "QDRANT_URL": "http://127.0.0.1:1",
}


def _settings(env: str, **extra: Any) -> WorkerSettings:
    return WorkerSettings.model_validate({"APP_ENV": env, **BASE, **extra})


@pytest.fixture(autouse=True)
def _no_models(monkeypatch: pytest.MonkeyPatch) -> None:
    # The index store would load embedding weights; it is irrelevant to these flags.
    monkeypatch.setattr(fork_job, "build_index_store", lambda settings: object())
    for name in ("LLM_API_KEY", "LLM_MODEL", "LLM_PROVIDER"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("env", ["local", "preview", "production"])
def test_failure_markers_are_inert_outside_app_env_test(env: str) -> None:
    settings = _settings(env)
    assert fork_job.deps_from_settings(settings).inject_failures is False
    assert question_import_job.deps_from_settings(settings).inject_failures is False
    assert not isinstance(build_generation_llm(settings), ScenarioLLMClient)


def test_app_env_test_is_the_only_switch() -> None:
    settings = _settings("test")
    assert fork_job.deps_from_settings(settings).inject_failures is True
    assert question_import_job.deps_from_settings(settings).inject_failures is True
    assert isinstance(build_generation_llm(settings), ScenarioLLMClient)


@pytest.mark.parametrize("env", ["preview", "production"])
@pytest.mark.parametrize("fake", [{"WORKER_PARSER": "fake"}, {"WORKER_EMBEDDER": "fake"}])
def test_deployed_workers_refuse_fake_adapters(env: str, fake: dict[str, str]) -> None:
    with pytest.raises(ValidationError, match="local and test runs only"):
        _settings(env, **fake)
