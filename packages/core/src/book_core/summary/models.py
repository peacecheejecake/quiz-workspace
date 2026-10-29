"""Summary units and the chapter inputs they are made from (DOCSUM-01).

A unit body is what the API shows: ``{title, summary_md, key_points: [{text, pages}]}`` where
``pages`` is ``{from, to}`` or null. Units are content-addressed: a chapter's ``input_hash`` is
the SHA-256 of its normalized block text and pages, so an unchanged chapter of a later revision
reuses its unit without an LLM call (DOCSUM-01-C01).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

PROMPT_VERSION = "docsum-v1"
DOCUMENT_SCOPE = "document"
CHAPTER_SCOPE = "chapter"
DOCUMENT_SECTION_KEY = "document"
# The section key of the whole body of a document without any top-level chapter.
BODY_SECTION_KEY = "body"

MAX_SUMMARY_CHARS = 4000
MAX_KEY_POINT_CHARS = 500
MAX_KEY_POINTS = 8

_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """NFC with whitespace runs collapsed (what the input hash and the prompts see)."""
    return _WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


class PageRange(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    from_: Annotated[int, Field(ge=1, alias="from")]
    to: Annotated[int, Field(ge=1)]


class KeyPoint(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    text: str
    pages: PageRange | None = None


class SummaryBody(BaseModel):
    """One stored summary (a chapter or the whole document)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    title: str
    summary_md: str
    key_points: tuple[KeyPoint, ...] = ()

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = self.model_dump(mode="json", by_alias=True)
        return out

    @classmethod
    def from_json(cls, value: Any) -> SummaryBody:
        return cls.model_validate(value)


@dataclass(frozen=True, slots=True)
class InputBlock:
    """A block of a chapter's input: normalized text and the pages it sits on."""

    text: str
    page_from: int
    page_to: int
    heading: bool = False


@dataclass(frozen=True, slots=True)
class ChapterInput:
    """The input of one top-level chapter (outline depth 1)."""

    section_key: str
    title: str
    page_from: int | None
    page_to: int | None
    blocks: tuple[InputBlock, ...] = field(default_factory=tuple)

    @property
    def body_blocks(self) -> tuple[InputBlock, ...]:
        return tuple(b for b in self.blocks if not b.heading)

    @property
    def empty(self) -> bool:
        """Nothing but headings: no LLM call, the summary says there is no body text."""
        return not self.body_blocks

    @property
    def chars(self) -> int:
        return sum(len(b.text) for b in self.blocks)

    @property
    def input_hash(self) -> str:
        """SHA-256 of the normalized block text with its pages (DOCSUM-01-C01)."""
        digest = hashlib.sha256()
        digest.update(f"{CHAPTER_SCOPE}\n{self.section_key}\n".encode())
        for block in self.blocks:
            kind = "h" if block.heading else "t"
            digest.update(f"{kind}\t{block.page_from}-{block.page_to}\t{block.text}\n".encode())
        return digest.hexdigest()


def document_input_hash(chapters: Sequence[ChapterInput]) -> str:
    """The reduce's input: the ordered chapter hashes (same list -> same document unit)."""
    digest = hashlib.sha256(f"{DOCUMENT_SCOPE}\n".encode())
    for chapter in chapters:
        digest.update(f"{chapter.section_key}\t{chapter.input_hash}\n".encode())
    return digest.hexdigest()


def clamp_body(body: SummaryBody, page_from: int | None, page_to: int | None) -> SummaryBody:
    """Length caps, and pages outside ``[page_from, page_to]`` dropped (the point stays, without
    a page link; DOCSUM-01-C06)."""
    points: list[KeyPoint] = []
    for point in body.key_points:
        text = normalize_text(point.text)[:MAX_KEY_POINT_CHARS]
        if not text:
            continue
        pages = point.pages
        if pages is not None and (
            page_from is None
            or page_to is None
            or pages.from_ > pages.to
            or pages.from_ < page_from
            or pages.to > page_to
        ):
            pages = None
        points.append(KeyPoint(text=text, pages=pages))
        if len(points) >= MAX_KEY_POINTS:
            break
    return SummaryBody(
        title=body.title,
        summary_md=body.summary_md.strip()[:MAX_SUMMARY_CHARS],
        key_points=tuple(points),
    )
