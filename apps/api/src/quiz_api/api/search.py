"""Workspace search (M3.6a, SEARCH-01; docs/architecture.md §4 search flow).

    POST /workspaces/{id}/search    any member (viewer included); archived workspaces readable

Scope (server-enforced): the path workspace after the membership check (404 for non-members,
deleted and missing workspaces, same body), then the *active published* revision of every
non-deleted document of that workspace, read from the database. Qdrant is only ever queried with
those revision ids (`SearchScope`), so drafts, superseded revisions, deleted documents and other
workspaces can never match, whatever the index still holds. Question-paper documents
(`document_type = question_paper`) are left out unless `include_question_papers` is set or the
request names them in `document_ids` / `chapter_ids`.

Filters only narrow that scope:
  * `document_ids`: documents of this workspace (a deleted, missing or foreign id is 404
    "Document not found."); a document without a published revision simply has no hits.
  * `chapter_ids`: outline node ids (`GET /documents/{id}/outline`); the chapter and all its
    sub-sections. Chapter ids are revision-scoped: an id of an older revision of a document is
    mapped to the active revision's section with the same `section_key` (a section that no longer
    exists matches nothing, with a warning). Missing or foreign ids are 404 "Chapter not found.".
    Chapters restrict their own document only, so chapters of two documents can be combined.
  * `languages`: chunk language tags (`ko`, `en`).

Results carry the hit's location (document, published revision, chapter/section, blocks, page and
bbox) and a paragraph-complete excerpt of that revision (`book_core.search.ExcerptResolver`) with
highlight spans for the matched passage and the query terms. Scores are reported as their type
(`bm25`, `cosine`, `rrf`); no reranker in interactive search (implementation-plan §7).

Rate limit: per user, in-process token bucket (`SEARCH_RATE_LIMIT_PER_MINUTE`, `SEARCH_RATE_BURST`;
a stopgap, see `quiz_api.rate_limit`): 429 with `Retry-After`. Index unreachable: 503. Responses
are `Cache-Control: no-store` like every /api/v1 response. The query is never logged.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Literal

import httpx
from book_core.contracts import (
    DocumentRevision,
    Excerpt,
    SearchMode,
    Section,
    SourceLocation,
)
from book_core.indexing import IndexStoreError, SearchScope
from book_core.search import (
    DEFAULT_MAX_QUERY_CHARS,
    ExcerptError,
    ExcerptResolver,
    InvalidQueryError,
    RankedHit,
    RerankMode,
    SearchFilters,
    SearchLimits,
    prepare_query,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from qdrant_client.http.exceptions import ApiException
from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz import Action, WorkspaceAccess, require_workspace_access
from quiz_api.db import get_db_session
from quiz_api.document_content import block_from_row
from quiz_api.errors import problem_responses
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.search import ChapterRow, SearchableDocument, SearchRepository
from quiz_api.search_engine import SearchEngine, SearchUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["search"])

DOCUMENT_NOT_FOUND = "Document not found."
CHAPTER_NOT_FOUND = "Chapter not found."
MAX_QUERY_CHARS = 4000
MAX_FILTER_IDS = 200
MAX_RESULTS = 50
DEFAULT_RESULTS = 10
# First-stage candidates per list: the architecture defaults (30), more when more results are asked.
MIN_CANDIDATES = 30
QUESTION_PAPER = "question_paper"

LanguageCode = Annotated[
    str,
    StringConstraints(min_length=2, max_length=35, pattern=r"^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$"),
]


# --- schemas ------------------------------------------------------------------------------------


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: Annotated[str, StringConstraints(min_length=1, max_length=MAX_QUERY_CHARS)] = Field(
        description="Free text in any language. Longer than 1000 characters is truncated (with a "
        "warning); blank is 422."
    )
    mode: Literal["keyword", "semantic", "hybrid"] = Field(
        default="hybrid",
        description="`keyword` (BM25), `semantic` (dense) or `hybrid` (both fused with RRF).",
    )
    document_ids: list[uuid.UUID] | None = Field(
        default=None, max_length=MAX_FILTER_IDS, description="Only these documents."
    )
    chapter_ids: list[uuid.UUID] | None = Field(
        default=None,
        max_length=MAX_FILTER_IDS,
        description="Only these outline nodes (chapter or section) and their sub-sections.",
    )
    languages: list[LanguageCode] | None = Field(
        default=None, max_length=10, description="Only passages in these languages, e.g. `en`."
    )
    include_question_papers: bool = Field(
        default=False,
        description="Also search question-paper documents (left out of book search by default).",
    )
    limit: int = Field(default=DEFAULT_RESULTS, ge=1, le=MAX_RESULTS)


class TextRange(BaseModel):
    start: int = Field(description="Offset in `text` (characters), inclusive.")
    end: int = Field(description="Offset in `text` (characters), exclusive.")


class HitBoundingBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class HitLocation(BaseModel):
    page: int
    bbox: HitBoundingBox | None = Field(description="PDF points, origin top-left.")
    block_id: str | None


class SearchItem(BaseModel):
    document_id: uuid.UUID
    document_title: str
    document_type: str = Field(description="`book` or `question_paper`.")
    revision_id: uuid.UUID = Field(description="The published revision the hit comes from.")
    chunk_id: str
    chapter_id: uuid.UUID | None = Field(
        description="Top-level outline node (chapter) of the hit, in this revision."
    )
    section_id: uuid.UUID | None = Field(
        description="Outline node of the hit's own section (the chapter or a sub-section)."
    )
    breadcrumb: list[str] = Field(description="Document title, then the section path.")
    block_id: str = Field(description="Where to jump: the first matched block.")
    block_ids: list[str] = Field(description="Blocks the hit itself covers.")
    context_block_ids: list[str] = Field(description="Every block shown in `text`.")
    page: int = Field(description="1-based PDF page of `block_id`.")
    bbox: HitBoundingBox | None = Field(description="Box of `block_id` on `page`.")
    locations: list[HitLocation] = Field(description="Every page/box of `context_block_ids`.")
    text: str = Field(description="Excerpt: the matched paragraphs plus context, canonical text.")
    highlights: list[TextRange] = Field(description="The matched passage inside `text`.")
    term_highlights: list[TextRange] = Field(description="Query terms inside `text`.")
    truncated_start: bool
    truncated_end: bool
    language: str | None
    rank: int
    score: float
    score_type: Literal["bm25", "cosine", "rrf", "rerank"]


class SearchResponse(BaseModel):
    query: str = Field(description="The query as searched (normalised, maybe truncated).")
    mode: Literal["keyword", "semantic", "hybrid"]
    query_language: str | None = Field(description="Script hint: `ko`, `en`, `mixed` or null.")
    truncated: bool = Field(description="The query was cut to the maximum length.")
    warnings: list[str]
    items: list[SearchItem]


# --- dependencies -------------------------------------------------------------------------------


def get_search_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> SearchRepository:
    return SearchRepository(session)


def get_search_engine(request: Request) -> SearchEngine:
    engine: SearchEngine | None = getattr(request.app.state, "search_engine", None)
    if engine is None:
        engine = request.app.state.search_engine = SearchEngine(request.app.state.settings)
    return engine


def get_search_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(request.app.state, "search_limiter", None)
    if limiter is None:
        settings = request.app.state.settings
        limiter = request.app.state.search_limiter = TokenBucketLimiter(
            settings.search_rate_per_minute, settings.search_rate_burst
        )
    return limiter


def search_rate_limit(
    user: CurrentUser, limiter: Annotated[TokenBucketLimiter, Depends(get_search_limiter)]
) -> None:
    wait = limiter.acquire(f"search:{user.id}")
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many searches. Wait a moment and try again.",
            headers={"Retry-After": retry_after_header(wait)},
        )


SearchRepo = Annotated[SearchRepository, Depends(get_search_repository)]
Engine = Annotated[SearchEngine, Depends(get_search_engine)]
ReadAccess = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.READ))]


# --- scope --------------------------------------------------------------------------------------


@dataclass
class Scope:
    """What the request may search: documents (with their active revision) and, per document,
    the admitted section keys (None = the whole document)."""

    documents: dict[uuid.UUID, SearchableDocument]
    sections: dict[uuid.UUID, set[str]] | None = None
    warnings: list[str] = field(default_factory=list)


def subtree_keys(chapters: Sequence[ChapterRow], roots: Iterable[uuid.UUID]) -> set[str]:
    """Section keys of `roots` and all their descendants (chapters of one revision)."""
    children: dict[uuid.UUID, list[ChapterRow]] = defaultdict(list)
    by_id = {c.id: c for c in chapters}
    for chapter in chapters:
        if chapter.parent_id is not None:
            children[chapter.parent_id].append(chapter)
    found: set[str] = set()
    seen: set[uuid.UUID] = set()
    stack = [by_id[r] for r in roots if r in by_id]
    while stack:
        current = stack.pop()
        if current.id in seen:
            continue
        seen.add(current.id)
        found.add(current.section_key)
        stack.extend(children.get(current.id, ()))
    return found


def build_scope(
    repo: SearchRepository, workspace_id: uuid.UUID, body: SearchRequest
) -> tuple[Scope, list[ChapterRow]]:
    """The documents and sections this request searches (see the module docstring), plus the
    chapters of their active revisions."""
    searchable = {d.id: d for d in repo.searchable_documents(workspace_id)}
    selected: dict[uuid.UUID, SearchableDocument]
    explicit = False
    if body.document_ids:
        wanted = list(dict.fromkeys(body.document_ids))
        if repo.existing_documents(workspace_id, wanted) != set(wanted):
            raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND)
        selected = {d: searchable[d] for d in wanted if d in searchable}
        explicit = True
    else:
        selected = dict(searchable)

    warnings: list[str] = []
    sections: dict[uuid.UUID, set[str]] | None = None
    requested_chapters: list[ChapterRow] = []
    if body.chapter_ids:
        wanted_chapters = list(dict.fromkeys(body.chapter_ids))
        requested_chapters = repo.chapters_by_id(workspace_id, wanted_chapters)
        if len(requested_chapters) != len(wanted_chapters):
            raise HTTPException(status_code=404, detail=CHAPTER_NOT_FOUND)
        chapter_documents = {c.document_id for c in requested_chapters}
        selected = {d: doc for d, doc in selected.items() if d in chapter_documents}
        explicit = True

    if not explicit and not body.include_question_papers:
        selected = {d: doc for d, doc in selected.items() if doc.document_type != QUESTION_PAPER}

    active_chapters = repo.chapters_of([doc.revision_id for doc in selected.values()])
    if requested_chapters:
        by_revision: dict[uuid.UUID, list[ChapterRow]] = defaultdict(list)
        for chapter in active_chapters:
            by_revision[chapter.revision_id].append(chapter)
        sections = {}
        stale = False
        for chapter in requested_chapters:
            doc = selected.get(chapter.document_id)
            if doc is None:
                continue
            tree = by_revision[doc.revision_id]
            if chapter.revision_id == doc.revision_id:
                root = chapter.id
            else:
                # An outline id of an older (or draft) revision: the same section of the
                # published revision, by its stable key.
                match = next((c for c in tree if c.section_key == chapter.section_key), None)
                if match is None:
                    stale = True
                    continue
                root = match.id
            keys = subtree_keys(tree, [root])
            if keys:
                sections.setdefault(doc.id, set()).update(keys)
        if stale:
            warnings.append("some selected chapters no longer exist in the published revision")
        selected = {d: doc for d, doc in selected.items() if d in sections}
    return Scope(documents=selected, sections=sections, warnings=warnings), active_chapters


def to_search_scope(workspace_id: uuid.UUID, scope: Scope) -> SearchScope | None:
    if not scope.documents:
        return None
    documents = sorted(scope.documents.values(), key=lambda d: str(d.id))
    return SearchScope(
        workspace_id=str(workspace_id),
        revision_ids=tuple(str(d.revision_id) for d in documents),
        document_ids=tuple(str(d.id) for d in documents),
        document_sections=tuple(
            (str(doc_id), tuple(sorted(keys)))
            for doc_id, keys in sorted(scope.sections.items(), key=lambda kv: str(kv[0]))
        )
        if scope.sections is not None
        else (),
    )


# --- excerpts -----------------------------------------------------------------------------------


def _sections(chapters: Sequence[ChapterRow]) -> tuple[Section, ...]:
    """The revision's sections in `sort_order`, without heading links (a partial block set may
    not hold every heading; the excerpt only needs titles and parents)."""
    keys = {c.id: c.section_key for c in chapters}
    return tuple(
        Section(
            id=c.section_key,
            title=c.title,
            level=c.level,
            parent_id=keys.get(c.parent_id) if c.parent_id else None,
        )
        for c in sorted(chapters, key=lambda c: c.sort_order)
    )


def revision_for_excerpts(
    doc: SearchableDocument, chapters: Sequence[ChapterRow], rows: Sequence[RowMapping]
) -> DocumentRevision:
    """A (possibly partial: only some sections' blocks) view of the published revision.

    Excerpts never cross section boundaries (`ExcerptConfig.cross_sections` is off) and captions
    link within a section, so the blocks of the hits' sections give the same excerpts as the
    whole revision."""
    keys = {c.id: c.section_key for c in chapters}
    blocks = [block_from_row(row, keys) for row in rows]
    loaded = {b.id for b in blocks}
    blocks = [
        b
        if b.caption_block_id is None or b.caption_block_id in loaded
        else b.model_copy(update={"caption_block_id": None})
        for b in blocks
    ]
    return DocumentRevision(
        document_id=str(doc.id),
        revision_id=str(doc.revision_id),
        revision_number=doc.revision_number,
        source_sha256=doc.sha256,
        sections=_sections(chapters),
        blocks=tuple(blocks),
    )


class ExcerptLoader:
    """Excerpts for the hits of one request; revision content is read once per revision."""

    def __init__(
        self,
        repo: SearchRepository,
        documents: Mapping[uuid.UUID, SearchableDocument],
        chapters: Sequence[ChapterRow],
    ) -> None:
        self._repo = repo
        self._documents = {str(d.revision_id): d for d in documents.values()}
        self._chapters: dict[str, list[ChapterRow]] = defaultdict(list)
        for chapter in chapters:
            self._chapters[str(chapter.revision_id)].append(chapter)
        self._resolvers: dict[str, ExcerptResolver] = {}
        self._full: set[str] = set()

    def chapter_ids(
        self, revision_id: str, section_key: str | None
    ) -> tuple[uuid.UUID | None, ...]:
        """(chapter id, section id) of a section key in this revision."""
        if section_key is None:
            return None, None
        tree = self._chapters.get(revision_id, [])
        by_key = {c.section_key: c for c in tree}
        by_id = {c.id: c for c in tree}
        section = by_key.get(section_key)
        if section is None:
            return None, None
        root = section
        seen = {root.id}
        while root.parent_id is not None and root.parent_id in by_id and root.parent_id not in seen:
            root = by_id[root.parent_id]
            seen.add(root.id)
        return root.id, section.id

    def prepare(self, hits: Sequence[RankedHit]) -> None:
        """Load the blocks of every hit's section (one query per revision)."""
        wanted: dict[str, set[str | None]] = defaultdict(set)
        for hit in hits:
            wanted[hit.hit.revision_id].add(hit.chunk.section_id)
        for revision_id, keys in wanted.items():
            self._load(revision_id, keys)

    def _load(self, revision_id: str, keys: set[str | None] | None) -> None:
        doc = self._documents[revision_id]
        tree = self._chapters.get(revision_id, [])
        if keys is None:
            rows = self._repo.blocks(doc.revision_id)
            self._full.add(revision_id)
        else:
            ids = [c.id for c in tree if c.section_key in keys]
            rows = self._repo.blocks(doc.revision_id, chapter_ids=ids, without_chapter=None in keys)
        self._resolvers[revision_id] = ExcerptResolver(
            revision_for_excerpts(doc, tree, rows), document_title=doc.title
        )

    def excerpt(self, hit: RankedHit, query: str) -> Excerpt | None:
        revision_id = hit.hit.revision_id
        if revision_id not in self._documents:
            return None
        if revision_id not in self._resolvers:
            self._load(revision_id, {hit.chunk.section_id})
        try:
            return self._resolvers[revision_id].resolve_hit(hit, query=query)
        except ExcerptError:
            if revision_id in self._full:
                return None
        # A chunk whose blocks lie outside its section: use the whole revision.
        self._load(revision_id, None)
        try:
            return self._resolvers[revision_id].resolve_hit(hit, query=query)
        except ExcerptError:
            return None


def _bbox(location: SourceLocation | None) -> HitBoundingBox | None:
    if location is None or location.bbox is None:
        return None
    box = location.bbox
    return HitBoundingBox(x0=box.x0, y0=box.y0, x1=box.x1, y1=box.y1)


def _location(location: SourceLocation) -> HitLocation:
    return HitLocation(page=location.page, bbox=_bbox(location), block_id=location.block_id)


def build_item(
    hit: RankedHit,
    doc: SearchableDocument,
    excerpt: Excerpt | None,
    ids: tuple[uuid.UUID | None, ...],
) -> SearchItem:
    chunk = hit.chunk
    if excerpt is not None:
        primary = excerpt.primary_location or excerpt.locations[0]
        matched = list(excerpt.matched_block_ids) or list(excerpt.block_ids)
        text = excerpt.text
        locations = list(excerpt.locations)
        context = list(excerpt.block_ids)
        highlights = [TextRange(start=s.start, end=s.end) for s in excerpt.highlights]
        terms = [TextRange(start=s.start, end=s.end) for s in excerpt.term_highlights]
        breadcrumb = list(excerpt.breadcrumb)
        truncated = (excerpt.truncated_start, excerpt.truncated_end)
    else:
        # The canonical blocks could not be resolved (inconsistent rows): the indexed passage of
        # the same published revision, without context.
        primary = chunk.locations[0]
        matched = list(chunk.block_ids)
        text = chunk.content
        locations = list(chunk.locations)
        context = list(chunk.block_ids)
        highlights = [TextRange(start=0, end=len(text))]
        terms = []
        breadcrumb = [doc.title]
        truncated = (False, False)
    block_id = primary.block_id or matched[0]
    chapter_id, section_id = ids
    return SearchItem(
        document_id=doc.id,
        document_title=doc.title,
        document_type=doc.document_type,
        revision_id=doc.revision_id,
        chunk_id=chunk.id,
        chapter_id=chapter_id,
        section_id=section_id,
        breadcrumb=breadcrumb,
        block_id=block_id,
        block_ids=matched,
        context_block_ids=context,
        page=primary.page,
        bbox=_bbox(primary),
        locations=[_location(loc) for loc in locations],
        text=text,
        highlights=highlights,
        term_highlights=terms,
        truncated_start=truncated[0],
        truncated_end=truncated[1],
        language=chunk.language,
        rank=hit.hit.rank,
        score=hit.hit.score,
        score_type=hit.hit.score_type.value,
    )


# --- route --------------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/search",
    operation_id="searchWorkspace",
    responses=problem_responses(429, 503),
    dependencies=[Depends(search_rate_limit)],
)
def search_workspace(
    access: ReadAccess, body: SearchRequest, repo: SearchRepo, engine: Engine
) -> SearchResponse:
    """Search the published text of this workspace's documents (SEARCH-01)."""
    try:
        prepared = prepare_query(body.query, max_chars=DEFAULT_MAX_QUERY_CHARS)
    except InvalidQueryError:
        raise _invalid_query() from None
    scope, chapters = build_scope(repo, access.workspace_id, body)
    warnings = list(scope.warnings)
    search_scope = to_search_scope(access.workspace_id, scope)
    if search_scope is None:
        if prepared.truncated:
            warnings.append(
                f"query truncated from {prepared.original_length} to {len(prepared.text)} "
                "characters"
            )
        return SearchResponse(
            query=prepared.text,
            mode=body.mode,
            query_language=prepared.language,
            truncated=prepared.truncated,
            warnings=[*warnings, "no published documents in the search scope"],
            items=[],
        )

    candidates = max(MIN_CANDIDATES, body.limit * 3)
    limits = SearchLimits(
        dense_candidates=candidates,
        keyword_candidates=candidates,
        results=body.limit,
        rerank=RerankMode.OFF,
    )
    filters = SearchFilters(languages=tuple(dict.fromkeys(body.languages or ())))
    # The scope is fixed now; do not hold the DB transaction open across the index query.
    repo.end_read()
    try:
        result = engine.service().search(
            body.query, search_scope, mode=SearchMode(body.mode), filters=filters, limits=limits
        )
    except InvalidQueryError:
        raise _invalid_query() from None
    except (SearchUnavailableError, IndexStoreError, ApiException, httpx.HTTPError, OSError) as exc:
        # Type only (messages can carry URLs); the query is never logged.
        logger.warning("search: index unavailable (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="Search is temporarily unavailable. Try again shortly."
        ) from None

    loader = ExcerptLoader(repo, scope.documents, chapters)
    loader.prepare(result.hits)
    items: list[SearchItem] = []
    by_revision = {str(d.revision_id): d for d in scope.documents.values()}
    for hit in result.hits:
        doc = by_revision.get(hit.hit.revision_id)
        if doc is None or str(doc.id) != hit.hit.document_id:  # pragma: no cover - scoped
            continue
        excerpt = loader.excerpt(hit, result.query)
        if excerpt is None:
            logger.warning("search: no excerpt for a hit (revision content inconsistent)")
        ids = loader.chapter_ids(hit.hit.revision_id, hit.chunk.section_id)
        items.append(build_item(hit, doc, excerpt, ids))
    return SearchResponse(
        query=result.query,
        mode=body.mode,
        query_language=result.query_language,
        truncated=result.truncated,
        warnings=[*warnings, *result.warnings],
        items=items,
    )


def _invalid_query() -> HTTPException:
    return HTTPException(status_code=422, detail="The search query must not be blank.")
