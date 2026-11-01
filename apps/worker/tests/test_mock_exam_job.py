"""`mock_exam.generate` wiring (MOCK-B): registration, the APP_ENV=test fake, the MOCK_EXAM_*
budget/time-limit check. The pipeline itself runs against the real stack in
tests/integration/questions/mock_exams (MOCK-01-C02..C09)."""

from __future__ import annotations

from pathlib import Path

import pytest
from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM
from pydantic import ValidationError
from quiz_worker.celery_app import default_definitions
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
