"""Optional LLM refinement of one pre-extracted question (versioned prompt, structured output).

The model sees only that question's own printed lines (stem, options, figure caption) and the
answer-key line(s) printed for its number, never the rest of the document. Its output is a
proposal: the extractor accepts only text that is present in those lines and only answers that
the printed answer key states (questions.md §6, QIMPORT-01-AC02).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from book_core.llm import LLMRequest

EXTRACT_TASK = "questions.extract"
EXTRACT_PROMPT_VERSION = "questions.extract/v1"

SYSTEM_PROMPT = """\
You convert one printed exam question into structured data for a question bank.

Rules:
- Copy the stem and option texts exactly as printed (fix only broken line breaks and spacing).
  Do not paraphrase, translate, complete or correct them.
- Do not include the question number in the stem or the option labels in option texts.
- question_type: MCQ when the question has options; ESSAY when it asks for a written
  explanation (e.g. 서술하시오, 설명하시오, explain, describe); otherwise SHORT_ANSWER.
- multi_select: true only for an MCQ whose stem asks for every / several correct options.
- options: one entry per printed option, label exactly as printed (e.g. "①", "A").
- answer: only when the ANSWER KEY section below states it. Never solve the question or infer
  an answer yourself. With no answer key line, answer must be null.
  For MCQ give option_labels (as printed in the answer key) and text_answers null; otherwise
  give text_answers and option_labels null."""


class LLMOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    text: str


class LLMAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    option_labels: list[str] | None
    text_answers: list[str] | None


class LLMQuestion(BaseModel):
    """Structured output schema of ``questions.extract/v1``."""

    model_config = ConfigDict(extra="forbid")

    question_type: Literal["MCQ", "SHORT_ANSWER", "ESSAY"]
    multi_select: bool
    stem: str
    options: list[LLMOption]
    answer: LLMAnswer | None


def build_request(question_lines: Sequence[str], answer_key_lines: Sequence[str]) -> LLMRequest:
    """The request for one question. Deterministic: the same source gives the same fingerprint."""
    key = "\n".join(answer_key_lines) if answer_key_lines else "(none)"
    prompt = (
        "QUESTION (as printed):\n"
        "<<<\n" + "\n".join(question_lines) + "\n>>>\n\n"
        "ANSWER KEY (printed lines for this question number):\n"
        "<<<\n" + key + "\n>>>"
    )
    return LLMRequest(
        task=EXTRACT_TASK,
        prompt_version=EXTRACT_PROMPT_VERSION,
        system=SYSTEM_PROMPT,
        prompt=prompt,
    )
