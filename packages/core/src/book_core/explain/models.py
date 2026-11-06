"""Typed input of an AI explanation (AIEXPL-01, questions.md §13, C04).

An explanation is shared by every member who submitted the question (one per question revision),
so its input is the question revision only: type, stem, options in stored order, the server's
answer (correct option ids / accepted answers) and rubric, plus the tagged passages (the
question's own published source blocks first, then the evidence the API's retrieval pinned). There
is **no field** for a user's answer, choice or attempt, nor for the human explanation (UX12
EXPL-2): whatever the caller has, it cannot reach the request.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from book_core.ask.models import AskSource

ExplainKind = Literal["question", "mock_exam_question"]
MCQ = "MCQ"


@dataclass(frozen=True, slots=True)
class ExplainOption:
    """An option in the revision's stored order (1-based ``number``) with its stable id."""

    option_id: str
    number: int
    text: str


@dataclass(frozen=True, slots=True)
class ExplainQuestion:
    kind: ExplainKind
    question_type: str
    stem: str
    options: tuple[ExplainOption, ...]
    correct_option_ids: tuple[str, ...]
    accepted_answers: tuple[str, ...]
    rubric: str | None

    @property
    def is_mcq(self) -> bool:
        return self.question_type == MCQ

    @property
    def option_ids(self) -> tuple[str, ...]:
        return tuple(o.option_id for o in self.options)

    def option(self, option_id: str) -> ExplainOption | None:
        return next((o for o in self.options if o.option_id == option_id), None)

    @property
    def correct_texts(self) -> tuple[str, ...]:
        correct = set(self.correct_option_ids)
        return tuple(o.text for o in self.options if o.option_id in correct)


ExplainSource = AskSource


def explain_question(
    *,
    kind: ExplainKind,
    question_type: str,
    stem: str,
    options: Sequence[Mapping[str, object]],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
    rubric: str | None,
) -> ExplainQuestion:
    """The DTO from a revision row (options as stored: ``[{id, text}]``)."""
    shown = tuple(
        ExplainOption(option_id=str(o.get("id")), number=n, text=str(o.get("text", "")))
        for n, o in enumerate((o for o in options if o.get("id") is not None), start=1)
    )
    return ExplainQuestion(
        kind=kind,
        question_type=question_type,
        stem=stem,
        options=shown,
        correct_option_ids=tuple(correct_option_ids or ()),
        accepted_answers=tuple(a for a in accepted_answers or () if a.strip()),
        rubric=rubric if rubric and rubric.strip() else None,
    )
