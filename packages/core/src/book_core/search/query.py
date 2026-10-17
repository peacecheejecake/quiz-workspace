"""Query normalisation and a script-based language hint (no translation)."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

DEFAULT_MAX_QUERY_CHARS = 1000
_SPACE = re.compile(r"\s+")


class InvalidQueryError(ValueError):
    """The query is empty or whitespace only."""


@dataclass(frozen=True, slots=True)
class PreparedQuery:
    text: str
    truncated: bool
    original_length: int
    language: str | None


def prepare_query(query: str, *, max_chars: int = DEFAULT_MAX_QUERY_CHARS) -> PreparedQuery:
    """NFC-normalise, collapse whitespace, reject empty queries and truncate long ones."""
    if not isinstance(query, str):
        raise InvalidQueryError("query must be a string")
    if max_chars < 1:
        raise ValueError("max_chars must be >= 1")
    text = _SPACE.sub(" ", unicodedata.normalize("NFC", query)).strip()
    if not text:
        raise InvalidQueryError("query must not be empty")
    original = len(text)
    truncated = original > max_chars
    if truncated:
        text = text[:max_chars].rstrip()
    return PreparedQuery(
        text=text, truncated=truncated, original_length=original, language=detect_language(text)
    )


def detect_language(text: str) -> str | None:
    """Coarse hint from the letters' scripts: ``ko`` (Hangul), ``en`` (Latin), ``mixed`` or
    ``None`` (no letters, or only other scripts). Used to bucket KO/EN queries in evaluation;
    it never changes how a query is searched."""
    hangul = latin = 0
    for char in text:
        if not char.isalpha():
            continue
        if "가" <= char <= "힣" or "ᄀ" <= char <= "ᇿ" or "㄰" <= char <= "㆏":
            hangul += 1
        elif char.isascii() or unicodedata.name(char, "").startswith("LATIN"):
            latin += 1
    total = hangul + latin
    if total == 0:
        return None
    share = hangul / total
    if share >= 0.8:
        return "ko"
    if share <= 0.2:
        return "en"
    return "mixed"
