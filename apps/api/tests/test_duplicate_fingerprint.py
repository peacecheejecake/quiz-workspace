"""UX7-DEDUP duplicate fingerprint (docs/questions.md §10.1): what counts as the same question."""

from __future__ import annotations

import pytest
from quiz_api.question_fingerprint import (
    answer_key,
    fingerprint,
    model_answer_of,
    normalize_option,
    normalize_stem,
)

STEM = "다음 중 물의 순환에 대한 설명으로 옳은 것은?"
OPTIONS = ["증발은 액체가 기체로 변하는 현상이다", "응결은 기체가 고체로 변한다", "강수는 없다"]


def mcq(stem: str = STEM, options: list[str] | None = None, kind: str = "MCQ") -> str:
    return fingerprint(kind, stem, OPTIONS if options is None else options)


@pytest.mark.parametrize(
    "label",
    [
        "①",
        "② ",
        "⑴ ",
        "⒜",
        "Ⓐ ",
        "㉠ ",
        "❶",
        "➀ ",
        "1)",
        "1. ",
        "(1) ",
        "A.",
        "a) ",
        "(B)",
        "ㄱ. ",
        "ㄴ)",
        "(ㄷ) ",
        "가. ",
        "나)",
        "(다) ",
        "（1）",  # noqa: RUF001
        "1．",  # noqa: RUF001
        "  3 ) ",
    ],
)
def test_option_labels_are_stripped(label: str) -> None:
    assert normalize_option(f"{label}증발") == "증발"


@pytest.mark.parametrize("text", ["1.5", "2,000", "0.25배", "3.14"])
def test_decimals_are_not_labels(text: str) -> None:
    assert normalize_option(text) == text


def test_decimal_options_stay_distinct() -> None:
    assert mcq(options=["1.5", "2"]) != mcq(options=["15", "2"])
    assert mcq(options=["1.5", "2"]) != mcq(options=["5", "2"])


def test_an_option_that_is_only_a_label_keeps_its_text() -> None:
    assert normalize_option("①") != ""
    assert normalize_option("A.") != ""


@pytest.mark.parametrize(
    "prefix",
    ["12. ", "12) ", "(12) ", "Q12. ", "q 3) ", "문 12. ", "문제 12. ", "문제12)", "７．"],  # noqa: RUF001
)
def test_leading_question_numbers_are_part_of_the_stem(prefix: str) -> None:
    """User decision 2026-11-01 (UX7-DEDUP-2): nothing of the question asked is ignored, so a
    stem with a leading number is another question than the same stem without it."""
    assert normalize_stem(f"{prefix}{STEM}") != normalize_stem(STEM)
    assert mcq(stem=f"{prefix}{STEM}") != mcq()


def test_a_numbered_stem_is_not_a_duplicate_of_the_unnumbered_one() -> None:
    assert mcq(stem=f"12. {STEM}") != mcq(stem=STEM)
    # The same number on both, restyled otherwise, is still the same question.
    assert mcq(stem=f"12. {STEM}") == mcq(stem=f"12.  {STEM.replace(' ', '  ')} ( )")


@pytest.mark.parametrize("stem", ["문제 3에서 구한 값은?", "1.5배가 되는 값은?", "2024년의 값은?"])
def test_numbers_that_belong_to_the_stem_stay(stem: str) -> None:
    other = stem.replace("3", "4").replace("1.5", "2.5").replace("2024", "2025")
    assert normalize_stem(stem) != normalize_stem(other)


@pytest.mark.parametrize(
    "variant",
    [
        "다음 중 물의 순환에 대한 설명으로 옳은 것은? ( )",
        "다음 중 물의 순환에 대한 설명으로 옳은 것은?(   )",
        "다음 중 물의 순환에 대한 설명으로 옳은 것은 [ ]",
        "다음 중 물의 순환에 대한 설명으로 옳은 것은? (____)",
        "다음 중 물의 순환에 대한 설명으로 옳은 것은？（ ）",  # noqa: RUF001
        "다음중  물의순환에 대한 설명으로\n옳은 것은?",
        "다음 중, 물의 순환에 대한 설명으로 옳은 것은…",
        "“다음 중 물의 순환에 대한 설명으로 옳은 것은?”",
    ],
)
def test_whitespace_punctuation_and_empty_answer_marks_do_not_matter(variant: str) -> None:
    assert mcq(stem=variant) == mcq()


def test_option_order_and_labels_do_not_matter() -> None:
    labelled = [f"{label} {text}" for label, text in zip("③①②", reversed(OPTIONS), strict=True)]
    assert mcq(options=labelled) == mcq()
    assert mcq(options=[f"({chr(65 + i)}) {t}" for i, t in enumerate(OPTIONS)]) == mcq()


def test_different_content_is_a_different_question() -> None:
    assert mcq(stem=STEM.replace("옳은", "옳지 않은")) != mcq()
    assert mcq(options=[*OPTIONS[:2], "강수는 있다"]) != mcq()
    assert mcq(options=OPTIONS[:2]) != mcq()
    assert mcq(options=[*OPTIONS, OPTIONS[0]]) != mcq()  # options are a multiset


def test_math_symbols_and_brackets_are_kept() -> None:
    assert normalize_stem("2+(-3)의 값은?") != normalize_stem("2+3의 값은?")
    assert mcq(options=["-1", "1"]) != mcq(options=["1", "1"])
    assert mcq(options=["x/2", "x"]) != mcq(options=["x2", "x"])


def test_case_is_kept() -> None:
    assert normalize_stem("Which is pH?") != normalize_stem("which is ph?")


def test_full_width_characters_are_folded() -> None:
    full_width = "\uff21\uff22\uff23\u3000\uff11\uff12\uff13의 값"
    assert normalize_stem(full_width) == normalize_stem("ABC 123의 값")


def test_type_is_part_of_the_question() -> None:
    assert fingerprint("SHORT_ANSWER", STEM, []) != fingerprint("ESSAY", STEM, [])
    assert fingerprint("SHORT_ANSWER", STEM, []) == fingerprint("SHORT_ANSWER", f"{STEM} ( )", [])


def test_fingerprint_is_stable() -> None:
    assert mcq() == mcq()
    assert len(mcq()) == 64
    assert fingerprint("ESSAY", "설명하시오", []) == fingerprint("ESSAY", " 설명 하시오.", [])
    assert fingerprint("ESSAY", "설명하시오", []) != fingerprint("ESSAY", "1. 설명하시오.", [])


def test_answer_key() -> None:
    options = [("o1", "① 증발"), ("o2", "② 응결")]
    assert answer_key(options, ["o1"], None) == ("증발",)
    assert answer_key([("x", "증발"), ("y", "응결")], ["x"], None) == ("증발",)
    assert answer_key(options, ["o2"], None) != answer_key(options, ["o1"], None)
    assert answer_key([], None, ["물", " 물 "]) == ("물",)
    assert answer_key([], None, None) is None
    assert answer_key(options, None, None) is None


# --- user decision 2026-11-01: short answer / essay = stem + model answer --------------------


def test_short_answers_compare_their_accepted_answers() -> None:
    stem = "물이 기체로 변하는 현상은?"
    same = fingerprint("SHORT_ANSWER", stem, [], model_answer_of("SHORT_ANSWER", ["증발"], None))
    assert same == fingerprint(
        "SHORT_ANSWER",
        f"{stem} ( )",
        [],
        model_answer_of("SHORT_ANSWER", [" 증 발.", "증발"], None),
    )
    assert same != fingerprint(
        "SHORT_ANSWER", stem, [], model_answer_of("SHORT_ANSWER", ["응결"], None)
    )
    assert same != fingerprint(
        "SHORT_ANSWER", stem, [], model_answer_of("SHORT_ANSWER", None, None)
    )


def test_essays_compare_their_model_answer() -> None:
    stem = "물의 순환을 설명하시오."
    model = "증발, 응결, 강수가 반복된다."
    same = fingerprint("ESSAY", stem, [], model_answer_of("ESSAY", None, model))
    assert same == fingerprint(
        "ESSAY", stem, [], model_answer_of("ESSAY", None, "증발 응결 강수가  반복된다")
    )
    assert same != fingerprint("ESSAY", stem, [], model_answer_of("ESSAY", None, "다른 답"))
    assert same != fingerprint("ESSAY", stem, [], model_answer_of("ESSAY", None, None))


def test_mcq_answers_stay_out_of_the_fingerprint() -> None:
    assert model_answer_of("MCQ", ["x"], "y") == []
