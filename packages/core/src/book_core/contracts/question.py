"""Question draft contracts shared by PDF import (extractor) and variant generation.

Source: docs/questions.md §4 (stable option ids), §5 (variation types, validation, lineage and
provenance fields, human approval), §6 (import: answer may be null, page/area provenance, source
type preserved), docs/architecture.md §4 (``QuestionDraft``), §5 (``question_type``), screens
QIMPORT-01 / QGEN-01.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from book_core.contracts.common import (
    CoreModel,
    Identifier,
    NonEmptyText,
    SourceLocation,
    ensure_unique,
)


class QuestionType(StrEnum):
    MCQ = "MCQ"
    SHORT_ANSWER = "SHORT_ANSWER"
    ESSAY = "ESSAY"


class VariationType(StrEnum):
    OPTION_SHUFFLE = "OPTION_SHUFFLE"
    PARAPHRASE = "PARAPHRASE"
    INVERT_POLARITY = "INVERT_POLARITY"
    ANALOGOUS_CONCEPT = "ANALOGOUS_CONCEPT"


DRAFT_VARIATION_TYPES: frozenset[VariationType] = frozenset(
    {VariationType.PARAPHRASE, VariationType.INVERT_POLARITY, VariationType.ANALOGOUS_CONCEPT}
)
"""Variations that produce a draft; OPTION_SHUFFLE never creates a question (questions.md §5)."""


class DraftOrigin(StrEnum):
    """How the draft was produced; kept separate so the shared review UI can tell them apart."""

    PDF_IMPORT = "pdf_import"
    GENERATION = "generation"


class ReviewStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ValidationSeverity(StrEnum):
    WARNING = "warning"
    ERROR = "error"


class ValidationIssue(CoreModel):
    """A machine validation result. ``error`` blocks approval; ``warning`` needs human review."""

    code: Identifier
    severity: ValidationSeverity
    message: NonEmptyText
    field: str | None = None


class QuestionOption(CoreModel):
    """An MCQ option. Grading uses ``id``, never display position (questions.md §4)."""

    id: Identifier
    text: NonEmptyText


class SourceEvidence(CoreModel):
    """Where the draft comes from or what justifies its answer.

    Import: the page/area of the question PDF. Generation: the source passage(s) used.
    """

    document_id: Identifier
    revision_id: Identifier | None = None
    block_ids: tuple[Identifier, ...] = ()
    locations: Annotated[tuple[SourceLocation, ...], Field(min_length=1)]
    quote: str | None = None


class GeneratorInfo(CoreModel):
    """LLM model and prompt version used to produce the draft (questions.md §5)."""

    model: NonEmptyText
    prompt_version: NonEmptyText


class QuestionDraft(CoreModel):
    """An extracted or generated question awaiting human review.

    Drafts may be incomplete (missing options or answer); completeness problems are reported in
    ``validations``, not by rejecting the draft. ``correct_option_ids`` / ``accepted_answers`` are
    ``None`` when unknown: import must never invent an answer (QIMPORT-01-AC02).
    """

    schema_version: Literal[1] = 1
    id: Identifier
    origin: DraftOrigin
    question_type: QuestionType
    stem: NonEmptyText
    options: tuple[QuestionOption, ...] = ()
    correct_option_ids: tuple[Identifier, ...] | None = None
    accepted_answers: tuple[NonEmptyText, ...] | None = None
    explanation: str | None = None
    justification: str | None = None
    evidence: tuple[SourceEvidence, ...] = ()
    variation_type: VariationType | None = None
    parent_question_id: Identifier | None = None
    source_question_revision_id: Identifier | None = None
    generator: GeneratorInfo | None = None
    validations: tuple[ValidationIssue, ...] = ()
    review_status: ReviewStatus = ReviewStatus.PENDING

    @model_validator(mode="after")
    def _check(self) -> Self:
        option_ids = [o.id for o in self.options]
        ensure_unique(option_ids, "option id")
        if self.correct_option_ids is not None:
            ensure_unique(list(self.correct_option_ids), "correct option id")
            unknown = set(self.correct_option_ids) - set(option_ids)
            if unknown:
                raise ValueError(f"correct_option_ids not among options: {sorted(unknown)}")

        lineage = (self.variation_type, self.parent_question_id, self.source_question_revision_id)
        if self.origin is DraftOrigin.GENERATION:
            if self.variation_type not in DRAFT_VARIATION_TYPES:
                raise ValueError(
                    "generated drafts need variation_type PARAPHRASE, INVERT_POLARITY "
                    "or ANALOGOUS_CONCEPT"
                )
            if self.parent_question_id is None or self.source_question_revision_id is None:
                raise ValueError(
                    "generated drafts need parent_question_id and source_question_revision_id"
                )
        elif any(value is not None for value in lineage):
            raise ValueError("imported drafts cannot carry variation or lineage fields")

        if self.review_status is ReviewStatus.APPROVED and self.has_blocking_issues:
            raise ValueError("a draft with error-level validations cannot be approved")
        return self

    @property
    def has_blocking_issues(self) -> bool:
        return any(v.severity is ValidationSeverity.ERROR for v in self.validations)
