"""Deterministic ``PdfParser`` for tests and fake-adapter E2E runs (no Docling, no models).

``FakeParser`` returns a registered ``ParsedDocument`` for known file bytes (matched by sha256),
for example the ideal documents built from the fixture truth files, and otherwise builds a
document from UTF-8 text input: pages separated by form feeds (``\\f``), blocks by blank lines,
``#``-prefixed blocks are headings (``##`` = level 2).
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    Section,
    SourceLocation,
    TableContent,
)
from book_core.parser._blocks import DraftBlock, finalize_blocks, normalize_text
from book_core.parser.base import ParserError, sha256_hex

FAKE_PARSER_VERSION = "fake-parser/1"
A4_WIDTH = 595.28
A4_HEIGHT = 841.89
_MARGIN = 64.0
_LINE_HEIGHT = 14.0
_BLOCK_GAP = 10.0
_CHARS_PER_LINE = 80


class UnknownDocumentError(ParserError):
    """``FakeParser`` has no document registered for these bytes and they are not text."""


def document_from_pages(
    pages: Sequence[Sequence[str]],
    *,
    source_path: str,
    source_sha256: str,
    parser_version: str = FAKE_PARSER_VERSION,
) -> ParsedDocument:
    """Build an A4 ``ParsedDocument`` with synthetic stacked bboxes from per-page block texts.

    Blocks starting with ``#`` are headings (level = number of ``#``); a page without blocks is
    flagged as having no text layer.
    """
    if not pages:
        raise ValueError("a document needs at least one page")
    drafts: list[DraftBlock] = []
    for page_no, blocks in enumerate(pages, start=1):
        top = _MARGIN
        for raw in blocks:
            heading_level = len(raw) - len(raw.lstrip("#")) if raw.startswith("#") else None
            text = normalize_text(raw.lstrip("#") if heading_level else raw)
            if not text:
                continue
            lines = max(1, math.ceil(len(text) / _CHARS_PER_LINE))
            bottom = min(top + lines * _LINE_HEIGHT, A4_HEIGHT - _MARGIN)
            bbox = (
                BBox(x0=_MARGIN, y0=top, x1=A4_WIDTH - _MARGIN, y1=bottom) if top < bottom else None
            )
            drafts.append(
                DraftBlock(
                    type=BlockType.HEADING if heading_level else BlockType.TEXT,
                    text=text,
                    locations=(SourceLocation(page=page_no, bbox=bbox),),
                    heading_level=heading_level,
                )
            )
            top = min(bottom + _BLOCK_GAP, A4_HEIGHT - _MARGIN)
    return ParsedDocument(
        source_path=source_path,
        source_sha256=source_sha256,
        parser_version=parser_version,
        pages=tuple(
            PageInfo(page=n, width=A4_WIDTH, height=A4_HEIGHT, text_layer=bool(blocks))
            for n, blocks in enumerate(pages, start=1)
        ),
        blocks=finalize_blocks(drafts),
    )


def document_from_text(text: str, *, source_path: str, source_sha256: str) -> ParsedDocument:
    """``document_from_pages`` over ``\\f``-separated pages of blank-line-separated blocks."""
    pages = [
        [block for block in page.split("\n\n") if block.strip()]
        for page in text.replace("\r\n", "\n").split("\f")
    ]
    return document_from_pages(pages, source_path=source_path, source_sha256=source_sha256)


def _bbox(raw: Mapping[str, Any] | None) -> BBox | None:
    return BBox.model_validate(raw) if raw is not None else None


def _book_truth_document(data: Mapping[str, Any]) -> ParsedDocument:
    levels = {s["id"]: s["level"] for s in data["sections"]}
    blocks = []
    for raw in data["blocks"]:
        block_type = BlockType(raw["type"])
        table = raw.get("table")
        blocks.append(
            Block(
                id=raw["id"],
                type=block_type,
                text=raw["text"],
                section_id=raw.get("section_id"),
                locations=tuple(
                    SourceLocation(page=part["page"], bbox=_bbox(part["bbox"]))
                    for part in raw["parts"]
                ),
                heading_level=(
                    levels.get(raw.get("section_id")) if block_type is BlockType.HEADING else None
                ),
                table=TableContent.model_validate(table) if table is not None else None,
                caption_block_id=raw.get("caption_block_id"),
            )
        )
    return ParsedDocument(
        source_path=data["file"],
        source_sha256=data["sha256"],
        parser_version=FAKE_PARSER_VERSION,
        pages=tuple(
            PageInfo(page=p["page"], width=p["width"], height=p["height"]) for p in data["pages"]
        ),
        sections=tuple(
            Section(id=s["id"], title=s["title"], level=s["level"], parent_id=s.get("parent_id"))
            for s in data["sections"]
        ),
        blocks=tuple(blocks),
    )


def _questions_truth_document(data: Mapping[str, Any]) -> ParsedDocument:
    """Title, instructions, one block per question (number, stem, options as printed lines),
    figures with captions, and the answer key lines."""
    drafts = [
        DraftBlock(
            type=BlockType.HEADING,
            text=normalize_text(data["title"]),
            locations=(SourceLocation(page=1),),
            heading_level=1,
        ),
        DraftBlock(
            type=BlockType.TEXT,
            text=normalize_text(data["instructions"]),
            locations=(SourceLocation(page=1),),
        ),
    ]
    for question in data["questions"]:
        separator = ". " if question.get("option_style") == "latin" else " "
        lines = [f"{question['number']}. {question['stem']}"]
        lines += [f"{o['label']}{separator}{o['text']}" for o in question["options"]]
        drafts.append(
            DraftBlock(
                type=BlockType.TEXT,
                text="\n".join(lines),
                locations=(SourceLocation(page=question["page"], bbox=_bbox(question["bbox"])),),
            )
        )
        figure = question.get("figure")
        if figure is not None:
            drafts.append(
                DraftBlock(
                    type=BlockType.IMAGE,
                    text="",
                    locations=(SourceLocation(page=figure["page"], bbox=_bbox(figure["bbox"])),),
                    caption_index=len(drafts) + 1,
                )
            )
            drafts.append(
                DraftBlock(
                    type=BlockType.TEXT,
                    text=normalize_text(figure["caption"]),
                    locations=(
                        SourceLocation(page=figure["page"], bbox=_bbox(figure["caption_bbox"])),
                    ),
                )
            )
    drafts += [
        DraftBlock(
            type=BlockType.TEXT,
            text=normalize_text(line),
            locations=(SourceLocation(page=data["answer_key_page"]),),
        )
        for line in data["answer_key_lines"]
    ]
    return ParsedDocument(
        source_path=data["file"],
        source_sha256=data["sha256"],
        parser_version=FAKE_PARSER_VERSION,
        pages=tuple(
            PageInfo(page=p["page"], width=p["width"], height=p["height"]) for p in data["pages"]
        ),
        blocks=finalize_blocks(drafts),
    )


def load_truth_document(path: Path) -> ParsedDocument:
    """Ideal ``ParsedDocument`` of a synthetic fixture from its ``*.truth.json``
    (``tests/fixtures/pdfs``). Books mirror ``BookTruth.to_parsed_document()``."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("kind") == "book":
        return _book_truth_document(data)
    if data.get("kind") == "questions":
        return _questions_truth_document(data)
    raise ValueError(f"{path}: unknown truth kind {data.get('kind')!r}")


class FakeParser:
    """``PdfParser`` returning registered documents by input sha256, else parsing text input."""

    def __init__(self, documents: Iterable[ParsedDocument] = ()) -> None:
        self._documents: dict[str, ParsedDocument] = {}
        for document in documents:
            self.register(document)

    @classmethod
    def from_truth_files(cls, paths: Iterable[Path]) -> FakeParser:
        return cls(load_truth_document(path) for path in paths)

    @property
    def parser_version(self) -> str:
        return FAKE_PARSER_VERSION

    def register(self, document: ParsedDocument) -> None:
        self._documents[document.source_sha256] = document

    def parse(self, path: Path, *, source_path: str | None = None) -> ParsedDocument:
        data = path.read_bytes()
        digest = sha256_hex(data)
        name = source_path or path.name
        known = self._documents.get(digest)
        if known is not None:
            return known.model_copy(
                update={"source_path": name, "parser_version": FAKE_PARSER_VERSION}
            )
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UnknownDocumentError(f"no fake document registered for {name}") from exc
        return document_from_text(text, source_path=name, source_sha256=digest)
