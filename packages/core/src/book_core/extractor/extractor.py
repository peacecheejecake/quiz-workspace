"""``QuestionExtractor``: question PDF (``ParsedDocument``) -> ``QuestionDraft``s (Task M4.3).

Pipeline (questions.md §6): rule-based pre-extraction (numbering, options, figures, answer key,
page/bbox provenance) -> optional LLM refinement per question (``questions.extract/v1``,
structured output, own source text only) -> structural validation -> drafts with
``review_status=pending``, ``origin=pdf_import`` and validation issues.

Answers come only from the printed answer key. An LLM answer is accepted only when the answer key
line for that question states the same thing; otherwise it is rejected with a warning and the
answer stays as the key gives it (``None`` when the key has no line for the question).
LLM failures (provider errors, schema-invalid output) never fail the run: the question keeps
its pre-extraction and gets a warning.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Annotated, Literal

from pydantic import Field

from book_core.contracts import (
    Block,
    CoreModel,
    DocumentRevision,
    DraftOrigin,
    GeneratorInfo,
    ParsedDocument,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    SourceEvidence,
    ValidationIssue,
)
from book_core.contracts.common import Identifier
from book_core.extractor.llm_refine import LLMQuestion, build_request
from book_core.extractor.segment import (
    AnswerKeyEntry,
    RawFigure,
    RawQuestion,
    Segmentation,
    SourceLine,
    infer_type,
    segment,
    union_locations,
)
from book_core.llm import (
    LLMCallInfo,
    LLMClient,
    LLMOutputError,
    LLMProviderError,
    LLMRequest,
    LLMUsage,
)
from book_core.question import (
    CIRCLED_DIGITS,
    answer_option_keys,
    canonical_key,
    issue,
    loose_text,
    option_id,
    structural_issues,
)

logger = logging.getLogger("book_core.extractor")

EXTRACTOR_VERSION = "book-core-question-extractor/1"


class ExtractedQuestion(CoreModel):
    """A draft plus extraction facts the draft contract does not carry."""

    number: Annotated[int, Field(ge=0)]
    multi_select: bool
    refined_by_llm: bool
    draft: QuestionDraft


class QuestionExtraction(CoreModel):
    """Result of one extraction run. Contains no answer-key or source text beyond the drafts."""

    schema_version: Literal[1] = 1
    extractor_version: str = EXTRACTOR_VERSION
    document_id: Identifier
    revision_id: Identifier | None = None
    questions: tuple[ExtractedQuestion, ...] = ()
    warnings: tuple[ValidationIssue, ...] = ()
    llm_calls: tuple[LLMCallInfo, ...] = ()

    @property
    def drafts(self) -> tuple[QuestionDraft, ...]:
        return tuple(q.draft for q in self.questions)

    @property
    def llm_usage(self) -> LLMUsage:
        total = LLMUsage()
        for call in self.llm_calls:
            total = total + call.usage
        return total


@dataclass(slots=True)
class _Candidate:
    number: int
    question_type: QuestionType
    multi_select: bool
    stem: str
    options: list[tuple[str, str]]  # (canonical key, text)
    correct_option_ids: tuple[str, ...] | None = None
    accepted_answers: tuple[str, ...] | None = None
    issues: list[ValidationIssue] = field(default_factory=list)
    generator: GeneratorInfo | None = None


class QuestionExtractor:
    """Extract import drafts from a parsed question paper.

    ``llm=None`` (or no ``LLM_API_KEY`` configured) runs the deterministic rule-based path only.
    """

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm

    def extract(
        self,
        document: ParsedDocument | DocumentRevision,
        *,
        document_id: str,
        revision_id: str | None = None,
    ) -> QuestionExtraction:
        blocks = document.blocks
        seg = segment(blocks)
        warnings = _document_warnings(
            seg.questions, seg.answer_key, seg.unparsed_answer_lines, seg.ambiguous_answer_tables
        )

        questions: list[ExtractedQuestion] = []
        calls: list[LLMCallInfo] = []
        for ctx in _contexts(seg, blocks):
            raw = ctx.raw
            candidate = _pre_extract(raw, ctx.entries, ctx.next_block, ctx.figures)
            if ctx.occurrence:
                candidate.issues.append(
                    issue(
                        "duplicate_question_number",
                        f"Question number {raw.number} appears more than once; "
                        "the answer key was not applied.",
                    )
                )
            refined = False
            if self._llm is not None and candidate.stem:
                candidate, refined, info = _refine(self._llm, candidate, ctx)
                if info is not None:
                    calls.append(info)

            draft_id = f"{document_id}-q{raw.number:03d}"
            if ctx.occurrence:
                draft_id = f"{draft_id}-{ctx.occurrence}"
            draft = _build_draft(
                candidate,
                draft_id=draft_id,
                evidence=_evidence(raw, ctx.figures, blocks, document_id, revision_id),
            )
            if draft is None:
                warnings.append(
                    issue(
                        "question_skipped",
                        f"Question {raw.number} has no stem text and was skipped.",
                    )
                )
                continue
            questions.append(
                ExtractedQuestion(
                    number=raw.number,
                    multi_select=candidate.multi_select,
                    refined_by_llm=refined,
                    draft=draft,
                )
            )

        logger.info(
            "question extraction document=%s questions=%d answer_key_entries=%d llm_calls=%d",
            document_id,
            len(questions),
            len(seg.answer_key),
            len(calls),
        )
        return QuestionExtraction(
            document_id=document_id,
            revision_id=revision_id,
            questions=tuple(questions),
            warnings=tuple(warnings),
            llm_calls=tuple(calls),
        )


def llm_requests(document: ParsedDocument | DocumentRevision) -> list[tuple[int, LLMRequest]]:
    """``(question number, request)`` for every question the extractor would refine, in order.

    The requests are exactly those ``QuestionExtractor.extract`` sends, so tests (and cost
    estimates) can script or count them before a run.
    """
    seg = segment(document.blocks)
    return [
        (ctx.raw.number, build_request(*_request_lines(ctx)))
        for ctx in _contexts(seg, document.blocks)
        if ctx.raw.stem
    ]


@dataclass(frozen=True, slots=True)
class _Context:
    raw: RawQuestion
    entries: list[AnswerKeyEntry]
    figures: list[RawFigure]
    next_block: Block | None
    occurrence: int
    """0 for a unique question number, else the 1-based occurrence of a duplicated number."""


def _contexts(seg: Segmentation, blocks: Sequence[Block]) -> list[_Context]:
    counts = Counter(q.number for q in seg.questions)
    key_by_number: dict[int, list[AnswerKeyEntry]] = {}
    for entry in seg.answer_key:
        key_by_number.setdefault(entry.number, []).append(entry)
    labelled = {f.label: f for f in seg.loose_figures if f.label is not None}
    for q in seg.questions:
        for f in q.figures:
            if f.label is not None:
                labelled.setdefault(f.label, f)

    contexts: list[_Context] = []
    seen: Counter[int] = Counter()
    for raw in seg.questions:
        seen[raw.number] += 1
        duplicate = counts[raw.number] > 1
        last = max(raw.block_indices)
        contexts.append(
            _Context(
                raw=raw,
                entries=[] if duplicate else key_by_number.get(raw.number, []),
                figures=_figures(raw, labelled),
                next_block=blocks[last + 1] if last + 1 < len(blocks) else None,
                occurrence=seen[raw.number] if duplicate else 0,
            )
        )
    return contexts


# ------------------------------------------------------------------------------------------
# Pre-extraction


def _figures(raw: RawQuestion, labelled: dict[str, RawFigure]) -> list[RawFigure]:
    figures = list(raw.figures)
    own = {f.label for f in figures}
    for label in raw.figure_labels:
        if label not in own and label in labelled:
            figures.append(labelled[label])
    return figures


def _options(raw: RawQuestion) -> tuple[list[tuple[str, str]], list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    options: list[tuple[str, str]] = []
    seen: Counter[str] = Counter()
    for option in raw.options:
        key = canonical_key(option.label)
        seen[key] += 1
        if seen[key] > 1:
            issues.append(
                issue(
                    "duplicate_option_label",
                    f"Option label {option.label} appears more than once.",
                    field="options",
                )
            )
            key = f"{key}-{seen[key]}"
        options.append((key, option.text))
    keys = [k for k, _ in options]
    if keys and not _is_sequence(keys):
        issues.append(
            issue(
                "option_sequence_gap",
                "Option labels are not a consecutive sequence; check for a missing option.",
                field="options",
            )
        )
    if any(not text for _, text in options):
        issues.append(issue("option_text_missing", "An option has no text.", field="options"))
    return options, issues


_HANGUL_LABELS = "가나다라마바사아자차"


def _is_sequence(keys: Sequence[str]) -> bool:
    """Labels run 1, 2, 3... / A, B, C... / 가, 나, 다... from the first label."""
    if keys and all(k in _HANGUL_LABELS for k in keys):
        return "".join(keys) == _HANGUL_LABELS[: len(keys)]
    if all(k.isdigit() for k in keys):
        return [int(k) for k in keys] == list(range(1, len(keys) + 1))
    if all(len(k) == 1 and k.isalpha() for k in keys):
        return [ord(k) for k in keys] == list(range(ord("A"), ord("A") + len(keys)))
    return False


def _answer_from_key(
    question_type: QuestionType,
    option_keys: Sequence[str],
    entries: Sequence[AnswerKeyEntry],
) -> tuple[tuple[str, ...] | None, tuple[str, ...] | None, list[ValidationIssue]]:
    """``(correct_option_ids, accepted_answers, issues)`` from the printed answer key."""
    if not entries:
        return None, None, []
    texts = {e.text for e in entries}
    if len(texts) > 1:
        return (
            None,
            None,
            [
                issue(
                    "answer_key_conflict",
                    "The answer key lists different answers for this question; none was applied.",
                )
            ],
        )
    text = entries[0].text
    if question_type is QuestionType.MCQ:
        keys = answer_option_keys(text)
        if keys is None or not set(keys) <= set(option_keys):
            return (
                None,
                None,
                [
                    issue(
                        "answer_key_unmapped",
                        "The answer key entry does not match this question's option labels; "
                        "no answer was applied.",
                        field="correct_option_ids",
                    )
                ],
            )
        ordered = tuple(dict.fromkeys(option_id(k) for k in keys))
        return ordered, None, []
    if any(c in CIRCLED_DIGITS for c in text):
        return (
            None,
            None,
            [
                issue(
                    "answer_key_type_mismatch",
                    "The answer key gives an option label for a question without options; "
                    "no answer was applied.",
                    field="accepted_answers",
                )
            ],
        )
    return None, (text,), []


def _pre_extract(
    raw: RawQuestion,
    entries: Sequence[AnswerKeyEntry],
    next_block: Block | None,
    figures: Sequence[RawFigure],
) -> _Candidate:
    options, issues = _options(raw)
    question_type, multi = infer_type(raw, next_block)
    if question_type is QuestionType.MCQ and len(options) < 2:
        issues.append(
            issue(
                "type_uncertain",
                "Only one option was found; check whether this is a multiple-choice question.",
            )
        )
    found_labels = {f.label for f in figures}
    for label in raw.figure_labels:
        if label not in found_labels:
            issues.append(
                issue(
                    "figure_missing",
                    "The stem refers to a figure that was not found in the document.",
                )
            )
    if question_type is not QuestionType.MCQ:
        options = []
    correct, accepted, answer_issues = _answer_from_key(
        question_type, [k for k, _ in options], entries
    )
    return _Candidate(
        number=raw.number,
        question_type=question_type,
        multi_select=multi,
        stem=raw.stem,
        options=options,
        correct_option_ids=correct,
        accepted_answers=accepted,
        issues=issues + answer_issues,
    )


# ------------------------------------------------------------------------------------------
# LLM refinement


def _source_lines(raw: RawQuestion, figures: Sequence[RawFigure]) -> list[str]:
    lines: list[SourceLine] = [*raw.stem_lines]
    for option in raw.options:
        lines += option.lines
    lines += [f.caption for f in figures if f.caption is not None]
    seen: set[tuple[int, str]] = set()
    ordered: list[str] = []
    for line in sorted(lines, key=lambda ln: ln.block_index):
        if (line.block_index, line.text) not in seen:
            seen.add((line.block_index, line.text))
            ordered.append(line.text)
    return ordered


def _request_lines(ctx: _Context) -> tuple[list[str], list[str]]:
    return _source_lines(ctx.raw, ctx.figures), sorted({e.line.text for e in ctx.entries})


def _refine(
    llm: LLMClient, pre: _Candidate, ctx: _Context
) -> tuple[_Candidate, bool, LLMCallInfo | None]:
    source, key_lines = _request_lines(ctx)
    entries = ctx.entries
    request = build_request(source, key_lines)
    try:
        result = llm.complete(request, LLMQuestion)
    except LLMOutputError as exc:
        pre.issues.append(
            issue(
                "llm_output_invalid",
                f"LLM output was invalid ({exc.detail}); the rule-based extraction was kept.",
            )
        )
        return pre, False, exc.call_info
    except LLMProviderError as exc:
        pre.issues.append(
            issue(
                "llm_unavailable",
                f"LLM call failed ({exc.kind}); the rule-based extraction was kept.",
            )
        )
        return pre, False, None
    merged = _merge(pre, result.output, entries)
    merged.generator = GeneratorInfo(model=result.info.model, prompt_version=request.prompt_version)
    return merged, True, result.info


def _merge(
    pre: _Candidate,
    proposal: LLMQuestion,
    entries: Sequence[AnswerKeyEntry],
) -> _Candidate:
    issues = list(pre.issues)
    stem, options, text_issues = _verified_text(pre, proposal)
    issues += text_issues

    question_type = QuestionType(proposal.question_type)
    if (question_type is QuestionType.MCQ) != bool(options):
        issues.append(
            issue(
                "llm_type_rejected",
                f"The LLM type {question_type.value} does not fit the printed options; "
                f"{pre.question_type.value} was kept.",
            )
        )
        question_type = pre.question_type
    if question_type is not QuestionType.MCQ:
        options = []
    multi = proposal.multi_select if question_type is QuestionType.MCQ else False

    # Re-derive the key answer against the final options; drop the pre answer issues.
    issues = [
        i
        for i in issues
        if i.code not in {"answer_key_unmapped", "answer_key_type_mismatch", "answer_key_conflict"}
    ]
    correct, accepted, key_issues = _answer_from_key(
        question_type, [k for k, _ in options], entries
    )
    issues += key_issues

    answer = proposal.answer
    has_llm_answer = answer is not None and bool(answer.option_labels or answer.text_answers)
    if (
        answer is not None
        and has_llm_answer
        and not _llm_answer_matches_key(
            question_type, answer.option_labels, answer.text_answers, entries
        )
    ):
        issues.append(
            issue(
                "llm_answer_rejected",
                "The LLM answer is not stated by the source answer key and was discarded.",
                field="correct_option_ids"
                if question_type is QuestionType.MCQ
                else "accepted_answers",
            )
        )
    return replace(
        pre,
        question_type=question_type,
        multi_select=multi,
        stem=stem,
        options=options,
        correct_option_ids=correct,
        accepted_answers=accepted,
        issues=issues,
    )


def _verified_text(
    pre: _Candidate, proposal: LLMQuestion
) -> tuple[str, list[tuple[str, str]], list[ValidationIssue]]:
    """Stem and options from the LLM only where they match the printed spans.

    Every label-text pair must be the printed one: with options found by the pre-extractor,
    each LLM option must have the same label, in the same order, with the same text as that
    option's printed span (whitespace/line breaks aside), and the stem must equal the printed
    stem span. So swapped texts, text moved between stem and options and rewritten text are all
    rejected (the printed version is kept, with a warning). When the pre-extractor found no
    options, the LLM split is accepted only if stem + label + text + ... reproduces the printed
    question text exactly.
    """
    issues: list[ValidationIssue] = []
    keys = [canonical_key(o.label) for o in proposal.options]
    keys_ok = all(keys) and len(set(keys)) == len(keys)
    llm_stem = proposal.stem.strip()

    if not pre.options and proposal.options:
        llm_options = [(k, o.text.strip()) for k, o in zip(keys, proposal.options, strict=True)]
        # The labels must form a complete sequence from the first label, so an option cannot
        # be folded into the stem (``stem 가. x`` + ``나. y`` also reproduces the print).
        if keys_ok and _is_sequence(keys) and _reproduces(pre.stem, llm_stem, llm_options):
            return llm_stem, llm_options, issues
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM split of stem and options does not reproduce the printed question; "
                "the printed text was kept.",
                field="options",
            )
        )
        return pre.stem, pre.options, issues

    stem = pre.stem
    if llm_stem and loose_text(llm_stem) == loose_text(pre.stem):
        stem = llm_stem
    else:
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM stem differs from the printed stem; the printed stem was kept.",
                field="stem",
            )
        )
    if not pre.options:
        return stem, pre.options, issues
    if not proposal.options:
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM dropped printed options; the printed options were kept.",
                field="options",
            )
        )
    elif not (
        keys_ok
        and keys == [k for k, _ in pre.options]
        and all(
            loose_text(o.text) == loose_text(text)
            for o, (_, text) in zip(proposal.options, pre.options, strict=True)
        )
    ):
        issues.append(
            issue(
                "llm_text_rejected",
                "LLM options do not match the printed label-text pairs; "
                "the printed options were kept.",
                field="options",
            )
        )
    return stem, pre.options, issues


def _reproduces(printed: str, stem: str, options: Sequence[tuple[str, str]]) -> bool:
    """Whether ``stem`` followed by each option's printed marker and text is exactly
    ``printed`` (compared without whitespace, NFKC: ``①`` reads as ``1``)."""
    target = loose_text(printed)
    pos = len(loose_text(stem))
    if pos == 0 or not target.startswith(loose_text(stem)):
        return False
    for key, text in options:
        marker = re.compile(rf"\(?{re.escape(key)}[.)]?", re.IGNORECASE)
        match = marker.match(target, pos)
        body = loose_text(text)
        if match is None or not body or not target.startswith(body, match.end()):
            return False
        pos = match.end() + len(body)
    return pos == len(target)


def _llm_answer_matches_key(
    question_type: QuestionType,
    option_labels: Sequence[str] | None,
    text_answers: Sequence[str] | None,
    entries: Sequence[AnswerKeyEntry],
) -> bool:
    if len({e.text for e in entries}) != 1:
        return False
    key_text = entries[0].text
    if question_type is QuestionType.MCQ:
        key_keys = answer_option_keys(key_text)
        if not option_labels or text_answers or key_keys is None:
            return False
        return {canonical_key(label) for label in option_labels} == set(key_keys)
    if not text_answers or option_labels:
        return False
    return all(loose_text(t) and loose_text(t) in loose_text(key_text) for t in text_answers)


# ------------------------------------------------------------------------------------------
# Draft assembly


def _evidence(
    raw: RawQuestion,
    figures: Sequence[RawFigure],
    blocks: Sequence[Block],
    document_id: str,
    revision_id: str | None,
) -> tuple[SourceEvidence, ...]:
    own = [blocks[i] for i in sorted(set(raw.block_indices))]
    evidence = [
        SourceEvidence(
            document_id=document_id,
            revision_id=revision_id,
            block_ids=tuple(b.id for b in own),
            locations=union_locations(own),
        )
    ]
    for figure in figures:
        parts = [b for b in (figure.image, figure.caption.block if figure.caption else None) if b]
        if not parts:
            continue
        evidence.append(
            SourceEvidence(
                document_id=document_id,
                revision_id=revision_id,
                block_ids=tuple(dict.fromkeys(b.id for b in parts)),
                locations=tuple(
                    loc.model_copy(update={"block_id": b.id}) for b in parts for loc in b.locations
                ),
                quote=figure.caption.text if figure.caption is not None else None,
            )
        )
    return tuple(evidence)


def _build_draft(
    candidate: _Candidate, *, draft_id: str, evidence: tuple[SourceEvidence, ...]
) -> QuestionDraft | None:
    if not candidate.stem.strip():
        return None
    options = tuple(
        QuestionOption(id=option_id(k), text=t or "(빈 선택지)") for k, t in candidate.options
    )
    correct = candidate.correct_option_ids
    option_ids = {o.id for o in options}
    if correct is not None and not set(correct) <= option_ids:
        correct = None
    issues = candidate.issues + structural_issues(
        question_type=candidate.question_type,
        options=options,
        correct_option_ids=correct,
        accepted_answers=candidate.accepted_answers,
        evidence=evidence,
        multi_select=candidate.multi_select,
    )
    return QuestionDraft(
        id=draft_id,
        origin=DraftOrigin.PDF_IMPORT,
        question_type=candidate.question_type,
        stem=candidate.stem.strip(),
        options=options,
        correct_option_ids=correct,
        accepted_answers=candidate.accepted_answers,
        evidence=evidence,
        generator=candidate.generator,
        validations=tuple(_dedupe(issues)),
        review_status=ReviewStatus.PENDING,
    )


def _dedupe(issues: Sequence[ValidationIssue]) -> list[ValidationIssue]:
    return list(dict.fromkeys(issues))


def _document_warnings(
    questions: Sequence[RawQuestion],
    answer_key: Sequence[AnswerKeyEntry],
    unparsed: int,
    ambiguous_tables: int = 0,
) -> list[ValidationIssue]:
    warnings: list[ValidationIssue] = []
    if not questions:
        warnings.append(issue("no_questions_found", "No numbered questions were found."))
        return warnings
    numbers = sorted({q.number for q in questions})
    missing = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers))
    if missing:
        warnings.append(
            issue(
                "question_number_gap",
                "Question numbers are missing: " + ", ".join(map(str, missing)) + ".",
            )
        )
    if not answer_key:
        warnings.append(
            issue("answer_key_missing", "No answer key was found; all answers are empty.")
        )
    unknown = sorted({e.number for e in answer_key} - set(numbers))
    if unknown:
        warnings.append(
            issue(
                "answer_key_unknown_number",
                "The answer key lists numbers without a question: "
                + ", ".join(map(str, unknown))
                + ".",
            )
        )
    if ambiguous_tables:
        warnings.append(
            issue(
                "answer_key_table_ambiguous",
                f"{ambiguous_tables} answer key table(s) can be read row- or column-wise; "
                "no answers were taken from them.",
            )
        )
    if unparsed:
        warnings.append(
            issue(
                "answer_key_unparsed",
                f"{unparsed} answer key line(s) could not be read.",
            )
        )
    return warnings
