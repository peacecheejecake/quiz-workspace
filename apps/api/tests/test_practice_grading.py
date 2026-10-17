"""M5.2 grading and shuffling rules (docs/questions.md §4, tests/e2e/fixtures/questions.ts A11)."""

from __future__ import annotations

import pytest
from quiz_api.practice_grading import (
    grade_mcq,
    grade_short_answer,
    new_shuffle_seed,
    normalize_answer,
    shuffled_option_ids,
)

IDS = ["opt-1", "opt-2", "opt-3", "opt-4"]


def test_shuffle_is_a_reproducible_permutation() -> None:
    orders = set()
    for _ in range(200):
        seed = new_shuffle_seed()
        assert 0 <= seed < 2**63
        order = shuffled_option_ids(IDS, seed)
        assert sorted(order) == IDS
        assert shuffled_option_ids(IDS, seed) == order
        orders.add(tuple(order))
    assert len(orders) > 1
    assert IDS == ["opt-1", "opt-2", "opt-3", "opt-4"]  # input untouched


@pytest.mark.parametrize(
    ("selected", "correct", "expected"),
    [
        (["opt-2"], ["opt-2"], "correct"),
        (["opt-1"], ["opt-2"], "incorrect"),
        (["opt-3", "opt-1"], ["opt-1", "opt-3"], "correct"),
        (["opt-1"], ["opt-1", "opt-3"], "incorrect"),
        (["opt-1", "opt-2", "opt-3"], ["opt-1", "opt-3"], "incorrect"),
        (["opt-1"], None, "pending"),
        (["opt-1"], [], "pending"),
    ],
)
def test_mcq_is_graded_by_id_set_equality(
    selected: list[str], correct: list[str] | None, expected: str
) -> None:
    assert grade_mcq(selected, correct) == expected


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("Evaporation", "correct"),
        ("  EVAPORATION  ", "correct"),
        ("".join(chr(ord(c) + 0xFEE0) for c in "evaporation"), "correct"),
        ("증발", "correct"),
        (" 증발\n", "correct"),
        ("water   cycle", "correct"),
        ("Water\tCycle", "correct"),
        ("STRASSE", "correct"),  # casefold: ß == ss
        ("응결", "incorrect"),
        ("evaporat", "incorrect"),
        ("", "incorrect"),
    ],
)
def test_short_answers_are_normalized(given: str, expected: str) -> None:
    accepted = ["Evaporation", "증발", "water cycle", "Straße"]
    assert grade_short_answer(given, accepted) == expected


def test_short_answer_without_accepted_answers_is_pending() -> None:
    assert grade_short_answer("anything", None) == "pending"
    assert grade_short_answer("anything", []) == "pending"


def test_normalize_answer() -> None:
    assert normalize_answer("  \uff21\u3000B\n\nc ") == "a b c"
    # Decomposed Hangul jamo compose under NFKC.
    assert normalize_answer("\u1112\u1161\u11ab") == "\ud55c"
