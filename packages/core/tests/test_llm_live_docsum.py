"""Real LLM provider smoke tests of document summaries and chapter notes (DOCSUM-X).

Marked ``llm``: opt-in, billed, excluded from ``make test``. Run with ``make test-llm`` and
``LLM_API_KEY`` / ``LLM_MODEL`` set; fails (never skips) without them. Sends only the hand-written
synthetic text below, never fixture, book or user content. Assertions are structural (what the
pipeline guarantees after its own validation), not about wording.
"""

from __future__ import annotations

import pytest
from book_core.llm import LLMConfig, LLMUsage, create_llm_client
from book_core.notes import ChapterNoteGenerator, NoteOption, NoteQuestion, NoteRequest
from book_core.summary import (
    ChapterInput,
    InputBlock,
    LLMSummarizer,
    StoredUnit,
    SummaryBody,
    SummaryLimits,
    SummaryTally,
    summarize_revision,
)

pytestmark = pytest.mark.llm

SYNTHETIC_CHAPTERS = (
    ChapterInput(
        section_key="ch1",
        title="1장 덧셈",
        page_from=1,
        page_to=2,
        blocks=(
            InputBlock("1장 덧셈", 1, 1, heading=True),
            InputBlock("두 수를 더한 결과를 합이라고 한다. 2와 3의 합은 5이다.", 1, 1),
            InputBlock("덧셈은 순서를 바꾸어도 결과가 같다. 이를 교환법칙이라고 한다.", 2, 2),
        ),
    ),
    ChapterInput(
        section_key="ch2",
        title="2장 뺄셈",
        page_from=3,
        page_to=3,
        blocks=(
            InputBlock("2장 뺄셈", 3, 3, heading=True),
            InputBlock("큰 수에서 작은 수를 빼면 차가 남는다. 5에서 3을 빼면 2가 된다.", 3, 3),
        ),
    ),
)


def _config() -> LLMConfig:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"
    return config


class _Store:
    def __init__(self) -> None:
        self.saved: dict[tuple[str, str, str], StoredUnit] = {}

    def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None:
        return self.saved.get((scope, section_key, input_hash))

    def save(
        self,
        scope: str,
        section_key: str,
        input_hash: str,
        body: SummaryBody,
        page_from: int | None,
        page_to: int | None,
        usage: LLMUsage | None,
    ) -> StoredUnit:
        unit = StoredUnit(id=section_key, body=body, page_from=page_from, page_to=page_to)
        self.saved[(scope, section_key, input_hash)] = unit
        return unit


def test_real_provider_summarizes_a_synthetic_document_with_pages_in_range() -> None:
    summarizer = LLMSummarizer(create_llm_client(_config()))
    tally = SummaryTally()
    store = _Store()

    result = summarize_revision(
        SYNTHETIC_CHAPTERS,
        document_title="합성 산수 노트",
        summarizer=summarizer,
        store=store,
        limits=SummaryLimits(),
        tally=tally,
    )

    assert result.document.body.summary_md.strip()
    assert [u.body.title for u in result.chapters] == ["1장 덧셈", "2장 뺄셈"]
    for chapter, unit in zip(SYNTHETIC_CHAPTERS, result.chapters, strict=True):
        assert unit.body.summary_md.strip()
        for point in unit.body.key_points:
            # Out-of-range pages are dropped by the pipeline; whatever remains is in the chapter.
            if point.pages is not None:
                assert chapter.page_from is not None
                assert chapter.page_to is not None
                assert chapter.page_from <= point.pages.from_ <= point.pages.to <= chapter.page_to
    assert tally.generated_units == 3  # two chapters + the document
    assert tally.usage.input_tokens > 0
    assert tally.usage.output_tokens > 0

    # The same input again reuses every unit without a call.
    again = SummaryTally()
    summarize_revision(
        SYNTHETIC_CHAPTERS,
        document_title="합성 산수 노트",
        summarizer=summarizer,
        store=store,
        limits=SummaryLimits(),
        tally=again,
    )
    assert (again.generated_units, again.reused_units) == (0, 3)


def test_real_provider_writes_a_chapter_note_citing_only_input_questions() -> None:
    questions = (
        NoteQuestion(
            tag="Q1",
            label="1장 1번",
            question_type="MCQ",
            stem="2와 3의 합은?",
            options=(
                NoteOption(text="4", correct=False),
                NoteOption(text="5", correct=True),
                NoteOption(text="6", correct=False),
            ),
            explanation="두 수를 더한 결과를 합이라고 하며 2 + 3 = 5이다.",
        ),
        NoteQuestion(
            tag="Q2",
            label="1장 2번",
            question_type="SHORT_ANSWER",
            stem="덧셈에서 순서를 바꾸어도 결과가 같다는 성질의 이름은?",
            accepted_answers=("교환법칙",),
            explanation="a + b = b + a 이므로 덧셈은 교환법칙이 성립한다.",
        ),
    )
    reference = "\n".join(b.text for b in SYNTHETIC_CHAPTERS[0].blocks)

    result = ChapterNoteGenerator(create_llm_client(_config())).generate(
        NoteRequest(questions=questions, reference_text=reference)
    )

    items = [item for section in result.sections for item in section.items]
    assert items
    assert all(item.text.strip() for item in items)
    assert all(item.tags and set(item.tags) <= {"Q1", "Q2"} for item in items)
    assert result.usage.batches == 1
    assert result.usage.llm_calls in (1, 2)  # one re-request at most
    assert result.usage.input_tokens > 0
    assert result.model
