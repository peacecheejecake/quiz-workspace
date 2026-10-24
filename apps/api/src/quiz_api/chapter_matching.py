"""Suggest the book chapter of an imported question (CHAPTER-MAP, QIMPORT-01-AC08,
docs/questions.md §6). Pure: no DB access.

The question's chapter in the question PDF (the outline node of its first source block, and that
node's ancestors) is matched to the chapters of the workspace's books by normalised title:

* NFKC, case-folded;
* a leading chapter number is split off: `제1장`, `1장` (also 편/부/절/과/강/단원), `Chapter 1`
  (`Part`, `Unit`, `Lesson`, `Section`), `1.`, `1.2`, `1)`;
* everything but letters and digits is dropped (spacing and punctuation never decide).

So "제1장 수신제도", "1장 수신 제도" and "1. 수신제도" have the same title key. The deepest node of
the question's chain whose key is non-empty and found among the book chapters decides: exactly one
book chapter with that key is the suggestion; several are narrowed by the chapter number (`제1장`
vs `제3장`), and still several is `ambiguous` (no suggestion: never a guess). No node found is
`no_match`; a question whose source block has no chapter is `no_source_chapter`.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

ChapterMatch = Literal["matched", "no_match", "ambiguous", "no_source_chapter"]

_UNITS = "장|편|부|절|과|강|단원"
_PREFIX = re.compile(
    rf"""^\s*(?:
        제\s*(?P<ko>\d+)\s*(?:{_UNITS})
      | (?P<ko2>\d+)\s*(?:{_UNITS})(?![가-힣])
      | (?:chapter|chap\.?|part|unit|lesson|section)\s*(?P<en>\d+)\b
      | (?P<num>\d+(?:\.\d+)*)\s*[.):]?(?=\s|$)
    )""",
    re.VERBOSE | re.IGNORECASE,
)


@dataclass(frozen=True)
class TitleKey:
    number: str | None
    key: str


def title_key(title: str) -> TitleKey:
    """(chapter number, normalised title) of an outline title."""
    text = unicodedata.normalize("NFKC", title).casefold().strip()
    number: str | None = None
    match = _PREFIX.match(text)
    if match is not None:
        digits = next(g for g in match.groupdict().values() if g)
        number = str(int(digits.split(".")[0]))
        text = text[match.end() :]
    key = "".join(c for c in text if unicodedata.category(c)[0] in {"L", "N"})
    return TitleKey(number, key)


@dataclass(frozen=True)
class BookChapter:
    id: uuid.UUID
    title: str
    document_id: uuid.UUID
    document_title: str
    level: int


@dataclass(frozen=True)
class Suggestion:
    chapter: BookChapter | None
    match: ChapterMatch
    # The question PDF chapter the decision was made from (the deepest one when none matched).
    source_title: str | None


class ChapterMatcher:
    """Book chapters indexed by title key (built once per request)."""

    def __init__(self, chapters: Sequence[BookChapter]) -> None:
        self._by_key: dict[str, list[tuple[BookChapter, str | None]]] = defaultdict(list)
        for chapter in chapters:
            found = title_key(chapter.title)
            if found.key:
                self._by_key[found.key].append((chapter, found.number))

    def suggest(self, chain: Sequence[str]) -> Suggestion:
        """`chain`: the question's outline titles in the question PDF, deepest first."""
        if not chain:
            return Suggestion(None, "no_source_chapter", None)
        for title in chain:
            found = title_key(title)
            candidates = self._by_key.get(found.key, []) if found.key else []
            if not candidates:
                continue
            if len(candidates) > 1 and found.number is not None:
                narrowed = [c for c, n in candidates if n == found.number]
                if len(narrowed) == 1:
                    return Suggestion(narrowed[0], "matched", title)
            if len(candidates) == 1:
                return Suggestion(candidates[0][0], "matched", title)
            return Suggestion(None, "ambiguous", title)
        return Suggestion(None, "no_match", chain[0])
