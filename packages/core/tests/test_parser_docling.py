"""Docling parser adapter against the synthetic fixture truth (M1.2).

Needs the ``parser`` extra (part of the root dev install) and the Docling layout/TableFormer
weights, which Docling downloads into the Hugging Face cache on first use.

Tolerances:
- Text: a truth block part matches a parsed block on the same page when both are equal after
  NFKC and removal of all whitespace (line-break/space differences only).
- Geometry: matched headings, paragraphs, images and tables overlap their truth bbox with
  IoU >= ``MIN_IOU``. Truth boxes span the font ascent/descent, Docling boxes the glyph cells,
  which is why single-line boxes land around 0.83 rather than 1.0.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from pathlib import Path

import pytest
from book_core.contracts import BBox, Block, BlockType, ParsedDocument
from book_core.parser import ParserError, ParserOptions, PdfParser
from book_core.parser.docling_adapter import DoclingParser, text_layer_pages
from fixture_truth import BookTruth, QuestionsTruth, TruthPart
from make_fixture_pdfs import OUT_DIR
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

BOOKS = ("book-ko", "book-en")
QUESTIONS = "questions-ko"
ALL_FIXTURES = (*BOOKS, QUESTIONS)
MIN_IOU = 0.75
BLOCK_ID = re.compile(r"^p\d+-b\d{3}-[0-9a-f]{10}$")


def _loose(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _iou(a: BBox, b: BBox) -> float:
    ix = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    iy = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    inter = ix * iy
    union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter
    return inter / union


def _book(fixture_id: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{fixture_id}.truth.json").read_bytes())


def _questions() -> QuestionsTruth:
    return QuestionsTruth.model_validate_json((OUT_DIR / f"{QUESTIONS}.truth.json").read_bytes())


@pytest.fixture(scope="session")
def parser() -> DoclingParser:
    return DoclingParser()


@pytest.fixture(scope="session")
def parsed(parser: DoclingParser) -> dict[str, ParsedDocument]:
    return {fixture_id: parser.parse(OUT_DIR / f"{fixture_id}.pdf") for fixture_id in ALL_FIXTURES}


def _on_page(doc: ParsedDocument, page: int) -> Iterator[tuple[int, Block]]:
    for index, block in enumerate(doc.blocks):
        if any(loc.page == page for loc in block.locations):
            yield index, block


def _match(doc: ParsedDocument, part: TruthPart, text: str | None = None) -> tuple[int, Block]:
    wanted = _loose(text if text is not None else part.text)
    hits = [(i, b) for i, b in _on_page(doc, part.page) if _loose(b.text) == wanted]
    assert len(hits) == 1, f"page {part.page}: {len(hits)} blocks match {part.text!r}"
    return hits[0]


def _bbox_on(block: Block, page: int) -> BBox:
    bbox = next(loc.bbox for loc in block.locations if loc.page == page)
    assert bbox is not None
    return bbox


def test_docling_parser_satisfies_protocol(parser: DoclingParser) -> None:
    assert isinstance(parser, PdfParser)
    assert parser.parser_version.startswith("docling/")
    assert "book-core-docling/" in parser.parser_version


@pytest.mark.parametrize("fixture_id", ALL_FIXTURES)
def test_pages_hash_and_provenance(parsed: dict[str, ParsedDocument], fixture_id: str) -> None:
    doc = parsed[fixture_id]
    truth = _questions() if fixture_id == QUESTIONS else _book(fixture_id)
    assert doc.source_sha256 == truth.sha256
    assert doc.source_path == truth.file
    assert not doc.ocr_applied
    assert [p.page for p in doc.pages] == list(range(1, truth.page_count + 1))
    for page, expected in zip(doc.pages, truth.pages, strict=True):
        assert page.width == pytest.approx(expected.width, abs=0.01)
        assert page.height == pytest.approx(expected.height, abs=0.01)
        assert page.text_layer
    assert all(BLOCK_ID.match(b.id) for b in doc.blocks)
    assert doc.sections == ()


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_every_truth_text_part_is_found_on_its_page(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    for block in truth.blocks:
        if block.type not in (BlockType.TEXT, BlockType.HEADING):
            continue
        for part in block.parts:
            _, found = _match(doc, part)
            assert found.type is block.type, f"{block.id}: parsed as {found.type}"


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_body_headings_are_exactly_the_truth_headings(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    body = [b for b in doc.blocks if b.locations[0].page != truth.toc_page]
    parsed_headings = [b.text for b in body if b.type is BlockType.HEADING]
    assert parsed_headings == [b.text for b in truth.blocks if b.type is BlockType.HEADING]
    assert all(b.heading_level is not None for b in body if b.type is BlockType.HEADING)


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_blocks_overlap_truth_bboxes_and_keep_reading_order(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    order: list[int] = []
    for block in truth.blocks:
        for part in block.parts:
            if block.type is BlockType.IMAGE:
                candidates = [
                    (i, b) for i, b in _on_page(doc, part.page) if b.type is BlockType.IMAGE
                ]
                assert len(candidates) == 1
                index, found = candidates[0]
            else:
                index, found = _match(doc, part, block.text if block.table else None)
            iou = _iou(_bbox_on(found, part.page), part.bbox)
            assert iou >= MIN_IOU, f"{block.id} page {part.page}: IoU {iou:.2f}"
            order.append(index)
    assert order == sorted(order), "parsed reading order differs from truth"


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_table_cells_match_truth(parsed: dict[str, ParsedDocument], fixture_id: str) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    truth_tables = [b for b in truth.blocks if b.table is not None]
    assert truth_tables
    for block in truth_tables:
        assert block.table is not None
        _, found = _match(doc, block.parts[0], block.text)
        assert found.type is BlockType.TABLE
        assert found.table is not None
        assert found.table.rows == block.table.rows
        assert found.table.header_rows == block.table.header_rows
        assert found.text == block.text


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_figure_and_table_captions_are_linked(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    by_id = {b.id: b for b in doc.blocks}
    truth_by_id = {b.id: b for b in truth.blocks}
    images = [b for b in truth.blocks if b.type is BlockType.IMAGE]
    assert images
    for image in images:
        assert image.caption_block_id is not None
        caption = truth_by_id[image.caption_block_id]
        parsed_images = [
            b for _, b in _on_page(doc, image.parts[0].page) if b.type is BlockType.IMAGE
        ]
        assert len(parsed_images) == 1
        assert parsed_images[0].text == ""
        assert parsed_images[0].caption_block_id is not None
        assert by_id[parsed_images[0].caption_block_id].text == caption.text
    # Table captions are printed above the table: linked and placed before it.
    for index, table in enumerate(truth.blocks):
        if table.table is None:
            continue
        caption = truth.blocks[index - 1]
        assert caption.id.endswith("-caption")
        table_index, found = _match(doc, table.parts[0], table.text)
        assert found.caption_block_id is not None
        assert by_id[found.caption_block_id].text == caption.text
        assert doc.blocks[table_index - 1].id == found.caption_block_id


@pytest.mark.parametrize("fixture_id", ALL_FIXTURES)
def test_running_headers_and_page_numbers_are_dropped(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc = parsed[fixture_id]
    truth = _questions() if fixture_id == QUESTIONS else _book(fixture_id)
    noise = [(page.page, item) for page in truth.pages for item in page.noise]
    assert noise
    for page, item in noise:
        for _, block in _on_page(doc, page):
            assert _loose(item.text) not in _loose(block.text), f"noise kept: {block.text!r}"
            bbox = _bbox_on(block, page)
            assert _iou(bbox, item.bbox) == 0.0


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_cross_page_paragraph_stays_split_per_page(
    parsed: dict[str, ParsedDocument], fixture_id: str
) -> None:
    doc, truth = parsed[fixture_id], _book(fixture_id)
    for block_id in truth.cross_page_block_ids:
        block = next(b for b in truth.blocks if b.id == block_id)
        first, last = block.parts[0], block.parts[-1]
        first_index, first_block = _match(doc, first)
        last_index, last_block = _match(doc, last)
        assert last_index == first_index + 1
        assert [loc.page for loc in first_block.locations] == [first.page]
        assert [loc.page for loc in last_block.locations] == [last.page]
        assert list(_on_page(doc, first.page))[-1][1] is first_block
        assert next(iter(_on_page(doc, last.page)))[1] is last_block


def test_question_stems_options_and_answer_key_are_found(
    parsed: dict[str, ParsedDocument],
) -> None:
    doc, truth = parsed[QUESTIONS], _questions()
    for question in truth.questions:
        part = TruthPart(page=question.page, bbox=question.bbox, text=question.stem)
        _, stem = _match(doc, part, f"{question.number}. {question.stem}")
        stem_box = _bbox_on(stem, question.page)
        assert question.bbox.y0 <= stem_box.y0 < stem_box.y1 <= question.bbox.y1
        for option in question.options:
            sep = ". " if question.option_style == "latin" else " "
            _match(doc, part, f"{option.label}{sep}{option.text}")
        if question.figure is not None:
            caption = TruthPart(
                page=question.page, bbox=question.figure.caption_bbox, text=question.figure.caption
            )
            _, found = _match(doc, caption)
            assert _iou(_bbox_on(found, question.page), question.figure.caption_bbox) >= MIN_IOU
    for line in truth.answer_key_lines:
        _match(doc, TruthPart(page=truth.answer_key_page, bbox=truth.questions[0].bbox, text=line))


def test_same_bytes_give_identical_json(
    parser: DoclingParser, parsed: dict[str, ParsedDocument]
) -> None:
    again = parser.parse(OUT_DIR / "book-ko.pdf")
    assert again.model_dump_json() == parsed["book-ko"].model_dump_json()
    fresh = DoclingParser().parse(OUT_DIR / "book-en.pdf", source_path="book-en.pdf")
    assert fresh.model_dump_json() == parsed["book-en"].model_dump_json()


def test_source_path_defaults_to_file_name_and_can_be_overridden(parser: DoclingParser) -> None:
    doc = parser.parse(OUT_DIR / "questions-ko.pdf", source_path="ws/1/doc/2/original.pdf")
    assert doc.source_path == "ws/1/doc/2/original.pdf"


def _pdf_with_image_only_page(path: Path) -> None:
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=True)
    pdf.setFont("Helvetica", 12)
    pdf.drawString(72, 760, "A page with a text layer.")
    pdf.showPage()
    pdf.rect(72, 400, 300, 300, fill=1)  # no text: what a scanned page looks like to a parser
    pdf.showPage()
    pdf.save()


def test_pages_without_text_layer_are_flagged(parser: DoclingParser, tmp_path: Path) -> None:
    path = tmp_path / "scan.pdf"
    _pdf_with_image_only_page(path)
    assert text_layer_pages(path.read_bytes()) == [True, False]
    doc = parser.parse(path)
    assert [p.text_layer for p in doc.pages] == [True, False]
    assert not doc.ocr_applied
    assert all(b.text == "" for b in doc.blocks if b.locations[0].page == 2)


def test_ocr_runs_only_when_enabled_and_needed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "scan.pdf"
    _pdf_with_image_only_page(path)
    ocr_parser = DoclingParser(ParserOptions(ocr=True))
    requested: list[bool] = []
    real_converter = DoclingParser._converter

    def spy(self: DoclingParser, ocr: bool) -> object:
        requested.append(ocr)
        # The OCR engine is an optional extra; run the text pipeline in its place.
        return real_converter(self, False)

    monkeypatch.setattr(DoclingParser, "_converter", spy)
    assert ocr_parser.parse(path).ocr_applied
    assert not ocr_parser.parse(OUT_DIR / "book-en.pdf").ocr_applied
    assert not DoclingParser().parse(path).ocr_applied
    assert requested == [True, False, False]


def test_non_pdf_input_raises_parser_error(parser: DoclingParser, tmp_path: Path) -> None:
    path = tmp_path / "not-a.pdf"
    path.write_bytes(b"plain text, not a PDF")
    with pytest.raises(ParserError):
        parser.parse(path)
