"""book_core.notes: citation validation, the single re-request, batching and merge (CHNOTE-01
C02, C04) with the deterministic fake LLM, plus a seeded property test that no stored item ever
cites a question outside the input."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

import pytest
from book_core.llm import FakeLLMClient, LLMOutputError, LLMProviderError, LLMRequest, LLMResult
from book_core.llm.scenarios import ScenarioLLMClient
from book_core.notes import (
    MAX_BATCH_CHARS,
    MAX_BATCH_QUESTIONS,
    PROMPT_VERSION,
    TASK,
    ChapterNoteGenerator,
    LLMNoteOutput,
    NoteCitationError,
    NoteOption,
    NoteQuestion,
    NoteRequest,
    build_request,
    check_response,
    plan_batches,
    question_size,
)
from pydantic import BaseModel

REPO = Path(__file__).resolve().parents[3]
SCENARIOS = REPO / "tests" / "fixtures" / "llm" / "chapter-note-scenarios.json"
REFERENCE = "물이 에너지를 얻어 수증기가 된다. 이 과정을 증발이라고 한다.\n응결은 그 반대이다."


def q(n: int, marker: str = "", explanation: str | None = None) -> NoteQuestion:
    return NoteQuestion(
        tag=f"Q{n}",
        label=f"1장 {n}번",
        question_type="MCQ",
        stem=f"문제 {n}{f' [{marker}]' if marker else ''}",
        options=(NoteOption("가", True), NoteOption("나", False)),
        explanation=explanation if explanation is not None else f"해설 {n}",
    )


def item(text: str, tags: list[str], quote: str | None = None) -> dict[str, Any]:
    return {"text": text, "tags": tags, "quote": quote}


def output(*items: dict[str, Any], heading: str = "h") -> dict[str, Any]:
    return {"sections": [{"heading": heading, "items": list(items)}]}


def texts(result: Any) -> list[str]:
    return [i.text for s in result.sections for i in s.items]


class SequenceLLM:
    """Answers each call with the next scripted response (a mapping or a raw string)."""

    def __init__(self, *responses: Any) -> None:
        self._responses = list(responses)
        self.requests: list[LLMRequest] = []
        self._fake = FakeLLMClient("seq")

    @property
    def model_name(self) -> str:
        return "seq"

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        self.requests.append(request)
        response = self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]
        self._fake.script(request.task, response)
        return self._fake.complete(request, schema)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


# --- validation ---------------------------------------------------------------------------------


def test_valid_items_are_kept_in_order() -> None:
    checked = check_response(
        LLMNoteOutput.model_validate(
            output(item("a", ["Q1"]), item("b", ["Q2", "Q1", "Q2"]), item("c", ["Q1"], "증발"))
        ),
        ["Q1", "Q2"],
        REFERENCE,
    )
    assert not checked.reject
    assert checked.dropped == 0
    assert [(i.text, i.tags) for i in checked.sections[0].items] == [
        ("a", ("Q1",)),
        ("b", ("Q2", "Q1")),
        ("c", ("Q1",)),
    ]


@pytest.mark.parametrize(
    ("bad", "reject", "code"),
    [
        (item("x", ["Q99"]), True, "unknown_question_tag"),
        (item("x", ["Q1", "Q3"]), True, "unknown_question_tag"),
        (item("x", ["Q1"], "달 표면에서만 일어난다"), True, "quote_not_in_reference"),
        (item("x", ["Q1"], "   "), True, "quote_not_in_reference"),
        (item("x", []), False, "item_without_citation"),
        (item("  ", ["Q1"]), False, "empty_item"),
    ],
)
def test_invalid_items_are_dropped_and_some_reject(
    bad: dict[str, Any], reject: bool, code: str
) -> None:
    checked = check_response(
        LLMNoteOutput.model_validate(output(item("ok", ["Q1"]), bad)), ["Q1", "Q2"], REFERENCE
    )
    assert checked.reject is reject
    assert checked.dropped == 1
    assert code in checked.codes
    assert [i.text for s in checked.sections for i in s.items] == ["ok"]


def test_quotes_ignore_whitespace_and_width_but_not_words() -> None:
    known = ["Q1"]
    spaced = LLMNoteOutput.model_validate(output(item("a", ["Q1"], "이 과정을  증발이라고\n한다.")))
    assert not check_response(spaced, known, REFERENCE).reject
    changed = LLMNoteOutput.model_validate(output(item("a", ["Q1"], "이 과정을 응결이라고 한다.")))
    assert check_response(changed, known, REFERENCE).reject


# --- generator ----------------------------------------------------------------------------------


def test_a_rejected_response_is_requested_once_more_then_invalid_items_are_dropped() -> None:
    mixed = output(item("A", ["Q1"]), item("Q99", ["Q99"]), item("NOTAG", []), item("B", ["Q2"]))
    llm = SequenceLLM(mixed)
    result = ChapterNoteGenerator(llm).generate(NoteRequest((q(1), q(2)), REFERENCE))
    assert len(llm.requests) == 2
    assert llm.requests[0] == llm.requests[1]
    assert texts(result) == ["A", "B"]
    assert (result.usage.llm_calls, result.usage.items, result.usage.dropped_items) == (2, 2, 2)
    assert result.prompt_version == PROMPT_VERSION
    assert "unknown_question_tag" in result.rejected_codes


def test_the_second_response_is_used_when_it_is_valid() -> None:
    llm = SequenceLLM(output(item("bad", ["Q7"])), output(item("good", ["Q1"])))
    result = ChapterNoteGenerator(llm).generate(NoteRequest((q(1),), REFERENCE))
    assert texts(result) == ["good"]
    assert (result.usage.llm_calls, result.usage.dropped_items) == (2, 0)


def test_a_valid_response_is_not_requested_again() -> None:
    llm = SequenceLLM(output(item("a", ["Q1"]), item("notag", [])))
    result = ChapterNoteGenerator(llm).generate(NoteRequest((q(1),), REFERENCE))
    assert len(llm.requests) == 1, "an item without a tag is dropped, not re-requested"
    assert (texts(result), result.usage.dropped_items) == (["a"], 1)


def test_no_surviving_item_is_a_citation_error() -> None:
    llm = SequenceLLM(output(item("x", ["Q99"]), item("y", [])))
    with pytest.raises(NoteCitationError) as caught:
        ChapterNoteGenerator(llm).generate(NoteRequest((q(1), q(2)), REFERENCE))
    assert caught.value.code == "note_citation_invalid"
    assert len(llm.requests) == 2


def test_malformed_output_and_provider_errors_propagate() -> None:
    with pytest.raises(LLMOutputError):
        ChapterNoteGenerator(SequenceLLM('{"sections": [')).generate(
            NoteRequest((q(1),), REFERENCE)
        )
    failing = FakeLLMClient()
    failing.script(TASK, LLMProviderError("down", kind="timeout"))
    with pytest.raises(LLMProviderError):
        ChapterNoteGenerator(failing).generate(NoteRequest((q(1),), REFERENCE))


def test_the_prompt_carries_the_questions_tags_answers_and_reference() -> None:
    request = build_request((q(1, explanation="해설-하나"), q(2)), REFERENCE)
    assert request.task == TASK
    assert request.prompt_version == PROMPT_VERSION
    assert "[Q1] 1장 1번" in request.prompt
    assert "[Q2] 1장 2번" in request.prompt
    assert "가 (correct)" in request.prompt
    assert "해설-하나" in request.prompt
    assert "이 과정을 증발이라고 한다." in request.prompt
    assert "Valid tags: Q1, Q2" in request.prompt


def test_an_essay_model_answer_is_part_of_the_prompt() -> None:
    essay = NoteQuestion(
        tag="Q1",
        label="1장 1번",
        question_type="ESSAY",
        stem="서술하시오",
        rubric="모범 답안-증발",
    )
    prompt = build_request((essay,), REFERENCE).prompt
    assert "Model answer / grading criteria (채점 기준): 모범 답안-증발" in prompt
    assert question_size(essay) > question_size(
        NoteQuestion(tag="Q1", label="1장 1번", question_type="ESSAY", stem="서술하시오")
    )


def test_cancellation_check_runs_before_each_call() -> None:
    class StopError(Exception):
        pass

    def check() -> None:
        raise StopError

    llm = SequenceLLM(output(item("a", ["Q1"])))
    with pytest.raises(StopError):
        ChapterNoteGenerator(llm).generate(NoteRequest((q(1),), REFERENCE), check=check)
    assert llm.requests == []


# --- batching and merge (C04, N10) --------------------------------------------------------------


def test_plan_batches_respects_both_limits_with_the_fewest_contiguous_batches() -> None:
    assert plan_batches([]) == []
    assert plan_batches([10] * 240) == [range(0, 120), range(120, 240)]
    assert plan_batches([10] * 121) == [range(0, 120), range(120, 121)]
    assert plan_batches([7_100] * 10) == [range(0, 8), range(8, 10)]
    # A question over the character limit is a batch of its own.
    assert plan_batches([10, MAX_BATCH_CHARS + 5, 10]) == [range(0, 1), range(1, 2), range(2, 3)]
    rng = random.Random(7)  # noqa: S311 - deterministic test data
    sizes = [rng.randint(1, 9_000) for _ in range(500)]
    batches = plan_batches(sizes)
    assert [i for b in batches for i in b] == list(range(500))
    for batch in batches:
        assert len(batch) <= MAX_BATCH_QUESTIONS
        assert len(batch) == 1 or sum(sizes[i] for i in batch) <= MAX_BATCH_CHARS


def test_large_chapters_are_merged_by_heading_with_chapter_wide_tags() -> None:
    questions = tuple(q(n, "E2E-NOTE-OK") for n in range(1, 241))
    llm = ScenarioLLMClient.from_file(SCENARIOS)
    progress: list[tuple[int, int]] = []
    result = ChapterNoteGenerator(llm).generate(
        NoteRequest(questions, REFERENCE), progress=lambda d, t: progress.append((d, t))
    )
    assert progress == [(1, 2), (2, 2)]
    assert result.usage.batches == 2
    assert result.usage.llm_calls == 2
    assert [s.heading for s in result.sections] == ["핵심 개념", "정리"]
    cited = {t for s in result.sections for i in s.items for t in i.tags}
    assert cited == {"Q1", "Q2", "Q121", "Q122"}
    # Each batch's request is tagged from Q1 again.
    assert all("[Q1] " in prompt for _, request in llm.calls for prompt in [request.prompt])
    assert "[Q121]" not in llm.calls[1][1].prompt


def test_long_explanations_split_by_characters() -> None:
    questions = tuple(q(n, "E2E-NOTE-OK", explanation="가" * 7_000) for n in range(1, 11))
    assert sum(question_size(x) for x in questions) > MAX_BATCH_CHARS
    result = ChapterNoteGenerator(ScenarioLLMClient.from_file(SCENARIOS)).generate(
        NoteRequest(questions, REFERENCE)
    )
    assert result.usage.batches == 2
    assert {t for s in result.sections for i in s.items for t in i.tags} == {
        "Q1",
        "Q2",
        "Q9",
        "Q10",
    }


def test_the_mixed_scenario_keeps_four_items_after_one_re_request() -> None:
    truth = json.loads((REPO / "tests/fixtures/pdfs/book-ko.truth.json").read_text("utf-8"))
    chapter1 = "\n".join(b["text"] for b in truth["blocks"] if str(b["id"]).startswith("ch1"))
    questions = tuple(q(n, "E2E-NOTE-MIXED") for n in range(1, 4))
    result = ChapterNoteGenerator(ScenarioLLMClient.from_file(SCENARIOS)).generate(
        NoteRequest(questions, chapter1)
    )
    assert [t.split()[-1] for t in texts(result)] == [
        "NOTE-MIX-A",
        "NOTE-MIX-B",
        "NOTE-MIX-C",
        "NOTE-MIX-D",
    ]
    assert (result.usage.llm_calls, result.usage.items, result.usage.dropped_items) == (2, 4, 3)
    # Without Q3 the item citing it is dropped too.
    two = ChapterNoteGenerator(ScenarioLLMClient.from_file(SCENARIOS)).generate(
        NoteRequest(questions[:2], chapter1)
    )
    assert "NOTE-MIX-C" not in " ".join(texts(two))


def test_property_stored_items_only_cite_input_questions() -> None:
    rng = random.Random(20261029)  # noqa: S311 - deterministic test data
    for _ in range(200):
        n = rng.randint(1, 6)
        questions = tuple(q(i) for i in range(1, n + 1))

        def random_item(n: int = n) -> dict[str, Any]:
            tags = [f"Q{rng.randint(0, n + 3)}" for _ in range(rng.randint(0, 3))]
            quote = rng.choice([None, None, "증발", "없는 문장", ""])
            return item(f"t{rng.random()}", tags, quote)

        responses = [
            {
                "sections": [
                    {"heading": rng.choice(["a", "b"]), "items": [random_item() for _ in range(4)]}
                    for _ in range(rng.randint(1, 3))
                ]
            }
            for _ in range(2)
        ]
        try:
            result = ChapterNoteGenerator(SequenceLLM(*responses)).generate(
                NoteRequest(questions, REFERENCE)
            )
        except NoteCitationError:
            continue
        inputs = {x.tag for x in questions}
        for section in result.sections:
            for it in section.items:
                assert it.tags, "an item without a citation was kept"
                assert set(it.tags) <= inputs, "an item cites a question outside the input"
