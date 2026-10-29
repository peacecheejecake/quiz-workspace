"""DOC-03-C02: the pure full-text renderer `book_core.export.render_revision` (DOCTXT).

Golden files: packages/core/tests/golden/export/<book>.<md|txt>, rendered from the synthetic
fixtures `book-ko` / `book-en` (tests/fixtures/pdfs/*.truth.json) and reviewed against
docs/screens/documents-text-export.md. Regenerate them only for an intended format change.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest
from book_core.contracts.common import SourceLocation
from book_core.contracts.document import (
    Block,
    BlockType,
    DocumentRevision,
    Section,
    TableContent,
)
from book_core.export import ExportFormat, render_revision
from book_core.parser.fake import load_truth_document
from book_core.structure import build_revision

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden" / "export"
TITLES = {"book-ko": "물의 순환과 정수 처리", "book-en": "The Water Cycle and Water Treatment"}


def lines(text: str) -> list[str]:
    return text.split("\n")


def _render() -> Callable[..., str]:
    return render_revision


# ---------------------------------------------------------------------------------------------
# DOC-03-C02 book_core.export.render_revision (pure)
# ---------------------------------------------------------------------------------------------


def _fixture_revision(book: str) -> DocumentRevision:
    parsed = load_truth_document(PDF_DIR / f"{book}.truth.json")
    return build_revision(parsed, document_id=f"doc-{book}", revision_id="rev-1").revision


def _loc(page: int) -> tuple[SourceLocation, ...]:
    return (SourceLocation(page=page),)


def _deep_revision() -> DocumentRevision:
    """Seven nested section levels (heading cap) and a table whose cells hold `|` and newlines."""
    sections: list[Section] = []
    blocks: list[Block] = []
    parent: str | None = None
    for level in range(1, 8):
        sid, bid = f"s{level}", f"h{level}"
        sections.append(
            Section(
                id=sid, title=f"Level {level}", level=level, parent_id=parent, heading_block_id=bid
            )
        )
        blocks.append(
            Block(
                id=bid,
                type=BlockType.HEADING,
                text=f"Level {level}",
                section_id=sid,
                locations=_loc(1 if level < 7 else 2),
                heading_level=level,
            )
        )
        parent = sid
    blocks.append(
        Block(
            id="t1",
            type=BlockType.TABLE,
            text="a|b | head\nline1\nline2 | x",
            section_id="s7",
            locations=_loc(2),
            table=TableContent(rows=(("a|b", "head"), ("line1\nline2", "x")), header_rows=1),
        )
    )
    blocks.append(Block(id="p1", type=BlockType.TEXT, text="Closing paragraph.", locations=_loc(3)))
    for i, b in enumerate(blocks):
        blocks[i] = b.model_copy(update={"ordinal": i})
    return DocumentRevision(
        document_id="doc-deep",
        revision_id="rev-deep",
        revision_number=1,
        source_sha256="0" * 64,
        sections=tuple(sections),
        blocks=tuple(blocks),
    )


def _index_of_line(text: str, line: str) -> int:
    found = lines(text).index(line) if line in lines(text) else -1
    assert found >= 0, f"missing line {line!r}"
    return found


def _previous_nonblank(text: str, index: int) -> str:
    rows = lines(text)
    i = index - 1
    while i >= 0 and rows[i].strip() == "":
        i -= 1
    return rows[i] if i >= 0 else ""


@pytest.mark.parametrize("book", ["book-ko", "book-en"])
@pytest.mark.parametrize("fmt", ["md", "txt"])
def test_doc_03_c02_render_matches_the_golden_file_byte_for_byte(book: str, fmt: str) -> None:
    render = _render()
    revision = _fixture_revision(book)
    out = render(revision, fmt, title=TITLES[book])
    assert out == render(revision, fmt, title=TITLES[book]), "rendering is deterministic"
    golden = GOLDEN_DIR / f"{book}.{fmt}"
    assert golden.is_file(), f"golden file {golden.relative_to(REPO_ROOT)} missing"
    assert out.encode("utf-8") == golden.read_bytes(), f"{book}.{fmt} differs from its golden file"


def test_doc_03_c02_markdown_structure_of_book_ko() -> None:
    md = _render()(_fixture_revision("book-ko"), "md", title=TITLES["book-ko"])
    assert not md.startswith("﻿"), "UTF-8 without BOM"
    assert "\r" not in md, "LF line endings only"
    assert lines(md)[0] == "# 물의 순환과 정수 처리", "document title is the only `#` heading"
    assert [line for line in lines(md) if re.match(r"^# ", line)] == ["# 물의 순환과 정수 처리"]
    # Chapters `##`, sections `###` (outline depth), in outline order.
    headings = [line for line in lines(md) if re.match(r"^#{2,6} ", line)]
    assert headings == [
        "## 1장 물의 순환",
        "### 1.1 증발과 응결",
        "### 1.2 강수와 유출",
        "## 2장 정수 처리",
        "### 2.1 응집과 침전",
        "### 2.2 여과와 소독",
    ]
    # GFM table: header row, delimiter row, body rows.
    header = _index_of_line(md, "| 단계 | 주요 작용 | 예시 체류 시간 |")
    assert re.fullmatch(r"\|(\s*:?-{3,}:?\s*\|){3}", lines(md)[header + 1]), "delimiter row"
    assert lines(md)[header + 2] == "| 응집 | 미세 입자 결합 | 약 30분 |"
    assert lines(md)[header + 5] == "| 소독 | 미생물 억제 | 약 30분 |"
    # The figure is a placeholder, followed by its caption text.
    figure = _index_of_line(md, "[그림 p.2]")
    assert figure < md.split("\n").index("그림 1. 물 순환 모식도 (자리표시자)")
    # Page markers sit right before the first block of their page.
    assert _previous_nonblank(md, _index_of_line(md, "## 1장 물의 순환")) == "<!-- p.2 -->"
    assert _previous_nonblank(md, _index_of_line(md, "## 2장 정수 처리")) == "<!-- p.4 -->"
    assert md.index("<!-- p.2 -->") < md.index("<!-- p.4 -->")
    assert "<!-- p.1 -->" not in md, "page 1 (table of contents) has no canonical block"
    # Paragraphs are separated by blank lines; block order is the reading order.
    texts = [b.text for b in _fixture_revision("book-ko").blocks if b.type is BlockType.TEXT]
    positions = [md.index(t[:20]) for t in texts]
    assert positions == sorted(positions), "text blocks keep their reading order"
    assert "\n\n" + texts[0] + "\n\n" in md, "a paragraph is its own block between blank lines"


def test_doc_03_c02_markdown_page_marker_of_a_page_starting_mid_document() -> None:
    md = _render()(_fixture_revision("book-en"), "md", title=TITLES["book-en"])
    # book-en: "Rivers and groundwater …" is the first block that starts on page 3.
    rivers = next(
        i for i, line in enumerate(lines(md)) if line.startswith("Rivers and groundwater")
    )
    assert _previous_nonblank(md, rivers) == "<!-- p.3 -->"
    assert _previous_nonblank(md, _index_of_line(md, "## Chapter 2. Water Treatment")) == (
        "<!-- p.4 -->"
    )
    assert "[그림 p.2]" in lines(md)


def test_doc_03_c02_plain_text_structure_of_book_ko() -> None:
    txt = _render()(_fixture_revision("book-ko"), "txt", title=TITLES["book-ko"])
    assert not txt.startswith("﻿")
    assert "\r" not in txt
    assert "<!--" not in txt, "no Markdown page comments in the text file"
    assert not [line for line in lines(txt) if line.startswith("#")], "no Markdown headings"
    assert not [line for line in lines(txt) if line.startswith("|")], "no Markdown tables"
    for heading in ("1장 물의 순환", "1.1 증발과 응결", "2.2 여과와 소독"):
        assert heading in lines(txt), f"heading {heading!r} is one line as is"
    assert "단계\t주요 작용\t예시 체류 시간" in lines(txt), "table rows are tab-separated"
    assert "응집\t미세 입자 결합\t약 30분" in lines(txt)
    assert "[그림 p.2]" in lines(txt)
    assert _previous_nonblank(txt, _index_of_line(txt, "1장 물의 순환")) == "[p.2]"
    assert _previous_nonblank(txt, _index_of_line(txt, "2장 정수 처리")) == "[p.4]"
    md = _render()(_fixture_revision("book-ko"), "md", title=TITLES["book-ko"])
    texts = [b.text[:20] for b in _fixture_revision("book-ko").blocks if b.type is BlockType.TEXT]
    assert [txt.index(t) for t in texts] == sorted(txt.index(t) for t in texts)
    assert [md.index(t) for t in texts] == sorted(md.index(t) for t in texts), "same order as md"


def test_doc_03_c02_heading_depth_cap_and_table_cell_escapes() -> None:
    revision = _deep_revision()
    md = _render()(revision, "md", title="Deep")
    headings = [line for line in lines(md) if line.startswith("#")]
    assert headings == [
        "# Deep",
        "## Level 1",
        "### Level 2",
        "#### Level 3",
        "##### Level 4",
        "###### Level 5",
        "###### Level 6",
        "###### Level 7",
    ], "outline depth n gives n+1 `#`, capped at `######`"
    rows = [line for line in lines(md) if line.startswith("|")]
    assert len(rows) == 3, "header, delimiter and one body row: a cell newline never splits a row"
    assert rows[0].startswith("| a\\|b |"), "a `|` inside a cell is escaped"
    assert "line1" in rows[2], "a newline inside a cell stays in its row"
    assert "line2" in rows[2], "a newline inside a cell stays in its row"
    # Page markers: before the first block of pages 1, 2 and 3.
    assert _previous_nonblank(md, _index_of_line(md, "## Level 1")) == "<!-- p.1 -->"
    assert _previous_nonblank(md, _index_of_line(md, "###### Level 7")) == "<!-- p.2 -->"
    assert _previous_nonblank(md, _index_of_line(md, "Closing paragraph.")) == "<!-- p.3 -->"
    txt = _render()(revision, "txt", title="Deep")
    assert "Level 7" in lines(txt)
    tab_rows = [line for line in lines(txt) if "\t" in line]
    assert len(tab_rows) == 2, "one text line per table row"


def test_doc_03_c02_format_aliases_and_unknown_formats() -> None:
    revision = _fixture_revision("book-ko")
    md = render_revision(revision, "md", title="t")
    assert render_revision(revision, "markdown", title="t") == md
    assert render_revision(revision, ExportFormat.TEXT, title="t") == render_revision(
        revision, "plain", title="t"
    )
    with pytest.raises(ValueError, match="html"):
        render_revision(revision, "html", title="t")


def test_doc_03_c02_paragraph_lines_never_become_markdown_headings_or_page_comments() -> None:
    revision = DocumentRevision(
        document_id="d",
        revision_id="r",
        revision_number=1,
        source_sha256="0" * 64,
        blocks=(
            Block(id="a", type=BlockType.TEXT, text="# not a heading", locations=_loc(1)),
            Block(id="b", type=BlockType.TEXT, text="<!-- p.9 -->\n\n\nnext", locations=_loc(1)),
            Block(id="c", type=BlockType.TEXT, text="   ", locations=_loc(2)),
        ),
    )
    md = render_revision(revision, "md", title="T")
    assert lines(md) == [
        "# T",
        "",
        "<!-- p.1 -->",
        "",
        "\\# not a heading",
        "",
        "\\<!-- p.9 -->",
        "next",
        "",
    ], "escaped lines; a blank-only block (and its page) is left out"
