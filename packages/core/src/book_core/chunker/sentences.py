"""Sentence-aware splitting of long paragraphs (Korean and English)."""

from __future__ import annotations

import re

from book_core.chunker.tokens import Tokenizer

# A sentence ends at terminal punctuation (optionally followed by closing quotes/brackets)
# followed by whitespace. Korean prose ends sentences with ``다.``/``요.``/``까?`` etc., so the
# same punctuation rule covers it; full-width terminators (U+3002, U+FF01, U+FF1F) may end a
# sentence without a following space.
_TERMINAL = ".!?\u2026"
_CLOSERS = "\"'\u201d\u2019)\\]\u300d\u300f»"
_FULL_WIDTH_TERMINAL = "\u3002\uff01\uff1f"
_BOUNDARY = re.compile(
    "(?:(?<=[" + _TERMINAL + "])|(?<=[" + _TERMINAL + "][" + _CLOSERS + "]))\\s+"
    "|(?<=[" + _FULL_WIDTH_TERMINAL + "])\\s*|\\n+"
)
# Tokens before a period that do not end a sentence (``e.g. this``, ``Fig. 2``, ``Dr. Kim``).
_ABBREVIATIONS = frozenset(
    {
        "al",
        "approx",
        "cf",
        "dr",
        "e.g",
        "eq",
        "etc",
        "fig",
        "figs",
        "i.e",
        "jr",
        "mr",
        "mrs",
        "ms",
        "no",
        "nos",
        "p",
        "pp",
        "prof",
        "sec",
        "sr",
        "st",
        "vol",
        "vs",
    }
)
_LAST_WORD = re.compile(r"(\S+)\.$")


def _is_abbreviation(head: str) -> bool:
    match = _LAST_WORD.search(head)
    if match is None:
        return False
    word = match.group(1).lower().lstrip("([\"'")
    # Single initials (``J. Smith``) and listed abbreviations; ``etc.`` may still end a sentence
    # but merging two sentences only makes a piece slightly larger, never wrong.
    return word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha() and word.isascii())


def split_sentences(text: str) -> list[str]:
    """Sentences of ``text`` in order; joining them with single spaces restores the text up to
    whitespace. Text without sentence punctuation is one sentence."""
    sentences: list[str] = []
    start = 0
    for match in _BOUNDARY.finditer(text):
        end = match.start()
        if end <= start:
            continue
        head = text[start:end]
        if head.endswith(".") and _is_abbreviation(head):
            continue
        sentences.append(head.strip())
        start = match.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return [s for s in sentences if s]


def split_oversized(text: str, budget: int, tokenizer: Tokenizer) -> list[str]:
    """Split one sentence longer than ``budget`` tokens at word boundaries, or at characters for
    a word that alone exceeds the budget (unspaced CJK runs, URLs)."""
    pieces: list[str] = []
    current: list[str] = []
    used = 0
    for word in text.split():
        cost = tokenizer.count(word)
        if cost > budget:
            if current:
                pieces.append(" ".join(current))
                current, used = [], 0
            pieces.extend(_split_chars(word, budget, tokenizer))
            continue
        if current and used + cost > budget:
            pieces.append(" ".join(current))
            current, used = [], 0
        current.append(word)
        used += cost
    if current:
        pieces.append(" ".join(current))
    return pieces


def _split_chars(word: str, budget: int, tokenizer: Tokenizer) -> list[str]:
    pieces: list[str] = []
    start = 0
    while start < len(word):
        end = start + 1
        # Grow while the piece fits; a tokenizer charging >budget for one char still advances.
        while end < len(word) and tokenizer.count(word[start : end + 1]) <= budget:
            end += 1
        pieces.append(word[start:end])
        start = end
    return pieces
