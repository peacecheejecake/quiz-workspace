"""Structure heuristics on synthetic edge cases built in code (M1.3)."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    SourceLocation,
    TableContent,
)
from book_core.parser import document_from_pages
from book_core.parser._blocks import table_text as _table_text
from book_core.structure import (
    NumberingKind,
    StructureResult,
    build_revision,
    normalize_block_text,
    parse_numbering,
)
from book_core.structure.numbering import disambiguate_letters

SHA = "0" * 64


def table_text_of(table: TableContent) -> str:
    return _table_text(table.rows)


LONG_KO = "본문 문장이 이어진다. " * 20
LONG_EN = "This sentence belongs to the body text. " * 8


def _structure(pages: list[list[str]]) -> StructureResult:
    parsed = document_from_pages(pages, source_path="t.pdf", source_sha256=SHA)
    return build_revision(parsed, document_id="d", revision_id="r")


@dataclass
class B:
    type: BlockType
    text: str
    page: int
    bbox: tuple[float, float, float, float] = (64, 100, 530, 140)
    table: TableContent | None = None
    heading_level: int | None = None


def _manual(blocks: list[B]) -> StructureResult:
    parsed = ParsedDocument(
        source_path="m.pdf",
        source_sha256=SHA,
        parser_version="test",
        pages=tuple(
            PageInfo(page=n, width=595, height=842)
            for n in range(1, max(b.page for b in blocks) + 1)
        ),
        blocks=tuple(
            Block(
                id=f"b{i}",
                type=b.type,
                text=b.text,
                table=b.table,
                heading_level=b.heading_level,
                locations=(
                    SourceLocation(
                        page=b.page,
                        bbox=BBox(x0=b.bbox[0], y0=b.bbox[1], x1=b.bbox[2], y1=b.bbox[3]),
                    ),
                ),
            )
            for i, b in enumerate(blocks)
        ),
    )
    return build_revision(parsed, document_id="d", revision_id="r")


def _tree(result: StructureResult) -> list[tuple[str, int, str | None]]:
    titles = {s.id: s.title for s in result.revision.sections}
    return [
        (s.title, s.level, titles[s.parent_id] if s.parent_id else None)
        for s in result.revision.sections
    ]


def _codes(result: StructureResult) -> list[str]:
    return [w.code for w in result.warnings]


@pytest.mark.parametrize(
    ("title", "kind", "numbers"),
    [
        ("제1장 개요", NumberingKind.CHAPTER, (1,)),
        ("1장 물의 순환", NumberingKind.CHAPTER, (1,)),
        ("Chapter 12. Results", NumberingKind.CHAPTER, (12,)),
        ("CHAPTER IV Methods", NumberingKind.CHAPTER, (4,)),
        ("Part II Foundations", NumberingKind.PART, (2,)),
        ("제2부 응용", NumberingKind.PART, (2,)),
        ("제3절 방법", NumberingKind.KO_SECTION, (3,)),
        ("1. 서론", NumberingKind.NUM1, (1,)),
        ("2 Background", NumberingKind.NUM1, (2,)),
        ("1.1 증발과 응결", NumberingKind.NUM2, (1, 1)),
        ("2.3.4. Details", NumberingKind.NUM3, (2, 3, 4)),
        ("IV. Discussion", NumberingKind.ROMAN, (4,)),
        ("B. Appendix tables", NumberingKind.UPPER_ALPHA, (2,)),
        ("나. 세부 내용", NumberingKind.HANGUL, (2,)),
        ("(3) 예시", NumberingKind.PAREN, (3,)),
    ],
)
def test_parse_numbering(title: str, kind: NumberingKind, numbers: tuple[int, ...]) -> None:
    numbering = parse_numbering(title)
    assert numbering is not None
    assert (numbering.kind, numbering.numbers) == (kind, numbers)


@pytest.mark.parametrize("title", ["Introduction", "물의 순환", "2024", "Chapters of life"])
def test_unnumbered_titles(title: str) -> None:
    assert parse_numbering(title) is None


def test_headings_without_numbers_stay_flat_and_skip_title_page() -> None:
    result = _structure(
        [
            ["# A Book Title", "An excerpt"],
            ["# Introduction", LONG_EN, "# Background", LONG_EN],
            ["# Methods", LONG_EN],
        ]
    )
    assert _tree(result) == [
        ("Introduction", 1, None),
        ("Background", 1, None),
        ("Methods", 1, None),
    ]
    assert _codes(result) == ["flat_sections"]
    front = {b.id for b in result.revision.blocks if b.section_id is None}
    assert front == set(result.front_matter_block_ids)
    assert {b.text for b in result.revision.blocks if b.id in front} == {
        "A Book Title",
        "An excerpt",
    }


def test_headings_without_numbers_use_parser_levels_when_they_vary() -> None:
    result = _structure([["# Intro", LONG_EN, "## Scope", LONG_EN, "# Next", "## Detail"]])
    assert _tree(result) == [
        ("Intro", 1, None),
        ("Scope", 2, "Intro"),
        ("Next", 1, None),
        ("Detail", 2, "Next"),
    ]
    assert _codes(result) == ["levels_from_layout"]


def test_headings_without_numbers_use_heading_heights() -> None:
    big, small = (64, 80, 300, 98), (64, 120, 300, 132)
    result = _manual(
        [
            B(BlockType.HEADING, "Overview", 1, big, heading_level=1),
            B(BlockType.TEXT, LONG_EN, 1),
            B(BlockType.HEADING, "Scope", 1, small, heading_level=1),
            B(BlockType.TEXT, LONG_EN, 1),
            B(BlockType.HEADING, "Next part", 2, big, heading_level=1),
        ]
    )
    assert _tree(result) == [
        ("Overview", 1, None),
        ("Scope", 2, "Overview"),
        ("Next part", 1, None),
    ]


def test_numbering_gaps_and_mismatches_are_warnings() -> None:
    result = _structure(
        [
            ["# 1장 시작", LONG_KO, "# 1.1 첫 절", LONG_KO, "# 1.3 셋째 절", LONG_KO],
            ["# 2.1 잘못된 절", LONG_KO, "# 3장 다음 장", LONG_KO],
        ]
    )
    assert _tree(result) == [
        ("1장 시작", 1, None),
        ("1.1 첫 절", 2, "1장 시작"),
        ("1.3 셋째 절", 2, "1장 시작"),
        ("2.1 잘못된 절", 2, "1장 시작"),
        ("3장 다음 장", 1, None),
    ]
    codes = _codes(result)
    assert codes.count("numbering_gap") == 3  # 1.1->1.3, 1.3->2.1, 1장->3장
    assert codes.count("numbering_mismatch") == 1
    assert all(w.block_ids for w in result.warnings)


def test_mixed_ko_en_headings_and_parts() -> None:
    result = _structure(
        [
            ["# 표지 제목"],
            ["# Part I 기초", "# Chapter 1 Introduction", LONG_EN, "# 1.1 배경", LONG_KO],
            ["# 제2장 방법", LONG_KO, "# 2.1 Data", LONG_EN, "# 2.1.1 수집", LONG_KO],
            ["# 연습문제", LONG_KO, "# References", LONG_EN],
        ]
    )
    assert _tree(result) == [
        ("Part I 기초", 1, None),
        ("Chapter 1 Introduction", 2, "Part I 기초"),
        ("1.1 배경", 3, "Chapter 1 Introduction"),
        ("제2장 방법", 2, "Part I 기초"),
        ("2.1 Data", 3, "제2장 방법"),
        ("2.1.1 수집", 4, "2.1 Data"),
        ("연습문제", 3, "제2장 방법"),
        ("References", 1, None),
    ]
    assert _codes(result) == ["unnumbered_heading"]
    assert [b.text for b in result.revision.blocks if b.section_id is None] == ["표지 제목"]


def test_toc_page_is_front_matter_even_with_numbered_lines() -> None:
    result = _structure(
        [
            ["# 목차", "# 1장 시작 ........ 2", "1.1 첫 절 ........ 2", "2장 끝 ........ 3"],
            ["# 1장 시작", LONG_KO, "# 1.1 첫 절", LONG_KO],
            ["# 2장 끝", LONG_KO],
        ]
    )
    assert _tree(result) == [
        ("1장 시작", 1, None),
        ("1.1 첫 절", 2, "1장 시작"),
        ("2장 끝", 1, None),
    ]
    assert len(result.toc_block_ids) == 4
    assert result.warnings == ()


def test_toc_cross_check_reports_missing_headings() -> None:
    result = _structure(
        [
            ["# Contents", "Chapter 1 Start ........ 2"],
            ["# Chapter 1 Start", LONG_EN, "# Chapter 2 Unlisted", LONG_EN],
        ]
    )
    assert _codes(result) == ["toc_mismatch"]
    assert "Chapter 2 Unlisted" in result.warnings[0].message


def test_cross_page_merge_ko_and_en_with_hyphenation() -> None:
    result = _structure(
        [
            ["# 1장 시작", "물은 바다에서 증발하여 구름이 되고, 다시 비가 되어"],
            ["땅으로 떨어진다. 이 과정은 반복된다.", "새 문단이다."],
            ["# 2장 Next", "Rain that reaches the ground is called infil-"],
            ["tration when it soaks into the soil.", "Rivers flow back to the sea."],
        ]
    )
    texts = [b.text for b in result.revision.blocks if b.type is BlockType.TEXT]
    assert texts == [
        "물은 바다에서 증발하여 구름이 되고, 다시 비가 되어 땅으로 떨어진다. 이 과정은 반복된다.",
        "새 문단이다.",
        "Rain that reaches the ground is called infiltration when it soaks into the soil.",
        "Rivers flow back to the sea.",
    ]
    merged = [b for b in result.revision.blocks if len(b.locations) == 2]
    assert [[loc.page for loc in b.locations] for b in merged] == [[1, 2], [3, 4]]


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("The process ends here.", "the next page starts lowercase."),  # sentence ended
        ("A list follows", "1. First item"),  # list marker
        ("Values are shown in", "Table 2. Results"),  # caption
        ("Ends without a period", "New paragraph starts with a capital."),  # EN, capital
        ("결과는 다음과 같다:", "다음 페이지 내용"),  # colon ends the sentence
        ("문단이 끝난다.", "새 문단이 시작된다."),
        ("이어지는 문장", "① 첫째 항목"),
    ],
)
def test_no_merge_without_continuation(first: str, second: str) -> None:
    result = _structure([["# 1장 A", first], [second]])
    texts = [b.text for b in result.revision.blocks if b.type is BlockType.TEXT]
    assert texts == [first, second]


def test_no_merge_across_table_or_heading_or_figure() -> None:
    table = TableContent(rows=(("a", "b"), ("1", "2")), header_rows=1)
    result = _manual(
        [
            B(BlockType.HEADING, "1장 시작", 1),
            B(BlockType.TEXT, "표는 다음과 같이 정리되며", 1),
            B(BlockType.TABLE, "a | b\n1 | 2", 2, table=table),
            B(BlockType.TEXT, "이어서 설명하면", 2),
            B(BlockType.HEADING, "1.1 다음 절", 3),
            B(BlockType.TEXT, "the paragraph after a heading", 3),
            B(BlockType.TEXT, "Before the figure the text runs on", 3),
            B(BlockType.IMAGE, "", 4),
            B(BlockType.TEXT, "and continues after it.", 4),
        ]
    )
    blocks = result.revision.blocks
    assert len(blocks) == 9
    assert all(len(b.locations) == 1 for b in blocks)
    assert blocks[2].type is BlockType.TABLE
    assert blocks[2].table == table


def test_merge_across_columns_on_same_page() -> None:
    result = _manual(
        [
            B(BlockType.HEADING, "Chapter 1 Columns", 1, (64, 60, 300, 80)),
            B(BlockType.TEXT, "Left column text that keeps", 1, (64, 600, 290, 800)),
            B(BlockType.TEXT, "going in the right column.", 1, (305, 90, 530, 200)),
            B(BlockType.TEXT, "Another paragraph", 1, (305, 210, 530, 300)),
            B(BlockType.TEXT, "below it in the same column.", 1, (305, 310, 530, 400)),
        ]
    )
    texts = [b.text for b in result.revision.blocks if b.type is BlockType.TEXT]
    assert texts == [
        "Left column text that keeps going in the right column.",
        "Another paragraph",
        "below it in the same column.",
    ]


@pytest.mark.parametrize(
    ("raw", "block_type", "expected"),
    [
        ("  a\tb \n c  ", BlockType.TEXT, "a b c"),
        (
            "infil- tration and pre- and post-war",
            BlockType.TEXT,
            "infiltration and pre- and post-war",
        ),
        ("soft­hyphen", BlockType.TEXT, "softhyphen"),
        ("Title- Case", BlockType.TEXT, "Title- Case"),
        ("a  |  b\n\n c | d ", BlockType.TABLE, "a | b\nc | d"),
        ("é", BlockType.HEADING, "é"),
    ],
)
def test_normalize_block_text(raw: str, block_type: BlockType, expected: str) -> None:
    assert normalize_block_text(raw, block_type) == expected


def test_document_without_headings_has_no_sections() -> None:
    result = _structure([["just text.", "more text."]])
    assert result.revision.sections == ()
    assert _codes(result) == ["no_headings"]
    assert all(b.section_id is None for b in result.revision.blocks)


def _body(*pages: list[str]) -> list[list[str]]:
    """Pages where every title becomes a heading followed by a body paragraph."""
    return [[text for title in page for text in (f"# {title}", LONG_EN)] for page in pages]


ALPHA_TO_U = [f"{ch}. Item {ch}" for ch in "ABCDEFGHIJKLMNOPQRSTU"]
LEADER_TABLE = TableContent(rows=tuple((f"Step {n}", "........", str(n)) for n in range(1, 5)))

# (pages or manual blocks, expected tree as (title, level, parent, heading page), TOC blocks,
#  front-matter blocks)
StructureCase = tuple[list[list[str]] | list[B], list[tuple[str, int, str | None, int]], int, int]
STRUCTURE_CASES: dict[str, StructureCase] = {
    "alpha A-J flat": (
        _body([f"{ch}. Topic {ch}" for ch in "ABCDE"], [f"{ch}. Topic {ch}" for ch in "FGHIJ"]),
        [(f"{ch}. Topic {ch}", 1, None, 1 if ch < "F" else 2) for ch in "ABCDEFGHIJ"],
        0,
        0,
    ),
    "roman I II III": (
        _body(["I. One", "II. Two", "III. Three"]),
        [("I. One", 1, None, 1), ("II. Two", 1, None, 1), ("III. Three", 1, None, 1)],
        0,
        0,
    ),
    "alpha H I J": (
        _body(["H. Eight", "I. Nine", "J. Ten"]),
        [("H. Eight", 1, None, 1), ("I. Nine", 1, None, 1), ("J. Ten", 1, None, 1)],
        0,
        0,
    ),
    "alpha I J": (
        _body(["I. Nine", "J. Ten"]),
        [("I. Nine", 1, None, 1), ("J. Ten", 1, None, 1)],
        0,
        0,
    ),
    "roman IV V VI": (
        _body(["IV. Four", "V. Five", "VI. Six"]),
        [("IV. Four", 1, None, 1), ("V. Five", 1, None, 1), ("VI. Six", 1, None, 1)],
        0,
        0,
    ),
    "alpha U V": (
        _body(["U. Twenty-one", "V. Twenty-two"]),
        [("U. Twenty-one", 1, None, 1), ("V. Twenty-two", 1, None, 1)],
        0,
        0,
    ),
    "lone I": (_body(["I. Only"]), [("I. Only", 1, None, 1)], 0, 0),
    "roman parts IV with A..U then V VI": (
        _body(["IV. Part four", *ALPHA_TO_U], ["V. Part five"], ["VI. Part six"]),
        [
            ("IV. Part four", 1, None, 1),
            *[(title, 2, "IV. Part four", 1) for title in ALPHA_TO_U],
            ("V. Part five", 1, None, 2),
            ("VI. Part six", 1, None, 3),
        ],
        0,
        0,
    ),
    "roman I with A B then II with A": (
        _body(["I. Overview", "A. First", "B. Second"], ["II. Methods", "A. Data"]),
        [
            ("I. Overview", 1, None, 1),
            ("A. First", 2, "I. Overview", 1),
            ("B. Second", 2, "I. Overview", 1),
            ("II. Methods", 1, None, 2),
            ("A. Data", 2, "II. Methods", 2),
        ],
        0,
        0,
    ),
    "leadered multi-page TOC, one entry per block": (
        [
            ["# Contents", "# Chapter 1 Start ........ 3", "1.1 Scope ........ 3"],
            ["Chapter 2 Middle ........ 4", "# Chapter 3 End ........ 5"],
            *_body(["Chapter 1 Start", "1.1 Scope"], ["Chapter 2 Middle"], ["Chapter 3 End"]),
        ],
        [
            ("Chapter 1 Start", 1, None, 3),
            ("1.1 Scope", 2, "Chapter 1 Start", 3),
            ("Chapter 2 Middle", 1, None, 4),
            ("Chapter 3 End", 1, None, 5),
        ],
        5,
        5,
    ),
    "titled leader-free TOC continuation": (
        [
            ["# 목차", "# 1장 시작", "# 2장 중간"],
            ["# 목차", "# 3장 끝"],
            *_body(["1장 시작"], ["2장 중간"], ["3장 끝"]),
        ],
        [("1장 시작", 1, None, 3), ("2장 중간", 1, None, 4), ("3장 끝", 1, None, 5)],
        5,
        5,
    ),
    "leader table inside a chapter is not a TOC": (
        [
            B(BlockType.HEADING, "Chapter 1 Steps", 1),
            B(BlockType.TEXT, LONG_EN, 1),
            B(BlockType.TABLE, table_text_of(LEADER_TABLE), 1, table=LEADER_TABLE),
            B(BlockType.HEADING, "Chapter 2 More", 2),
        ],
        [("Chapter 1 Steps", 1, None, 1), ("Chapter 2 More", 1, None, 2)],
        0,
        0,
    ),
    "first page of short paragraphs is not a title page": (
        [
            ["# Introduction", *["A short paragraph of body text here."] * 10],
            *_body(["Background"], ["Methods"]),
        ],
        [("Introduction", 1, None, 1), ("Background", 1, None, 2), ("Methods", 1, None, 3)],
        0,
        0,
    ),
}


@pytest.mark.parametrize("case", sorted(STRUCTURE_CASES))
def test_structure_case_matrix(case: str) -> None:
    source, tree, toc_blocks, front_blocks = STRUCTURE_CASES[case]
    if source and isinstance(source[0], B):
        result = _manual([b for b in source if isinstance(b, B)])
    else:
        result = _structure([page for page in source if isinstance(page, list)])
    blocks = {b.id: b for b in result.revision.blocks}
    titles = {s.id: s.title for s in result.revision.sections}
    got = [
        (
            s.title,
            s.level,
            titles[s.parent_id] if s.parent_id else None,
            blocks[s.heading_block_id].locations[0].page if s.heading_block_id else 0,
        )
        for s in result.revision.sections
    ]
    assert got == tree
    assert len(result.toc_block_ids) == toc_blocks
    assert len(result.front_matter_block_ids) == front_blocks
    assert all(
        b.section_id is not None
        for b in result.revision.blocks
        if b.id not in result.front_matter_block_ids
    )


@pytest.mark.parametrize(
    ("labels", "kinds"),
    [
        ("I II III", "R R R"),
        ("H I J", "A A A"),
        ("I J", "A A"),
        ("IV V VI", "R R R"),
        ("U V", "A A"),
        ("I", "R"),
        ("A B C D E F G H I J", "A A A A A A A A A A"),
        ("IV A B C D E F G H I J K L M N O P Q R S T U V VI", "R" + " A" * 21 + " R R"),
        ("I A B II A", "R A A R A"),
        ("W X Y", "A A A"),
        ("IX X XI", "R R R"),
    ],
)
def test_disambiguate_letters_matrix(labels: str, kinds: str) -> None:
    resolved = disambiguate_letters(
        [parse_numbering(f"{label}. Title") for label in labels.split()]
    )
    short = {NumberingKind.ROMAN: "R", NumberingKind.UPPER_ALPHA: "A"}
    assert " ".join(short[n.kind] for n in resolved if n is not None) == kinds
