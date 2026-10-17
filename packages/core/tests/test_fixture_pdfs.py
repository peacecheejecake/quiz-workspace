"""Synthetic PDF fixtures and their ground truth (M1.1).

Guards the contract later tasks rely on: the committed PDFs are exactly what the generator
produces, their text is extractable (including Korean) and matches the truth JSON, truth bboxes
locate the drawn text, and nothing non-synthetic (foreign fonts, images) is embedded.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import unicodedata
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import BBox, BlockType, QuestionType
from fixture_content import SYNTHETIC_MARKER_EN, SYNTHETIC_MARKER_KO
from fixture_truth import BookTruth, QuestionsTruth, RetrievalSeed
from make_fixture_font import BOLD_NAME, REGULAR_NAME
from make_fixture_pdfs import OUT_DIR, build_all
from pypdf import PdfReader
from pypdf.generic import DictionaryObject, PdfObject

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
BOOKS = ("book-ko", "book-en")
QUESTIONS = "questions-ko"
ALL_FIXTURES = (*BOOKS, QUESTIONS)
FONT_PREFIX = "NotoSansKRFixtureSubset"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


def _book(fixture_id: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{fixture_id}.truth.json").read_bytes())


def _questions() -> QuestionsTruth:
    return QuestionsTruth.model_validate_json((OUT_DIR / f"{QUESTIONS}.truth.json").read_bytes())


def _page_texts(fixture_id: str) -> list[str]:
    reader = PdfReader(OUT_DIR / f"{fixture_id}.pdf")
    return [_norm(page.extract_text()) for page in reader.pages]


Run = tuple[float, float, str]  # (x, baseline from top, text)


def _runs(fixture_id: str) -> list[list[Run]]:
    """Origins of every drawn text run, in top-left coordinates."""
    reader = PdfReader(OUT_DIR / f"{fixture_id}.pdf")
    pages: list[list[Run]] = []
    for page in reader.pages:
        height = float(page.mediabox.height)
        runs: list[Run] = []

        def visit(
            text: Any,
            cm: Any,
            tm: Any,
            _font: Any,
            _size: Any,
            out: list[Run] = runs,
            height: float = height,
        ) -> None:
            if str(text).strip():
                x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
                y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
                out.append((float(x), height - float(y), str(text).strip()))

        page.extract_text(visitor_text=visit)
        pages.append(runs)
    return pages


def _inside(run: Run, bbox: BBox, tol: float = 1.0) -> bool:
    x, baseline, _ = run
    return bbox.x0 - tol <= x <= bbox.x1 + tol and bbox.y0 - tol <= baseline <= bbox.y1 + tol


# --- determinism ---------------------------------------------------------------------------


def test_generator_output_matches_committed_files() -> None:
    first = build_all()
    second = build_all()
    assert first == second
    for name, data in first.items():
        committed = (OUT_DIR / name).read_bytes()
        assert committed == data, f"{name} is stale; run make_fixture_pdfs.py"


def test_cli_regenerates_byte_identical_files(tmp_path: Path) -> None:
    subprocess.run(  # noqa: S603 - fixed argv, our own script
        [sys.executable, str(SCRIPTS_DIR / "make_fixture_pdfs.py"), "--out", str(tmp_path)],
        check=True,
        capture_output=True,
    )
    generated = sorted(p.name for p in tmp_path.iterdir())
    assert generated == sorted(build_all())
    for name in generated:
        assert (tmp_path / name).read_bytes() == (OUT_DIR / name).read_bytes(), name


# --- truth validity ------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_id", ALL_FIXTURES)
def test_truth_matches_pdf_file(fixture_id: str) -> None:
    truth: BookTruth | QuestionsTruth = (
        _questions() if fixture_id == QUESTIONS else _book(fixture_id)
    )
    pdf = OUT_DIR / truth.file
    assert truth.fixture_id == fixture_id
    assert truth.sha256 == hashlib.sha256(pdf.read_bytes()).hexdigest()
    reader = PdfReader(pdf)
    assert truth.page_count == len(reader.pages)
    assert 2 <= truth.page_count <= 5
    for page, info in zip(reader.pages, truth.pages, strict=True):
        assert float(page.mediabox.width) == pytest.approx(info.width, abs=0.01)
        assert float(page.mediabox.height) == pytest.approx(info.height, abs=0.01)


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_book_truth_covers_required_structure(fixture_id: str) -> None:
    truth = _book(fixture_id)
    chapters = [s for s in truth.sections if s.level == 1]
    assert len(chapters) >= 2
    for chapter in chapters:
        assert sum(1 for s in truth.sections if s.parent_id == chapter.id) >= 2
    types = {b.type for b in truth.blocks}
    assert {BlockType.HEADING, BlockType.TEXT, BlockType.TABLE, BlockType.IMAGE} <= types
    images = [b for b in truth.blocks if b.type is BlockType.IMAGE]
    assert all(b.caption_block_id for b in images)
    assert truth.cross_page_block_ids
    content_pages = [p for p in truth.pages if p.page != truth.toc_page]
    assert all(p.noise for p in content_pages)
    parsed = truth.to_parsed_document()
    assert len(parsed.blocks) == len(truth.blocks)


def test_ko_and_en_books_share_section_ids() -> None:
    ko, en = _book("book-ko"), _book("book-en")
    assert [s.id for s in ko.sections] == [s.id for s in en.sections]
    assert ko.language == "ko"
    assert en.language == "en"


def test_question_truth_covers_required_cases() -> None:
    truth = _questions()
    qs = truth.questions
    mcq = [q for q in qs if q.question_type is QuestionType.MCQ]
    assert any(not q.multi_select for q in mcq)
    assert any(q.multi_select for q in mcq)
    assert {q.option_style for q in mcq} == {"circled", "latin"}
    assert any(q.question_type is QuestionType.SHORT_ANSWER for q in qs)
    assert any(q.question_type is QuestionType.ESSAY for q in qs)
    assert any(q.figure is not None for q in qs)
    assert any(q.answer is None for q in qs)
    assert any(q.answer is not None for q in qs)
    assert truth.answer_key_page == truth.page_count
    # Every answered question appears in the key, and only those.
    keyed = {int(line.split(".", 1)[0]) for line in truth.answer_key_lines}
    assert keyed == {q.number for q in qs if q.answer is not None}


def test_retrieval_seed_references_both_languages() -> None:
    seed = RetrievalSeed.model_validate_json((OUT_DIR / "retrieval-seed.json").read_bytes())
    sections = {fid: {s.id for s in _book(fid).sections} for fid in BOOKS}
    assert {q.language for q in seed.queries} == {"ko", "en"}
    for query in seed.queries:
        fixtures = {r.fixture_id for r in query.relevant}
        assert fixtures == set(BOOKS), f"{query.id} must be judged against both books"
        for rel in query.relevant:
            assert rel.section_id in sections[rel.fixture_id]


# --- extraction ----------------------------------------------------------------------------


def _book_expectations(truth: BookTruth) -> Iterator[tuple[int, str]]:
    for line in truth.toc:
        yield truth.toc_page, line.title
    for block in truth.blocks:
        if block.table is not None:
            for row in block.table.rows:
                for cell in row:
                    yield block.parts[0].page, cell
            continue
        for part in block.parts:
            if part.text:
                yield part.page, part.text
    for page in truth.pages:
        for noise in page.noise:
            yield page.page, noise.text


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_book_text_is_extractable_per_page(fixture_id: str) -> None:
    truth = _book(fixture_id)
    pages = _page_texts(fixture_id)
    for page, text in _book_expectations(truth):
        assert _norm(text) in pages[page - 1], f"page {page} lacks {text!r}"


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_cross_page_paragraph_is_split_across_pages(fixture_id: str) -> None:
    truth = _book(fixture_id)
    pages = _page_texts(fixture_id)
    for block_id in truth.cross_page_block_ids:
        block = next(b for b in truth.blocks if b.id == block_id)
        assert block.text not in "".join(pages)
        first, last = block.parts[0], block.parts[-1]
        assert first.text in pages[first.page - 1]
        assert last.text in pages[last.page - 1]
        assert first.text not in pages[last.page - 1]


def test_question_text_is_extractable_per_page() -> None:
    truth = _questions()
    pages = _page_texts(QUESTIONS)
    assert _norm(truth.title) in pages[0]
    for q in truth.questions:
        page = pages[q.page - 1]
        assert f"{q.number}." in page
        assert q.stem in page
        for option in q.options:
            assert option.label in page
            assert option.text in page
        if q.figure is not None:
            assert q.figure.caption in page
    key_page = pages[truth.answer_key_page - 1]
    for line in truth.answer_key_lines:
        assert line in key_page
    unanswered = [q for q in truth.questions if q.answer is None]
    for q in unanswered:
        assert not re.search(rf"(^| ){q.number}\. ", key_page), q.number


def test_korean_text_is_real_unicode_not_glyph_ids() -> None:
    pages = _page_texts("book-ko")
    hangul = sum(1 for ch in "".join(pages) if "가" <= ch <= "힣")
    assert hangul > 1000
    assert "�" not in "".join(pages)


# --- geometry ------------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_book_bboxes_locate_drawn_text(fixture_id: str) -> None:
    truth = _book(fixture_id)
    runs = _runs(fixture_id)
    boxes: dict[int, list[BBox]] = {p.page: [n.bbox for n in p.noise] for p in truth.pages}
    for block in truth.blocks:
        for part in block.parts:
            boxes[part.page].append(part.bbox)
            if block.type in (BlockType.TEXT, BlockType.HEADING):
                hits = [
                    r for r in runs[part.page - 1] if _inside(r, part.bbox) and r[2] in part.text
                ]
                assert hits, f"{block.id} p{part.page}: no drawn text inside its bbox"
    # Every run on a content page belongs to some truth bbox (nothing unaccounted for).
    for page in truth.pages:
        if page.page == truth.toc_page:
            continue
        for run in runs[page.page - 1]:
            assert any(_inside(run, box) for box in boxes[page.page]), (page.page, run)


def test_question_bboxes_locate_stems() -> None:
    truth = _questions()
    runs = _runs(QUESTIONS)
    for q in truth.questions:
        stem_runs = [r for r in runs[q.page - 1] if r[2] in q.stem and _inside(r, q.bbox)]
        assert stem_runs, f"question {q.number}: stem not inside its bbox"
        if q.figure is not None:
            assert q.bbox.y0 < q.figure.bbox.y0 < q.figure.bbox.y1 <= q.bbox.y1


# --- provenance ----------------------------------------------------------------------------


def _dict(obj: object) -> DictionaryObject:
    resolved = obj.get_object() if isinstance(obj, PdfObject) else obj
    assert isinstance(resolved, DictionaryObject), type(resolved)
    return resolved


def _fonts(reader: PdfReader) -> Iterator[DictionaryObject]:
    for page in reader.pages:
        fonts = _dict(page["/Resources"]).get("/Font")
        if fonts is not None:
            yield from (_dict(ref) for ref in _dict(fonts).values())


@pytest.mark.parametrize("fixture_id", ALL_FIXTURES)
def test_only_synthetic_content_is_embedded(fixture_id: str) -> None:
    reader = PdfReader(OUT_DIR / f"{fixture_id}.pdf")
    meta = reader.metadata
    assert meta is not None
    assert "synthetic" in str(meta.get("/Keywords"))
    assert meta.get("/Author") == "quiz-workspace test fixtures"
    text = " ".join(_page_texts(fixture_id))
    assert SYNTHETIC_MARKER_KO in text or SYNTHETIC_MARKER_EN in text
    for page in reader.pages:
        assert "/XObject" not in _dict(page["/Resources"]), "fixtures must not embed images"
    for font in _fonts(reader):
        name = str(font["/BaseFont"])
        if name == "/Helvetica":
            # reportlab's default font resource; a base-14 font, never embedded or drawn with.
            assert "/FontDescriptor" not in font
            continue
        assert FONT_PREFIX in name, name
        assert "/ToUnicode" in font, f"{name} lacks a ToUnicode map"
        assert "/FontFile2" in _dict(font["/FontDescriptor"]), f"{name} is not embedded"


def test_font_license_ships_with_fonts() -> None:
    font_dir = OUT_DIR / "fonts"
    license_text = (font_dir / "OFL.txt").read_text()
    assert "SIL OPEN FONT LICENSE Version 1.1" in license_text
    assert sorted(p.name for p in font_dir.glob("*.ttf")) == sorted([BOLD_NAME, REGULAR_NAME])
