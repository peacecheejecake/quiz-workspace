"""Each worker job reads its own LLM route (LLM-ROUTE)."""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from typing import Any

import pytest
from book_core.llm import LLMConfig
from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.ask_job import ask_deps, build_ask_llm
from quiz_worker.chapter_note_job import build_chapter_note_llm
from quiz_worker.explain_job import build_explainer, explain_deps
from quiz_worker.mock_exam_job import build_mock_exam_llm
from quiz_worker.question_import_job import build_llm
from quiz_worker.settings import WorkerSettings
from quiz_worker.summary_job import build_summarizer

BUILDERS: list[tuple[str, Callable[[WorkerSettings], Any], dict[str, str]]] = [
    ("QUESTION_IMPORT", build_llm, {"WORKER_QUESTION_IMPORT_LLM": "true"}),
    ("DOCUMENT_SUMMARY", build_summarizer, {}),
    ("CHAPTER_NOTES", build_chapter_note_llm, {}),
    ("MOCK_EXAMS", build_mock_exam_llm, {}),
    ("ASK", build_ask_llm, {}),
    ("AI_EXPLANATIONS", build_explainer, {}),
]


@pytest.mark.parametrize(("route", "build", "extra"), BUILDERS)
def test_each_job_reads_its_route(
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    build: Callable[[WorkerSettings], Any],
    extra: dict[str, str],
) -> None:
    monkeypatch.setenv("APP_ENV", "local")
    for name, value in extra.items():
        monkeypatch.setenv(name, value)
    seen: list[str | None] = []

    def spy(env: Any = None, *, route: str | None = None) -> None:
        seen.append(route)
        return None

    monkeypatch.setattr(LLMConfig, "from_env", spy)
    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]
    with contextlib.suppress(WorkerNotConfiguredError):  # question import needs an LLM
        build(settings)
    assert seen == [route]


def test_ask_effort_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_EFFORT_ASK", raising=False)
    monkeypatch.setenv("ASK_LLM_EFFORT", "medium")
    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]
    assert ask_deps(settings, object()).effort == "medium"
    monkeypatch.setenv("LLM_EFFORT_ASK", "high")
    assert ask_deps(settings, object()).effort == "high"


def test_explain_effort_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_EFFORT_AI_EXPLANATIONS", raising=False)
    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]
    assert explain_deps(settings, object()).effort == "low"
    monkeypatch.setenv("LLM_EFFORT_AI_EXPLANATIONS", "high")
    assert explain_deps(settings, object()).effort == "high"


def test_invalid_route_effort_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_EFFORT_ASK", "turbo")
    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]
    with pytest.raises(WorkerNotConfiguredError):
        ask_deps(settings, object())
