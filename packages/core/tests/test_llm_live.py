"""Real LLM provider round trip (M4.3). Marked ``llm``: opt-in, billed, excluded from ``make test``.

Run with ``make test-llm`` and ``LLM_API_KEY`` / ``LLM_MODEL`` set; fails (never skips) without
them. Sends only the hand-written synthetic question below, never fixture or book text.
"""

from __future__ import annotations

import pytest
from book_core.contracts import (
    Excerpt,
    QuestionOption,
    QuestionType,
    SourceLocation,
    VariationType,
)
from book_core.extractor import LLMQuestion, build_request
from book_core.generation import SourceQuestion, VariantGenerator, VariantRequest
from book_core.llm import LLMConfig, create_llm_client

pytestmark = pytest.mark.llm

SYNTHETIC_QUESTION = ["7. 2 + 3 의 값은?", "① 4", "② 5", "③ 6"]


def test_real_provider_returns_schema_valid_question() -> None:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"
    client = create_llm_client(config)

    result = client.complete(build_request(SYNTHETIC_QUESTION, []), LLMQuestion)

    output = result.output
    assert output.question_type == "MCQ"
    assert [o.label for o in output.options] == ["①", "②", "③"]
    assert result.info.usage.input_tokens > 0
    assert result.info.model
    # Whether the model answers is not asserted: the extractor discards any answer that the
    # printed answer key does not state (test_extractor.py covers that path deterministically).


def test_real_provider_generates_a_validated_paraphrase() -> None:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"
    source = SourceQuestion(
        question_id="q-1",
        revision_id="qr-1",
        question_type=QuestionType.MCQ,
        stem="2 + 3 의 값은?",
        options=(
            QuestionOption(id="opt-1", text="4"),
            QuestionOption(id="opt-2", text="5"),
            QuestionOption(id="opt-3", text="6"),
        ),
        correct_option_ids=("opt-2",),
    )
    passage = Excerpt(
        document_id="doc-1",
        revision_id="rev-1",
        text="두 수를 더하면 합이 된다. 2와 3을 더하면 5가 된다.",
        block_ids=("b-1",),
        locations=(SourceLocation(page=1),),
    )
    request = VariantRequest(
        source=source, variation_types=(VariationType.PARAPHRASE,), passages=(passage,)
    )

    result = VariantGenerator(create_llm_client(config)).generate(request)

    # Whatever the model writes becomes a validated draft or a structured rejection.
    assert result.variants or result.rejected
    assert result.llm_calls
    assert result.llm_calls[0].usage.input_tokens > 0
