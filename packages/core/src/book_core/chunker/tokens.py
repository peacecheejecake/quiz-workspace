"""Token budgeting: a tokenizer interface and a deterministic, CJK-aware approximation."""

from __future__ import annotations

import re
from typing import Protocol, runtime_checkable


@runtime_checkable
class Tokenizer(Protocol):
    """Counts the tokens a text costs in the embedding/reranking model.

    ``count`` must be deterministic and additive over whitespace-separated pieces (the count of
    ``"a b"`` equals the counts of ``"a"`` and ``"b"``), which subword tokenizers satisfy closely
    enough for budgeting. A model tokenizer (e.g. Qwen3's, M2.1) can be plugged in here.
    """

    @property
    def name(self) -> str: ...

    def count(self, text: str) -> int: ...


# Hangul syllables/jamo, CJK ideographs, kana: one token per character. Latin/other letters
# grouped into words, digits into numbers, anything else (punctuation, symbols) one token each.
_CJK = r"ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힣豈-﫿"
_TOKEN = re.compile(rf"([{_CJK}])|([^\W\d_{_CJK}]+)|(\d+)|(\S)")


class ApproxTokenizer:
    """Conservative approximation of a multilingual BPE tokenizer (Qwen3-like), no model needed.

    - Hangul / CJK: 1 token per character (real tokenizers use ~0.6-1 per syllable);
    - Latin and other alphabetic words: 1 token per started ``chars_per_token`` characters;
    - digit runs: 1 token per started 3 digits;
    - punctuation and other symbols: 1 token each; whitespace is free.

    It errs on the high side so chunks budgeted with it stay within the real model's limits.
    """

    def __init__(self, chars_per_token: int = 4) -> None:
        if chars_per_token < 1:
            raise ValueError("chars_per_token must be >= 1")
        self._chars_per_token = chars_per_token

    @property
    def name(self) -> str:
        return f"approx-cjk-v1/{self._chars_per_token}"

    def count(self, text: str) -> int:
        total = 0
        for match in _TOKEN.finditer(text):
            word, digits = match.group(2), match.group(3)
            if word is not None:
                total += -(-len(word) // self._chars_per_token)
            elif digits is not None:
                total += -(-len(digits) // 3)
            else:
                total += 1
        return total
