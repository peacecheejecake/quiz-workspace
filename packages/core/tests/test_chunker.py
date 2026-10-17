"""Hierarchical chunker on the book fixtures (M1.4).

Revisions come from the fixture truth (``FakeParser`` + ``build_revision``); the ``models``-marked
test repeats the structural assertions on revisions built from real Docling output. Default
sizes leave every fixture paragraph whole, so a small config is used as well to exercise
sentence and table-row splitting on the same content.
"""

from __future__ import annotations

from collections import Counter

import pytest
from book_core.chunker import (
    ApproxTokenizer,
    ChunkedRevision,
    ChunkerConfig,
    chunk_revision,
    diff_chunks,
    split_sentences,
)
from book_core.contracts import (
    BlockType,
    ChunkLevel,
    DocumentRevision,
    ParsedDocument,
    SearchChunk,
)
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision, ends_sentence, publish
from fixture_truth import BookTruth
from make_fixture_pdfs import OUT_DIR

BOOKS = ("book-ko", "book-en")
SMALL = ChunkerConfig(target_tokens=64, max_tokens=96, overlap_tokens=24, parent_max_tokens=208)
CONFIGS = {"default": ChunkerConfig(), "small": SMALL}


def _truth(fixture_id: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{fixture_id}.truth.json").read_bytes())


def _revision(parsed: ParsedDocument, revision_id: str = "rev-1") -> DocumentRevision:
    return publish(build_revision(parsed, document_id="doc-1", revision_id=revision_id).revision)


def _truth_revision(fixture_id: str, revision_id: str = "rev-1") -> DocumentRevision:
    parser = FakeParser.from_truth_files([OUT_DIR / f"{fixture_id}.truth.json"])
    return _revision(parser.parse(OUT_DIR / f"{fixture_id}.pdf"), revision_id)


def assert_chunk_invariants(
    revision: DocumentRevision, result: ChunkedRevision, config: ChunkerConfig
) -> None:
    tokenizer = ApproxTokenizer()
    blocks = {b.id: b for b in revision.blocks}
    parents = {p.id: p for p in result.parents}
    assert len(parents) == len(result.parents)
    assert len({c.id for c in result.children}) == len(result.children)
    assert not set(parents) & {c.id for c in result.children}

    # Every non-front-matter block is covered by at least one child.
    in_scope = {b.id for b in revision.blocks if b.section_id is not None}
    covered = {bid for c in result.children for bid in c.block_ids}
    assert in_scope <= covered
    assert covered <= in_scope  # front matter excluded by default
    assert result.uncovered_block_ids == ()

    # One or more parents per non-empty section; nothing crosses a section.
    sections_with_blocks = {b.section_id for b in revision.blocks if b.section_id is not None}
    assert {p.section_id for p in result.parents} == sections_with_blocks
    for chunk in result.chunks:
        assert chunk.document_id == revision.document_id
        assert chunk.revision_id == revision.revision_id
        assert {blocks[bid].section_id for bid in chunk.block_ids} == {chunk.section_id}
        # Provenance: every location is a location of a covered block, and every covered
        # block's locations are present.
        expected = {
            (loc.page, loc.bbox, bid) for bid in chunk.block_ids for loc in blocks[bid].locations
        }
        assert {(loc.page, loc.bbox, loc.block_id) for loc in chunk.locations} == expected
        assert chunk.token_count == tokenizer.count(chunk.search_text)
        assert chunk.search_text.endswith(chunk.content)
        assert chunk.search_text.startswith(" > ".join(chunk.breadcrumb))
        assert SearchChunk.model_validate_json(chunk.model_dump_json()) == chunk

    for child in result.children:
        assert child.level is ChunkLevel.CHILD
        parent = parents[child.parent_id or ""]
        assert parent.section_id == child.section_id
        assert set(child.block_ids) <= set(parent.block_ids)
        if child.token_count is not None and child.token_count > config.max_tokens:
            # Only a single table row (with the repeated header) may exceed the limit.
            assert any(blocks[b].type is BlockType.TABLE for b in child.block_ids)
    for parent in result.parents:
        assert parent.level is ChunkLevel.PARENT
        assert parent.parent_id is None
        assert parent.token_count is not None
        assert parent.token_count <= config.parent_max_tokens
        kids = [c for c in result.children if c.parent_id == parent.id]
        assert kids
        assert set(parent.block_ids) == {b for c in kids for b in c.block_ids}

    # Children and parents are in reading order.
    order = {b.id: b.ordinal for b in revision.blocks}
    starts = [min(order[b] or 0 for b in c.block_ids) for c in result.children]
    assert starts == sorted(starts)
    assert [c.ordinal for c in result.children] == list(range(len(result.children)))
    assert [p.ordinal for p in result.parents] == list(range(len(result.parents)))


@pytest.mark.parametrize("config_name", sorted(CONFIGS))
@pytest.mark.parametrize("fixture_id", BOOKS)
def test_chunks_cover_fixture_revisions(fixture_id: str, config_name: str) -> None:
    config = CONFIGS[config_name]
    revision = _truth_revision(fixture_id)
    truth = _truth(fixture_id)
    result = chunk_revision(revision, document_title=truth.title, config=config)
    assert_chunk_invariants(revision, result, config)
    for chunk in result.children:
        assert chunk.token_count is not None
        assert chunk.token_count <= config.max_tokens  # fixture table rows are short
        assert chunk.language == truth.language
        assert chunk.breadcrumb[0] == truth.title

    sections = {s.id: s for s in revision.sections}
    for chunk in result.chunks:
        assert chunk.section_id is not None
        section = sections[chunk.section_id]
        assert chunk.breadcrumb[-1] == section.title
        if section.parent_id is not None:
            assert chunk.breadcrumb[-2] == sections[section.parent_id].title

    # The cross-page paragraph's chunk carries both page locations.
    merged = [b for b in revision.blocks if len(b.locations) == 2]
    assert len(merged) == len(truth.cross_page_block_ids) == 1
    holders = [c for c in result.children if merged[0].id in c.block_ids]
    assert holders
    for chunk in holders:
        assert [loc.page for loc in chunk.locations if loc.block_id == merged[0].id] == [2, 3]


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_default_config_keeps_blocks_whole_and_tables_with_captions(fixture_id: str) -> None:
    revision = _truth_revision(fixture_id)
    result = chunk_revision(revision)
    # A block is never split at the default sizes: each is in exactly one child.
    counts = Counter(bid for c in result.children for bid in c.block_ids)
    assert set(counts.values()) == {1}
    # One parent per section for the fixture books.
    assert len(result.parents) == len(revision.sections)
    blocks = {b.id: b for b in revision.blocks}
    tables = [b for b in revision.blocks if b.type is BlockType.TABLE]
    for table in tables:
        holder = next(c for c in result.children if table.id in c.block_ids)
        # The table is its own chunk together with its caption (unlinked in the truth).
        kinds = [blocks[b].type for b in holder.block_ids]
        assert kinds == [BlockType.TEXT, BlockType.TABLE]
        assert holder.content == f"{blocks[holder.block_ids[0]].text}\n{table.text}"
    # A figure travels with its caption.
    for image in (b for b in revision.blocks if b.type is BlockType.IMAGE):
        holder = next(c for c in result.children if image.id in c.block_ids)
        assert image.caption_block_id in holder.block_ids
    # Headings lead the first child of their section.
    for section in revision.sections:
        first = next(c for c in result.children if c.section_id == section.id)
        assert first.block_ids[0] == section.heading_block_id
        assert first.content.startswith(section.title)


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_small_config_splits_paragraphs_at_sentences_and_tables_between_rows(
    fixture_id: str,
) -> None:
    revision = _truth_revision(fixture_id)
    result = chunk_revision(revision, config=SMALL)
    blocks = {b.id: b for b in revision.blocks}
    split = {bid for bid, n in Counter(b for c in result.children for b in c.block_ids).items()}
    split_blocks = [
        blocks[bid]
        for bid in split
        if sum(bid in c.block_ids for c in result.children) > 1
        and blocks[bid].type is BlockType.TEXT
    ]
    assert split_blocks, "the small config must split some paragraph"
    tokenizer = ApproxTokenizer()
    parents = {p.id: p for p in result.parents}
    for block in split_blocks:
        sentences = split_sentences(block.text)
        assert len(sentences) > 1
        pieces = [c for c in result.children if block.id in c.block_ids]
        assert len({p.id for p in pieces}) == len(pieces)
        for piece in pieces:
            body = piece.content.split("\n\n")[-1]  # after a leading heading, if any
            assert body in block.text
            if ends_sentence(body):
                continue
            # A piece ends mid-sentence only when that sentence alone exceeds the budget.
            budget = SMALL.target_tokens - tokenizer.count(" > ".join(piece.breadcrumb))
            assert any(body[-12:] in s and tokenizer.count(s) > budget for s in sentences)
        # The parent holds the paragraph exactly once (overlap is not repeated there).
        holders = {p.parent_id for p in pieces}
        if len(holders) == 1:
            assert parents[holders.pop() or ""].content.count(block.text) == 1

    for table in (b for b in revision.blocks if b.type is BlockType.TABLE):
        assert table.table is not None
        rows = [" | ".join(r) for r in table.table.rows]
        header = rows[: table.table.header_rows]
        parts = [c for c in result.children if table.id in c.block_ids]
        assert len(parts) > 1, "the small config must split the fixture table"
        body_seen: list[str] = []
        for part in parts:
            lines = part.content.split("\n")
            table_lines = [line for line in lines if " | " in line]
            assert table_lines[: len(header)] == header  # header repeated in every part
            assert all(line in rows for line in table_lines)  # never split inside a row
            body_seen.extend(table_lines[len(header) :])
        assert body_seen == rows[len(header) :]


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_chunking_is_deterministic_and_ids_survive_revisions(fixture_id: str) -> None:
    first = chunk_revision(_truth_revision(fixture_id), config=SMALL)
    second = chunk_revision(_truth_revision(fixture_id), config=SMALL)
    assert first == second
    assert [c.model_dump_json() for c in first.chunks] == [
        c.model_dump_json() for c in second.chunks
    ]
    other_revision = chunk_revision(_truth_revision(fixture_id, "rev-9"), config=SMALL)
    assert [(c.id, c.content_hash) for c in other_revision.chunks] == [
        (c.id, c.content_hash) for c in first.chunks
    ]
    assert {c.revision_id for c in other_revision.chunks} == {"rev-9"}
    assert diff_chunks(first.chunks, other_revision.chunks).is_empty


@pytest.mark.parametrize("config_name", sorted(CONFIGS))
def test_editing_one_paragraph_changes_only_its_child_and_parent(config_name: str) -> None:
    config = CONFIGS[config_name]
    base = _truth_revision("book-ko")
    before = chunk_revision(base, config=config)
    # A paragraph in a section with several children, edited without changing its length.
    target = next(
        b
        for b in base.blocks
        if b.type is BlockType.TEXT
        and "물" in b.text
        and b.section_id is not None
        and sum(c.section_id == b.section_id for c in before.children) > 2
    )
    edited = publish(
        apply_edits(base, {target.id: target.text.replace("물", "비", 1)}, revision_id="r2")
    )
    after = chunk_revision(edited, config=config)
    diff = diff_chunks(before.chunks, after.chunks)

    # Only the child holding the edited sentence (all of the paragraph at default sizes, one
    # of its pieces when split) and its parent change.
    pieces = {c.id for c in after.children if target.id in c.block_ids}
    changed_children = {c.id for c in after.children if c.id in diff.changed}
    assert changed_children
    assert changed_children <= pieces
    if len(pieces) == 1:
        assert changed_children == pieces
    parent_ids = {c.parent_id for c in after.children if c.id in changed_children}
    assert diff.added == ()
    assert diff.removed == ()
    assert set(diff.changed) == changed_children | parent_ids
    assert set(diff.affected_parent_ids) == parent_ids
    assert set(diff.reindex_ids) == set(diff.changed)
    assert len(diff.unchanged) == len(after.chunks) - len(diff.changed)
    old = {c.id: c for c in before.chunks}
    for chunk in after.chunks:
        if chunk.id in diff.unchanged:
            assert chunk.content_hash == old[chunk.id].content_hash
            assert chunk.content == old[chunk.id].content


def test_editing_a_heading_changes_its_section_subtree_breadcrumbs() -> None:
    base = _truth_revision("book-ko")
    before = chunk_revision(base)
    chapter = next(s for s in base.sections if s.level == 1)
    assert chapter.heading_block_id is not None
    edited = apply_edits(base, {chapter.heading_block_id: "1장 물의 순환 (개정)"}, revision_id="r2")
    after = chunk_revision(edited)
    diff = diff_chunks(before.chunks, after.chunks)
    subtree = {s.id for s in base.sections if s.id == chapter.id or s.parent_id == chapter.id}
    assert set(diff.changed) == {c.id for c in after.chunks if c.section_id in subtree}
    assert all(
        "1장 물의 순환 (개정)" in after_c.breadcrumb
        for after_c in after.chunks
        if after_c.section_id in subtree
    )


def test_growing_a_paragraph_reports_added_and_removed_chunks() -> None:
    base = _truth_revision("book-en")
    before = chunk_revision(base, config=SMALL)
    target = next(b for b in base.blocks if b.type is BlockType.TEXT and b.section_id)
    longer = " ".join([target.text] * 4)
    after = chunk_revision(apply_edits(base, {target.id: longer}, revision_id="r2"), config=SMALL)
    diff = diff_chunks(before.chunks, after.chunks)
    assert diff.added
    assert set(diff.removed) <= {c.id for c in before.chunks}
    new_ids = {c.id for c in after.chunks}
    assert set(diff.added) | set(diff.changed) | set(diff.unchanged) == new_ids
    assert not set(diff.removed) & new_ids
    # Chunks of other sections are untouched.
    other = {c.id for c in after.chunks if c.section_id != target.section_id}
    assert other <= set(diff.unchanged)


@pytest.fixture(scope="module")
def docling_revisions() -> dict[str, DocumentRevision]:
    from book_core.parser.docling_adapter import DoclingParser

    parser = DoclingParser()
    return {
        fixture_id: _revision(parser.parse(OUT_DIR / f"{fixture_id}.pdf")) for fixture_id in BOOKS
    }


@pytest.mark.models
@pytest.mark.parametrize("config_name", sorted(CONFIGS))
@pytest.mark.parametrize("fixture_id", BOOKS)
def test_chunks_cover_docling_revisions(
    fixture_id: str, config_name: str, docling_revisions: dict[str, DocumentRevision]
) -> None:
    config = CONFIGS[config_name]
    revision = docling_revisions[fixture_id]
    truth = _truth(fixture_id)
    result = chunk_revision(revision, document_title=truth.title, config=config)
    assert_chunk_invariants(revision, result, config)
    merged = [b for b in revision.blocks if [loc.page for loc in b.locations] == [2, 3]]
    assert len(merged) == 1
    holders = [c for c in result.children if merged[0].id in c.block_ids]
    assert holders
    assert all({2, 3} <= {loc.page for loc in c.locations} for c in holders)
    assert {c.language for c in result.children} == {truth.language}
    assert chunk_revision(revision, document_title=truth.title, config=config) == result
