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
# Tables in a stem (questions.md §4 11, QTABLE-01): GFM pipe tables. `apps/web` mirrors these
# rules in `stem-table.ts`; tests/fixtures/question-tables.json holds their shared cases.

_PIPE_DELIMITER_CELL = re.compile(r":?-+:?")


def _pipe_cells(line: str) -> list[str] | None:
    """Cells of a ``| a | b |`` row (``\\|`` stays inside its cell), ``None`` for another line."""
    line = line.strip()
    if len(line) < 2 or line[0] != "|":
        return None
    cells: list[str] = []
    start = 1
    i = 1
    while i < len(line):
        if line[i] == "\\":
            i += 2
            continue
        if line[i] == "|":
            cells.append(line[start:i].strip())
            start = i + 1
        i += 1
    return cells if start == len(line) else None


def _is_pipe_table(rows: list[list[str]]) -> bool:
    """A header row, a delimiter row and the same number of cells in every row."""
    return (
        len(rows) >= 2
        and all(_PIPE_DELIMITER_CELL.fullmatch(cell) for cell in rows[1])
        and len({len(row) for row in rows}) == 1
    )


def split_pipe_blocks(text: str) -> list[tuple[bool, str]]:
    """``text`` as ``(is table, segment)`` in order, segments stripped and empty ones dropped.

    A table is a run of consecutive ``| ... |`` lines that passes ``_is_pipe_table``; any other
    run (a row with another cell count, no delimiter row) stays text, whole.
    """
    segments: list[tuple[bool, str]] = []
    plain: list[str] = []

    def flush() -> None:
        body = "\n".join(plain).strip()
        plain.clear()
        if body:
            segments.append((False, body))

    lines = text.split("\n")
    i = 0
    while i < len(lines):
        end = i
        rows: list[list[str]] = []
        while end < len(lines) and (cells := _pipe_cells(lines[end])) is not None:
            rows.append(cells)
            end += 1
        if _is_pipe_table(rows):
            flush()
            segments.append((True, "\n".join(line.strip() for line in lines[i:end])))
        else:
            plain += lines[i : max(end, i + 1)]
        i = max(end, i + 1)
    flush()
    return segments


def has_pipe_table(text: str) -> bool:
    return any(is_table for is_table, _ in split_pipe_blocks(text))


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
    # Both endpoints of a printed range are references, not item starts.
    references = [
        match.span()
        for match in re.finditer(
            r"[\uff08(][^()\uff08\uff09\r\n]+[)\uff09]\s*[~\uff5e]\s*[\uff08(][^()\uff08\uff09\r\n]+[)\uff09]",
            text,
        )
    ]
    tokens = [t for t in tokens if not any(a <= t[0] < b for a, b in references)]
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
    sentence and the first item (``stem_item_starts``); unchanged without an item list. Only the
    text around a pipe table is read: its cells are never items, and it stands apart from that
    text by blank lines."""
    segments = split_pipe_blocks(text)
    if not any(is_table for is_table, _ in segments):
        return _break_items(text)
    return "\n\n".join(
        segment if is_table else _break_items(segment) for is_table, segment in segments
    )


def _break_items(text: str) -> str:
    starts = stem_item_starts(text)
    item_end = len(text)
    if not starts:
        candidates = re.finditer(r"(?<!\S)-\s+(?=\S)", text)
        bullets: list[re.Match[str]] = []
        sentence_end = re.compile(r"[.!?。\uff01\uff1f][)\uff09\"'\u2019”」』]*\s*$")
        for candidate in candidates:
            prefix = text[: candidate.start()]
            line_start = not prefix.strip() or re.search(r"\n[^\S\r\n]*$", prefix)
            # A closing answer mark can introduce the first item, but is not a sentence
            # boundary between items (it can close an operand within an item).
            boundary = sentence_end.search(prefix) if bullets else _BEFORE_FIRST_ITEM.search(prefix)
            if line_start or boundary:
                bullets.append(candidate)
        if bullets:
            paragraph_end = re.search(r"\r?\n(?:[^\S\r\n]*\r?\n)+", text[bullets[0].start() :])
            if paragraph_end:
                item_end = bullets[0].start() + paragraph_end.start()
                bullets = [bullet for bullet in bullets if bullet.start() < item_end]
        bullet_bodies = [
            text[m.end() : end].strip()
            for m, end in zip(bullets, [*(n.start() for n in bullets[1:]), item_end], strict=False)
        ]
        if (
            len(bullets) >= 2
            and (
                not text[: bullets[0].start()].strip()
                or _BEFORE_FIRST_ITEM.search(text[: bullets[0].start()].strip())
            )
            and all(sentence_end.search(body) for body in bullet_bodies)
        ):
            starts = [m.start() for m in bullets]
        else:
            passage = re.search(r"[?\uff1f]\s*\(\s*\)\s+(?=\S)", text)
            if (
                passage
                and len(text[passage.end() :].strip()) >= 40
                and "\n\n" not in passage.group()
            ):
                return text[: passage.end()].rstrip() + "\n\n" + text[passage.end() :].lstrip()
            return text
    items = [text[a:b].strip() for a, b in zip(starts, [*starts[1:], item_end], strict=True)]
    head = text[: starts[0]].strip()
    body = "\n".join(items)
    return (f"{head}\n\n{body}" if head else body) + text[item_end:]


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
