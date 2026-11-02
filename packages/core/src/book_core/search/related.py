"""Related passages after a submission (RELSRC-01, method A: search only, no LLM).

Pure helpers shared by the API's computation (`quiz_api.api.related_sources`):

- ``corpus_fingerprint``: the cache key part that says "which published corpus answered".
  SHA-256 over the sorted ``(document_id, active published revision id)`` pairs of the
  workspace's searchable books, the embedding model key and the chunk configuration version.
  A correction publish, a restore, an added or deleted book and an embedder switch (``make
  reindex`` into a new collection = a new model key) change it; reindexing the same revisions
  does not.
- ``related_query``: the search query, the stem plus the correct answer only (MCQ: the correct
  options' texts; short answer: the accepted answers; essay: the rubric), never a wrong option,
  cut to ``MAX_RELATED_QUERY_CHARS``.
- ``merge_related``: the deterministic list: the question's own source blocks first (order
  kept), then search hits, one row per block and per page, hits below the relevance floor
  dropped, at most ``limit`` rows.
- ``related_excerpt``: the shown excerpt (paragraph boundaries, at most ``MAX_EXCERPT_CHARS``)
  and the highlight ranges of the query terms in it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace

from book_core.search.excerpt import term_spans

# Bump when the chunking of indexed revisions changes in a way that changes search results
# without a new model key (the model key already covers the embedder, BM25 and payload schema).
CHUNK_CONFIG_VERSION = "1"
MAX_RELATED_QUERY_CHARS = 2000
MAX_EXCERPT_CHARS = 300
_ELLIPSIS = "…"


def corpus_fingerprint(
    books: Iterable[tuple[str, str]],
    *,
    embedding_model: str,
    chunk_config_version: str = CHUNK_CONFIG_VERSION,
) -> str:
    """Hex SHA-256 of the sorted (document id, published revision id) pairs + model + chunks."""
    pairs = sorted({(str(doc), str(rev)) for doc, rev in books})
    payload = json.dumps(
        {"books": pairs, "embedding_model": embedding_model, "chunks": chunk_config_version},
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def related_query(
    stem: str,
    *,
    question_type: str,
    options: Sequence[object] = (),
    correct_option_ids: Sequence[str] | None = None,
    accepted_answers: Sequence[str] | None = None,
    rubric: str | None = None,
    max_chars: int = MAX_RELATED_QUERY_CHARS,
) -> str:
    """Stem + the correct answer's text (see the module docstring); no wrong option."""
    answer: list[str] = []
    if question_type == "MCQ":
        correct = set(correct_option_ids or ())
        for option in options:
            if isinstance(option, dict) and str(option.get("id")) in correct:
                answer.append(str(option.get("text") or ""))
    elif question_type == "SHORT_ANSWER":
        answer.extend(str(a) for a in accepted_answers or ())
    elif rubric:
        answer.append(rubric)
    text = " ".join(p.strip() for p in (stem, *answer) if p and p.strip())
    return text[:max_chars]


@dataclass(frozen=True)
class RelatedCandidate:
    """One passage reference: the blocks it shows (the first is the row's block), its pages,
    and for search hits the relevance score (None = no scorer) and fusion score."""

    document_id: str
    revision_id: str
    block_ids: tuple[str, ...]
    page_start: int
    page_end: int
    from_question_source: bool = False
    score: float | None = None
    relevance: float | None = None


def merge_related(
    sources: Sequence[RelatedCandidate],
    hits: Sequence[RelatedCandidate],
    *,
    limit: int,
    min_relevance: float | None = None,
) -> list[RelatedCandidate]:
    """Question-source rows first, then hits; no repeated block or (document, page)."""
    if limit < 1:
        return []
    chosen: list[RelatedCandidate] = []
    blocks: set[tuple[str, str]] = set()
    pages: set[tuple[str, int]] = set()

    def take(candidate: RelatedCandidate) -> None:
        if len(chosen) >= limit or not candidate.block_ids:
            return
        keys = {(candidate.document_id, b) for b in candidate.block_ids}
        page = (candidate.document_id, candidate.page_start)
        if keys & blocks or page in pages:
            return
        blocks.update(keys)
        pages.add(page)
        chosen.append(candidate)

    for source in sources:
        take(replace(source, from_question_source=True, relevance=None))
    for hit in hits:
        if (
            min_relevance is not None
            and hit.relevance is not None
            and hit.relevance < min_relevance
        ):
            continue
        take(replace(hit, from_question_source=False))
    return chosen


def related_excerpt(
    paragraphs: Sequence[str], query: str, *, max_chars: int = MAX_EXCERPT_CHARS
) -> tuple[str, list[tuple[int, int]]]:
    """Whole paragraphs up to ``max_chars`` (a longer first paragraph is cut at a word boundary
    with an ellipsis) and the query-term ranges in that text."""
    parts = [" ".join(p.split()) for p in paragraphs]
    parts = [p for p in parts if p]
    text = ""
    for part in parts:
        candidate = f"{text}\n\n{part}" if text else part
        if len(candidate) <= max_chars:
            text = candidate
            continue
        if not text:
            cut = part[: max_chars - len(_ELLIPSIS)]
            space = cut.rfind(" ")
            if space > max_chars // 2:
                cut = cut[:space]
            text = cut.rstrip() + _ELLIPSIS
        break
    spans = [(s, e) for s, e in term_spans(text, query) if 0 <= s < e <= len(text)] if text else []
    return text, spans


__all__ = [
    "CHUNK_CONFIG_VERSION",
    "MAX_EXCERPT_CHARS",
    "MAX_RELATED_QUERY_CHARS",
    "RelatedCandidate",
    "corpus_fingerprint",
    "merge_related",
    "related_excerpt",
    "related_query",
]
