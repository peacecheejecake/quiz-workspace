"""Batching of mock exam sources into as few LLM calls as the budgets allow (MOCK-01 "LLM 호출
묶기", MOCK-01-C09).

One call carries as many sources as fit into the input budget (instructions, every source and
each of the batch's passages once) and the output budget (an estimated ``output_tokens_per_item``
per source), capped by ``sources_per_call``. Packing is deterministic: sources are ordered by
chapter, then sources sharing a passage are kept together (in the order their first passage
appears), then by plan position, and greedily filled into batches.

A source that alone exceeds the input budget is narrowed: its passages are dropped from the end
(lowest priority first) until it fits. One that still does not fit (or would be left without the
passage it needs) is skipped as ``source_too_large``.

Token counts are estimates (:func:`estimate_tokens`): conservative, character based, used when
the provider has no tokenizer.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

DEFAULT_MAX_PROMPT_TOKENS = 60_000
DEFAULT_MAX_OUTPUT_TOKENS = 16_000
DEFAULT_SOURCES_PER_CALL = 40
OUTPUT_TOKENS_PER_ITEM = 400
"""Estimated output of one generated question (stem, options, explanation, citations)."""

SOURCE_TOO_LARGE = "source_too_large"


def estimate_tokens(text: str) -> int:
    """A conservative token estimate: every non-ASCII character counts as one token (Korean
    and other scripts are rarely denser), ASCII as one token per three characters."""
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    return (len(text) - ascii_chars) + math.ceil(ascii_chars / 3)


@dataclass(frozen=True, slots=True)
class Budget:
    max_prompt_tokens: int = DEFAULT_MAX_PROMPT_TOKENS
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS
    sources_per_call: int = DEFAULT_SOURCES_PER_CALL
    output_tokens_per_item: int = OUTPUT_TOKENS_PER_ITEM
    base_prompt_tokens: int = 0
    """Instructions and framing sent with every call."""

    def __post_init__(self) -> None:
        if min(self.max_prompt_tokens, self.max_output_tokens, self.sources_per_call) < 1:
            raise ValueError("budgets must be positive")
        if self.output_tokens_per_item < 1 or self.base_prompt_tokens < 0:
            raise ValueError("invalid per-item or base token estimate")

    @property
    def items_per_call(self) -> int:
        """Sources one call may carry: the cap, and what the output budget can hold."""
        return max(
            1, min(self.sources_per_call, self.max_output_tokens // self.output_tokens_per_item)
        )


@dataclass(frozen=True, slots=True)
class PackSource:
    """One plan item to pack."""

    position: int
    chapter_rank: int
    source_tokens: int
    passages: tuple[str, ...] = ()
    """Keys of its passages, highest priority first (see ``passage_tokens``)."""
    requires_passage: bool = False
    """It cannot be generated without a passage (ANALOGOUS_CONCEPT)."""


@dataclass(frozen=True, slots=True)
class PackedBatch:
    positions: tuple[int, ...]
    passages: tuple[str, ...]
    """Each passage once, in first-use order."""
    prompt_tokens: int


@dataclass(frozen=True, slots=True)
class PackResult:
    batches: tuple[PackedBatch, ...]
    too_large: tuple[int, ...] = ()
    narrowed: Mapping[int, tuple[str, ...]] = field(default_factory=dict)
    """Positions whose passages were cut to fit, with the passages they kept."""


def pack_batches(
    sources: Sequence[PackSource], passage_tokens: Mapping[str, int], budget: Budget
) -> PackResult:
    """Greedy, deterministic packing (see the module docstring)."""
    too_large: list[int] = []
    narrowed: dict[int, tuple[str, ...]] = {}
    fitted: list[PackSource] = []
    for source in sources:
        kept = list(dict.fromkeys(source.passages))
        while kept and _own_tokens(source, kept, passage_tokens, budget) > budget.max_prompt_tokens:
            kept.pop()
        fits = _own_tokens(source, kept, passage_tokens, budget) <= budget.max_prompt_tokens
        if not fits or (source.requires_passage and not kept):
            too_large.append(source.position)
            continue
        if len(kept) != len(dict.fromkeys(source.passages)):
            narrowed[source.position] = tuple(kept)
        fitted.append(_with_passages(source, tuple(kept)))

    first_seen: dict[str, int] = {}
    for source in sorted(fitted, key=lambda s: (s.chapter_rank, s.position)):
        for key in source.passages:
            first_seen.setdefault(key, len(first_seen))

    def order(source: PackSource) -> tuple[int, int, int]:
        lead = min((first_seen[k] for k in source.passages), default=len(first_seen))
        return (source.chapter_rank, lead, source.position)

    batches: list[PackedBatch] = []
    positions: list[int] = []
    passages: list[str] = []
    tokens = budget.base_prompt_tokens
    for source in sorted(fitted, key=order):
        new = [k for k in source.passages if k not in passages]
        extra = source.source_tokens + sum(passage_tokens.get(k, 0) for k in new)
        if positions and (
            len(positions) >= budget.items_per_call or tokens + extra > budget.max_prompt_tokens
        ):
            batches.append(PackedBatch(tuple(positions), tuple(passages), tokens))
            positions, passages, tokens = [], [], budget.base_prompt_tokens
            new = list(source.passages)
            extra = source.source_tokens + sum(passage_tokens.get(k, 0) for k in new)
        positions.append(source.position)
        passages.extend(new)
        tokens += extra
    if positions:
        batches.append(PackedBatch(tuple(positions), tuple(passages), tokens))
    return PackResult(batches=tuple(batches), too_large=tuple(too_large), narrowed=narrowed)


def _own_tokens(
    source: PackSource, passages: Sequence[str], passage_tokens: Mapping[str, int], budget: Budget
) -> int:
    return (
        budget.base_prompt_tokens
        + source.source_tokens
        + sum(passage_tokens.get(k, 0) for k in passages)
    )


def _with_passages(source: PackSource, passages: tuple[str, ...]) -> PackSource:
    return PackSource(
        position=source.position,
        chapter_rank=source.chapter_rank,
        source_tokens=source.source_tokens,
        passages=passages,
        requires_passage=source.requires_passage,
    )


def halves(positions: Sequence[int]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """An unreadable batch is re-requested as two halves (the first one the smaller)."""
    mid = len(positions) // 2
    return tuple(positions[:mid]), tuple(positions[mid:])
