"""Text featurisation shared by the deterministic fake adapters.

Uses SHA-256 rather than ``hash()`` so results are identical across processes, machines and
``PYTHONHASHSEED`` values. Tokenisation is Unicode-aware (``\\w`` matches Hangul, CJK, Latin...),
so the fakes behave the same for any language without a language-specific model.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

_TOKEN = re.compile(r"\w+")


def features(text: str) -> list[str]:
    """Word tokens plus in-word character bigrams of NFKC-normalised, case-folded text."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    result: list[str] = []
    for token in _TOKEN.findall(normalized):
        result.append(f"w:{token}")
        result.extend(f"b:{token[i : i + 2]}" for i in range(len(token) - 1))
    return result


def stable_digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()
