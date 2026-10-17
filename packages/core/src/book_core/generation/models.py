"""Inputs and outputs of variant generation (questions.md §5, QGEN-01).

``SourceQuestion`` is the CONFIRMED question revision a variant is generated from;
``VariantRequest`` is one generation run's parameters; ``VariantGenerationResult`` holds the
drafts that passed the hard checks (with their remaining validation issues) and the candidates
that were rejected, each with structured reasons.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from enum import StrEnum
from typing import Annotated, Any, Self

from pydantic import Field, ValidationError, model_validator

from book_core.contracts import (
    DRAFT_VARIATION_TYPES,
    CoreModel,
    Excerpt,
    Identifier,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    Sha256Hex,
    SourceEvidence,
    SourceLocation,
    ValidationIssue,
    VariationType,
)
from book_core.contracts.common import NonEmptyText, ensure_unique
from book_core.llm import LLMCallInfo, LLMUsage

MAX_CANDIDATES_PER_VARIATION = 20
"""Matches ``question_generation_runs.candidate_count`` (1..20)."""

MAX_PASSAGES = 8
"""Source passages sent to the LLM in one request."""

MAX_SOURCE_PAGES = 50
"""Pages of one stored source range turned into page-level locations."""


class Difficulty(StrEnum):
    """Optional target difficulty relative to the source question."""

    EASIER = "easier"
    SAME = "same"
    HARDER = "harder"


class SourceQuestion(CoreModel):
    """The CONFIRMED question revision variants are generated from.

    ``evidence`` is the source question's own provenance; a PARAPHRASE / INVERT_POLARITY draft
    without cited passages inherits it.
    """

    question_id: Identifier
    revision_id: Identifier
    question_type: QuestionType
    stem: NonEmptyText
    options: tuple[QuestionOption, ...] = ()
    correct_option_ids: tuple[Identifier, ...] | None = None
    accepted_answers: tuple[NonEmptyText, ...] | None = None
    is_multi_answer: bool = False
    explanation: str | None = None
    evidence: tuple[SourceEvidence, ...] = ()

    @model_validator(mode="after")
    def _check(self) -> Self:
        ids = [o.id for o in self.options]
        ensure_unique(ids, "option id")
        if self.correct_option_ids is not None and not set(self.correct_option_ids) <= set(ids):
            raise ValueError("correct_option_ids not among options")
        return self


def stored_source_evidence(
    *,
    document_id: str,
    revision_id: str | None,
    page_start: int | None,
    page_end: int | None,
    block_ids: Sequence[str] = (),
    locations: Sequence[Mapping[str, Any]] = (),
) -> SourceEvidence | None:
    """A stored question source (``question_sources`` row) as the source question's evidence.

    The worker (generation) and the API (re-validation of a reviewer's edit) must build the
    same value, so a draft that inherited the source's provenance stays valid. Stored
    ``locations`` win; otherwise the page range (capped at :data:`MAX_SOURCE_PAGES`) becomes
    page-level locations. ``None`` without any location.
    """
    found: list[SourceLocation] = []
    for raw in locations:
        try:
            found.append(SourceLocation.model_validate(raw))
        except ValidationError:
            continue
    if not found and page_start is not None and page_start >= 1:
        end = min(max(page_end or page_start, page_start), page_start + MAX_SOURCE_PAGES)
        found = [SourceLocation(page=p) for p in range(page_start, end + 1)]
    if not found:
        return None
    try:
        return SourceEvidence(
            document_id=document_id,
            revision_id=revision_id,
            block_ids=tuple(block_ids),
            locations=tuple(found),
        )
    except ValidationError:
        return None


class VariantRequest(CoreModel):
    """One generation run: which variations, how many candidates each, and which passages.

    ``passages`` are paragraph-complete excerpts (M2.5) of the source question's sources and,
    for ANALOGOUS_CONCEPT, of semantically related sections; candidates must cite them.
    ``existing_fingerprints`` are :func:`book_core.question.question_fingerprint` values of
    questions already in the workspace, so duplicates of them are rejected.

    OPTION_SHUFFLE is not accepted: it never creates a question; it is the practice session's
    displayed option order (``quiz_api.practice_grading.shuffled_option_ids``).
    """

    source: SourceQuestion
    variation_types: Annotated[tuple[VariationType, ...], Field(min_length=1, max_length=3)]
    candidate_count: Annotated[int, Field(ge=1, le=MAX_CANDIDATES_PER_VARIATION)] = 1
    passages: Annotated[tuple[Excerpt, ...], Field(max_length=MAX_PASSAGES)] = ()
    difficulty: Difficulty | None = None
    existing_fingerprints: frozenset[Sha256Hex] = frozenset()
    draft_id_prefix: Identifier | None = None
    """Prefix of draft ids (default: the source revision id); ids are
    ``<prefix>-<variation>-<candidate index>``."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if VariationType.OPTION_SHUFFLE in self.variation_types:
            raise ValueError(
                "OPTION_SHUFFLE does not generate questions; it is stored on the practice session"
            )
        if not set(self.variation_types) <= DRAFT_VARIATION_TYPES:  # pragma: no cover
            raise ValueError("unsupported variation type")
        ensure_unique([v.value for v in self.variation_types], "variation type")
        if VariationType.ANALOGOUS_CONCEPT in self.variation_types and not self.passages:
            raise ValueError("ANALOGOUS_CONCEPT needs source passages (document search excerpts)")
        return self


class RejectedCandidate(CoreModel):
    """A candidate (or a whole LLM call, ``candidate_index`` None) that produced no draft.

    ``reasons`` are safe to log and store: they never quote the model output or book text.
    """

    variation_type: VariationType
    candidate_index: Annotated[int, Field(ge=0)] | None = None
    reasons: Annotated[tuple[ValidationIssue, ...], Field(min_length=1)]


class GeneratedVariant(CoreModel):
    """A draft that passed the hard checks, with its content fingerprint."""

    draft: QuestionDraft
    fingerprint: Sha256Hex
    candidate_index: Annotated[int, Field(ge=0)]


class VariantGenerationResult(CoreModel):
    variants: tuple[GeneratedVariant, ...] = ()
    rejected: tuple[RejectedCandidate, ...] = ()
    llm_calls: tuple[LLMCallInfo, ...] = ()

    @property
    def drafts(self) -> tuple[QuestionDraft, ...]:
        return tuple(v.draft for v in self.variants)

    @property
    def llm_usage(self) -> LLMUsage:
        total = LLMUsage()
        for call in self.llm_calls:
            total = total + call.usage
        return total
