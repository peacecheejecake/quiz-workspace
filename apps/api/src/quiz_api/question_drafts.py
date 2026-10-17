"""Review rules for question drafts (M4.4a; shared with generation drafts in M6).

A draft's `payload` is a book_core `QuestionDraft` (schema_version 1). The rules applied here:

* Editing: the edited content must be storable as a question at all (quiz_api.question_rules for
  a DRAFT question: option ids, lengths, answer ids among the options, ...) or the edit is 422.
  After an edit the draft's validations are recomputed with the shared structural rules
  (`book_core.question.structural_issues`, the ones the extractor ran); extraction-only warnings
  (e.g. an unreadable answer-key line) were shown to the reviewer who edited and are dropped.
* Approving and publishing (CONFIRMED): no `error`-level validation, and the content passes the
  question bank's CONFIRMED rules (question_rules.content_issues). An MCQ without a known answer
  therefore cannot be confirmed until a reviewer enters the answer: an answer the source does not
  give is never made up (QIMPORT-01-AC02). Short-answer and essay questions may be confirmed with
  a null answer (not auto-gradable; graded by self/reviewer, questions.md §4.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from book_core.contracts import (
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    ValidationIssue,
    ValidationSeverity,
)
from book_core.question import structural_issues

from quiz_api.question_rules import Issues, Loc, QuestionContent, content_issues


@dataclass(frozen=True)
class SourcePages:
    page_start: int | None
    page_end: int | None
    block_ids: tuple[str, ...]
    locations: list[dict[str, Any]]


def parse_payload(payload: dict[str, Any]) -> QuestionDraft:
    return QuestionDraft.model_validate(payload)


def content_of(draft: QuestionDraft, *, is_multi_answer: bool) -> QuestionContent:
    return QuestionContent(
        question_type=draft.question_type.value,
        stem=draft.stem,
        options=tuple((o.id, o.text) for o in draft.options),
        correct_option_ids=draft.correct_option_ids,
        is_multi_answer=is_multi_answer,
        accepted_answers=draft.accepted_answers,
        explanation=draft.explanation,
        rubric=None,
    )


def recompute_validations(
    content: QuestionContent, draft: QuestionDraft
) -> tuple[ValidationIssue, ...]:
    issues = structural_issues(
        question_type=QuestionType(content.question_type),
        options=[QuestionOption(id=oid, text=text) for oid, text in content.options],
        correct_option_ids=content.correct_option_ids,
        accepted_answers=content.accepted_answers,
        evidence=draft.evidence,
        multi_select=content.is_multi_answer if content.question_type == "MCQ" else None,
    )
    return tuple(dict.fromkeys(issues))


def publish_issues(
    content: QuestionContent, validations: list[dict[str, Any]], prefix: Loc = ("body",)
) -> Issues:
    """Why the draft cannot be confirmed (empty = it can)."""
    issues = content_issues(content, "CONFIRMED", prefix)
    for v in validations:
        if v.get("severity") == ValidationSeverity.ERROR.value:
            field = v.get("field")
            issues.add((field,) if isinstance(field, str) and field else (), str(v.get("message")))
    return issues


def with_review(
    draft: QuestionDraft,
    content: QuestionContent,
    validations: tuple[ValidationIssue, ...],
    review_status: str,
) -> QuestionDraft:
    """The payload for edited content / a new review status (validated as a QuestionDraft)."""
    return QuestionDraft.model_validate(
        {
            **draft.model_dump(),
            "question_type": content.question_type,
            "stem": content.stem,
            "options": [{"id": oid, "text": text} for oid, text in content.options],
            "correct_option_ids": content.correct_option_ids,
            "accepted_answers": content.accepted_answers,
            "explanation": content.explanation,
            "validations": [v.model_dump() for v in validations],
            "review_status": ReviewStatus(review_status),
        }
    )


def answer_missing(draft: QuestionDraft) -> bool:
    return draft.correct_option_ids is None and draft.accepted_answers is None


def pages(draft: QuestionDraft) -> list[int]:
    return sorted({loc.page for e in draft.evidence for loc in e.locations})


def source_pages(draft: QuestionDraft) -> SourcePages:
    """One `question_sources` row summarising every evidence region of the draft."""
    found = pages(draft)
    block_ids = tuple(dict.fromkeys(b for e in draft.evidence for b in e.block_ids))
    locations = [loc.model_dump(mode="json") for e in draft.evidence for loc in e.locations]
    return SourcePages(
        page_start=found[0] if found else None,
        page_end=found[-1] if found else None,
        block_ids=block_ids,
        locations=locations,
    )
