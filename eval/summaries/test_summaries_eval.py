"""Offline checks of the DOCSUM-X evaluation scripts (fake providers, synthetic fixtures)."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest
from book_core.llm import FakeLLMClient, LLMUsage
from book_core.notes import TASK
from book_core.summary import (
    ChapterDigest,
    InputBlock,
    KeyPoint,
    PageRange,
    SummaryBody,
    SummaryCall,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import note_eval
import summary_eval
from source import DEFAULT_BOOKS, load_document, support


def test_truth_books_load_as_top_level_chapters_with_page_text() -> None:
    doc = load_document(DEFAULT_BOOKS[0])
    assert [(c.title, c.page_from, c.page_to) for c in doc.chapters] == [
        ("1장 물의 순환", 2, 3),
        ("2장 정수 처리", 4, 4),
    ]
    assert sorted(doc.page_text) == [2, 3, 4]  # page 1 is the table of contents (no blocks)
    claim = "물이 에너지를 얻어 수증기로 바뀌는 증발이 일어난다"
    assert support(claim, doc.pages_text(2, 2)) > 0.65
    assert support(claim, doc.pages_text(4, 4)) < 0.3
    en = load_document(DEFAULT_BOOKS[1])
    assert support("Chlorine reduces pathogenic microorganisms", en.pages_text(4, 4)) == 1.0
    assert support("Chlorine reduces pathogenic microorganisms", en.pages_text(2, 2)) < 0.3


def test_non_synthetic_truth_files_are_refused(tmp_path: Path) -> None:
    data = json.loads(DEFAULT_BOOKS[0].read_text(encoding="utf-8"))
    data["synthetic"] = False
    path = tmp_path / "real.truth.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="synthetic"):
        load_document(path)


def test_summary_eval_with_the_extractive_fake_is_fully_valid() -> None:
    report = summary_eval.run(list(DEFAULT_BOOKS))
    s = report["summary"]
    assert s["chapters_nonempty"] == 4
    assert s["chapter_coverage"] == 1.0
    assert s["document_chapter_coverage"] == 1.0
    assert s["proposed_citations"]["in_range_rate"] == 1.0
    assert s["proposed_citations"]["supported_rate"] == 1.0
    assert "summary_md" not in json.dumps(report)


class _WrongPages:
    """Cites page 1 (outside every chapter, no matching text) for every key point."""

    model_name = "wrong-pages"
    usage = LLMUsage(input_tokens=1, output_tokens=1)

    def summarize_chapter(
        self, title: str, blocks: Sequence[InputBlock], page_from: int, page_to: int
    ) -> SummaryCall:
        point = KeyPoint(text=blocks[-1].text[:40], pages=PageRange(from_=1, to=1))
        body = SummaryBody(title=title, summary_md="x", key_points=(point,))
        return SummaryCall(body, self.usage)

    def merge_chapter(
        self, title: str, parts: Sequence[SummaryBody], page_from: int, page_to: int
    ) -> SummaryCall:
        return SummaryCall(parts[0], self.usage)

    def summarize_document(
        self,
        title: str,
        chapters: Sequence[ChapterDigest],
        page_from: int | None,
        page_to: int | None,
    ) -> SummaryCall:
        return SummaryCall(SummaryBody(title=title, summary_md="y"), self.usage)


def test_summary_eval_detects_out_of_range_and_unsupported_pages() -> None:
    report = summary_eval.run(DEFAULT_BOOKS[:1], summarizer=_WrongPages())
    s = report["summary"]
    assert s["proposed_citations"]["in_range_rate"] == 0.0
    assert s["proposed_citations"]["supported_rate"] == 0.0
    # The pipeline drops the out-of-range pages: nothing to link, so no stored citation.
    assert s["stored_citations"]["with_pages"] == 0
    # The document summary names no chapter and cites no page.
    assert s["document_chapter_coverage"] == 0.0


def test_note_eval_with_the_scripted_dataset() -> None:
    report = note_eval.run()
    s = report["summary"]
    assert (s["chapters"], s["failed"], s["questions"]) == (4, 0, 11)
    # book-ko/ch1: one item cites the wrong question, one cites Q99 (re-requested, dropped).
    assert (s["footnotes_supported"], s["footnotes"]) == (14, 15)
    assert (s["questions_cited"], s["dropped_items"], s["re_requests"]) == (10, 1, 1)
    assert s["proposed_citation_validity"] == pytest.approx(17 / 19, abs=1e-4)
    text = json.dumps(report, ensure_ascii=False)
    assert "증발" not in text
    assert "evaporation" not in text.lower()


def test_note_eval_counts_a_chapter_without_valid_items_as_failed() -> None:
    def only_q99(case: note_eval.ChapterCase) -> FakeLLMClient:
        client = FakeLLMClient("q99")
        item = {"text": "t", "tags": ["Q99"]}
        client.script(TASK, {"sections": [{"heading": "h", "items": [item]}]})
        return client

    report = note_eval.run(clients=only_q99)
    s = report["summary"]
    assert s["failed"] == 4
    assert s["footnote_coverage"] == 0.0
    assert s["llm_calls"] == 8  # each chapter: one call + one re-request
