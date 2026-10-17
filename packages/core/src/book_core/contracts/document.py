"""Document contracts: parser output and canonical (user-correctable) revisions.

Source: docs/architecture.md §4 (``ParsedDocument``, ``DocumentRevision``, indexing flow),
§5 (``chapters(parent_id)``, ``content_blocks(source_location)``), implementation plan M1.2-M1.4.
"""

from __future__ import annotations

from collections.abc import Sequence
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from book_core.contracts.common import (
    CoreModel,
    Identifier,
    NonEmptyText,
    PageNumber,
    Sha256Hex,
    SourceLocation,
    ensure_unique,
)


class BlockType(StrEnum):
    """Kinds of content block (architecture.md §4: text / table / image; headings drive the
    chapter/section hierarchy and formulas are a parser test target, architecture.md §9)."""

    HEADING = "heading"
    TEXT = "text"
    TABLE = "table"
    IMAGE = "image"
    FORMULA = "formula"


class RevisionStatus(StrEnum):
    """DOC-02: draft and published revisions are kept separate."""

    DRAFT = "draft"
    PUBLISHED = "published"


class PageInfo(CoreModel):
    """Page size in PDF points, used to bound block coordinates.

    ``text_layer`` is ``False`` when the source page had no extractable text (a scanned or
    image-only page); such pages need the OCR fallback, see ``ParsedDocument.ocr_applied``.
    """

    page: PageNumber
    width: Annotated[float, Field(gt=0)]
    height: Annotated[float, Field(gt=0)]
    text_layer: bool = True


class Section(CoreModel):
    """A chapter (level 1) or nested section. Parents must precede their children."""

    id: Identifier
    title: NonEmptyText
    level: Annotated[int, Field(ge=1)]
    parent_id: Identifier | None = None


class TableContent(CoreModel):
    """Cells of a table block as a rectangular grid (spanning cells repeat their text).

    The first ``header_rows`` rows are column headers.
    """

    rows: Annotated[tuple[tuple[str, ...], ...], Field(min_length=1)]
    header_rows: Annotated[int, Field(ge=0)] = 0

    @model_validator(mode="after")
    def _check(self) -> Self:
        if len({len(row) for row in self.rows}) != 1:
            raise ValueError("table rows must have the same number of cells")
        if self.header_rows > len(self.rows):
            raise ValueError("header_rows exceeds row count")
        return self


class Block(CoreModel):
    """One content block in reading order, with provenance to the original PDF.

    ``text`` may be empty for blocks without extractable text (e.g. an image without caption).
    A block can span pages, hence one or more ``locations``. Table blocks hold their rows as
    ``a | b | c`` lines in ``text`` and the cells in ``table``. ``heading_level`` is the level the
    parser detected for a heading (1 = top); it is a hint, the section tree lives in
    ``sections``. ``caption_block_id`` links an image or table to its caption block.
    """

    id: Identifier
    type: BlockType
    text: str
    section_id: Identifier | None = None
    locations: Annotated[tuple[SourceLocation, ...], Field(min_length=1)]
    heading_level: Annotated[int, Field(ge=1)] | None = None
    table: TableContent | None = None
    caption_block_id: Identifier | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.heading_level is not None and self.type is not BlockType.HEADING:
            raise ValueError(f"block {self.id!r}: heading_level is only valid for headings")
        if self.table is not None and self.type is not BlockType.TABLE:
            raise ValueError(f"block {self.id!r}: table cells are only valid for tables")
        if self.caption_block_id is not None and self.type not in (
            BlockType.IMAGE,
            BlockType.TABLE,
        ):
            raise ValueError(f"block {self.id!r}: only images and tables have captions")
        if self.caption_block_id == self.id:
            raise ValueError(f"block {self.id!r} cannot be its own caption")
        return self


def _check_structure(
    sections: Sequence[Section], blocks: Sequence[Block], pages: Sequence[PageInfo] | None
) -> None:
    ensure_unique([s.id for s in sections], "section id")
    ensure_unique([b.id for b in blocks], "block id")

    levels: dict[str, int] = {}
    for section in sections:
        if section.parent_id is None:
            if section.level != 1:
                raise ValueError(f"root section {section.id!r} must have level 1")
        else:
            parent_level = levels.get(section.parent_id)
            if parent_level is None:
                raise ValueError(
                    f"section {section.id!r} references unknown or later parent "
                    f"{section.parent_id!r}"
                )
            if section.level <= parent_level:
                raise ValueError(f"section {section.id!r} level must be deeper than its parent")
        levels[section.id] = section.level

    page_sizes = {p.page: p for p in pages} if pages is not None else None
    block_ids = {b.id for b in blocks}
    for block in blocks:
        if block.caption_block_id is not None and block.caption_block_id not in block_ids:
            raise ValueError(
                f"block {block.id!r} references unknown caption block {block.caption_block_id!r}"
            )
        if block.section_id is not None and block.section_id not in levels:
            raise ValueError(f"block {block.id!r} references unknown section {block.section_id!r}")
        for loc in block.locations:
            if loc.block_id is not None and loc.block_id != block.id:
                raise ValueError(f"block {block.id!r} location points at block {loc.block_id!r}")
            if page_sizes is None:
                continue
            size = page_sizes.get(loc.page)
            if size is None:
                raise ValueError(f"block {block.id!r} references unknown page {loc.page}")
            if loc.bbox is not None and (loc.bbox.x1 > size.width or loc.bbox.y1 > size.height):
                raise ValueError(f"block {block.id!r} bbox exceeds page {loc.page} bounds")


class ParsedDocument(CoreModel):
    """Parser output for one immutable source PDF (stored as ``parsed_document.json``)."""

    schema_version: Literal[1] = 1
    source_path: NonEmptyText
    source_sha256: Sha256Hex
    parser_version: NonEmptyText
    ocr_applied: bool = False
    pages: Annotated[tuple[PageInfo, ...], Field(min_length=1)]
    sections: tuple[Section, ...] = ()
    blocks: tuple[Block, ...] = ()

    @model_validator(mode="after")
    def _check(self) -> Self:
        ensure_unique([str(p.page) for p in self.pages], "page")
        _check_structure(self.sections, self.blocks, self.pages)
        return self


class DocumentRevision(CoreModel):
    """Corrected canonical blocks of a document plus their publication state.

    Block ids are stable across revisions of the same document so that chunks, search hits and
    question sources keep pointing at the same logical block after a correction.
    """

    schema_version: Literal[1] = 1
    document_id: Identifier
    revision_id: Identifier
    revision_number: Annotated[int, Field(ge=1)]
    parent_revision_id: Identifier | None = None
    source_sha256: Sha256Hex
    status: RevisionStatus = RevisionStatus.DRAFT
    sections: tuple[Section, ...] = ()
    blocks: tuple[Block, ...] = ()

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.parent_revision_id == self.revision_id:
            raise ValueError("revision cannot be its own parent")
        _check_structure(self.sections, self.blocks, None)
        return self
