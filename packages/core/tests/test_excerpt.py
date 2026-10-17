"""ExcerptResolver (M2.5): paragraph expansion, context, source locations, highlights.

Default tests use revisions built from the fixture truth (``FakeParser`` + ``build_revision``);
canonical block ids are ``cb-<truth block id>`` there. A small chunker config splits fixture
paragraphs into sentence windows so that mid-paragraph hits exist. The ``models``-marked test
repeats the completeness check on revisions built from real Docling output.
"""

from __future__ import annotations

import json
import re
import unicodedata

import pytest
from book_core.chunker import ChunkerConfig, chunk_revision, split_sentences
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    DocumentRevision,
    Excerpt,
    ScoreType,
    SearchHit,
    SearchMode,
    Section,
    SourceLocation,
    TextSpan,
)
from book_core.parser import FakeParser
from book_core.search import (
    ExcerptConfig,
    ExcerptError,
    ExcerptResolver,
    RankedHit,
    query_terms,
    term_spans,
)
from book_core.structure import apply_edits, build_revision, publish
from fixture_truth import BookTruth
from make_fixture_pdfs import OUT_DIR
from pydantic import ValidationError

BOOKS = ("book-ko", "book-en")
SMALL = ChunkerConfig(target_tokens=64, max_tokens=96, overlap_tokens=24, parent_max_tokens=208)
SEED = json.loads((OUT_DIR / "retrieval-seed.json").read_text(encoding="utf-8"))["queries"]


def _truth(book: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{book}.truth.json").read_bytes())


def _revision(book: str, revision_id: str = "r1") -> DocumentRevision:
    parsed = FakeParser.from_truth_files([OUT_DIR / f"{book}.truth.json"]).parse(
        OUT_DIR / f"{book}.pdf"
    )
    return publish(build_revision(parsed, document_id=book, revision_id=revision_id).revision)


REVISIONS = {book: _revision(book) for book in BOOKS}


def _block(book: str, truth_id: str) -> Block:
    return next(b for b in REVISIONS[book].blocks if b.id == f"cb-{truth_id}")


def _resolver(book: str, **config: object) -> ExcerptResolver:
    return ExcerptResolver(
        REVISIONS[book],
        config=ExcerptConfig(**config),  # type: ignore[arg-type]
        document_title=_truth(book).title,
    )


def _spans(excerpt: Excerpt, spans: tuple[TextSpan, ...]) -> list[str]:
    return [excerpt.text[s.start : s.end] for s in spans]


def _loose(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


# --- paragraph expansion -----------------------------------------------------------------------


@pytest.mark.parametrize("book", BOOKS)
def test_mid_paragraph_window_expands_to_full_paragraph(book: str) -> None:
    revision = REVISIONS[book]
    blocks = {b.id: b for b in revision.blocks}
    children = chunk_revision(revision, config=SMALL).children
    windows = [
        c
        for c in children
        if len(c.block_ids) == 1
        and blocks[c.block_ids[0]].type is BlockType.TEXT
        and c.content != blocks[c.block_ids[0]].text
        and not blocks[c.block_ids[0]].text.startswith(c.content)
        and blocks[c.block_ids[0]].text.count(c.content) == 1
    ]
    assert windows, "the small config must split some paragraph"
    resolver = _resolver(book, context_before=0, context_after=0)
    for chunk in windows:
        block = blocks[chunk.block_ids[0]]
        excerpt = resolver.resolve_hit(chunk)
        assert excerpt.text == block.text
        assert excerpt.block_ids == excerpt.matched_block_ids == (block.id,)
        assert _spans(excerpt, excerpt.highlights) == [chunk.content]
        assert excerpt.highlights[0].start == block.text.index(chunk.content) > 0
        assert excerpt.chunk_id == chunk.id
        assert excerpt.section_id == block.section_id == chunk.section_id
        assert not excerpt.truncated_start
        assert not excerpt.truncated_end


@pytest.mark.parametrize("book", BOOKS)
def test_heading_led_chunk_shows_paragraphs_and_breadcrumb(book: str) -> None:
    revision = REVISIONS[book]
    truth = _truth(book)
    heading = _block(book, "ch1-s1-heading")
    chunk = next(
        c for c in chunk_revision(revision, config=SMALL).children if heading.id in c.block_ids
    )
    excerpt = _resolver(book, context_after=0).resolve_hit(chunk)
    assert heading.id not in excerpt.block_ids
    assert heading.text not in excerpt.text
    assert excerpt.text == _block(book, "ch1-s1-p1").text
    assert excerpt.breadcrumb == (
        truth.title,
        _block(book, "ch1-heading").text,
        heading.text,
    )
    # Only the paragraph part of the chunk is highlighted.
    assert _spans(excerpt, excerpt.highlights) == [chunk.content.split("\n\n", 1)[1]]


@pytest.mark.parametrize("book", BOOKS)
def test_cross_page_paragraph_has_both_page_locations(book: str) -> None:
    [truth_id] = _truth(book).cross_page_block_ids
    block = _block(book, truth_id)
    assert [loc.page for loc in block.locations] == [2, 3]
    for chunk in chunk_revision(REVISIONS[book], config=SMALL).children:
        if block.id not in chunk.block_ids:
            continue
        excerpt = _resolver(book, context_before=0, context_after=0).resolve_hit(chunk)
        assert excerpt.text == block.text
        own = [loc for loc in excerpt.locations if loc.block_id == block.id]
        assert [loc.page for loc in own] == [2, 3]
        assert [loc.bbox for loc in own] == [loc.bbox for loc in block.locations]
        assert excerpt.primary_location == own[0]
        assert excerpt.primary_location.page == 2


# --- context -----------------------------------------------------------------------------------


@pytest.mark.parametrize("book", BOOKS)
def test_context_counts_paragraphs_and_stops_at_section(book: str) -> None:
    middle = _block(book, "ch1-s2-p2")
    p1, p3 = _block(book, "ch1-s2-p1"), _block(book, "ch1-s2-p3")

    def ids(**config: object) -> tuple[str, ...]:
        return _resolver(book, **config).resolve([middle.id]).block_ids

    assert ids(context_before=0, context_after=0) == (middle.id,)
    assert ids(context_before=1, context_after=0) == (p1.id, middle.id)
    assert ids(context_before=0, context_after=1) == (middle.id, p3.id)
    # Large context stays inside section 1.2: no heading, no blocks of 1.1 or chapter 2.
    assert ids(context_before=10, context_after=10) == (p1.id, middle.id, p3.id)
    excerpt = _resolver(book, context_before=1, context_after=1).resolve([middle.id])
    assert excerpt.text == "\n\n".join((p1.text, middle.text, p3.text))
    assert excerpt.matched_block_ids == (middle.id,)
    assert _spans(excerpt, excerpt.highlights) == [middle.text]
    assert excerpt.primary_location == middle.locations[0]
    assert {loc.block_id for loc in excerpt.locations} == {p1.id, middle.id, p3.id}


@pytest.mark.parametrize("book", BOOKS)
def test_cross_sections_only_when_asked(book: str) -> None:
    last = _block(book, "ch1-s2-p3")
    within = _resolver(book, context_after=2).resolve([last.id])
    assert within.block_ids[-1] == last.id
    crossing = _resolver(book, context_after=2, cross_sections=True).resolve([last.id])
    assert crossing.block_ids[-2:] == (_block(book, "ch2-heading").id, _block(book, "ch2-p1").id)
    assert crossing.section_id == last.section_id
    assert crossing.text.endswith(_block(book, "ch2-p1").text)


@pytest.mark.parametrize("book", BOOKS)
def test_table_is_one_unit_with_its_caption(book: str) -> None:
    table, caption = _block(book, "ch2-s1-table1"), _block(book, "ch2-s1-table1-caption")
    excerpt = _resolver(book, context_before=0, context_after=0).resolve([table.id])
    assert excerpt.block_ids == (caption.id, table.id)
    assert excerpt.matched_block_ids == (caption.id, table.id)
    assert excerpt.text == f"{caption.text}\n{table.text}"
    # A paragraph's context counts the captioned table as one unit.
    p2 = _block(book, "ch2-s1-p2")
    with_table = _resolver(book, context_before=0, context_after=1).resolve([p2.id])
    assert with_table.block_ids == (p2.id, caption.id, table.id)
    # A split table part (repeated header + rows) is highlighted line by line.
    parts = [
        c
        for c in chunk_revision(REVISIONS[book], config=ChunkerConfig(32, 40, 8, 120)).children
        if table.id in c.block_ids
    ]
    assert len(parts) > 1
    later = _resolver(book, context_before=0, context_after=0).resolve_hit(parts[-1])
    highlighted = "\n".join(_spans(later, later.highlights))
    for row in parts[-1].content.split("\n")[1:]:
        assert row in highlighted


@pytest.mark.parametrize("book", BOOKS)
def test_figure_hit_shows_caption_and_image_location(book: str) -> None:
    image, caption = _block(book, "ch1-s1-fig1"), _block(book, "ch1-s1-fig1-caption")
    excerpt = _resolver(book, context_before=0, context_after=0).resolve([image.id])
    assert excerpt.text == caption.text
    assert excerpt.block_ids == (image.id, caption.id)
    assert excerpt.primary_location == image.locations[0]
    assert image.locations[0].bbox in {loc.bbox for loc in excerpt.locations}
    p3 = _block(book, "ch1-s1-p3")
    before = _resolver(book, context_before=1, context_after=0).resolve([p3.id])
    assert before.block_ids == (image.id, caption.id, p3.id)


# --- highlights --------------------------------------------------------------------------------


def test_query_terms_ko_and_en() -> None:
    terms = query_terms("정수장에서 염소를 넣는 이유")
    assert terms.hangul == ("정수", "수장", "염소", "넣", "이유")
    terms = query_terms("Why are coagulants added before sedimentation?")
    assert terms.hangul == ()
    assert ("coagulants", "coagulant") in terms.words
    assert all(word not in {"why", "are"} for word, _ in terms.words)


def test_term_highlights_korean() -> None:
    block = _block("book-ko", "ch2-s2-p2")
    excerpt = _resolver("book-ko", context_before=0, context_after=0).resolve(
        [block.id], query="정수장에서 염소를 넣는 이유"
    )
    found = _spans(excerpt, excerpt.term_highlights)
    assert found.count("염소") == block.text.count("염소") == 2
    assert set(found) <= {"염소", "넣"}
    starts = [s.start for s in excerpt.term_highlights]
    assert starts == sorted(starts)
    assert excerpt.text[: excerpt.term_highlights[0].start] == "마지막으로 "


def test_term_highlights_english_words_and_stems() -> None:
    block = _block("book-en", "ch2-s1-p1")
    excerpt = _resolver("book-en", context_before=0, context_after=0).resolve(
        [block.id], query="Why are COAGULANTS added before sedimentation"
    )
    found = _spans(excerpt, excerpt.term_highlights)
    assert "coagulant" in found
    stems = ("coagulant", "added", "before", "sedimentation")
    assert all(w.lower().startswith(stems) for w in found)
    for span in excerpt.term_highlights:
        # Whole words only.
        assert span.start == 0 or not excerpt.text[span.start - 1].isalnum()
        assert span.end == len(excerpt.text) or not excerpt.text[span.end].isalnum()


def test_term_spans_map_folded_text_back_to_original_offsets() -> None:
    wide = "".join(chr(ord(c) + 0xFEE0) for c in "CHLORINE")  # full-width letters
    text = f"{wide} and Straße; 염소는 chlorinated"
    spans = term_spans(text, "chlorine strasse 염소")
    assert [text[s:e] for s, e in spans] == [wide, "Straße", "염소"]
    assert term_spans("no match here", "염소") == []


# --- truncation --------------------------------------------------------------------------------


@pytest.mark.parametrize("book", BOOKS)
def test_truncation_keeps_match_at_sentence_boundaries(book: str) -> None:
    middle = _block(book, "ch1-s2-p2")
    full = _resolver(book, context_before=5, context_after=5).resolve([middle.id])
    limit = len(middle.text) + 40
    excerpt = _resolver(book, context_before=5, context_after=5, max_chars=limit).resolve(
        [middle.id]
    )
    assert len(excerpt.text) <= limit < len(full.text)
    assert excerpt.text in full.text
    assert _spans(excerpt, excerpt.highlights) == [middle.text]
    assert excerpt.truncated_start or excerpt.truncated_end
    # Clean cut: starts at a sentence/paragraph start and ends after a sentence terminator.
    offset = full.text.index(excerpt.text)
    assert offset == 0 or full.text[offset - 1] in " \n"
    assert excerpt.text[-1] in ".!?…다"
    assert set(excerpt.block_ids) <= set(full.block_ids)
    assert middle.id in excerpt.matched_block_ids


@pytest.mark.parametrize("book", BOOKS)
def test_truncation_inside_a_long_paragraph_keeps_the_window(book: str) -> None:
    block = _block(book, "ch1-s2-p2")
    chunk = next(
        c
        for c in chunk_revision(REVISIONS[book], config=SMALL).children
        if c.block_ids == (block.id,) and block.text.endswith(c.content)
    )
    excerpt = _resolver(book, context_before=0, context_after=0, max_chars=len(chunk.content) + 5)
    result = excerpt.resolve_hit(chunk)
    assert result.truncated_start
    assert not result.truncated_end
    assert result.text == chunk.content
    assert _spans(result, result.highlights) == [chunk.content]


def test_truncation_of_one_overlong_sentence_cuts_at_words() -> None:
    words = " ".join(f"word{i}" for i in range(200))
    revision = DocumentRevision(
        document_id="d",
        revision_id="r",
        revision_number=1,
        source_sha256="a" * 64,
        sections=(Section(id="s", title="S", level=1),),
        blocks=(
            Block(
                id="b",
                type=BlockType.TEXT,
                text=words,
                section_id="s",
                locations=(SourceLocation(page=1, bbox=BBox(x0=1, y0=1, x1=2, y1=2)),),
            ),
        ),
    )
    resolver = ExcerptResolver(revision, config=ExcerptConfig(max_chars=60))
    excerpt = resolver.resolve(["b"], passage="word150 word151")
    assert len(excerpt.text) <= 60
    assert excerpt.truncated_start
    assert excerpt.truncated_end
    assert _spans(excerpt, excerpt.highlights) == ["word150 word151"]
    assert excerpt.text.split(" ")[0] in words.split(" ")
    assert excerpt.text.split(" ")[-1] in words.split(" ")
    assert excerpt.breadcrumb == ("S",)
    assert excerpt.locations[0].block_id == "b"


# --- revisions, hits, determinism --------------------------------------------------------------


@pytest.mark.parametrize("book", BOOKS)
def test_edited_revision_shows_corrected_text_with_original_pages(book: str) -> None:
    [truth_id] = _truth(book).cross_page_block_ids
    block = _block(book, truth_id)
    edited_text = block.text.replace("." if book == "book-en" else "다.", "!", 1)
    edited = publish(apply_edits(REVISIONS[book], {block.id: edited_text}, revision_id="r2"))
    new_block = next(b for b in edited.blocks if b.id == block.id)
    assert new_block.edited
    assert new_block.text != block.text
    chunk = next(c for c in chunk_revision(edited).children if block.id in c.block_ids)
    resolver = ExcerptResolver(edited, config=ExcerptConfig(context_before=0, context_after=0))
    excerpt = resolver.resolve_hit(chunk)
    assert excerpt.revision_id == "r2"
    assert new_block.text in excerpt.text
    assert [loc.page for loc in excerpt.locations if loc.block_id == block.id] == [2, 3]
    # A passage from another revision is not found: the whole matched unit is highlighted.
    stale = resolver.resolve([block.id], passage=block.text)
    assert _spans(stale, stale.highlights) == [new_block.text]
    # Hits of another revision are refused.
    old_chunk = next(c for c in chunk_revision(REVISIONS[book]).children if block.id in c.block_ids)
    with pytest.raises(ExcerptError, match="does not belong"):
        resolver.resolve_hit(old_chunk)


def test_search_hit_and_ranked_hit_inputs() -> None:
    book = "book-en"
    chunk = next(c for c in chunk_revision(REVISIONS[book]).children if c.section_id is not None)
    hit = SearchHit(
        chunk_id=chunk.id,
        document_id=chunk.document_id,
        revision_id=chunk.revision_id,
        section_id=chunk.section_id,
        mode=SearchMode.HYBRID,
        score_type=ScoreType.RRF,
        score=0.5,
        rank=1,
        passage=chunk.content,
        locations=chunk.locations,
    )
    resolver = _resolver(book)
    from_chunk = resolver.resolve_hit(chunk, query="water")
    assert resolver.resolve_hit(hit, query="water") == from_chunk
    assert resolver.resolve_hit(RankedHit(hit=hit, chunk=chunk), query="water") == from_chunk


def test_unknown_blocks_and_bad_config_are_refused() -> None:
    resolver = _resolver("book-ko")
    with pytest.raises(ExcerptError, match="unknown block"):
        resolver.resolve(["cb-nope"])
    with pytest.raises(ExcerptError, match="at least one"):
        resolver.resolve([])
    with pytest.raises(ValueError, match="max_chars"):
        ExcerptConfig(max_chars=0)
    with pytest.raises(ValueError, match="context_before"):
        ExcerptConfig(context_before=-1)


@pytest.mark.parametrize("book", BOOKS)
def test_excerpts_are_deterministic_and_round_trip(book: str) -> None:
    query = next(q["query"] for q in SEED if q["language"] == ("ko" if book == "book-ko" else "en"))
    chunks = chunk_revision(REVISIONS[book], config=SMALL).children
    first = [_resolver(book).resolve_hit(c, query=query) for c in chunks]
    again = [
        ExcerptResolver(_revision(book), document_title=_truth(book).title).resolve_hit(
            c, query=query
        )
        for c in chunks
    ]
    assert first == again
    for excerpt, chunk in zip(first, chunks, strict=True):
        assert Excerpt.model_validate_json(excerpt.model_dump_json()) == excerpt
        assert excerpt.highlights
        assert set(chunk.block_ids) & set(excerpt.block_ids) or not excerpt.text
        assert excerpt.primary_location in excerpt.locations


def test_excerpt_contract_checks() -> None:
    loc = SourceLocation(page=1, block_id="b1")
    base = {
        "document_id": "d",
        "revision_id": "r",
        "text": "text",
        "block_ids": ("b1",),
        "locations": (loc,),
    }
    assert Excerpt.model_validate({**base, "matched_block_ids": ("b1",), "primary_location": loc})
    with pytest.raises(ValidationError, match="matched blocks"):
        Excerpt.model_validate({**base, "matched_block_ids": ("b2",)})
    with pytest.raises(ValidationError, match="primary location"):
        Excerpt.model_validate({**base, "primary_location": SourceLocation(page=2)})
    with pytest.raises(ValidationError, match="exceeds"):
        Excerpt.model_validate({**base, "term_highlights": (TextSpan(start=0, end=9),)})


# --- real models -------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def docling_revisions() -> dict[str, DocumentRevision]:
    from book_core.parser.docling_adapter import DoclingParser

    parser = DoclingParser()
    return {
        book: publish(
            build_revision(
                parser.parse(OUT_DIR / f"{book}.pdf"), document_id=book, revision_id="r1"
            ).revision
        )
        for book in BOOKS
    }


@pytest.mark.models
@pytest.mark.parametrize("book", BOOKS)
def test_excerpts_contain_truth_paragraphs_on_docling(
    book: str, docling_revisions: dict[str, DocumentRevision]
) -> None:
    """For every seed query's relevant section in this book, the excerpt of each child chunk
    holding a truth paragraph contains that whole paragraph, on the truth pages."""
    revision = docling_revisions[book]
    truth = _truth(book)
    titles = {s.id: s.title for s in truth.sections}
    resolver = ExcerptResolver(revision, document_title=truth.title)
    children = chunk_revision(revision, document_title=truth.title, config=SMALL).children
    sections = {_loose(s.title): s.id for s in revision.sections}
    checked = 0
    for query in SEED:
        for relevant in query["relevant"]:
            if relevant["fixture_id"] != book:
                continue
            section_id = sections[_loose(titles[relevant["section_id"]])]
            terms = 0
            paragraphs = [
                b
                for b in truth.blocks
                if b.section_id == relevant["section_id"] and b.type is BlockType.TEXT
            ]
            for paragraph in paragraphs:
                head = _loose(split_sentences(paragraph.text)[0])[:24]
                holders = [
                    c for c in children if c.section_id == section_id and head in _loose(c.content)
                ]
                assert holders, (query["id"], paragraph.id)
                excerpt = resolver.resolve_hit(holders[0], query=query["query"])
                assert _loose(paragraph.text) in _loose(excerpt.text), (query["id"], paragraph.id)
                pages = {loc.page for loc in excerpt.locations}
                assert {part.page for part in paragraph.parts} <= pages
                assert excerpt.highlights
                terms += len(excerpt.term_highlights)
                checked += 1
            if query["language"] == truth.language:
                assert terms, query["id"]
    assert checked >= 6
