"""Deterministic ``FakeParser`` and the parser-independent helpers (M1.2)."""

from __future__ import annotations

from pathlib import Path

import pytest
from book_core.contracts import BlockType
from book_core.parser import (
    FAKE_PARSER_VERSION,
    FakeParser,
    PdfParser,
    UnknownDocumentError,
    document_from_pages,
    load_truth_document,
    sha256_hex,
)
from book_core.parser._blocks import make_bbox, normalize_text, table_text
from fixture_truth import BookTruth, QuestionsTruth
from make_fixture_pdfs import OUT_DIR

BOOKS = ("book-ko", "book-en")


def _truth_path(fixture_id: str) -> Path:
    return OUT_DIR / f"{fixture_id}.truth.json"


def test_fake_parser_satisfies_protocol() -> None:
    assert isinstance(FakeParser(), PdfParser)
    assert FakeParser().parser_version == FAKE_PARSER_VERSION


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_book_truth_document_matches_truth_models(fixture_id: str) -> None:
    expected = BookTruth.model_validate_json(_truth_path(fixture_id).read_bytes())
    ideal = expected.to_parsed_document()
    loaded = load_truth_document(_truth_path(fixture_id))
    assert loaded == ideal.model_copy(update={"parser_version": FAKE_PARSER_VERSION})
    tables = [b for b in loaded.blocks if b.type is BlockType.TABLE]
    assert tables
    assert all(b.table is not None for b in tables)
    assert all(b.caption_block_id for b in loaded.blocks if b.type is BlockType.IMAGE)
    assert all(b.heading_level in (1, 2) for b in loaded.blocks if b.type is BlockType.HEADING)


def test_questions_truth_document_has_questions_figure_and_answer_key() -> None:
    truth = QuestionsTruth.model_validate_json(_truth_path("questions-ko").read_bytes())
    doc = load_truth_document(_truth_path("questions-ko"))
    texts = [b.text for b in doc.blocks]
    for question in truth.questions:
        block = next(b for b in doc.blocks if b.text.startswith(f"{question.number}. "))
        assert question.stem in block.text
        assert block.locations[0].page == question.page
        assert block.locations[0].bbox == question.bbox
        assert all(o.text in block.text for o in question.options)
    assert all(line in texts for line in truth.answer_key_lines)
    images = [b for b in doc.blocks if b.type is BlockType.IMAGE]
    assert len(images) == 1
    caption = next(b for b in doc.blocks if b.id == images[0].caption_block_id)
    assert caption.text.startswith("[그림 1]")


def test_load_truth_document_rejects_unknown_kind(tmp_path: Path) -> None:
    path = tmp_path / "x.truth.json"
    path.write_text('{"kind": "poster"}', encoding="utf-8")
    with pytest.raises(ValueError, match="poster"):
        load_truth_document(path)


def test_registered_document_is_returned_by_content_hash(tmp_path: Path) -> None:
    parser = FakeParser.from_truth_files(_truth_path(f) for f in (*BOOKS, "questions-ko"))
    doc = parser.parse(OUT_DIR / "book-ko.pdf")
    assert doc.source_sha256 == sha256_hex((OUT_DIR / "book-ko.pdf").read_bytes())
    assert doc.source_path == "book-ko.pdf"
    assert doc.parser_version == FAKE_PARSER_VERSION
    copy = tmp_path / "upload.bin"
    copy.write_bytes((OUT_DIR / "book-ko.pdf").read_bytes())
    renamed = parser.parse(copy, source_path="ws/a/doc/b/original.pdf")
    assert renamed.source_path == "ws/a/doc/b/original.pdf"
    assert renamed.blocks == doc.blocks


def test_text_input_builds_pages_headings_and_blocks(tmp_path: Path) -> None:
    path = tmp_path / "notes.txt"
    path.write_text(
        "# Chapter\n\nFirst  paragraph.\n\n## Section\n\f\fLast page.", encoding="utf-8"
    )
    doc = FakeParser().parse(path)
    assert [p.page for p in doc.pages] == [1, 2, 3]
    assert [p.text_layer for p in doc.pages] == [True, False, True]
    assert [(b.type, b.text, b.heading_level) for b in doc.blocks] == [
        (BlockType.HEADING, "Chapter", 1),
        (BlockType.TEXT, "First paragraph.", None),
        (BlockType.HEADING, "Section", 2),
        (BlockType.TEXT, "Last page.", None),
    ]
    assert [b.locations[0].page for b in doc.blocks] == [1, 1, 1, 3]
    boxes = [b.locations[0].bbox for b in doc.blocks[:3]]
    assert all(box is not None for box in boxes)
    assert boxes[0] is not None
    assert boxes[1] is not None
    assert boxes[0].y1 < boxes[1].y0
    assert doc.source_sha256 == sha256_hex(path.read_bytes())
    assert FakeParser().parse(path).model_dump_json() == doc.model_dump_json()


def test_unknown_binary_input_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "unknown.pdf"
    path.write_bytes(b"%PDF-1.7\n\xff\xfe binary")
    with pytest.raises(UnknownDocumentError):
        FakeParser().parse(path)


def test_block_ids_are_stable_and_depend_on_page_order_and_content() -> None:
    def build(pages: list[list[str]]) -> list[str]:
        doc = document_from_pages(pages, source_path="a.pdf", source_sha256="0" * 64)
        return [b.id for b in doc.blocks]

    first = build([["# A", "x"], ["y"]])
    assert first == build([["# A", "x"], ["y"]])
    assert first[0].startswith("p1-b001-")
    assert first[2].startswith("p2-b001-")
    assert build([["# A", "z"], ["y"]])[1] != first[1]
    assert build([["# A", "z"], ["y"]])[2] == first[2]


def test_document_needs_a_page() -> None:
    with pytest.raises(ValueError, match="page"):
        document_from_pages([], source_path="a.pdf", source_sha256="0" * 64)


def test_helpers_normalize_text_tables_and_bboxes() -> None:
    assert normalize_text(" a\n\tb  c ") == "a b c"
    assert normalize_text("가") == "가"  # NFC
    assert table_text([["a", "b"], ["c", "d"]]) == "a | b\nc | d"
    box = make_bbox(-3.0, 10.004, 700.0, 20.0, 595.28, 841.89)
    assert box is not None
    assert (box.x0, box.y0, box.x1, box.y1) == (0.0, 10.0, 595.28, 20.0)
    assert make_bbox(10.0, 5.0, 10.0, 9.0, 100.0, 100.0) is None
