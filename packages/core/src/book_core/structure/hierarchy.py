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
4. Numbering gaps and parent/child mismatches (``2.1`` under ``1장``) are reported as warnings;
   the tree follows the heading order regardless.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field

from book_core.contracts import BlockType
from book_core.structure.canonical import CanonicalDraft
from book_core.structure.numbering import (
    Numbering,
    NumberingKind,
    is_back_matter,
    is_toc_title,
    parse_numbering,
)

_LEADERS = re.compile(r"(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}|(?:_\s?){4,}")
_TOC_LEADER_MIN = 3
_TITLE_PAGE_MAX_TEXT = 200
_MAX_FONT_LEVELS = 3
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


def _is_toc_like(draft: CanonicalDraft) -> bool:
    if draft.type not in (BlockType.TEXT, BlockType.TABLE):
        return False
    return len(_LEADERS.findall(draft.text)) >= _TOC_LEADER_MIN


def _toc_pages(drafts: Sequence[CanonicalDraft], page_count: int) -> set[int]:
    """The first run of TOC pages near the start: a page with a TOC title, or with dot-leader
    blocks and no body-length paragraph (so a leader table inside a chapter is not a TOC)."""
    prose_pages = {
        _page(d)
        for d in drafts
        if d.type is BlockType.TEXT and len(d.text) >= _TITLE_PAGE_MAX_TEXT and not _is_toc_like(d)
    }
    candidates = {
        _page(d)
        for d in drafts
        if (d.type is BlockType.HEADING and is_toc_title(d.text))
        or (_is_toc_like(d) and _page(d) not in prose_pages)
    }
    if not candidates:
        return set()
    start = min(candidates)
    if start > max(4, page_count // 10):
        return set()
    pages = set()
    page = start
    while page in candidates:
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
    numbering = {i: parse_numbering(drafts[i].text) for i in heads}
    kinds = {n.kind for n in numbering.values() if n is not None}

    if not heads:
        result.front_matter = list(range(len(drafts)))
        warn.append(StructureWarning("no_headings", "no headings found; no sections restored"))
        return result

    if kinds:
        top = min(kinds)
        start = next(i for i in heads if (n := numbering[i]) is not None and n.kind is top)
    else:
        page_one_text = max(
            (len(d.text) for d in drafts if _page(d) == 1 and d.type is BlockType.TEXT), default=0
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

    stack: list[tuple[float, int]] = []  # (rank, section index)
    last_sibling: dict[tuple[int | None, NumberingKind], int] = {}
    current: int | None = None
    head_set = set(heads)
    for i in range(start, len(drafts)):
        if i in result.toc:
            continue
        if i in head_set:
            rank = ranks[i]
            while stack and stack[-1][0] >= rank:
                stack.pop()
            parent = stack[-1][1] if stack else None
            level = result.sections[parent].level + 1 if parent is not None else 1
            n = numbering[i]
            result.sections.append(SectionDraft(i, drafts[i].text, level, parent, n))
            current = len(result.sections) - 1
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
