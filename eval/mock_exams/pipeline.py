"""An in-process run of the mock exam AI generation steps (MOCK-X evaluation and `make test-llm`).

It applies the same core steps as the worker's ``mock_exam.generate`` job (apps/worker
``mock_exam_job``), without the database: sources are packed into as few calls as the budget
allows (``book_core.mock_exam.pack_batches``), each call is one ``mock_exam.generate/v1`` request,
every answered item is validated on its own (``check_batch``, every ``error`` blocks storage), an
unreadable or truncated answer is split in halves and re-requested (a one-source call that fails
again fails its item), and after the first round every failed item is re-requested once, packed
together; an item failing again is skipped. Calls run one at a time (the job's concurrency does
not change what is accepted).

Nothing here keeps or returns question text: the tally holds counts, codes and token usage only.
"""

from __future__ import annotations

from collections import Counter, deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from book_core.contracts import Excerpt, VariationType
from book_core.generation import Difficulty, SourceQuestion
from book_core.llm import LLMClient, LLMOutputError, LLMProviderError, LLMUsage
from book_core.mock_exam import (
    SOURCE_TOO_LARGE,
    BatchSource,
    Budget,
    LLMMockBatch,
    PackSource,
    base_prompt_text,
    batch_passage_tag,
    build_batch_request,
    check_batch,
    estimate_tokens,
    halves,
    pack_batches,
    source_block,
    source_tag,
)
from book_core.mock_exam.prompts import passage_block


@dataclass(frozen=True, slots=True)
class GenerationSource:
    """One plan item: its pinned source, variation type, chapter rank and passage keys."""

    position: int
    source: SourceQuestion
    variation_type: VariationType
    chapter_rank: int = 0
    passages: tuple[str, ...] = ()


@dataclass
class GenerationTally:
    requested: int = 0
    accepted: int = 0
    first_pass_accepted: int = 0
    re_requested: int = 0
    """Items sent again in the second round (each failed item once)."""
    unreadable: int = 0
    """Answers that could not be read (malformed or cut at the output budget)."""
    llm_calls: int = 0
    batches: int = 0
    """Calls whose answer was read and validated."""
    provider_errors: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    """Final failure code of every item that was not stored."""
    warnings: int = 0
    """Accepted items stored with a ``warning`` issue ("확인 필요")."""
    usage: LLMUsage = field(default_factory=LLMUsage)
    model: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "requested": self.requested,
            "accepted": self.accepted,
            "first_pass_accepted": self.first_pass_accepted,
            "re_requested": self.re_requested,
            "unreadable": self.unreadable,
            "llm_calls": self.llm_calls,
            "batches": self.batches,
            "provider_errors": self.provider_errors,
            "warnings": self.warnings,
            "skipped": dict(sorted(self.skipped.items())),
            "usage": self.usage.model_dump(),
        }


class _Run:
    def __init__(
        self,
        sources: Sequence[GenerationSource],
        passages: Mapping[str, Excerpt],
        llm: LLMClient,
        budget: Budget,
        difficulty: Difficulty | None,
    ) -> None:
        self.by_position = {s.position: s for s in sources}
        self.passages = passages
        self.llm = llm
        self.difficulty = difficulty
        self.budget = Budget(
            max_prompt_tokens=budget.max_prompt_tokens,
            max_output_tokens=budget.max_output_tokens,
            sources_per_call=budget.sources_per_call,
            output_tokens_per_item=budget.output_tokens_per_item,
            base_prompt_tokens=estimate_tokens(base_prompt_text(difficulty)),
        )
        self.own: dict[int, list[str]] = {s.position: list(s.passages) for s in sources}
        self.failed: dict[int, str] = {}
        self.siblings: set[str] = set()
        self.tally = GenerationTally(requested=len(sources))
        self.stopped = False

    def run(self) -> GenerationTally:
        self._round(sorted(self.by_position), retry=False)
        again = sorted(self.failed)
        self.tally.re_requested = 0 if self.stopped else len(again)
        if not self.stopped:
            self._round(again, retry=True)
        self.tally.skipped.update(self.failed.values())
        return self.tally

    def _round(self, positions: list[int], *, retry: bool) -> None:
        if not positions:
            return
        packed = pack_batches(
            [
                PackSource(
                    position=p,
                    chapter_rank=self.by_position[p].chapter_rank,
                    source_tokens=self._source_tokens(p),
                    passages=tuple(self.own[p]),
                    requires_passage=self.by_position[p].variation_type
                    is VariationType.ANALOGOUS_CONCEPT,
                )
                for p in positions
            ],
            {k: estimate_tokens(passage_block("P00", v)) for k, v in self.passages.items()},
            self.budget,
        )
        for position, kept in packed.narrowed.items():
            self.own[position] = list(kept)
        for position in positions:
            self.failed.pop(position, None)
        for position in packed.too_large:
            self.failed[position] = SOURCE_TOO_LARGE
        queue: deque[tuple[int, ...]] = deque(b.positions for b in packed.batches)
        while queue:
            task = queue.popleft()
            if self.stopped:
                for position in task:
                    self.failed[position] = "llm_unavailable"
                continue
            queue.extendleft(reversed(self._call(task, retry=retry)))

    def _source_tokens(self, position: int) -> int:
        item = self.by_position[position]
        block = BatchSource(
            tag="S00",
            position=position,
            source=item.source,
            variation_type=item.variation_type,
            passage_tags=tuple("P00" for _ in self.own[position]),
        )
        return estimate_tokens(source_block(block)) + 8

    def _call(self, task: tuple[int, ...], *, retry: bool) -> list[tuple[int, ...]]:
        keys: list[str] = []
        for position in task:
            keys += [k for k in self.own[position] if k not in keys]
        tags = {key: batch_passage_tag(i) for i, key in enumerate(keys)}
        sources = [
            BatchSource(
                tag=source_tag(i),
                position=position,
                source=self.by_position[position].source,
                variation_type=self.by_position[position].variation_type,
                passage_tags=tuple(tags[k] for k in self.own[position]),
            )
            for i, position in enumerate(task)
        ]
        passages = [self.passages[k] for k in keys]
        request = build_batch_request(sources, passages, difficulty=self.difficulty)
        self.tally.llm_calls += 1
        try:
            result = self.llm.complete(request, LLMMockBatch)
        except LLMOutputError as exc:
            if exc.call_info is not None:
                self._count(exc.call_info.usage, exc.call_info.model)
            return self._unreadable(task)
        except LLMProviderError as exc:
            if exc.kind == "max_tokens":
                return self._unreadable(task)
            self.tally.provider_errors += 1
            self.stopped = True
            for position in task:
                self.failed[position] = "llm_unavailable"
            return []
        self._count(result.info.usage, result.info.model)
        self.tally.batches += 1
        outcomes = check_batch(result.output, sources, passages, sibling_fingerprints=self.siblings)
        for outcome in outcomes:
            if outcome.accepted and outcome.content is not None:
                self.siblings.add(outcome.content.fingerprint())
                self.tally.accepted += 1
                self.tally.first_pass_accepted += not retry
                self.tally.warnings += bool(outcome.issues)
            else:
                self.failed[outcome.position] = (outcome.codes or ("invalid",))[0]
        return []

    def _unreadable(self, task: tuple[int, ...]) -> list[tuple[int, ...]]:
        self.tally.unreadable += 1
        if len(task) > 1:
            first, second = halves(task)
            return [first, second]
        self.failed[task[0]] = "llm_output_invalid"
        return []

    def _count(self, usage: LLMUsage, model: str) -> None:
        self.tally.usage = self.tally.usage + usage
        self.tally.model = self.tally.model or model


def generate(
    sources: Sequence[GenerationSource],
    passages: Mapping[str, Excerpt],
    llm: LLMClient,
    *,
    budget: Budget | None = None,
    difficulty: Difficulty | None = None,
) -> GenerationTally:
    """Runs the AI generation steps over ``sources`` and returns the counts (see the module)."""
    return _Run(sources, passages, llm, budget or Budget(), difficulty).run()
