"""Map/reduce over a revision's chapter inputs with content-addressed unit reuse (DOCSUM-01).

``summarize_revision`` looks every chapter up in the caller's ``UnitStore`` by its input hash
(no LLM call when found), summarizes the others (in parts when longer than the chapter limit),
then the document (reduce) unless the same chapter hash list was summarized before. Units are
saved as soon as they exist, so a failed run keeps what it already paid for. A revision whose
input is over ``max_input_chars`` fails before any call (``SummaryTooLargeError``).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from book_core.llm import LLMUsage
from book_core.summary.chapters import split_blocks
from book_core.summary.models import (
    CHAPTER_SCOPE,
    DOCUMENT_SCOPE,
    DOCUMENT_SECTION_KEY,
    ChapterInput,
    SummaryBody,
    clamp_body,
    document_input_hash,
)
from book_core.summary.summarizer import ChapterDigest, Summarizer

DEFAULT_CHAPTER_CHARS = 24_000
DEFAULT_MAX_INPUT_CHARS = 1_500_000


class SummaryTooLargeError(Exception):
    """The document's input is over the limit; nothing was sent to the LLM."""

    def __init__(self, chars: int, limit: int) -> None:
        super().__init__(f"summary input of {chars} characters is over the limit of {limit}")
        self.chars = chars
        self.limit = limit


@dataclass(frozen=True, slots=True)
class StoredUnit:
    id: str
    body: SummaryBody
    page_from: int | None
    page_to: int | None


class UnitStore(Protocol):
    """The document's units for one prompt version and model (the caller binds both)."""

    def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None: ...

    def save(
        self,
        scope: str,
        section_key: str,
        input_hash: str,
        body: SummaryBody,
        page_from: int | None,
        page_to: int | None,
        usage: LLMUsage | None,
    ) -> StoredUnit: ...


@dataclass(frozen=True, slots=True)
class SummaryLimits:
    chapter_chars: int = DEFAULT_CHAPTER_CHARS
    max_input_chars: int = DEFAULT_MAX_INPUT_CHARS


@dataclass(slots=True)
class SummaryTally:
    """Counts and usage so far (kept by the caller, also when the run fails)."""

    reused_units: int = 0
    generated_units: int = 0
    usage: LLMUsage = field(default_factory=LLMUsage)

    def add(self, usage: LLMUsage) -> None:
        self.usage = self.usage + usage


@dataclass(frozen=True, slots=True)
class SummaryResult:
    document: StoredUnit
    chapters: tuple[StoredUnit, ...]


def _noop() -> None:
    return None


def summarize_revision(
    chapters: Sequence[ChapterInput],
    *,
    document_title: str,
    summarizer: Summarizer,
    store: UnitStore,
    limits: SummaryLimits,
    tally: SummaryTally,
    on_progress: Callable[[int, int], None] = lambda done, total: None,
    before_generate: Callable[[], None] = _noop,
) -> SummaryResult:
    total_chars = sum(c.chars for c in chapters)
    if total_chars > limits.max_input_chars:
        raise SummaryTooLargeError(total_chars, limits.max_input_chars)

    units: list[StoredUnit] = []
    on_progress(0, len(chapters))
    for chapter in chapters:
        units.append(_chapter_unit(chapter, summarizer, store, limits, tally, before_generate))
        on_progress(len(units), len(chapters))

    doc_from = min((c.page_from for c in chapters if c.page_from is not None), default=None)
    doc_to = max((c.page_to for c in chapters if c.page_to is not None), default=None)
    doc_hash = document_input_hash(chapters)
    document = store.find(DOCUMENT_SCOPE, DOCUMENT_SECTION_KEY, doc_hash)
    if document is not None:
        tally.reused_units += 1
    else:
        digests = [
            ChapterDigest(c.title, u.body, u.page_from, u.page_to)
            for c, u in zip(chapters, units, strict=True)
        ]
        if any(d.body.summary_md for d in digests):
            before_generate()
            call = summarizer.summarize_document(document_title, digests, doc_from, doc_to)
            tally.add(call.usage)
            body = clamp_body(
                SummaryBody(
                    title=document_title,
                    summary_md=call.body.summary_md,
                    key_points=call.body.key_points,
                ),
                doc_from,
                doc_to,
            )
            usage: LLMUsage | None = call.usage
            tally.generated_units += 1
        else:
            body, usage = SummaryBody(title=document_title, summary_md=""), None
        document = store.save(
            DOCUMENT_SCOPE, DOCUMENT_SECTION_KEY, doc_hash, body, doc_from, doc_to, usage
        )
    return SummaryResult(document=document, chapters=tuple(units))


def _chapter_unit(
    chapter: ChapterInput,
    summarizer: Summarizer,
    store: UnitStore,
    limits: SummaryLimits,
    tally: SummaryTally,
    before_generate: Callable[[], None],
) -> StoredUnit:
    key = chapter.input_hash
    found = store.find(CHAPTER_SCOPE, chapter.section_key, key)
    if found is not None:
        tally.reused_units += 1
        return found
    if chapter.empty or chapter.page_from is None or chapter.page_to is None:
        body = SummaryBody(title=chapter.title, summary_md="")
        return store.save(
            CHAPTER_SCOPE, chapter.section_key, key, body, chapter.page_from, chapter.page_to, None
        )

    before_generate()
    pf, pt = chapter.page_from, chapter.page_to
    parts = split_blocks(chapter.blocks, limits.chapter_chars)
    usage_total = None
    if len(parts) == 1:
        call = summarizer.summarize_chapter(chapter.title, parts[0], pf, pt)
        tally.add(call.usage)
        body, usage_total = call.body, call.usage
    else:
        bodies: list[SummaryBody] = []
        for part in parts:
            call = summarizer.summarize_chapter(
                chapter.title, part, min(b.page_from for b in part), max(b.page_to for b in part)
            )
            tally.add(call.usage)
            usage_total = call.usage if usage_total is None else usage_total + call.usage
            bodies.append(clamp_body(call.body, pf, pt))
        merged = summarizer.merge_chapter(chapter.title, bodies, pf, pt)
        tally.add(merged.usage)
        assert usage_total is not None  # noqa: S101 - more than one part
        body, usage_total = merged.body, usage_total + merged.usage
    body = clamp_body(
        SummaryBody(title=chapter.title, summary_md=body.summary_md, key_points=body.key_points),
        pf,
        pt,
    )
    tally.generated_units += 1
    return store.save(CHAPTER_SCOPE, chapter.section_key, key, body, pf, pt, usage_total)
