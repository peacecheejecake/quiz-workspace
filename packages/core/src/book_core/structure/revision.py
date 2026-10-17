"""``ParsedDocument`` -> canonical ``DocumentRevision`` and revisions from user edits."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from book_core.contracts import (
    Block,
    BlockType,
    DocumentRevision,
    ParsedDocument,
    RevisionStatus,
    Section,
    TableContent,
    revision_content_hash,
)
from book_core.structure.canonical import canonical_drafts, normalize_block_text
from book_core.structure.hierarchy import StructureWarning, restore_hierarchy

CANONICAL_PREFIX = "cb-"
SECTION_PREFIX = "sec-"


class RevisionEditError(ValueError):
    """An edit cannot be applied (unknown block, empty text, non-rectangular table ...)."""


@dataclass(frozen=True, slots=True)
class StructureResult:
    revision: DocumentRevision
    warnings: tuple[StructureWarning, ...]
    front_matter_block_ids: tuple[str, ...]
    """Canonical blocks before the body (title page, TOC, preface); they have no section."""
    toc_block_ids: tuple[str, ...]


def canonical_block_id(source_block_id: str) -> str:
    """Canonical ids derive from the first source block id (``p<page>-b<order>-<hash>``), which a
    deterministic parser reproduces for the same PDF bytes, so they survive re-parsing."""
    return f"{CANONICAL_PREFIX}{source_block_id}"


def section_id(heading_source_block_id: str) -> str:
    return f"{SECTION_PREFIX}{heading_source_block_id}"


def _finalize(revision: dict[str, Any]) -> DocumentRevision:
    draft = DocumentRevision.model_validate({**revision, "content_hash": None})
    return draft.model_copy(
        update={"content_hash": revision_content_hash(draft.sections, draft.blocks)}
    )


def build_revision(
    parsed: ParsedDocument, *, document_id: str, revision_id: str
) -> StructureResult:
    """First (draft) revision of a document: restored section tree and canonical blocks.

    Sections the parser may have filled in are ignored; the tree is rebuilt from headings.
    """
    drafts = canonical_drafts(parsed.blocks)
    hierarchy = restore_hierarchy(drafts, len(parsed.pages))

    ids = [canonical_block_id(d.first.id) for d in drafts]
    canonical_of = {src.id: ids[i] for i, d in enumerate(drafts) for src in d.sources}
    section_ids = [section_id(drafts[s.heading_index].first.id) for s in hierarchy.sections]

    sections = [
        Section(
            id=section_ids[n],
            title=s.title,
            level=s.level,
            parent_id=section_ids[s.parent] if s.parent is not None else None,
            heading_block_id=ids[s.heading_index],
        )
        for n, s in enumerate(hierarchy.sections)
    ]
    blocks = []
    for i, draft in enumerate(drafts):
        first = draft.first
        section = hierarchy.block_sections[i]
        caption = first.caption_block_id
        blocks.append(
            Block(
                id=ids[i],
                type=draft.type,
                text=draft.text,
                section_id=section_ids[section] if section is not None else None,
                locations=tuple(
                    loc.model_copy(update={"block_id": ids[i]}) for _, loc in draft.locations
                ),
                heading_level=(
                    sections[section].level
                    if draft.type is BlockType.HEADING and section is not None
                    else first.heading_level
                ),
                table=first.table,
                caption_block_id=canonical_of.get(caption) if caption is not None else None,
                source_block_ids=tuple(src for src, _ in draft.locations),
                ordinal=i,
            )
        )
    revision = _finalize(
        {
            "document_id": document_id,
            "revision_id": revision_id,
            "revision_number": 1,
            "source_sha256": parsed.source_sha256,
            "status": RevisionStatus.DRAFT,
            "sections": sections,
            "blocks": blocks,
        }
    )
    return StructureResult(
        revision=revision,
        warnings=tuple(hierarchy.warnings),
        front_matter_block_ids=tuple(ids[i] for i in hierarchy.front_matter),
        toc_block_ids=tuple(ids[i] for i in hierarchy.toc),
    )


def _edited_table(block: Block, text: str) -> TableContent:
    rows = tuple(tuple(cell.strip() for cell in line.split("|")) for line in text.split("\n"))
    header_rows = block.table.header_rows if block.table is not None else 0
    try:
        return TableContent(rows=rows, header_rows=min(header_rows, len(rows)))
    except ValueError as exc:
        raise RevisionEditError(f"block {block.id!r}: table text is not a grid: {exc}") from exc


def _edited_block(block: Block, raw: str) -> Block | None:
    if block.type is BlockType.IMAGE:
        raise RevisionEditError(f"block {block.id!r}: image blocks have no editable text")
    text = normalize_block_text(raw, block.type, dehyphenate=False)
    if not text:
        raise RevisionEditError(f"block {block.id!r}: text cannot be empty")
    update: dict[str, Any] = {"text": text, "edited": True}
    if block.type is BlockType.TABLE:
        table = _edited_table(block, text)
        update["table"] = table
        update["text"] = "\n".join(" | ".join(row) for row in table.rows)
    if update["text"] == block.text and update.get("table", block.table) == block.table:
        return None
    return Block.model_validate({**block.model_dump(), **update})


def apply_edits(
    base: DocumentRevision, edits: Mapping[str, str], *, revision_id: str
) -> DocumentRevision:
    """New draft revision with the text of the given canonical blocks replaced.

    Ids, order, sections and provenance are kept; changed blocks get ``edited=True`` (blocks
    edited in earlier revisions stay marked). Editing a heading renames its section. Edits
    that do not change the normalized text are ignored.
    """
    by_id = {b.id: b for b in base.blocks}
    unknown = sorted(set(edits) - set(by_id))
    if unknown:
        raise RevisionEditError(f"unknown block ids: {', '.join(unknown)}")
    replaced: dict[str, Block] = {}
    for block_id, text in edits.items():
        edited = _edited_block(by_id[block_id], text)
        if edited is not None:
            replaced[block_id] = edited
    titles = {b.id: b.text for b in replaced.values() if b.type is BlockType.HEADING}
    sections = [
        s.model_copy(update={"title": titles[s.heading_block_id]})
        if s.heading_block_id in titles
        else s
        for s in base.sections
    ]
    return _finalize(
        {
            **base.model_dump(exclude={"sections", "blocks", "content_hash"}),
            "revision_id": revision_id,
            "revision_number": base.revision_number + 1,
            "parent_revision_id": base.revision_id,
            "status": RevisionStatus.DRAFT,
            "sections": sections,
            "blocks": [replaced.get(b.id, b) for b in base.blocks],
        }
    )


def publish(revision: DocumentRevision) -> DocumentRevision:
    return revision.model_copy(update={"status": RevisionStatus.PUBLISHED})


def changed_block_ids(old: DocumentRevision, new: DocumentRevision) -> tuple[str, ...]:
    """Blocks of ``new`` whose content differs from ``old`` (or that ``old`` lacks), plus blocks
    ``old`` had and ``new`` dropped; what re-indexing must touch."""
    before = {b.id: b.model_dump(exclude={"edited"}) for b in old.blocks}
    after = {b.id: b.model_dump(exclude={"edited"}) for b in new.blocks}
    changed = [bid for bid, dump in after.items() if before.get(bid) != dump]
    removed = [bid for bid in before if bid not in after]
    return tuple(changed + removed)
