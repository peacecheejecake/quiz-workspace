"""Stem item lists (questions.md §4 11, STEM-ITEMS): which labels start an item line."""

from __future__ import annotations

import pytest
from book_core.question import (
    break_stem_items,
    has_item_label,
    leading_item_families,
    stem_item_starts,
)


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
    assert has_item_label("옳은 것은 (가) 갑 (다) 을")
    assert not has_item_label("(가)와 (나)에 들어갈 말은?")


def test_ux11_range_bullets_and_passage() -> None:
    cases = [
        ("다음 (가) ~ (라)의 것은? ( ) (가) 첫째 (나) 둘째 (다) 셋째 (라) 넷째", 5),
        (
            "다음은? ( ) - 첫째 ( 가) 이내. - 둘째 ( 나)이 경과. "
            "- 셋째 ( 다)이다. - 넷째 ( 라) 이내.",
            5,
        ),
        (
            "주요 내용이다. ( )안에 맞는 것은? ( ) 카드사는 회원의 카드가 최종 이용일 이후 "
            "장기간 이용실적이 없는 경우 회원에게 의사를 확인하여야 합니다.",
            2,
        ),
    ]
    for text, count in cases:
        result = break_stem_items(text)
        assert len(result.splitlines()) - result.count("\n\n") == count
        assert "".join(result.split()) == "".join(text.split())
        assert break_stem_items(result) == result


def test_ux11_user_cases_preserve_text_and_are_idempotent() -> None:
    import json
    from pathlib import Path

    cases = json.loads((Path(__file__).parents[3] / "tests/fixtures/ux11-stem.json").read_text())
    for case, expected_lines in zip(cases, (5, 5, 2), strict=True):
        text = case["stem"]
        result = break_stem_items(text)
        assert len(result.splitlines()) - result.count("\n\n") == expected_lines
        assert "".join(result.split()) == "".join(text.split())
        assert break_stem_items(result) == result


@pytest.mark.parametrize(
    "text",
    [
        "온도는 - 10도에서 - 5도로 상승한다.",
        "온도는? ( ) - 10도에서 - 5도",
        "다음은 A - B 또는 C - D 범위이다.",
        "옳은 것은? ( ) 짧은 답",
        "이미 문단이다.\n\n다음 문단이다.",
        "옳은 것은? A. 첫째 I. 다른 항목 B. 둘째",
    ],
)
def test_ux11_near_counterexamples(text: str) -> None:
    assert break_stem_items(text) == text


def test_ux11_bullet_list_preserves_following_paragraph() -> None:
    text = "다음은? ( ) - 갑이다. - 을이다.\n\n위 내용을 참고하시오."
    expected = "다음은? ( )\n\n- 갑이다.\n- 을이다.\n\n위 내용을 참고하시오."
    assert break_stem_items(text) == expected
    assert break_stem_items(expected) == expected


def test_ux11_shared_bullet_parity_matrix() -> None:
    import json
    from pathlib import Path

    cases = json.loads((Path(__file__).parents[3] / "tests/fixtures/ux11-bullets.json").read_text())
    for case in cases:
        assert break_stem_items(case["stem"]) == case["normalized"]
        assert break_stem_items(case["normalized"]) == case["normalized"]


def test_ux11_shared_range_and_passage_boundaries() -> None:
    import json
    from pathlib import Path

    cases = json.loads(
        (Path(__file__).parents[3] / "tests/fixtures/ux11-boundaries.json").read_text()
    )
    for case in cases:
        result = break_stem_items(case["stem"])
        assert "".join(result.split()) == "".join(case["stem"].split())
        assert break_stem_items(result) == result
        if case["kind"] == "range":
            assert len(stem_item_starts(case["stem"])) == case["items"]
        else:
            assert result.startswith("서문입니다.\n\n옳은 것은? ( )\n\n카드사는")


def test_ux12_passage2_source_lines_of_list_items_keep_their_breaks() -> None:
    from book_core.extractor.segment import RawQuestion

    def stem(*parts: str) -> str:
        return RawQuestion(number=1, stem_lines=[], stem_parts=list(parts)).stem

    assert stem("두 항목의", "합계는?", "- 가람 항목 : 10 , 20", "- 누리 항목 : 30 , 40") == (
        "두 항목의 합계는?\n\n- 가람 항목 : 10 , 20\n- 누리 항목 : 30 , 40"
    )
    assert stem("합계는?", "- 가람 항목", "- 누리 항목은", "둘째 줄", "- 마루") == (
        "합계는?\n\n- 가람 항목\n- 누리 항목은 둘째 줄\n- 마루"
    )
    assert stem("합계는?", "∙ 가람", "∙누리") == "합계는?\n∙ 가람\n∙누리"
    # A wrapped line that opens with a hyphen glued to a word, or a number, goes on.
    assert stem("기간은 2023", "-01 부터 12", "% 이다.") == "기간은 2023 -01 부터 12 % 이다."
