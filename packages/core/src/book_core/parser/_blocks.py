"""Helpers shared by parser implementations: text normalization, bboxes and stable block ids."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from book_core.contracts import BBox, Block, BlockType, SourceLocation, TableContent

COORD_DECIMALS = 2
_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """NFC with runs of whitespace collapsed to one space (the fixture truth convention)."""
    return _WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


def table_text(rows: Sequence[Sequence[str]]) -> str:
    """Rows as ``a | b | c`` lines, the canonical text of a table block."""
    return "\n".join(" | ".join(row) for row in rows)


def make_bbox(
    x0: float, y0: float, x1: float, y1: float, page_width: float, page_height: float
) -> BBox | None:
    """Top-left-origin box clamped to the page and rounded; ``None`` if it degenerates."""

    def clamp(value: float, upper: float) -> float:
        return round(min(max(value, 0.0), upper), COORD_DECIMALS)

    left, right = sorted((clamp(x0, page_width), clamp(x1, page_width)))
    top, bottom = sorted((clamp(y0, page_height), clamp(y1, page_height)))
    if left >= right or top >= bottom:
        return None
    return BBox(x0=left, y0=top, x1=right, y1=bottom)


@dataclass(slots=True)
class DraftBlock:
    """A block before its stable id is known (ids depend on the final reading order)."""

    type: BlockType
    text: str
    locations: tuple[SourceLocation, ...]
    heading_level: int | None = None
    table: TableContent | None = None
    caption_index: int | None = None
    """Index of the caption's ``DraftBlock`` in the same list."""


def block_id(page: int, order: int, block_type: BlockType, text: str) -> str:
    """``p<page>-b<order on page>-<content hash>``: stable for the same bytes and parser."""
    digest = hashlib.sha256(f"{block_type.value}\x1f{text}".encode()).hexdigest()[:10]
    return f"p{page}-b{order:03d}-{digest}"


def finalize_blocks(drafts: Sequence[DraftBlock]) -> tuple[Block, ...]:
    """Assign ids in reading order and resolve caption links."""
    per_page: dict[int, int] = {}
    ids: list[str] = []
    for draft in drafts:
        page = draft.locations[0].page
        order = per_page.get(page, 0) + 1
        per_page[page] = order
        ids.append(block_id(page, order, draft.type, draft.text))
    return tuple(
        Block(
            id=ids[i],
            type=draft.type,
            text=draft.text,
            locations=draft.locations,
            heading_level=draft.heading_level,
            table=draft.table,
            caption_block_id=ids[draft.caption_index] if draft.caption_index is not None else None,
        )
        for i, draft in enumerate(drafts)
    )
