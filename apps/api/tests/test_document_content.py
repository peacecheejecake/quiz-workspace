"""Pure M3.4 content logic: single-block edits with `apply_edits` semantics, versions, outline
tree, and the row codec's hash. SQL and the worker round trip are covered by
tests/integration/workspaces/test_document_revisions.py."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from book_core.contracts import Block, BlockType, SourceLocation, TableContent
from book_core.structure import apply_edits
from quiz_api.document_content import (
    BlockEditRefused,
    ContentDecodeError,
    block_attributes,
    block_version,
    edit_block,
    outline_tree,
    revision_from_rows,
)

SHA = "a" * 64


def _block(block_type: BlockType = BlockType.TEXT, text: str = "원래 문장.", **extra: Any) -> Block:
    return Block(
        id="cb-1",
        type=block_type,
        text=text,
        section_id="sec-1",
        locations=(SourceLocation(page=3, block_id="cb-1"),),
        ordinal=7,
        **extra,
    )


def test_text_edit_is_normalized_and_marked_edited() -> None:
    edited = edit_block(_block(), "  교정된   문장.  ", source_sha256=SHA)
    assert edited is not None
    assert (edited.text, edited.edited) == ("교정된 문장.", True)
    # Links and provenance survive the one-block edit.
    assert (edited.section_id, edited.ordinal, edited.locations) == (
        "sec-1",
        7,
        _block().locations,
    )


def test_unchanged_text_is_a_no_op_also_for_an_already_edited_block() -> None:
    assert edit_block(_block(), "원래 문장.", source_sha256=SHA) is None
    previously = _block(text="이미 고침.", edited=True)
    assert edit_block(previously, "이미 고침.", source_sha256=SHA) is None


def test_edit_matches_apply_edits_on_the_whole_revision() -> None:
    from book_core.contracts import DocumentRevision

    block = _block().model_copy(update={"section_id": None})
    base = DocumentRevision(
        document_id="d", revision_id="r1", revision_number=1, source_sha256=SHA, blocks=(block,)
    )
    expected = apply_edits(base, {"cb-1": "새 문장"}, revision_id="r2").blocks[0]
    assert edit_block(block, "새 문장", source_sha256=SHA) == expected


@pytest.mark.parametrize("text", ["", "   ", "\n"])
def test_empty_text_is_refused(text: str) -> None:
    with pytest.raises(BlockEditRefused, match="empty"):
        edit_block(_block(), text, source_sha256=SHA)


def test_image_blocks_are_not_editable() -> None:
    image = _block(BlockType.IMAGE, "", caption_block_id="cb-2")
    with pytest.raises(BlockEditRefused, match="Image"):
        edit_block(image, "설명", source_sha256=SHA)


def test_table_text_is_reparsed_into_cells_and_must_be_a_grid() -> None:
    table = _block(
        BlockType.TABLE,
        "a | b\nc | d",
        table=TableContent(rows=(("a", "b"), ("c", "d")), header_rows=1),
        caption_block_id="cb-2",
    )
    edited = edit_block(table, "가 | 나\n다 | 라", source_sha256=SHA)
    assert edited is not None
    assert edited.table == TableContent(rows=(("가", "나"), ("다", "라")), header_rows=1)
    assert edited.caption_block_id == "cb-2"
    assert block_attributes(edited) == {
        "table": {"rows": [["가", "나"], ["다", "라"]], "header_rows": 1},
        "caption_block_id": "cb-2",
    }
    with pytest.raises(BlockEditRefused, match="grid"):
        edit_block(table, "가 | 나\n다", source_sha256=SHA)


def test_refusals_never_quote_the_text() -> None:
    book_text = "책 본문 일부"
    table = _block(BlockType.TABLE, "a | b", table=TableContent(rows=(("a", "b"),)))
    with pytest.raises(BlockEditRefused) as info:
        edit_block(table, f"{book_text} | x\ny", source_sha256=SHA)
    assert book_text not in str(info.value)


def test_heading_length_is_bounded_by_the_chapter_title_limit() -> None:
    heading = _block(BlockType.HEADING, "1장", heading_level=1)
    with pytest.raises(BlockEditRefused, match="heading"):
        edit_block(heading, "가" * 1001, source_sha256=SHA)
    edited = edit_block(heading, "1장 새 제목", source_sha256=SHA)
    assert edited is not None
    assert block_attributes(edited) == {"heading_level": 1}


def test_block_version_tracks_the_text() -> None:
    assert block_version("a") == block_version("a")
    assert block_version("a") != block_version("b")
    assert len(block_version("a")) == 32


def _chapter(cid: uuid.UUID, parent: uuid.UUID | None, key: str, order: int) -> dict[str, Any]:
    return {
        "id": cid,
        "parent_id": parent,
        "section_key": key,
        "level": 1 if parent is None else 2,
        "sort_order": order,
        "title": key.upper(),
        "page": order + 1,
        "heading_block_id": f"cb-{key}",
    }


def test_outline_tree_nests_children_in_order() -> None:
    a, a1, a2, b = (uuid.uuid4() for _ in range(4))
    rows = [_chapter(b, None, "b", 3), _chapter(a2, a, "a2", 2), _chapter(a, None, "a", 0)]
    rows.append(_chapter(a1, a, "a1", 1))
    roots = outline_tree(rows)
    assert [n.section_key for n in roots] == ["a", "b"]
    assert [c.section_key for c in roots[0].children] == ["a1", "a2"]
    assert roots[1].children == []


def _block_row(block_id: str, ordinal: int, chapter: uuid.UUID | None, text: str) -> dict[str, Any]:
    return {
        "block_id": block_id,
        "ordinal": ordinal,
        "chapter_id": chapter,
        "block_type": "text",
        "text": text,
        "provenance": {"locations": [{"page": 1}], "source_block_ids": []},
        "attributes": {},
        "edited": False,
    }


def test_revision_from_rows_hash_ignores_row_order_and_edited_flags() -> None:
    a = uuid.uuid4()
    chapters = [_chapter(a, None, "a", 0) | {"heading_block_id": None}]
    blocks = [_block_row("b2", 2, a, "둘"), _block_row("b1", 1, None, "하나")]
    kwargs: dict[str, Any] = {
        "document_id": "d",
        "revision_id": "r",
        "revision_number": 2,
        "parent_revision_id": None,
        "source_sha256": SHA,
        "chapters": chapters,
    }
    first = revision_from_rows(blocks=blocks, **kwargs)
    second = revision_from_rows(blocks=[{**b, "edited": True} for b in reversed(blocks)], **kwargs)
    assert [b.id for b in first.blocks] == ["b1", "b2"]
    assert first.blocks[1].section_id == "a"
    assert first.content_hash == second.content_hash
    changed = revision_from_rows(blocks=[blocks[0], _block_row("b1", 1, None, "하나!")], **kwargs)
    assert changed.content_hash != first.content_hash


def test_inconsistent_rows_never_leak_text() -> None:
    with pytest.raises(ContentDecodeError) as info:
        revision_from_rows(
            document_id="d",
            revision_id="r",
            revision_number=1,
            parent_revision_id=None,
            source_sha256=SHA,
            chapters=[],
            blocks=[_block_row("b1", 1, uuid.uuid4(), "비밀 본문")],
        )
    assert "비밀" not in str(info.value)
