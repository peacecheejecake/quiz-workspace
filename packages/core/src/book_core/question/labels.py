"""Printed option labels (①, A., (1), 1)) and answer-key tokens, mapped to stable option ids.

A label is reduced to a canonical key: circled and parenthesised digits to the digit (``①`` ->
``1``), Latin letters to upper case (``a)`` -> ``A``). Option ids are ``opt-<key>``, so the
answer key ("2. A, C, D") maps to ids without relying on display position (questions.md §4).
"""

from __future__ import annotations

import re
import unicodedata

CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩"

_OPTION_MARKER = re.compile(
    r"""^\s*(?:
        (?P<circled>[①-⑩])\s*
      | \(\s*(?P<paren>10|[1-9]|[A-Ea-e])\s*\)\s*
      | (?P<latin>[A-E])[.)]\s+
      | (?P<lower>[a-e])\)\s+
      | (?P<digit>10|[1-9])\)\s+
    )(?P<text>.*)$""",
    re.VERBOSE,
)
_ANSWER_SPLIT = re.compile(r"[,\uff0c\u3001/\u00b7;\s]+|\b(?:and|or)\b|및|와|과")
HANGUL_LABELS = "가나다라마바사아자차"
_ANSWER_TOKEN = re.compile(rf"^\(?\s*(10|[1-9]|[A-Ea-e]|[{HANGUL_LABELS}])\s*\)?\.?(?:번)?$")


def canonical_key(label: str) -> str:
    """``①``/``(1)``/``1)``/``1`` -> ``1``; ``A.``/``(a)``/``a)`` -> ``A``."""
    label = label.strip().strip("().").strip()
    if len(label) == 1 and label in CIRCLED_DIGITS:
        return str(CIRCLED_DIGITS.index(label) + 1)
    return label.upper()


def option_id(key: str) -> str:
    return f"opt-{key}"


def split_option_line(text: str) -> list[tuple[str, str]] | None:
    """``[(label, text), ...]`` when ``text`` starts with an option marker, else ``None``.

    Circled markers can share one line (``① 응결 ② 증발``); other styles are one per line.
    """
    match = _OPTION_MARKER.match(text)
    if match is None:
        return None
    if match.group("circled") is not None:
        parts = re.split(r"([①-⑩])", text.strip())
        options: list[tuple[str, str]] = []
        for marker, body in zip(parts[1::2], parts[2::2], strict=True):
            options.append((marker, body.strip()))
        return options
    label = next(
        match.group(name)
        for name in ("paren", "latin", "lower", "digit")
        if match.group(name) is not None
    )
    return [(label, match.group("text").strip())]


def answer_option_keys(text: str) -> tuple[str, ...] | None:
    """Canonical option keys of an MCQ answer (``②``, ``A, C, D``, ``2, 4``, ``3번``, ``나``).

    ``None`` when the text is not purely a list of option labels (e.g. a written answer).
    """
    text = unicodedata.normalize("NFC", text).strip()
    if not text:
        return None
    circled = [c for c in text if c in CIRCLED_DIGITS]
    if circled:
        rest = re.sub(r"[①-⑩]", "", text)
        if _ANSWER_SPLIT.sub("", rest):
            return None
        return tuple(canonical_key(c) for c in circled)
    tokens = [t for t in _ANSWER_SPLIT.split(text) if t]
    keys: list[str] = []
    for token in tokens:
        match = _ANSWER_TOKEN.match(token)
        if match is None:
            return None
        keys.append(canonical_key(match.group(1)))
    return tuple(keys) or None


def loose_text(text: str) -> str:
    """NFKC without whitespace: compares texts that differ only in spacing or line breaks."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


# ------------------------------------------------------------------------------------------
# Stem items (questions.md §4 11, STEM-ITEMS): ``(가) ...`` ``(나) ...`` printed between the
# question sentence and the options. Option labels (``①``-``⑳``, ``❶``, ``➀``) and ``1.`` are
# never item labels.


def _run(first: str, last: str) -> tuple[str, ...]:
    return tuple(chr(c) for c in range(ord(first), ord(last) + 1))


_ROMAN = ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII")
_TEXT_FORMATS = frozenset({"paren", "fullparen", "close", "dot"})
# Family -> (labels in order, the formats it is printed in).
_ITEM_FAMILIES: dict[str, tuple[tuple[str, ...], frozenset[str]]] = {
    "hangul": (tuple("가나다라마바사아자차카타파하"), _TEXT_FORMATS),
    "jamo": (tuple("ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"), _TEXT_FORMATS),
    "upper": (_run("A", "Z"), _TEXT_FORMATS),
    "lower": (_run("a", "z"), _TEXT_FORMATS),
    "roman": (_run("\u2160", "\u216b"), _TEXT_FORMATS),  # Roman numeral signs
    "roman-small": (_run("\u2170", "\u217b"), _TEXT_FORMATS),
    "roman-ascii": (_ROMAN, _TEXT_FORMATS),
    "arabic": (tuple(str(n) for n in range(1, 21)), frozenset({"paren", "fullparen", "close"})),
    "circled-jamo": (_run("㉠", "㉭"), frozenset({"bare"})),
    "circled-hangul": (_run("㉮", "㉻"), frozenset({"bare"})),
    "paren-jamo": (_run("㈀", "㈍"), frozenset({"bare"})),
    "paren-hangul": (_run("㈎", "㈛"), frozenset({"bare"})),
    "circled-lower": (_run("ⓐ", "ⓩ"), frozenset({"bare"})),
    "circled-upper": (_run("Ⓐ", "Ⓩ"), frozenset({"bare"})),
    "paren-digit": (_run("⑴", "⒇"), frozenset({"bare"})),
    "paren-lower": (_run("⒜", "⒵"), frozenset({"bare"})),
}


def _item_ordinals() -> dict[str, list[tuple[str, int]]]:
    """Label -> ``(family, 1-based ordinal)`` for every family it belongs to."""
    out: dict[str, list[tuple[str, int]]] = {}
    for family, (labels, _) in _ITEM_FAMILIES.items():
        for ordinal, label in enumerate(labels, start=1):
            out.setdefault(label, []).append((family, ordinal))
    return out


_ITEM_ORDINALS = _item_ordinals()
_BARE_ITEMS = "".join(
    label for labels, formats in _ITEM_FAMILIES.values() if "bare" in formats for label in labels
)
# A label token: at the start or after whitespace, followed by whitespace and some content, so a
# mention inside a sentence ("(가)와 (나)에", "빈칸 (가)에") is never one. Spaces inside the
# brackets do not matter (``( 가 )``).
_ITEM_TOKEN = re.compile(
    rf"""(?:^|(?<=\s))(?:
        \(\s*(?P<paren>[^\s()\uff08\uff09]{{1,4}})\s*\)
      | \uff08\s*(?P<fullparen>[^\s()\uff08\uff09]{{1,4}})\s*\uff09
      | (?P<close>[^\s()\uff08\uff09.]{{1,4}})\)
      | (?P<dot>[^\s()\uff08\uff09.]{{1,4}})\.
      | (?P<bare>[{_BARE_ITEMS}])
    )(?=\s+\S)""",
    re.VERBOSE,
)
_ITEM_FORMATS = ("paren", "fullparen", "close", "dot", "bare")
# The question sentence before the first item ends a sentence, a quotation or an answer blank.
_BEFORE_FIRST_ITEM = re.compile(r"[?\uff1f.:\uff1a)\uff09」>]\s*$")


def _item_tokens(text: str) -> list[tuple[int, str, str, int]]:
    """``(offset, family, format, ordinal)`` of every item-label token in ``text``; a token that
    reads in several families (``I``: Latin 9th, Roman 1st) appears once per family."""
    tokens: list[tuple[int, str, str, int]] = []
    for match in _ITEM_TOKEN.finditer(text):
        fmt = next(f for f in _ITEM_FORMATS if match.group(f) is not None)
        for family, ordinal in _ITEM_ORDINALS.get(match.group(fmt), []):
            if fmt in _ITEM_FAMILIES[family][1]:
                tokens.append((match.start(), family, fmt, ordinal))
    return tokens


def has_item_label(text: str) -> bool:
    """Whether ``text`` holds an item-label token anywhere (``... 것은? (가) 갑 (나) 을``), any
    family or format and no list rules: lenient, for telling options from questions."""
    return bool(_item_tokens(text))


def stem_item_starts(text: str) -> list[int]:
    """Offsets of the printed item labels of the stem's item list, ``[]`` without one.

    ``text`` is one paragraph. A list is the label tokens of one family, all in one format, that
    run exactly from the family's first label in order (``(가)`` ``(나)``, ``ㄱ.`` ``ㄴ.``,
    ``⑴`` ``⑵``), at least two. Any other token of that family in the paragraph (a missing,
    skipped or swapped label, another format) means no list at all: ``(가) … (다) … (나) …``
    is left alone. Text before the first item must end like a question sentence (``?``, ``.``,
    ``:``, ``)``, ``」``, ``>``, an answer blank ``( )``).
    """
    tokens = _item_tokens(text)
    for family in dict.fromkeys(family for _, family, _, ordinal in tokens if ordinal == 1):
        run = [t for t in tokens if t[1] == family]
        if len(run) < 2 or len({fmt for _, _, fmt, _ in run}) != 1:
            continue
        if [ordinal for *_, ordinal in run] != list(range(1, len(run) + 1)):
            continue
        head = text[: run[0][0]].strip()
        if head and _BEFORE_FIRST_ITEM.search(head) is None:
            continue
        return [start for start, *_ in run]
    return []


def break_stem_items(text: str) -> str:
    """``text`` with each stem item on its own line and a blank line between the question
    sentence and the first item (``stem_item_starts``); unchanged without an item list."""
    starts = stem_item_starts(text)
    if not starts:
        return text
    items = [text[a:b].strip() for a, b in zip(starts, [*starts[1:], len(text)], strict=True)]
    head = text[: starts[0]].strip()
    body = "\n".join(items)
    return f"{head}\n\n{body}" if head else body


# A label at the very start, in any item format and with nothing required after it: ``(가)``,
# ``( 가 )``, ``ㄱ.``, ``a)``, ``㉠``, or bare before a separator or the end (``ㄱ, ㄴ``).
_LEADING_LABEL = re.compile(
    rf"""^\s*(?:
        [(\uff08]\s*(?P<bracket>[^\s()\uff08\uff09]{{1,4}})\s*[)\uff09]
      | (?P<closed>[^\s()\uff08\uff09.,]{{1,4}})[).]
      | (?P<bare>[^\s()\uff08\uff09.,、·]{{1,4}})(?=\s*[,、·]|\s*$)
      | (?P<enclosed>[{_BARE_ITEMS}])
    )""",
    re.VERBOSE,
)


def leading_item_families(text: str) -> frozenset[str]:
    """The item families (``hangul``, ``jamo``, ...) of a label that starts ``text``, any format
    and position in the family; empty without one. Lenient on purpose: it tells which lines name
    stem items (``(가) ...`` printed under the question, ``1. (가), (나)`` options), not how the
    stem is laid out, so it needs neither a sentence end nor a complete list (questions.md §4 11).
    Option labels (``①``, ``❶``, ``➀``) belong to no family."""
    match = _LEADING_LABEL.match(text)
    if match is None:
        return frozenset()
    core = next(g for g in match.groups() if g is not None)
    return frozenset(family for family, _ in _ITEM_ORDINALS.get(core, []))
