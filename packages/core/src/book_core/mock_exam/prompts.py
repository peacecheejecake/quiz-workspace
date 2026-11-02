"""The batched prompt and structured output of ``mock_exam.generate/v1`` (MOCK-01 "LLM 호출
묶기").

One call = one batch. Each source is a block tagged ``S1``..``Sn`` holding the source question
verbatim (stem, options with their numbers, answer, explanation), a ``variation_type:`` line and
the tags of its passages; each passage of the batch appears once, tagged ``P1``..``Pk``. The
model answers one item per source with that source's tag. Its output is a proposal only: every
item is validated on its own against its source (:mod:`book_core.mock_exam.validation`).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict

from book_core.contracts import Excerpt, VariationType
from book_core.generation import Difficulty, LLMCitation, LLMVariantOption, SourceQuestion
from book_core.llm import LLMRequest

TASK = "mock_exam.generate"
PROMPT_VERSION = "mock_exam.generate/v1"

_RULES = """\
You write exam questions for a mock exam. Every source question below gets exactly one new
question, written according to that source's variation_type. Answer with one item per source,
with its source_tag (S1, S2, ...) and its variation_type, in source order.

Output rules (each item):
- Write in the language of its source question.
- question_type: MCQ (with options), SHORT_ANSWER or ESSAY.
- For MCQ: options get distinct labels ("1", "2", ...); correct_option_labels lists the labels
  of every correct option; accepted_answers is null; multi_select is true exactly when the stem
  asks for several options.
- For SHORT_ANSWER: options is empty, correct_option_labels is null, accepted_answers lists the
  accepted answers. For ESSAY: options is empty, correct_option_labels is null and
  accepted_answers may be null (put grading points in explanation).
- justification explains why the answer is correct, based on the passages.
- citations: at least one {passage_id, quote} per item when its source lists passages; quote
  must be copied verbatim from that passage (a sentence or phrase), never invented. Cite only
  the passages its own source lists; an item whose source lists none has no citations.
- Never copy a source question unchanged and never repeat an item.
- Use only facts from the source question and the passages.

Variation types:
- PARAPHRASE: reword the stem and options so the question tests the same concept at the same
  difficulty with the same correct answer(s). Keep the question type and the number of correct
  options.
- INVERT_POLARITY: invert the polarity of the stem (e.g. "옳지 않은 것은?" <-> "옳은 것은?") and
  set the answer that is correct for the inverted stem. If inverting changes how many options are
  correct, rebuild the options so the intended number of options is correct.
- ANALOGOUS_CONCEPT: a new question of the same type and difficulty about a related concept taken
  from the passages (not the concept the source tests); its answer must follow from the cited
  passage(s)."""

_DIFFICULTY_HINT: dict[Difficulty, str] = {
    Difficulty.EASIER: "Target difficulty: slightly easier than each source question.",
    Difficulty.SAME: "Target difficulty: the same as each source question.",
    Difficulty.HARDER: "Target difficulty: slightly harder than each source question.",
}


class LLMMockItem(BaseModel):
    """One item of ``mock_exam.generate/v1``: an LLM variant plus its source tag and type."""

    model_config = ConfigDict(extra="forbid")

    source_tag: str
    variation_type: str
    question_type: Literal["MCQ", "SHORT_ANSWER", "ESSAY"]
    multi_select: bool
    stem: str
    options: list[LLMVariantOption]
    correct_option_labels: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    justification: str
    citations: list[LLMCitation]


class LLMMockBatch(BaseModel):
    """Structured output schema of ``mock_exam.generate/v1``."""

    model_config = ConfigDict(extra="forbid")

    items: list[LLMMockItem]


@dataclass(frozen=True, slots=True)
class BatchSource:
    """One source of a batch: its tag, pinned question, variation type and passage tags."""

    tag: str
    position: int
    source: SourceQuestion
    variation_type: VariationType
    passage_tags: tuple[str, ...]


def source_tag(index: int) -> str:
    return f"S{index + 1}"


def batch_passage_tag(index: int) -> str:
    return f"P{index + 1}"


def source_block(item: BatchSource) -> str:
    source = item.source
    lines = [
        f"variation_type: {item.variation_type.value}",
        "passages: " + (", ".join(item.passage_tags) or "(none)"),
        f"type: {source.question_type.value}",
        f"multi_select: {source.is_multi_answer}",
        "stem:",
        source.stem,
    ]
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


def passage_block(tag: str, passage: Excerpt) -> str:
    head = " ".join([tag, " > ".join(passage.breadcrumb)]).rstrip()
    return f"<<<{head}\n{passage.text}\n>>>"


def system_prompt(difficulty: Difficulty | None) -> str:
    return _RULES + ("\n" + _DIFFICULTY_HINT[difficulty] if difficulty is not None else "")


def build_batch_request(
    sources: Sequence[BatchSource],
    passages: Sequence[Excerpt],
    *,
    difficulty: Difficulty | None = None,
) -> LLMRequest:
    """The request of one batch. Deterministic: same inputs, same fingerprint."""
    parts = [f"Write exactly {len(sources)} item(s), one per source."]
    if passages:
        parts.append(
            "PASSAGES:\n"
            + "\n".join(passage_block(batch_passage_tag(i), p) for i, p in enumerate(passages))
        )
    else:
        parts.append("PASSAGES: (none; citations must be empty)")
    parts.append("SOURCES:\n" + "\n".join(f"<<<{s.tag}\n{source_block(s)}\n>>>" for s in sources))
    return LLMRequest(
        task=TASK,
        prompt_version=PROMPT_VERSION,
        system=system_prompt(difficulty),
        prompt="\n\n".join(parts),
    )


def base_prompt_text(difficulty: Difficulty | None) -> str:
    """The text every request carries besides its sources and passages (token budget)."""
    return system_prompt(difficulty) + "\nWrite exactly 40 item(s), one per source.\nPASSAGES:\n"
