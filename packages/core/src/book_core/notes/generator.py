"""Chapter note generation: batches, one LLM call per batch (+ one re-request), merge.

Batching (CHNOTE-01-C04, assumption N10): the chapter's questions, in Heatmap order, are split
into contiguous batches of at most ``MAX_BATCH_QUESTIONS`` questions and ``MAX_BATCH_CHARS``
input characters; greedy filling gives the fewest batches. A single question larger than the
character limit gets a batch of its own.

Per batch the questions are tagged ``Q1``..``Qk``; a response that cites an unknown tag or a
quote missing from the reference text is re-requested once and, from the second response, the
invalid items are dropped (:mod:`book_core.notes.validation`). Batch tags are then mapped back
to the chapter-wide tags and sections with the same heading are merged in first-seen order.

Errors: :class:`NoteCitationError` when no item survives (``note_citation_invalid``);
``LLMOutputError`` (schema) and ``LLMProviderError`` propagate for the caller to classify.
Nothing here logs prompt, question or output text.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from book_core.llm import LLMCallInfo, LLMClient, LLMRequest
from book_core.notes.models import (
    MAX_BATCH_CHARS,
    MAX_BATCH_QUESTIONS,
    LLMNoteOutput,
    NoteItem,
    NoteQuestion,
    NoteResult,
    NoteSection,
    NoteUsage,
)
from book_core.notes.prompts import PROMPT_VERSION, batch_tag, build_request, question_size
from book_core.notes.validation import CheckedResponse, check_response

logger = logging.getLogger("book_core.notes")


class NoteCitationError(Exception):
    """No item of the note could be traced to an input question."""

    code = "note_citation_invalid"


def plan_batches(
    sizes: Sequence[int],
    *,
    max_questions: int = MAX_BATCH_QUESTIONS,
    max_chars: int = MAX_BATCH_CHARS,
) -> list[range]:
    """Contiguous index ranges covering ``sizes`` with the fewest batches under both limits."""
    batches: list[range] = []
    start = 0
    total = 0
    for index, size in enumerate(sizes):
        count = index - start
        if count and (count >= max_questions or total + size > max_chars):
            batches.append(range(start, index))
            start, total = index, 0
        total += size
    if start < len(sizes):
        batches.append(range(start, len(sizes)))
    return batches


@dataclass(frozen=True)
class NoteRequest:
    questions: tuple[NoteQuestion, ...]
    reference_text: str


Progress = Callable[[int, int], None]


class ChapterNoteGenerator:
    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def generate(
        self,
        request: NoteRequest,
        *,
        progress: Progress | None = None,
        check: Callable[[], None] | None = None,
    ) -> NoteResult:
        """``progress(done, total)`` after each batch; ``check()`` before each LLM call (e.g. a
        cancellation check that raises)."""
        questions = request.questions
        batches = plan_batches([question_size(q) for q in questions])
        usage = NoteUsage(batches=len(batches))
        calls: list[LLMCallInfo] = []
        merged: dict[str, list[NoteItem]] = {}
        codes: set[str] = set()
        for done, batch in enumerate(batches):
            members = [questions[i] for i in batch]
            checked = self._batch(members, request.reference_text, usage, calls, check)
            codes |= set(checked.codes)
            usage.dropped_items += checked.dropped
            to_chapter = {batch_tag(i): q.tag for i, q in enumerate(members)}
            for section in checked.sections:
                items = merged.setdefault(section.heading, [])
                items += [
                    NoteItem(text=i.text, tags=tuple(to_chapter[t] for t in i.tags))
                    for i in section.items
                ]
            if progress is not None:
                progress(done + 1, len(batches))
        sections = tuple(
            NoteSection(heading=h, items=tuple(items)) for h, items in merged.items() if items
        )
        usage.items = sum(len(s.items) for s in sections)
        for info in calls:
            usage.input_tokens += info.usage.input_tokens
            usage.output_tokens += info.usage.output_tokens
            if info.usage.cost_usd is not None:
                usage.cost_usd = (usage.cost_usd or 0.0) + info.usage.cost_usd
        if not usage.items:
            raise NoteCitationError("no note item cites an input question")
        model = calls[-1].model if calls else self._llm.model_name
        return NoteResult(
            sections=sections,
            usage=usage,
            model=model,
            prompt_version=PROMPT_VERSION,
            rejected_codes=tuple(sorted(codes)),
        )

    def _batch(
        self,
        members: Sequence[NoteQuestion],
        reference_text: str,
        usage: NoteUsage,
        calls: list[LLMCallInfo],
        check: Callable[[], None] | None,
    ) -> CheckedResponse:
        llm_request = build_request(members, reference_text)
        known = [batch_tag(i) for i in range(len(members))]
        checked = self._call(llm_request, known, reference_text, usage, calls, check)
        if checked.reject:
            logger.info(
                "chapter note response rejected, re-requesting once (codes=%s)",
                ",".join(checked.codes),
            )
            checked = self._call(llm_request, known, reference_text, usage, calls, check)
        return checked

    def _call(
        self,
        llm_request: LLMRequest,
        known: Sequence[str],
        reference_text: str,
        usage: NoteUsage,
        calls: list[LLMCallInfo],
        check: Callable[[], None] | None,
    ) -> CheckedResponse:
        if check is not None:
            check()
        usage.llm_calls += 1
        result = self._llm.complete(llm_request, LLMNoteOutput)
        calls.append(result.info)
        return check_response(result.output, known, reference_text)
