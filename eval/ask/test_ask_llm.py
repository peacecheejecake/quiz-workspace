"""Real LLM provider smoke tests of streaming, AI questions and AI explanations (ASK-X).

Marked ``llm``: opt-in, billed, excluded from ``make test``. Run with ``make test-llm`` and
``LLM_API_KEY`` / ``LLM_MODEL`` set; fails (never skips) without them. Sends only the hand-written
synthetic passage and questions below, never fixture, book or user content. Assertions are
structural (what the product's own checks guarantee about a finished answer), not about wording.
"""

from __future__ import annotations

import pytest
from book_core.ask import (
    AskSource,
    build_request,
    hint_context,
    validate_citations,
)
from book_core.explain import build_request as build_explain_request
from book_core.explain import (
    explain_question,
    finish_explanation,
)
from book_core.llm import LLMConfig
from book_core.llm.streaming import (
    TextDelta,
    TextStreamClient,
    TextStreamEnd,
    create_text_stream_client,
)

pytestmark = pytest.mark.llm

PASSAGE = AskSource(
    tag="S1",
    document_title="synthetic",
    chapter_title="1장 덧셈",
    page_from=1,
    page_to=1,
    text=(
        "두 수를 더한 결과를 합이라고 한다. 2와 3의 합은 5이다. "
        "덧셈은 순서를 바꾸어도 결과가 같다. 이를 교환법칙이라고 한다."
    ),
)
OPTIONS = [
    {"id": "opt-1", "text": "교환법칙"},
    {"id": "opt-2", "text": "결합법칙"},
    {"id": "opt-3", "text": "분배법칙"},
    {"id": "opt-4", "text": "항등법칙"},
]


def _client() -> TextStreamClient:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"
    return create_text_stream_client(config)


def _stream(client: TextStreamClient, request) -> tuple[str, TextStreamEnd]:  # type: ignore[no-untyped-def]
    deltas: list[str] = []
    end: TextStreamEnd | None = None
    for event in client.stream_text(request.to_text_request()):
        if isinstance(event, TextDelta):
            deltas.append(event.text)
        else:
            end = event
    assert end is not None, "a stream ends with exactly one TextStreamEnd"
    assert deltas, "text arrived before the end"
    return "".join(deltas), end


def test_real_provider_streams_an_answer_with_usage() -> None:
    request = build_request(
        question="덧셈에서 순서를 바꾸어도 결과가 같은 성질은 무엇인가요?",
        sources=[PASSAGE],
        attachment=None,
        max_output_tokens=400,
    )
    text, end = _stream(_client(), request)
    assert end.stop_reason in {"end_turn", "max_tokens"}
    assert end.usage.input_tokens > 0
    assert end.usage.output_tokens > 0
    assert text.strip()


def test_real_provider_ask_answer_cites_only_given_tags() -> None:
    request = build_request(
        question="2와 3의 합은 얼마인가요?",
        sources=[PASSAGE],
        attachment=None,
        max_output_tokens=400,
    )
    text, _ = _stream(_client(), request)
    result = validate_citations(text, request.source_tags)
    assert not result.no_answer, "the passage answers the question"
    assert set(result.cited_tags) <= {"S1"}
    assert "[S" not in result.text, "every remaining tag was renumbered or dropped"


def test_real_provider_hint_answer_does_not_state_the_answer() -> None:
    hint = hint_context(
        kind="question",
        number="1",
        chapter=None,
        question_type="MCQ",
        stem="덧셈에서 순서를 바꾸어도 결과가 같다는 성질은?",
        options=OPTIONS,
        displayed_option_ids=[o["id"] for o in OPTIONS],
        selected_option_ids=[],
    )
    request = build_request(
        question="정답이 몇 번인지 알려 주세요.",
        sources=[PASSAGE],
        attachment=hint,
        max_output_tokens=400,
    )
    text, _ = _stream(_client(), request)
    result = validate_citations(text, request.source_tags)
    assert request.disclosure == "hint"
    assert not any(f in request.attachment_fields for f in ("correct_answer", "explanation"))
    assert "1번이 정답" not in result.text
    assert "정답은 1번" not in result.text


def test_real_provider_explanation_matches_the_stored_answer() -> None:
    question = explain_question(
        kind="question",
        question_type="MCQ",
        stem="덧셈에서 순서를 바꾸어도 결과가 같다는 성질은?",
        options=OPTIONS,
        correct_option_ids=["opt-1"],
        accepted_answers=None,
        rubric=None,
    )
    client = _client()
    request = build_explain_request(question=question, sources=[PASSAGE], max_output_tokens=1500)
    raw, end = _stream(client, request)
    finished = finish_explanation(raw, question, request.source_tags, truncated=end.truncated)
    if finished.body is None and finished.missing_option_ids:  # the one coverage re-request
        again = build_explain_request(
            question=question,
            sources=[PASSAGE],
            max_output_tokens=1500,
            missing_option_ids=finished.missing_option_ids,
        )
        raw, end = _stream(client, again)
        finished = finish_explanation(raw, question, again.source_tags, truncated=end.truncated)
    assert finished.body is not None, finished.error_code
    assert finished.body["correct_option_ids"] == ["opt-1"]
    assert len(finished.body["options"]) == len(OPTIONS)
