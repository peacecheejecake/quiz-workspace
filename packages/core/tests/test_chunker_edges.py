"""Chunker edge cases on revisions built in code, plus tokenizer/sentence/contract units (M1.4)."""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass

import pytest
from book_core.chunker import (
    ApproxTokenizer,
    ChunkerConfig,
    ChunkingError,
    Tokenizer,
    bound_breadcrumb,
    chunk_revision,
    detect_language,
    diff_chunks,
    oversized_spans,
    split_oversized,
    split_sentences,
)
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    ChunkLevel,
    DocumentRevision,
    SearchChunk,
    Section,
    SourceLocation,
    TableContent,
)

SHA = "0" * 64
TOK = ApproxTokenizer()
KO_SENTENCES = [
    f"{n}번째 문장에서 물은 바다와 대기 사이를 이동하며 형태를 바꾼다." for n in range(1, 31)
]
LONG_KO = " ".join(KO_SENTENCES)


@dataclass
class B:
    type: BlockType
    text: str
    section: str | None
    pages: tuple[int, ...] = (1,)
    table: TableContent | None = None
    caption: str | None = None


def _revision(
    blocks: list[B], sections: list[Section] | None = None, revision_id: str = "r1"
) -> DocumentRevision:
    sections = sections or [Section(id="s1", title="1장 시험", level=1)]
    return DocumentRevision(
        document_id="doc",
        revision_id=revision_id,
        revision_number=1,
        source_sha256=SHA,
        sections=tuple(sections),
        blocks=tuple(
            Block(
                id=f"b{i}",
                type=b.type,
                text=b.text,
                section_id=b.section,
                table=b.table,
                caption_block_id=b.caption,
                heading_level=1 if b.type is BlockType.HEADING else None,
                locations=tuple(
                    SourceLocation(
                        page=p, bbox=BBox(x0=60, y0=100 + i, x1=500, y1=140 + i), block_id=f"b{i}"
                    )
                    for p in b.pages
                ),
                ordinal=i,
            )
            for i, b in enumerate(blocks)
        ),
    )


def _covered(result_children: tuple[SearchChunk, ...]) -> set[str]:
    return {b for c in result_children for b in c.block_ids}


def test_very_long_paragraph_is_split_at_korean_sentences_with_overlap() -> None:
    config = ChunkerConfig(target_tokens=120, max_tokens=160, overlap_tokens=40)
    revision = _revision([B(BlockType.HEADING, "1장 시험", "s1"), B(BlockType.TEXT, LONG_KO, "s1")])
    result = chunk_revision(revision, config=config)
    pieces = result.children
    assert len(pieces) > 3
    assert pieces[0].block_ids == ("b0", "b1")  # the heading leads the first window
    assert all(c.block_ids == ("b1",) for c in pieces[1:])
    for piece in pieces:
        assert piece.token_count is not None
        assert piece.token_count <= config.max_tokens
        body = piece.content.split("\n\n")[-1]
        assert set(split_sentences(body)) <= set(KO_SENTENCES)  # whole sentences only
    # Consecutive windows share their boundary sentence (overlap within the block).
    for prev, nxt in itertools.pairwise(pieces):
        assert split_sentences(prev.content)[-1] == split_sentences(nxt.content)[0]
    seen = {s for c in pieces for s in split_sentences(c.content.split("\n\n")[-1])}
    assert seen == set(KO_SENTENCES)
    # Parent context holds the paragraph once, without the overlap duplicates.
    (parent,) = result.parents
    assert parent.content == f"1장 시험\n\n{LONG_KO}"
    assert len({c.id for c in pieces}) == len(pieces)


def test_no_overlap_and_unpunctuated_text_falls_back_to_words_and_characters() -> None:
    config = ChunkerConfig(target_tokens=40, max_tokens=60, overlap_tokens=0)
    words = " ".join(f"word{n}" for n in range(200))
    unspaced = "가" * 150
    revision = _revision([B(BlockType.TEXT, words, "s1"), B(BlockType.TEXT, unspaced, "s1")])
    result = chunk_revision(revision, config=config)
    word_pieces = [c for c in result.children if c.block_ids == ("b0",)]
    char_pieces = [c for c in result.children if c.block_ids == ("b1",)]
    assert " ".join(c.content for c in word_pieces) == words
    assert "".join(c.content for c in char_pieces) == unspaced
    assert all((c.token_count or 0) <= config.max_tokens for c in result.children)


def test_empty_sections_and_heading_only_sections() -> None:
    sections = [
        Section(id="s1", title="1장 빈 장", level=1, heading_block_id="b0"),
        Section(id="s1-1", title="1.1 제목만", level=2, parent_id="s1", heading_block_id="b1"),
        Section(id="s1-2", title="1.2 블록 없음", level=2, parent_id="s1"),
        Section(id="s2", title="2장 본문", level=1, heading_block_id="b2"),
    ]
    revision = _revision(
        [
            B(BlockType.HEADING, "1장 빈 장", "s1"),
            B(BlockType.HEADING, "1.1 제목만", "s1-1"),
            B(BlockType.HEADING, "2장 본문", "s2"),
            B(BlockType.TEXT, "본문 문장이다.", "s2"),
        ],
        sections,
    )
    result = chunk_revision(revision, document_title="책")
    by_section = {c.section_id: c for c in result.children}
    assert by_section["s1"].content == "1장 빈 장"
    assert by_section["s1-1"].breadcrumb == ("책", "1장 빈 장", "1.1 제목만")
    assert "s1-2" not in by_section  # a section without blocks has no chunks
    assert by_section["s2"].content == "2장 본문\n\n본문 문장이다."
    assert {p.section_id for p in result.parents} == {"s1", "s1-1", "s2"}
    assert _covered(result.children) == {"b0", "b1", "b2", "b3"}


def test_section_with_only_a_table_split_between_rows_with_header_repeated() -> None:
    rows = (("단계", "설명"), *((f"단계 {n}", f"설명 문장 {n} 입니다") for n in range(40)))
    table = TableContent(rows=rows, header_rows=1)
    text = "\n".join(" | ".join(r) for r in rows)
    revision = _revision(
        [
            B(BlockType.TEXT, "표 3. 단계 목록", "s1"),
            B(BlockType.TABLE, text, "s1", pages=(1, 2), table=table),
        ]
    )
    config = ChunkerConfig(target_tokens=60, max_tokens=80, overlap_tokens=10)
    result = chunk_revision(revision, config=config)
    parts = result.children
    assert len(parts) > 2
    assert parts[0].block_ids == ("b0", "b1")  # caption detected and kept with the table
    assert parts[0].content.startswith("표 3. 단계 목록\n단계 | 설명\n")
    body: list[str] = []
    for part in parts:
        lines = part.content.split("\n")
        if part is not parts[0]:
            assert part.block_ids == ("b1",)
            assert lines[0] == "단계 | 설명"
        table_lines = lines[1:] if part is not parts[0] else lines[2:]
        assert all(line in text.split("\n") for line in table_lines)
        body.extend(table_lines)
        assert (part.token_count or 0) <= config.max_tokens
        assert {loc.page for loc in part.locations} == {1, 2}
    assert body == [" | ".join(r) for r in rows[1:]]
    (parent,) = {c.parent_id for c in parts}
    assert result.parents[0].id == parent
    assert result.parents[0].content == f"표 3. 단계 목록\n{text}"


def test_oversized_table_row_stays_whole() -> None:
    rows = (("h",), ("x " * 300,), ("y",))
    table = TableContent(rows=rows, header_rows=1)
    revision = _revision(
        [B(BlockType.TABLE, "\n".join(r[0].strip() for r in rows), "s1", table=table)]
    )
    config = ChunkerConfig(target_tokens=40, max_tokens=60, overlap_tokens=0, parent_max_tokens=60)
    result = chunk_revision(revision, config=config)
    assert [c.content.split("\n")[1] for c in result.children] == ["x " * 300, "y"]
    assert all(c.content.startswith("h\n") for c in result.children)
    assert len(result.parents) == 2  # each part alone exceeds the parent budget


def test_figures_travel_with_captions_and_context() -> None:
    revision = _revision(
        [
            B(BlockType.TEXT, "앞 문단이다.", "s1"),
            B(BlockType.IMAGE, "", "s1", caption="b2"),
            B(BlockType.TEXT, "그림 1. 모식도", "s1"),
            B(BlockType.IMAGE, "", "s1"),  # uncaptioned, text-less: joins its neighbour
            B(BlockType.TEXT, "뒤 문단이다.", "s1"),
        ]
    )
    result = chunk_revision(revision)
    (child,) = result.children
    assert child.block_ids == ("b0", "b1", "b2", "b3", "b4")
    assert child.content == "앞 문단이다.\n\n그림 1. 모식도\n\n뒤 문단이다."


def test_text_less_section_is_reported_uncovered() -> None:
    sections = [Section(id="s1", title="1장", level=1), Section(id="s2", title="2장", level=1)]
    revision = _revision(
        [B(BlockType.TEXT, "본문이다.", "s1"), B(BlockType.IMAGE, "", "s2")], sections
    )
    result = chunk_revision(revision)
    assert result.uncovered_block_ids == ("b1",)
    assert _covered(result.children) == {"b0"}


def test_mixed_korean_english_text() -> None:
    text = (
        "Docling은 PDF를 구조화한다. 예를 들어 e.g. tables are kept whole. "
        "그 다음 Dr. Kim이 검토한다! Is it done? 그렇다."
    )
    assert split_sentences(text) == [
        "Docling은 PDF를 구조화한다.",
        "예를 들어 e.g. tables are kept whole.",
        "그 다음 Dr. Kim이 검토한다!",
        "Is it done?",
        "그렇다.",
    ]
    revision = _revision([B(BlockType.TEXT, text, "s1")])
    (child,) = chunk_revision(revision).children
    assert child.language == "ko"
    assert detect_language("Water is filtered through sand layers.") == "en"
    assert detect_language("물은 모래층을 통과하며 걸러진다.") == "ko"
    assert detect_language("12 | 34") is None


def test_front_matter_excluded_by_default_and_optional() -> None:
    revision = _revision(
        [
            B(BlockType.HEADING, "책 제목", None),
            B(BlockType.TEXT, "차례", None),
            B(BlockType.HEADING, "1장 시험", "s1"),
            B(BlockType.TEXT, "본문이다.", "s1"),
        ]
    )
    default = chunk_revision(revision, document_title="책 제목")
    assert _covered(default.children) == {"b2", "b3"}
    included = chunk_revision(
        revision, document_title="책 제목", config=ChunkerConfig(include_front_matter=True)
    )
    front = [c for c in included.chunks if c.section_id is None]
    assert {c.level for c in front} == {ChunkLevel.PARENT, ChunkLevel.CHILD}
    assert _covered(included.children) == {"b0", "b1", "b2", "b3"}
    assert all(c.breadcrumb == ("책 제목",) for c in front)
    untitled = chunk_revision(revision, config=ChunkerConfig(include_front_matter=True))
    assert (
        next(c for c in untitled.children if c.section_id is None).search_text == "책 제목\n\n차례"
    )


def test_diff_reports_removed_children_and_their_surviving_parent() -> None:
    blocks = [B(BlockType.TEXT, f"{n}번 문단이다.", "s1") for n in range(3)]
    base = chunk_revision(_revision(blocks))
    fewer = chunk_revision(_revision(blocks[:2]))
    diff = diff_chunks(base.chunks, fewer.chunks)
    # Packing changes the single child (b0,b1,b2) -> (b0,b1): new ids on both levels.
    assert diff.removed
    assert diff.added
    assert diff.affected_parent_ids == tuple(p.id for p in fewer.parents)
    assert diff_chunks(base.chunks, base.chunks).is_empty


def test_config_validation() -> None:
    with pytest.raises(ValueError, match="target_tokens"):
        ChunkerConfig(target_tokens=500, max_tokens=400)
    with pytest.raises(ValueError, match="overlap"):
        ChunkerConfig(target_tokens=100, max_tokens=200, overlap_tokens=100)
    with pytest.raises(ValueError, match="parent_max"):
        ChunkerConfig(max_tokens=400, parent_max_tokens=300)


def test_approx_tokenizer_is_cjk_aware() -> None:
    assert isinstance(TOK, Tokenizer)
    assert TOK.count("") == 0
    assert TOK.count("물의 순환") == 4  # one per Hangul syllable
    assert TOK.count("water cycle") == 4  # 1 per started 4 letters
    assert TOK.count("2024년, 30%") == 2 + 1 + 1 + 1 + 1
    assert TOK.count("물의 순환 water") == TOK.count("물의 순환") + TOK.count("water")
    with pytest.raises(ValueError, match="chars_per_token"):
        ApproxTokenizer(chars_per_token=0)


def test_split_oversized_respects_budget() -> None:
    pieces = split_oversized("alpha beta gamma delta " * 10, 8, TOK)
    assert all(TOK.count(p) <= 8 for p in pieces)
    assert " ".join(pieces) == ("alpha beta gamma delta " * 10).strip()


def test_contract_rejects_parent_with_parent() -> None:
    chunk = chunk_revision(_revision([B(BlockType.TEXT, "본문이다.", "s1")])).parents[0]
    data = chunk.model_dump()
    with pytest.raises(ValueError, match="parent chunks cannot have a parent"):
        SearchChunk.model_validate({**data, "parent_id": "other"})
    legacy = {k: v for k, v in data.items() if k not in {"level", "ordinal", "token_count"}}
    legacy.pop("breadcrumb")
    assert SearchChunk.model_validate(legacy).level is ChunkLevel.CHILD  # additive defaults


# -- regressions (M1.4 review) ------------------------------------------------------------------


def test_split_paragraph_spanning_parents_keeps_context_in_each_parent() -> None:
    config = ChunkerConfig(
        target_tokens=120, max_tokens=160, overlap_tokens=40, parent_max_tokens=300
    )
    revision = _revision([B(BlockType.TEXT, LONG_KO, "s1")])
    result = chunk_revision(revision, config=config)
    assert len(result.parents) > 2
    for parent in result.parents:
        kids = [c for c in result.children if c.parent_id == parent.id]
        # The parent is one verbatim slice of the paragraph, starting where its first child
        # starts (overlap included) and ending where its last child ends.
        assert parent.content in LONG_KO
        assert parent.content.startswith(kids[0].content)
        assert parent.content.endswith(kids[-1].content)
        assert all(c.content in parent.content for c in kids)
        sentences = split_sentences(parent.content)
        assert len(sentences) == len(set(sentences))  # overlap not repeated inside a parent
        assert (parent.token_count or 0) <= config.parent_max_tokens
    # A later parent starts with its first child's overlap sentence, which the previous
    # parent also holds.
    first, second = result.parents[:2]
    assert split_sentences(second.content)[0] in split_sentences(first.content)


def test_split_table_spanning_parents_repeats_header_once_per_parent() -> None:
    rows = (("단계", "설명"), *((f"단계 {n}", f"설명 문장 {n} 입니다") for n in range(60)))
    table = TableContent(rows=rows, header_rows=1)
    text = "\n".join(" | ".join(r) for r in rows)
    revision = _revision(
        [B(BlockType.TEXT, "표 3. 단계 목록", "s1"), B(BlockType.TABLE, text, "s1", table=table)]
    )
    config = ChunkerConfig(
        target_tokens=60, max_tokens=80, overlap_tokens=10, parent_max_tokens=160
    )
    result = chunk_revision(revision, config=config)
    assert len(result.parents) > 2
    body: list[str] = []
    for n, parent in enumerate(result.parents):
        lines = parent.content.split("\n")
        if n == 0:
            assert lines[0] == "표 3. 단계 목록"
            lines = lines[1:]
        assert lines[0] == "단계 | 설명"  # every parent has the column header ...
        assert lines.count("단계 | 설명") == 1  # ... exactly once
        body.extend(lines[1:])
        assert (parent.token_count or 0) <= config.parent_max_tokens
    assert body == [" | ".join(r) for r in rows[1:]]


@pytest.mark.parametrize(
    "text",
    [
        "가" * 150,
        "물의순환은" * 40 + " 그리고 끝.",
        "See https://example.com/" + "a1b2" * 120 + "?q=1 for details. Then stop.",
    ],
)
@pytest.mark.parametrize("overlap", [0, 8])
def test_character_splits_reconstruct_the_canonical_text(text: str, overlap: int) -> None:
    config = ChunkerConfig(
        target_tokens=40, max_tokens=60, overlap_tokens=overlap, parent_max_tokens=4000
    )
    revision = _revision([B(BlockType.TEXT, text, "s1")])
    result = chunk_revision(revision, config=config)
    assert len(result.children) > 2
    (parent,) = result.parents
    assert parent.content == text  # byte-faithful, no inserted separators
    for child in result.children:
        assert child.content in text
        assert child.content == child.content.strip()
        assert (child.token_count or 0) <= config.max_tokens
    if overlap == 0:  # pieces tile the text exactly, up to the whitespace between them
        tiled = "".join(c.content for c in result.children)
        assert re.sub(r"\s+", "", tiled) == re.sub(r"\s+", "", text)


def test_oversized_spans_are_contiguous_slices() -> None:
    text = "앞말 " + "가" * 30 + " 뒷말"
    spans = oversized_spans(text, (0, len(text)), 8, TOK)
    assert all(TOK.count(text[s:e]) <= 8 for s, e in spans)
    assert text[spans[0][0] : spans[-1][1]] == text
    assert all(a[1] <= b[0] for a, b in itertools.pairwise(spans))
    assert "".join(text[s:e] for s, e in spans) == text.replace(" ", "")


def test_huge_breadcrumb_is_bounded_and_max_tokens_holds() -> None:
    sections = [
        Section(id="s1", title="장 " + "나" * 300, level=1),
        Section(id="s1-1", title="가" * 400, level=2, parent_id="s1"),
    ]
    revision = _revision(
        [B(BlockType.TEXT, LONG_KO, "s1-1"), B(BlockType.TEXT, "짧은 문단이다.", "s1-1")],
        sections,
    )
    config = ChunkerConfig()
    result = chunk_revision(revision, document_title="책 " * 200, config=config)
    budget = int(config.target_tokens * config.breadcrumb_max_share)
    for chunk in result.chunks:
        assert TOK.count(" > ".join(chunk.breadcrumb)) <= budget
        assert chunk.breadcrumb[-1].startswith("가")
        assert chunk.breadcrumb[-1].endswith("…")
    for child in result.children:
        assert child.token_count == TOK.count(child.search_text)
        assert child.token_count <= config.max_tokens
    assert {b for c in result.children for b in c.block_ids} == {"b0", "b1"}


def test_bound_breadcrumb_ellipsizes_longest_then_drops_outermost() -> None:
    crumb = ("Document title", "1장 " + "가" * 20, "1.1 짧은 절")
    assert bound_breadcrumb(crumb, 100, TOK) == crumb
    bounded = bound_breadcrumb(crumb, 20, TOK)
    assert TOK.count(" > ".join(bounded)) <= 20
    assert bounded[0] == "Document title"
    assert bounded[1].startswith("1장 가")
    assert bounded[1].endswith("…")
    assert bounded[2] == "1.1 짧은 절"
    tiny = bound_breadcrumb(crumb, 3, TOK)
    assert TOK.count(" > ".join(tiny)) <= 3
    assert tiny[-1].endswith("…")
    assert bound_breadcrumb(crumb, 0, TOK) == ()


class _NewlineHeavyTokenizer:
    """Not additive: a text with a line break costs double (search_text joins crumb + body)."""

    name = "newline-heavy"

    def count(self, text: str) -> int:
        n = TOK.count(text)
        return 2 * n if "\n" in text else n


def test_unmeetable_limit_raises_chunking_error() -> None:
    revision = _revision([B(BlockType.TEXT, LONG_KO, "s1")])
    with pytest.raises(ChunkingError, match="max_tokens"):
        chunk_revision(revision, tokenizer=_NewlineHeavyTokenizer())
    with pytest.raises(ValueError, match="breadcrumb_max_share"):
        ChunkerConfig(breadcrumb_max_share=1.0)
