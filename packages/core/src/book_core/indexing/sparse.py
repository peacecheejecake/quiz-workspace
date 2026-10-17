"""Client-side BM25 term weighting for Qdrant sparse vectors (Korean + English).

Qdrant stores the term-frequency half of BM25 per document and applies IDF itself
(``Modifier.IDF``) from live collection statistics at query time, so documents never need
re-encoding when the corpus grows. Tokenisation happens here rather than in Qdrant's
server-side ``Qdrant/bm25`` inference because that splits Korean on whitespace only: an eojeol
such as ``염소를`` (noun + particle) never matches the query ``염소``. Instead:

- text is NFKC-normalised and case-folded;
- Hangul and CJK (Han/Kana) runs become overlapping character bigrams (a one-character run
  stays a unigram), which matches nouns regardless of the attached particle or ending without a
  morphological analyser or dictionary;
- every other run of letters/digits (Latin, Cyrillic, numbers...) is one word token; a short
  English stop-word list is dropped.

Terms are mapped to sparse indices with a stable hash (SHA-256, first 4 bytes), so the same text
gives the same vector in every process. ``BM25_VERSION`` is part of the collection's model key:
changing the tokenisation must create a new collection.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

BM25_VERSION = "bm25-kobigram-v1"

# Hangul syllables + jamo, CJK ideographs, Hiragana/Katakana.
_CJK_RANGES = (
    "ᄀ-ᇿ㄰-㆏가-힣"  # Hangul jamo, compatibility jamo, syllables
    "぀-ヿ"  # Hiragana, Katakana
    "㐀-䶿一-鿿豈-﫿"  # CJK ideographs
)
_RUN = re.compile(rf"([{_CJK_RANGES}]+)|([^\W_{_CJK_RANGES}]+)")

_EN_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "for",
        "from",
        "has",
        "have",
        "how",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "so",
        "than",
        "that",
        "the",
        "their",
        "then",
        "there",
        "these",
        "this",
        "those",
        "to",
        "was",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "why",
        "will",
        "with",
    ]
)


@dataclass(frozen=True, slots=True)
class SparseVector:
    """Sorted, unique ``indices`` with matching ``values``."""

    indices: tuple[int, ...]
    values: tuple[float, ...]

    def __post_init__(self) -> None:
        if len(self.indices) != len(self.values):
            raise ValueError("indices and values must have the same length")


def tokenize(text: str) -> list[str]:
    """BM25 terms of ``text`` in order (with repetitions)."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    terms: list[str] = []
    for cjk, word in _RUN.findall(normalized):
        if cjk:
            if len(cjk) == 1:
                terms.append(cjk)
            else:
                terms.extend(cjk[i : i + 2] for i in range(len(cjk) - 1))
        elif word not in _EN_STOPWORDS:
            terms.append(word)
    return terms


def term_index(term: str) -> int:
    """Stable unsigned 32-bit sparse index of a term."""
    return int.from_bytes(hashlib.sha256(term.encode("utf-8")).digest()[:4], "big")


@dataclass(frozen=True, slots=True)
class Bm25Encoder:
    """BM25 encoder: ``k1``/``b`` as usual; ``avg_doc_terms`` is the assumed average document
    length in terms (a constant, so encoding a document never depends on the rest of the
    corpus). The default fits children of the default chunker size (~256 tokens)."""

    k1: float = 1.2
    b: float = 0.75
    avg_doc_terms: float = 200.0

    def __post_init__(self) -> None:
        if self.k1 < 0 or not 0 <= self.b <= 1 or self.avg_doc_terms <= 0:
            raise ValueError("require k1 >= 0, 0 <= b <= 1 and avg_doc_terms > 0")

    def encode_document(self, text: str) -> SparseVector:
        """Saturated, length-normalised term frequencies (IDF is applied by Qdrant)."""
        terms = tokenize(text)
        norm = self.k1 * (1 - self.b + self.b * len(terms) / self.avg_doc_terms)
        weights: dict[int, float] = {}
        for term, tf in Counter(terms).items():
            index = term_index(term)
            weights[index] = weights.get(index, 0.0) + tf * (self.k1 + 1) / (tf + norm)
        return _sorted(weights)

    def encode_query(self, text: str) -> SparseVector:
        """One unit weight per distinct query term."""
        return _sorted(dict.fromkeys((term_index(t) for t in tokenize(text)), 1.0))


def _sorted(weights: dict[int, float]) -> SparseVector:
    items = sorted(weights.items())
    return SparseVector(tuple(i for i, _ in items), tuple(v for _, v in items))
