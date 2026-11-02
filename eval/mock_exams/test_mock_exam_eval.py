"""Offline checks of the MOCK-X mock exam evaluation (scripted fake, synthetic fixtures)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from book_core.llm import LLMProviderError
from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM
from book_core.mock_exam import Budget

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mock_exam_eval
from pipeline import generate


def test_the_scripted_dataset_report() -> None:
    report = mock_exam_eval.run()
    s = report["summary"]
    assert (s["cases"], s["requested"], s["accepted"]) == (6, 24, 21)
    assert s["pass_rate"] == pytest.approx(21 / 24, abs=1e-4)
    assert s["skipped"] == {
        "answer_not_in_options": 1,
        "citation_not_in_passage": 1,
        "inverted_answer_mismatch": 1,
    }
    calls = {c["case"]: c["llm_calls"] for c in report["cases"]}
    # MOCK-01-C09 / AC08 call counts: one call per batch, one re-request of the failed items,
    # an unreadable batch of four (or a truncated one of three) answered as two halves.
    assert calls == {
        "paraphrase-6": 1,
        "invert-6": 1,
        "invert-faults": 2,
        "broken-batch": 3,
        "truncated-batch": 3,
        "all-fail": 2,
    }
    assert s["failed_cases"] == 1


def test_the_report_holds_no_question_or_passage_text() -> None:
    report = mock_exam_eval.run()
    text = json.dumps(report, ensure_ascii=False) + mock_exam_eval.markdown(report)
    dataset = mock_exam_eval.load_dataset(mock_exam_eval.DEFAULT_DATASET)
    for case in dataset.cases:
        for item in case.sources:
            assert item.source.stem[:12] not in text
            assert all(o.text not in text for o in item.source.options if len(o.text) > 3)
    assert "증발" not in text
    assert "E2E-MOCK" not in text


def test_the_llm_provider_gets_plain_stems() -> None:
    dataset = mock_exam_eval.load_dataset(mock_exam_eval.DEFAULT_DATASET, with_marker=False)
    assert all("[E2E-MOCK" not in s.source.stem for c in dataset.cases for s in c.sources)


def test_a_small_output_budget_splits_a_case_into_more_calls() -> None:
    dataset = mock_exam_eval.load_dataset(mock_exam_eval.DEFAULT_DATASET)
    case = dataset.cases[0]
    llm = MockExamScenarioLLM(dataset.block)
    tally = generate(case.sources, dataset.passages, llm, budget=Budget(max_output_tokens=800))
    assert (tally.accepted, tally.llm_calls, tally.batches) == (6, 3, 3)


def test_a_provider_outage_skips_every_item_without_a_re_request() -> None:
    dataset = mock_exam_eval.load_dataset(mock_exam_eval.DEFAULT_DATASET)

    class Down:
        model_name = "down"

        def complete(self, request: object, schema: object) -> object:
            raise LLMProviderError("unavailable (test)", kind="unavailable")

    tally = generate(dataset.cases[0].sources, dataset.passages, Down())  # type: ignore[arg-type]
    assert (tally.accepted, tally.llm_calls, tally.re_requested) == (0, 1, 0)
    assert tally.skipped == {"llm_unavailable": 6}
