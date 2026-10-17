"""Question PDF extraction into ``QuestionDraft`` without inventing answers: Task M4.3."""

from book_core.extractor.extractor import (
    EXTRACTOR_VERSION,
    ExtractedQuestion,
    QuestionExtraction,
    QuestionExtractor,
    llm_requests,
)
from book_core.extractor.llm_refine import (
    EXTRACT_PROMPT_VERSION,
    EXTRACT_TASK,
    LLMAnswer,
    LLMOption,
    LLMQuestion,
    build_request,
)

__all__ = [
    "EXTRACTOR_VERSION",
    "EXTRACT_PROMPT_VERSION",
    "EXTRACT_TASK",
    "ExtractedQuestion",
    "LLMAnswer",
    "LLMOption",
    "LLMQuestion",
    "QuestionExtraction",
    "QuestionExtractor",
    "build_request",
    "llm_requests",
]
