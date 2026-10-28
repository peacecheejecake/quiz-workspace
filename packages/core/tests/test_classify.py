"""Content kind classifier (UX6-UPLOAD-B): book / question_paper / mixed from parsed blocks.

Fixture PDFs run through ``FakeParser`` (their ideal ``ParsedDocument``); the other documents
are synthetic text, one block per printed line like Docling output.
"""

from __future__ import annotations

import pytest
from book_core.contracts import ParsedDocument
from book_core.extractor.classify import CLASSIFIER_VERSION, ContentDetection, classify_content
from book_core.parser import FakeParser, document_from_pages
from book_core.structure import build_revision
from make_fixture_pdfs import OUT_DIR


def _fixture(name: str) -> ParsedDocument:
    return FakeParser.from_truth_files([OUT_DIR / f"{name}.truth.json"]).parse(
        OUT_DIR / f"{name}.pdf"
    )


def _doc(*pages: list[str]) -> ParsedDocument:
    blocks = [[line for block in page for line in block.split("\n")] for page in pages]
    return document_from_pages(blocks, source_path="x.pdf", source_sha256="0" * 64)


def _classify(*pages: list[str]) -> ContentDetection:
    return classify_content(_doc(*pages).blocks)


_PROSE = (
    "물은 증발과 응결을 거치며 지구 표면과 대기 사이를 끊임없이 순환한다. 이 과정에서 태양 "
    "에너지가 물을 데우고, 수증기는 상승하여 구름을 이루며, 구름 속 물방울은 다시 비가 되어 "
    "내린다."
)


def _chapter(n: int) -> list[str]:
    return [
        f"# 제{n}장 물의 순환 {n}",
        f"{n}. 개요",
        _PROSE,
        _PROSE,
        f"{n}.1 증발",
        _PROSE,
        _PROSE,
        _PROSE,
    ]


def _exercises(start: int, count: int, *, answers: bool) -> list[str]:
    lines: list[str] = ["# 확인 문제"]
    for n in range(start, start + count):
        lines += [
            f"{n}. 다음 중 물의 순환 과정에 해당하지 않는 것은?",
            "① 증발",
            "② 응결",
            "③ 강수",
            "④ 광합성",
        ]
        if answers:
            lines += ["정답: ④", "해설: 광합성은 식물의 에너지 대사 과정이다."]
    return lines


@pytest.mark.parametrize("name", ["book-ko", "book-en"])
def test_fixture_books_are_books(name: str) -> None:
    detection = classify_content(_fixture(name).blocks)
    assert detection.kind == "book"
    assert detection.confidence == "high"
    assert detection.strong_questions == 0


def test_fixture_question_paper_is_a_question_paper() -> None:
    detection = classify_content(_fixture("questions-ko").blocks)
    assert detection.kind == "question_paper"
    assert detection.confidence == "high"
    assert detection.strong_questions >= 5
    assert detection.coverage >= 0.75
    assert detection.version == CLASSIFIER_VERSION


def test_classification_of_the_built_revision_matches_the_parse() -> None:
    """The worker classifies the canonical revision, not the raw parse."""
    for name, kind in (("book-ko", "book"), ("questions-ko", "question_paper")):
        parsed = _fixture(name)
        revision = build_revision(parsed, document_id="d", revision_id="r").revision
        assert classify_content(revision.blocks).kind == kind


def test_book_with_chapter_end_exercises_is_mixed_and_high_when_answered() -> None:
    pages = []
    for n in range(1, 5):
        pages.append(_chapter(n) + _chapter(n))
        pages.append(_exercises(1, 3, answers=True))
    detection = _classify(*pages)
    assert detection.kind == "mixed"
    assert detection.confidence == "high"
    assert detection.strong_questions == 12
    assert 0 < detection.coverage < 0.6


def test_mixed_without_answers_is_low_confidence() -> None:
    pages = [_chapter(1) + _chapter(2), _exercises(1, 5, answers=False), _chapter(3) * 2]
    detection = _classify(*pages)
    assert detection.kind == "mixed"
    assert detection.confidence == "low"
    assert detection.answered_ratio == 0


def test_question_bank_with_inline_answers_and_explanations_is_a_paper() -> None:
    pages = [["# 2026 기출문제", "다음 물음에 답하시오."]]
    pages += [_exercises(n, 5, answers=True)[1:] for n in range(1, 30, 5)]
    detection = _classify(*pages)
    assert detection.kind == "question_paper"
    assert detection.confidence == "high"
    assert detection.answered_ratio == 1
    assert detection.gap_ratio == 0


def test_numbered_textbook_headings_and_statute_paragraphs_are_weak_evidence() -> None:
    """``1. 개요`` headings and ``① 이 법은 ...`` paragraphs look like stems with options, but
    ask nothing and have no answer."""
    statute = [
        "1. 예금자보호법",
        "① 이 법은 금융회사가 파산 등으로 예금을 지급할 수 없는 경우에 적용한다.",
        "② 보호 한도는 대통령령으로 정한다.",
        "③ 이 법에 따른 보험금은 예금보험공사가 지급한다.",
    ]
    pages = [_chapter(1) + statute, _chapter(2) + statute, _chapter(3) + statute]
    detection = _classify(*pages)
    assert detection.kind == "book"
    assert detection.strong_questions == 0
    assert detection.confidence == "high"


def test_a_couple_of_questions_do_not_make_a_book_mixed() -> None:
    pages = [_chapter(1) + _exercises(1, 2, answers=False), _chapter(2)]
    detection = _classify(*pages)
    assert detection.kind == "book"
    assert detection.strong_questions == 2
    assert detection.confidence == "low"


def test_answer_key_section_counts_as_question_text() -> None:
    questions = []
    for n in range(1, 9):
        questions += [f"{n}. 다음 중 옳은 것은?", "① 가", "② 나", "③ 다", "④ 라"]
    detection = _classify(questions, ["정답", "1. ② 2. ③ 3. ① 4. ④", "5. ② 6. ③ 7. ① 8. ④"])
    assert detection.kind == "question_paper"
    assert detection.answered_ratio == 1
    assert detection.page_share == 1


def test_numbering_gaps_lower_mixed_confidence() -> None:
    pages = [_chapter(1) * 3]
    for n in (1, 5, 9, 14, 20):
        pages.append(_exercises(n, 1, answers=True) + _chapter(n))
    detection = _classify(*pages)
    assert detection.kind == "mixed"
    assert detection.gap_ratio > 0.2
    assert detection.confidence == "low"


def test_empty_document_is_a_book_and_the_result_holds_no_text() -> None:
    detection = classify_content(())
    assert detection.kind == "book"
    assert detection.coverage == 0
    dumped = _classify(_exercises(1, 4, answers=True)).model_dump_json()
    assert "광합성" not in dumped
    assert "증발" not in dumped


def test_classification_is_deterministic() -> None:
    doc = _doc(_chapter(1), _exercises(1, 4, answers=True), _chapter(2))
    assert classify_content(doc.blocks) == classify_content(doc.blocks)
