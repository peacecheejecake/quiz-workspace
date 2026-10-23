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


_ENCLOSED_FIRST, _ENCLOSED_LAST = "\u2460", "\u24ff"
"""Enclosed alphanumerics (``①``-``⑳``, ``⑴``, ``⒈``, ``ⓐ`` ...)."""
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
    # ``1-1.`` / ``2-3-1.`` (Korean textbooks); the trailing dot is required so dates, ranges
    # and phone numbers (``2025-2026 전망``) are not read as numbering.
    (NumberingKind.NUM1, re.compile(r"^(\d{1,3}(?:-\d{1,3})+)\.(?=\s|$)")),
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
    stripped = title.strip()
    # A circled or parenthesized digit (``① 장 단위로 ...``) is a list item; NFKC would turn it
    # into a plain number that reads as ``1장``.
    enclosed = bool(stripped) and _ENCLOSED_FIRST <= stripped[0] <= _ENCLOSED_LAST
    text = unicodedata.normalize("NFKC", stripped)
    for kind, pattern in _PATTERNS:
        if enclosed and kind < NumberingKind.ROMAN:
            continue
        match = pattern.match(text)
        if match is None:
            continue
        raw = next(group for group in match.groups() if group is not None)
        if "." in raw or "-" in raw:
            numbers = tuple(int(part) for part in re.split(r"[.\-]", raw))
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

_State = tuple[int | None, int | None]
"""Last Roman value and last letter value of the current sequences (``None`` = not started)."""
_Key = tuple[int, int, int]
"""(cost, readings flipped from the default, flip mask with later headings as higher bits)."""


def _step(state: _State, n: Numbering | None) -> tuple[_State, int]:
    """Sequence state after heading ``n`` and the cost ``n`` adds.

    Roman headings form one sequence (reset only by an outer Part/Chapter/제N절 heading) that
    must start at I and increase by one; letter headings restart under every outer heading
    (Roman, Chapter, numbered ...) and must start at A and increase by one. A gap or a wrong
    start costs 1, a letter going backwards ``_BACKWARD_LETTER``, a Roman numeral that does not
    increase ``_HARD``.
    """
    roman, letter = state
    if n is None:
        return state, 0
    value = n.numbers[-1]
    if n.kind is NumberingKind.ROMAN:
        if roman is None:
            cost = int(value != 1)
        elif value <= roman:
            cost = _HARD
        else:
            cost = int(value != roman + 1)
        return (value, None), cost
    if n.kind is NumberingKind.UPPER_ALPHA:
        if letter is None:
            cost = int(value != 1)
        elif value <= letter:
            cost = _BACKWARD_LETTER
        else:
            cost = int(value != letter + 1)
        return (roman, value), cost
    if n.kind < NumberingKind.ROMAN:
        return (None, None), 0
    if n.kind < NumberingKind.UPPER_ALPHA:
        return (roman, None), 0
    return state, 0


def _sequence_cost(numberings: Sequence[Numbering | None]) -> int:
    """Total ``_step`` cost of a fully resolved heading list."""
    state: _State = (None, None)
    cost = 0
    for n in numberings:
        state, added = _step(state, n)
        cost += added
    return cost


def _resets_all(n: Numbering | None) -> bool:
    return n is not None and n.kind < NumberingKind.ROMAN


def _solve_segment(
    segment: Sequence[Numbering | None],
    default: Sequence[Numbering | None],
    flipped: Sequence[Numbering | None],
) -> int:
    """Flip mask (bit j = j-th ambiguous heading of the segment takes the non-default reading)
    with the minimum ``_Key``, by dynamic programming over the sequence state.

    Paths reaching the same state share their future, so keeping the minimum key per state is
    exact: future costs and flips add equally, and future flips are higher mask bits.
    """
    frontier: dict[_State, _Key] = {(None, None): (0, 0, 0)}
    bit = 0
    for n, d, f in zip(segment, default, flipped, strict=True):
        nxt: dict[_State, _Key] = {}
        options = [(n, 0)] if not _is_ambiguous(n) else [(d, 0), (f, 1 << bit)]
        for state, (cost, flips, mask) in frontier.items():
            for reading, flip in options:
                after, added = _step(state, reading)
                key = (cost + added, flips + (flip != 0), mask | flip)
                if after not in nxt or key < nxt[after]:
                    nxt[after] = key
        frontier = nxt
        bit += _is_ambiguous(n)
    return min(frontier.values())[2]


def disambiguate_letters(numberings: Sequence[Numbering | None]) -> list[Numbering | None]:
    """Resolve single-letter ``I.``/``V.``/``X.`` headings, which read as Roman numerals or as
    letters, by a global minimum-cost assignment over the whole heading sequence.

    The cost of an assignment is ``_sequence_cost``. Ties go to the assignment closest to the
    document's default reading (letter if it uses letter headings and no multi-letter Roman
    numerals, else Roman), then to the one that keeps later headings at the default. Headings
    that reset both sequences (Part/Chapter/제N절 ...) split the list into independent segments,
    each solved exactly by dynamic programming over the sequence state, in linear time.
    """
    result = list(numberings)
    if not any(_is_ambiguous(n) for n in result):
        return result
    uses_alpha = any(n is not None and n.kind is NumberingKind.UPPER_ALPHA for n in numberings)
    uses_multi_roman = any(
        n is not None and n.kind is NumberingKind.ROMAN and len(n.label) > 1 for n in numberings
    )
    alpha_default = uses_alpha and not uses_multi_roman
    alpha = [_alpha(n) if n is not None and _is_ambiguous(n) else n for n in result]
    default, flipped = (alpha, result) if alpha_default else (result, alpha)

    bounds = [i for i, n in enumerate(result) if i > 0 and _resets_all(n)]
    out = list(default)
    for start, end in zip([0, *bounds], [*bounds, len(result)], strict=True):
        segment = result[start:end]
        mask = _solve_segment(segment, default[start:end], flipped[start:end])
        bit = 0
        for i in range(start, end):
            if _is_ambiguous(result[i]):
                if mask >> bit & 1:
                    out[i] = flipped[i]
                bit += 1
    return out


_BARE_LABEL = re.compile(
    rf"^(?:제\s*{_NUM}\s*[부편장절]|{_NUM}\s*[부장절]|(?:part|chapter|ch\.)\s*(?:{_NUM}|{_ROMAN_RE}))"
    r"[.:]?$",
    re.IGNORECASE,
)


def is_bare_label(title: str) -> bool:
    """A Part/Chapter/제N절 label without a title (``제1 장``, ``Chapter 3``), as printed when the
    title is set as a separate line."""
    return _BARE_LABEL.match(unicodedata.normalize("NFKC", title).strip()) is not None


def _key(title: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", title).casefold().split()).rstrip(".:")


def is_appendix(title: str) -> bool:
    return _APPENDIX.match(unicodedata.normalize("NFKC", title).strip()) is not None


def is_back_matter(title: str) -> bool:
    return is_appendix(title) or _key(title) in _BACK_MATTER


def is_toc_title(title: str) -> bool:
    return _key(title) in _TOC_TITLES
