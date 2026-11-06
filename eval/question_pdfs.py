"""Diagnose question extraction on local question PDFs you are allowed to read (UX12-EXTRACT-1).

Prints numbers only, per document and per reading order: never document text, so the output is
safe to paste into a report. Parse results stay in memory; nothing here is committed: keep real
PDFs (and their parsed JSON) outside the repository.

    # PDFs (real Docling models, slow on first run) or `core parse` output (*.json):
    uv run python eval/question_pdfs.py ~/pdfs/exam.pdf ~/pdfs/book.parsed.json
    # compare the parser's order with the simulated repairs, list the question numbers:
    uv run python eval/question_pdfs.py exam.pdf --order parser page-y guarded --detail \\
        --json /tmp/question-report.json

Orders (``--order``): ``parser`` is the order the import reads today (``ParsedDocument``, as the
worker does); ``page-y`` sorts every page top to bottom; ``guarded`` does that on single-column
pages and keeps the parser's order on two-column pages; ``repaired`` is what the import reads now
(``book_core.extractor.reading_order``); ``page-y`` and ``guarded`` stay to compare against it.

Columns: ``mv_page``/``mv_up`` blocks moved to an earlier page / up within their column, ``2col``
two-column pages, ``opts`` option-count histogram, ``gaps`` missing question numbers, ``dup``
repeated numbers (both per chapter), ``ans`` answered ratio, ``tbl`` non-option tables dropped
from the stem (and the questions they hit), ``rev`` regions holding a block printed before the
question's first line, ``seq`` questions starting before the previous question, ``ovl`` pairs of
questions whose page regions overlap, ``marg`` images in the margin attached to a question,
``hsec`` questions split over several outline sections by a heading inside them.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from itertools import combinations, pairwise
from pathlib import Path

from book_core.contracts import BBox, Block, BlockType, ParsedDocument, SourceLocation
from book_core.extractor.reading_order import reading_order
from book_core.extractor.segment import (
    RawQuestion,
    answer_entries,
    segment_chapters,
    union_locations,
)
from book_core.structure import build_revision

ORDERS = ("parser", "page-y", "guarded", "repaired")

LINE_TOLERANCE = 3.0
"""PDF points: blocks this close vertically are on the same printed line, not out of order."""
OVERLAP_SHARE = 0.1
"""A pair of regions overlaps when the intersection is this share of the smaller region."""
COLUMN_MIN_BLOCKS = 4
"""Blocks wider than ``COLUMN_MIN_WIDTH`` each side of the page middle on a two-column page."""
COLUMN_MIN_WIDTH = 60.0
"""PDF points: shorter blocks are grid cells or labels (options in 2x2), not column text."""
COLUMN_MAX_CROSSING = 3
"""Blocks across the page middle a two-column page may have (a title, a full-width table)."""


@dataclass(slots=True)
class Row:
    input: int
    order: str
    pages: int = 0
    blocks: int = 0
    questions: int = 0
    two_column_pages: int = 0
    moved_earlier_page: int = 0
    moved_up: int = 0
    column_jumps: int = 0
    option_histogram: dict[int, int] = field(default_factory=dict)
    number_gaps: int = 0
    duplicate_numbers: int = 0
    answered_ratio: float = 0.0
    dropped_tables: int = 0
    questions_with_dropped_tables: int = 0
    reversed_regions: int = 0
    out_of_sequence: int = 0
    overlapping_regions: int = 0
    margin_images: int = 0
    heading_split_questions: int = 0
    # Question numbers only (``--detail``), never their text.
    detail: dict[str, list[int]] = field(default_factory=dict)


def _load(path: Path) -> ParsedDocument:
    if path.suffix.lower() == ".json":
        return ParsedDocument.model_validate_json(path.read_bytes())
    from book_core.parser import ParserOptions
    from book_core.parser.docling_adapter import DoclingParser

    return DoclingParser(ParserOptions()).parse(path, source_path=path.name)


def _boxes(block: Block) -> list[tuple[int, BBox]]:
    return [(loc.page, loc.bbox) for loc in block.locations if loc.bbox is not None]


def _first(block: Block) -> tuple[int, BBox] | None:
    boxes = _boxes(block)
    return boxes[0] if boxes else None


def _same_column(a: BBox, b: BBox) -> bool:
    return min(a.x1, b.x1) > max(a.x0, b.x0)


def _above(block: tuple[int, BBox], reference: tuple[int, BBox]) -> bool:
    """``block`` is printed before ``reference``: an earlier page, or higher in its column."""
    if block[0] != reference[0]:
        return block[0] < reference[0]
    return _same_column(block[1], reference[1]) and block[1].y0 < reference[1].y0 - LINE_TOLERANCE


def two_column_pages(blocks: Sequence[Block], widths: dict[int, float]) -> set[int]:
    """Pages of real column text: wide blocks wholly on each side of the page middle and next to
    nothing across it. Options printed 2x2 are short and sit under full-width stems."""
    left: Counter[int] = Counter()
    right: Counter[int] = Counter()
    crossing: Counter[int] = Counter()
    for block in blocks:
        located = _first(block)
        if located is None or block.type is BlockType.IMAGE:
            continue
        page, box = located
        middle = widths.get(page, 0.0) / 2
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


def _top_down(items: list[tuple[float, float, int, Block]]) -> list[Block]:
    """Rows top to bottom, left to right within a row: a row is the blocks starting within
    ``LINE_TOLERANCE`` of its first block (a plain y sort swaps cells of one printed line)."""
    items = sorted(items, key=lambda item: (item[0], item[2]))
    rows: list[list[tuple[float, float, int, Block]]] = []
    for item in items:
        if rows and item[0] - rows[-1][0][0] <= LINE_TOLERANCE:
            rows[-1].append(item)
        else:
            rows.append([item])
    return [i[3] for row in rows for i in sorted(row, key=lambda item: (item[1], item[2]))]


def reordered(blocks: Sequence[Block], order: str, widths: dict[int, float]) -> tuple[Block, ...]:
    """The blocks in a simulated reading order; unlocated blocks stay after their predecessor."""
    if order == "parser":
        return tuple(blocks)
    if order == "repaired":
        return reading_order(blocks)
    keep = two_column_pages(blocks, widths) if order == "guarded" else set()
    pages: dict[int, list[tuple[float, float, int, Block]]] = {}
    y, x = 0.0, 0.0
    for index, block in enumerate(blocks):
        located = _first(block)
        if located is not None:
            y, x = located[1].y0, located[1].x0
        pages.setdefault(block.locations[0].page, []).append((y, x, index, block))
    ordered: list[Block] = []
    for page in sorted(pages):
        items = pages[page]
        ordered += [item[3] for item in items] if page in keep else _top_down(items)
    return tuple(ordered)


def _inversions(blocks: Sequence[Block]) -> tuple[int, int, int]:
    """``(moved to an earlier page, moved up in the column, jumps up to another column)``."""
    earlier = up = jumps = 0
    located = [box for block in blocks if (box := _first(block)) is not None]
    for previous, current in pairwise(located):
        if current[0] < previous[0]:
            earlier += 1
        elif current[0] == previous[0] and current[1].y0 < previous[1].y0 - LINE_TOLERANCE:
            if _same_column(current[1], previous[1]):
                up += 1
            else:
                jumps += 1
    return earlier, up, jumps


def _own(question: RawQuestion, blocks: Sequence[Block]) -> list[Block]:
    return [blocks[i] for i in sorted(set(question.block_indices))]


def _dropped_tables(question: RawQuestion, blocks: Sequence[Block]) -> int:
    """Tables inside the question that are neither options nor in the stem (the stem keeps only
    an option table's header rows)."""
    used = {line.block.id for option in question.options for line in option.lines}
    return sum(1 for b in _own(question, blocks) if b.type is BlockType.TABLE and b.id not in used)


def _reversed(question: RawQuestion, blocks: Sequence[Block]) -> bool:
    start = _first(question.stem_lines[0].block)
    if start is None:
        return False
    return any(
        (box := _first(b)) is not None and _above(box, start) for b in _own(question, blocks)
    )


def _regions(blocks: Sequence[Block]) -> dict[int, BBox]:
    locations: tuple[SourceLocation, ...] = union_locations(blocks)
    return {loc.page: loc.bbox for loc in locations if loc.bbox is not None}


def _overlaps(a: BBox, b: BBox) -> bool:
    width = min(a.x1, b.x1) - max(a.x0, b.x0)
    height = min(a.y1, b.y1) - max(a.y0, b.y0)
    if width <= 0 or height <= 0:
        return False
    smaller = min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0))
    return width * height >= OVERLAP_SHARE * smaller


def _overlapping_pairs(
    questions: Sequence[RawQuestion], blocks: Sequence[Block]
) -> list[tuple[int, int]]:
    by_page: dict[int, list[tuple[int, BBox]]] = {}
    for question in questions:
        for page, box in _regions(_own(question, blocks)).items():
            by_page.setdefault(page, []).append((question.number, box))
    pairs: list[tuple[int, int]] = []
    for regions in by_page.values():
        for (a, box_a), (b, box_b) in combinations(regions, 2):
            if _overlaps(box_a, box_b):
                pairs.append((a, b))
    return pairs


def _margin_images(question: RawQuestion, blocks: Sequence[Block]) -> int:
    """Images beside the text of the question: no horizontal overlap with its text blocks."""
    own = _own(question, blocks)
    text = [box for b in own if b.type is not BlockType.IMAGE and (box := _first(b)) is not None]
    count = 0
    for block in own:
        image = _first(block) if block.type is BlockType.IMAGE else None
        if image is None:
            continue
        same_page = [box for page, box in text if page == image[0]]
        if not same_page or not any(_same_column(image[1], box) for box in same_page):
            count += 1
    return count


def _sections(parsed: ParsedDocument) -> dict[str, str | None]:
    """Parser block id -> outline section of the canonical block built from it."""
    revision = build_revision(parsed, document_id="eval", revision_id="eval").revision
    return {
        source: block.section_id for block in revision.blocks for source in block.source_block_ids
    }


def _numbering(questions: Sequence[RawQuestion]) -> tuple[int, int]:
    """``(missing, repeated)`` question numbers, summed per chapter: numbering restarts there,
    so a number repeated in another chapter is neither a duplicate nor a reason to count a gap."""
    chapters: dict[int, list[int]] = {}
    for question in questions:
        chapters.setdefault(question.chapter, []).append(question.number)
    gaps = duplicates = 0
    for numbers in chapters.values():
        distinct = sorted(set(numbers))
        duplicates += len(numbers) - len(distinct)
        gaps += distinct[-1] - distinct[0] + 1 - len(distinct)
    return gaps, duplicates


def analyse(parsed: ParsedDocument, order: str, *, index: int = 1) -> Row:
    widths = {p.page: p.width for p in parsed.pages}
    blocks = reordered(parsed.blocks, order, widths)
    seg = segment_chapters(blocks)
    questions = seg.questions
    keys = answer_entries(seg)
    sections = _sections(parsed)

    row = Row(input=index, order=order, pages=len(parsed.pages), blocks=len(blocks))
    row.questions = len(questions)
    row.two_column_pages = len(two_column_pages(blocks, widths))
    row.moved_earlier_page, row.moved_up, row.column_jumps = _inversions(blocks)
    row.option_histogram = dict(sorted(Counter(len(q.options) for q in questions).items()))

    row.number_gaps, row.duplicate_numbers = _numbering(questions)
    answered = sum(1 for q in questions if q.answer or keys[id(q)])
    row.answered_ratio = round(answered / len(questions), 4) if questions else 0.0

    detail: dict[str, list[int]] = {}

    def note(name: str, number: int) -> None:
        detail.setdefault(name, []).append(number)

    starts = [_first(q.stem_lines[0].block) for q in questions]
    for question, (previous, start) in zip(questions[1:], pairwise(starts), strict=True):
        if previous is not None and start is not None and _above(start, previous):
            row.out_of_sequence += 1
            note("out_of_sequence", question.number)
    for question in questions:
        tables = _dropped_tables(question, blocks)
        if tables:
            row.dropped_tables += tables
            row.questions_with_dropped_tables += 1
            note("dropped_tables", question.number)
        if _reversed(question, blocks):
            row.reversed_regions += 1
            note("reversed_regions", question.number)
        margin = _margin_images(question, blocks)
        if margin:
            row.margin_images += margin
            note("margin_images", question.number)
        if len({sections.get(b.id) for b in _own(question, blocks)}) > 1:
            row.heading_split_questions += 1
            note("heading_split", question.number)
        if len(question.options) not in (0, 4):
            note("not_four_options", question.number)
    pairs = _overlapping_pairs(questions, blocks)
    row.overlapping_regions = len(pairs)
    for a, _b in pairs:
        note("overlapping_regions", a)
    row.detail = detail
    return row


def _histogram(histogram: dict[int, int]) -> str:
    return " ".join(f"{count}:{n}" for count, n in histogram.items())


def _print(row: Row, name: str) -> None:
    print(
        f"{row.order:<8}{row.pages:>6}{row.blocks:>7}{row.questions:>6}{row.two_column_pages:>6}"
        f"{row.moved_earlier_page:>8}{row.moved_up:>7}{row.number_gaps:>6}"
        f"{row.duplicate_numbers:>5}{row.answered_ratio:>6.2f}"
        f"{row.dropped_tables:>5}/{row.questions_with_dropped_tables:<4}"
        f"{row.reversed_regions:>4}{row.out_of_sequence:>5}{row.overlapping_regions:>5}"
        f"{row.margin_images:>6}{row.heading_split_questions:>6}"
        f"  {_histogram(row.option_histogram)}  #{row.input} {name}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("inputs", nargs="+", type=Path, help="A PDF or a ParsedDocument JSON")
    parser.add_argument("--order", nargs="+", choices=ORDERS, default=["parser"])
    parser.add_argument("--detail", action="store_true", help="Also list question numbers.")
    parser.add_argument("--json", type=Path, help="Also write the rows as JSON (numbers only).")
    args = parser.parse_args(argv)

    rows = []
    print(
        "order    pages blocks   qs  2col mv_page  mv_up  gaps  dup   ans  tbl/q    rev  seq  ovl"
        "  marg  hsec  opts"
    )
    for index, path in enumerate(args.inputs, start=1):
        parsed = _load(path.expanduser())
        for order in args.order:
            row = analyse(parsed, order, index=index)
            # The file name can be private: rows are numbered, the name stays on this terminal.
            _print(row, path.name)
            if args.detail:
                for name, numbers in row.detail.items():
                    print(f"    {name}: {' '.join(map(str, numbers))}")
            rows.append(asdict(row))
    if args.json is not None:
        args.json.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
