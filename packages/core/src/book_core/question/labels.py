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
