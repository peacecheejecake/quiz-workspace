"""Review rules for generated drafts (M6.2; questions.md §5, QGEN-01).

A generation draft is re-validated with the same rules the worker applied
(`book_core.generation.validate_variant`): schema/structure, answer count against the source,
the inverted answer of an INVERT_POLARITY that keeps the options, duplicate fingerprints (the
workspace's live questions and the run's other drafts), and citations (quotes must stay verbatim
excerpts of the passages the run gave the LLM, stored on the run). The LLM's declared answer is
never trusted: an `error` blocks approval until a reviewer edits the draft or, for
`ACKNOWLEDGEABLE_CODES`, explicitly confirms the change.

Confirmation (decision, tests/e2e/fixtures/generation.ts G5): sending `is_multi_answer: true` on
an MCQ draft confirms a changed answer count (`answer_count_changed`; the reviewer switches to a
multi-answer question), `is_multi_answer: false` withdraws that confirmation, and sending
`question_type` confirms a changed question type (`question_type_changed`). Confirmations are kept
on the draft (`question_drafts.acknowledged_codes`) across later edits; the issue then stays
visible as a warning.

Validations are recomputed on every PATCH of a generation draft (also a bare approval), so an
approval reflects questions registered since the run (duplicates) and the reviewer's flags.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence

from book_core.contracts import (
    Excerpt,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ValidationIssue,
)
from book_core.generation import (
    ACKNOWLEDGEABLE_CODES,
    SourceQuestion,
    stored_source_evidence,
    validate_variant,
)
from book_core.question import issue, question_fingerprint
from pydantic import ValidationError
from sqlalchemy.orm import Session

from quiz_api.question_drafts import parse_payload, with_review
from quiz_api.question_rules import QuestionContent
from quiz_api.repositories.question_generations import (
    ContentRecord,
    QuestionGenerationRepository,
    SourceRevisionRecord,
    StoredSourceRecord,
)
from quiz_api.repositories.question_imports import DraftRecord


def source_question(
    revision: SourceRevisionRecord, sources: Iterable[StoredSourceRecord]
) -> SourceQuestion:
    """The core view of a run's pinned source revision (same as the worker's)."""
    evidence = []
    for source in sources:
        if source.document_id is None:
            continue
        found = stored_source_evidence(
            document_id=str(source.document_id),
            revision_id=str(source.document_revision_id) if source.document_revision_id else None,
            page_start=source.page_start,
            page_end=source.page_end,
            block_ids=source.block_ids,
            locations=source.locations,
        )
        if found is not None:
            evidence.append(found)
    return SourceQuestion(
        question_id=str(revision.question_id),
        revision_id=str(revision.revision_id),
        question_type=QuestionType(revision.question_type),
        stem=revision.stem,
        options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in revision.options),
        correct_option_ids=tuple(revision.correct_option_ids)
        if revision.correct_option_ids is not None
        else None,
        accepted_answers=tuple(a for a in revision.accepted_answers if a.strip())
        if revision.accepted_answers
        else None,
        is_multi_answer=revision.is_multi_answer,
        explanation=revision.explanation,
        evidence=tuple(evidence),
    )


def _fingerprint(
    question_type: str,
    stem: str,
    options: Sequence[QuestionOption],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
) -> str | None:
    try:
        return question_fingerprint(
            question_type=QuestionType(question_type),
            stem=stem,
            options=options,
            correct_option_ids=correct_option_ids,
            accepted_answers=accepted_answers,
        )
    except (ValueError, ValidationError):
        return None


def content_fingerprints(contents: Iterable[ContentRecord]) -> frozenset[str]:
    out = (
        _fingerprint(
            c.question_type,
            c.stem,
            [QuestionOption(id=o["id"], text=o["text"]) for o in c.options],
            c.correct_option_ids,
            c.accepted_answers,
        )
        for c in contents
    )
    return frozenset(f for f in out if f is not None)


def draft_fingerprints(drafts: Iterable[DraftRecord], *, exclude: uuid.UUID) -> frozenset[str]:
    out: set[str] = set()
    for record in drafts:
        if record.id == exclude:
            continue
        try:
            draft = parse_payload(record.payload)
        except ValidationError:
            continue
        found = _fingerprint(
            draft.question_type.value,
            draft.stem,
            draft.options,
            draft.correct_option_ids,
            draft.accepted_answers,
        )
        if found is not None:
            out.add(found)
    return frozenset(out)


def acknowledged_codes(
    record: DraftRecord,
    *,
    sent: set[str],
    is_multi_answer: bool | None,
    question_type: str,
) -> tuple[str, ...]:
    """The reviewer's confirmations after this PATCH (see the module docstring)."""
    codes = set(record.acknowledged_codes) & ACKNOWLEDGEABLE_CODES
    if "is_multi_answer" in sent:
        if is_multi_answer and question_type == "MCQ":
            codes.add("answer_count_changed")
        else:
            codes.discard("answer_count_changed")
    if "question_type" in sent:
        codes.add("question_type_changed")
    return tuple(sorted(codes))


def generation_validations(
    session: Session,
    record: DraftRecord,
    draft: QuestionDraft,
    content: QuestionContent,
    acknowledged: Sequence[str],
) -> tuple[ValidationIssue, ...]:
    """The validations of `record` with `content` (the reviewed/edited content)."""
    repo = QuestionGenerationRepository(session)
    run = repo.get_run(record.generation_run_id) if record.generation_run_id else None
    revision = (
        repo.source_revision(
            record.workspace_id, run.source_question_id, run.source_question_revision_id
        )
        if run is not None
        else None
    )
    if run is None or revision is None:  # defensive: FKs keep both
        return (
            issue(
                "source_missing",
                "The generation run or its source question revision is missing.",
                error=True,
            ),
        )
    passages = []
    for raw in repo.passages(run.id):
        try:
            passages.append(Excerpt.model_validate(raw))
        except ValidationError:
            continue
    stored = repo.stored_sources(record.workspace_id, revision.question_id)
    source = source_question(revision, stored)
    edited = with_review(draft, content, (), "pending")
    return validate_variant(
        edited,
        source=source,
        passages=passages,
        existing_fingerprints=content_fingerprints(repo.workspace_contents(record.workspace_id)),
        sibling_fingerprints=draft_fingerprints(repo.list_drafts(run.id), exclude=record.id),
        acknowledged=acknowledged,
        multi_select=content.is_multi_answer if content.question_type == "MCQ" else None,
    )
