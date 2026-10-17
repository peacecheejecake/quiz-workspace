"""Heading numbering patterns (KO and EN) used to infer the chapter/section hierarchy."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, replace
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
    label: str = ""
    """The printed label, e.g. ``1.2``, ``IV`` or ``가``."""


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
            return Numbering(NumberingKind(NumberingKind.NUM1 + depth - 1), numbers, raw)
        return Numbering(kind, (_value(raw, kind),), raw)
    return None


def _alpha(numbering: Numbering) -> Numbering:
    label = numbering.label
    return replace(numbering, kind=NumberingKind.UPPER_ALPHA, numbers=(ord(label) - 64,))


def _is_ambiguous(numbering: Numbering | None) -> bool:
    return (
        numbering is not None
        and numbering.kind is NumberingKind.ROMAN
        and len(numbering.label) == 1
    )


_HARD = 10
"""Cost of a Roman numeral that does not increase (a second Roman ``I`` after ``I``)."""
_BACKWARD_LETTER = 2
_BRUTE_FORCE_MAX = 12
"""Ambiguous headings solved exactly together; longer runs are solved in windows."""


def _sequence_cost(numberings: Sequence[Numbering | None]) -> int:
    """Breaks in the Roman and letter heading sequences of a fully resolved heading list.

    Roman headings form one sequence (reset only by an outer Part/Chapter/제N절 heading) that
    must start at I and increase by one; letter headings restart under every outer heading
    (Roman, Chapter, numbered ...) and must start at A and increase by one. A gap or a wrong
    start costs 1, a letter going backwards ``_BACKWARD_LETTER``, a Roman numeral that does not
    increase ``_HARD``.
    """
    cost = 0
    roman: int | None = None
    letter: int | None = None
    for n in numberings:
        if n is None:
            continue
        value = n.numbers[-1]
        if n.kind is NumberingKind.ROMAN:
            if roman is None:
                cost += value != 1
            elif value <= roman:
                cost += _HARD
            else:
                cost += value != roman + 1
            roman, letter = value, None
        elif n.kind is NumberingKind.UPPER_ALPHA:
            if letter is None:
                cost += value != 1
            elif value <= letter:
                cost += _BACKWARD_LETTER
            else:
                cost += value != letter + 1
            letter = value
        elif n.kind < NumberingKind.UPPER_ALPHA:
            letter = None
            if n.kind < NumberingKind.ROMAN:
                roman = None
    return cost


def disambiguate_letters(numberings: Sequence[Numbering | None]) -> list[Numbering | None]:
    """Resolve single-letter ``I.``/``V.``/``X.`` headings, which read as Roman numerals or as
    letters, by a global minimum-cost assignment over the whole heading sequence.

    Every combination of readings of the ambiguous headings is scored with ``_sequence_cost``
    (exactly, for up to ``_BRUTE_FORCE_MAX`` ambiguous headings; longer runs are solved window
    by window, left to right, with later headings at their default reading). Ties go to the
    assignment closest to the default reading: letter if the document uses letter headings and
    no multi-letter Roman numerals, else Roman; then to the earliest such assignment.
    """
    result = list(numberings)
    ambiguous = [i for i, n in enumerate(result) if _is_ambiguous(n)]
    if not ambiguous:
        return result
    uses_alpha = any(n is not None and n.kind is NumberingKind.UPPER_ALPHA for n in numberings)
    uses_multi_roman = any(
        n is not None and n.kind is NumberingKind.ROMAN and len(n.label) > 1 for n in numberings
    )
    roman_reading = {i: result[i] for i in ambiguous}
    alpha_reading = {i: _alpha(n) for i, n in roman_reading.items() if n is not None}
    default, flipped = (
        (alpha_reading, roman_reading)
        if uses_alpha and not uses_multi_roman
        else (roman_reading, alpha_reading)
    )
    for i in ambiguous:
        result[i] = default[i]
    for start in range(0, len(ambiguous), _BRUTE_FORCE_MAX):
        window = ambiguous[start : start + _BRUTE_FORCE_MAX]

        def apply(mask: int, window: list[int] = window) -> None:
            for bit, i in enumerate(window):
                result[i] = flipped[i] if mask >> bit & 1 else default[i]

        def key(mask: int) -> tuple[int, int, int]:
            apply(mask)
            return (_sequence_cost(result), mask.bit_count(), mask)

        apply(min(range(1 << len(window)), key=key))
    return result


def _key(title: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", title).casefold().split()).rstrip(".:")


def is_appendix(title: str) -> bool:
    return _APPENDIX.match(unicodedata.normalize("NFKC", title).strip()) is not None


def is_back_matter(title: str) -> bool:
    return is_appendix(title) or _key(title) in _BACK_MATTER


def is_toc_title(title: str) -> bool:
    return _key(title) in _TOC_TITLES
