"""Variant generation: one structured LLM call per variation type, then validation.

The generator never raises on LLM behaviour: provider failures, schema-invalid output and
semantically invalid candidates all become :class:`RejectedCandidate` records with structured,
log-safe reasons. Candidates that pass the hard checks become generated ``QuestionDraft`` s in
review status ``pending`` with lineage (parent question, source revision), generator provenance
(model, prompt version) and their remaining validation issues. Nothing is registered as a
question here; that happens only after human approval (M6.2).
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from book_core.contracts import (
    DraftOrigin,
    GeneratorInfo,
    QuestionDraft,
    ValidationIssue,
    VariationType,
)
from book_core.generation.models import (
    GeneratedVariant,
    RejectedCandidate,
    VariantGenerationResult,
    VariantRequest,
)
from book_core.generation.prompts import LLMVariantBatch, build_request
from book_core.generation.validation import (
    VariantContent,
    content_from_llm,
    content_issues,
    is_rejection,
)
from book_core.llm import LLMCallInfo, LLMClient, LLMOutputError, LLMProviderError
from book_core.llm.base import sanitize_validation_error
from book_core.question import issue

logger = logging.getLogger("book_core.generation")


class VariantGenerator:
    """Generates PARAPHRASE / INVERT_POLARITY / ANALOGOUS_CONCEPT drafts through an LLM."""

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def generate(self, request: VariantRequest) -> VariantGenerationResult:
        variants: list[GeneratedVariant] = []
        rejected: list[RejectedCandidate] = []
        calls: list[LLMCallInfo] = []
        accepted_fingerprints: set[str] = set()

        for variation in request.variation_types:
            batch, info, failure = self._call(request, variation)
            if info is not None:
                calls.append(info)
            if failure is not None or batch is None or info is None:
                reason = failure or issue("llm_unavailable", "The LLM call failed.", error=True)
                rejected.append(RejectedCandidate(variation_type=variation, reasons=(reason,)))
                continue
            if not batch.candidates:
                rejected.append(
                    RejectedCandidate(
                        variation_type=variation,
                        reasons=(
                            issue("no_candidates", "The LLM returned no candidates.", error=True),
                        ),
                    )
                )
            for index, candidate in enumerate(batch.candidates):
                if index >= request.candidate_count:
                    rejected.append(
                        RejectedCandidate(
                            variation_type=variation,
                            candidate_index=index,
                            reasons=(
                                issue(
                                    "candidate_over_limit",
                                    f"More than the {request.candidate_count} requested "
                                    "candidate(s).",
                                    error=True,
                                ),
                            ),
                        )
                    )
                    continue
                content, issues = content_from_llm(candidate, request.source, request.passages)
                if content is not None:
                    issues = content_issues(
                        content,
                        variation_type=variation,
                        source=request.source,
                        passages=request.passages,
                        existing_fingerprints=request.existing_fingerprints,
                        sibling_fingerprints=accepted_fingerprints,
                    )
                if content is None or is_rejection(issues):
                    rejected.append(
                        RejectedCandidate(
                            variation_type=variation,
                            candidate_index=index,
                            reasons=tuple(_rejection_reasons(issues)),
                        )
                    )
                    continue
                built = _draft(request, variation, index, content, issues, info)
                if isinstance(built, ValidationIssue):
                    rejected.append(
                        RejectedCandidate(
                            variation_type=variation, candidate_index=index, reasons=(built,)
                        )
                    )
                    continue
                fingerprint = content.fingerprint()
                accepted_fingerprints.add(fingerprint)
                variants.append(
                    GeneratedVariant(draft=built, fingerprint=fingerprint, candidate_index=index)
                )

        logger.info(
            "variant generation source_revision=%s variations=%s drafts=%d rejected=%d "
            "llm_calls=%d",
            request.source.revision_id,
            ",".join(v.value for v in request.variation_types),
            len(variants),
            len(rejected),
            len(calls),
        )
        return VariantGenerationResult(
            variants=tuple(variants), rejected=tuple(rejected), llm_calls=tuple(calls)
        )

    def _call(
        self, request: VariantRequest, variation: VariationType
    ) -> tuple[LLMVariantBatch | None, LLMCallInfo | None, ValidationIssue | None]:
        llm_request = build_request(
            variation,
            request.source,
            request.passages,
            candidate_count=request.candidate_count,
            difficulty=request.difficulty,
        )
        try:
            result = self._llm.complete(llm_request, LLMVariantBatch)
        except LLMOutputError as exc:
            return (
                None,
                exc.call_info,
                issue(
                    "llm_output_invalid",
                    f"The LLM output does not match the variant schema ({exc.detail}).",
                    error=True,
                ),
            )
        except LLMProviderError as exc:
            return (
                None,
                None,
                issue("llm_unavailable", f"The LLM call failed ({exc.kind}).", error=True),
            )
        return result.output, result.info, None


def _rejection_reasons(issues: list[ValidationIssue]) -> list[ValidationIssue]:
    blocking = [i for i in issues if is_rejection([i])]
    return blocking or issues


def _draft(
    request: VariantRequest,
    variation: VariationType,
    index: int,
    content: VariantContent,
    issues: list[ValidationIssue],
    info: LLMCallInfo,
) -> QuestionDraft | ValidationIssue:
    prefix = request.draft_id_prefix or request.source.revision_id
    try:
        return QuestionDraft(
            id=f"{prefix}-{variation.value.lower()}-{index:02d}",
            origin=DraftOrigin.GENERATION,
            question_type=content.question_type,
            stem=content.stem,
            options=content.options,
            correct_option_ids=content.correct_option_ids,
            accepted_answers=content.accepted_answers,
            explanation=content.explanation,
            justification=content.justification,
            evidence=content.evidence,
            variation_type=variation,
            parent_question_id=request.source.question_id,
            source_question_revision_id=request.source.revision_id,
            generator=GeneratorInfo(model=info.model, prompt_version=info.prompt_version),
            validations=tuple(issues),
        )
    except ValidationError as exc:  # defensive: the checks above should make this unreachable
        detail = sanitize_validation_error(exc, QuestionDraft)
        return issue("draft_invalid", f"The candidate is not a valid draft ({detail}).", error=True)
