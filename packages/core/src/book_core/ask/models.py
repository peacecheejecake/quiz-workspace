"""Typed inputs of an AI question answer (ASK-01, questions.md §13).

The attached question is one of two DTOs, by disclosure level (ASK-01-C03):

- ``HintQuestionContext`` (not submitted yet): what the question shows before submission — its
  number, chapter, type, stem, every option's text in the session's display order and the
  user's current choice. It has **no field** that tells which option is correct or carries a
  private answer (correct ids, ``is_correct``, accepted answers, rubric, model answer,
  explanation, source passages), so a hint request cannot carry them whatever the caller does.
  The correct option's text is just one of the options.
- ``FullQuestionContext`` (submitted, or the 문제 상세 / 모의고사 문제 관리 views that already show
  the answer): the same plus the answer, explanation, rubric, the user's own submission and
  result, and the cited passages of its sources.

Builders take only the values a level may use (``hint_context`` has no answer parameters).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

Disclosure = Literal["none", "hint", "full"]
AttachmentKind = Literal["question", "mock_exam_question"]

# Field names that tell the answer or carry private answer content; none is a field of the hint
# DTOs, and a hint request serializes none of them (ASK-01-C03).
ASK_FIELDS_FORBIDDEN_IN_HINT = (
    "correct_answer",
    "correct_option_ids",
    "is_correct",
    "explanation",
    "accepted_answers",
    "rubric",
    "question_sources",
    "evidence",
)


@dataclass(frozen=True, slots=True)
class HintOption:
    """An option as shown: 1-based display number, its text, stable id, chosen by the user now."""

    number: int
    text: str
    option_id: str
    selected: bool


@dataclass(frozen=True, slots=True)
class HintQuestionContext:
    kind: AttachmentKind
    number: str | None
    chapter: str | None
    question_type: str
    stem: str
    options: tuple[HintOption, ...]
    selected: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class FullQuestionContext:
    kind: AttachmentKind
    number: str | None
    chapter: str | None
    question_type: str
    stem: str
    options: tuple[HintOption, ...]
    selected: tuple[int, ...]
    correct_answer: tuple[str, ...]
    explanation: str | None
    accepted_answers: tuple[str, ...]
    rubric: str | None
    submitted_answer: str | None
    result: str | None
    question_sources: tuple[str, ...]


QuestionContext = HintQuestionContext | FullQuestionContext


@dataclass(frozen=True, slots=True)
class AskSource:
    """One pinned evidence passage, as the model sees it (``tag`` = ``S1``…)."""

    tag: str
    document_title: str
    chapter_title: str | None
    page_from: int
    page_to: int
    text: str


@dataclass(frozen=True, slots=True)
class HistoryTurn:
    question: str
    answer: str


def displayed_options(
    options: Sequence[Mapping[str, object]],
    displayed_option_ids: Sequence[str],
    selected_option_ids: Iterable[str],
) -> tuple[HintOption, ...]:
    """The options in display order (the session's, else stored order), numbered from 1; ids the
    question does not have are ignored (the client's choice never adds an option)."""
    by_id = {str(o.get("id")): str(o.get("text", "")) for o in options if o.get("id") is not None}
    order = [i for i in displayed_option_ids if i in by_id]
    order += [i for i in by_id if i not in order]
    chosen = set(selected_option_ids)
    return tuple(
        HintOption(number=n, text=by_id[i], option_id=i, selected=i in chosen)
        for n, i in enumerate(order, start=1)
    )


def hint_context(
    *,
    kind: AttachmentKind,
    number: str | None,
    chapter: str | None,
    question_type: str,
    stem: str,
    options: Sequence[Mapping[str, object]],
    displayed_option_ids: Sequence[str],
    selected_option_ids: Iterable[str],
) -> HintQuestionContext:
    shown = displayed_options(options, displayed_option_ids, selected_option_ids)
    return HintQuestionContext(
        kind=kind,
        number=number,
        chapter=chapter,
        question_type=question_type,
        stem=stem,
        options=shown,
        selected=tuple(o.number for o in shown if o.selected),
    )


def full_context(
    *,
    kind: AttachmentKind,
    number: str | None,
    chapter: str | None,
    question_type: str,
    stem: str,
    options: Sequence[Mapping[str, object]],
    displayed_option_ids: Sequence[str],
    selected_option_ids: Iterable[str],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
    explanation: str | None,
    rubric: str | None,
    submitted_answer: str | None,
    result: str | None,
    question_sources: Sequence[str],
) -> FullQuestionContext:
    shown = displayed_options(options, displayed_option_ids, selected_option_ids)
    correct = set(correct_option_ids or ())
    return FullQuestionContext(
        kind=kind,
        number=number,
        chapter=chapter,
        question_type=question_type,
        stem=stem,
        options=shown,
        selected=tuple(o.number for o in shown if o.selected),
        correct_answer=tuple(f"{o.number}. {o.text}" for o in shown if o.option_id in correct),
        explanation=explanation,
        accepted_answers=tuple(a for a in accepted_answers or () if a.strip()),
        rubric=rubric,
        submitted_answer=submitted_answer,
        result=result,
        question_sources=tuple(p for p in question_sources if p.strip()),
    )
