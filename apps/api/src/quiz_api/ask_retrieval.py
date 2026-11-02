"""Evidence retrieval of the AI features (ASK-01 "검색 범위", C02), shared by AI questions (ASK-B),
AI explanations (EXPL-B) and related passages (RELSRC-B).

It reuses the SEARCH-01 pipeline (`quiz_api.api.search`: the server-side scope from the
database, BM25 + dense candidates fused by RRF in Qdrant restricted to the active published
revisions, `ExcerptLoader` paragraphs) and narrows it to what may ground an answer:

- only live documents of this workspace with `document_type = book` and a published active
  revision (question papers never; drafts, older revisions, deleted documents and other
  workspaces can never match because Qdrant is queried with the DB-built revision ids only);
- the caller's scope (document / chapter ids) is intersected with that: unknown, foreign or
  question-paper ids only narrow the result (an all-foreign scope matches nothing), never 404;
- in a `mixed` document (교재+문제) every hit touching the blocks the question extractor reads as
  questions, options, answers or explanations (`book_core.summary.question_block_indices`, the same
  segments DOCSUM leaves out) is dropped; only the dropped count is reported;
- summaries and chapter notes are not indexed, so they are never evidence;
- with a relevance scorer (APP_ENV=test: the deterministic `FakeReranker`) candidates scoring
  below `min_relevance` are dropped and the rest ordered by that score. Interactive search has no
  reranker in other environments (implementation-plan §7), so there the RRF order stands and no
  threshold applies until ASK-X's evaluation sets one.

`retrieve` returns references plus excerpt text (in memory only: callers pin ids, pages, chunk
ids and scores, never the text) within `top_k` and `max_context_chars` (lower ranks dropped, the
first one always kept). When the query embedder is down the result is keyword-only and
`degraded` says `dense_unavailable` (SEARCH-01-AC06). The query is never logged.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass, field

import httpx
from book_core.contracts import Excerpt, SearchMode
from book_core.indexing import IndexStoreError
from book_core.reranker import FakeReranker, Reranker
from book_core.search import (
    DEFAULT_MAX_QUERY_CHARS,
    DEGRADED_DENSE_UNAVAILABLE,
    InvalidQueryError,
    RankedHit,
    RerankMode,
    SearchFilters,
    SearchLimits,
    prepare_query,
)
from qdrant_client.http.exceptions import ApiException
from sqlalchemy import select
from sqlalchemy.orm import Session

from quiz_api.api.search import (
    ExcerptLoader,
    SearchRequest,
    build_scope,
    revision_for_excerpts,
    to_search_scope,
)
from quiz_api.repositories.search import ChapterRow, SearchableDocument, SearchRepository
from quiz_api.repositories.tables import documents
from quiz_api.search_engine import SearchEngine, SearchUnavailableError
from quiz_api.settings import Environment, Settings

logger = logging.getLogger(__name__)

MIXED = "mixed"
MAX_SOURCE_CHARS = 2000
# First-stage candidates per list (the architecture's dense 30 / BM25 30).
CANDIDATES = 30
_QUESTION_BLOCK_CACHE_SIZE = 64


class RetrievalUnavailableError(RuntimeError):
    """The index cannot be reached (answered as 503 by the caller)."""


@dataclass(frozen=True)
class RetrievalScope:
    """Requested narrowing; empty = every published book of the workspace."""

    document_ids: tuple[uuid.UUID, ...] = ()
    chapter_ids: tuple[uuid.UUID, ...] = ()


@dataclass(frozen=True)
class RetrievedSource:
    rank: int
    document_id: uuid.UUID
    document_title: str
    revision_id: uuid.UUID
    chapter_id: uuid.UUID | None
    chunk_id: str
    block_ids: tuple[str, ...]
    matched_block_ids: tuple[str, ...]
    page_from: int
    page_to: int
    score: float
    score_type: str
    relevance: float | None
    text: str = field(repr=False)


@dataclass(frozen=True)
class RetrievalResult:
    sources: tuple[RetrievedSource, ...]
    degraded: tuple[str, ...] = ()
    question_part_dropped: int = 0


_TEST_MARKER = re.compile(r"E2E-[A-Za-z0-9_-]+")


class _TestRelevance:
    """APP_ENV=test: `FakeReranker` (share of the query's word/bigram features in the passage)
    on the query without the E2E fake markers, which carry no meaning."""

    def __init__(self) -> None:
        self._inner = FakeReranker()

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        return self._inner.score(_TEST_MARKER.sub(" ", query), passages)


def relevance_scorer(settings: Settings) -> Reranker | None:
    """The scorer behind `min_relevance` (see the module docstring)."""
    return _TestRelevance() if settings.app_env is Environment.TEST else None


class _QuestionBlockCache:
    """Question-part block ids of published `mixed` revisions (immutable content), per process."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._items: OrderedDict[uuid.UUID, frozenset[str]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, revision_id: uuid.UUID) -> frozenset[str] | None:
        with self._lock:
            found = self._items.get(revision_id)
            if found is not None:
                self._items.move_to_end(revision_id)
            return found

    def put(self, revision_id: uuid.UUID, ids: frozenset[str]) -> None:
        with self._lock:
            self._items[revision_id] = ids
            self._items.move_to_end(revision_id)
            while len(self._items) > self._size:
                self._items.popitem(last=False)


_question_blocks = _QuestionBlockCache(_QUESTION_BLOCK_CACHE_SIZE)


def question_part_blocks(
    repo: SearchRepository, doc: SearchableDocument, chapters: Sequence[ChapterRow]
) -> frozenset[str]:
    cached = _question_blocks.get(doc.revision_id)
    if cached is not None:
        return cached
    from book_core.summary.chapters import question_block_indices

    tree = [c for c in chapters if c.revision_id == doc.revision_id]
    revision = revision_for_excerpts(doc, tree, repo.blocks(doc.revision_id))
    blocks = list(revision.blocks)
    ids = frozenset(blocks[i].id for i in question_block_indices(blocks))
    _question_blocks.put(doc.revision_id, ids)
    return ids


class AskRetrieval:
    """One request's retrieval in `session` (reads only; ends the read transaction before the
    index query, so call it outside any transaction holding locks)."""

    def __init__(
        self,
        session: Session,
        engine: SearchEngine,
        *,
        scorer: Reranker | None = None,
        min_relevance: float = 0.0,
    ) -> None:
        self._session = session
        self._repo = SearchRepository(session)
        self._engine = engine
        self._scorer = scorer
        self._min_relevance = min_relevance

    def _narrowed(
        self, workspace_id: uuid.UUID, scope: RetrievalScope
    ) -> tuple[list[uuid.UUID] | None, list[uuid.UUID] | None] | None:
        """The scope's ids that belong to this workspace (None = no filter); None overall when a
        non-empty request keeps nothing (it then matches nothing)."""
        document_ids: list[uuid.UUID] | None = None
        chapter_ids: list[uuid.UUID] | None = None
        if scope.document_ids:
            wanted = list(dict.fromkeys(scope.document_ids))
            known = self._repo.existing_documents(workspace_id, wanted)
            document_ids = [d for d in wanted if d in known]
            if not document_ids:
                return None
        if scope.chapter_ids:
            wanted_chapters = list(dict.fromkeys(scope.chapter_ids))
            rows = self._repo.chapters_by_id(workspace_id, wanted_chapters)
            known_chapters = {r.id for r in rows}
            chapter_ids = [c for c in wanted_chapters if c in known_chapters]
            if not chapter_ids:
                return None
        return document_ids, chapter_ids

    def _content_kinds(self, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str | None]:
        if not ids:
            return {}
        rows = self._session.execute(
            select(documents.c.id, documents.c.content_kind).where(documents.c.id.in_(list(ids)))
        )
        return {row.id: row.content_kind for row in rows}

    def retrieve(
        self,
        workspace_id: uuid.UUID,
        query: str,
        scope: RetrievalScope,
        *,
        top_k: int,
        max_context_chars: int,
        max_source_chars: int = MAX_SOURCE_CHARS,
    ) -> RetrievalResult:
        try:
            prepared = prepare_query(query, max_chars=DEFAULT_MAX_QUERY_CHARS)
        except InvalidQueryError:
            return RetrievalResult(())
        narrowed = self._narrowed(workspace_id, scope)
        if narrowed is None:
            return RetrievalResult(())
        document_ids, chapter_ids = narrowed
        request = SearchRequest(
            query=prepared.text, document_ids=document_ids, chapter_ids=chapter_ids, limit=50
        )
        # build_scope never admits a question paper (UX7-SEARCH-2); every other document is a book.
        search_scope, chapters = build_scope(self._repo, workspace_id, request)
        searchable = search_scope.documents
        index_scope = to_search_scope(workspace_id, search_scope)
        if index_scope is None:
            return RetrievalResult(())
        kinds = self._content_kinds(list(searchable))
        candidates = max(CANDIDATES, top_k * 3)
        limits = SearchLimits(
            dense_candidates=CANDIDATES,
            keyword_candidates=CANDIDATES,
            results=candidates,
            rerank=RerankMode.OFF,
        )
        self._repo.end_read()
        try:
            result = self._engine.service().search(
                prepared.text,
                index_scope,
                mode=SearchMode.HYBRID,
                filters=SearchFilters(),
                limits=limits,
            )
        except InvalidQueryError:
            return RetrievalResult(())
        except (
            SearchUnavailableError,
            IndexStoreError,
            ApiException,
            httpx.HTTPError,
            OSError,
        ) as exc:
            logger.warning("ask retrieval: index unavailable (%s)", type(exc).__name__)
            raise RetrievalUnavailableError("search index unavailable") from None
        degraded = (
            (DEGRADED_DENSE_UNAVAILABLE,) if DEGRADED_DENSE_UNAVAILABLE in result.degraded else ()
        )
        by_revision = {str(d.revision_id): d for d in searchable.values()}
        question_blocks: dict[uuid.UUID, frozenset[str]] = {}
        dropped = 0
        hits: list[RankedHit] = []
        for hit in result.hits:
            doc = by_revision.get(hit.hit.revision_id)
            if doc is None or str(doc.id) != hit.hit.document_id:
                continue
            if kinds.get(doc.id) == MIXED:
                if doc.revision_id not in question_blocks:
                    question_blocks[doc.revision_id] = question_part_blocks(
                        self._repo, doc, chapters
                    )
                if set(hit.chunk.block_ids) & question_blocks[doc.revision_id]:
                    dropped += 1
                    continue
            hits.append(hit)
        relevance: dict[int, float] = {}
        if self._scorer is not None and hits:
            scores = self._scorer.score(prepared.text, [h.chunk.content for h in hits])
            scored = [(s, i, h) for i, (s, h) in enumerate(zip(scores, hits, strict=True))]
            scored = [x for x in scored if x[0] >= self._min_relevance]
            scored.sort(key=lambda x: (-x[0], x[1]))
            hits = [h for _s, _i, h in scored]
            relevance = {id(h): s for s, _i, h in scored}
        loader = ExcerptLoader(self._repo, searchable, chapters)
        loader.prepare(hits[: top_k * 2])
        sources: list[RetrievedSource] = []
        seen: set[tuple[str, tuple[str, ...]]] = set()
        total = 0
        for hit in hits:
            if len(sources) >= top_k:
                break
            doc = by_revision[hit.hit.revision_id]
            excerpt = loader.excerpt(hit, result.query)
            source = _source(len(sources) + 1, doc, hit, excerpt, loader, relevance.get(id(hit)))
            if source is None:
                continue
            key = (str(source.revision_id), source.block_ids)
            if key in seen:
                continue
            chars = min(len(source.text), max_source_chars)
            if sources and total + chars > max_context_chars:
                break
            seen.add(key)
            sources.append(source)
            total += chars
        self._repo.end_read()
        return RetrievalResult(tuple(sources), degraded, dropped)


def _source(
    rank: int,
    doc: SearchableDocument,
    hit: RankedHit,
    excerpt: Excerpt | None,
    loader: ExcerptLoader,
    relevance: float | None,
) -> RetrievedSource | None:
    if excerpt is None:
        return None
    pages = [loc.page for loc in excerpt.locations]
    chapter_id, _section_id = loader.chapter_ids(hit.hit.revision_id, hit.chunk.section_id)
    return RetrievedSource(
        rank=rank,
        document_id=doc.id,
        document_title=doc.title,
        revision_id=doc.revision_id,
        chapter_id=chapter_id,
        chunk_id=hit.chunk.id,
        block_ids=tuple(excerpt.block_ids),
        matched_block_ids=tuple(excerpt.matched_block_ids),
        page_from=min(pages),
        page_to=max(pages),
        score=hit.hit.score,
        score_type=hit.hit.score_type.value,
        relevance=relevance,
        text=excerpt.text,
    )
