"""Question content fingerprint used for duplicate detection (M6.1)."""

from __future__ import annotations

from book_core.contracts import QuestionOption, QuestionType
from book_core.question import question_fingerprint

OPTIONS = (
    QuestionOption(id="opt-1", text="증발"),
    QuestionOption(id="opt-2", text="응결"),
    QuestionOption(id="opt-3", text="융해"),
)


def fp(**overrides: object) -> str:
    args: dict[str, object] = {
        "question_type": QuestionType.MCQ,
        "stem": "수증기가 물방울로 변하는 현상은?",
        "options": OPTIONS,
        "correct_option_ids": ("opt-2",),
    }
    args.update(overrides)
    return question_fingerprint(**args)  # type: ignore[arg-type]


def test_fingerprint_is_a_stable_sha256() -> None:
    value = fp()
    assert len(value) == 64
    assert value == fp()
    # Pinned: stored fingerprints must stay comparable across releases (bump
    # FINGERPRINT_VERSION when the canonical form changes).
    assert value == "83a729c5fe63d7840dc3680108b2069f3f04627905a105d3db28cd60ce0ed19c"


def test_ids_order_spacing_width_and_case_do_not_matter() -> None:
    renamed = tuple(
        QuestionOption(id=f"x{n}", text=o.text) for n, o in enumerate(reversed(OPTIONS))
    )
    assert fp(options=renamed, correct_option_ids=("x1",)) == fp()
    fullwidth_question_mark = "\uff1f"
    assert fp(stem=f" 수증기가  물방울로\n변하는 현상은{fullwidth_question_mark} ") == fp()
    latin = (QuestionOption(id="a", text="Water"), QuestionOption(id="b", text="Ice"))
    upper = (QuestionOption(id="a", text="WATER"), QuestionOption(id="b", text="ice"))
    assert fp(options=latin, correct_option_ids=("a",)) == fp(
        options=upper, correct_option_ids=("a",)
    )


def test_content_and_answer_changes_matter() -> None:
    base = fp()
    assert fp(stem="물방울이 수증기로 변하는 현상은?") != base
    assert fp(correct_option_ids=("opt-1",)) != base
    assert fp(correct_option_ids=("opt-1", "opt-2")) != base
    assert fp(correct_option_ids=None) != base
    assert fp(correct_option_ids=()) != fp(correct_option_ids=None)
    assert fp(options=(*OPTIONS, QuestionOption(id="opt-4", text="승화"))) != base
    assert fp(question_type=QuestionType.SHORT_ANSWER, options=(), correct_option_ids=None) != (
        fp(question_type=QuestionType.ESSAY, options=(), correct_option_ids=None)
    )


def test_accepted_answers_are_a_set() -> None:
    def short(*answers: str) -> str:
        return fp(
            question_type=QuestionType.SHORT_ANSWER,
            options=(),
            correct_option_ids=None,
            accepted_answers=answers,
        )

    assert short("응결", "응축") == short("응축", " 응결 ", "응결")
    assert short("응결") != short("응축")


def test_unknown_correct_ids_are_ignored() -> None:
    assert fp(correct_option_ids=("opt-2", "missing")) == fp()
