"""Docling-backed ``PdfParser`` (requires the ``parser`` extra).

This is the only module in ``book_core`` that imports Docling. Mapping to the contract:

- Reading order is Docling's body order. Page headers/footers are Docling "furniture" and are
  dropped (they are not canonical text).
- ``title``/``section_header`` -> ``heading`` (``heading_level`` = Docling's level, title = 1);
  text, paragraph, caption, footnote, reference, code and list items -> ``text`` (list items keep
  their printed marker, e.g. ``1.`` or ``A.``); ``formula`` -> ``formula``; ``table`` and
  ``document_index`` (a printed TOC) -> ``table`` with cells; ``picture`` -> ``image`` with empty
  text. Other items (forms, key-value regions) are skipped.
- Captions are separate ``text`` blocks linked via ``caption_block_id``; a caption printed above
  its table/figure is placed before it in reading order.
- OCR fallback: only RapidOCR, configured explicitly (Docling's auto engine selection silently
  passes pages through when no engine is installed). ``ocr_applied`` means RapidOCR ran.
- Bboxes are converted to the contract convention (PDF points, top-left origin), clamped to the
  page and rounded to 0.01 pt. Pages are 1-based. A paragraph that continues on the next page
  stays two blocks; merging is the structure step's job (M1.3).
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
from io import BytesIO
from pathlib import Path

import pypdfium2  # type: ignore[import-untyped]  # no py.typed; used only here
from docling.datamodel.accelerator_options import AcceleratorOptions
from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc.document import DoclingDocument
from docling_core.types.doc.items.node import DocItem
from docling_core.types.doc.items.picture.picture import PictureItem
from docling_core.types.doc.items.table.table import TableItem
from docling_core.types.doc.items.text import (
    FormulaItem,
    ListItem,
    SectionHeaderItem,
    TextItem,
    TitleItem,
)
from docling_core.types.doc.labels import DocItemLabel
from docling_core.types.io import DocumentStream

from book_core.contracts import (
    BlockType,
    PageInfo,
    ParsedDocument,
    SourceLocation,
    TableContent,
)
from book_core.parser._blocks import (
    COORD_DECIMALS,
    DraftBlock,
    finalize_blocks,
    make_bbox,
    normalize_text,
    table_text,
)
from book_core.parser.base import ParserError, ParserOptions, sha256_hex

ADAPTER_VERSION = 1
"""Bump when the Docling -> contract mapping changes output for the same Docling version."""

_DROPPED_TEXT_LABELS = frozenset({DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER})
_CAPTION_TOLERANCE = 1.0


def _dist_version(*names: str) -> str:
    for name in names:
        try:
            return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    return "unknown"


def docling_parser_version() -> str:
    return (
        f"docling/{_dist_version('docling', 'docling-slim')}"
        f" docling-ibm-models/{_dist_version('docling-ibm-models')}"
        f" book-core-docling/{ADAPTER_VERSION}"
    )


OCR_ENGINE_MODULES = ("rapidocr", "onnxruntime")


def ocr_engine_available() -> bool:
    """Whether the RapidOCR engine (``ocr`` extra) is importable."""
    return all(importlib.util.find_spec(name) is not None for name in OCR_ENGINE_MODULES)


def text_layer_pages(data: bytes) -> list[bool]:
    """Per page: whether the PDF has extractable (non-whitespace) text on it."""
    pdf = pypdfium2.PdfDocument(data)
    try:
        flags: list[bool] = []
        for index in range(len(pdf)):
            page = pdf[index]
            textpage = page.get_textpage()
            try:
                text = str(textpage.get_text_range())
            finally:
                textpage.close()
                page.close()
            flags.append(bool(text.strip()))
        return flags
    finally:
        pdf.close()


class DoclingParser:
    """``PdfParser`` on Docling's standard PDF pipeline (layout + TableFormer, CPU).

    Converters (and their models) are created lazily and reused across ``parse`` calls.
    """

    def __init__(self, options: ParserOptions | None = None) -> None:
        self._options = options or ParserOptions()
        if self._options.ocr and not ocr_engine_available():
            raise ParserError(
                "OCR requested but RapidOCR is not installed (install book-core[ocr])"
            )
        self._converters: dict[bool, DocumentConverter] = {}
        self._version = docling_parser_version()

    @property
    def parser_version(self) -> str:
        return self._version

    @property
    def options(self) -> ParserOptions:
        return self._options

    def parse(self, path: Path, *, source_path: str | None = None) -> ParsedDocument:
        data = path.read_bytes()
        return self.parse_bytes(data, source_path=source_path or path.name)

    def parse_bytes(self, data: bytes, *, source_path: str) -> ParsedDocument:
        try:
            text_layers = text_layer_pages(data)
        except pypdfium2.PdfiumError as exc:
            raise ParserError(f"not a readable PDF: {source_path}") from exc
        run_ocr = self._options.ocr and not all(text_layers)

        stream = DocumentStream(name=Path(source_path).name or "document.pdf", stream=BytesIO(data))
        result = self._converter(run_ocr).convert(stream, raises_on_error=False)
        if result.status is not ConversionStatus.SUCCESS:
            errors = "; ".join(e.error_message for e in result.errors)
            raise ParserError(f"docling conversion {result.status.value}: {errors}")
        return document_from_docling(
            result.document,
            text_layers=text_layers,
            source_path=source_path,
            source_sha256=sha256_hex(data),
            parser_version=self._version,
            ocr_applied=run_ocr,
        )

    def pipeline_options(self, ocr: bool) -> PdfPipelineOptions:
        options = PdfPipelineOptions(
            do_ocr=ocr,
            do_table_structure=self._options.table_structure,
            artifacts_path=self._options.artifacts_path,
            accelerator_options=AcceleratorOptions(device=self._options.device),
            document_timeout=self._options.document_timeout,
        )
        if ocr:
            options.ocr_options = RapidOcrOptions(lang=[self._options.ocr_lang])
        return options

    def _converter(self, ocr: bool) -> DocumentConverter:
        converter = self._converters.get(ocr)
        if converter is None:
            pipeline = self.pipeline_options(ocr)
            converter = DocumentConverter(
                format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline)}
            )
            self._converters[ocr] = converter
        return converter


def document_from_docling(
    doc: DoclingDocument,
    *,
    text_layers: list[bool],
    source_path: str,
    source_sha256: str,
    parser_version: str,
    ocr_applied: bool = False,
) -> ParsedDocument:
    """Map a converted ``DoclingDocument`` to the contract (pure; no models involved)."""
    pages = _pages(doc, text_layers)
    drafts = _drafts(doc, {p.page: p for p in pages})
    return ParsedDocument(
        source_path=source_path,
        source_sha256=source_sha256,
        parser_version=parser_version,
        ocr_applied=ocr_applied,
        pages=pages,
        blocks=finalize_blocks(drafts),
    )


def _pages(doc: DoclingDocument, text_layers: list[bool]) -> tuple[PageInfo, ...]:
    if len(doc.pages) != len(text_layers):
        raise ParserError(f"docling saw {len(doc.pages)} pages, the PDF has {len(text_layers)}")
    return tuple(
        PageInfo(
            page=number,
            width=round(doc.pages[number].size.width, COORD_DECIMALS),
            height=round(doc.pages[number].size.height, COORD_DECIMALS),
            text_layer=text_layers[number - 1],
        )
        for number in sorted(doc.pages)
    )


Span = tuple[int, int]


def _page_locations(
    item: DocItem, doc: DoclingDocument, pages: dict[int, PageInfo]
) -> list[tuple[SourceLocation, Span]]:
    """One location per page the item touches (consecutive provenance boxes on the same page
    are merged), with the character span of the item text that lies on that page."""
    merged: list[tuple[int, list[float], Span]] = []
    for prov in item.prov:
        if prov.page_no not in pages:
            continue
        box = prov.bbox.to_top_left_origin(doc.pages[prov.page_no].size.height)
        coords = [box.l, box.t, box.r, box.b]
        span = (prov.charspan[0], prov.charspan[1])
        if merged and merged[-1][0] == prov.page_no:
            page_no, last, last_span = merged[-1]
            union = [
                min(last[0], coords[0]),
                min(last[1], coords[1]),
                max(last[2], coords[2]),
                max(last[3], coords[3]),
            ]
            merged[-1] = (page_no, union, (last_span[0], span[1]))
        else:
            merged.append((prov.page_no, coords, span))
    return [
        (
            SourceLocation(
                page=page_no,
                bbox=make_bbox(
                    coords[0],
                    coords[1],
                    coords[2],
                    coords[3],
                    pages[page_no].width,
                    pages[page_no].height,
                ),
            ),
            span,
        )
        for page_no, coords, span in merged
    ]


def _split_text(item: TextItem, spans: list[Span]) -> list[str] | None:
    """Per-page texts of an item Docling joined across pages, cut at its character spans."""
    source = item.orig
    ends = [0, *(bound for span in spans for bound in span)]
    if ends != sorted(ends) or ends[-1] > len(source):
        return None
    parts = [normalize_text(source[start:end]) for start, end in spans]
    return parts if all(parts) else None


def _table(item: TableItem) -> TableContent | None:
    grid = item.data.grid
    rows = tuple(tuple(normalize_text(cell.text) for cell in row) for row in grid)
    if not rows or not rows[0]:
        return None
    header_rows = 0
    for row in grid:
        if not any(cell.column_header for cell in row):
            break
        header_rows += 1
    return TableContent(rows=rows, header_rows=header_rows)


def _draft(
    item: DocItem, locations: list[SourceLocation], text_part: str | None = None
) -> DraftBlock | None:
    """Map one Docling item to a block, or ``None`` if it carries no canonical content.

    ``text_part`` replaces the item text when the item is split into per-page blocks.
    """
    locs = tuple(locations)
    if isinstance(item, TableItem):
        table = _table(item)
        text = table_text(table.rows) if table is not None else ""
        return DraftBlock(type=BlockType.TABLE, text=text, locations=locs, table=table)
    if isinstance(item, PictureItem):
        return DraftBlock(type=BlockType.IMAGE, text="", locations=locs)
    if not isinstance(item, TextItem) or item.label in _DROPPED_TEXT_LABELS:
        return None

    text = normalize_text(item.text if text_part is None else text_part)
    if isinstance(item, ListItem) and item.marker and text_part is None:
        text = normalize_text(f"{item.marker} {text}")
    if isinstance(item, FormulaItem):
        text = text or normalize_text(item.orig)
    if not text:
        return None

    if isinstance(item, SectionHeaderItem):
        return DraftBlock(
            type=BlockType.HEADING, text=text, locations=locs, heading_level=item.level
        )
    if isinstance(item, TitleItem):
        return DraftBlock(type=BlockType.HEADING, text=text, locations=locs, heading_level=1)
    if isinstance(item, FormulaItem):
        return DraftBlock(type=BlockType.FORMULA, text=text, locations=locs)
    return DraftBlock(type=BlockType.TEXT, text=text, locations=locs)


def _is_above(caption: DraftBlock, parent: DraftBlock) -> bool:
    cap, par = caption.locations[0], parent.locations[0]
    if cap.page != par.page or cap.bbox is None or par.bbox is None:
        return False
    return cap.bbox.y1 <= par.bbox.y0 + _CAPTION_TOLERANCE


def _drafts(doc: DoclingDocument, pages: dict[int, PageInfo]) -> list[DraftBlock]:
    """Docling body items in reading order, captions linked to (and placed around) parents."""
    entries: list[tuple[str, DraftBlock, list[str]]] = []
    for item, _level in doc.iterate_items():
        if not isinstance(item, DocItem):
            continue
        located = _page_locations(item, doc, pages)
        if not located:
            continue
        locations = [loc for loc, _ in located]
        parts = (
            _split_text(item, [span for _, span in located])
            if isinstance(item, TextItem) and len(located) > 1
            else None
        )
        if parts is not None:
            # A paragraph Docling joined across pages: one block per page (M1.3 merges).
            if isinstance(item, ListItem) and item.marker:
                parts[0] = f"{item.marker} {parts[0]}"
            for part_no, (location, part) in enumerate(zip(locations, parts, strict=True)):
                draft = _draft(item, [location], part)
                if draft is not None:
                    entries.append(
                        (f"{item.self_ref}@{part_no}" if part_no else item.self_ref, draft, [])
                    )
            continue
        draft = _draft(item, locations)
        if draft is None:
            continue
        captions = (
            [ref.cref for ref in item.captions] if isinstance(item, TableItem | PictureItem) else []
        )
        entries.append((item.self_ref, draft, captions))

    by_ref = {ref: draft for ref, draft, _ in entries}
    owned = {cref for _, _, captions in entries for cref in captions if cref in by_ref}
    ordered: list[DraftBlock] = []
    caption_of: dict[int, DraftBlock] = {}
    for ref, draft, captions in entries:
        if ref in owned:
            continue
        caps = [by_ref[c] for c in captions if c in by_ref]
        above = [c for c in caps if _is_above(c, draft)]
        ordered.extend(above)
        ordered.append(draft)
        ordered.extend(c for c in caps if all(c is not a for a in above))
        if caps:
            caption_of[id(draft)] = caps[0]

    index = {id(draft): i for i, draft in enumerate(ordered)}
    for draft in ordered:
        caption = caption_of.get(id(draft))
        if caption is not None:
            draft.caption_index = index[id(caption)]
    return ordered
