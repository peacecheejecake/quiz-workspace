"""What differs between a re-extracted draft and what it replaces (UX12-REEXTRACT, C04).

Same normalisation as the duplicate fingerprint (docs/questions.md §10.1), so a field reported as
changed is one a learner would see differently. Unlike the fingerprint it compares MCQ answers: a
draft whose stem and options match but whose answer differs is still the same question, and the
reviewer must see that the printed answer no longer agrees with the registered one.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from quiz_api.question_fingerprint import (
    answer_key,
    model_answer_of,
    normalize_option,
    normalize_stem,
)
from quiz_api.question_rules import QuestionContent

ChangedField = Literal["type", "stem", "options", "answer"]


def changed_fields(
    new: QuestionContent,
    question_type: str,
    stem: str,
    options: Sequence[tuple[str, str]],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
    rubric: str | None,
) -> list[ChangedField]:
    """The fields of `new` that differ from the earlier content, in display order."""
    changed: list[ChangedField] = []
    if new.question_type != question_type:
        changed.append("type")
    if normalize_stem(new.stem) != normalize_stem(stem):
        changed.append("stem")
    new_options = sorted(normalize_option(text) for _, text in new.options)
    if new_options != sorted(normalize_option(text) for _, text in options):
        changed.append("options")
    new_answer = (
        answer_key(new.options, new.correct_option_ids, new.accepted_answers),
        model_answer_of(new.question_type, new.accepted_answers, new.rubric),
    )
    old_answer = (
        answer_key(options, correct_option_ids, accepted_answers),
        model_answer_of(question_type, accepted_answers, rubric),
    )
    if new_answer != old_answer:
        changed.append("answer")
    return changed
