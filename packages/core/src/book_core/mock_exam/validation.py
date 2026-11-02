"""Per-item validation of a batch answer (MOCK-01-C02): the storage condition of a mock exam
question.

Every item is checked on its own against its source with the unchanged QGEN validation
(:mod:`book_core.generation.validation`: schema mapping, option/answer count, the inverted
answer, duplicate fingerprints, citations of this request's passages). With no human approval
behind a mock exam question, **every** ``error`` issue blocks storage, not only the codes that
made QGEN drop a candidate (``is_rejection``): e.g. ``inverted_answer_mismatch`` blocked a QGEN
draft's approval and drops a mock exam item. ``warning`` issues are stored with the question
(shown to editors as "확인 필요").

A missing source, an unknown or repeated ``source_tag`` and an item of another variation type
are failed items too. Nothing here logs or returns item text: issues carry codes and fixed
messages only.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass

from book_core.contracts import Excerpt, ValidationIssue, ValidationSeverity
from book_core.generation import LLMVariant, passage_tag
from book_core.generation.validation import VariantContent, content_from_llm, content_issues
from book_core.mock_exam.prompts import BatchSource, LLMMockBatch, LLMMockItem
from book_core.question import issue


@dataclass(frozen=True, slots=True)
class ItemOutcome:
    """The result of one source of a batch."""

    position: int
    content: VariantContent | None
    issues: tuple[ValidationIssue, ...]

    @property
    def accepted(self) -> bool:
        return self.content is not None and not blocking(self.issues)

    @property
    def codes(self) -> tuple[str, ...]:
        return tuple(i.code for i in self.issues if i.severity is ValidationSeverity.ERROR)


def blocking(issues: Sequence[ValidationIssue]) -> bool:
    return any(i.severity is ValidationSeverity.ERROR for i in issues)


def accept_for_mock_exam(
    item: LLMMockItem,
    source: BatchSource,
    passages: Sequence[Excerpt],
    *,
    existing_fingerprints: Collection[str] = (),
    sibling_fingerprints: Collection[str] = (),
) -> tuple[VariantContent | None, list[ValidationIssue]]:
    """The item as question content and every issue it has (any ``error`` blocks storage)."""
    if item.variation_type.strip().upper() != source.variation_type.value:
        return None, [
            issue(
                "variation_type_mismatch",
                "The item is not of its source's variation type.",
                error=True,
            )
        ]
    # Only the source's own passages count: the batch tags (P1..Pk of the request) map onto
    # them, a citation of another source's passage is unknown to this item, and a source without
    # passages needs no citation (its evidence is the source's own provenance).
    own, local = source_passages(source, passages)
    citations = []
    for citation in item.citations:
        tag = local.get(citation.passage_id.strip().strip("[]").casefold())
        if tag is None:
            return None, [
                issue(
                    "citation_unknown_passage",
                    "A citation does not reference one of its source's passages.",
                    error=True,
                    field="evidence",
                )
            ]
        citations.append({"passage_id": tag, "quote": citation.quote})
    raw = item.model_dump(exclude={"source_tag", "variation_type"})
    candidate = LLMVariant.model_validate({**raw, "citations": citations})
    content, issues = content_from_llm(candidate, source.source, own)
    if content is None:
        return None, issues
    return content, content_issues(
        content,
        variation_type=source.variation_type,
        source=source.source,
        passages=own,
        existing_fingerprints=existing_fingerprints,
        sibling_fingerprints=sibling_fingerprints,
    )


def source_passages(
    source: BatchSource, passages: Sequence[Excerpt]
) -> tuple[list[Excerpt], dict[str, str]]:
    """The source's own passages (in its tag order) and batch tag -> local tag (``P1``..)."""
    own: list[Excerpt] = []
    local: dict[str, str] = {}
    for tag in source.passage_tags:
        index = int(tag[1:]) - 1 if tag[:1].upper() == "P" and tag[1:].isdigit() else -1
        if 0 <= index < len(passages) and tag.casefold() not in local:
            own.append(passages[index])
            local[tag.casefold()] = passage_tag(len(own) - 1)
    return own, local


def check_batch(
    output: LLMMockBatch,
    sources: Sequence[BatchSource],
    passages: Sequence[Excerpt],
    *,
    existing_fingerprints: Collection[str] = (),
    sibling_fingerprints: Collection[str] = (),
) -> list[ItemOutcome]:
    """One outcome per source of the batch, in source order. Accepted items are also checked
    against each other (no two items of one batch, or of the generation, may be the same)."""
    by_tag: Mapping[str, BatchSource] = {s.tag.casefold(): s for s in sources}
    items: dict[str, LLMMockItem] = {}
    repeated: set[str] = set()
    for item in output.items:
        key = item.source_tag.strip().strip("[]").casefold()
        if key not in by_tag:
            continue  # an unknown tag answers nothing
        if key in items:
            repeated.add(key)
        items.setdefault(key, item)
    siblings = set(sibling_fingerprints)
    outcomes: list[ItemOutcome] = []
    for source in sources:
        key = source.tag.casefold()
        if key in repeated:
            outcomes.append(_failed(source, "duplicate_item", "The source got more than one item."))
            continue
        answer = items.get(key)
        if answer is None:
            outcomes.append(_failed(source, "item_missing", "The answer has no item for it."))
            continue
        content, issues = accept_for_mock_exam(
            answer,
            source,
            passages,
            existing_fingerprints=existing_fingerprints,
            sibling_fingerprints=siblings,
        )
        outcome = ItemOutcome(source.position, content, tuple(issues))
        if outcome.accepted and content is not None:
            siblings.add(content.fingerprint())
        outcomes.append(outcome)
    return outcomes


def _failed(source: BatchSource, code: str, message: str) -> ItemOutcome:
    return ItemOutcome(source.position, None, (issue(code, message, error=True),))
