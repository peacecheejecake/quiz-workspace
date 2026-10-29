"""Chapter notes (CHNOTE-01, docs/questions.md §9): a study note of one chapter made from its
CONFIRMED questions and explanations, every item footnoted with its source question(s).

The LLM proposes items with question tags; :mod:`book_core.notes.validation` rejects (once) and
drops anything that cites a question outside the input, cites nothing, or quotes text that is
not in the chapter. Large chapters are batched and merged (:mod:`book_core.notes.generator`).
"""

from book_core.notes.generator import (
    ChapterNoteGenerator,
    NoteCitationError,
    NoteRequest,
    plan_batches,
)
from book_core.notes.models import (
    MAX_BATCH_CHARS,
    MAX_BATCH_QUESTIONS,
    MAX_REFERENCE_CHARS,
    LLMNoteItem,
    LLMNoteOutput,
    LLMNoteSection,
    NoteItem,
    NoteOption,
    NoteQuestion,
    NoteResult,
    NoteSection,
    NoteUsage,
)
from book_core.notes.prompts import PROMPT_VERSION, TASK, build_request, question_size
from book_core.notes.validation import CheckedResponse, check_response

__all__ = [
    "MAX_BATCH_CHARS",
    "MAX_BATCH_QUESTIONS",
    "MAX_REFERENCE_CHARS",
    "PROMPT_VERSION",
    "TASK",
    "ChapterNoteGenerator",
    "CheckedResponse",
    "LLMNoteItem",
    "LLMNoteOutput",
    "LLMNoteSection",
    "NoteCitationError",
    "NoteItem",
    "NoteOption",
    "NoteQuestion",
    "NoteRequest",
    "NoteResult",
    "NoteSection",
    "NoteUsage",
    "build_request",
    "check_response",
    "plan_batches",
    "question_size",
]
