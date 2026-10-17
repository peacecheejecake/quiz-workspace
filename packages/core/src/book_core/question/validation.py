"""Structural checks shared by imported and generated drafts (questions.md §5-§6).

They run on candidate values *before* a ``QuestionDraft`` is built, so a problem becomes a
``ValidationIssue`` on the draft (shown in the shared review UI) instead of an exception.
``error`` blocks approval; ``warning`` asks the reviewer to look.
"""

from __future__ import annotations

from collections.abc import Sequence

from book_core.contracts import (
    QuestionOption,
    QuestionType,
    SourceEvidence,
    ValidationIssue,
    ValidationSeverity,
)

MIN_MCQ_OPTIONS = 2


def issue(
    code: str, message: str, *, error: bool = False, field: str | None = None
) -> ValidationIssue:
    return ValidationIssue(
        code=code,
        severity=ValidationSeverity.ERROR if error else ValidationSeverity.WARNING,
        message=message,
        field=field,
    )


def structural_issues(
    *,
    question_type: QuestionType,
    options: Sequence[QuestionOption],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
    evidence: Sequence[SourceEvidence],
    multi_select: bool | None = None,
) -> list[ValidationIssue]:
    """Option ids unique, answer ids among the options, MCQ multi flag consistent with the
    answer count, no options or option answers on written questions, provenance present, and
    a missing answer flagged (never filled in)."""
    issues: list[ValidationIssue] = []
    ids = [o.id for o in options]
    if len(set(ids)) != len(ids):
        issues.append(issue("duplicate_option_id", "Option ids are not unique.", error=True))

    if question_type is QuestionType.MCQ:
        if len(options) < MIN_MCQ_OPTIONS:
            issues.append(
                issue(
                    "mcq_too_few_options",
                    f"A multiple-choice question needs at least {MIN_MCQ_OPTIONS} options.",
                    error=True,
                    field="options",
                )
            )
        if accepted_answers is not None:
            issues.append(
                issue(
                    "mcq_text_answer",
                    "A multiple-choice answer must reference options.",
                    error=True,
                    field="accepted_answers",
                )
            )
        if correct_option_ids is not None:
            unknown = sorted(set(correct_option_ids) - set(ids))
            if unknown:
                issues.append(
                    issue(
                        "answer_not_in_options",
                        f"Answer references unknown options: {', '.join(unknown)}.",
                        error=True,
                        field="correct_option_ids",
                    )
                )
            if len(set(correct_option_ids)) != len(correct_option_ids):
                issues.append(
                    issue(
                        "duplicate_answer_option",
                        "Answer lists an option twice.",
                        error=True,
                        field="correct_option_ids",
                    )
                )
            if not correct_option_ids:
                issues.append(
                    issue(
                        "empty_answer",
                        "Answer is empty.",
                        error=True,
                        field="correct_option_ids",
                    )
                )
            elif multi_select is False and len(correct_option_ids) > 1:
                issues.append(
                    issue(
                        "mcq_multi_inconsistent",
                        "Several correct options, but the stem does not ask for several.",
                        field="correct_option_ids",
                    )
                )
            elif multi_select is True and len(correct_option_ids) == 1:
                issues.append(
                    issue(
                        "mcq_multi_inconsistent",
                        "The stem asks for several options, but the answer has one.",
                        field="correct_option_ids",
                    )
                )
    else:
        if options:
            issues.append(
                issue(
                    "options_not_allowed",
                    f"A {question_type.value} question cannot have options.",
                    error=True,
                    field="options",
                )
            )
        if correct_option_ids is not None:
            issues.append(
                issue(
                    "option_answer_not_allowed",
                    f"A {question_type.value} answer cannot reference options.",
                    error=True,
                    field="correct_option_ids",
                )
            )

    if correct_option_ids is None and accepted_answers is None:
        issues.append(
            issue(
                "answer_missing",
                "No answer in the source; enter one during review or leave it empty.",
                field="correct_option_ids"
                if question_type is QuestionType.MCQ
                else "accepted_answers",
            )
        )
    if not evidence:
        issues.append(issue("provenance_missing", "Source page/region is missing.", error=True))
    return issues
