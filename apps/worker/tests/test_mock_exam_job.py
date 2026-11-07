"""`mock_exam.generate` wiring (MOCK-B): registration, the APP_ENV=test fake, the MOCK_EXAM_*
budget/time-limit check. The pipeline itself runs against the real stack in
tests/integration/questions/mock_exams (MOCK-01-C02..C09)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM
from pydantic import ValidationError
from quiz_worker.celery_app import default_definitions
from quiz_worker.errors import JobError
from quiz_worker.mock_exam_job import budget_from_settings, build_mock_exam_llm
from quiz_worker.mock_exam_store import JOB_TYPE
from quiz_worker.settings import Environment, WorkerSettings, mock_exam_budget_problem


def test_the_job_is_registered() -> None:
    settings = WorkerSettings(APP_ENV=Environment.TEST)  # type: ignore[call-arg]
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}


def test_the_feature_is_off_by_default_with_the_documented_budgets() -> None:
    settings = WorkerSettings(APP_ENV=Environment.TEST)  # type: ignore[call-arg]
    assert settings.mock_exams is False
    budget = budget_from_settings(settings)
    assert (budget.max_prompt_tokens, budget.max_output_tokens, budget.sources_per_call) == (
        60_000,
        16_000,
        40,
    )
    assert settings.mock_exam_generation_concurrency == 2
    assert budget.items_per_call == 40


def test_the_test_llm_is_the_batched_fake(tmp_path: Path) -> None:
    settings = WorkerSettings(
        APP_ENV=Environment.TEST,
        WORKER_MOCK_EXAMS=True,
        WORKER_MOCK_EXAM_FAULT_DIR=str(tmp_path),
    )  # type: ignore[call-arg]
    assert isinstance(build_mock_exam_llm(settings), MockExamScenarioLLM)


def test_budgets_over_the_model_or_the_time_limit_are_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = {
        "prompt_tokens": 60_000,
        "output_tokens": 16_000,
        "sources_per_call": 40,
        "concurrency": 2,
        "context_tokens": 200_000,
        "max_tokens": 16_000,
        "call_timeout_seconds": 120,
        "task_soft_time_limit_seconds": 1500,
    }
    assert mock_exam_budget_problem(**base) is None
    assert "LLM_CONTEXT_TOKENS" in str(
        mock_exam_budget_problem(**{**base, "context_tokens": 70_000})
    )
    assert "LLM_MAX_TOKENS" in str(mock_exam_budget_problem(**{**base, "max_tokens": 8_000}))
    slow = {**base, "sources_per_call": 1, "concurrency": 1}
    assert "SOFT_TIME_LIMIT" in str(mock_exam_budget_problem(**slow))
    monkeypatch.setenv("LLM_MAX_TOKENS", "8000")
    WorkerSettings(APP_ENV=Environment.TEST)  # type: ignore[call-arg]  # the feature is off
    with pytest.raises(ValidationError, match="LLM_MAX_TOKENS"):
        WorkerSettings(APP_ENV=Environment.TEST, WORKER_MOCK_EXAMS=True)  # type: ignore[call-arg]


def test_the_real_provider_gets_the_mock_exam_output_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex P2: the provider's max_tokens is MOCK_EXAM_MAX_OUTPUT_TOKENS, not LLM_MAX_TOKENS."""
    import book_core.llm as llm

    seen: list[Any] = []

    def capture(config: Any) -> object:
        seen.append(config)
        return object()

    monkeypatch.setattr(llm, "create_llm_client", capture)
    monkeypatch.setenv("LLM_API_KEY", "sk-test-not-a-key")
    monkeypatch.setenv("LLM_MODEL", "model-a")
    monkeypatch.setenv("LLM_MAX_TOKENS", "16000")
    settings = WorkerSettings(
        APP_ENV=Environment.LOCAL,
        WORKER_MOCK_EXAMS=True,
        MOCK_EXAM_MAX_OUTPUT_TOKENS=8000,
    )  # type: ignore[call-arg]
    build_mock_exam_llm(settings)
    assert [c.max_tokens for c in seen] == [8000]


def _run_fake_pipeline(
    *, concurrency: int, fail_first: bool = False
) -> tuple[list[int], list[int]]:
    import threading
    import time
    from types import SimpleNamespace

    from quiz_worker.mock_exam_job import _Pipeline, _Task

    lock = threading.Lock()
    running = 0
    at_start: list[int] = []
    settled: list[int] = []

    def call(task: Any) -> Any:
        nonlocal running
        with lock:
            at_start.append(running)
            running += 1
        try:
            time.sleep(0.03)
        finally:
            with lock:
                running -= 1
        err = fail_first and task.positions == (0,)
        return SimpleNamespace(task=task, provider_error=ValueError("x") if err else None)

    def settle(answer: Any) -> list[Any]:
        settled.extend(answer.task.positions)
        return []

    fake = SimpleNamespace(
        deps=SimpleNamespace(concurrency=concurrency),
        ctx=SimpleNamespace(check_cancelled=lambda: None),
        _call=call,
        _settle=settle,
    )
    tasks = [_Task((i,), False) for i in range(5)]
    try:
        _Pipeline._run(fake, tasks)  # type: ignore[arg-type]
    except JobError:
        settled.append(-1)  # the provider error surfaced
    return at_start, settled


def test_mock_exam_the_first_call_runs_alone_then_the_rest_overlap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import quiz_worker.mock_exam_job as job

    monkeypatch.setattr(job, "_provider_error", lambda exc: JobError("x"))
    at_start, settled = _run_fake_pipeline(concurrency=3)
    assert at_start[0] == 0
    assert at_start[1] == 0  # the second call starts only after the first finished
    assert max(at_start) > 0
    assert sorted(settled) == [0, 1, 2, 3, 4]


def test_mock_exam_a_failed_first_call_keeps_the_existing_error_handling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import quiz_worker.mock_exam_job as job

    monkeypatch.setattr(job, "_provider_error", lambda exc: JobError("x"))
    at_start, settled = _run_fake_pipeline(concurrency=3, fail_first=True)
    assert settled == [-1]
    assert at_start == [0]  # nothing else was started after the failed first call
