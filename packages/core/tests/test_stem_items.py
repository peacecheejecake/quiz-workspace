"""Stem item lists (questions.md §4 11, STEM-ITEMS): which labels start an item line."""

from __future__ import annotations

import pytest
from book_core.question import break_stem_items, leading_item_families, stem_item_starts


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "옳은 것만 묶인 것은? ( ) (가) 갑 (나) 을 (다) 병 (라) 정",
            "옳은 것만 묶인 것은? ( )\n\n(가) 갑\n(나) 을\n(다) 병\n(라) 정",
        ),
        ("옳은 것은? ㄱ. 갑 ㄴ. 을 ㄷ. 병", "옳은 것은?\n\nㄱ. 갑\nㄴ. 을\nㄷ. 병"),
        ("옳은 것은? ㄱ) 갑 ㄴ) 을", "옳은 것은?\n\nㄱ) 갑\nㄴ) 을"),
        (
            "옳은 것은? \uff08가\uff09 갑 \uff08나\uff09 을",
            "옳은 것은?\n\n\uff08가\uff09 갑\n\uff08나\uff09 을",
        ),
        ("옳은 것은? (A) 갑 (B) 을", "옳은 것은?\n\n(A) 갑\n(B) 을"),
        ("옳은 것은? a. 갑 b. 을", "옳은 것은?\n\na. 갑\nb. 을"),
        ("옳은 것은? I. 갑 II. 을 III. 병", "옳은 것은?\n\nI. 갑\nII. 을\nIII. 병"),
        ("옳은 것은? \u2160. 갑 \u2161. 을", "옳은 것은?\n\n\u2160. 갑\n\u2161. 을"),
        ("옳은 것은? (1) 갑 (2) 을", "옳은 것은?\n\n(1) 갑\n(2) 을"),
        ("옳은 것은? 1) 갑 2) 을", "옳은 것은?\n\n1) 갑\n2) 을"),
        ("옳은 것은? ㉠ 갑 ㉡ 을", "옳은 것은?\n\n㉠ 갑\n㉡ 을"),
        ("옳은 것은? ㉮ 갑 ㉯ 을", "옳은 것은?\n\n㉮ 갑\n㉯ 을"),
        ("옳은 것은? ⑴ 갑 ⑵ 을", "옳은 것은?\n\n⑴ 갑\n⑵ 을"),
        ("옳은 것은? ⒜ 갑 ⒝ 을", "옳은 것은?\n\n⒜ 갑\n⒝ 을"),
        ("옳은 것은? ⓐ 갑 ⓑ 을", "옳은 것은?\n\nⓐ 갑\nⓑ 을"),
        ("다음을 보라: (가) 갑 (나) 을", "다음을 보라:\n\n(가) 갑\n(나) 을"),
        ("「갑」 (가) 갑 (나) 을", "「갑」\n\n(가) 갑\n(나) 을"),
        ("(가) 갑 (나) 을", "(가) 갑\n(나) 을"),
        # A wrapped item keeps its continuation on the same line.
        ("옳은 것은? ( 가 ) 갑 ( 나 ) 을", "옳은 것은?\n\n( 가 ) 갑\n( 나 ) 을"),
        ("옳은 것은? (가 ) 갑 ( 나) 을", "옳은 것은?\n\n(가 ) 갑\n( 나) 을"),
        (
            "옳은 것은? (가) 갑은 길어서 다음 줄로 이어진다. (나) 을",
            "옳은 것은?\n\n(가) 갑은 길어서 다음 줄로 이어진다.\n(나) 을",
        ),
    ],
)
def test_item_lists_break_before_each_label(text: str, expected: str) -> None:
    assert break_stem_items(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "(가)와 (나)에 들어갈 말로 옳은 것은?",
        "빈칸 (가)에 들어갈 말은? (가)",
        "다음 글의 (가) 시기와 (나) 시기에 대한 설명으로 옳은 것은?",
        "옳은 것은? ① 갑 ② 을 ③ 병",
        "옳은 것은? ❶ 갑 ❷ 을",
        "옳은 것은? ➀ 갑 ➁ 을",
        "옳은 것은? 1. 갑 2. 을",
        "옳은 것은? (가) 갑",
        "옳은 것은? (나) 갑 (다) 을",
        "옳은 것은? (가) 갑 나. 을",
        "옳은 것은? (가) 갑 (다) 을",
        # Interrupted lists (missing, skipped, swapped, another format): no line breaks at all.
        "옳은 것은? (가) 갑 (다) 병 (나) 을",
        "옳은 것은? (가) 갑 (나) 을 (라) 정",
        "옳은 것은? (가) 갑 (나) 을 (나) 병",
        "옳은 것은? (가) 갑 나. 을 (나) 병",
        "옳은 것은? ㄱ. 갑 ㄴ) 을 ㄴ. 병",
        "옳은 것은 (가) 갑 (나) 을",
        "옳은 것은? (가)갑 (나)을",
        "물이 기체가 되는 과정은?",
    ],
)
def test_mentions_option_labels_and_broken_sequences_are_not_item_lists(text: str) -> None:
    assert stem_item_starts(text) == []
    assert break_stem_items(text) == text


def test_option_lines_naming_items_are_recognised_leniently() -> None:
    assert leading_item_families("(가), (나)") == {"hangul"}
    assert leading_item_families("( 가 ) 갑은 을이다.") == {"hangul"}
    assert leading_item_families("ㄱ, ㄴ") == {"jamo"}
    assert leading_item_families("ㄷ") == {"jamo"}
    assert leading_item_families("ㄱ. 갑") == {"jamo"}
    assert leading_item_families("㉠ 갑") == {"circled-jamo"}
    assert leading_item_families("ㄱ에 대한 설명") == frozenset()
    assert leading_item_families("① 갑") == frozenset()
    assert leading_item_families("A man walks") == frozenset()
