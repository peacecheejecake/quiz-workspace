"""Versioned prompt of task ``chapter_notes.generate`` (one request per batch).

The model sees the batch's questions tagged ``Q1``..``Qk`` (stem, options with the correct ones
marked, accepted answers, explanation) and, as reference only, the chapter's published text.
Every item must cite at least one question tag; a quote, when given, must be copied verbatim
from the reference text. The output is checked by :mod:`book_core.notes.validation`.
"""

from __future__ import annotations

from collections.abc import Sequence

from book_core.llm import LLMRequest
from book_core.notes.models import MAX_REFERENCE_CHARS, NoteQuestion

TASK = "chapter_notes.generate"
PROMPT_VERSION = f"{TASK}/v1"

SYSTEM = """\
You write a study note for one chapter of a book from the chapter's exam questions and their
explanations. The note summarises what the questions and explanations teach.

Rules:
- Use only facts from the questions, their answers and explanations. The reference text is
  given only to check terms and wording; never add an item that no question supports.
- Every item cites the question(s) it comes from with their tags (e.g. ["Q1", "Q3"]). Use only
  the tags given below. An item without a tag is discarded.
- quote is optional: a short phrase copied verbatim from the reference text, or null. Never
  invent or paraphrase a quote.
- Group items under short section headings. Write in the language of the questions.
- Output JSON only: {"sections": [{"heading": str, "items": [{"text": str, "tags": [str],
  "quote": str | null}]}]}."""


def batch_tag(index: int) -> str:
    return f"Q{index + 1}"


def render_question(question: NoteQuestion, tag: str) -> str:
    lines = [f"[{tag}] {question.label} ({question.question_type})", f"Question: {question.stem}"]
    if question.options:
        lines.append("Options:")
        lines += [
            f"- {option.text}{' (correct)' if option.correct else ''}"
            for option in question.options
        ]
    if question.accepted_answers:
        lines.append("Accepted answers: " + " | ".join(question.accepted_answers))
    if question.explanation:
        lines.append(f"Explanation: {question.explanation}")
    return "\n".join(lines)


def question_size(question: NoteQuestion) -> int:
    """Input characters of one question (what batching limits)."""
    return len(render_question(question, "Q0"))


def reference_excerpt(reference_text: str, limit: int = MAX_REFERENCE_CHARS) -> str:
    """The reference text, cut at a line boundary when it is longer than ``limit``."""
    if len(reference_text) <= limit:
        return reference_text
    cut = reference_text.rfind("\n", 0, limit)
    return reference_text[: cut if cut > 0 else limit]


def build_request(questions: Sequence[NoteQuestion], reference_text: str) -> LLMRequest:
    """One batch: its questions re-tagged ``Q1``..``Qk`` in order, then the reference text."""
    blocks = [render_question(q, batch_tag(i)) for i, q in enumerate(questions)]
    parts = ["Questions:", "\n\n".join(blocks)]
    reference = reference_excerpt(reference_text)
    if reference.strip():
        parts += ["Reference text (for wording only):", reference]
    tags = ", ".join(batch_tag(i) for i in range(len(questions)))
    parts.append(f"Valid tags: {tags}")
    return LLMRequest(
        task=TASK, prompt_version=PROMPT_VERSION, system=SYSTEM, prompt="\n\n".join(parts)
    )
