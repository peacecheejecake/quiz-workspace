"""``reading_order`` and the checks built on it (UX12-EXTRACT-2): synthetic blocks only.

The layouts mirror what ``eval/question_pdfs.py`` measured on real papers: a block after the next
page, cells of one printed line a fraction of a point apart, options printed 2x2, margin
decoration. No real paper has two-column text, so that guard rests on these tests alone.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from book_core.contracts import BBox, Block, BlockType, ParsedDocument, SourceLocation
from book_core.contracts.document import PageInfo
from book_core.extractor import (
    QuestionExtractor,
    classify_content,
    llm_requests,
    reading_order,
)

LEFT, RIGHT = 77.0, 457.0
SHA = "0" * 64


def block(
    id_: str,
    page: int,
    y: float,
    *,
    x0: float = LEFT,
    x1: float = RIGHT,
    text: str = "",
    kind: BlockType = BlockType.TEXT,
    height: float = 9.0,
    caption: str | None = None,
) -> Block:
    return Block(
        id=id_,
        type=kind,
        text=text or id_,
        locations=(SourceLocation(page=page, bbox=BBox(x0=x0, y0=y, x1=x1, y1=y + height)),),
        caption_block_id=caption,
    )


def image(id_: str, page: int, x0: float, y: float, x1: float, y1: float) -> Block:
    return Block(
        id=id_,
        type=BlockType.IMAGE,
        text="",
        locations=(SourceLocation(page=page, bbox=BBox(x0=x0, y0=y, x1=x1, y1=y1)),),
    )


def ids(blocks: Sequence[Block]) -> list[str]:
    return [b.id for b in blocks]


def question(prefix: str, number: int, page: int, y: float) -> list[Block]:
    """A question and its four options, one line each, printed from ``y`` down."""
    lines = [block(f"{prefix}-stem", page, y, text=f"{number}. 다음 중 옳은 것은?")]
    for i, label in enumerate("①②③④"):
        lines.append(
            block(f"{prefix}-{i}", page, y + 14 * (i + 1), x0=101, text=f"{label} 보기 {i}")
        )
    lines.append(block(f"{prefix}-key", page, y + 74, text="정답: ①"))
    return lines


def paper(blocks: Sequence[Block], pages: int = 6) -> ParsedDocument:
    return ParsedDocument(
        source_path="synthetic.pdf",
        source_sha256=SHA,
        parser_version="test",
        pages=tuple(PageInfo(page=p, width=533, height=729) for p in range(1, pages + 1)),
        blocks=tuple(blocks),
    )


def filler_pages(first: int, last: int) -> list[Block]:
    """Pages of full-width text, so the body area is the medians over enough pages."""
    return [
        block(f"f{p}-{i}", p, 92.0 + 40 * i, text=f"본문 {p} {i}")
        for p in range(first, last + 1)
        for i in range(2)
    ]


def test_a_block_after_the_next_page_goes_back_to_its_page() -> None:
    last = block("p1-last", 1, 300)
    following = block("p2-first", 2, 92)
    assert ids(reading_order([block("p1", 1, 92), following, last])) == [
        "p1",
        "p1-last",
        "p2-first",
    ]


def test_a_block_is_sorted_by_the_page_it_starts_on() -> None:
    spanning = Block(
        id="span",
        type=BlockType.TEXT,
        text="span",
        locations=(
            SourceLocation(page=1, bbox=BBox(x0=LEFT, y0=600, x1=RIGHT, y1=620)),
            SourceLocation(page=2, bbox=BBox(x0=LEFT, y0=92, x1=RIGHT, y1=100)),
        ),
    )
    assert ids(reading_order([block("p2", 2, 200), spanning])) == ["span", "p2"]


def test_a_row_keeps_a_label_before_its_text_whatever_the_y_jitter() -> None:
    # The text of option ① starts a fraction of a point above its label: a plain y sort puts the
    # text first, the label then opens an empty option and the text falls into the stem.
    label = block("label", 1, 584.4, x0=101, x1=138)
    text = block("text", 1, 584.0, x0=137, x1=366)
    assert ids(reading_order([text, label])) == ["label", "text"]


def test_rows_more_than_the_tolerance_apart_stay_rows() -> None:
    upper = block("upper", 1, 100, x0=300, x1=400)
    lower = block("lower", 1, 103.5, x0=101, x1=200)
    assert ids(reading_order([lower, upper])) == ["upper", "lower"]


def test_a_row_does_not_chain_past_the_tolerance_from_its_first_block() -> None:
    blocks = [
        block("a", 1, 100, x0=300, x1=350),
        block("b", 1, 102, x0=200, x1=250),
        block("c", 1, 104, x0=100, x1=150),
    ]
    assert ids(reading_order(blocks)) == ["b", "a", "c"]


def test_options_printed_two_by_two_are_read_row_by_row_not_as_columns() -> None:
    # Short cells on both sides of the middle are not two-column text.
    stem = block("stem", 1, 92)
    cells = [
        block(f"{name}", 1, y, x0=x, x1=x + 40)
        for name, x, y in (
            ("c1", 101, 120),
            ("c2", 276, 120),
            ("c3", 101, 134),
            ("c4", 276, 134),
            ("c5", 101, 148),
            ("c6", 276, 148),
            ("c7", 101, 162),
            ("c8", 276, 162),
        )
    ]
    shuffled = [stem, *reversed(cells)]
    assert ids(reading_order(shuffled)) == ["stem", *ids(cells)]


def _column_page(page: int, *, crossing: int = 0, width: float = 150.0) -> list[Block]:
    """Left column first, as the parser reads a two-column page; rows align across columns."""
    blocks = [
        block(f"x{page}-{i}", page, 60.0 + 12 * i, x0=LEFT, x1=RIGHT) for i in range(crossing)
    ]
    for side, x0 in (("l", LEFT), ("r", 300.0)):
        blocks += [
            block(f"{side}{page}-{i}", page, 150.0 + 40 * i, x0=x0, x1=x0 + width) for i in range(4)
        ]
    return blocks


def test_a_two_column_page_keeps_the_parsers_order() -> None:
    page = _column_page(1)
    assert ids(reading_order(page)) == ids(page)


def test_a_two_column_page_with_a_title_across_the_middle_keeps_the_parsers_order() -> None:
    page = _column_page(1, crossing=3)
    assert ids(reading_order(page)) == ids(page)


def test_too_many_blocks_across_the_middle_is_not_a_two_column_page() -> None:
    page = _column_page(1, crossing=4)
    assert ids(reading_order(page)) != ids(page)


def test_only_the_two_column_page_is_kept_the_others_are_sorted() -> None:
    columns = _column_page(1)
    single = [block("late", 2, 300), block("early", 2, 100)]
    assert ids(reading_order([*columns, *single])) == [*ids(columns), "early", "late"]


def test_a_page_with_a_block_without_a_bbox_keeps_the_parsers_order() -> None:
    unlocated = Block(
        id="none", type=BlockType.TEXT, text="none", locations=(SourceLocation(page=1),)
    )
    blocks = [block("late", 1, 300), unlocated, block("early", 1, 100)]
    assert ids(reading_order(blocks)) == ["late", "none", "early"]


@pytest.mark.parametrize(
    ("x0", "y0", "x1", "y1"),
    [
        (466, 31, 498, 65),  # top right
        (474, 76, 489, 100),  # right margin
        (48, 35, 118, 55),  # header band, across the body's left edge
        (20, 200, 70, 260),  # left margin
    ],
)
def test_images_outside_the_body_area_are_dropped(
    x0: float, y0: float, x1: float, y1: float
) -> None:
    decoration = image("decoration", 3, x0, y0, x1, y1)
    blocks = [*filler_pages(1, 6), decoration]
    assert "decoration" not in ids(reading_order(blocks))


def test_a_figure_inside_the_body_area_stays() -> None:
    figure = image("figure", 3, 200, 300, 400, 420)
    assert "figure" in ids(reading_order([*filler_pages(1, 6), figure]))


def test_an_image_crossing_the_body_edge_stays() -> None:
    figure = image("figure", 3, 400, 300, 500, 420)
    assert "figure" in ids(reading_order([*filler_pages(1, 6), figure]))


def test_a_captioned_image_outside_the_body_stays() -> None:
    caption = block("cap", 3, 500, text="[그림 1]")
    figure = Block(
        id="figure",
        type=BlockType.IMAGE,
        text="",
        locations=(SourceLocation(page=3, bbox=BBox(x0=466, y0=200, x1=498, y1=260)),),
        caption_block_id="cap",
    )
    assert "figure" in ids(reading_order([*filler_pages(1, 6), figure, caption]))


def test_a_short_paper_keeps_a_figure_beside_narrower_text() -> None:
    text = [block(f"t{p}", p, 92, x0=LEFT, x1=250) for p in (1, 2, 3)]
    figure = image("figure", 1, 300, 92, 450, 200)
    assert "figure" in ids(reading_order([*text, figure]))


def _broken_paper() -> tuple[ParsedDocument, ParsedDocument]:
    """The same six-page paper as the parser reads it (question 1's options after question 2,
    decoration in the margin of every page) and as printed."""
    q1 = question("q1", 1, 1, 92)
    q2 = question("q2", 2, 2, 92)
    tail = [b for p in range(3, 7) for b in question(f"q{p}", p, p, 92)]
    decoration = [image(f"d{p}", p, 474, 76, 489, 100) for p in range(1, 7)]
    printed = [*q1, *q2, *tail]
    parser_order = [*q1[:1], *q2, *q1[1:], decoration[0], decoration[1], *tail, *decoration[2:]]
    return paper(parser_order), paper(printed)


def _content(document: ParsedDocument) -> list[tuple[int, str, tuple[str, ...]]]:
    extraction = QuestionExtractor().extract(document, document_id="doc")
    return [
        (q.number, q.draft.stem, tuple(o.text for o in q.draft.options))
        for q in extraction.questions
    ]


def test_extract_reads_the_printed_order_and_drops_the_decoration() -> None:
    broken, printed = _broken_paper()
    assert _content(broken) == _content(printed)
    extraction = QuestionExtractor().extract(broken, document_id="doc")
    for extracted in extraction.questions:
        for evidence in extracted.draft.evidence:
            assert not {b for b in evidence.block_ids if b.startswith("d")}
            assert all(loc.bbox is None or loc.bbox.x1 <= RIGHT for loc in evidence.locations)
        pages = {loc.page for e in extracted.draft.evidence for loc in e.locations}
        assert pages == {extracted.number}


def test_evidence_and_context_read_the_same_list_as_the_segmentation() -> None:
    # A position taken from the sorted list must not be read from the parser's list.
    broken, _ = _broken_paper()
    extraction = QuestionExtractor().extract(broken, document_id="doc")
    first = extraction.questions[0].draft
    assert first.evidence[0].block_ids == (
        "q1-stem",
        "q1-0",
        "q1-1",
        "q1-2",
        "q1-3",
    )


def test_llm_requests_use_the_same_order_as_extract() -> None:
    broken, printed = _broken_paper()
    assert llm_requests(broken) == llm_requests(printed)


def test_classification_is_the_same_in_either_order() -> None:
    broken, printed = _broken_paper()
    assert classify_content(broken.blocks) == classify_content(printed.blocks)


def _codes(document: ParsedDocument) -> dict[int, set[str]]:
    extraction = QuestionExtractor().extract(document, document_id="doc")
    return {
        q.number: {v.code for v in q.draft.validations if v.code != "answer_missing"}
        for q in extraction.questions
    }


def test_a_repaired_question_gets_a_note_and_the_others_do_not() -> None:
    broken, printed = _broken_paper()
    codes = _codes(broken)
    assert "reading_order_repaired" in codes[1]
    assert "reading_order_repaired" not in codes[3]
    assert all("reading_order_repaired" not in c for c in _codes(printed).values())


def test_a_dropped_decoration_alone_is_not_a_repair() -> None:
    blocks = [b for p in range(1, 7) for b in question(f"q{p}", p, p, 92)]
    decorated = [*blocks, *[image(f"d{p}", p, 474, 76, 489, 100) for p in range(1, 7)]]
    assert all("reading_order_repaired" not in c for c in _codes(paper(decorated)).values())


def _with_options(number: int, count: int) -> list[Block]:
    page = 1 + (number - 1) // 2
    y = 92.0 if number % 2 else 300.0
    lines = [block(f"s{number}", page, y, text=f"{number}. 다음 중 옳은 것은?")]
    for i in range(count):
        label = "①②③④⑤⑥"[i]
        lines.append(
            block(f"o{number}-{i}", page, y + 14 * (i + 1), x0=101, text=f"{label} 보기 {i}")
        )
    return lines


def test_a_rare_option_count_is_flagged_against_the_document_mode() -> None:
    blocks = [b for n in range(1, 13) for b in _with_options(n, 5 if n == 7 else 4)]
    codes = _codes(paper(blocks))
    assert "option_count_outlier" in codes[7]
    assert all("option_count_outlier" not in c for n, c in codes.items() if n != 7)


def test_a_section_of_another_format_is_not_an_outlier() -> None:
    # Ten O/X questions before fifty with four options, as the exam papers print them.
    blocks = [b for n in range(1, 61) for b in _with_options(n, 2 if n <= 10 else 4)]
    pages = 1 + 60 // 2
    assert all("option_count_outlier" not in c for c in _codes(paper(blocks, pages)).values())


def test_a_few_questions_have_no_document_mode() -> None:
    blocks = [b for n in range(1, 6) for b in _with_options(n, 5 if n == 3 else 4)]
    assert all("option_count_outlier" not in c for c in _codes(paper(blocks)).values())


def test_no_options_followed_by_repeated_labels_is_flagged_on_both() -> None:
    no_options = [block("s1", 1, 92, text="1. 다음 중 옳은 것은?")]
    doubled = _with_options(2, 4)
    doubled += [
        block(f"x{i}", 1, 500 + 14 * i, x0=101, text=f"{'①②③④'[i]} 다른 보기") for i in range(4)
    ]
    codes = _codes(paper([*no_options, *doubled]))
    assert "options_on_next_question" in codes[1]
    assert "options_on_next_question" in codes[2]


def test_repeated_labels_after_a_question_with_options_are_not_that_pattern() -> None:
    first = _with_options(1, 4)
    doubled = _with_options(2, 4)
    doubled += [
        block(f"x{i}", 1, 500 + 14 * i, x0=101, text=f"{'①②③④'[i]} 다른 보기") for i in range(4)
    ]
    codes = _codes(paper([*first, *doubled]))
    assert "options_on_next_question" not in codes[2]
