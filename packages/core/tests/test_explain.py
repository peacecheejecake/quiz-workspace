"""book_core.explain: the AI explanation request, output handling and fake (AIEXPL-01-C04, C08)."""

from __future__ import annotations

import dataclasses
import json
import threading
import time
from pathlib import Path

import pytest
from book_core.ask import AskSource
from book_core.explain import (
    ANSWER_MISMATCH,
    FAKE_RAW_SENTINEL,
    INCOMPLETE,
    TRUNCATED_SUFFIX,
    AnswerMismatchError,
    ExplainCallMeta,
    ExplanationStream,
    FakeExplainer,
    build_request,
    explain_question,
    finish_explanation,
)
from book_core.explain.models import ExplainQuestion
from book_core.llm import LLMProviderError, TextDelta, TextStreamEnd

TERMS = ["증발", "응결", "강수", "유출"]
OPTIONS = [{"id": f"opt-{i}", "text": t} for i, t in enumerate(TERMS, start=1)]
SOURCE = AskSource("S1", "물의 순환", "1장", 2, 2, "햇빛이 바다를 데운다. 둘째 문장.")


def mcq(stem: str = "물이 수증기가 되는 과정은?") -> ExplainQuestion:
    return explain_question(
        kind="question",
        question_type="MCQ",
        stem=stem,
        options=OPTIONS,
        correct_option_ids=["opt-1"],
        accepted_answers=None,
        rubric=None,
        explanation="사람이 쓴 해설",
    )


def meta(target: str = "q1", revision: str = "r1") -> ExplainCallMeta:
    return ExplainCallMeta("question", target, revision, "e1")


def run(fake: FakeExplainer, question: ExplainQuestion, **kw: object) -> tuple[list[str], str]:
    request = build_request(question=question, sources=[SOURCE], max_output_tokens=1500)
    shown = ExplanationStream(question)
    out = [shown.feed(e.text) for e in fake.stream(request, meta(**kw)) if isinstance(e, TextDelta)]  # type: ignore[arg-type]
    out.append(shown.finish())
    return [o for o in out if o], shown.raw


@pytest.fixture
def fake(tmp_path: Path) -> FakeExplainer:
    return FakeExplainer(log_dir=tmp_path / "log", hold_dir=tmp_path / "hold", delay_seconds=0)


def test_aiexpl_01_c04_the_request_has_the_answer_and_sources_but_no_user_field() -> None:
    fields = {f.name for f in dataclasses.fields(ExplainQuestion)}
    assert not {f for f in fields if "selected" in f or "submitted" in f or "attempt" in f}
    request = build_request(question=mcq(), sources=[SOURCE], max_output_tokens=1500)
    parts = ("물이 수증기가 되는 과정은?", "opt-1: 증발", "정답 보기 id: opt-1", "사람이 쓴 해설")
    for part in parts:
        assert part in request.prompt
    assert "[S1] 물의 순환 · 1장 · p.2" in request.prompt
    assert request.to_text_request().max_tokens == 1500
    assert request.attempt == 1


def test_aiexpl_01_c04_short_answers_carry_accepted_answers_and_rubric() -> None:
    question = explain_question(
        kind="question",
        question_type="SHORT_ANSWER",
        stem="물이 기체로 변하는 현상은?",
        options=[],
        correct_option_ids=None,
        accepted_answers=["증발", " "],
        rubric="핵심어 증발",
        explanation=None,
    )
    request = build_request(question=question, sources=[], max_output_tokens=500)
    assert "정답(허용 답안): 증발" in request.prompt
    assert "채점 기준: 핵심어 증발" in request.prompt
    assert "정답 보기 id" not in request.prompt


def test_aiexpl_01_c04_nothing_is_shown_before_a_matching_answer_line() -> None:
    stream = ExplanationStream(mcq())
    assert stream.feed("[[SUMMARY]]\n정답 이유\n") == ""  # held until the answer line
    shown = stream.feed("[[ANSWER]] opt-1\n[[OPTION opt-2]]\n응결: 틀립니다.\n")
    assert shown.startswith("**정답과 이유**\n정답 이유\n")
    assert "**2. 응결**" in shown
    assert "opt-" not in shown
    mismatch = ExplanationStream(mcq())
    with pytest.raises(AnswerMismatchError):
        mismatch.feed("[[ANSWER]] opt-2\n")


def test_aiexpl_01_c04_validation_mismatch_coverage_and_citations() -> None:
    question = mcq()
    good = "\n".join(
        [
            "[[ANSWER]] opt-1",
            "[[SUMMARY]]",
            "정답은 증발 [S1] 그리고 [S9]",
            *[f"[[OPTION {o['id']}]]\n{o['text']} 설명" for o in OPTIONS],
            "[[CONCEPTS]]",
            "개념 [S1]",
        ]
    )
    done = finish_explanation(good, question, ["S1"])
    assert done.body is not None
    assert done.body["summary_md"] == "정답은 증발 [1] 그리고"
    assert [o["option_id"] for o in done.body["options"]] == ["opt-1", "opt-2", "opt-3", "opt-4"]
    assert done.body["correct_option_ids"] == ["opt-1"]
    assert done.cited_tags == ("S1",)
    assert done.dropped_citations == 1
    wrong = finish_explanation(good.replace("[[ANSWER]] opt-1", "[[ANSWER]] opt-3"), question, [])
    assert (wrong.body, wrong.error_code) == (None, ANSWER_MISMATCH)
    missing = finish_explanation(good.replace("[[OPTION opt-4]]\n유출 설명", ""), question, [])
    assert (missing.error_code, missing.missing_option_ids) == (INCOMPLETE, ("opt-4",))
    twice = finish_explanation(good + "\n[[OPTION opt-2]]\n또", question, [])
    assert twice.error_code == INCOMPLETE
    cut = finish_explanation(good, question, ["S1"], truncated=True)
    assert cut.body is not None
    assert cut.body["concepts_md"].endswith(TRUNCATED_SUFFIX)


def test_aiexpl_01_c08_the_fake_is_deterministic_and_streams_whole_lines(
    fake: FakeExplainer,
) -> None:
    first, raw = run(fake, mcq())
    _, again = run(fake, mcq(), target="q2")
    assert raw == again
    assert len(first) >= 3
    assert all(chunk.endswith("\n") for chunk in first)
    done = finish_explanation(raw, mcq(), ["S1"])
    assert done.body is not None
    assert done.body["summary_md"] == "정답은 증발입니다. 햇빛이 바다를 데운다. [1]"
    assert done.body["options"][1]["why_md"] == "응결: 틀립니다. 정답은 증발입니다."


def test_aiexpl_01_c08_markers_hit_the_first_call_of_a_revision(fake: FakeExplainer) -> None:
    failing = mcq("x [E2E-EXPL-FAIL]")
    request = build_request(question=failing, sources=[SOURCE], max_output_tokens=9)
    with pytest.raises(LLMProviderError):
        list(fake.stream(request, meta()))
    assert any(isinstance(e, TextStreamEnd) for e in fake.stream(request, meta()))
    with pytest.raises(LLMProviderError):  # a new revision fails once again
        list(fake.stream(request, meta(revision="r2")))

    question = mcq("y [E2E-EXPL-MISMATCH]")
    stream = ExplanationStream(question)
    request = build_request(question=question, sources=[SOURCE], max_output_tokens=9)
    chunks = [e.text for e in fake.stream(request, meta(target="m")) if isinstance(e, TextDelta)]
    with pytest.raises(AnswerMismatchError):
        stream.feed(chunks[0])
    _, raw = run(fake, question, target="m")
    assert FAKE_RAW_SENTINEL not in raw
    assert finish_explanation(raw, question, ["S1"]).body is not None

    _, partial = run(fake, mcq("z [E2E-EXPL-MISSING-OPTION]"), target="p")
    assert finish_explanation(partial, mcq(), ["S1"]).missing_option_ids == ("opt-4",)


def test_aiexpl_01_c08_the_call_log_holds_markers_and_ids_only(
    fake: FakeExplainer, tmp_path: Path
) -> None:
    run(fake, mcq("비밀 발문 [E2E-EXPL-SLOW]"))
    [record] = list((tmp_path / "log" / "ai_explanation" / "q1").glob("*.json"))
    data = json.loads(record.read_text(encoding="utf-8"))
    assert data == {
        "target_kind": "question",
        "revision_id": "r1",
        "explanation_id": "e1",
        "attempt": 1,
        "markers": ["E2E-EXPL-SLOW"],
    }
    assert "비밀" not in record.read_text(encoding="utf-8")
    assert len(fake.calls) == 1


def test_aiexpl_01_c08_hold_and_mid_stream_barriers(fake: FakeExplainer, tmp_path: Path) -> None:
    hold = tmp_path / "hold"
    question = mcq("h [E2E-EXPL-HOLDMID-tok1]")
    request = build_request(question=question, sources=[SOURCE], max_output_tokens=9)
    chunks: list[str] = []
    events = fake.stream(request, meta(target="h"))

    def consume() -> None:
        for event in events:
            if isinstance(event, TextDelta):
                chunks.append(event.text)

    worker = threading.Thread(target=consume, daemon=True)
    worker.start()
    deadline = time.monotonic() + 10
    while not (hold / "tok1.mid").exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert (hold / "tok1.mid").exists()
    assert len(chunks) == 1
    assert chunks[0].startswith("[[ANSWER]] opt-1\n")
    (hold / "tok1.resume").write_text("")
    worker.join(10)
    assert len(chunks) >= 3
