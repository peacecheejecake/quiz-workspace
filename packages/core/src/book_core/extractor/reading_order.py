"""The printed reading order of a question paper's blocks (UX12-EXTRACT-2, questions.md §6).

Docling's body order is not monotonic: a block can come after the next page, which hands one
question the other's options or answer. ``reading_order`` restores the printed order for every
reader of a question paper (``QuestionExtractor``, ``llm_requests``, ``classify_content``), so a
question means the same thing to all of them:

- pages ascending, by the page a block starts on;
- rows top to bottom, a row being the blocks starting within ``ROW_TOLERANCE`` of its first block,
  and left to right within a row. A plain y sort is not enough: cells of one printed line differ
  by a fraction of a point, and swapping them puts an option's text before its label;
- a page of two-column text keeps the parser's order (its columns would interleave), and so does
  a page with a block without a bbox (it has no position to sort by);
- images wholly outside the body area are margin or header decoration, not question figures. They
  go in the same step on purpose: sorted but kept, they would land on the question that ends the
  previous page and stretch its region across the page break;
- a single punctuation mark under ``SPECK_MAX_HEIGHT`` tall is a stray mark, not text. Sorted back
  in, it would end up in a stem. Only the height tells: a normal-height ``)`` closes a real stem.

Thresholds were measured with ``eval/question_pdfs.py``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from statistics import median
from typing import NamedTuple

from book_core.contracts import BBox, Block, BlockType

ROW_TOLERANCE = 3.0
"""PDF points: blocks starting this close vertically are on one printed row."""
COLUMN_MIN_BLOCKS = 4
"""Wide blocks needed on each side of the body's middle for a page to count as two-column."""
COLUMN_MIN_WIDTH = 60.0
"""PDF points: shorter blocks are grid cells or labels (options printed 2x2), not column text."""
COLUMN_MAX_CROSSING = 3
"""Blocks across the middle a two-column page may have (a title, a full-width table)."""
BODY_MIN_PAGES = 4
"""Pages with text before the body area is trusted: on a short paper a median is one page's text
extent, and a real figure beside narrower text would look like margin decoration."""
SPECK_MAX_HEIGHT = 2.0
"""PDF points: printed text is about 9 tall on the measured papers, a stray dot about 1."""


class BodyArea(NamedTuple):
    left: float
    top: float
    right: float

    @property
    def middle(self) -> float:
        return (self.left + self.right) / 2


def _box(block: Block) -> tuple[int, BBox] | None:
    """Page and bbox of the block's first located part."""
    for location in block.locations:
        if location.bbox is not None:
            return location.page, location.bbox
    return None


def _text_boxes(blocks: Sequence[Block]) -> list[tuple[int, BBox]]:
    return [
        located
        for block in blocks
        if block.type is not BlockType.IMAGE and (located := _box(block)) is not None
    ]


def body_area(blocks: Sequence[Block]) -> tuple[BodyArea | None, int]:
    """The page body as medians of the per-page text extents, and the pages they come from."""
    extents: dict[int, tuple[float, float, float]] = {}
    for page, box in _text_boxes(blocks):
        left, top, right = extents.get(page, (box.x0, box.y0, box.x1))
        extents[page] = (min(left, box.x0), min(top, box.y0), max(right, box.x1))
    if not extents:
        return None, 0
    pages = extents.values()
    area = BodyArea(
        median(e[0] for e in pages), median(e[1] for e in pages), median(e[2] for e in pages)
    )
    return area, len(extents)


def is_decoration(block: Block, body: BodyArea) -> bool:
    """An image without a caption wholly left of, right of or above the page body."""
    located = _box(block) if block.type is BlockType.IMAGE else None
    if located is None or block.caption_block_id is not None:
        return False
    box = located[1]
    return box.x1 <= body.left or box.x0 >= body.right or box.y1 <= body.top


def is_speck(block: Block) -> bool:
    """A lone punctuation mark too short to be a line of text."""
    text = block.text.strip()
    bbox = block.locations[0].bbox
    return (
        block.type is BlockType.TEXT
        and len(text) == 1
        and not text.isalnum()
        and bbox is not None
        and bbox.y1 - bbox.y0 < SPECK_MAX_HEIGHT
    )


def two_column_pages(blocks: Sequence[Block], middle: float) -> set[int]:
    """Pages of real column text: wide blocks wholly on each side of ``middle`` and next to nothing
    across it. Options printed 2x2 are short and sit under full-width stems, so they do not count;
    such a page has to be read row by row."""
    left: Counter[int] = Counter()
    right: Counter[int] = Counter()
    crossing: Counter[int] = Counter()
    for page, box in _text_boxes(blocks):
        if box.x0 < middle < box.x1:
            crossing[page] += 1
        elif box.x1 - box.x0 > COLUMN_MIN_WIDTH:
            (left if box.x1 <= middle else right)[page] += 1
    return {
        page
        for page in left
        if min(left[page], right[page]) >= COLUMN_MIN_BLOCKS
        and crossing[page] <= COLUMN_MAX_CROSSING
    }


def _rows(items: Sequence[tuple[BBox, int]]) -> list[int]:
    """Indices of a page's located blocks, row by row (module docstring)."""
    rows: list[list[tuple[BBox, int]]] = []
    for item in sorted(items, key=lambda i: (i[0].y0, i[1])):
        if rows and item[0].y0 - rows[-1][0][0].y0 <= ROW_TOLERANCE:
            rows[-1].append(item)
        else:
            rows.append([item])
    return [i for row in rows for _, i in sorted(row, key=lambda r: (r[0].x0, r[1]))]


def reading_order(blocks: Sequence[Block]) -> tuple[Block, ...]:
    """``blocks`` in printed order, without decoration images and specks (module docstring)."""
    body, pages_with_text = body_area(blocks)
    kept = [block for block in blocks if not is_speck(block)]
    if body is not None and pages_with_text >= BODY_MIN_PAGES:
        kept = [block for block in kept if not is_decoration(block, body)]
    columns = two_column_pages(kept, body.middle) if body is not None else set()

    by_page: dict[int, list[int]] = {}
    for index, block in enumerate(kept):
        by_page.setdefault(block.locations[0].page, []).append(index)
    ordered: list[Block] = []
    for page in sorted(by_page):
        indices = by_page[page]
        located = [(box, i) for i in indices if (box := kept[i].locations[0].bbox) is not None]
        if page in columns or len(located) != len(indices):
            ordered += [kept[i] for i in indices]
        else:
            ordered += [kept[i] for i in _rows(located)]
    return tuple(ordered)
