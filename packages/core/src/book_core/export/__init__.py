"""Full-text export of a canonical revision as Markdown or plain text (DOC-03, DOCTXT).

``render_revision(revision, format, *, title)`` is a pure, deterministic function of its
arguments: the same revision and title always give the same string (UTF-8 without BOM once
encoded, LF line endings, one trailing newline).

Markdown (``md``): the document title as the only ``#`` heading; a section heading at outline
depth n becomes n+1 ``#`` (capped at ``######``); paragraphs separated by blank lines; tables as
GFM tables (the first row is the header row, ``|`` in a cell escaped, a newline in a cell is
``<br>``); image blocks as the ``[그림 p.N]`` placeholder (their caption is its own block); a
``<!-- p.N -->`` comment right before the first block that starts on page N.

Plain text (``txt``): the same blocks in the same order; headings one line as they are, tables one
line per row with tab-separated cells, the same figure placeholder and a ``[p.N]`` line instead of
the page comment.
"""

from __future__ import annotations

import re
from enum import StrEnum

from book_core.contracts.document import Block, BlockType, DocumentRevision

__all__ = ["FIGURE_PLACEHOLDER", "ExportFormat", "render_revision"]

MAX_MARKDOWN_HEADING = 6
FIGURE_PLACEHOLDER = "[그림 p.{page}]"

_BLANK_LINES = re.compile(r"\n[ \t]*(?:\n[ \t]*)+")
_WHITESPACE = re.compile(r"\s+")


class ExportFormat(StrEnum):
    MARKDOWN = "md"
    TEXT = "txt"

    @classmethod
    def parse(cls, value: str) -> ExportFormat:
        """``md`` / ``txt`` (also ``markdown`` / ``plain``, the names in docs/architecture.md)."""
        aliases = {"markdown": cls.MARKDOWN, "plain": cls.TEXT}
        return aliases.get(value) or cls(value)


def _one_line(text: str) -> str:
    return _WHITESPACE.sub(" ", text).strip()


def _paragraph(text: str) -> str:
    """Block text with inner blank lines removed, so a block stays one paragraph."""
    return _BLANK_LINES.sub("\n", text.strip())


def _md_paragraph(text: str) -> str:
    """A paragraph whose lines cannot turn into headings or page comments."""
    lines = []
    for line in _paragraph(text).split("\n"):
        if line.startswith("#") or line.startswith("<!--"):
            line = "\\" + line
        lines.append(line)
    return "\n".join(lines)


def _md_cell(cell: str) -> str:
    text = cell.replace("\\", "\\\\").replace("|", "\\|")
    return "<br>".join(_one_line(part) for part in text.split("\n") if part.strip())


def _txt_cell(cell: str) -> str:
    return _one_line(cell)


def _md_table(block: Block) -> str:
    assert block.table is not None  # noqa: S101 - callers check
    rows = [[_md_cell(cell) for cell in row] for row in block.table.rows]
    width = len(rows[0])
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(row) + " |" for row in rows[1:]]
    return "\n".join(lines)


def _txt_table(block: Block) -> str:
    assert block.table is not None  # noqa: S101 - callers check
    return "\n".join("\t".join(_txt_cell(cell) for cell in row) for row in block.table.rows)


def _heading_depths(revision: DocumentRevision) -> dict[str, int]:
    """Heading block id -> outline depth (1 = chapter) of the section it opens."""
    return {
        section.heading_block_id: section.level
        for section in revision.sections
        if section.heading_block_id is not None
    }


def _render_block(block: Block, fmt: ExportFormat, depth: int) -> str | None:
    page = block.locations[0].page
    if block.type is BlockType.IMAGE:
        return FIGURE_PLACEHOLDER.format(page=page)
    if block.type is BlockType.HEADING:
        text = _one_line(block.text)
        if not text:
            return None
        if fmt is ExportFormat.TEXT:
            return text
        return "#" * min(depth + 1, MAX_MARKDOWN_HEADING) + " " + text
    if block.type is BlockType.TABLE and block.table is not None:
        return _md_table(block) if fmt is ExportFormat.MARKDOWN else _txt_table(block)
    if not block.text.strip():
        return None
    return _md_paragraph(block.text) if fmt is ExportFormat.MARKDOWN else _paragraph(block.text)


def render_revision(revision: DocumentRevision, format: str, *, title: str) -> str:
    """The revision's canonical blocks, in reading order, as one Markdown or text file."""
    fmt = ExportFormat.parse(str(format))
    depths = _heading_depths(revision)
    head = _one_line(title)
    parts: list[str] = []
    if head:
        parts.append(f"# {head}" if fmt is ExportFormat.MARKDOWN else head)
    current_page: int | None = None
    ordered = sorted(
        enumerate(revision.blocks),
        key=lambda item: (item[1].ordinal if item[1].ordinal is not None else item[0], item[0]),
    )
    for _, block in ordered:
        depth = depths.get(block.id) or block.heading_level or 1
        rendered = _render_block(block, fmt, depth)
        if rendered is None:
            continue
        page = block.locations[0].page
        if page != current_page:
            parts.append(f"<!-- p.{page} -->" if fmt is ExportFormat.MARKDOWN else f"[p.{page}]")
            current_page = page
        parts.append(rendered)
    return "\n\n".join(parts) + "\n"
