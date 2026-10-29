"""DOCSUM-B: the API offers summaries only with the switch on and a provider configured
(DOCSUM-01-AC05). Routes and the authorization matrix are covered by the infra contract tests
(tests/integration/documents/summary)."""

from __future__ import annotations

import pytest
from quiz_api.errors import ProblemType
from quiz_api.settings import Settings


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, False),
        ({"WORKER_DOCUMENT_SUMMARY": "true"}, False),
        ({"WORKER_DOCUMENT_SUMMARY": "true", "LLM_MODEL": " "}, False),
        ({"WORKER_DOCUMENT_SUMMARY": "true", "LLM_MODEL": "model-x"}, True),
        ({"WORKER_DOCUMENT_SUMMARY": "true", "APP_ENV": "test"}, True),
        ({"WORKER_DOCUMENT_SUMMARY": "false", "LLM_MODEL": "model-x"}, False),
    ],
)
def test_docsum_01_ac05_available_needs_the_switch_and_a_provider(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], expected: bool
) -> None:
    for name in ("WORKER_DOCUMENT_SUMMARY", "LLM_MODEL", "APP_ENV", "LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.summary_available is expected


def test_docsum_b_problem_types_are_part_of_the_contract() -> None:
    assert ProblemType.SUMMARY_DISABLED.value.endswith(":summary-disabled")
    assert ProblemType.SUMMARY_NOT_APPLICABLE.value.endswith(":summary-not-applicable")
    assert ProblemType.SUMMARY_NOT_FAILED.value.endswith(":summary-not-failed")
