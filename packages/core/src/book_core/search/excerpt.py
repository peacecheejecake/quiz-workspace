"""Paragraph-complete excerpts with page/bbox provenance for search hits (Task M2.5).

Chunks are retrieval units: a child may be a window in the middle of a long paragraph, or lead
with a heading. ``ExcerptResolver`` works on the canonical revision instead (architecture.md
§4): the hit's blocks are expanded to whole paragraphs (a table or figure travels with its
caption as one unit), surrounded by a configurable number of context units of the same section,
and every page/bbox of the shown blocks is attached so the UI can jump into the PDF
(SEARCH-01-AC03). The matched passage and the query terms are located inside the excerpt as
character offsets for highlighting.

Everything is computed from the revision the hit belongs to, so excerpts of edited revisions
show the corrected text while their provenance still points at the original pages.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from book_core.chunker import caption_links, sentence_spans
from book_core.contracts import (
    Block,
    BlockType,
    DocumentRevision,
    Excerpt,
    SearchChunk,
    SearchHit,
    Section,
    SourceLocation,
    TextSpan,
)
from book_core.search.service import RankedHit

UNIT_SEPARATOR = "\n\n"


@dataclass(frozen=True, slots=True)
class ExcerptConfig:
    """How much text an excerpt shows.

    - ``context_before`` / ``context_after``: paragraphs (or table/figure units) added before
      the first and after the last matched unit. Headings are not context (the section path is
      in ``Excerpt.breadcrumb``) and neither are figures without any text.
    - ``cross_sections``: context may continue into neighbouring sections (their headings then
      count as context units); by default it stops at the section boundary.
    - ``max_chars``: upper bound on ``Excerpt.text``. Longer excerpts are cut at sentence
      boundaries (word boundaries when one sentence is too long) around the matched passage.
    """

    context_before: int = 1
    context_after: int = 1
    cross_sections: bool = False
    max_chars: int = 1600

    def __post_init__(self) -> None:
        for name in ("context_before", "context_after", "max_chars"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be an integer >= 0")
        if self.max_chars < 1:
            raise ValueError("max_chars must be >= 1")


class ExcerptError(ValueError):
    """The hit does not belong to the resolver's revision or names unknown blocks."""


@dataclass(frozen=True, slots=True)
class _Unit:
    """Blocks shown together: one block, or a table/figure with its caption (reading order)."""

    blocks: tuple[Block, ...]
    text: str
    section_id: str | None
    heading: bool


def _units(blocks: Sequence[Block]) -> list[_Unit]:
    units: list[_Unit] = []
    start = 0
    while start < len(blocks):
        # Captions are linked within a run of one section, as the chunker does.
        end = start
        while end < len(blocks) and blocks[end].section_id == blocks[start].section_id:
            end += 1
        run = blocks[start:end]
        position = {b.id: i for i, b in enumerate(run)}
        caption_of = caption_links(run)
        by_id = {b.id: b for b in run}
        owner_of = {cap.id: by_id[owner] for owner, cap in caption_of.items()}
        emitted: set[str] = set()
        for block in run:
            if block.id in emitted:
                continue
            owner = owner_of.get(block.id, block)
            if owner.id in emitted:
                owner = block
            caption = caption_of.get(owner.id)
            if caption is not None and caption.id in emitted:
                caption = None
            members = sorted(
                [owner, *([caption] if caption is not None else [])], key=lambda b: position[b.id]
            )
            emitted.update(m.id for m in members)
            units.append(
                _Unit(
                    blocks=tuple(members),
                    text="\n".join(m.text for m in members if m.text.strip()),
                    section_id=owner.section_id,
                    heading=owner.type is BlockType.HEADING and caption is None,
                )
            )
        start = end
    return units


class ExcerptResolver:
    """Builds ``Excerpt``s for hits of one ``DocumentRevision``.

    ``document_title`` (when known) leads the breadcrumb, as in the chunker. The resolver is
    immutable and deterministic: the same hit always gives the same excerpt.
    """

    def __init__(
        self,
        revision: DocumentRevision,
        *,
        config: ExcerptConfig | None = None,
        document_title: str | None = None,
    ) -> None:
        self._revision = revision
        self._config = config or ExcerptConfig()
        self._units = _units(revision.blocks)
        self._unit_of = {b.id: i for i, u in enumerate(self._units) for b in u.blocks}
        self._sections = {s.id: s for s in revision.sections}
        title = document_title.strip() if document_title else ""
        self._title = title or None

    @property
    def revision(self) -> DocumentRevision:
        return self._revision

    def resolve_hit(
        self,
        hit: RankedHit | SearchHit | SearchChunk,
        *,
        query: str | None = None,
        config: ExcerptConfig | None = None,
    ) -> Excerpt:
        """Excerpt for a search result. A ``SearchHit`` names its blocks through its locations;
        its ``passage`` (the chunk content) is the matched span."""
        if isinstance(hit, RankedHit):
            hit = hit.chunk
        if isinstance(hit, SearchChunk):
            document_id, revision_id = hit.document_id, hit.revision_id
            block_ids: Sequence[str] = hit.block_ids
            chunk_id, passage = hit.id, hit.content
        else:
            document_id, revision_id = hit.document_id, hit.revision_id
            block_ids = list(dict.fromkeys(loc.block_id for loc in hit.locations if loc.block_id))
            chunk_id, passage = hit.chunk_id, hit.passage
        if document_id != self._revision.document_id or revision_id != self._revision.revision_id:
            raise ExcerptError(
                f"hit of {document_id}/{revision_id} does not belong to revision "
                f"{self._revision.document_id}/{self._revision.revision_id}"
            )
        return self.resolve(
            block_ids, chunk_id=chunk_id, passage=passage, query=query, config=config
        )

    def resolve(
        self,
        block_ids: Iterable[str],
        *,
        chunk_id: str | None = None,
        passage: str | None = None,
        query: str | None = None,
        config: ExcerptConfig | None = None,
    ) -> Excerpt:
        """Excerpt around canonical ``block_ids`` of this revision.

        ``passage`` is the matched text (e.g. a child chunk's content: blank-line separated
        verbatim slices of the blocks); it is located inside the excerpt for ``highlights``.
        Without it, or when none of it is found (text from another revision), the whole matched
        units are highlighted. ``query`` adds ``term_highlights``.
        """
        config = config or self._config
        ids = list(dict.fromkeys(block_ids))
        if not ids:
            raise ExcerptError("an excerpt needs at least one block id")
        unknown = [bid for bid in ids if bid not in self._unit_of]
        if unknown:
            raise ExcerptError(f"unknown block ids: {', '.join(unknown)}")

        hit_units = sorted({self._unit_of[bid] for bid in ids})
        # A leading heading of a chunk is context, not the match (it is in the breadcrumb).
        content_units = [i for i in hit_units if not self._units[i].heading]
        matched = content_units or hit_units
        matched_set = set(matched)
        first, last = matched[0], matched[-1]
        selected = [
            i for i in range(first, last + 1) if i in matched_set or self._units[i].text.strip()
        ]
        before = self._context(first, -1, config.context_before, config.cross_sections)
        after = self._context(last, 1, config.context_after, config.cross_sections)
        selected = [*reversed(before), *selected, *after]

        # Assemble the text and remember each unit's character range.
        parts: list[str] = []
        ranges: dict[int, tuple[int, int]] = {}
        offset = 0
        for index in selected:
            text = self._units[index].text
            if not text:
                continue
            if parts:
                offset += len(UNIT_SEPARATOR)
            ranges[index] = (offset, offset + len(text))
            parts.append(text)
            offset += len(text)
        full = UNIT_SEPARATOR.join(parts)
        if not full:
            raise ExcerptError("the matched blocks have no text and no captioned neighbours")

        matched_ranges = [ranges[i] for i in matched if i in ranges]
        highlights = _locate(full, passage, matched_ranges) if passage else []
        if not highlights:
            highlights = _merge(matched_ranges, full)
        terms = term_spans(full, query) if query else []

        start, end = 0, len(full)
        if len(full) > config.max_chars:
            focus = (highlights[0][0], highlights[-1][1]) if highlights else (0, 1)
            start, end = _window(full, *focus, config.max_chars)
        kept = [
            i
            for i in selected
            if (i in ranges and ranges[i][0] < end and ranges[i][1] > start)
            or (i not in ranges and i in matched_set)
        ]
        blocks = [b for i in kept for b in self._units[i].blocks]
        matched_ids = [b.id for i in kept if i in matched_set for b in self._units[i].blocks]
        locations = _locations(blocks)
        primary = _locations([b for b in blocks if b.id in set(matched_ids)])[0]
        section = self._units[first].section_id
        return Excerpt(
            document_id=self._revision.document_id,
            revision_id=self._revision.revision_id,
            chunk_id=chunk_id,
            section_id=section,
            text=full[start:end],
            highlights=_shift(highlights, start, end, clip=True),
            term_highlights=_shift(terms, start, end, clip=False),
            block_ids=tuple(b.id for b in blocks),
            matched_block_ids=tuple(matched_ids),
            locations=locations,
            primary_location=primary,
            breadcrumb=self._breadcrumb(section),
            truncated_start=start > 0,
            truncated_end=bool(full[end:].strip()),
        )

    def _context(self, origin: int, step: int, count: int, cross: bool) -> list[int]:
        """Up to ``count`` units next to ``origin`` in direction ``step`` (nearest first)."""
        section = self._units[origin].section_id
        found: list[int] = []
        index = origin + step
        while 0 <= index < len(self._units) and len(found) < count:
            unit = self._units[index]
            if unit.section_id != section and not cross:
                break
            if unit.text.strip() and (cross or not unit.heading):
                found.append(index)
            index += step
        return found

    def _breadcrumb(self, section_id: str | None) -> tuple[str, ...]:
        path: list[str] = []
        current: Section | None = self._sections.get(section_id) if section_id else None
        seen: set[str] = set()
        while current is not None and current.id not in seen:
            seen.add(current.id)
            path.insert(0, current.title)
            current = self._sections.get(current.parent_id) if current.parent_id else None
        return (self._title, *path) if self._title else tuple(path)


# --- locations ---------------------------------------------------------------------------------


def _locations(blocks: Sequence[Block]) -> tuple[SourceLocation, ...]:
    out: list[SourceLocation] = []
    for block in blocks:
        for loc in block.locations:
            located = loc if loc.block_id else loc.model_copy(update={"block_id": block.id})
            if located not in out:
                out.append(located)
    return tuple(out)


# --- highlights --------------------------------------------------------------------------------

Span = tuple[int, int]


def _merge(spans: Iterable[Span], text: str) -> list[Span]:
    """Sorted spans with overlapping ones, and ones separated only by whitespace, merged."""
    merged: list[Span] = []
    for start, end in sorted(spans):
        if merged and (start <= merged[-1][1] or not text[merged[-1][1] : start].strip()):
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _locate(text: str, passage: str, regions: Sequence[Span]) -> list[Span]:
    """Where the blank-line separated pieces of ``passage`` occur in ``regions`` of ``text``, in
    order. A piece that is not one verbatim slice (part of a split table: repeated header +
    rows) is located line by line; pieces found nowhere (a leading heading) are skipped.

    Chunks do not record their offset inside a split block, so a piece occurring more than once
    in its paragraph (only plausible for a very short window) is matched at its first
    occurrence after the previous piece."""
    spans: list[Span] = []
    cursor = regions[0][0] if regions else 0

    def find(needle: str) -> Span | None:
        nonlocal cursor
        for start, end in regions:
            if end <= cursor:
                continue
            at = text.find(needle, max(start, cursor), end)
            if at >= 0:
                cursor = at + len(needle)
                return at, cursor
        return None

    for piece in passage.split(UNIT_SEPARATOR):
        piece = piece.strip()
        if not piece:
            continue
        found = find(piece)
        if found is not None:
            spans.append(found)
            continue
        mark = cursor
        lines = [line.strip() for line in piece.split("\n") if line.strip()]
        line_spans = [s for s in (find(line) for line in lines) if s is not None]
        if not line_spans:
            cursor = mark
        spans.extend(line_spans)
    return _merge(spans, text)


def _shift(spans: Sequence[Span], start: int, end: int, *, clip: bool) -> tuple[TextSpan, ...]:
    out: list[TextSpan] = []
    for s, e in spans:
        if clip:
            s, e = max(s, start), min(e, end)
        elif s < start or e > end:
            continue
        if s < e:
            out.append(TextSpan(start=s - start, end=e - start))
    return tuple(out)


# Particles and copulas stripped from the end of a Korean query word before it is split into
# bigrams, so ``염소를`` highlights ``염소`` and not every ``소를`` (longest first).
_KO_PARTICLES = (
    "에서는",
    "으로는",
    "에게서",
    "이라고",
    "에서",
    "에게",
    "으로",
    "까지",
    "부터",
    "처럼",
    "보다",
    "이다",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "의",
    "에",
    "와",
    "과",
    "도",
    "로",
    "만",
)
_EN_STOPWORDS = frozenset(
    (
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "can",
        "could",
        "do",
        "does",
        "did",
        "for",
        "from",
        "has",
        "have",
        "how",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "may",
        "might",
        "of",
        "on",
        "or",
        "so",
        "than",
        "that",
        "the",
        "their",
        "then",
        "there",
        "these",
        "this",
        "those",
        "to",
        "was",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
    )
)
_EN_SUFFIXES = ("ing", "ed", "es", "s")
_HANGUL_RUN = re.compile(r"[가-힣]+")
_WORD = re.compile(r"[^\W_]+")


@dataclass(frozen=True, slots=True)
class QueryTerms:
    hangul: tuple[str, ...]
    words: tuple[tuple[str, str], ...]
    """(whole word, prefix stem) pairs; a text word matches when equal or starting with stem."""


def _fold(text: str) -> tuple[str, list[int]]:
    """NFKC + casefold per character, with the source index of every folded character."""
    chars: list[str] = []
    index: list[int] = []
    for i, char in enumerate(text):
        folded = unicodedata.normalize("NFKC", char).casefold()
        chars.append(folded)
        index.extend([i] * len(folded))
    return "".join(chars), index


def query_terms(query: str) -> QueryTerms:
    """Highlight terms of a query: Korean words (particle stripped) as overlapping syllable
    bigrams (a one-syllable word as itself), other words case-folded minus English stop words,
    with a crude suffix stem (``-s``, ``-es``, ``-ed``, ``-ing``) kept to at least 4 letters."""
    folded, _ = _fold(query)
    hangul: list[str] = []
    for match in _HANGUL_RUN.finditer(folded):
        word = match.group()
        for particle in _KO_PARTICLES:
            if word.endswith(particle) and len(word) > len(particle):
                word = word[: -len(particle)]
                break
        grams = [word] if len(word) == 1 else [word[i : i + 2] for i in range(len(word) - 1)]
        hangul.extend(g for g in grams if g not in hangul)
    words: list[tuple[str, str]] = []
    for match in _WORD.finditer(folded):
        word = match.group()
        if _HANGUL_RUN.search(word) or word in _EN_STOPWORDS:
            continue
        stem = word
        for suffix in _EN_SUFFIXES:
            if word.endswith(suffix) and len(word) - len(suffix) >= 4:
                stem = word[: -len(suffix)]
                break
        if (word, stem) not in words:
            words.append((word, stem))
    return QueryTerms(tuple(hangul), tuple(words))


def term_spans(text: str, query: str) -> list[Span]:
    """Character ranges of ``text`` matching the query terms (see ``query_terms``): every
    occurrence of a Korean bigram, and whole words equal to a query word or starting with its
    stem (stems of at least 4 letters). Overlapping or touching ranges are merged."""
    terms = query_terms(query)
    folded, index = _fold(text)
    found: list[Span] = []
    for gram in terms.hangul:
        at = folded.find(gram)
        while at >= 0:
            found.append((at, at + len(gram)))
            at = folded.find(gram, at + 1)
    if terms.words:
        for match in _WORD.finditer(folded):
            word = match.group()
            if any(
                word == whole or (len(stem) >= 4 and word.startswith(stem))
                for whole, stem in terms.words
            ):
                found.append((match.start(), match.end()))
    merged: list[Span] = []
    for start, end in sorted(found):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [(index[s], index[e - 1] + 1) for s, e in merged]


# --- truncation --------------------------------------------------------------------------------


def _window(text: str, match_start: int, match_end: int, limit: int) -> Span:
    """``[start, end)`` of at most ``limit`` characters around the match: whole sentences, grown
    alternately before and after the match; when even the match's sentences do not fit, whole
    words around the match instead (see ``_word_window``)."""
    spans = sentence_spans(text)
    lo = next(k for k, (_, e) in enumerate(spans) if e > match_start)
    hi = max(k for k, (s, _) in enumerate(spans) if s < match_end)
    hi = max(hi, lo)
    if spans[hi][1] - spans[lo][0] > limit:
        return _word_window(text, match_start, match_end, limit)
    grow_before = True
    can_before = can_after = True
    while can_before or can_after:
        if grow_before and can_before:
            if lo > 0 and spans[hi][1] - spans[lo - 1][0] <= limit:
                lo -= 1
            else:
                can_before = False
        elif can_after:
            if hi + 1 < len(spans) and spans[hi + 1][1] - spans[lo][0] <= limit:
                hi += 1
            else:
                can_after = False
        grow_before = not grow_before
    return spans[lo][0], spans[hi][1]


def _word_window(text: str, match_start: int, match_end: int, limit: int) -> Span:
    """The whole match plus whole words of context, added alternately before and after it
    while the window stays within ``limit``. A match longer than ``limit`` keeps its start and
    is cut at the last word boundary that fits (mid-word only for an unspaced run)."""
    if match_end - match_start > limit:
        end = match_start + limit
        if not text[end].isspace():
            cut = end
            while cut > match_start and not text[cut - 1].isspace():
                cut -= 1
            if cut > match_start:
                end = cut
        while end > match_start and text[end - 1].isspace():
            end -= 1
        return match_start, end

    def word_before(pos: int) -> int:
        while pos > 0 and text[pos - 1].isspace():
            pos -= 1
        while pos > 0 and not text[pos - 1].isspace():
            pos -= 1
        return pos

    def word_after(pos: int) -> int:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        while pos < len(text) and not text[pos].isspace():
            pos += 1
        return pos

    start, end = match_start, match_end
    can_before = can_after = True
    grow_before = True
    while can_before or can_after:
        if grow_before and can_before:
            nxt = word_before(start)
            if nxt < start and end - nxt <= limit:
                start = nxt
            else:
                can_before = False
        elif can_after:
            nxt = word_after(end)
            if nxt > end and nxt - start <= limit:
                end = nxt
            else:
                can_after = False
        grow_before = not grow_before
    return start, end


__all__ = [
    "UNIT_SEPARATOR",
    "ExcerptConfig",
    "ExcerptError",
    "ExcerptResolver",
    "QueryTerms",
    "query_terms",
    "term_spans",
]
