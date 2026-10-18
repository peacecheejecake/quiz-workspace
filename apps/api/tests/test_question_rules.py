"""Question content rules (M4.2a): the API-side mirror of the question_revisions CHECKs."""

from __future__ import annotations

from dataclasses import replace

import pytest
from fastapi.exceptions import RequestValidationError
from quiz_api.question_rules import (
    QuestionContent,
    content_issues,
    opaque_id_valid,
    storable,
    transition_allowed,
    unstorable_strings,
    validate_content,
)

MCQ = QuestionContent(
    question_type="MCQ",
    stem="물이 기체로 변하는 과정은?",
    options=(("opt-1", "응결"), ("opt-2", "증발"), ("opt-3", "강수")),
    correct_option_ids=("opt-2",),
    is_multi_answer=False,
    accepted_answers=None,
    explanation=None,
    rubric=None,
)
SHORT = QuestionContent("SHORT_ANSWER", "여과 단계는?", (), None, False, ("여과",), None, None)
ESSAY = QuestionContent("ESSAY", "서술하시오.", (), None, False, None, None, "침투와 유출")


def locs(content: QuestionContent, status: str = "CONFIRMED") -> list[tuple[str | int, ...]]:
    return [tuple(i["loc"]) for i in content_issues(content, status).items]  # type: ignore[arg-type]


@pytest.mark.parametrize("content", [MCQ, SHORT, ESSAY, replace(SHORT, accepted_answers=None)])
def test_valid_content_passes(content: QuestionContent) -> None:
    assert locs(content) == []
    validate_content(content, "CONFIRMED")


@pytest.mark.parametrize(
    ("content", "loc"),
    [
        (replace(MCQ, correct_option_ids=None), ("body", "correct_option_ids")),
        (replace(MCQ, correct_option_ids=()), ("body", "correct_option_ids")),
        (replace(MCQ, correct_option_ids=("opt-9",)), ("body", "correct_option_ids", 0)),
        (replace(MCQ, correct_option_ids=("opt-1", "opt-2")), ("body", "correct_option_ids")),
        (replace(MCQ, options=(*MCQ.options, ("opt-2", "dup"))), ("body", "options", 3, "id")),
        (replace(MCQ, options=(("opt-1", "a"), ("opt 2", "b"))), ("body", "options", 1, "id")),
        (replace(MCQ, options=(("opt-1", "a"), ("", "b"))), ("body", "options", 1, "id")),
        (replace(MCQ, options=(("opt-1", "a"), ("opt-2", "  "))), ("body", "options", 1, "text")),
        (
            replace(MCQ, options=(("opt-1", "a"),), correct_option_ids=("opt-1",)),
            ("body", "options"),
        ),
        (replace(MCQ, stem="   "), ("body", "stem")),
        (replace(MCQ, stem="a\x00b"), ("body", "stem")),
        (replace(MCQ, stem="x" * 20001), ("body", "stem")),
        (replace(MCQ, explanation="x" * 20001), ("body", "explanation")),
        (replace(MCQ, accepted_answers=("a",)), ("body", "accepted_answers")),
        (replace(SHORT, options=(("o", "t"),)), ("body", "options")),
        (replace(SHORT, correct_option_ids=("o",)), ("body", "correct_option_ids")),
        (replace(SHORT, is_multi_answer=True), ("body", "is_multi_answer")),
        (replace(SHORT, accepted_answers=()), ("body", "accepted_answers")),
        (replace(SHORT, accepted_answers=("ok", " ")), ("body", "accepted_answers", 1)),
        (replace(ESSAY, accepted_answers=("a",)), ("body", "accepted_answers")),
        (replace(ESSAY, options=(("o", "t"),)), ("body", "options")),
    ],
)
def test_each_rule_reports_its_field(content: QuestionContent, loc: tuple[str | int, ...]) -> None:
    assert loc in locs(content)
    with pytest.raises(RequestValidationError):
        validate_content(content, "CONFIRMED")


def test_multi_answer_mcq_takes_several_answers() -> None:
    multi = replace(MCQ, is_multi_answer=True, correct_option_ids=("opt-1", "opt-3"))
    assert locs(multi) == []
    assert ("body", "correct_option_ids") in locs(replace(multi, correct_option_ids=("opt-1",) * 2))


def test_draft_mcq_may_lack_an_answer_and_options_but_not_be_malformed() -> None:
    draft = replace(MCQ, options=(), correct_option_ids=None)
    assert locs(draft, "DRAFT") == []
    assert locs(draft, "ARCHIVED") == [("body", "options"), ("body", "correct_option_ids")]
    assert locs(replace(MCQ, correct_option_ids=("opt-9",)), "DRAFT") == [
        ("body", "correct_option_ids", 0)
    ]


def test_every_violation_is_reported_at_once() -> None:
    bad = replace(MCQ, stem=" ", options=(("a b", " "),), correct_option_ids=())
    assert set(locs(bad)) >= {
        ("body", "stem"),
        ("body", "options", 0, "id"),
        ("body", "options", 0, "text"),
        ("body", "correct_option_ids"),
    }


@pytest.mark.parametrize(
    ("current", "target", "allowed"),
    [
        ("DRAFT", "CONFIRMED", True),
        ("CONFIRMED", "ARCHIVED", True),
        ("ARCHIVED", "CONFIRMED", True),
        ("CONFIRMED", "CONFIRMED", True),
        ("CONFIRMED", "DRAFT", False),
        ("ARCHIVED", "DRAFT", False),
        ("DRAFT", "ARCHIVED", False),
    ],
)
def test_publication_transitions(current: str, target: str, allowed: bool) -> None:
    assert transition_allowed(current, target) is allowed  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "oid", ["opt\x00", "\x00", "a\x07b", "a​b", "a\ud800", "a\x7f", "a\u0085", "a"]
)
def test_option_ids_reject_control_and_invalid_characters(oid: str) -> None:
    content = replace(MCQ, options=(("opt-1", "a"), (oid, "b")), correct_option_ids=("opt-1",))
    assert ("body", "options", 1, "id") in locs(content)
    assert not opaque_id_valid(oid)


@pytest.mark.parametrize("oid", ["opt-1", "가", "選択肢_3", "a" * 256, "\U0001f642"])
def test_ordinary_option_ids_are_accepted(oid: str) -> None:
    assert opaque_id_valid(oid)


def test_unstorable_strings_are_located_anywhere_in_a_body() -> None:
    body = {"stem": "ok", "options": [{"id": "a", "text": "b\x00"}], "x": ["\udc00"]}
    assert unstorable_strings(body) == [("options", 0, "text"), ("x", 0)]
    assert storable("tab\tnewline\n")
    assert not storable("\x00")
    assert not storable("\ud83d")
