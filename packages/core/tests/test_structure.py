"""Structure restoration and canonical revisions against the book fixture truth (M1.3).

The same assertions run on three inputs:
- ``truth``: the ideal ``ParsedDocument`` the ``FakeParser`` serves for the fixture PDFs (its
  parser-provided sections are ignored and rebuilt);
- ``docling_like``: the truth reshaped the way Docling reports the books (title/TOC page with
  the TOC as a messy table, every heading at level 1, the cross-page paragraph as two blocks);
- ``models``-marked: the real ``DoclingParser`` output (``pytest -m models``).

Truth blocks are matched to canonical blocks by text (NFKC, whitespace removed) on the page of
their first part, so the assertions do not depend on block ids.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    DocumentRevision,
    PageInfo,
    ParsedDocument,
    RevisionStatus,
    SourceLocation,
    TableContent,
)
from book_core.parser import FakeParser
from book_core.structure import (
    RevisionEditError,
    StructureResult,
    apply_edits,
    build_revision,
    changed_block_ids,
    publish,
)
from fixture_content import BOOK_EN, BOOK_KO
from fixture_truth import BookTruth, TruthBlock
from make_fixture_pdfs import OUT_DIR

BOOKS = ("book-ko", "book-en")
CONTENT = {"book-ko": BOOK_KO, "book-en": BOOK_EN}


def _loose(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _truth(fixture_id: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{fixture_id}.truth.json").read_bytes())


def _truth_document(fixture_id: str) -> ParsedDocument:
    parser = FakeParser.from_truth_files([OUT_DIR / f"{fixture_id}.truth.json"])
    return parser.parse(OUT_DIR / f"{fixture_id}.pdf")


def _docling_like(fixture_id: str) -> ParsedDocument:
    truth = _truth(fixture_id)
    content = CONTENT[fixture_id]
    front: list[Block] = [
        Block(
            id="front-title",
            type=BlockType.HEADING,
            text=truth.title,
            heading_level=1,
            locations=(SourceLocation(page=1, bbox=BBox(x0=64, y0=153, x1=470, y1=171)),),
        ),
        Block(
            id="front-subtitle",
            type=BlockType.TEXT,
            text=content.subtitle,
            locations=(SourceLocation(page=1, bbox=BBox(x0=64, y0=181, x1=360, y1=190)),),
        ),
        Block(
            id="front-toc-heading",
            type=BlockType.HEADING,
            text=content.toc_heading,
            heading_level=1,
            locations=(SourceLocation(page=1, bbox=BBox(x0=64, y0=240, x1=120, y1=251)),),
        ),
    ]
    # Docling splits TOC lines into cells unevenly and repeats spanning cells.
    rows = tuple((line.title, "." * 60, "." * 60, str(line.page)) for line in truth.toc)
    rows = ((*rows[0][:1], rows[0][0][:3], *rows[0][2:]), *rows[1:])
    front.append(
        Block(
            id="front-toc",
            type=BlockType.TABLE,
            text="\n".join(" | ".join(row) for row in rows),
            table=TableContent(rows=rows),
            locations=(SourceLocation(page=1, bbox=BBox(x0=63, y0=268, x1=531, y1=389)),),
        )
    )
    body: list[Block] = []
    for block in truth.blocks:
        for n, part in enumerate(block.parts):
            caption = block.caption_block_id
            body.append(
                Block(
                    id=f"{block.id}.{n}",
                    type=block.type,
                    text=part.text if len(block.parts) > 1 else block.text,
                    heading_level=1 if block.type is BlockType.HEADING else None,
                    table=(
                        TableContent(rows=block.table.rows, header_rows=block.table.header_rows)
                        if block.table is not None
                        else None
                    ),
                    caption_block_id=f"{caption}.0" if caption is not None else None,
                    locations=(SourceLocation(page=part.page, bbox=part.bbox),),
                )
            )
    return ParsedDocument(
        source_path=truth.file,
        source_sha256=truth.sha256,
        parser_version="docling-like/1",
        pages=tuple(PageInfo(page=p.page, width=p.width, height=p.height) for p in truth.pages),
        blocks=(*front, *body),
    )


SOURCES: dict[str, Callable[[str], ParsedDocument]] = {
    "truth": _truth_document,
    "docling_like": _docling_like,
}


def _build(parsed: ParsedDocument) -> StructureResult:
    return build_revision(parsed, document_id="doc-1", revision_id="rev-1")


def _match(revision: DocumentRevision, block: TruthBlock, truth: BookTruth) -> Block:
    if block.type is BlockType.IMAGE:
        caption = next(b for b in truth.blocks if b.id == block.caption_block_id)
        caption_ids = {_match(revision, caption, truth).id}
        hits = [b for b in revision.blocks if b.caption_block_id in caption_ids]
    else:
        page = block.parts[0].page
        hits = [
            b
            for b in revision.blocks
            if b.locations[0].page == page and _loose(b.text) == _loose(block.text)
        ]
    assert len(hits) == 1, f"{block.id}: {len(hits)} canonical blocks match"
    return hits[0]


def assert_matches_truth(
    result: StructureResult, truth: BookTruth, *, exact_tables: bool, split_parts: bool
) -> None:
    revision = result.revision
    by_truth_id = {b.id: b for b in truth.blocks}

    # Chapter/section tree: titles, hierarchy and heading pages equal the truth TOC.
    sections = {s.id: s for s in revision.sections}
    blocks = {b.id: b for b in revision.blocks}
    got = [
        (
            s.title,
            s.level,
            sections[s.parent_id].title if s.parent_id else None,
            blocks[s.heading_block_id].locations[0].page if s.heading_block_id else None,
        )
        for s in revision.sections
    ]
    truth_titles = {s.id: s.title for s in truth.sections}
    want = [
        (s.title, s.level, truth_titles[s.parent_id] if s.parent_id else None, s.page)
        for s in truth.sections
    ]
    assert got == want
    toc = [(line.title, line.level, line.page) for line in truth.toc]
    assert [(t, lvl, p) for t, lvl, _, p in got] == toc

    # Every truth block maps to exactly one canonical block, in the right section.
    matched = {block.id: _match(revision, block, truth) for block in truth.blocks}
    assert len({b.id for b in matched.values()}) == len(truth.blocks)
    for block in truth.blocks:
        canonical = matched[block.id]
        assert canonical.type is block.type, block.id
        section = sections[canonical.section_id] if canonical.section_id else None
        assert section is not None, block.id
        assert block.section_id is not None
        assert section.title == truth_titles[block.section_id], block.id
        assert [loc.page for loc in canonical.locations] == [p.page for p in block.parts]
        assert len(canonical.source_block_ids) == len(block.parts)
        assert all(loc.block_id == canonical.id for loc in canonical.locations)
        assert all(loc.bbox is not None for loc in canonical.locations)
        if block.type is BlockType.HEADING:
            assert section.heading_block_id == canonical.id

    # The cross-page paragraph is one canonical block with provenance on pages 2 and 3.
    for block_id in truth.cross_page_block_ids:
        canonical = matched[block_id]
        assert [loc.page for loc in canonical.locations] == [2, 3]
        assert len(canonical.source_block_ids) == 2
        if split_parts:  # the parser reported two blocks; both are kept as provenance
            assert len(set(canonical.source_block_ids)) == 2
        assert canonical.text == unicodedata.normalize("NFC", by_truth_id[block_id].text)

    # Tables, figures and captions stay separate blocks, captions linked.
    for block in truth.blocks:
        canonical = matched[block.id]
        if block.caption_block_id is not None:
            assert canonical.caption_block_id == matched[block.caption_block_id].id
        if block.table is not None:
            assert canonical.table is not None
            if exact_tables:
                assert canonical.table.rows == block.table.rows
            else:
                assert [[_loose(c) for c in r] for r in canonical.table.rows] == [
                    [_loose(c) for c in r] for r in block.table.rows
                ]

    # Front matter (title page, TOC) is not part of any chapter.
    unassigned = [b for b in revision.blocks if b.section_id is None]
    assert [b.id for b in unassigned] == list(result.front_matter_block_ids)
    assert all(b.locations[0].page < truth.sections[0].page for b in unassigned)
    assert set(result.toc_block_ids) <= set(result.front_matter_block_ids)
    assert all(
        blocks[s.heading_block_id].locations[0].page >= truth.sections[0].page
        for s in revision.sections
        if s.heading_block_id
    )
    assert result.warnings == ()
    assert revision.content_hash is not None
    assert [b.ordinal for b in revision.blocks] == list(range(len(revision.blocks)))


@pytest.mark.parametrize("source", sorted(SOURCES))
@pytest.mark.parametrize("fixture_id", BOOKS)
def test_structure_matches_truth(fixture_id: str, source: str) -> None:
    parsed = SOURCES[source](fixture_id)
    result = _build(parsed)
    assert_matches_truth(
        result, _truth(fixture_id), exact_tables=True, split_parts=source == "docling_like"
    )
    if source == "docling_like":
        assert len(result.front_matter_block_ids) == 4
        assert len(result.toc_block_ids) == 4  # the whole title/TOC page


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_revision_is_deterministic(fixture_id: str) -> None:
    first = _build(_docling_like(fixture_id))
    second = _build(_docling_like(fixture_id))
    assert first == second
    assert first.revision.model_dump_json() == second.revision.model_dump_json()
    reparsed = DocumentRevision.model_validate_json(first.revision.model_dump_json())
    assert reparsed == first.revision
    other = build_revision(_docling_like(fixture_id), document_id="doc-2", revision_id="r-9")
    assert [b.id for b in other.revision.blocks] == [b.id for b in first.revision.blocks]
    assert [s.id for s in other.revision.sections] == [s.id for s in first.revision.sections]
    assert other.revision.content_hash == first.revision.content_hash


def test_apply_edits_creates_new_revision_with_provenance() -> None:
    base = _build(_docling_like("book-ko")).revision
    text_blocks = [b for b in base.blocks if b.type is BlockType.TEXT and b.section_id]
    merged = next(b for b in base.blocks if len(b.locations) == 2)
    heading = next(b for b in base.blocks if b.type is BlockType.HEADING and b.section_id)
    edits = {
        text_blocks[0].id: text_blocks[0].text.replace("이동한다", "순환한다"),
        merged.id: "  교정된   문단  \n 텍스트. ",
        heading.id: "1장 물의 순환 (교정)",
        text_blocks[1].id: text_blocks[1].text,  # no-op
    }
    revised = apply_edits(base, edits, revision_id="rev-2")

    assert revised.revision_number == 2
    assert revised.parent_revision_id == "rev-1"
    assert revised.status is RevisionStatus.DRAFT
    assert revised.document_id == base.document_id
    assert revised.source_sha256 == base.source_sha256
    assert set(changed_block_ids(base, revised)) == {text_blocks[0].id, merged.id, heading.id}
    assert revised.content_hash != base.content_hash

    old = {b.id: b for b in base.blocks}
    for block in revised.blocks:
        before = old[block.id]
        assert block.locations == before.locations
        assert block.source_block_ids == before.source_block_ids
        assert block.section_id == before.section_id
        assert block.ordinal == before.ordinal
        assert block.edited is (block.id in {text_blocks[0].id, merged.id, heading.id})
    assert [b.id for b in revised.blocks] == [b.id for b in base.blocks]
    assert next(b for b in revised.blocks if b.id == merged.id).text == "교정된 문단 텍스트."
    section = next(s for s in revised.sections if s.heading_block_id == heading.id)
    assert section.title == "1장 물의 순환 (교정)"

    # Earlier edits stay marked; the parent revision is untouched.
    third = apply_edits(revised, {text_blocks[2].id: "새 문장."}, revision_id="rev-3")
    assert third.revision_number == 3
    assert third.parent_revision_id == "rev-2"
    assert changed_block_ids(revised, third) == (text_blocks[2].id,)
    assert {b.id for b in third.blocks if b.edited} == {
        text_blocks[0].id,
        merged.id,
        heading.id,
        text_blocks[2].id,
    }
    assert not any(b.edited for b in base.blocks)

    published = publish(third)
    assert published.status is RevisionStatus.PUBLISHED
    assert published.content_hash == third.content_hash


def test_apply_edits_tables_and_errors() -> None:
    base = _build(_docling_like("book-en")).revision
    table = next(b for b in base.blocks if b.type is BlockType.TABLE and b.section_id)
    image = next(b for b in base.blocks if b.type is BlockType.IMAGE)
    assert table.table is not None
    lines = table.text.split("\n")
    lines[1] = lines[1].replace("Coagulation", "Coagulation (rapid mix)")
    revised = apply_edits(base, {table.id: "\n".join(lines)}, revision_id="rev-2")
    edited = next(b for b in revised.blocks if b.id == table.id)
    assert edited.table is not None
    assert edited.table.rows[1][0] == "Coagulation (rapid mix)"
    assert edited.table.header_rows == table.table.header_rows

    with pytest.raises(RevisionEditError, match="unknown block"):
        apply_edits(base, {"nope": "x"}, revision_id="rev-2")
    with pytest.raises(RevisionEditError, match="empty"):
        apply_edits(base, {table.id: "   "}, revision_id="rev-2")
    with pytest.raises(RevisionEditError, match="image"):
        apply_edits(base, {image.id: "alt"}, revision_id="rev-2")
    with pytest.raises(RevisionEditError, match="grid"):
        apply_edits(base, {table.id: "a | b\nc"}, revision_id="rev-2")


def test_revision_contract_rejects_inconsistent_provenance() -> None:
    revision = _build(_docling_like("book-en")).revision
    data = revision.model_dump()
    with pytest.raises(ValueError, match="content_hash"):
        DocumentRevision.model_validate({**data, "content_hash": "0" * 64})
    blocks = [dict(b) for b in data["blocks"]]
    blocks[0]["source_block_ids"] = ["a", "b"]
    with pytest.raises(ValueError, match="align"):
        DocumentRevision.model_validate({**data, "blocks": blocks, "content_hash": None})
    blocks = [dict(b) for b in data["blocks"]]
    blocks[1]["ordinal"] = 0
    with pytest.raises(ValueError, match="ordinals"):
        DocumentRevision.model_validate({**data, "blocks": blocks, "content_hash": None})
    sections = [dict(s) for s in data["sections"]]
    sections[0]["heading_block_id"] = data["blocks"][1]["id"]  # a text block
    with pytest.raises(ValueError, match="not a heading block"):
        DocumentRevision.model_validate({**data, "sections": sections, "content_hash": None})


@pytest.fixture(scope="module")
def docling_documents() -> dict[str, ParsedDocument]:
    from book_core.parser.docling_adapter import DoclingParser

    parser = DoclingParser()
    return {fixture_id: parser.parse(OUT_DIR / f"{fixture_id}.pdf") for fixture_id in BOOKS}


@pytest.mark.models
@pytest.mark.parametrize("fixture_id", BOOKS)
def test_structure_matches_truth_on_docling(
    fixture_id: str, docling_documents: dict[str, ParsedDocument]
) -> None:
    parsed = docling_documents[fixture_id]
    result = _build(parsed)
    assert_matches_truth(result, _truth(fixture_id), exact_tables=False, split_parts=True)
    assert result.toc_block_ids  # the TOC page is detected (title, subtitle, heading, table)
    assert _build(parsed) == result
