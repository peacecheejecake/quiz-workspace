"""Docling -> ``ParsedDocument`` mapping and OCR decisions without model weights (M1.2).

``DoclingDocument``s are built in code, so these tests never load or download models; the
real-model quality tests are ``test_parser_docling.py`` (marker ``models``).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import BBox, BlockType, ParsedDocument
from book_core.parser import ParserError, ParserOptions, PdfParser, docling_adapter
from book_core.parser.docling_adapter import (
    DoclingParser,
    document_from_docling,
    text_layer_pages,
)
from docling.datamodel.base_models import ConversionStatus
from docling.datamodel.pipeline_options import RapidOcrOptions
from docling_core.types.doc.base import BoundingBox, CoordOrigin, Size
from docling_core.types.doc.common.content_layer import ContentLayer
from docling_core.types.doc.common.reference import ProvenanceItem
from docling_core.types.doc.document import DoclingDocument
from docling_core.types.doc.items.table.table_data import TableCell, TableData
from docling_core.types.doc.labels import DocItemLabel
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

WIDTH, HEIGHT = 600.0, 800.0
BLOCK_ID = re.compile(r"^p\d+-b\d{3}-[0-9a-f]{10}$")
SPLIT_TEXT = "Water keeps moving and the total amount stays constant."
SPLIT_AT = SPLIT_TEXT.index(" the total")


def _prov(
    page: int, left: float, top: float, right: float, bottom: float, span: tuple[int, int] = (0, 0)
) -> ProvenanceItem:
    """Bottom-left-origin box as Docling emits for PDFs (``top`` > ``bottom``)."""
    box = BoundingBox(l=left, t=top, r=right, b=bottom, coord_origin=CoordOrigin.BOTTOMLEFT)
    return ProvenanceItem(page_no=page, bbox=box, charspan=span)


def _cell(text: str, row: int, col: int, *, header: bool = False) -> TableCell:
    return TableCell(
        text=text,
        start_row_offset_idx=row,
        end_row_offset_idx=row + 1,
        start_col_offset_idx=col,
        end_col_offset_idx=col + 1,
        column_header=header,
    )


def _docling_document(paragraph: str = "Body paragraph on page one.") -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    doc.add_page(page_no=1, size=Size(width=WIDTH, height=HEIGHT))
    doc.add_page(page_no=2, size=Size(width=WIDTH, height=HEIGHT))

    doc.add_text(
        label=DocItemLabel.PAGE_HEADER,
        text="Running head",
        prov=_prov(1, 50, 780, 200, 770),
        content_layer=ContentLayer.FURNITURE,
    )
    doc.add_title(text="Book Title", prov=_prov(1, 50, 760, 300, 740))
    doc.add_heading(text="1.1  Section", level=2, prov=_prov(1, 50, 730, 200, 715))
    doc.add_text(label=DocItemLabel.TEXT, text=paragraph, prov=_prov(1, 50, 700, 550, 660))
    group = doc.add_list_group()
    doc.add_list_item(
        text="Pick the answer.",
        enumerated=True,
        marker="1.",
        parent=group,
        prov=_prov(1, 60, 650, 400, 640),
    )
    doc.add_list_item(
        text="first option",
        enumerated=True,
        marker="A.",
        parent=group,
        prov=_prov(1, 80, 635, 300, 625),
    )

    table = doc.add_table(
        data=TableData(
            num_rows=2,
            num_cols=2,
            table_cells=[
                _cell("Stage", 0, 0, header=True),
                _cell("Time", 0, 1, header=True),
                _cell("Settle", 1, 0),
                _cell("3  h", 1, 1),
            ],
        ),
        prov=_prov(1, 50, 590, 550, 500),
    )
    table_caption = doc.add_text(
        label=DocItemLabel.CAPTION,
        text="Table 1. Stages",
        parent=table,
        prov=_prov(1, 50, 605, 250, 595),
    )
    table.captions.append(table_caption.get_ref())

    picture = doc.add_picture(prov=_prov(1, 100, 480, 500, 300))
    figure_caption = doc.add_text(
        label=DocItemLabel.CAPTION,
        text="Figure 1. Cycle",
        parent=picture,
        prov=_prov(1, 100, 290, 300, 280),
    )
    picture.captions.append(figure_caption.get_ref())

    split = doc.add_text(
        label=DocItemLabel.TEXT,
        text=SPLIT_TEXT,
        prov=_prov(1, 50, 120, 550, 60, (0, SPLIT_AT)),
    )
    split.prov.append(_prov(2, 50, 760, 550, 740, (SPLIT_AT + 1, len(SPLIT_TEXT))))
    doc.add_text(
        label=DocItemLabel.PAGE_FOOTER,
        text="- 1 -",
        prov=_prov(1, 290, 40, 310, 30),
        content_layer=ContentLayer.FURNITURE,
    )
    doc.add_text(label=DocItemLabel.TEXT, text="Next page text.", prov=_prov(2, 50, 700, 400, 690))
    # Out-of-page coordinates are clamped to the page.
    doc.add_text(label=DocItemLabel.TEXT, text="Bleeds off page.", prov=_prov(2, -5, 810, 620, 790))
    return doc


def _convert(doc: DoclingDocument, layers: list[bool] | None = None) -> ParsedDocument:
    return document_from_docling(
        doc,
        text_layers=layers or [True, True],
        source_path="synthetic.pdf",
        source_sha256="0" * 64,
        parser_version="docling/test",
    )


@pytest.fixture
def parsed() -> ParsedDocument:
    return _convert(_docling_document())


def _block(doc: ParsedDocument, text: str) -> Any:
    return next(b for b in doc.blocks if b.text == text)


def test_reading_order_types_and_furniture_drop(parsed: ParsedDocument) -> None:
    assert [(b.type, b.text) for b in parsed.blocks] == [
        (BlockType.HEADING, "Book Title"),
        (BlockType.HEADING, "1.1 Section"),
        (BlockType.TEXT, "Body paragraph on page one."),
        (BlockType.TEXT, "1. Pick the answer."),
        (BlockType.TEXT, "A. first option"),
        (BlockType.TEXT, "Table 1. Stages"),
        (BlockType.TABLE, "Stage | Time\nSettle | 3 h"),
        (BlockType.IMAGE, ""),
        (BlockType.TEXT, "Figure 1. Cycle"),
        (BlockType.TEXT, "Water keeps moving and"),
        (BlockType.TEXT, "the total amount stays constant."),
        (BlockType.TEXT, "Next page text."),
        (BlockType.TEXT, "Bleeds off page."),
    ]
    assert all("Running head" not in b.text and "- 1 -" not in b.text for b in parsed.blocks)


def test_bboxes_use_top_left_origin_clamped_to_page(parsed: ParsedDocument) -> None:
    assert parsed.pages[0].width == WIDTH
    assert parsed.pages[0].height == HEIGHT
    heading = _block(parsed, "1.1 Section")
    assert heading.locations[0].bbox == BBox(x0=50, y0=70, x1=200, y1=85)
    assert heading.locations[0].page == 1
    edge = _block(parsed, "Bleeds off page.")
    assert edge.locations[0].bbox == BBox(x0=0, y0=0, x1=WIDTH, y1=10)


def test_heading_levels(parsed: ParsedDocument) -> None:
    assert _block(parsed, "Book Title").heading_level == 1
    assert _block(parsed, "1.1 Section").heading_level == 2
    assert all(b.heading_level is None for b in parsed.blocks if b.type is not BlockType.HEADING)


def test_table_grid_and_captions(parsed: ParsedDocument) -> None:
    by_id = {b.id: b for b in parsed.blocks}
    table = next(b for b in parsed.blocks if b.type is BlockType.TABLE)
    assert table.table is not None
    assert table.table.rows == (("Stage", "Time"), ("Settle", "3 h"))
    assert table.table.header_rows == 1
    # Caption printed above the table is placed before it; a figure caption below stays after.
    assert table.caption_block_id is not None
    assert by_id[table.caption_block_id].text == "Table 1. Stages"
    image = next(b for b in parsed.blocks if b.type is BlockType.IMAGE)
    assert image.caption_block_id is not None
    assert by_id[image.caption_block_id].text == "Figure 1. Cycle"
    ids = [b.id for b in parsed.blocks]
    assert ids.index(table.caption_block_id) == ids.index(table.id) - 1
    assert ids.index(image.caption_block_id) == ids.index(image.id) + 1


def test_cross_page_item_is_split_per_page_by_char_spans(parsed: ParsedDocument) -> None:
    first = _block(parsed, "Water keeps moving and")
    second = _block(parsed, "the total amount stays constant.")
    assert [loc.page for loc in first.locations] == [1]
    assert [loc.page for loc in second.locations] == [2]
    assert second.locations[0].bbox == BBox(x0=50, y0=40, x1=550, y1=60)
    assert second.id.startswith("p2-b001-")


def test_block_ids_are_stable_and_content_addressed(parsed: ParsedDocument) -> None:
    assert all(BLOCK_ID.match(b.id) for b in parsed.blocks)
    assert _convert(_docling_document()).model_dump_json() == parsed.model_dump_json()
    changed = _convert(_docling_document(paragraph="A different paragraph."))
    differing = [
        (a.id, b.id) for a, b in zip(parsed.blocks, changed.blocks, strict=True) if a.id != b.id
    ]
    assert len(differing) == 1
    assert differing[0][0].startswith("p1-b003-")


def test_page_count_mismatch_is_an_error() -> None:
    with pytest.raises(ParserError, match="pages"):
        _convert(_docling_document(), layers=[True])


# --- PDF-level checks (pypdfium2 only) and the OCR decision -------------------------------


def _pdf(path: Path, *, image_only_second_page: bool) -> Path:
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=True)
    pdf.setFont("Helvetica", 12)
    pdf.drawString(72, 760, "A page with a text layer.")
    pdf.showPage()
    if image_only_second_page:
        pdf.rect(72, 400, 300, 300, fill=1)  # no text: what a scanned page looks like
    else:
        pdf.drawString(72, 760, "Second page text.")
    pdf.showPage()
    pdf.save()
    return path


class _FakeResult:
    status = ConversionStatus.SUCCESS

    def __init__(self, document: DoclingDocument) -> None:
        self.document = document
        self.errors: list[Any] = []


class _FakeConverter:
    def convert(self, source: object, raises_on_error: bool = True) -> _FakeResult:
        return _FakeResult(_docling_document())


@pytest.fixture
def requested_ocr(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    """Replace the model-backed converter; record whether OCR was requested."""
    requested: list[bool] = []

    def converter(self: DoclingParser, ocr: bool) -> _FakeConverter:
        requested.append(ocr)
        return _FakeConverter()

    monkeypatch.setattr(DoclingParser, "_converter", converter)
    return requested


def test_docling_parser_satisfies_protocol_without_loading_models() -> None:
    parser = DoclingParser()
    assert isinstance(parser, PdfParser)
    assert parser.parser_version.startswith("docling/")
    assert "book-core-docling/" in parser.parser_version


def test_text_layer_detection(tmp_path: Path) -> None:
    scan = _pdf(tmp_path / "scan.pdf", image_only_second_page=True)
    text = _pdf(tmp_path / "text.pdf", image_only_second_page=False)
    assert text_layer_pages(scan.read_bytes()) == [True, False]
    assert text_layer_pages(text.read_bytes()) == [True, True]


def test_ocr_requested_without_engine_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(docling_adapter, "ocr_engine_available", lambda: False)
    with pytest.raises(ParserError, match="RapidOCR"):
        DoclingParser(ParserOptions(ocr=True))


def test_default_install_has_no_ocr_engine() -> None:
    # The `ocr` extra is not part of the dev install; if this changes, revisit the default.
    assert not docling_adapter.ocr_engine_available()


def test_ocr_runs_only_when_enabled_needed_and_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, requested_ocr: list[bool]
) -> None:
    scan = _pdf(tmp_path / "scan.pdf", image_only_second_page=True)
    text = _pdf(tmp_path / "text.pdf", image_only_second_page=False)
    plain = DoclingParser()
    scanned = plain.parse(scan)
    assert not scanned.ocr_applied
    assert [p.text_layer for p in scanned.pages] == [True, False]

    monkeypatch.setattr(docling_adapter, "ocr_engine_available", lambda: True)
    ocr = DoclingParser(ParserOptions(ocr=True))
    assert ocr.parse(scan).ocr_applied
    assert not ocr.parse(text).ocr_applied
    assert requested_ocr == [False, True, False]


def test_ocr_pipeline_uses_rapidocr_explicitly() -> None:
    parser = DoclingParser()
    with_ocr = parser.pipeline_options(True)
    assert with_ocr.do_ocr
    assert isinstance(with_ocr.ocr_options, RapidOcrOptions)
    assert with_ocr.ocr_options.lang == ["korean"]
    assert not parser.pipeline_options(False).do_ocr


def test_non_pdf_input_raises_parser_error(tmp_path: Path, requested_ocr: list[bool]) -> None:
    path = tmp_path / "not-a.pdf"
    path.write_bytes(b"plain text, not a PDF")
    with pytest.raises(ParserError, match="not a readable PDF"):
        DoclingParser().parse(path)
    assert requested_ocr == []
