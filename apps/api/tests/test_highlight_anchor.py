"""UX9-HL-B anchor rules (HILITE-01-C03/C05): blocks, the server-side cut, UTF-16 offsets and
re-anchoring, including the property that a relocated anchor only ever points at its quote."""

from __future__ import annotations

import random
import uuid

import pytest
from quiz_api.chapter_notes import Ref
from quiz_api.highlight_anchor import (
    CONTEXT_CHARS,
    Anchor,
    AnchorError,
    block_order,
    cut,
    explanation_blocks,
    note_blocks,
    overlaps,
    relocate,
    to_index,
    to_offset,
    utf16_length,
)

TEXT = "가나다 라마바 사아자"


def _anchor(blocks: dict[str, str], block: str, quote: str) -> Anchor:
    start = blocks[block].index(quote)
    return Anchor(
        block,
        to_offset(blocks[block], start),
        to_offset(blocks[block], start) + utf16_length(quote),
    )


def test_explanation_paragraphs_split_on_blank_lines_like_the_client() -> None:
    assert explanation_blocks("첫 문단\n둘째 줄\n\n  \n둘째 문단") == {
        "p0": "첫 문단\n둘째 줄",
        "p1": "둘째 문단",
    }
    assert explanation_blocks(None) == {}
    assert explanation_blocks("") == {}


def test_note_blocks_are_the_presented_items_without_footnote_tags() -> None:
    qid, rid = uuid.uuid4(), uuid.uuid4()
    refs = [Ref("Q1", qid, rid, "1장 1번")]
    body = {
        "sections": [
            {
                "heading": "A",
                "items": [{"text": "첫 항목", "tags": ["Q1"]}, {"text": "x", "tags": []}],
            },
            {"heading": "B", "items": [{"text": "둘째 장 항목", "tags": ["Q1"]}]},
        ]
    }
    # The untagged item is not presented, so it has no block (indices follow the rendered body).
    assert note_blocks(body, refs) == {"s0.i0": "첫 항목", "s1.i0": "둘째 장 항목"}


def test_hilite_01_c03_cut_takes_quote_and_32_characters_of_context() -> None:
    blocks = {"p0": "앞" * 40 + "인용" + "뒤" * 40}
    piece = cut(blocks, Anchor("p0", 40, 42))
    assert piece.quote == "인용"
    assert piece.prefix == "앞" * CONTEXT_CHARS
    assert piece.suffix == "뒤" * CONTEXT_CHARS
    short = cut({"p0": TEXT}, Anchor("p0", 4, 7))
    assert (short.quote, short.prefix, short.suffix) == ("라마바", "가나다 ", " 사아자")


@pytest.mark.parametrize(
    "anchor",
    [
        Anchor("p0", 3, 3),
        Anchor("p0", 5, 2),
        Anchor("p0", 0, len(TEXT) + 1),
        Anchor("p9", 0, 1),
        Anchor("s0.i0", 0, 1),
    ],
)
def test_hilite_01_c03_invalid_anchors_are_refused(anchor: Anchor) -> None:
    with pytest.raises(AnchorError):
        cut({"p0": TEXT}, anchor)


def test_hilite_01_c03_quotes_hold_at_most_2000_characters() -> None:
    blocks = {"p0": "가" * 2100}
    assert len(cut(blocks, Anchor("p0", 0, 2000)).quote) == 2000
    with pytest.raises(AnchorError):
        cut(blocks, Anchor("p0", 0, 2001))


def test_offsets_are_utf16_code_units() -> None:
    text = "a😀b"  # the emoji is two UTF-16 units
    assert utf16_length(text) == 4
    assert to_index(text, 3) == 2
    assert to_offset(text, 2) == 3
    with pytest.raises(AnchorError):
        to_index(text, 2)  # inside the surrogate pair
    assert cut({"p0": text}, Anchor("p0", 1, 4)).quote == "😀b"


def test_hilite_01_c05_relocation_follows_the_quote_and_its_context() -> None:
    original = Anchor("p0", 4, 7)
    piece = cut({"p0": TEXT}, original)
    found = relocate(
        explanation_blocks("가나다 (보충) 라마바 사아자"),
        original,
        piece.quote,
        piece.prefix,
        piece.suffix,
    )
    assert found == Anchor("p0", 9, 12)
    # The same quote twice: the one whose prefix/suffix match best.
    twice = explanation_blocks("라마바 앞 가나다 (보충) 라마바 사아자")
    assert relocate(twice, original, piece.quote, piece.prefix, piece.suffix) == Anchor(
        "p0", 15, 18
    )
    # Equal context: the one nearest the original position.
    tie = explanation_blocks("라마바 라마바")
    assert relocate(tie, Anchor("p0", 4, 7), "라마바", "", "") == Anchor("p0", 4, 7)
    # Moved to another paragraph.
    moved = explanation_blocks("새 문단\n\n가나다 라마바 사아자")
    assert relocate(moved, original, piece.quote, piece.prefix, piece.suffix) == Anchor("p1", 4, 7)
    # Gone.
    assert (
        relocate(explanation_blocks("가나다 사아자"), original, "라마바", "가나다 ", " 사아자")
        is None
    )


def test_overlaps_and_block_order() -> None:
    assert overlaps(Anchor("p0", 0, 3), Anchor("p0", 2, 5))
    assert not overlaps(Anchor("p0", 0, 3), Anchor("p0", 3, 5)), "touching ranges do not overlap"
    assert not overlaps(Anchor("p0", 0, 3), Anchor("p1", 0, 3))
    assert sorted(["s1.i0", "s0.i10", "s0.i2"], key=block_order) == ["s0.i2", "s0.i10", "s1.i0"]
    assert sorted(["p10", "p2"], key=block_order) == ["p2", "p10"]


ALPHABET = "가나다라마바 사아자\n😀ab"


def _random_text(rng: random.Random, n: int) -> str:
    return "".join(rng.choice(ALPHABET) for _ in range(n))


def _edit(rng: random.Random, text: str) -> str:
    for _ in range(rng.randint(1, 4)):
        op = rng.choice(("insert", "delete", "replace", "paragraph"))
        i = rng.randint(0, len(text))
        j = min(len(text), i + rng.randint(0, 6))
        if op == "insert":
            text = text[:i] + _random_text(rng, rng.randint(1, 5)) + text[i:]
        elif op == "delete":
            text = text[:i] + text[j:]
        elif op == "replace":
            text = text[:i] + _random_text(rng, j - i) + text[j:]
        else:
            text = text[:i] + "\n\n" + text[i:]
    return text


def test_hilite_01_c05_property_relocated_anchors_only_point_at_the_quote() -> None:
    rng = random.Random(20261103)  # noqa: S311 - a seeded test sequence
    relocated = missing = 0
    for _ in range(2000):
        original_text = _random_text(rng, rng.randint(5, 60))
        blocks = explanation_blocks(original_text)
        block = rng.choice(sorted(blocks))
        units = utf16_length(blocks[block])
        if units < 1:
            continue
        index_start = rng.randint(0, len(blocks[block]) - 1)
        index_end = rng.randint(index_start + 1, min(len(blocks[block]), index_start + 8))
        anchor = Anchor(
            block, to_offset(blocks[block], index_start), to_offset(blocks[block], index_end)
        )
        piece = cut(blocks, anchor)
        edited = explanation_blocks(_edit(rng, original_text))
        found = relocate(edited, anchor, piece.quote, piece.prefix, piece.suffix)
        if found is None:
            assert not any(piece.quote in t for t in edited.values()), "a present quote was missed"
            missing += 1
            continue
        relocated += 1
        assert cut(edited, found).quote == piece.quote
    assert relocated > 100
    assert missing > 100
    # Unchanged text: the anchor is found exactly where it was.
    blocks = {"p0": TEXT}
    anchor = _anchor(blocks, "p0", "라마바")
    piece = cut(blocks, anchor)
    assert relocate(blocks, anchor, piece.quote, piece.prefix, piece.suffix) == anchor
