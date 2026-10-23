"""Canonical text: whitespace/hyphenation normalization and merging of split paragraphs."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from book_core.contracts import Block, BlockType, SourceLocation
from book_core.structure.numbering import NumberingKind, parse_numbering

_HSPACE = re.compile(r"[^\S\n]+")
_SOFT_HYPHEN = "­"
# Some PDFs map the printed hyphen of ``1-1.`` style numbers to U+00AD; between digits it is a
# visible hyphen, never an invisible hyphenation point.
_DIGIT_SOFT_HYPHEN = re.compile(r"(?<=\d)\u00ad(?=\d)")
# A word broken at a line end: ``infil- tration``. Suspended compounds (``pre- and post-war``)
# keep their hyphen.
_LINE_HYPHEN = re.compile(r"(?<=[a-z]{2})- (?=([a-z]{2,}))")
_SUSPENDED_NEXT = frozenset({"and", "or", "nor", "to", "versus", "vs"})
_SENTENCE_END = frozenset(".!?。\uff01\uff1f…:;")
_CLOSERS = frozenset("\"'”\u2019)]}»」』〉》")
_ITEM_START = re.compile(
    r"^(?:[-•·▪◦●○■□※*]\s|[①-⑳]|\(?\d{1,3}[.)]\s|[가-하][.)]\s|[A-Za-z][.)]\s"
    r"|(?:그림|표|사진|figure|fig\.|table)\s*\d)",
    re.IGNORECASE,
)
_COLUMN_TOLERANCE = 2.0


def _is_cjk_no_space(ch: str) -> bool:
    """Scripts written without spaces between words (Han, kana); Hangul uses spaces."""
    code = ord(ch)
    return 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF


def _is_hangul(ch: str) -> bool:
    code = ord(ch)
    return 0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F


def _dehyphenate(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        return "- " if match.group(1) in _SUSPENDED_NEXT else ""

    return _LINE_HYPHEN.sub(repl, text)


def normalize_block_text(text: str, block_type: BlockType, *, dehyphenate: bool = True) -> str:
    """NFC, no soft hyphens (one between digits is a printed hyphen: ``-``), horizontal whitespace
    collapsed; line breaks are kept only in tables (row separators). With ``dehyphenate``, EN
    words broken at a line end are rejoined in text blocks. Wording is never changed."""
    text = unicodedata.normalize("NFC", text)
    text = _DIGIT_SOFT_HYPHEN.sub("-", text).replace(_SOFT_HYPHEN, "")
    if block_type is BlockType.TABLE:
        lines = (_HSPACE.sub(" ", line).strip() for line in text.split("\n"))
        return "\n".join(line for line in lines if line)
    text = " ".join(text.split())
    if dehyphenate and block_type is BlockType.TEXT:
        text = _dehyphenate(text)
    return text


def ends_sentence(text: str) -> bool:
    stripped = text.rstrip()
    while stripped and stripped[-1] in _CLOSERS:
        stripped = stripped[:-1]
    return not stripped or stripped[-1] in _SENTENCE_END


def _continues(prev: str, nxt: str) -> bool:
    """Whether ``nxt`` reads as the continuation of the unfinished sentence ending ``prev``."""
    if not prev or not nxt or ends_sentence(prev) or _ITEM_START.match(nxt):
        return False
    label = parse_numbering(nxt)
    if label is not None and label.kind <= NumberingKind.KO_SECTION:
        return False  # a Part/Chapter/제N절 label (chapter opener) starts a new block
    last, first = prev.rstrip()[-1], nxt[0]
    if first.isascii() and first.isalpha():
        return first.islower() or last in ",-\u2013"
    if _is_hangul(first) or _is_cjk_no_space(first):
        return last.isalnum() or last in ",、"
    if first.isdigit():
        return (last.isalpha() and last.islower()) or last == ","
    return False


def join_texts(prev: str, nxt: str) -> str:
    """Join two fragments of one paragraph (``prev`` ends mid-sentence)."""
    if prev.endswith("-") and len(prev) > 2 and prev[-2].islower() and nxt[:1].islower():
        word = re.match(r"[a-z]+", nxt)
        if word is None or word.group(0) not in _SUSPENDED_NEXT:
            return prev[:-1] + nxt
    if _is_cjk_no_space(prev[-1]) and _is_cjk_no_space(nxt[0]):
        return prev + nxt
    return f"{prev} {nxt}"


def _column_break(prev: SourceLocation, nxt: SourceLocation) -> bool:
    """``nxt`` starts at the top of the next column on the same page."""
    if prev.page != nxt.page or prev.bbox is None or nxt.bbox is None:
        return False
    return nxt.bbox.x0 >= prev.bbox.x1 - _COLUMN_TOLERANCE and nxt.bbox.y0 < prev.bbox.y0


@dataclass(slots=True)
class CanonicalDraft:
    """A canonical block before ids are assigned: one or more consecutive parser blocks."""

    type: BlockType
    text: str
    sources: list[Block]
    locations: list[tuple[str, SourceLocation]]

    @property
    def first(self) -> Block:
        return self.sources[0]


def mergeable(prev: CanonicalDraft, block: Block, caption_ids: set[str]) -> bool:
    """A text block continues the previous text block across a page or column break."""
    if prev.type is not BlockType.TEXT or block.type is not BlockType.TEXT:
        return False
    if block.id in caption_ids or any(s.id in caption_ids for s in prev.sources):
        return False
    last = prev.locations[-1][1]
    first = block.locations[0]
    if first.page != last.page + 1 and not _column_break(last, first):
        return False
    return _continues(prev.text, block.text)


def canonical_drafts(blocks: Sequence[Block]) -> list[CanonicalDraft]:
    """Normalize parser blocks and merge paragraphs split across pages/columns.

    Only directly adjacent text blocks merge, so nothing merges across a heading, table, figure
    or caption; tables, images and formulas stay one canonical block each.
    """
    caption_ids = {b.caption_block_id for b in blocks if b.caption_block_id is not None}
    drafts: list[CanonicalDraft] = []
    for block in blocks:
        text = normalize_block_text(block.text, block.type)
        located = [(block.id, loc) for loc in block.locations]
        if drafts and mergeable(drafts[-1], block.model_copy(update={"text": text}), caption_ids):
            prev = drafts[-1]
            prev.text = join_texts(prev.text, text)
            prev.sources.append(block)
            prev.locations.extend(located)
            continue
        drafts.append(CanonicalDraft(block.type, text, [block], located))
    return drafts
