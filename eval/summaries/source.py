"""Inputs shared by the summary and chapter-note evaluations (DOCSUM-X).

A document is read from one of:

- a synthetic fixture truth file (``tests/fixtures/pdfs/*.truth.json``): sections and blocks with
  their pages, no parser or model needed (the committed default);
- ``core parse`` output (``*.json``, a ``ParsedDocument``) or a PDF (real Docling models), run
  through the worker's own ``build_revision`` + ``chapter_inputs``. Keep such files outside the
  repository; never commit real PDFs or their parsed text.

Nothing here prints or writes document text.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.summary import ChapterInput, InputBlock, chapter_inputs
from book_core.summary.models import normalize_text

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "fixtures" / "pdfs"
DEFAULT_BOOKS = (FIXTURES / "book-ko.truth.json", FIXTURES / "book-en.truth.json")

_TEXT_TYPES = frozenset({"text", "heading", "table", "formula"})
_DROP = re.compile(r"[\s\W_]+", re.UNICODE)


@dataclass(frozen=True)
class EvalDocument:
    """One document's chapter inputs and its text per page (for citation checks)."""

    name: str
    title: str
    chapters: tuple[ChapterInput, ...]
    page_text: dict[int, str]

    def pages_text(self, page_from: int, page_to: int) -> str:
        return " ".join(self.page_text.get(p, "") for p in range(page_from, page_to + 1))

    def chapter_text(self, section_key: str) -> str:
        for chapter in self.chapters:
            if chapter.section_key == section_key:
                return "\n".join(b.text for b in chapter.blocks)
        raise KeyError(section_key)


def _truth(path: Path) -> EvalDocument:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    if not data.get("synthetic"):
        raise ValueError(f"{path.name}: only synthetic fixture truth files are accepted")
    sections = {s["id"]: s for s in data["sections"]}

    def root(section_id: str) -> str:
        current = sections[section_id]
        while current.get("parent_id"):
            current = sections[current["parent_id"]]
        return str(current["id"])

    top = [s for s in data["sections"] if not s.get("parent_id")]
    grouped: dict[str, list[InputBlock]] = {s["id"]: [] for s in top}
    page_text: dict[int, list[str]] = defaultdict(list)
    for block in data["blocks"]:
        if block["type"] not in _TEXT_TYPES:
            continue
        text = normalize_text(block["text"])
        if not text:
            continue
        pages = [part["page"] for part in block["parts"]]
        for page in sorted(set(pages)):
            page_text[page].append(text)
        if block.get("section_id") not in sections:
            continue
        grouped[root(block["section_id"])].append(
            InputBlock(
                text=text,
                page_from=min(pages),
                page_to=max(pages),
                heading=block["type"] == "heading",
            )
        )
    chapters = tuple(
        ChapterInput(
            section_key=s["id"],
            title=normalize_text(s["title"]),
            page_from=min((b.page_from for b in grouped[s["id"]]), default=None),
            page_to=max((b.page_to for b in grouped[s["id"]]), default=None),
            blocks=tuple(grouped[s["id"]]),
        )
        for s in top
    )
    return EvalDocument(
        name=str(data.get("fixture_id") or path.stem),
        title=str(data["title"]),
        chapters=chapters,
        page_text={p: " ".join(t) for p, t in page_text.items()},
    )


def _parsed(path: Path) -> EvalDocument:
    from book_core.contracts import ParsedDocument
    from book_core.structure import build_revision

    if path.suffix.lower() == ".json":
        parsed = ParsedDocument.model_validate_json(path.read_bytes())
    else:
        from book_core.parser import ParserOptions
        from book_core.parser.docling_adapter import DoclingParser

        parsed = DoclingParser(ParserOptions()).parse(path, source_path=path.name)
    revision = build_revision(parsed, document_id="eval", revision_id="eval").revision
    title = path.stem
    chapters = tuple(chapter_inputs(revision, document_title=title))
    page_text: dict[int, list[str]] = defaultdict(list)
    for block in revision.blocks:
        text = normalize_text(block.text)
        for page in sorted({loc.page for loc in block.locations}):
            if text:
                page_text[page].append(text)
    return EvalDocument(
        name=path.stem,
        title=title,
        chapters=chapters,
        page_text={p: " ".join(t) for p, t in page_text.items()},
    )


def load_document(path: Path) -> EvalDocument:
    if path.name.endswith(".truth.json"):
        return _truth(path)
    return _parsed(path)


_WORD = re.compile(r"\w+")
_CJK = re.compile(r"[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]")
_STOP = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "with",
    ]
)


def units(text: str) -> set[str]:
    """Comparable units of a text: character bigrams inside Hangul/CJK words (no spaces between
    morphemes), the first six letters of other words (crude stemming), stop words and numbers
    left out. Case- and width-folded."""
    found: set[str] = set()
    for word in _WORD.findall(unicodedata.normalize("NFKC", text).casefold()):
        if _CJK.search(word):
            found |= {word[i : i + 2] for i in range(len(word) - 1)} if len(word) > 1 else {word}
        elif word not in _STOP and not word.isdigit():
            found.add(word[:6])
    return found


def support(claim: str, evidence: str) -> float:
    """Share of the claim's units found in the evidence (1.0 = fully contained)."""
    claimed = units(claim)
    if not claimed:
        return 0.0
    return len(claimed & units(evidence)) / len(claimed)


def contains(text: str, phrase: str) -> bool:
    """``phrase`` occurs in ``text`` ignoring case, spacing and punctuation."""
    flat = _DROP.sub("", unicodedata.normalize("NFKC", text).casefold())
    needle = _DROP.sub("", unicodedata.normalize("NFKC", phrase).casefold())
    return bool(needle) and needle in flat


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None
