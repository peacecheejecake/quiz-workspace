"""Offline checks of the ASK-X AI question and explanation evaluation (scripted fake)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from book_core.ask import ASK_FIELDS_FORBIDDEN_IN_HINT
from book_core.llm import LLMProviderError
from book_core.llm.streaming import FakeTextStreamClient, TextDelta, TextStreamEnd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ask_eval


def test_the_scripted_dataset_report() -> None:
    report = ask_eval.run()
    s = report["summary"]
    assert (s["ask_cases"], s["answers"], s["explain_cases"]) == (21, 17, 6)
    # 27 raw footnote tags in the answers, two of them unknown ([S9] and [S7]) in one answer.
    assert (s["citation_tags"], s["answers_with_dropped_tags"]) == (27, 1)
    assert s["citation_valid_rate"] == pytest.approx(25 / 27, abs=1e-4)
    assert s["uncited_answers"] == 1
    assert (s["cited_paragraphs"], s["support_rate"]) == (25, pytest.approx(21 / 25, abs=1e-4))
    # 3 of 4 not-found cases are refused, 1 of 17 answerable cases is refused wrongly.
    assert (s["not_found_correct"], s["false_refusals"]) == (3, 1)
    assert s["not_found_accuracy"] == pytest.approx(19 / 21, abs=1e-4)
    assert (s["hint_cases"], s["hint_leaked"]) == (9, 2)
    assert s["hint_leaks_by_attachment"] == {
        "registered": {"cases": 5, "leaked": 1},
        "mock_exam": {"cases": 4, "leaked": 1},
    }
    assert s["explain_answer_agreement"] == pytest.approx(5 / 6, abs=1e-4)
    assert (s["explain_valid_first"], s["explain_valid_final"]) == (
        pytest.approx(4 / 6, abs=1e-4),
        pytest.approx(5 / 6, abs=1e-4),
    )
    assert s["explain_re_requests"] == 1
    assert s["explain_errors"] == {"explanation_answer_mismatch": 1}
    assert s["llm_calls"] == 28
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
        ("응결은 수증기가 물방울이 되는 과정이라고 한 구절을 확인해 보세요. [1]", False),
        ("보기 2번의 응결과 1번의 증발을 비교해 보세요.", False),
        ("정답은 알려드릴 수 없습니다. 구절을 확인해 보세요.", False),
        ("최종 답을 직접 알려주지는 않겠습니다.", False),
        ("2번이 정답인지는 말씀드릴 수 없고 스스로 찾아보셔야 합니다.", False),
        ("정답은 스스로 찾아보세요.", False),
        ("정답: 응결", True),
        ("정답은 2번이라고 알려드릴게요.", True),
        ("정답은 2번이며 다른 가능성은 없습니다.", True),
        ("최종 답을 말하면 응결이다.", False),  # a paraphrase only the judge catches
    ],
)
def test_the_leak_patterns(answer: str, leaked: bool) -> None:
    assert ask_eval.leaks(answer, 2, "응결") is leaked


@pytest.mark.parametrize(
    ("answer", "leaked"),
    [
        ("정답은 2번이라고 알려드릴게요.", True),
        ("정답은 2번이며 다른 가능성은 없습니다.", True),
        ("정답은 알려드릴 수 없습니다.", False),
        ("최종 답을 직접 알려주지는 않겠습니다.", False),
        ("2번이 정답은 아닙니다.", False),
        ("응결이 정답이라고 말할 수 없습니다.", False),
        ("2번이 정답인지는 말씀드릴 수 없고 스스로 찾아보셔야 합니다.", False),
        ("최종 답을 말하면 응결이다.", False),  # a paraphrase only the judge catches
    ],
    ids=lambda v: v if isinstance(v, str) else str(v),
)
def test_review_regression_table(answer: str, leaked: bool) -> None:
    """Every sentence the Codex reviews raised, correct option 2 / 응결."""
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
    assert sum(1 for c in client.calls if c.task == "ask.answer") == 21


def test_the_judge_catches_a_paraphrase_the_regex_misses() -> None:
    case = {
        "id": "paraphrase",
        "kind": "hint",
        "attachment": "registered",
        "question": "답이 뭐죠?",
        "sources": [],
        "mcq": {
            "stem": "수증기가 물방울이 되는 과정은?",
            "options": ["증발", "응결"],
            "correct": 2,
        },
    }
    dataset = ask_eval.load_dataset(ask_eval.DEFAULT_DATASET)

    def answer(verdict: str | None) -> dict[str, Any]:
        class Client:
            model_name = "x"

            def stream_text(self, request):  # type: ignore[no-untyped-def]
                text = verdict if request.task == "eval.judge" else "최종 답을 말하면 응결이다."
                end = TextStreamEnd(model="x", stop_reason="end_turn")
                return iter([TextDelta(text or ""), end])

        meter = ask_eval.Meter(Client())
        return ask_eval.run_ask_case(dataset, case, meter, use_judge=verdict is not None)

    offline = answer(None)
    assert (offline["regex_leak"], offline["leaked"]) == (False, False)
    judged = answer("YES")
    assert (judged["regex_leak"], judged["leaked"]) == (False, True)


def test_a_provider_outage_is_not_swallowed() -> None:
    client = FakeTextStreamClient(error=LLMProviderError("unavailable (test)", kind="unavailable"))
    with pytest.raises(LLMProviderError):
        ask_eval.run(client=client)


def test_the_judge_confirms_a_nominated_leak_and_can_clear_it() -> None:
    class Judged(ask_eval.ScriptedClient):
        def __init__(self, dataset: ask_eval.Dataset, verdict: str) -> None:
            super().__init__(dataset)
            self.verdict = verdict
            self.judged = 0

        def stream_text(self, request):  # type: ignore[no-untyped-def]
            if request.task != "eval.judge":
                return super().stream_text(request)
            self.judged += 1
            return iter(
                [
                    TextDelta(self.verdict),
                    TextStreamEnd(model="judge", stop_reason="end_turn"),
                ]
            )

    dataset = ask_eval.load_dataset(ask_eval.DEFAULT_DATASET)
    for verdict, leaked in (("YES", 9), ("NO", 0)):
        client = Judged(dataset, verdict)
        report = ask_eval.run(provider="llm", client=client)
        s = report["summary"]
        assert s["hint_leaked"] == leaked
        # Judge calls count in calls and usage but never in the first-text timing.
        assert s["judge_calls"] == client.judged > 0
        assert s["llm_calls"] == s["generation_calls"] + s["judge_calls"]
        assert s["first_text_ms"]["count"] == s["generation_calls"]
        assert s["judge_first_text_ms"]["count"] == s["judge_calls"]
        # The judge reads every hint answer and decides: YES on the 7 regex-clean answers (a
        # paraphrase the patterns miss) is a leak, NO on the 2 regex hits is not. The regex result
        # stays in the report as a diagnostic.
        hints = [e for e in report["ask"] if e["kind"] == "hint"]
        assert sum(1 for e in hints if "judge_leak" in e) == 9
        assert sum(1 for e in hints if e["regex_leak"]) == 2
