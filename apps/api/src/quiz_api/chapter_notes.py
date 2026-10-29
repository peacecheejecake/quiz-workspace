"""Pure rules of chapter notes (CHNOTE-01): input fingerprint, question labels and how a stored
note body becomes sections with numbered footnotes.

Stored body (worker, book_core.notes): ``{sections: [{heading, items: [{text, tags}]}]}`` where
tags are the note's input tags (``question_refs[].tag``). On read every distinct cited tag gets a
footnote number in order of first appearance; a footnote links its question only while that
question is still one the reader may open (members: a live CONFIRMED question of the chapter;
guests: a live CONFIRMED question of the shared workspace), otherwise it shows the pinned label
with no link and no stem ("삭제되었거나 옮긴 문제").
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

STEM_PREVIEW_CHARS = 40


def input_fingerprint(
    refs: Iterable[tuple[uuid.UUID | str, uuid.UUID | str]], body_hash: str
) -> str:
    """SHA-256 of the sorted `question_id:revision_id` lines, a newline and the body hash.

    Same value as SQL `public.chapter_note_fingerprint` (supabase/tests/19_chapter_notes)."""
    lines = sorted(f"{question_id}:{revision_id}" for question_id, revision_id in refs)
    return hashlib.sha256(("\n".join(lines) + "\n" + body_hash).encode("utf-8")).hexdigest()


def question_label(
    chapter_number: int | None, chapter_title: str, question_number: int | None, position: int
) -> str:
    """ "<n>장 <번호>번" like the Heatmap preview; the chapter title stands in for a chapter
    without a number and the position in the chapter for an unnumbered question."""
    chapter = f"{chapter_number}장" if chapter_number is not None else chapter_title.strip()
    return f"{chapter} {question_number if question_number is not None else position}번"


def stem_preview(stem: str) -> str:
    text = " ".join(stem.split())
    return text[:STEM_PREVIEW_CHARS]


@dataclass(frozen=True)
class Ref:
    tag: str
    question_id: uuid.UUID
    question_revision_id: uuid.UUID
    label: str


def parse_refs(raw: Any) -> list[Ref]:
    refs: list[Ref] = []
    for entry in raw if isinstance(raw, list) else []:
        try:
            refs.append(
                Ref(
                    tag=str(entry["tag"]),
                    question_id=uuid.UUID(str(entry["question_id"])),
                    question_revision_id=uuid.UUID(str(entry["question_revision_id"])),
                    label=str(entry.get("label") or ""),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return refs


@dataclass(frozen=True)
class PresentedItem:
    text: str
    footnotes: list[int]


@dataclass(frozen=True)
class PresentedSection:
    heading: str
    items: list[PresentedItem]


@dataclass(frozen=True)
class PresentedFootnote:
    number: int
    question_id: uuid.UUID | None
    label: str
    stem_preview: str | None


def present_body(
    body: Any, refs: list[Ref], linkable: Mapping[uuid.UUID, str]
) -> tuple[list[PresentedSection], list[PresentedFootnote]]:
    """Sections with footnote numbers and the footnote list. `linkable` maps the question ids the
    reader may open to their current stem. Items citing no known tag are left out."""
    by_tag = {r.tag: r for r in refs}
    numbers: dict[str, int] = {}
    footnotes: list[PresentedFootnote] = []
    sections: list[PresentedSection] = []
    raw_sections = body.get("sections") if isinstance(body, dict) else None
    for raw in raw_sections if isinstance(raw_sections, list) else []:
        if not isinstance(raw, dict):
            continue
        items: list[PresentedItem] = []
        for item in raw.get("items") or []:
            if not isinstance(item, dict):
                continue
            cited: list[int] = []
            for tag in item.get("tags") or []:
                ref = by_tag.get(str(tag))
                if ref is None:
                    continue
                if ref.tag not in numbers:
                    numbers[ref.tag] = len(numbers) + 1
                    stem = linkable.get(ref.question_id)
                    footnotes.append(
                        PresentedFootnote(
                            number=numbers[ref.tag],
                            question_id=ref.question_id if stem is not None else None,
                            label=ref.label,
                            stem_preview=stem_preview(stem) if stem is not None else None,
                        )
                    )
                if numbers[ref.tag] not in cited:
                    cited.append(numbers[ref.tag])
            if cited:
                items.append(PresentedItem(text=str(item.get("text") or ""), footnotes=cited))
        if items:
            sections.append(PresentedSection(heading=str(raw.get("heading") or ""), items=items))
    return sections, footnotes
