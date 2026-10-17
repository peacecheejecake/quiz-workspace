"""Canonical ``DocumentRevision`` -> parent/child ``SearchChunk``s with block/page provenance.

Why not Docling's ``HybridChunker``: it chunks a ``DoclingDocument``, but the index must reflect
the canonical revision (user-corrected text, merged cross-page paragraphs, restored section
tree, stable canonical block ids). Rebuilding a ``DoclingDocument`` from a revision would be
lossy, would drop our block ids/provenance, and would make the default (model-free) install
depend on docling-core and a HF tokenizer. What we keep from its approach:

1. hierarchical pass first: chunks follow document structure, never cross a section, and
   headings are context (``contextualize`` -> our breadcrumb in ``search_text``);
2. token-aware pass: oversized items are split (here at sentence boundaries, KO and EN) and
   undersized peers in the same section are merged up to a target size (``merge_peers``);
3. tables are serialized row by row and split only between rows, with header rows repeated.

On top of that, children are grouped into section-scoped parent chunks (context for the
reranker, excerpts and generation), and ids/hashes are designed for incremental re-indexing.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from enum import Enum, auto

from book_core.chunker.sentences import oversized_spans, sentence_spans
from book_core.chunker.tokens import ApproxTokenizer, Tokenizer
from book_core.contracts import (
    Block,
    BlockType,
    ChunkLevel,
    DocumentRevision,
    SearchChunk,
    Section,
    SourceLocation,
)

CHILD_PREFIX = "chk-"
PARENT_PREFIX = "chp-"
_UNIT_SEP = "\n\n"
_CRUMB_SEP = " > "


@dataclass(frozen=True, slots=True)
class ChunkerConfig:
    """Size limits in tokens of ``search_text`` (breadcrumb included) under the tokenizer.

    - ``target_tokens``: children are packed with whole blocks up to this size;
    - ``max_tokens``: hard limit; a single block up to it stays whole, longer text blocks are
      split at sentence boundaries into windows of about ``target_tokens``;
    - ``overlap_tokens``: trailing sentences of one window repeated at the start of the next,
      only inside a split block (never across blocks, so a block edit stays local);
    - ``parent_max_tokens``: parents group consecutive children of one section up to this size;
    - ``include_front_matter``: also chunk blocks outside every section (title page, TOC);
    - ``breadcrumb_max_share``: the indexed breadcrumb (``search_text`` prefix and
      ``SearchChunk.breadcrumb``) gets at most this share of ``target_tokens``. A longer one is
      shortened: the longest title is ellipsized first (deepest on ties), and when every title
      is down to ``…`` the outermost ones (document title first) are dropped. Section titles
      stay available in full through ``section_id``.

    ``max_tokens`` always holds for children (``ChunkingError`` otherwise, e.g. with a
    tokenizer that is not additive), except for a single table row plus its repeated header,
    since tables are never split inside a row.
    """

    target_tokens: int = 256
    max_tokens: int = 384
    overlap_tokens: int = 32
    parent_max_tokens: int = 1536
    include_front_matter: bool = False
    breadcrumb_max_share: float = 0.25

    def __post_init__(self) -> None:
        if not 0 <= self.breadcrumb_max_share < 1:
            raise ValueError("require 0 <= breadcrumb_max_share < 1")
        if not 0 < self.target_tokens <= self.max_tokens:
            raise ValueError("require 0 < target_tokens <= max_tokens")
        if not 0 <= self.overlap_tokens < self.target_tokens:
            raise ValueError("require 0 <= overlap_tokens < target_tokens")
        if self.parent_max_tokens < self.max_tokens:
            raise ValueError("parent_max_tokens must be >= max_tokens")


class ChunkingError(ValueError):
    """The configured limits cannot be met (a child would exceed ``max_tokens``)."""


@dataclass(frozen=True, slots=True)
class ChunkedRevision:
    """Chunks of one revision in reading order. ``uncovered_block_ids`` are in-scope blocks no
    chunk could carry (a section consisting only of a text-less image)."""

    parents: tuple[SearchChunk, ...]
    children: tuple[SearchChunk, ...]
    uncovered_block_ids: tuple[str, ...]
    tokenizer: str

    @property
    def chunks(self) -> tuple[SearchChunk, ...]:
        return (*self.parents, *self.children)


class _Kind(Enum):
    TEXT = auto()
    HEADING = auto()
    TABLE = auto()


@dataclass(slots=True)
class _Unit:
    """Blocks that are chunked together: one block, or a table/figure with its caption."""

    kind: _Kind
    blocks: list[Block]
    text: str
    tokens: int
    table: Block | None = None
    caption: Block | None = None


@dataclass(frozen=True, slots=True)
class _Segment:
    """What a child contributes to its parent's content.

    Plain segments are whole units. Pieces of one split text block (same ``key``) are ranges
    ``[start, end)`` of ``source``; inside one parent they merge into a single range, so the
    first piece keeps its full context (overlap included) and later overlap is not repeated.
    Parts of one split table carry their ``prefix`` lines (caption and header for the first
    part, the repeated header for later ones) and ``rows``; inside one parent the first part's
    prefix is kept and the rows are appended.
    """

    key: str
    text: str = ""
    source: str | None = None
    start: int = 0
    end: int = 0
    prefix: tuple[str, ...] | None = None
    rows: tuple[str, ...] = ()

    def render(self) -> str:
        if self.source is not None:
            return self.source[self.start : self.end]
        if self.prefix is not None:
            return "\n".join((*self.prefix, *self.rows))
        return self.text

    def merge(self, other: _Segment) -> _Segment | None:
        """``other`` (a later piece of the same block) folded into this one, if mergeable."""
        if other.key != self.key:
            return None
        if self.source is not None and other.source == self.source:
            return replace(self, end=max(self.end, other.end))
        if self.prefix is not None and other.prefix is not None:
            return replace(self, rows=(*self.rows, *other.rows))
        return None


@dataclass(slots=True)
class _Child:
    blocks: list[Block]
    texts: list[str]
    part: int | None = None
    segments: list[_Segment] = field(default_factory=list)


def _segments(units: Iterable[_Unit]) -> list[_Segment]:
    return [_Segment(u.blocks[0].id, u.text) for u in units if u.text]


def _parent_content(children: Sequence[_Child]) -> str:
    merged: list[_Segment] = []
    for child in children:
        for segment in child.segments:
            folded = merged[-1].merge(segment) if merged else None
            if folded is not None:
                merged[-1] = folded
            else:
                merged.append(segment)
    return _UNIT_SEP.join(s.render() for s in merged if s.render())


def _sha(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode())
        digest.update(b"\x1f")
    return digest.hexdigest()


def _dedupe_blocks(blocks: Iterable[Block]) -> list[Block]:
    seen: set[str] = set()
    out: list[Block] = []
    for block in blocks:
        if block.id not in seen:
            seen.add(block.id)
            out.append(block)
    return out


def _locations(blocks: Sequence[Block]) -> tuple[SourceLocation, ...]:
    out: list[SourceLocation] = []
    for block in blocks:
        for loc in block.locations:
            located = loc if loc.block_id else loc.model_copy(update={"block_id": block.id})
            if located not in out:
                out.append(located)
    return tuple(out)


def detect_language(text: str) -> str | None:
    """``ko`` or ``en`` by letter counts (Hangul weighted x2: Korean needs about half as many
    letters per word), ``None`` without letters of either script."""
    hangul = sum(1 for ch in text if "가" <= ch <= "힣" or "㄰" <= ch <= "㆏")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if hangul == 0 and latin == 0:
        return None
    return "ko" if hangul * 2 >= latin else "en"


def _table_lines(block: Block) -> tuple[list[str], list[str]]:
    if block.table is not None:
        rows = [" | ".join(row) for row in block.table.rows]
        header_rows = block.table.header_rows
    else:
        rows = [line for line in block.text.split("\n") if line.strip()]
        header_rows = 0
    return rows[:header_rows], rows[header_rows:]


_CAPTION_START = re.compile(
    r"^\s*(?:(?P<table>표|table|tab\.)|(?P<figure>그림|사진|figure|fig\.))\s*\d", re.IGNORECASE
)


def _captions(blocks: Sequence[Block]) -> dict[str, Block]:
    """Caption of each table/image of a section run: the linked ``caption_block_id`` or, when
    the parser did not link one, an adjacent text block labelled like a caption (``표 1.``,
    ``Figure 2``) of the matching kind."""
    by_id = {b.id: b for b in blocks}
    captions: dict[str, Block] = {}
    taken: set[str] = set()
    for block in blocks:
        cap_id = block.caption_block_id
        if cap_id is not None and cap_id in by_id and cap_id not in taken:
            captions[block.id] = by_id[cap_id]
            taken.add(cap_id)
    taken.update(b.caption_block_id for b in blocks if b.caption_block_id is not None)
    for i, block in enumerate(blocks):
        if block.type not in (BlockType.TABLE, BlockType.IMAGE) or block.id in captions:
            continue
        if block.caption_block_id is not None:
            continue
        group = "table" if block.type is BlockType.TABLE else "figure"
        for j in (i - 1, i + 1):
            if not 0 <= j < len(blocks):
                continue
            near = blocks[j]
            match = _CAPTION_START.match(near.text)
            if near.type is BlockType.TEXT and near.id not in taken and match and match[group]:
                captions[block.id] = near
                taken.add(near.id)
                break
    return captions


class _SectionChunker:
    """Packs the blocks of one section run into children, then groups children into parents."""

    def __init__(self, config: ChunkerConfig, tokenizer: Tokenizer, crumb_tokens: int) -> None:
        self.tok = tokenizer
        # Budgets apply to content; the breadcrumb prefix of search_text takes its share
        # (bounded by ``breadcrumb_max_share``, so this only fails for an inconsistent tokenizer).
        self.target = config.target_tokens - crumb_tokens
        self.max = config.max_tokens - crumb_tokens
        if self.target < 1:
            raise ChunkingError(
                f"breadcrumb takes {crumb_tokens} tokens, no room left in target_tokens"
            )
        self.overlap = min(config.overlap_tokens, self.target - 1)
        self.parent_max = config.parent_max_tokens - crumb_tokens
        self.children: list[_Child] = []
        self.pending_textless: list[Block] = []

    # -- units ------------------------------------------------------------------------------

    def units(self, blocks: Sequence[Block]) -> list[_Unit]:
        position = {b.id: i for i, b in enumerate(blocks)}
        caption_of = _captions(blocks)
        by_id = {b.id: b for b in blocks}
        owner_of = {cap.id: by_id[owner_id] for owner_id, cap in caption_of.items()}
        emitted: set[str] = set()
        units: list[_Unit] = []
        for block in blocks:
            if block.id in emitted:
                continue
            owner = owner_of.get(block.id, block)
            if owner.id in emitted:
                owner = block
            caption = caption_of.get(owner.id)
            if caption is not None and caption.id in emitted:
                caption = None
            members = sorted(
                [owner, *([caption] if caption is not None else [])],
                key=lambda b: position[b.id],
            )
            emitted.update(m.id for m in members)
            if owner.type is BlockType.TABLE:
                header, body = _table_lines(owner)
                cap = [caption.text] if caption is not None and caption.text else []
                text = "\n".join([*cap, *header, *body])
                units.append(
                    _Unit(_Kind.TABLE, members, text, self.tok.count(text), owner, caption)
                )
                continue
            text = "\n".join(m.text for m in members if m.text.strip())
            heading = owner.type is BlockType.HEADING and caption is None
            kind = _Kind.HEADING if heading else _Kind.TEXT
            units.append(_Unit(kind, members, text, self.tok.count(text)))
        return units

    # -- packing ----------------------------------------------------------------------------

    def run(self, blocks: Sequence[Block]) -> None:
        buffer: list[_Unit] = []
        for unit in self.units(blocks):
            if not unit.text:
                # Uncaptioned, text-less figure: travels with the surrounding text.
                if buffer or not self.children:
                    buffer.append(unit)
                else:
                    self.children[-1].blocks.extend(unit.blocks)
                continue
            if unit.table is not None or unit.tokens > self.max:
                lead = self._flush(buffer, keep_headings=True)
                if unit.table is not None:
                    self._emit_table(unit, unit.table, lead)
                else:
                    self._emit_split(unit, lead)
                buffer = []
                continue
            used = sum(u.tokens for u in buffer)
            only_headings = all(u.kind is _Kind.HEADING or not u.text for u in buffer)
            if buffer and used + unit.tokens > (self.max if only_headings else self.target):
                if only_headings:
                    self._flush(buffer, keep_headings=False)
                    buffer = []
                else:
                    buffer = self._flush(buffer, keep_headings=True)
                    if sum(u.tokens for u in buffer) + unit.tokens > self.max:
                        self._flush(buffer, keep_headings=False)
                        buffer = []
            buffer.append(unit)
        self._flush(buffer, keep_headings=False)

    def _flush(self, buffer: list[_Unit], *, keep_headings: bool) -> list[_Unit]:
        """Emit ``buffer`` as one child. With ``keep_headings``, trailing headings are not
        emitted but returned, to lead the next chunk (keep-with-next)."""
        buffer = list(buffer)
        carry: list[_Unit] = []
        if keep_headings:
            while buffer and buffer[-1].kind is _Kind.HEADING:
                carry.insert(0, buffer.pop())
        blocks = [b for u in buffer for b in u.blocks]
        if not any(u.text for u in buffer):
            if blocks and self.children:
                self.children[-1].blocks.extend(blocks)
            else:
                self.pending_textless.extend(blocks)
            return carry
        self.children.append(
            _Child(
                blocks=[*self._take_pending(), *blocks],
                texts=[u.text for u in buffer if u.text],
                segments=_segments(buffer),
            )
        )
        return carry

    def _take_pending(self) -> list[Block]:
        pending, self.pending_textless = self.pending_textless, []
        return pending

    def _lead(self, lead: list[_Unit], room: int) -> tuple[list[Block], list[_Unit], int]:
        """Headings that fit in ``room`` tokens lead the next chunk; otherwise they become a
        child of their own."""
        tokens = sum(u.tokens for u in lead)
        if not lead or tokens > room:
            self._flush(lead, keep_headings=False)
            return [], [], 0
        return [b for u in lead for b in u.blocks], lead, tokens

    def _emit_split(self, unit: _Unit, lead_units: list[_Unit]) -> None:
        """A text block over ``max``: sentence windows of about ``target`` with overlap."""
        lead_blocks, lead, lead_tokens = self._lead(lead_units, self.max - self.target)
        key, source = unit.blocks[0].id, unit.text
        # (start, end, tokens) ranges of ``source``; windows are slices of it, so the original
        # separators (or their absence inside a character-split word) are kept.
        sentences: list[tuple[int, int, int]] = []
        for span in sentence_spans(source):
            cost = self.tok.count(source[span[0] : span[1]])
            pieces = (
                oversized_spans(source, span, self.target, self.tok)
                if cost > self.target
                else [span]
            )
            sentences.extend((s, e, self.tok.count(source[s:e])) for s, e in pieces)
        start, part = 0, 0
        while start < len(sentences):
            limit = self.target - lead_tokens if part == 0 else self.target
            end, used = start, 0
            while end < len(sentences) and (end == start or used + sentences[end][2] <= limit):
                used += sentences[end][2]
                end += 1
            segment = _Segment(
                key, source=source, start=sentences[start][0], end=sentences[end - 1][1]
            )
            text = segment.render()
            if part == 0:
                child = _Child(
                    [*self._take_pending(), *lead_blocks, *unit.blocks],
                    [*(u.text for u in lead if u.text), text],
                    part,
                    [*_segments(lead), segment],
                )
            else:
                child = _Child(list(unit.blocks), [text], part, [segment])
            self.children.append(child)
            if end >= len(sentences):
                break
            # Overlap: trailing sentences of this window, as long as the next window still
            # makes progress (overlap + next sentence fit in the target).
            back, overlap, nxt = end, 0, sentences[end][2]
            while (
                back - 1 > start
                and overlap + sentences[back - 1][2] <= self.overlap
                and overlap + sentences[back - 1][2] + nxt <= self.target
            ):
                back -= 1
                overlap += sentences[back][2]
            start = back
            part += 1

    def _emit_table(self, unit: _Unit, table: Block, lead_units: list[_Unit]) -> None:
        """A table is its own chunk; over ``max`` it is split between rows, header repeated."""
        caption = unit.caption
        if unit.tokens <= self.max:
            lead_blocks, lead, _ = self._lead(lead_units, self.max - unit.tokens)
            self.children.append(
                _Child(
                    [*self._take_pending(), *lead_blocks, *unit.blocks],
                    [*(u.text for u in lead if u.text), unit.text],
                    None,
                    [*_segments(lead), _Segment(table.id, unit.text)],
                )
            )
            return
        header, body = _table_lines(table)
        if not body:
            header, body = [], header
        cap = [caption.text] if caption is not None and caption.text else []
        header_tokens = sum(self.tok.count(line) for line in header)
        cap_tokens = sum(self.tok.count(line) for line in cap)
        lead_blocks, lead, lead_tokens = self._lead(
            lead_units, self.max // 2 - header_tokens - cap_tokens
        )
        part, index = 0, 0
        while index < len(body):
            first = part == 0
            used = header_tokens + (lead_tokens + cap_tokens if first else 0)
            rows: list[str] = []
            while index < len(body):
                cost = self.tok.count(body[index])
                if rows and used + cost > self.max:
                    break
                rows.append(body[index])
                used += cost
                index += 1
            segment = _Segment(
                table.id, prefix=(*(cap if first else []), *header), rows=tuple(rows)
            )
            text = segment.render()
            if first:
                captions = [caption] if caption is not None else []
                child = _Child(
                    [*self._take_pending(), *lead_blocks, *captions, table],
                    [*(u.text for u in lead if u.text), text],
                    part,
                    [*_segments(lead), segment],
                )
            else:
                child = _Child([table], [text], part, [segment])
            self.children.append(child)
            part += 1

    # -- parents ----------------------------------------------------------------------------

    def parent_groups(self) -> list[list[_Child]]:
        """Consecutive children up to ``parent_max`` tokens of rendered parent content (a parent
        that starts inside a split block carries that piece's full context)."""
        groups: list[list[_Child]] = []
        current: list[_Child] = []
        for child in self.children:
            candidate = [*current, child]
            if current and self.tok.count(_parent_content(candidate)) > self.parent_max:
                groups.append(current)
                candidate = [child]
            current = candidate
        if current:
            groups.append(current)
        return groups


def _breadcrumb(
    section_id: str | None, sections: dict[str, Section], document_title: str | None
) -> tuple[str, ...]:
    path: list[str] = []
    current = sections.get(section_id) if section_id is not None else None
    while current is not None:
        path.insert(0, current.title)
        current = sections.get(current.parent_id) if current.parent_id is not None else None
    title = document_title.strip() if document_title else ""
    return (title, *path) if title else tuple(path)


_ELLIPSIS = "…"


def _ellipsize(title: str, tokens: int, tokenizer: Tokenizer) -> str:
    """Longest prefix of ``title`` plus an ellipsis that costs at most ``tokens``."""
    low, high = 0, len(title) - 1
    while low < high:
        mid = (low + high + 1) // 2
        if tokenizer.count(title[:mid].rstrip() + _ELLIPSIS) <= tokens:
            low = mid
        else:
            high = mid - 1
    return title[:low].rstrip() + _ELLIPSIS


def bound_breadcrumb(
    breadcrumb: Sequence[str], budget: int, tokenizer: Tokenizer
) -> tuple[str, ...]:
    """Shorten ``breadcrumb`` to at most ``budget`` tokens (joined with `` > ``).

    The longest title is ellipsized first (the deepest on ties) until it fits; once every
    title is down to the ellipsis, the outermost entries are dropped. May return ``()``.
    """
    items = list(breadcrumb)

    def cost() -> int:
        return tokenizer.count(_CRUMB_SEP.join(items)) if items else 0

    while items and cost() > budget:
        costs = [tokenizer.count(t) for t in items]
        longest = max(range(len(items)), key=lambda i: (costs[i], i))
        if items[longest] != _ELLIPSIS and costs[longest] > tokenizer.count(_ELLIPSIS):
            # Cut just the excess, but never below a fair share of the budget, so a huge
            # title shortens itself rather than wiping out its neighbours.
            share = max((budget - (len(items) - 1)) // len(items), 1)
            keep = min(costs[longest] - 1, max(costs[longest] - (cost() - budget), share))
            items[longest] = _ellipsize(items[longest], keep, tokenizer)
        else:
            items.pop(0)
    return tuple(items)


def _search_text(breadcrumb: Sequence[str], content: str) -> str:
    return f"{_CRUMB_SEP.join(breadcrumb)}\n{content}" if breadcrumb else content


def _content_hash(fields: dict[str, object]) -> str:
    payload = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _make_chunk(
    *,
    chunk_id: str,
    revision: DocumentRevision,
    level: ChunkLevel,
    parent_id: str | None,
    section_id: str | None,
    breadcrumb: tuple[str, ...],
    content: str,
    blocks: Sequence[Block],
    ordinal: int,
    tokenizer: Tokenizer,
) -> SearchChunk:
    search_text = _search_text(breadcrumb, content)
    block_ids = tuple(b.id for b in blocks)
    locations = _locations(blocks)
    language = detect_language(content)
    # Everything the index stores except revision_id and ordinal (refreshed for every chunk).
    content_hash = _content_hash(
        {
            "level": level.value,
            "parent_id": parent_id,
            "section_id": section_id,
            "breadcrumb": list(breadcrumb),
            "content": content,
            "search_text": search_text,
            "language": language,
            "block_ids": list(block_ids),
            "locations": [loc.model_dump(mode="json") for loc in locations],
        }
    )
    return SearchChunk(
        id=chunk_id,
        document_id=revision.document_id,
        revision_id=revision.revision_id,
        parent_id=parent_id,
        section_id=section_id,
        content=content,
        search_text=search_text,
        content_hash=content_hash,
        language=language,
        block_ids=block_ids,
        locations=locations,
        level=level,
        ordinal=ordinal,
        token_count=tokenizer.count(search_text),
        breadcrumb=breadcrumb,
    )


def _runs(blocks: Sequence[Block]) -> list[tuple[str | None, list[Block]]]:
    runs: list[tuple[str | None, list[Block]]] = []
    for block in blocks:
        if runs and runs[-1][0] == block.section_id:
            runs[-1][1].append(block)
        else:
            runs.append((block.section_id, [block]))
    return runs


def chunk_revision(
    revision: DocumentRevision,
    *,
    document_title: str | None = None,
    config: ChunkerConfig | None = None,
    tokenizer: Tokenizer | None = None,
) -> ChunkedRevision:
    """Chunk a (published) revision into section-scoped parents and retrieval-sized children.

    Every in-scope block is covered by at least one child (a split paragraph or table by
    several), and no chunk crosses a section boundary. Child ids hash the document id, section
    id, covered block ids and the part index of a split block; parent ids hash their
    children's ids. Unchanged regions therefore keep their ids across revisions.
    """
    config = config or ChunkerConfig()
    tokenizer = tokenizer or ApproxTokenizer()
    sections = {s.id: s for s in revision.sections}
    parents: list[SearchChunk] = []
    children: list[SearchChunk] = []
    uncovered: list[str] = []
    crumb_budget = int(config.target_tokens * config.breadcrumb_max_share)

    for section_id, blocks in _runs(revision.blocks):
        if section_id is None and not config.include_front_matter:
            continue
        breadcrumb = bound_breadcrumb(
            _breadcrumb(section_id, sections, document_title), crumb_budget, tokenizer
        )
        crumb_tokens = tokenizer.count(_CRUMB_SEP.join(breadcrumb))
        chunker = _SectionChunker(config, tokenizer, crumb_tokens)
        chunker.run(blocks)
        uncovered.extend(b.id for b in chunker.pending_textless)
        scope = section_id or "-"
        for group in chunker.parent_groups():
            child_blocks = [_dedupe_blocks(child.blocks) for child in group]
            child_ids = [
                CHILD_PREFIX
                + _sha(
                    revision.document_id,
                    scope,
                    "child",
                    ",".join(b.id for b in blocks_),
                    "" if child.part is None else str(child.part),
                )[:24]
                for child, blocks_ in zip(group, child_blocks, strict=True)
            ]
            parent_id = PARENT_PREFIX + _sha(revision.document_id, scope, "parent", *child_ids)[:24]
            parents.append(
                _make_chunk(
                    chunk_id=parent_id,
                    revision=revision,
                    level=ChunkLevel.PARENT,
                    parent_id=None,
                    section_id=section_id,
                    breadcrumb=breadcrumb,
                    content=_parent_content(group),
                    blocks=_dedupe_blocks(b for bs in child_blocks for b in bs),
                    ordinal=len(parents),
                    tokenizer=tokenizer,
                )
            )
            for child, child_id, blocks_ in zip(group, child_ids, child_blocks, strict=True):
                chunk = _make_chunk(
                    chunk_id=child_id,
                    revision=revision,
                    level=ChunkLevel.CHILD,
                    parent_id=parent_id,
                    section_id=section_id,
                    breadcrumb=breadcrumb,
                    content=_UNIT_SEP.join(child.texts),
                    blocks=blocks_,
                    ordinal=len(children),
                    tokenizer=tokenizer,
                )
                single_row = any(s.prefix is not None and len(s.rows) == 1 for s in child.segments)
                if (chunk.token_count or 0) > config.max_tokens and not single_row:
                    raise ChunkingError(
                        f"chunk of section {section_id!r} has {chunk.token_count} tokens, "
                        f"over max_tokens={config.max_tokens}"
                    )
                children.append(chunk)
    return ChunkedRevision(
        parents=tuple(parents),
        children=tuple(children),
        uncovered_block_ids=tuple(uncovered),
        tokenizer=tokenizer.name,
    )
