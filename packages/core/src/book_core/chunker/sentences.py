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


Span = tuple[int, int]
"""Half-open character range ``[start, end)`` of the text being split."""

_WORD = re.compile(r"\S+")


def _strip(text: str, start: int, end: int) -> Span:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def sentence_spans(text: str) -> list[Span]:
    """Sentence ranges of ``text`` in order, without surrounding whitespace. Slicing ``text``
    from one span's start to a later span's end reproduces the original text exactly. Text
    without sentence punctuation is one sentence."""
    spans: list[Span] = []
    start = 0
    for match in _BOUNDARY.finditer(text):
        end = match.start()
        if end <= start:
            continue
        if text[end - 1] == "." and _is_abbreviation(text[start:end]):
            continue
        spans.append(_strip(text, start, end))
        start = match.end()
    spans.append(_strip(text, start, len(text)))
    return [(s, e) for s, e in spans if s < e]


def split_sentences(text: str) -> list[str]:
    """Sentences of ``text`` in order (see ``sentence_spans``)."""
    return [text[s:e] for s, e in sentence_spans(text)]


def oversized_spans(text: str, span: Span, budget: int, tokenizer: Tokenizer) -> list[Span]:
    """Split ``text[span]`` (a sentence longer than ``budget`` tokens) at word boundaries, or at
    characters for a word that alone exceeds the budget (unspaced CJK runs, URLs). The pieces
    are contiguous ranges of ``text``, so slicing from the first start to the last end restores
    the original characters, separators included."""
    pieces: list[Span] = []
    current: Span | None = None
    used = 0
    for match in _WORD.finditer(text, span[0], span[1]):
        word = (match.start(), match.end())
        cost = tokenizer.count(match.group())
        if cost > budget:
            if current is not None:
                pieces.append(current)
                current, used = None, 0
            pieces.extend(_char_spans(text, word, budget, tokenizer))
            continue
        if current is not None and used + cost > budget:
            pieces.append(current)
            current, used = None, 0
        current = word if current is None else (current[0], word[1])
        used += cost
    if current is not None:
        pieces.append(current)
    return pieces


def split_oversized(text: str, budget: int, tokenizer: Tokenizer) -> list[str]:
    """``oversized_spans`` over the whole ``text``, as strings."""
    return [text[s:e] for s, e in oversized_spans(text, (0, len(text)), budget, tokenizer)]


def _char_spans(text: str, word: Span, budget: int, tokenizer: Tokenizer) -> list[Span]:
    pieces: list[Span] = []
    start, stop = word
    while start < stop:
        end = start + 1
        # Grow while the piece fits; a tokenizer charging >budget for one char still advances.
        while end < stop and tokenizer.count(text[start : end + 1]) <= budget:
            end += 1
        pieces.append((start, end))
        start = end
    return pieces
