"""Marker-selected scripted LLM (M6.0): the generation scenarios QGEN-01 E2E/contract tests use."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from book_core.generation import LLMVariantBatch
from book_core.llm import FakeLLMNotScriptedError, LLMClient, LLMOutputError, LLMRequest
from book_core.llm.scenarios import ScenarioLLMClient

SCENARIOS = Path(__file__).resolve().parents[3] / "tests/fixtures/llm/generation-scenarios.json"
BOOK_TRUTH = Path(__file__).resolve().parents[3] / "tests/fixtures/pdfs/book-ko.truth.json"
TASKS = (
    "questions.generate.paraphrase",
    "questions.generate.invert_polarity",
    "questions.generate.analogous_concept",
)


# The fixture's outputs follow the real M6.1 schema (aligned in M6.2).
_Output = LLMVariantBatch


def _sources() -> dict[str, dict[str, Any]]:
    sources: dict[str, dict[str, Any]] = json.loads(SCENARIOS.read_text(encoding="utf-8"))[
        "sources"
    ]
    return sources


def _request(task: str, marker: str | None, stem: str = "원본 문제") -> LLMRequest:
    tagged = f"{stem} [{marker}]" if marker else stem
    return LLMRequest(task=task, prompt_version=f"{task}/v1", prompt=f"원본: {tagged}")


def test_client_satisfies_the_llm_protocol() -> None:
    assert isinstance(ScenarioLLMClient.from_file(SCENARIOS), LLMClient)


def test_ok_scenario_answers_each_scripted_task_with_a_schema_valid_candidate() -> None:
    client = ScenarioLLMClient.from_file(SCENARIOS)
    stem = str(_sources()["disinfection"]["stem"])
    for task in ("questions.generate.paraphrase", "questions.generate.analogous_concept"):
        result = client.complete(_request(task, "E2E-LLM-OK", stem), _Output)
        [candidate] = result.output.candidates
        labels = [o.label for o in candidate.options]
        assert candidate.correct_option_labels
        assert set(candidate.correct_option_labels) <= set(labels)
        assert candidate.citations
        assert candidate.stem != stem
        assert result.info.model == client.model_name
    assert [m for m, _ in client.calls] == ["E2E-LLM-OK", "E2E-LLM-OK"]


def test_every_evidence_quote_occurs_verbatim_in_the_source_page() -> None:
    truth = json.loads(BOOK_TRUTH.read_text(encoding="utf-8"))
    page_text = " ".join(
        b["text"] for b in truth["blocks"] if any(p["page"] == 4 for p in b.get("parts", []))
    )
    client = ScenarioLLMClient.from_file(SCENARIOS)
    scripted = [
        ("E2E-LLM-OK", "questions.generate.paraphrase"),
        ("E2E-LLM-OK", "questions.generate.analogous_concept"),
        ("E2E-LLM-INVERT-MULTI", "questions.generate.invert_polarity"),
        ("E2E-LLM-BATCH", "questions.generate.paraphrase"),
    ]
    for marker, task in scripted:
        output = client.generate(_request(task, marker), _Output)
        for candidate in output.candidates:
            for citation in candidate.citations:
                assert citation.quote in page_text, (marker, task)


def test_invert_multi_keeps_the_options_so_three_statements_become_correct() -> None:
    source = _sources()["not-correct"]
    client = ScenarioLLMClient.from_file(SCENARIOS)
    output = client.generate(
        _request("questions.generate.invert_polarity", "E2E-LLM-INVERT-MULTI"), _Output
    )
    [candidate] = output.candidates
    assert [o.text for o in candidate.options] == [o["text"] for o in source["options"]]
    correct = {o["text"] for o in source["options"] if o["id"] in source["correct_option_ids"]}
    inverted = [o for o in candidate.options if o.text not in correct]
    assert len(inverted) == 3
    # The model still declares one answer: the validator must not trust it (questions.md §5).
    assert candidate.multi_select is False
    assert candidate.correct_option_labels is not None
    assert len(candidate.correct_option_labels) == 1


@pytest.mark.parametrize("marker", ["E2E-LLM-MALFORMED", "E2E-LLM-SCHEMA-INVALID"])
@pytest.mark.parametrize("task", TASKS)
def test_invalid_scenarios_raise_a_sanitised_output_error(marker: str, task: str) -> None:
    client = ScenarioLLMClient.from_file(SCENARIOS)
    with pytest.raises(LLMOutputError) as caught:
        client.complete(_request(task, marker), _Output)
    assert "정수장" not in str(caught.value)


def test_unscripted_requests_fail_loudly() -> None:
    client = ScenarioLLMClient.from_file(SCENARIOS)
    with pytest.raises(FakeLLMNotScriptedError, match="found: none"):
        client.complete(_request("questions.generate.paraphrase", None), _Output)
    with pytest.raises(FakeLLMNotScriptedError, match="invert_polarity"):
        client.complete(_request("questions.generate.invert_polarity", "E2E-LLM-OK"), _Output)
    both = LLMRequest(
        task="questions.generate.paraphrase",
        prompt_version="v1",
        prompt="[E2E-LLM-OK] [E2E-LLM-MALFORMED]",
    )
    with pytest.raises(FakeLLMNotScriptedError, match="E2E-LLM-MALFORMED, E2E-LLM-OK"):
        client.complete(both, _Output)


def test_markers_are_unique_and_never_contain_each_other() -> None:
    scenarios = {"marker": "E2E-LLM-OK", "responses": {}}
    with pytest.raises(ValueError, match="unique"):
        ScenarioLLMClient.from_mapping({"schema_version": 1, "scenarios": [scenarios, scenarios]})
    nested = [scenarios, {"marker": "E2E-LLM-OK-2", "responses": {}}]
    with pytest.raises(ValueError, match="part of"):
        ScenarioLLMClient.from_mapping({"schema_version": 1, "scenarios": nested})


def test_every_source_names_a_declared_scenario() -> None:
    markers = set(ScenarioLLMClient.from_file(SCENARIOS).markers)
    for name, source in _sources().items():
        assert source["marker"] in markers, name
        ids = [o["id"] for o in source["options"]]
        assert set(source["correct_option_ids"]) <= set(ids), name
