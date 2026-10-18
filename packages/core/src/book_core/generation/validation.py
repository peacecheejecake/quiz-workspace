"""Validation of generated variants (questions.md §5: schema, option/answer count, duplicate
fingerprint, source coverage; the LLM's declared answer is never trusted).

Every check returns :class:`ValidationIssue` values; nothing here raises on odd content.

- Codes in :data:`REJECT_CODES` make the generator drop the candidate (it is recorded as a
  :class:`~book_core.generation.models.RejectedCandidate`): the content is unusable as a draft
  (no stem, unmapped answer, fabricated citation, duplicate, ...).
- Other ``error`` issues stay on the draft and block approval until fixed (or, for
  :data:`ACKNOWLEDGEABLE_CODES`, explicitly confirmed by the reviewer); ``warning`` issues ask
  the reviewer to look.

:func:`validate_variant` re-runs the content checks on an (edited) draft, so the review API
(M6.2) applies the same rules after a human edit.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass

from book_core.contracts import (
    Excerpt,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    SourceEvidence,
    ValidationIssue,
    ValidationSeverity,
    VariationType,
)
from book_core.generation.models import SourceQuestion
from book_core.generation.prompts import LLMVariant, passage_tag
from book_core.question import (
    canonical_key,
    issue,
    normalize_text,
    option_id,
    question_fingerprint,
    structural_issues,
)

MAX_STEM_CHARS = 20000
MAX_OPTIONS = 50
MAX_OPTION_CHARS = 5000
MAX_ANSWERS = 50
MAX_ANSWER_CHARS = 1000
MAX_TEXT_CHARS = 20000
"""Explanation / justification limit (``question_revisions.explanation``)."""
MIN_QUOTE_CHARS = 4
"""Minimum quote length (normalized characters) for a citation to count as evidence."""

REJECT_CODES: frozenset[str] = frozenset(
    {
        # content
        "empty_stem",
        "stem_too_long",
        "too_many_options",
        "option_text_empty",
        "option_text_too_long",
        "duplicate_option_text",
        "invalid_option_labels",
        "answer_text_invalid",
        "text_too_long",
        "justification_missing",
        # structure (book_core.question.structural_issues)
        "duplicate_option_id",
        "mcq_too_few_options",
        "mcq_text_answer",
        "answer_not_in_options",
        "duplicate_answer_option",
        "empty_answer",
        "options_not_allowed",
        "option_answer_not_allowed",
        "answer_missing",
        # duplicates
        "duplicate_of_source",
        "duplicate_of_existing",
        "duplicate_candidate",
        # sources
        "citation_unknown_passage",
        "citation_not_in_passage",
        "citation_too_short",
        "evidence_not_in_passages",
        "source_not_cited",
        # whole call / generator
        "llm_output_invalid",
        "llm_unavailable",
        "no_candidates",
        "candidate_over_limit",
        "draft_invalid",
    }
)

ACKNOWLEDGEABLE_CODES: frozenset[str] = frozenset({"answer_count_changed", "question_type_changed"})
"""Blocking issues a reviewer may explicitly confirm (questions.md §5: an inverted question's
answer count may change; confirm the rebuilt options or the multi-select type)."""

_NEGATION_MARKERS = (
    "않은",
    "않는",
    "아닌",
    "틀린",
    "옳지",
    "없는",
    "잘못된",
    "거리가먼",
    "부적절",
    "not",
    "false",
    "incorrect",
    "except",
    "least",
)


@dataclass(frozen=True, slots=True)
class VariantContent:
    """The reviewable content of a variant, from LLM output or from an (edited) draft."""

    question_type: QuestionType
    stem: str
    options: tuple[QuestionOption, ...]
    correct_option_ids: tuple[str, ...] | None
    accepted_answers: tuple[str, ...] | None
    explanation: str | None
    justification: str | None
    evidence: tuple[SourceEvidence, ...]
    multi_select: bool | None = None

    def fingerprint(self) -> str:
        return question_fingerprint(
            question_type=self.question_type,
            stem=self.stem,
            options=self.options,
            correct_option_ids=self.correct_option_ids,
            accepted_answers=self.accepted_answers,
        )


def source_fingerprint(source: SourceQuestion) -> str:
    return question_fingerprint(
        question_type=source.question_type,
        stem=source.stem,
        options=source.options,
        correct_option_ids=source.correct_option_ids,
        accepted_answers=source.accepted_answers,
    )


def is_rejection(issues: Sequence[ValidationIssue]) -> bool:
    return any(i.code in REJECT_CODES and i.severity is ValidationSeverity.ERROR for i in issues)


# ------------------------------------------------------------------------------------------
# LLM output -> content


def content_from_llm(
    candidate: LLMVariant, source: SourceQuestion, passages: Sequence[Excerpt]
) -> tuple[VariantContent | None, list[ValidationIssue]]:
    """Map a schema-valid candidate to draft content: option labels to stable ids, answer
    labels to option ids, citations to evidence. ``None`` with reject issues when unmappable.
    """
    issues: list[ValidationIssue] = []
    question_type = QuestionType(candidate.question_type)

    options, label_ids, option_issues = _options(candidate)
    issues += option_issues

    correct: tuple[str, ...] | None = None
    labels = candidate.correct_option_labels
    if (
        labels is not None
        and not option_issues
        and not (question_type is not QuestionType.MCQ and not labels)
    ):
        keys = [canonical_key(label) for label in labels]
        unknown = [k for k in keys if k not in label_ids]
        if unknown:
            issues.append(
                issue(
                    "answer_not_in_options",
                    f"Answer references {len(unknown)} label(s) that are not option labels.",
                    error=True,
                    field="correct_option_ids",
                )
            )
        else:
            correct = tuple(label_ids[k] for k in keys)

    accepted: tuple[str, ...] | None = None
    if candidate.accepted_answers is not None and not (
        question_type is QuestionType.MCQ and not candidate.accepted_answers
    ):
        accepted = tuple(a.strip() for a in candidate.accepted_answers)

    evidence, citation_issues = _evidence(candidate, source, passages)
    issues += citation_issues

    if issues:
        return None, issues
    return (
        VariantContent(
            question_type=question_type,
            stem=candidate.stem.strip(),
            options=options,
            correct_option_ids=correct,
            accepted_answers=accepted,
            explanation=(candidate.explanation or "").strip() or None,
            justification=candidate.justification.strip() or None,
            evidence=evidence,
            multi_select=candidate.multi_select if question_type is QuestionType.MCQ else None,
        ),
        [],
    )


def _options(
    candidate: LLMVariant,
) -> tuple[tuple[QuestionOption, ...], dict[str, str], list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    if len(candidate.options) > MAX_OPTIONS:
        issues.append(
            issue(
                "too_many_options",
                f"More than {MAX_OPTIONS} options.",
                error=True,
                field="options",
            )
        )
        return (), {}, issues
    keys = [canonical_key(o.label) for o in candidate.options]
    if not all(keys) or len(set(keys)) != len(keys):
        issues.append(
            issue(
                "invalid_option_labels",
                "Option labels are empty or not unique.",
                error=True,
                field="options",
            )
        )
    options: list[QuestionOption] = []
    for n, o in enumerate(candidate.options, start=1):
        text = o.text.strip()
        if not text:
            issues.append(
                issue("option_text_empty", f"Option {n} is empty.", error=True, field="options")
            )
        elif len(text) > MAX_OPTION_CHARS:
            issues.append(
                issue(
                    "option_text_too_long",
                    f"Option {n} is longer than {MAX_OPTION_CHARS} characters.",
                    error=True,
                    field="options",
                )
            )
        else:
            options.append(QuestionOption(id=option_id(str(n)), text=text))
    if issues:
        return (), {}, issues
    label_ids = {k: option_id(str(n)) for n, k in enumerate(keys, start=1)}
    return tuple(options), label_ids, issues


def _evidence(
    candidate: LLMVariant, source: SourceQuestion, passages: Sequence[Excerpt]
) -> tuple[tuple[SourceEvidence, ...], list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    by_tag = {passage_tag(i).casefold(): p for i, p in enumerate(passages)}
    evidence: list[SourceEvidence] = []
    seen: set[tuple[str, str, str]] = set()
    for n, citation in enumerate(candidate.citations, start=1):
        passage = by_tag.get(citation.passage_id.strip().strip("[]").casefold())
        if passage is None:
            issues.append(
                issue(
                    "citation_unknown_passage",
                    f"Citation {n} does not reference a given passage.",
                    error=True,
                    field="evidence",
                )
            )
            continue
        quote = citation.quote.strip()
        problem = _quote_problem(quote, passage)
        if problem is not None:
            issues.append(problem)
            continue
        key = (passage.document_id, passage.revision_id, normalize_text(quote))
        if key not in seen:
            seen.add(key)
            evidence.append(_passage_evidence(passage, quote))
    if passages and not evidence and not issues:
        issues.append(
            issue(
                "source_not_cited",
                "The candidate cites none of the source passages.",
                error=True,
                field="evidence",
            )
        )
    if not passages:
        return source.evidence, issues
    return tuple(evidence), issues


def _passage_evidence(passage: Excerpt, quote: str) -> SourceEvidence:
    return SourceEvidence(
        document_id=passage.document_id,
        revision_id=passage.revision_id,
        block_ids=passage.block_ids,
        locations=passage.locations,
        quote=quote,
    )


def _quote_problem(quote: str, passage: Excerpt) -> ValidationIssue | None:
    needle = normalize_text(quote)
    if len(needle) < MIN_QUOTE_CHARS:
        return issue(
            "citation_too_short",
            f"A citation quote is shorter than {MIN_QUOTE_CHARS} characters.",
            error=True,
            field="evidence",
        )
    if needle not in normalize_text(passage.text):
        return issue(
            "citation_not_in_passage",
            "A citation quote does not appear in the cited passage.",
            error=True,
            field="evidence",
        )
    return None


# ------------------------------------------------------------------------------------------
# Content checks (shared by generation and re-validation after edits)


def content_issues(
    content: VariantContent,
    *,
    variation_type: VariationType,
    source: SourceQuestion,
    passages: Sequence[Excerpt] = (),
    existing_fingerprints: Collection[str] = (),
    sibling_fingerprints: Collection[str] = (),
    acknowledged: Collection[str] = (),
) -> list[ValidationIssue]:
    """Every content rule; deterministic order. ``sibling_fingerprints`` are the other drafts
    of the same run."""
    issues: list[ValidationIssue] = []
    issues += _text_issues(content)
    issues += _structure(content, variation_type)
    issues += _duplicates(content, source, existing_fingerprints, sibling_fingerprints)
    issues += _evidence_issues(content, source, passages)
    issues += _source_changes(content, variation_type, source)
    return _acknowledge(issues, acknowledged)


def _text_issues(content: VariantContent) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    stem = content.stem.strip()
    if not stem:
        issues.append(issue("empty_stem", "The stem is empty.", error=True, field="stem"))
    elif len(stem) > MAX_STEM_CHARS:
        issues.append(
            issue(
                "stem_too_long",
                f"The stem is longer than {MAX_STEM_CHARS} characters.",
                error=True,
                field="stem",
            )
        )
    if len(content.options) > MAX_OPTIONS:
        issues.append(
            issue(
                "too_many_options", f"More than {MAX_OPTIONS} options.", error=True, field="options"
            )
        )
    texts: list[str] = []
    for n, o in enumerate(content.options, start=1):
        text = o.text.strip()
        if not text:
            issues.append(
                issue("option_text_empty", f"Option {n} is empty.", error=True, field="options")
            )
        elif len(text) > MAX_OPTION_CHARS:
            issues.append(
                issue(
                    "option_text_too_long",
                    f"Option {n} is longer than {MAX_OPTION_CHARS} characters.",
                    error=True,
                    field="options",
                )
            )
        texts.append(normalize_text(text))
    if len(set(texts)) != len(texts):
        issues.append(
            issue(
                "duplicate_option_text",
                "Two options have the same text.",
                error=True,
                field="options",
            )
        )
    answers = content.accepted_answers
    if answers is not None and (
        not answers
        or len(answers) > MAX_ANSWERS
        or any(not a.strip() or len(a) > MAX_ANSWER_CHARS for a in answers)
    ):
        issues.append(
            issue(
                "answer_text_invalid",
                f"Accepted answers must be 1-{MAX_ANSWERS} non-empty texts of at most "
                f"{MAX_ANSWER_CHARS} characters.",
                error=True,
                field="accepted_answers",
            )
        )
    for name, value in (
        ("explanation", content.explanation),
        ("justification", content.justification),
    ):
        if value is not None and len(value) > MAX_TEXT_CHARS:
            issues.append(
                issue(
                    "text_too_long",
                    f"The {name} is longer than {MAX_TEXT_CHARS} characters.",
                    error=True,
                    field=name,
                )
            )
    if not (content.justification or "").strip():
        issues.append(
            issue(
                "justification_missing",
                "The answer has no justification.",
                error=True,
                field="justification",
            )
        )
    return issues


def _structure(content: VariantContent, variation_type: VariationType) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for found in structural_issues(
        question_type=content.question_type,
        options=content.options,
        correct_option_ids=content.correct_option_ids,
        accepted_answers=content.accepted_answers,
        evidence=content.evidence,
        multi_select=content.multi_select,
    ):
        if found.code == "answer_missing":
            # A generated question must carry an answer, except an essay (graded by rubric).
            if content.question_type is QuestionType.ESSAY:
                continue
            found = issue(
                "answer_missing",
                "The generated question has no answer.",
                error=True,
                field=found.field,
            )
        elif found.code == "provenance_missing" and variation_type is not (
            VariationType.ANALOGOUS_CONCEPT
        ):
            # The source question itself had no recorded source and no passage was given.
            found = issue(
                "provenance_missing",
                "No source passage is linked; check the variant against the original.",
            )
        issues.append(found)
    return issues


def _duplicates(
    content: VariantContent,
    source: SourceQuestion,
    existing: Collection[str],
    siblings: Collection[str],
) -> list[ValidationIssue]:
    fingerprint = content.fingerprint()
    if fingerprint == source_fingerprint(source):
        return [
            issue(
                "duplicate_of_source",
                "The variant is the source question unchanged (option order aside).",
                error=True,
            )
        ]
    if fingerprint in existing:
        return [
            issue(
                "duplicate_of_existing",
                "The variant duplicates a question already in the workspace.",
                error=True,
            )
        ]
    if fingerprint in siblings:
        return [
            issue(
                "duplicate_candidate",
                "The variant duplicates another draft of this generation run.",
                error=True,
            )
        ]
    return []


def _evidence_issues(
    content: VariantContent, source: SourceQuestion, passages: Sequence[Excerpt]
) -> list[ValidationIssue]:
    """Every evidence entry is the source question's own provenance or a verbatim quote of a
    given passage; with passages given, at least one must be cited."""
    issues: list[ValidationIssue] = []
    cited = False
    for n, evidence in enumerate(content.evidence, start=1):
        # The original's own provenance is accepted as is, but still counts as a citation
        # when it is a supplied passage (e.g. the source was itself a generated question).
        inherited = evidence in source.evidence
        candidates = [
            p
            for p in passages
            if p.document_id == evidence.document_id
            and p.revision_id == evidence.revision_id
            and set(evidence.block_ids) <= set(p.block_ids)
        ]
        if not candidates:
            if inherited:
                continue
            issues.append(
                issue(
                    "evidence_not_in_passages",
                    f"Evidence {n} is neither a source passage nor the original's source.",
                    error=True,
                    field="evidence",
                )
            )
            continue
        if evidence.quote is None:
            cited = True
            continue
        problems = [_quote_problem(evidence.quote.strip(), p) for p in candidates]
        if any(p is None for p in problems):
            cited = True
        elif not inherited:
            issues.append(next(p for p in problems if p is not None))
    if passages and not cited and not issues:
        issues.append(
            issue(
                "source_not_cited",
                "The variant cites none of the source passages.",
                error=True,
                field="evidence",
            )
        )
    return issues


def _source_changes(
    content: VariantContent, variation_type: VariationType, source: SourceQuestion
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if content.question_type is not source.question_type:
        issues.append(
            issue(
                "question_type_changed",
                f"The question type changed from {source.question_type.value} to "
                f"{content.question_type.value}; confirm the change before approval.",
                error=True,
                field="question_type",
            )
        )
    elif (
        content.question_type is QuestionType.MCQ
        and source.correct_option_ids is not None
        and content.correct_option_ids is not None
        and len(source.correct_option_ids) != len(content.correct_option_ids)
    ):
        before, after = len(source.correct_option_ids), len(content.correct_option_ids)
        issues.append(
            issue(
                "answer_count_changed",
                f"The number of correct options changed from {before} to {after}; rebuild "
                "the options or confirm the multi-select question before approval.",
                error=True,
                field="correct_option_ids",
            )
        )
    if variation_type is VariationType.INVERT_POLARITY:
        mismatch = _inverted_answer_mismatch(content, source)
        if mismatch is not None:
            issues.append(mismatch)
    if variation_type is VariationType.INVERT_POLARITY and _negated(content.stem) == _negated(
        source.stem
    ):
        issues.append(
            issue(
                "polarity_unchanged",
                "The stem does not look inverted relative to the original; check its wording.",
                field="stem",
            )
        )
    if variation_type is VariationType.PARAPHRASE and normalize_text(content.stem) == (
        normalize_text(source.stem)
    ):
        issues.append(issue("stem_unchanged", "The stem was not reworded.", field="stem"))
    return issues


def _inverted_answer_mismatch(
    content: VariantContent, source: SourceQuestion
) -> ValidationIssue | None:
    """An inversion that keeps the original options (same texts, any order or ids) makes the
    complement of the original answer correct. The declared answer must be exactly that set;
    otherwise the draft is blocked until the reviewer sets the answer (multi-answer when several
    options are now correct) or rebuilds the options (questions.md §5, QGEN-01-AC03)."""
    if content.question_type is not QuestionType.MCQ or source.question_type is not (
        QuestionType.MCQ
    ):
        return None
    if source.correct_option_ids is None or content.correct_option_ids is None:
        return None
    source_texts = {normalize_text(o.text): o.id for o in source.options}
    if len(source_texts) != len(source.options):
        return None
    if sorted(normalize_text(o.text) for o in content.options) != sorted(source_texts):
        return None
    original = set(source.correct_option_ids)
    expected = {text for text, oid in source_texts.items() if oid not in original}
    by_id = {o.id: normalize_text(o.text) for o in content.options}
    declared = {by_id[i] for i in content.correct_option_ids if i in by_id}
    if declared == expected:
        return None
    return issue(
        "inverted_answer_mismatch",
        f"The inversion keeps the original options, so {len(expected)} of them are correct "
        f"now (the complement of the original answer) but the draft marks {len(declared)}; set "
        "the answer (multi-answer when several are correct) or rebuild the options.",
        error=True,
        field="correct_option_ids",
    )


def _negated(stem: str) -> bool:
    text = normalize_text(stem)
    return any(marker in text for marker in _NEGATION_MARKERS)


def _acknowledge(
    issues: list[ValidationIssue], acknowledged: Collection[str]
) -> list[ValidationIssue]:
    out: list[ValidationIssue] = []
    for found in issues:
        if found.code in ACKNOWLEDGEABLE_CODES and found.code in acknowledged:
            found = found.model_copy(
                update={
                    "severity": ValidationSeverity.WARNING,
                    "message": found.message + " (confirmed by the reviewer)",
                }
            )
        out.append(found)
    return out


# ------------------------------------------------------------------------------------------
# Re-validation of a stored / edited draft


def content_from_draft(draft: QuestionDraft, multi_select: bool | None = None) -> VariantContent:
    return VariantContent(
        question_type=draft.question_type,
        stem=draft.stem,
        options=draft.options,
        correct_option_ids=draft.correct_option_ids,
        accepted_answers=draft.accepted_answers,
        explanation=draft.explanation,
        justification=draft.justification,
        evidence=draft.evidence,
        multi_select=multi_select,
    )


def validate_variant(
    draft: QuestionDraft,
    *,
    source: SourceQuestion,
    passages: Sequence[Excerpt] = (),
    existing_fingerprints: Collection[str] = (),
    sibling_fingerprints: Collection[str] = (),
    acknowledged: Collection[str] = (),
    multi_select: bool | None = None,
) -> tuple[ValidationIssue, ...]:
    """The validations a generated draft must carry after a (human) edit.

    ``draft.variation_type`` selects the variation rules. Any ``error`` blocks approval;
    ``acknowledged`` lists :data:`ACKNOWLEDGEABLE_CODES` the reviewer confirmed. The caller
    should not include the draft's own fingerprint in ``sibling_fingerprints``.
    ``multi_select`` is the reviewer's multi-answer flag when the review UI has one; it adds
    the ``mcq_multi_inconsistent`` check (the LLM's flag is not stored on the draft).
    """
    variation = draft.variation_type
    if variation is None or variation is VariationType.OPTION_SHUFFLE:
        return (
            issue(
                "draft_invalid",
                "Only PARAPHRASE, INVERT_POLARITY and ANALOGOUS_CONCEPT drafts are validated.",
                error=True,
                field="variation_type",
            ),
        )
    return tuple(
        content_issues(
            content_from_draft(draft, multi_select),
            variation_type=variation,
            source=source,
            passages=passages,
            existing_fingerprints=existing_fingerprints,
            sibling_fingerprints=sibling_fingerprints,
            acknowledged=acknowledged,
        )
    )
