"""Canonical document content as stored rows <-> book_core contracts (M3.4, pure).

Row encoding is the one the parse job writes (apps/worker/src/quiz_worker/document_store.py):
`chapters.section_key` = `Section.id`, `sort_order` = position in `DocumentRevision.sections`;
`content_blocks.block_id` = `Block.id`, `ordinal` = reading order, `chapter_id` -> the block's
section, `provenance = {"locations", "source_block_ids"}`, `attributes = {"heading_level"?,
"table"?, "caption_block_id"?}`. The worker re-reads a corrected draft with its own decoder and
checks it against the `content_hash` the API stored, so both decoders must agree; the integration
tests run the worker on drafts the API wrote.

Block edits follow `book_core.structure.apply_edits` (normalized text, `edited=True`, table text
re-parsed into cells, image blocks and empty text refused, unchanged text is a no-op), applied to
one block at a time so a correction does not load the whole book.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from book_core.contracts import (
    Block,
    BlockType,
    DocumentRevision,
    Section,
    SourceLocation,
    TableContent,
    revision_content_hash,
)
from book_core.structure import RevisionEditError, apply_edits
from pydantic import ValidationError

# DB limits (CHECK constraints of chapters / content_blocks).
MAX_BLOCK_TEXT = 200_000
MAX_CHAPTER_TITLE = 1000


class ContentDecodeError(ValueError):
    """Stored rows do not form a valid revision (never carries block text)."""


class BlockEditRefused(ValueError):  # noqa: N818 - a refusal, reported as 422
    """The edit cannot be applied; `str()` is a user-presentable reason without block text."""


def block_version(text: str) -> str:
    """Optimistic-concurrency token of a block: changes whenever its text changes."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def block_from_row(row: Mapping[Any, Any], section_keys: Mapping[Any, str]) -> Block:
    provenance = row["provenance"]
    attributes = row["attributes"] or {}
    table = attributes.get("table")
    return Block(
        id=row["block_id"],
        type=BlockType(row["block_type"]),
        text=row["text"],
        section_id=section_keys[row["chapter_id"]] if row["chapter_id"] else None,
        locations=tuple(SourceLocation.model_validate(loc) for loc in provenance["locations"]),
        heading_level=attributes.get("heading_level"),
        table=TableContent.model_validate(table) if table is not None else None,
        caption_block_id=attributes.get("caption_block_id"),
        source_block_ids=tuple(provenance.get("source_block_ids") or ()),
        ordinal=row["ordinal"],
        edited=row["edited"],
    )


def block_attributes(block: Block) -> dict[str, Any]:
    attributes: dict[str, Any] = {}
    if block.heading_level is not None:
        attributes["heading_level"] = block.heading_level
    if block.table is not None:
        attributes["table"] = block.table.model_dump(mode="json")
    if block.caption_block_id is not None:
        attributes["caption_block_id"] = block.caption_block_id
    return attributes


def revision_from_rows(
    *,
    document_id: str,
    revision_id: str,
    revision_number: int,
    parent_revision_id: str | None,
    source_sha256: str,
    chapters: Sequence[Mapping[Any, Any]],
    blocks: Sequence[Mapping[Any, Any]],
) -> DocumentRevision:
    """The revision the rows encode, with its `content_hash` computed."""
    keys = {row["id"]: row["section_key"] for row in chapters}
    try:
        sections = tuple(
            Section(
                id=row["section_key"],
                title=row["title"],
                level=row["level"],
                parent_id=keys[row["parent_id"]] if row["parent_id"] else None,
                heading_block_id=row["heading_block_id"],
            )
            for row in sorted(chapters, key=lambda r: r["sort_order"])
        )
        content = tuple(
            block_from_row(row, keys) for row in sorted(blocks, key=lambda r: r["ordinal"])
        )
        return DocumentRevision(
            document_id=document_id,
            revision_id=revision_id,
            revision_number=revision_number,
            parent_revision_id=parent_revision_id,
            source_sha256=source_sha256,
            sections=sections,
            blocks=content,
            content_hash=revision_content_hash(sections, content),
        )
    except (ValidationError, ValueError, KeyError, TypeError):
        # Never the validation text: it quotes block content.
        raise ContentDecodeError("the stored revision content is inconsistent") from None


def edit_block(block: Block, text: str, *, source_sha256: str) -> Block | None:
    """`block` with its text corrected (`apply_edits` semantics); None when nothing changes.

    The edit runs on a one-block revision (section and caption links are detached for it and
    restored afterwards: they do not take part in the text edit)."""
    if block.type is BlockType.IMAGE:
        raise BlockEditRefused("Image blocks have no editable text.")
    probe = block.model_copy(update={"section_id": None, "caption_block_id": None})
    try:
        base = DocumentRevision(
            document_id="edit",
            revision_id="edit-base",
            revision_number=1,
            source_sha256=source_sha256,
            blocks=(probe,),
        )
        edited = apply_edits(base, {block.id: text}, revision_id="edit-next").blocks[0]
    except RevisionEditError:
        if block.type is BlockType.TABLE and text.strip():
            raise BlockEditRefused(
                "Table text must be a grid: one row per line, cells separated by '|', "
                "the same number of cells on every row."
            ) from None
        raise BlockEditRefused("The text of a block cannot be empty.") from None
    except (ValidationError, ValueError):
        raise BlockEditRefused("The corrected text is not valid for this block.") from None
    if edited == probe:
        return None
    if len(edited.text) > MAX_BLOCK_TEXT:
        raise BlockEditRefused(f"A block can hold at most {MAX_BLOCK_TEXT} characters.")
    if block.type is BlockType.HEADING and len(edited.text) > MAX_CHAPTER_TITLE:
        raise BlockEditRefused(f"A heading can hold at most {MAX_CHAPTER_TITLE} characters.")
    return edited.model_copy(
        update={"section_id": block.section_id, "caption_block_id": block.caption_block_id}
    )


@dataclass
class OutlineNode:
    id: Any
    section_key: str
    title: str
    level: int
    page: int | None
    heading_block_id: str | None
    children: list[OutlineNode] = field(default_factory=list)


def outline_tree(chapters: Sequence[Mapping[Any, Any]]) -> list[OutlineNode]:
    """Chapter rows (any order) -> roots in `sort_order`, children nested in order."""
    nodes = {
        row["id"]: OutlineNode(
            id=row["id"],
            section_key=row["section_key"],
            title=row["title"],
            level=row["level"],
            page=row["page"],
            heading_block_id=row["heading_block_id"],
        )
        for row in chapters
    }
    roots: list[OutlineNode] = []
    for row in sorted(chapters, key=lambda r: (r["sort_order"], str(r["id"]))):
        parent = nodes.get(row["parent_id"]) if row["parent_id"] else None
        (parent.children if parent is not None else roots).append(nodes[row["id"]])
    return roots
