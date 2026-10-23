"""Chapter/section tree from heading blocks: front matter, TOC cross-check, numbering levels.

Rules (deterministic, see ``restore_hierarchy``):

1. TOC: a heading titled ``목차``/``차례``/``Contents`` or blocks with dot leaders mark TOC pages
   (the first run of such pages, near the start). Everything on them is front matter; the TOC
   text is only used to cross-check the restored titles, never to build the tree.
2. Body start: the first heading with the outermost numbering style used after the TOC
   (``Part``/``제1부`` > ``Chapter 1``/``1장``/``제1장`` > ``제1절`` > ``I.`` > ``1``/``1.`` >
   ``1.1`` > ``1.1.1`` > ``A.`` > ``가.`` > ``(1)``). Without numbering, the first heading after
   the title page. Blocks before it are front matter (title page, preface): no section.
3. Levels: dense rank of the numbering styles in the body. Unnumbered headings in a numbered
   body sit one level below the current chapter, except back matter (``References``,
   ``Appendix``, ``부록`` ...) which is top level. A body without numbering uses the parser's
   heading levels if they vary, else single-line heading heights (font size), else stays flat.
4. Labels (``label_headings``, before 1-3): a chapter label the parser read as plain text
   (``제1 장`` on a chapter opener page) is a heading, except repeats of the current label (thumb
   index, running header); a bare label and its title line on the same page (``제1절`` +
   ``수신 총칙``) are one heading. Unnumbered headings in a numbered body (box titles) never
   parent a heading and never close the numbered sections around them.
5. Numbering gaps and parent/child mismatches (``2.1`` under ``1장``) are reported as warnings;
   the tree follows the heading order regardless.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field

from book_core.contracts import BlockType
from book_core.structure.canonical import CanonicalDraft, ends_sentence
from book_core.structure.numbering import (
    Numbering,
    NumberingKind,
    disambiguate_letters,
    is_back_matter,
    is_bare_label,
    is_toc_title,
    parse_numbering,
)

# Dot leaders: ``....``, ``……``, ``····``, ``____`` and the katakana/halfwidth middle dots and
# bullet operators Korean publishers often use (``・・・・``).
_LEADERS = re.compile(
    r"(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}|(?:_\s?){4,}|(?:[\u30fb\uff65\u2219\u2027]\s?){4,}"
)
_TOC_LEADER_MIN = 3
_TITLE_PAGE_MAX_TEXT = 200
_MAX_FONT_LEVELS = 3
_LABEL_MAX = 40
"""Longest text block read as a printed chapter label (``제1 장``, ``Chapter 3 Methods``)."""
_OUTER_KINDS = frozenset({NumberingKind.PART, NumberingKind.CHAPTER})
_OUTER_LABEL = re.compile(
    r"^(?:제\s*\d{1,4}\s*[부편장]|\d{1,4}\s*[부장]"
    r"|(?:part|chapter|ch\.)\s*(?:\d{1,4}|[ivxlcdm]{1,8}))[.:]?\s*",
    re.IGNORECASE,
)
# Korean predicate endings (``설명한다``, ``이다``, ``됩니다``): a sentence, not a chapter title.
_PREDICATE_END = re.compile(r"(?:[한된있없였같않이]다|니다|어요|해요)$")
# A particle right after the label (``제2장 에서 …``, ``제3장 의 내용``) continues a sentence.
_PARTICLES = frozenset(
    {
        "에서",
        "에서는",
        "에",
        "을",
        "를",
        "은",
        "는",
        "이",
        "가",
        "의",
        "과",
        "와",
        "으로",
        "로",
        "까지",
        "부터",
        "도",
        "만",
        "에는",
        "참조",
        "참고",
    }
)
_LOOSE_DROP = re.compile("[\\s|.·…_:\\-\u2013\u2014]+")


@dataclass(frozen=True, slots=True)
class StructureWarning:
    """Something the heuristics could not decide confidently; the result is still valid."""

    code: str
    message: str
    block_ids: tuple[str, ...] = ()


@dataclass(slots=True)
class SectionDraft:
    heading_index: int
    """Index of the heading in the canonical draft list."""
    title: str
    level: int
    parent: int | None
    """Index of the parent in the section draft list."""
    numbering: Numbering | None


@dataclass(slots=True)
class Hierarchy:
    sections: list[SectionDraft] = field(default_factory=list)
    block_sections: list[int | None] = field(default_factory=list)
    """Per canonical draft, the index of its section (``None`` = front matter / unassigned)."""
    front_matter: list[int] = field(default_factory=list)
    """Drafts before the body (title page, TOC, preface); includes ``toc``."""
    toc: list[int] = field(default_factory=list)
    warnings: list[StructureWarning] = field(default_factory=list)


def loose(text: str) -> str:
    """Comparison key for TOC cross-checks: NFKC, casefolded, no spaces or leader characters."""
    return _LOOSE_DROP.sub("", unicodedata.normalize("NFKC", text).casefold())


def _page(draft: CanonicalDraft) -> int:
    return draft.locations[0][1].page


def _leaders(draft: CanonicalDraft) -> int:
    if draft.type not in (BlockType.TEXT, BlockType.TABLE, BlockType.HEADING):
        return 0
    return len(_LEADERS.findall(draft.text))


def _toc_pages(drafts: Sequence[CanonicalDraft], page_count: int) -> set[int]:
    """The first run of TOC pages near the start.

    Leader evidence is counted per page across blocks (a TOC parsed one entry per block, some
    entries labelled as headings). A run starts on a page with a TOC title, or with at least
    ``_TOC_LEADER_MIN`` leaders and no body-length paragraph (so a leader table inside a chapter
    is not a TOC), and continues over following pages that have a TOC title or are made up
    mostly of leader entries.
    """
    leaders: dict[int, int] = {}
    entries: dict[int, int] = {}
    blocks: dict[int, int] = {}
    titled: set[int] = set()
    prose: set[int] = set()
    for d in drafts:
        page, count = _page(d), _leaders(d)
        leaders[page] = leaders.get(page, 0) + count
        entries[page] = entries.get(page, 0) + (count > 0)
        blocks[page] = blocks.get(page, 0) + 1
        if d.type is BlockType.HEADING and is_toc_title(d.text):
            titled.add(page)
        if d.type is BlockType.TEXT and count == 0 and len(d.text) >= _TITLE_PAGE_MAX_TEXT:
            prose.add(page)

    def starts(page: int) -> bool:
        return page in titled or (leaders.get(page, 0) >= _TOC_LEADER_MIN and page not in prose)

    def continues(page: int) -> bool:
        if page in titled:
            return True
        if page not in blocks or page in prose:
            return False
        return leaders[page] >= _TOC_LEADER_MIN or 2 * entries[page] > blocks[page]

    start = next((p for p in sorted(blocks) if starts(p)), None)
    if start is None or start > max(4, page_count // 10):
        return set()
    pages = {start}
    page = start + 1
    while continues(page):
        pages.add(page)
        page += 1
    return pages


def _rank_unnumbered(
    drafts: Sequence[CanonicalDraft], heads: list[int]
) -> tuple[dict[int, float], str]:
    """Ranks for a body without numbering: parser hints, else font size, else flat."""
    hints = [drafts[i].first.heading_level for i in heads]
    if all(h is not None for h in hints) and len(set(hints)) > 1:
        return {
            i: float(h or 1) for i, h in zip(heads, hints, strict=True)
        }, "parser heading levels"
    heights: list[float | None] = []
    for i in heads:
        locs = drafts[i].locations
        bbox = locs[0][1].bbox if len(locs) == 1 else None
        heights.append(round((bbox.y1 - bbox.y0) * 2) / 2 if bbox is not None else None)
    distinct = {h for h in heights if h is not None}
    if None not in heights and 1 < len(distinct) <= _MAX_FONT_LEVELS:
        return {i: -(h or 0.0) for i, h in zip(heads, heights, strict=True)}, "heading heights"
    return dict.fromkeys(heads, 0.0), ""


def _joined(head: CanonicalDraft, title: CanonicalDraft) -> CanonicalDraft:
    return CanonicalDraft(
        BlockType.HEADING,
        f"{head.text} {title.text}",
        [*head.sources, *title.sources],
        [*head.locations, *title.locations],
    )


def _label_title(label: CanonicalDraft, nxt: CanonicalDraft, *, allow_text: bool) -> bool:
    """``nxt`` is the title line printed right after a bare label (``제1절`` / ``수신 총칙``)."""
    allowed = (BlockType.HEADING, BlockType.TEXT) if allow_text else (BlockType.HEADING,)
    return (
        nxt.type in allowed
        and _page(nxt) == _page(label)
        and 0 < len(nxt.text) <= _LABEL_MAX
        and parse_numbering(nxt.text) is None
        and not is_toc_title(nxt.text)
        and not is_back_matter(nxt.text)
        and _leaders(nxt) == 0
    )


def _opener_text(text: str) -> bool:
    """A Part/Chapter label printed as an opener, not a sentence that starts with one: the bare
    label, or the label and a short title (no sentence end, no predicate ending, no particle or
    lowercase word right after the label)."""
    normalized = unicodedata.normalize("NFKC", text).strip()
    if is_bare_label(normalized):
        return True
    match = _OUTER_LABEL.match(normalized)
    if match is None:
        return False
    title = normalized[match.end() :]
    first = title.split(maxsplit=1)[0] if title else ""
    return not (
        not title
        or ends_sentence(title)
        or _PREDICATE_END.search(title) is not None
        or first in _PARTICLES
        or (first[:1].isascii() and first[:1].islower())
    )


def label_headings(drafts: Sequence[CanonicalDraft], page_count: int) -> list[CanonicalDraft]:
    """Headings the parser split or missed, restored before ``restore_hierarchy``.

    1. Printed chapter labels: after the TOC, a short text block that is a Part/Chapter label
       (``제1 장``, ``Chapter 3 Methods``) becomes a heading, since books set chapter openers as
       display text the layout model labels as plain text (or as a picture, see the Docling
       adapter). A label repeating the current Part/Chapter number (a thumb index or running
       header on every page, or the text copy of a parser heading) stays text, so only the
       first occurrence of each number opens a chapter. A sentence that starts with a label
       (``Chapter 2 describes …``, ``제2장 에서 설명한다.``) stays text and does not count.
    2. A bare label and its title line on the same page (``제1절`` + ``수신 총칙``,
       ``제1 장`` + ``수신제도``) become one heading; a parser heading only joins a heading.
    """
    toc_pages = _toc_pages(drafts, page_count)
    after_toc = max((i + 1 for i, d in enumerate(drafts) if _page(d) in toc_pages), default=0)
    result = list(drafts[:after_toc])
    current: dict[NumberingKind, tuple[int, ...]] = {}
    i = after_toc
    while i < len(drafts):
        draft = drafts[i]
        i += 1
        numbering = (
            parse_numbering(draft.text)
            if draft.type in (BlockType.HEADING, BlockType.TEXT)
            else None
        )
        promoted = False
        if numbering is not None and numbering.kind in _OUTER_KINDS:
            if draft.type is BlockType.TEXT:
                if (
                    len(draft.text) > _LABEL_MAX
                    or not _opener_text(draft.text)
                    or current.get(numbering.kind) == numbering.numbers
                ):
                    result.append(draft)
                    continue
                draft = CanonicalDraft(
                    BlockType.HEADING, draft.text, list(draft.sources), list(draft.locations)
                )
                promoted = True
            current[numbering.kind] = numbering.numbers
            if numbering.kind is NumberingKind.PART:
                current.pop(NumberingKind.CHAPTER, None)
        if (
            draft.type is BlockType.HEADING
            and is_bare_label(draft.text)
            and i < len(drafts)
            and _label_title(draft, drafts[i], allow_text=promoted)
        ):
            draft = _joined(draft, drafts[i])
            i += 1
        result.append(draft)
    return result


def restore_hierarchy(drafts: Sequence[CanonicalDraft], page_count: int) -> Hierarchy:
    result = Hierarchy(block_sections=[None] * len(drafts))
    warn = result.warnings

    toc_pages = _toc_pages(drafts, page_count)
    result.toc = [i for i, d in enumerate(drafts) if _page(d) in toc_pages]
    after_toc = result.toc[-1] + 1 if result.toc else 0
    heads = [
        i
        for i in range(after_toc, len(drafts))
        if drafts[i].type is BlockType.HEADING and i not in result.toc
    ]
    numbering = dict(
        zip(
            heads,
            disambiguate_letters([parse_numbering(drafts[i].text) for i in heads]),
            strict=True,
        )
    )
    kinds = {n.kind for n in numbering.values() if n is not None}

    if not heads:
        result.front_matter = list(range(len(drafts)))
        warn.append(StructureWarning("no_headings", "no headings found; no sections restored"))
        return result

    if kinds:
        top = min(kinds)
        start = next(i for i in heads if (n := numbering[i]) is not None and n.kind is top)
    else:
        page_one_text = sum(
            len(d.text) for d in drafts if _page(d) == 1 and d.type is BlockType.TEXT
        )
        title_page = (
            page_count > 1
            and page_one_text < _TITLE_PAGE_MAX_TEXT
            and any(_page(drafts[i]) > 1 for i in heads)
        )
        start = next(i for i in heads if not title_page or _page(drafts[i]) > 1)
    result.front_matter = list(range(start))
    heads = [i for i in heads if i >= start]

    ranks: dict[int, float] = {}
    body_kinds = sorted({n.kind for i in heads if (n := numbering[i]) is not None})
    dense = {kind: float(rank) for rank, kind in enumerate(body_kinds)}
    if body_kinds:
        chapter_rank = dense.get(NumberingKind.CHAPTER, 0.0)
        unnumbered = [
            i for i in heads if numbering[i] is None and not is_back_matter(drafts[i].text)
        ]
        for i in heads:
            n = numbering[i]
            if n is not None:
                ranks[i] = dense[n.kind]
            elif is_back_matter(drafts[i].text):
                ranks[i] = 0.0
            else:
                ranks[i] = chapter_rank + 0.5
        if unnumbered:
            warn.append(
                StructureWarning(
                    "unnumbered_heading",
                    "unnumbered headings in a numbered body were placed one level below the "
                    "current chapter",
                    tuple(drafts[i].first.id for i in unnumbered),
                )
            )
    else:
        ranks, source = _rank_unnumbered(drafts, heads)
        if source:
            warn.append(
                StructureWarning(
                    "levels_from_layout", f"no heading numbering; levels from {source}"
                )
            )
        else:
            warn.append(
                StructureWarning(
                    "flat_sections", "no heading numbering or level signal; sections kept flat"
                )
            )

    # Interim headings: unnumbered headings in a numbered body (a box title, "학습 목표"). They
    # sit one level below the current chapter but never parent a heading and never close the
    # numbered sections around them, so ``가.`` after a box title stays under its ``1-3.``.
    interims = (
        {i for i in heads if numbering[i] is None and not is_back_matter(drafts[i].text)}
        if body_kinds
        else set()
    )
    stack: list[tuple[float, int]] = []  # (rank, section index)
    last_sibling: dict[tuple[int | None, NumberingKind], int] = {}
    current: int | None = None
    head_set = set(heads)
    for i in range(start, len(drafts)):
        if i in result.toc:
            continue
        if i in head_set:
            rank = ranks[i]
            n = numbering[i]
            if i in interims:
                # Below the current chapter, leaving the numbered stack as it is.
                parent = next((sec for r, sec in reversed(stack) if r < rank), None)
            else:
                while stack and stack[-1][0] >= rank:
                    stack.pop()
                parent = stack[-1][1] if stack else None
            level = result.sections[parent].level + 1 if parent is not None else 1
            result.sections.append(SectionDraft(i, drafts[i].text, level, parent, n))
            current = len(result.sections) - 1
            if i not in interims:
                stack.append((rank, current))
            if n is not None:
                _check_numbering(result, current, n, last_sibling, drafts)
        result.block_sections[i] = current

    if result.toc:
        _cross_check_toc(result, drafts)
    return result


def _check_numbering(
    result: Hierarchy,
    index: int,
    numbering: Numbering,
    last_sibling: dict[tuple[int | None, NumberingKind], int],
    drafts: Sequence[CanonicalDraft],
) -> None:
    section = result.sections[index]
    block_id = drafts[section.heading_index].first.id
    parent = result.sections[section.parent] if section.parent is not None else None
    if (
        len(numbering.numbers) > 1
        and parent is not None
        and parent.numbering is not None
        and numbering.numbers[:-1] != parent.numbering.numbers
    ):
        result.warnings.append(
            StructureWarning(
                "numbering_mismatch",
                f"{section.title!r} does not continue the numbering of {parent.title!r}",
                (block_id,),
            )
        )
    key = (section.parent, numbering.kind)
    previous = last_sibling.get(key)
    if previous is not None and numbering.numbers[-1] != previous + 1:
        result.warnings.append(
            StructureWarning(
                "numbering_gap",
                f"{section.title!r} follows number {previous} at the same level",
                (block_id,),
            )
        )
    last_sibling[key] = numbering.numbers[-1]


def _cross_check_toc(result: Hierarchy, drafts: Sequence[CanonicalDraft]) -> None:
    toc_text = "".join(loose(drafts[i].text) for i in result.toc)
    missing = [s for s in result.sections if loose(s.title) not in toc_text]
    if missing:
        result.warnings.append(
            StructureWarning(
                "toc_mismatch",
                "restored headings not found in the printed TOC: "
                + ", ".join(repr(s.title) for s in missing),
                tuple(drafts[s.heading_index].first.id for s in missing),
            )
        )
