"""Pure rules of highlight anchors (HILITE-01-C03/C05, docs/questions.md §15).

An anchor is ``{block, start, end}``: ``block`` names one paragraph of the target text — a note
item ``s<i>.i<j>`` (``sections[i].items[j]`` of the presented note body, rendered text without
footnote tags) or an explanation paragraph ``p<i>`` (blank-line separated, 0-based) — and
``start``/``end`` are UTF-16 offsets into that block (JavaScript string indices), end exclusive.

The server cuts the quote and up to ``CONTEXT_CHARS`` characters before/after it from the stored
text (`cut`). When the text changed (a new question revision), `relocate` finds the quote again
in the current text: among the occurrences of the quote the one whose surroundings match the
stored prefix/suffix best, then the one nearest the original position. A relocated anchor always
points at the quote itself; without an occurrence it is missing.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from quiz_api.chapter_notes import Ref, present_body

QUOTE_MAX_CHARS = 2000
CONTEXT_CHARS = 32
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
_NOTE_BLOCK = re.compile(r"^s(\d{1,4})\.i(\d{1,4})$")
_PARAGRAPH_BLOCK = re.compile(r"^p(\d{1,4})$")


class AnchorError(ValueError):
    """The anchor does not name a non-empty range inside one block of the text."""


@dataclass(frozen=True)
class Anchor:
    block: str
    start: int
    end: int

    def as_dict(self) -> dict[str, Any]:
        return {"block": self.block, "start": self.start, "end": self.end}


@dataclass(frozen=True)
class Cut:
    quote: str
    prefix: str
    suffix: str


# --- blocks ---------------------------------------------------------------------------------------


def explanation_blocks(explanation: str | None) -> dict[str, str]:
    """``p<i>`` -> paragraph text (the split the client uses: ``/\\n\\s*\\n/``)."""
    if not explanation:
        return {}
    return {f"p{i}": part for i, part in enumerate(_PARAGRAPH_SPLIT.split(explanation))}


def note_blocks(body: Any, refs: list[Ref]) -> dict[str, str]:
    """``s<i>.i<j>`` -> item text of the presented note body (what the panel renders)."""
    sections, _ = present_body(body, refs, {})
    return {
        f"s{i}.i{j}": item.text
        for i, section in enumerate(sections)
        for j, item in enumerate(section.items)
    }


def block_order(block: str) -> tuple[int, ...]:
    """Reading order of a block name (unknown shapes last)."""
    m = _NOTE_BLOCK.match(block)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    m = _PARAGRAPH_BLOCK.match(block)
    if m:
        return (int(m.group(1)),)
    return (1_000_000,)


# --- UTF-16 offsets -------------------------------------------------------------------------------


def _units(ch: str) -> int:
    return 2 if ord(ch) > 0xFFFF else 1


def utf16_length(text: str) -> int:
    return sum(_units(ch) for ch in text)


def to_index(text: str, offset: int) -> int:
    """Python index of a UTF-16 offset; AnchorError inside a surrogate pair or past the end."""
    if offset < 0:
        raise AnchorError("negative offset")
    units = 0
    for index, ch in enumerate(text):
        if units == offset:
            return index
        units += _units(ch)
        if units > offset:
            raise AnchorError("offset inside a character")
    if units == offset:
        return len(text)
    raise AnchorError("offset past the end of the block")


def to_offset(text: str, index: int) -> int:
    return utf16_length(text[:index])


# --- cut and relocate -----------------------------------------------------------------------------


def cut(blocks: Mapping[str, str], anchor: Anchor) -> Cut:
    """The quote and its context of a valid anchor (AnchorError otherwise)."""
    text = blocks.get(anchor.block)
    if text is None:
        raise AnchorError("unknown block")
    if anchor.start >= anchor.end:
        raise AnchorError("empty range")
    start = to_index(text, anchor.start)
    end = to_index(text, anchor.end)
    quote = text[start:end]
    if len(quote) > QUOTE_MAX_CHARS:
        raise AnchorError("quote too long")
    return Cut(
        quote=quote,
        prefix=text[max(0, start - CONTEXT_CHARS) : start],
        suffix=text[end : end + CONTEXT_CHARS],
    )


def _common_suffix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _common_prefix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def relocate(
    blocks: Mapping[str, str], original: Anchor, quote: str, prefix: str, suffix: str
) -> Anchor | None:
    """The quote's position in `blocks`, or None when the text no longer contains it."""
    if not quote:
        return None
    origin_order = block_order(original.block)
    best: tuple[tuple[int, ...], Anchor] | None = None
    for block, text in blocks.items():
        start = text.find(quote)
        while start != -1:
            end = start + len(quote)
            score = _common_suffix(text[max(0, start - CONTEXT_CHARS) : start], prefix)
            score += _common_prefix(text[end : end + CONTEXT_CHARS], suffix)
            begin = to_offset(text, start)
            candidate = Anchor(block, begin, begin + utf16_length(quote))
            order = block_order(block)
            key = (
                -score,
                0 if block == original.block else 1,
                abs(order[0] - origin_order[0]),
                abs(begin - original.start),
                *order,
                begin,
            )
            if best is None or key < best[0]:
                best = (key, candidate)
            start = text.find(quote, start + 1)
    return best[1] if best is not None else None


def overlaps(a: Anchor, b: Anchor) -> bool:
    """Same block and intersecting ranges (touching ranges do not overlap)."""
    return a.block == b.block and a.start < b.end and b.start < a.end
