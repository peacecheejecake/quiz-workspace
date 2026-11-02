"""RELSRC-01 pure helpers: the corpus fingerprint (C03, including the embedder switch), the
answer-only query and the deterministic merge (C02)."""

from __future__ import annotations

import re

from book_core.embedding import FakeEmbedder
from book_core.indexing import embedder_model_key
from book_core.search import DEFAULT_MAX_QUERY_CHARS, prepare_query
from book_core.search.related import (
    MAX_EXCERPT_CHARS,
    RelatedCandidate,
    corpus_fingerprint,
    merge_related,
    related_excerpt,
    related_query,
)

BOOKS = [("doc-a", "rev-a1"), ("doc-b", "rev-b1")]
MODEL = embedder_model_key(FakeEmbedder())


def test_relsrc_01_c03_fingerprint_is_a_stable_sha256_of_the_sorted_books() -> None:
    first = corpus_fingerprint(BOOKS, embedding_model=MODEL)
    assert re.fullmatch(r"[0-9a-f]{64}", first)
    assert corpus_fingerprint(list(reversed(BOOKS)), embedding_model=MODEL) == first
    assert corpus_fingerprint([*BOOKS, BOOKS[0]], embedding_model=MODEL) == first


def test_relsrc_01_c03_fingerprint_changes_with_publish_restore_add_and_delete() -> None:
    base = corpus_fingerprint(BOOKS, embedding_model=MODEL)
    published = corpus_fingerprint([("doc-a", "rev-a2"), BOOKS[1]], embedding_model=MODEL)
    added = corpus_fingerprint([*BOOKS, ("doc-c", "rev-c1")], embedding_model=MODEL)
    deleted = corpus_fingerprint(BOOKS[:1], embedding_model=MODEL)
    assert len({base, published, added, deleted}) == 4


def test_relsrc_01_c03_an_embedder_switch_changes_the_fingerprint() -> None:
    """`make reindex` into a new collection = another model key (another model or dimension)."""
    other = embedder_model_key(FakeEmbedder(dimension=FakeEmbedder().dimension * 2))
    assert other != MODEL
    assert corpus_fingerprint(BOOKS, embedding_model=MODEL) != corpus_fingerprint(
        BOOKS, embedding_model=other
    )
    assert corpus_fingerprint(BOOKS, embedding_model=MODEL) != corpus_fingerprint(
        BOOKS, embedding_model=MODEL, chunk_config_version="2"
    )


def test_relsrc_01_c02_query_is_stem_and_correct_answer_only() -> None:
    options = [
        {"id": "a", "text": "가나다 원리"},
        {"id": "b", "text": "마바사 오개념"},
    ]
    mcq = related_query("발문?", question_type="MCQ", options=options, correct_option_ids=["a"])
    assert mcq == "발문? 가나다 원리"
    short = related_query("발문?", question_type="SHORT_ANSWER", accepted_answers=["증발", "기화"])
    assert short == "발문? 증발 기화"
    essay = related_query("발문?", question_type="ESSAY", rubric="핵심 기준")
    assert essay == "발문? 핵심 기준"
    assert len(related_query("가" * 5000, question_type="ESSAY")) == DEFAULT_MAX_QUERY_CHARS


def _c(block: str, page: int, doc: str = "d", relevance: float | None = None) -> RelatedCandidate:
    return RelatedCandidate(doc, "r", (block,), page, page, relevance=relevance)


def test_relsrc_01_c02_merge_sources_first_dedup_floor_and_limit() -> None:
    sources = [_c("s1", 2)]
    hits = [
        _c("s1", 2, relevance=0.9),  # the source block again
        _c("p2-other", 2, relevance=0.8),  # same page as the source row
        _c("h4", 4, relevance=0.5),
        _c("weak", 6, relevance=0.01),  # below the floor
        _c("h4", 7, relevance=0.4),  # same block again
        _c("x8", 8, doc="e", relevance=0.3),
        _c("x2", 2, doc="e", relevance=0.3),  # page 2 of ANOTHER document is fine
        _c("h9", 9, relevance=0.3),
    ]
    merged = merge_related(sources, hits, limit=4, min_relevance=0.1)
    assert [m.block_ids[0] for m in merged] == ["s1", "h4", "x8", "x2"]
    assert [m.from_question_source for m in merged] == [True, False, False, False]
    assert merge_related(sources, hits, limit=0) == []
    # Without a scorer (relevance None) nothing is dropped by the floor.
    unscored = merge_related([], [_c("a", 1), _c("b", 3)], limit=5, min_relevance=0.5)
    assert len(unscored) == 2


def test_relsrc_01_c02_excerpt_keeps_paragraphs_and_highlights_query_terms() -> None:
    text, spans = related_excerpt(["가나다 원리: 물이 증발한다.", "둘째 문단."], "가나다 원리")
    assert text == "가나다 원리: 물이 증발한다.\n\n둘째 문단."
    assert spans
    assert all(0 <= s < e <= len(text) for s, e in spans)
    assert text[spans[0][0] : spans[0][1]].startswith("가나")
    long_text, _ = related_excerpt(["단어 " * 400, "다음"], "단어")
    assert len(long_text) <= MAX_EXCERPT_CHARS
    assert long_text.endswith("…")
    two, _ = related_excerpt(["가" * 200, "나" * 200], "가")
    assert two == "가" * 200


def test_relsrc_01_c02_a_long_stem_never_pushes_the_answer_out_of_the_search_query() -> None:
    """The retrieval cuts queries at DEFAULT_MAX_QUERY_CHARS: the stem is shortened, never the
    correct answer (a long stem would otherwise search its opening text only)."""
    options = [{"id": "a", "text": "가나다 원리"}, {"id": "b", "text": "마바사 오개념"}]
    for stem in ("문제   설명 " * 400, "가" * (DEFAULT_MAX_QUERY_CHARS - 3)):
        query = related_query(stem, question_type="MCQ", options=options, correct_option_ids=["a"])
        searched = prepare_query(query).text
        assert len(query) <= DEFAULT_MAX_QUERY_CHARS
        assert searched.endswith("가나다 원리"), searched[-40:]
        assert "마바사" not in searched
    huge = related_query("발문", question_type="ESSAY", rubric="기준 " * 2000)
    assert len(huge) <= DEFAULT_MAX_QUERY_CHARS
    assert huge.startswith("기준")  # an answer over the budget leaves no room for the stem
