"""Offline checks of the ASK-X AI question and explanation evaluation (scripted fake)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from book_core.ask import ASK_FIELDS_FORBIDDEN_IN_HINT
from book_core.llm import LLMProviderError
from book_core.llm.streaming import FakeTextStreamClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ask_eval


def test_the_scripted_dataset_report() -> None:
    report = ask_eval.run()
    s = report["summary"]
    assert (s["ask_cases"], s["answers"], s["explain_cases"]) == (18, 14, 6)
    # 24 raw footnote tags in the answers, two of them unknown ([S9] and [S7]) in one answer.
    assert (s["citation_tags"], s["answers_with_dropped_tags"]) == (24, 1)
    assert s["citation_valid_rate"] == pytest.approx(22 / 24, abs=1e-4)
    assert s["uncited_answers"] == 1
    assert (s["cited_paragraphs"], s["support_rate"]) == (22, pytest.approx(19 / 22, abs=1e-4))
    # 3 of 4 not-found cases are refused, 1 of 14 answerable cases is refused wrongly.
    assert (s["not_found_correct"], s["false_refusals"]) == (3, 1)
    assert s["not_found_accuracy"] == pytest.approx(16 / 18, abs=1e-4)
    assert (s["hint_cases"], s["hint_leaked"]) == (6, 2)
    assert s["hint_leaks_by_attachment"] == {
        "registered": {"cases": 3, "leaked": 1},
        "mock_exam": {"cases": 3, "leaked": 1},
    }
    assert s["explain_answer_agreement"] == pytest.approx(5 / 6, abs=1e-4)
    assert (s["explain_valid_first"], s["explain_valid_final"]) == (
        pytest.approx(4 / 6, abs=1e-4),
        pytest.approx(5 / 6, abs=1e-4),
    )
    assert s["explain_re_requests"] == 1
    assert s["explain_errors"] == {"explanation_answer_mismatch": 1}
    assert s["llm_calls"] == 25
    assert s["usage"]["input_tokens"] > 0
    assert s["usage"]["output_tokens"] > 0
    assert s["usage"]["cost_usd"] is None


def test_the_report_holds_no_question_passage_or_answer_text() -> None:
    report = ask_eval.run()
    text = json.dumps(report, ensure_ascii=False) + ask_eval.markdown(report)
    dataset = ask_eval.load_dataset(ask_eval.DEFAULT_DATASET)
    for case in dataset.ask_cases:
        assert case["question"] not in text
        assert case["script"][:20] not in text
    for source in dataset.passages.values():
        assert source.text[:20] not in text
    assert "증발" not in text


def test_hint_requests_carry_no_answer_field() -> None:
    dataset = ask_eval.load_dataset(ask_eval.DEFAULT_DATASET)
    hints = [c for c in dataset.ask_cases if c["kind"] == "hint"]
    assert {c["attachment"] for c in hints} == {"registered", "mock_exam"}
    for case in hints:
        attachment = ask_eval.hint_attachment(case)
        fields = set(attachment.__dataclass_fields__)
        assert not fields & set(ASK_FIELDS_FORBIDDEN_IN_HINT)
        assert not any(o.selected for o in attachment.options)


@pytest.mark.parametrize(
    ("answer", "leaked"),
    [
        ("그러므로 정답은 2번입니다.", True),
        ("2번이 정답이다.", True),
        ("답은 2번이다.", True),
        ("응결이 정답입니다.", True),
        ("최종 답을 말하면 응결이다.", True),
        ("응결은 수증기가 물방울이 되는 과정이라고 한 구절을 확인해 보세요. [1]", False),
        ("보기 2번의 응결과 1번의 증발을 비교해 보세요.", False),
    ],
)
def test_the_leak_patterns(answer: str, leaked: bool) -> None:
    assert ask_eval.leaks(answer, 2, "응결") is leaked


def test_support_is_lexical_containment() -> None:
    passage = "원수에 응집제를 넣고 천천히 저으면 작은 입자들이 서로 달라붙어 덩어리가 된다."
    assert ask_eval.supported("응집제를 넣고 저으면 작은 입자들이 달라붙는다.", passage)
    assert not ask_eval.supported("전기 요금은 월 평균 3천만 원이다.", passage)


def test_the_llm_provider_gets_the_same_requests_without_scripts() -> None:
    client = FakeTextStreamClient(["[NO_ANSWER] 답할 수 없습니다."])
    report = ask_eval.run(provider="llm", client=client)
    # Every request is built by the product's builders; none reads a script.
    assert client.calls
    assert report["provider"] == "llm"
    assert all(c.task in {"ask.answer", "question.ai_explain", "eval.judge"} for c in client.calls)
    assert sum(1 for c in client.calls if c.task == "ask.answer") == 18


def test_a_provider_outage_is_not_swallowed() -> None:
    client = FakeTextStreamClient(error=LLMProviderError("unavailable (test)", kind="unavailable"))
    with pytest.raises(LLMProviderError):
        ask_eval.run(client=client)
