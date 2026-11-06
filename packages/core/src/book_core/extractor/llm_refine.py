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
EXTRACT_PROMPT_VERSION = "questions.extract/v5"

SYSTEM_PROMPT = """\
You convert one printed exam question into structured data for a question bank.

Rules:
- Copy the stem and option texts exactly as printed (fix only broken line breaks and spacing).
  Do not paraphrase, translate, complete or correct them.
- Stem layout: join a sentence wrapped over several printed lines with a space. When the stem
  lists labelled items between the question sentence and the options (e.g. "(가) ...",
  "ㄱ. ...", "(A) ...", "㉠ ...", "⑴ ..."), put a blank line after the question sentence and
  each item on its own line, starting with its label as printed; a wrapped item line continues
  its item with a space. A label mentioned inside a sentence ("(가)와 (나)에") is not an item.
- Passages: when a titled passage such as "<제목>" or "〈제목〉" follows the question sentence, put
  a blank line before it and after it. The title takes its own line, then its text, with each
  item starting with "∙", "·" or "•" on its own line and each " - " sub-item on its own line
  under its item. Keep every mark as printed. Do not break a range, a number, a word such as
  "A·B" or a hyphen inside a sentence. A title mentioned inside a sentence ("<보기>에서") is not
  a passage.
- Tables: lines starting with "|" are the rows of a table printed in the question. Copy them
  verbatim into the stem where they were printed, one row per line and the "| --- |" row included,
  with a blank line before and after the table. Never rewrite, summarize or drop a table.
- Do not include the question number in the stem or the option labels in option texts.
- question_type: MCQ when the question has options; ESSAY when it asks for a written
  explanation (e.g. 서술하시오, 설명하시오, explain, describe); otherwise SHORT_ANSWER.
- multi_select: true only for an MCQ whose stem asks for every / several correct options.
- options: one entry per printed option, label exactly as printed (e.g. "①", "A").
  Lettered items such as "(가) ..." / "(A) ..." printed between the question sentence and the
  numbered options are part of the stem, never options; keep option texts such as "(가), (나)"
  whole. An answer line such as "(정 답) ③" is not an option.
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
    """Structured output schema of ``questions.extract/v5``."""

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
