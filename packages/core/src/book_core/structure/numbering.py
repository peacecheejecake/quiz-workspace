"""Heading numbering patterns (KO and EN) used to infer the chapter/section hierarchy."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import IntEnum


class NumberingKind(IntEnum):
    """Numbering styles ordered from outermost to innermost.

    Levels are assigned by dense rank over the kinds a document actually uses, so ``1.1``
    under ``1장`` is level 2 whether or not plain ``1.`` headings exist.
    """

    PART = 10
    CHAPTER = 20
    KO_SECTION = 25
    ROMAN = 30
    NUM1 = 41
    NUM2 = 42
    NUM3 = 43
    NUM4 = 44
    NUM5 = 45
    UPPER_ALPHA = 50
    HANGUL = 60
    PAREN = 70


@dataclass(frozen=True, slots=True)
class Numbering:
    kind: NumberingKind
    numbers: tuple[int, ...]
    """Numeric value of each component; dotted numbers have one entry per component."""


_HANGUL_ORDER = "가나다라마바사아자차카타파하"
_ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
_NUM = r"(\d{1,4})"
_ROMAN_RE = r"([ivxlcdm]{1,8})"
_END = "(?=[\\s.:)\\-\u2013\u2014]|$)"

_PATTERNS: tuple[tuple[NumberingKind, re.Pattern[str]], ...] = (
    (NumberingKind.PART, re.compile(rf"^제\s*{_NUM}\s*[부편]{_END}")),
    (NumberingKind.PART, re.compile(rf"^{_NUM}\s*부(?=\s|$)")),
    (NumberingKind.PART, re.compile(rf"^part\s+(?:{_NUM}|{_ROMAN_RE}){_END}", re.IGNORECASE)),
    (NumberingKind.CHAPTER, re.compile(rf"^제\s*{_NUM}\s*장{_END}")),
    (NumberingKind.CHAPTER, re.compile(rf"^{_NUM}\s*장(?=[\s.:]|$)")),
    (
        NumberingKind.CHAPTER,
        re.compile(rf"^(?:chapter|ch\.)\s*(?:{_NUM}|{_ROMAN_RE}){_END}", re.IGNORECASE),
    ),
    (NumberingKind.KO_SECTION, re.compile(rf"^제\s*{_NUM}\s*절{_END}")),
    (NumberingKind.KO_SECTION, re.compile(rf"^{_NUM}\s*절(?=[\s.:]|$)")),
    (NumberingKind.NUM1, re.compile(r"^(\d{1,4}(?:\.\d{1,4})+)\.?(?=\s|$)")),
    (NumberingKind.NUM1, re.compile(rf"^{_NUM}\.?\s+(?=\S)")),
    (NumberingKind.ROMAN, re.compile(r"^([IVX]{1,6})\.\s+(?=\S)")),
    (NumberingKind.UPPER_ALPHA, re.compile(r"^([A-Z])\.\s+(?=\S)")),
    (NumberingKind.HANGUL, re.compile(rf"^([{_HANGUL_ORDER}])[.)]\s+(?=\S)")),
    (NumberingKind.PAREN, re.compile(r"^\(?(\d{1,3})\)\s+(?=\S)")),
)

_APPENDIX = re.compile(
    r"^(?:appendix(?:\s+[A-Z0-9]{1,3})?|부록(?:\s*[A-Z0-9가-힣]?)?)(?=[\s.:]|$)", re.I
)
_BACK_MATTER = frozenset(
    {
        "references",
        "bibliography",
        "index",
        "glossary",
        "afterword",
        "참고문헌",
        "참고 문헌",
        "찾아보기",
        "색인",
        "용어집",
        "맺음말",
    }
)
_TOC_TITLES = frozenset({"목차", "목 차", "차례", "차 례", "contents", "table of contents"})


def _roman(text: str) -> int | None:
    values = [_ROMAN.get(ch) for ch in text.lower()]
    if not values or any(v is None for v in values):
        return None
    total = 0
    ints = [v for v in values if v is not None]
    for i, value in enumerate(ints):
        total += -value if i + 1 < len(ints) and value < ints[i + 1] else value
    return total


def _value(raw: str, kind: NumberingKind) -> int:
    if raw.isdigit():
        return int(raw)
    if raw in _HANGUL_ORDER:
        return _HANGUL_ORDER.index(raw) + 1
    roman = _roman(raw)
    if roman is not None and kind is not NumberingKind.UPPER_ALPHA:
        return roman
    return ord(raw[0].upper()) - ord("A") + 1


def parse_numbering(title: str) -> Numbering | None:
    """The numbering style of a heading, or ``None`` for an unnumbered heading."""
    text = unicodedata.normalize("NFKC", title).strip()
    for kind, pattern in _PATTERNS:
        match = pattern.match(text)
        if match is None:
            continue
        raw = next(group for group in match.groups() if group is not None)
        if "." in raw:
            numbers = tuple(int(part) for part in raw.split("."))
            depth = min(len(numbers), 5)
            return Numbering(NumberingKind(NumberingKind.NUM1 + depth - 1), numbers)
        return Numbering(kind, (_value(raw, kind),))
    return None


def _key(title: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", title).casefold().split()).rstrip(".:")


def is_appendix(title: str) -> bool:
    return _APPENDIX.match(unicodedata.normalize("NFKC", title).strip()) is not None


def is_back_matter(title: str) -> bool:
    return is_appendix(title) or _key(title) in _BACK_MATTER


def is_toc_title(title: str) -> bool:
    return _key(title) in _TOC_TITLES
