"""Real LLM provider smoke test of mock exam generation (MOCK-X, `mock_exam.generate/v1`).

Marked ``llm``: opt-in, billed, excluded from ``make test``. Run with ``make test-llm`` and
``LLM_API_KEY`` / ``LLM_MODEL`` set; fails (never skips) without them. Sends only the hand-written
synthetic questions and passage below, never fixture, book or user content. Assertions are
structural (what the pipeline guarantees after its own validation), not about wording.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from book_core.contracts import Excerpt, QuestionOption, QuestionType, SourceLocation, VariationType
from book_core.generation import SourceQuestion
from book_core.llm import LLMConfig, create_llm_client

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import GenerationSource, generate

pytestmark = pytest.mark.llm

PASSAGE = Excerpt(
    document_id="synthetic",
    revision_id="synthetic-r1",
    text=(
        "두 수를 더한 결과를 합이라고 한다. 2와 3의 합은 5이다. "
        "덧셈은 순서를 바꾸어도 결과가 같다. 이를 교환법칙이라고 한다. "
        "큰 수에서 작은 수를 빼면 차가 남는다. 5에서 3을 빼면 2가 된다."
    ),
    block_ids=("b1",),
    locations=(SourceLocation(page=1),),
)


def _mcq(key: str, stem: str, options: list[str], correct: int, explanation: str) -> SourceQuestion:
    return SourceQuestion(
        question_id=f"q-{key}",
        revision_id=f"r-{key}",
        question_type=QuestionType.MCQ,
        stem=stem,
        options=tuple(QuestionOption(id=f"o{i}", text=t) for i, t in enumerate(options, 1)),
        correct_option_ids=(f"o{correct}",),
        explanation=explanation,
    )


SOURCES = (
    GenerationSource(
        position=0,
        source=_mcq("sum", "2와 3의 합은?", ["4", "5", "6", "7"], 2, "2 + 3 = 5이다."),
        variation_type=VariationType.PARAPHRASE,
        passages=("p1",),
    ),
    GenerationSource(
        position=1,
        source=_mcq(
            "commutative",
            "덧셈에서 순서를 바꾸어도 결과가 같다는 성질은?",
            ["교환법칙", "결합법칙", "분배법칙", "항등법칙"],
            1,
            "a + b = b + a 이므로 교환법칙이다.",
        ),
        variation_type=VariationType.PARAPHRASE,
        passages=("p1",),
    ),
    GenerationSource(
        position=2,
        source=_mcq(
            "difference",
            "다음 중 옳은 것은?",
            ["5에서 3을 빼면 2가 된다.", "2와 3의 합은 6이다.", "뺄셈의 결과를 합이라고 한다."],
            1,
            "5 - 3 = 2이고, 2 + 3 = 5이며, 뺄셈의 결과는 차이다.",
        ),
        variation_type=VariationType.INVERT_POLARITY,
        passages=("p1",),
    ),
)


def test_real_provider_answers_one_batch_whose_stored_items_passed_validation() -> None:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"

    tally = generate(SOURCES, {"p1": PASSAGE}, create_llm_client(config))

    # Three small sources fit one call; at most a split and one re-request round follow.
    assert 1 <= tally.llm_calls <= 6
    assert tally.provider_errors == 0
    assert tally.accepted >= 1, tally.as_dict()
    assert tally.accepted + sum(tally.skipped.values()) == len(SOURCES)
    assert tally.usage.input_tokens > 0
    assert tally.usage.output_tokens > 0
    assert tally.model
