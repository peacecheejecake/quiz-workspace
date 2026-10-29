"""Document summaries (DOCSUM-01): chapter inputs, content-addressed units, map/reduce.

The worker (`document.summarize`) feeds a published revision through ``chapter_inputs`` and
``summarize_revision`` with an ``LLMSummarizer`` (or, under APP_ENV=test only, the
``ExtractiveFakeSummarizer``). Nothing here logs; errors carry metadata only.
"""

from book_core.summary.chapters import chapter_inputs, question_block_indices, split_blocks
from book_core.summary.models import (
    BODY_SECTION_KEY,
    CHAPTER_SCOPE,
    DOCUMENT_SCOPE,
    DOCUMENT_SECTION_KEY,
    PROMPT_VERSION,
    ChapterInput,
    InputBlock,
    KeyPoint,
    PageRange,
    SummaryBody,
    clamp_body,
    document_input_hash,
)
from book_core.summary.pipeline import (
    DEFAULT_CHAPTER_CHARS,
    DEFAULT_MAX_INPUT_CHARS,
    StoredUnit,
    SummaryLimits,
    SummaryResult,
    SummaryTally,
    SummaryTooLargeError,
    UnitStore,
    summarize_revision,
)
from book_core.summary.summarizer import (
    SUMMARY_FAILURE_MARKER,
    SUMMARY_HOLD_MARKER,
    SUMMARY_SLOW_MARKER,
    ChapterDigest,
    ExtractiveFakeSummarizer,
    LLMSummarizer,
    LLMSummaryOutput,
    Summarizer,
    SummaryCall,
)

__all__ = [
    "BODY_SECTION_KEY",
    "CHAPTER_SCOPE",
    "DEFAULT_CHAPTER_CHARS",
    "DEFAULT_MAX_INPUT_CHARS",
    "DOCUMENT_SCOPE",
    "DOCUMENT_SECTION_KEY",
    "PROMPT_VERSION",
    "SUMMARY_FAILURE_MARKER",
    "SUMMARY_HOLD_MARKER",
    "SUMMARY_SLOW_MARKER",
    "ChapterDigest",
    "ChapterInput",
    "ExtractiveFakeSummarizer",
    "InputBlock",
    "KeyPoint",
    "LLMSummarizer",
    "LLMSummaryOutput",
    "PageRange",
    "StoredUnit",
    "Summarizer",
    "SummaryBody",
    "SummaryCall",
    "SummaryLimits",
    "SummaryResult",
    "SummaryTally",
    "SummaryTooLargeError",
    "UnitStore",
    "chapter_inputs",
    "clamp_body",
    "document_input_hash",
    "question_block_indices",
    "split_blocks",
    "summarize_revision",
]
