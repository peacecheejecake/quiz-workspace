"""Citation checks of a chapter note response (CHNOTE-01-C02).

Every item must cite at least one input tag. A response with an unknown tag (a question that is
not an input, e.g. ``Q99``) or a quote that does not occur in the reference text is *rejected*
and re-requested once; in the re-requested response such items are dropped, and so are items
without any tag (in either response). What remains cites only input questions.

Quotes are compared after the same normalisation as question fingerprints (NFKC, no whitespace,
case-folded), so line breaks and spacing differences of the extracted text do not count as a
mismatch, while any changed word does.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass

from book_core.notes.models import LLMNoteOutput, NoteItem, NoteSection
from book_core.question import normalize_text


@dataclass(frozen=True)
class CheckedResponse:
    """Validated sections (batch tags), what was dropped and whether to re-request."""

    sections: tuple[NoteSection, ...]
    dropped: int
    reject: bool
    codes: tuple[str, ...]

    @property
    def item_count(self) -> int:
        return sum(len(s.items) for s in self.sections)


def _item_codes(
    tags: list[str], quote: str | None, known: Collection[str], reference: str
) -> set[str]:
    codes: set[str] = set()
    if not tags:
        codes.add("item_without_citation")
    if any(tag not in known for tag in tags):
        codes.add("unknown_question_tag")
    if quote is not None:
        needle = normalize_text(quote)
        if not needle or needle not in reference:
            codes.add("quote_not_in_reference")
    return codes


REJECTING_CODES = frozenset({"unknown_question_tag", "quote_not_in_reference"})


def check_response(
    output: LLMNoteOutput, known_tags: Collection[str], reference_text: str
) -> CheckedResponse:
    """Keep the items whose tags are all known, non-empty and whose quote (if any) is in the
    reference text. ``reject`` is true when an item cited an unknown tag or a missing quote."""
    reference = normalize_text(reference_text)
    known = frozenset(known_tags)
    sections: list[NoteSection] = []
    dropped = 0
    codes: set[str] = set()
    for section in output.sections:
        heading = section.heading.strip()
        kept: list[NoteItem] = []
        for item in section.items:
            tags = [t.strip() for t in item.tags]
            item_codes = _item_codes(tags, item.quote, known, reference)
            text = item.text.strip()
            if not text:
                item_codes.add("empty_item")
            if item_codes:
                dropped += 1
                codes |= item_codes
                continue
            kept.append(NoteItem(text=text, tags=tuple(dict.fromkeys(tags))))
        if kept:
            sections.append(NoteSection(heading=heading or "-", items=tuple(kept)))
    return CheckedResponse(
        sections=tuple(sections),
        dropped=dropped,
        reject=bool(codes & REJECTING_CODES),
        codes=tuple(sorted(codes)),
    )
