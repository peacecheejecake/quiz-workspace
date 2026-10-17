"""Versioned prompts and the structured-output schema of variant generation.

One LLM call per variation type returns up to ``candidate_count`` candidates. The model sees
the source question (with its answer, so it can keep or deliberately change it) and the source
passages, each tagged ``P1``, ``P2``, ...; every candidate must cite passages by tag with a
verbatim quote. The output is a proposal: the declared answer and citations are validated by
:mod:`book_core.generation.validation`, never trusted (questions.md §5).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from book_core.contracts import Excerpt, VariationType
from book_core.generation.models import Difficulty, SourceQuestion
from book_core.llm import LLMRequest

GENERATE_TASKS: dict[VariationType, str] = {
    VariationType.PARAPHRASE: "questions.generate.paraphrase",
    VariationType.INVERT_POLARITY: "questions.generate.invert_polarity",
    VariationType.ANALOGOUS_CONCEPT: "questions.generate.analogous_concept",
}
PROMPT_VERSIONS: dict[VariationType, str] = {
    variation: f"{task}/v1" for variation, task in GENERATE_TASKS.items()
}

_COMMON_RULES = """\
You write variant exam questions for a personal question bank. A human reviews every draft.

Output rules:
- Write in the language of the source question.
- question_type: MCQ (with options), SHORT_ANSWER or ESSAY.
- For MCQ: options get distinct labels ("1", "2", ...); correct_option_labels lists the labels
  of every correct option; accepted_answers is null; multi_select is true exactly when the stem
  asks for several options.
- For SHORT_ANSWER: options is empty, correct_option_labels is null, accepted_answers lists the
  accepted answers. For ESSAY: options is empty, correct_option_labels is null and
  accepted_answers may be null (put grading points in explanation).
- justification explains why the answer is correct, based on the passages.
- citations: at least one {passage_id, quote} per candidate when passages are given; quote
  must be copied verbatim from that passage (a sentence or phrase), never invented.
- Never copy the source question unchanged and never repeat a candidate.
- Use only facts from the source question and the passages."""

_VARIATION_RULES: dict[VariationType, str] = {
    VariationType.PARAPHRASE: """\
Variation: PARAPHRASE.
Reword the stem and options so the question tests the same concept at the same difficulty with
the same correct answer(s). Keep the question type and the number of correct options.""",
    VariationType.INVERT_POLARITY: """\
Variation: INVERT_POLARITY.
Invert the polarity of the stem (e.g. "옳지 않은 것은?" <-> "옳은 것은?", "not true" <-> "true")
and set the answer that is correct for the inverted stem. Inverting can change how many
options are correct; then either rebuild the options so the intended number of options is
correct, or make the question explicitly multi-select. State in justification how the answer
count changed.""",
    VariationType.ANALOGOUS_CONCEPT: """\
Variation: ANALOGOUS_CONCEPT.
Write a new question of the same type and difficulty about a related concept taken from the
passages (not the concept the source question tests). Its answer must follow from the cited
passage(s).""",
}

_DIFFICULTY_HINT: dict[Difficulty, str] = {
    Difficulty.EASIER: "Target difficulty: slightly easier than the source question.",
    Difficulty.SAME: "Target difficulty: the same as the source question.",
    Difficulty.HARDER: "Target difficulty: slightly harder than the source question.",
}


class LLMVariantOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    text: str


class LLMCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passage_id: str
    quote: str


class LLMVariant(BaseModel):
    """One candidate of ``questions.generate.*/v1``."""

    model_config = ConfigDict(extra="forbid")

    question_type: Literal["MCQ", "SHORT_ANSWER", "ESSAY"]
    multi_select: bool
    stem: str
    options: list[LLMVariantOption]
    correct_option_labels: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    justification: str
    citations: list[LLMCitation]


class LLMVariantBatch(BaseModel):
    """Structured output schema of ``questions.generate.*/v1``."""

    model_config = ConfigDict(extra="forbid")

    candidates: list[LLMVariant]


def passage_tag(index: int) -> str:
    return f"P{index + 1}"


def _source_block(source: SourceQuestion) -> str:
    lines = [f"type: {source.question_type.value}", f"multi_select: {source.is_multi_answer}"]
    lines.append("stem:")
    lines.append(source.stem)
    labels = {o.id: str(n) for n, o in enumerate(source.options, start=1)}
    if source.options:
        lines.append("options:")
        lines += [f"{labels[o.id]}. {o.text}" for o in source.options]
    if source.correct_option_ids is not None:
        answer = ", ".join(labels[i] for i in source.correct_option_ids)
        lines.append(f"correct options: {answer or '(none)'}")
    if source.accepted_answers is not None:
        lines.append("accepted answers: " + " | ".join(source.accepted_answers))
    if source.explanation:
        lines.append("explanation:")
        lines.append(source.explanation)
    return "\n".join(lines)


def build_request(
    variation: VariationType,
    source: SourceQuestion,
    passages: Sequence[Excerpt],
    *,
    candidate_count: int,
    difficulty: Difficulty | None = None,
) -> LLMRequest:
    """The request for one variation. Deterministic: same inputs, same fingerprint."""
    system = _COMMON_RULES + "\n\n" + _VARIATION_RULES[variation]
    if difficulty is not None:
        system += "\n" + _DIFFICULTY_HINT[difficulty]
    parts = [
        f"Write {candidate_count} distinct candidate(s).",
        "SOURCE QUESTION:\n<<<\n" + _source_block(source) + "\n>>>",
    ]
    if passages:
        tagged = [
            " ".join([f"[{passage_tag(i)}]", " > ".join(p.breadcrumb)]).rstrip() + "\n" + p.text
            for i, p in enumerate(passages)
        ]
        parts.append("PASSAGES:\n<<<\n" + "\n\n".join(tagged) + "\n>>>")
    else:
        parts.append("PASSAGES: (none; citations must be empty)")
    return LLMRequest(
        task=GENERATE_TASKS[variation],
        prompt_version=PROMPT_VERSIONS[variation],
        system=system,
        prompt="\n\n".join(parts),
    )
