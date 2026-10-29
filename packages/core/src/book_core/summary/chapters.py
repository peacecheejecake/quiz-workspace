"""Split a published revision into the chapter inputs of its summary (DOCSUM-01).

One input per top-level section (outline depth 1, ``parent_id`` null) in outline order; a block
belongs to the top-level section above its own section. Blocks outside every section (front
matter such as a table of contents) are not summarized. A document without any section is one
input (``BODY_SECTION_KEY``) titled after the document.

For a book that also prints questions (``mixed``) the question extractor's own segmentation
(``segment_chapters``) marks the question, option, inline answer, explanation and answer-key
lines; their blocks are left out, so only body text reaches the LLM.
"""

from __future__ import annotations

from collections.abc import Sequence

from book_core.contracts import Block, BlockType, DocumentRevision, Section
from book_core.summary.models import (
    BODY_SECTION_KEY,
    ChapterInput,
    InputBlock,
    normalize_text,
)

_TEXT_TYPES = frozenset({BlockType.TEXT, BlockType.HEADING, BlockType.TABLE, BlockType.FORMULA})


def question_block_indices(blocks: Sequence[Block]) -> set[int]:
    """Indices (into ``blocks``) of what the question extractor reads as questions or answers."""
    from book_core.extractor.segment import segment_chapters

    seg = segment_chapters(blocks)
    found: set[int] = set()
    for question in seg.questions:
        if not question.is_question():
            continue
        found.update(question.block_indices)
        found.update(line.block_index for line in question.stem_lines)
        found.update(line.block_index for line in question.explanation_lines)
        for option in question.options:
            found.update(line.block_index for line in option.lines)
        found.update(entry.line.block_index for entry in question.answer)
    found.update(entry.line.block_index for entry in seg.answer_key)
    return found


def _input_block(block: Block) -> InputBlock | None:
    if block.type not in _TEXT_TYPES:
        return None
    text = normalize_text(block.text)
    if not text:
        return None
    pages = [loc.page for loc in block.locations]
    return InputBlock(
        text=text,
        page_from=min(pages),
        page_to=max(pages),
        heading=block.type is BlockType.HEADING,
    )


def _roots(sections: Sequence[Section]) -> dict[str, str]:
    by_id = {s.id: s for s in sections}
    roots: dict[str, str] = {}
    for section in sections:
        current = section
        seen = {current.id}
        while current.parent_id is not None and current.parent_id in by_id:
            current = by_id[current.parent_id]
            if current.id in seen:  # pragma: no cover - contracts reject cycles
                break
            seen.add(current.id)
        roots[section.id] = current.id
    return roots


def chapter_inputs(
    revision: DocumentRevision, *, document_title: str, exclude_questions: bool = False
) -> list[ChapterInput]:
    blocks = list(revision.blocks)
    if any(b.ordinal is not None for b in blocks):
        blocks.sort(key=lambda b: (b.ordinal is None, b.ordinal or 0))
    skipped = question_block_indices(blocks) if exclude_questions else set()

    top = [s for s in revision.sections if s.parent_id is None]
    if not top:
        body = [
            ib
            for i, b in enumerate(blocks)
            if i not in skipped and (ib := _input_block(b)) is not None
        ]
        return [_chapter(BODY_SECTION_KEY, document_title, body)] if body else []

    roots = _roots(revision.sections)
    grouped: dict[str, list[InputBlock]] = {s.id: [] for s in top}
    for index, block in enumerate(blocks):
        if index in skipped or block.section_id is None:
            continue
        root = roots.get(block.section_id)
        if root not in grouped:
            continue
        item = _input_block(block)
        if item is not None:
            grouped[root].append(item)
    return [_chapter(s.id, normalize_text(s.title) or s.id, grouped[s.id]) for s in top]


def _chapter(section_key: str, title: str, blocks: list[InputBlock]) -> ChapterInput:
    return ChapterInput(
        section_key=section_key,
        title=title,
        page_from=min((b.page_from for b in blocks), default=None),
        page_to=max((b.page_to for b in blocks), default=None),
        blocks=tuple(blocks),
    )


def split_blocks(blocks: Sequence[InputBlock], max_chars: int) -> list[tuple[InputBlock, ...]]:
    """Consecutive parts of at most ``max_chars`` characters (a longer block is cut into pieces
    on the same pages), for chapters over WORKER_SUMMARY_CHAPTER_CHARS."""
    limit = max(1, max_chars)
    pieces: list[InputBlock] = []
    for block in blocks:
        if len(block.text) <= limit:
            pieces.append(block)
            continue
        for start in range(0, len(block.text), limit):
            pieces.append(
                InputBlock(
                    text=block.text[start : start + limit],
                    page_from=block.page_from,
                    page_to=block.page_to,
                    heading=block.heading,
                )
            )
    parts: list[tuple[InputBlock, ...]] = []
    current: list[InputBlock] = []
    size = 0
    for piece in pieces:
        if current and size + len(piece.text) > limit:
            parts.append(tuple(current))
            current, size = [], 0
        current.append(piece)
        size += len(piece.text)
    if current:
        parts.append(tuple(current))
    return parts
