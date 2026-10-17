"""Variant generation (questions.md §5, Task M6.1): PARAPHRASE, INVERT_POLARITY and
ANALOGOUS_CONCEPT drafts through the provider-agnostic LLM client, with validation of schema,
answer count, duplicate fingerprint and source citations.

OPTION_SHUFFLE is deliberately absent: it never creates a question; the practice session stores
the displayed option order (M5.2, ``quiz_api.practice_grading``).
"""

from book_core.generation.generator import VariantGenerator
from book_core.generation.models import (
    MAX_CANDIDATES_PER_VARIATION,
    MAX_PASSAGES,
    MAX_SOURCE_PAGES,
    Difficulty,
    GeneratedVariant,
    RejectedCandidate,
    SourceQuestion,
    VariantGenerationResult,
    VariantRequest,
    stored_source_evidence,
)
from book_core.generation.prompts import (
    GENERATE_TASKS,
    PROMPT_VERSIONS,
    LLMCitation,
    LLMVariant,
    LLMVariantBatch,
    LLMVariantOption,
    build_request,
    passage_tag,
)
from book_core.generation.validation import (
    ACKNOWLEDGEABLE_CODES,
    REJECT_CODES,
    VariantContent,
    content_from_draft,
    content_issues,
    source_fingerprint,
    validate_variant,
)

__all__ = [
    "ACKNOWLEDGEABLE_CODES",
    "GENERATE_TASKS",
    "MAX_CANDIDATES_PER_VARIATION",
    "MAX_PASSAGES",
    "MAX_SOURCE_PAGES",
    "PROMPT_VERSIONS",
    "REJECT_CODES",
    "Difficulty",
    "GeneratedVariant",
    "LLMCitation",
    "LLMVariant",
    "LLMVariantBatch",
    "LLMVariantOption",
    "RejectedCandidate",
    "SourceQuestion",
    "VariantContent",
    "VariantGenerationResult",
    "VariantGenerator",
    "VariantRequest",
    "build_request",
    "content_from_draft",
    "content_issues",
    "passage_tag",
    "source_fingerprint",
    "stored_source_evidence",
    "validate_variant",
]
