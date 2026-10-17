"""Question content rules (M4.2a), checked before anything is written.

Mirrors the CHECK constraints of `question_revisions` (20261017180000_question_domain.sql:
`question_options_valid`, `question_correct_options_valid`, `question_text_items_valid`,
`question_revisions_single_answer`, length limits) and adds the type-specific completeness rules
the migration leaves to the API (docs/questions.md §4, tests/e2e/fixtures/questions.ts A2):

  * MCQ: options `{id, text}` with opaque, client-chosen ids (non-blank, no whitespace, unique,
    <= 256 chars) and non-blank text; `correct_option_ids` is null (answer unknown) or a non-empty
    set of distinct ids that all exist in `options`; a single-answer MCQ has exactly one.
    A CONFIRMED MCQ needs >= 2 options and an answer. `accepted_answers` is not used.
  * SHORT_ANSWER: no options / option answers / multi-answer; `accepted_answers` is null (not
    auto-gradable) or 1..50 non-blank strings.
  * ESSAY: no options, no option answers, no accepted answers; `rubric` is optional.

Every violation is reported (not just the first) as a FastAPI-style issue with a `loc` path into
the request body, rendered by the shared 422 problem handler.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from fastapi.exceptions import RequestValidationError

QuestionType = Literal["MCQ", "SHORT_ANSWER", "ESSAY"]
PublicationStatus = Literal["DRAFT", "CONFIRMED", "ARCHIVED"]

MAX_STEM = 20000
MAX_LONG_TEXT = 20000  # explanation, rubric
MAX_OPTIONS = 50
MAX_OPTION_ID = 256
MAX_OPTION_TEXT = 5000
MAX_ACCEPTED_ANSWERS = 50
MAX_ACCEPTED_ANSWER = 1000
MIN_CONFIRMED_MCQ_OPTIONS = 2

_OPAQUE_ID = re.compile(r"\S+")

Loc = tuple[str | int, ...]


@dataclass(frozen=True)
class QuestionContent:
    """The revisioned part of a question (one `question_revisions` row)."""

    question_type: QuestionType
    stem: str
    options: tuple[tuple[str, str], ...]  # (id, text) in authored order
    correct_option_ids: tuple[str, ...] | None
    is_multi_answer: bool
    accepted_answers: tuple[str, ...] | None
    explanation: str | None
    rubric: str | None

    def options_json(self) -> list[dict[str, str]]:
        return [{"id": oid, "text": text} for oid, text in self.options]


class Issues:
    def __init__(self, prefix: Loc = ("body",)) -> None:
        self._prefix = prefix
        self.items: list[dict[str, Any]] = []

    def add(self, loc: Loc, msg: str, kind: str = "value_error") -> None:
        self.items.append({"loc": (*self._prefix, *loc), "msg": msg, "type": kind})

    def raise_if_any(self) -> None:
        if self.items:
            raise RequestValidationError(self.items)


def _blank(value: str) -> bool:
    return value.strip() == ""


def _text(issues: Issues, loc: Loc, value: str | None, limit: int, *, required: bool) -> None:
    if value is None:
        if required:
            issues.add(loc, "Field required.", "missing")
        return
    if "\x00" in value:
        issues.add(loc, "Text must not contain NUL characters.")
    if required and _blank(value):
        issues.add(loc, "Must not be blank.")
    if len(value) > limit:
        issues.add(loc, f"At most {limit} characters.", "string_too_long")


def _options(issues: Issues, content: QuestionContent) -> None:
    if len(content.options) > MAX_OPTIONS:
        issues.add(("options",), f"At most {MAX_OPTIONS} options.", "too_long")
    seen: set[str] = set()
    for i, (oid, text) in enumerate(content.options):
        if not _OPAQUE_ID.fullmatch(oid) or len(oid) > MAX_OPTION_ID:
            issues.add(
                ("options", i, "id"),
                f"Option ids are 1-{MAX_OPTION_ID} characters without whitespace.",
            )
        elif oid in seen:
            issues.add(("options", i, "id"), "Option ids must be unique within the question.")
        seen.add(oid)
        _text(issues, ("options", i, "text"), text, MAX_OPTION_TEXT, required=True)


def _correct_option_ids(issues: Issues, content: QuestionContent, *, confirmed: bool) -> None:
    ids = content.correct_option_ids
    loc: Loc = ("correct_option_ids",)
    if ids is None:
        if confirmed:
            issues.add(loc, "A confirmed multiple-choice question needs a correct option.")
        return
    if not ids:
        issues.add(loc, "Select at least one correct option (null means the answer is unknown).")
        return
    if len(set(ids)) != len(ids):
        issues.add(loc, "Correct option ids must be distinct.")
    known = {oid for oid, _ in content.options}
    for i, oid in enumerate(ids):
        if oid not in known:
            issues.add((*loc, i), "Correct option ids must be ids of this question's options.")
    if not content.is_multi_answer and len(ids) != 1:
        issues.add(loc, "A single-answer question has exactly one correct option.")


def _accepted_answers(issues: Issues, answers: Sequence[str] | None) -> None:
    if answers is None:
        return
    loc: Loc = ("accepted_answers",)
    if not answers:
        issues.add(loc, "Give at least one accepted answer (null means not auto-gradable).")
    elif len(answers) > MAX_ACCEPTED_ANSWERS:
        issues.add(loc, f"At most {MAX_ACCEPTED_ANSWERS} accepted answers.", "too_long")
    for i, answer in enumerate(answers):
        _text(issues, (*loc, i), answer, MAX_ACCEPTED_ANSWER, required=True)


def content_issues(
    content: QuestionContent, status: PublicationStatus, prefix: Loc = ("body",)
) -> Issues:
    """All rule violations of `content` for a question in `status` (empty = valid)."""
    issues = Issues(prefix)
    confirmed = status != "DRAFT"
    _text(issues, ("stem",), content.stem, MAX_STEM, required=True)
    _text(issues, ("explanation",), content.explanation, MAX_LONG_TEXT, required=False)
    _text(issues, ("rubric",), content.rubric, MAX_LONG_TEXT, required=False)
    _options(issues, content)
    if content.question_type == "MCQ":
        if confirmed and len(content.options) < MIN_CONFIRMED_MCQ_OPTIONS:
            issues.add(
                ("options",),
                f"A confirmed multiple-choice question needs at least "
                f"{MIN_CONFIRMED_MCQ_OPTIONS} options.",
            )
        _correct_option_ids(issues, content, confirmed=confirmed)
        if content.accepted_answers is not None:
            issues.add(("accepted_answers",), "Only short-answer questions have accepted answers.")
        return issues
    kind = "short-answer" if content.question_type == "SHORT_ANSWER" else "essay"
    if content.options:
        issues.add(("options",), f"A {kind} question has no options.")
    if content.correct_option_ids is not None:
        issues.add(("correct_option_ids",), f"A {kind} question has no correct option ids.")
    if content.is_multi_answer:
        issues.add(("is_multi_answer",), "Only multiple-choice questions can be multi-answer.")
    if content.question_type == "SHORT_ANSWER":
        _accepted_answers(issues, content.accepted_answers)
    elif content.accepted_answers is not None:
        issues.add(("accepted_answers",), "Only short-answer questions have accepted answers.")
    return issues


def validate_content(content: QuestionContent, status: PublicationStatus) -> None:
    """Raise a 422 (`RequestValidationError`) listing every violation."""
    content_issues(content, status).raise_if_any()


# DRAFT -> CONFIRMED (publish), CONFIRMED <-> ARCHIVED. A confirmed question never returns to
# DRAFT (the migration's "archived, i.e. once confirmed"); a draft is deleted, not archived.
ALLOWED_TRANSITIONS: frozenset[tuple[PublicationStatus, PublicationStatus]] = frozenset(
    {("DRAFT", "CONFIRMED"), ("CONFIRMED", "ARCHIVED"), ("ARCHIVED", "CONFIRMED")}
)


def transition_allowed(current: PublicationStatus, target: PublicationStatus) -> bool:
    return current == target or (current, target) in ALLOWED_TRANSITIONS
