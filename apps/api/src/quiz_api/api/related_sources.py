"""Related passages after a submission (RELSRC-B, RELSRC-01; docs/questions.md §13).

    GET /questions/{id}/related-sources?practice_session_id=… | ?view=detail
    GET /mock-exam-questions/{id}/related-sources?mock_practice_session_id=… | ?view=manage
    GET /shared/{shareId}/questions/{id}/related-sources       stored lists only (share session)

Method A (user decision 2026-11-01): search only, no LLM, always on (no switch). The list is the
question's own source blocks in published books first, then hybrid-search hits for the stem plus
the correct answer (never a wrong option) over the same scope as AI questions
(`quiz_api.ask_retrieval`: published `book` revisions only, no question paper, no `mixed`
question part, no summary / note / AI explanation), one row per block and per page, hits below
RELATED_SOURCES_MIN_RELEVANCE dropped, at most RELATED_SOURCES_LIMIT rows
(`book_core.search.related`).

Proof (C01, C07; decided from the DB, client values ignored): the caller's own session of THIS
question with a submission (`practice_session_id` / `mock_practice_session_id`; a pending grade
counts), or `view=detail` (any member: the 문제 상세 rights) / `view=manage` (mock exam question:
edit rights in an active workspace — ASK-SYNC (a)). No proof or an unsubmitted session: 409
`related-before-submit`; another user's session, a session of another question, another
workspace, a deleted question, a removed mock question or a deleted mock exam: the same 404. A
DRAFT question: 409 `related-draft-unavailable` (ASK-SYNC (b); ARCHIVED questions keep theirs).
Refusals search and store nothing.

Storage (C03, C04): one row per (question revision, corpus fingerprint, retrieval version),
Workspace-shared, holding references only; excerpts and highlights are rebuilt from the published
blocks on every read. The corpus fingerprint covers the workspace's searchable books' published
revisions, the index's model key and the chunk version (`corpus_fingerprint`). A first read takes
a per-question advisory lock on its own connection, then in one REPEATABLE READ transaction
recomputes the fingerprint, re-checks, computes and stores, so concurrent first reads compute
once and a list is always stored under the key of the corpus it was computed from. Older keys
stay as superseded rows.
Not stored (C05): an archived workspace (computed and shown only), degraded search (BM25 only,
`degraded: ["dense_unavailable"]`), guests (never compute). An index outage is 503
`related-unavailable`.

Reading related passages records nothing (no attempt, study state or view). Nothing here logs a
stem, answer, query or passage (C06).

APP_ENV=test hooks (never installed elsewhere; tests/e2e/fixtures/related-sources.ts R5, R6, R8):
`E2E-RELSRC-HOLD-<token>` in the stem waits for `<hold dir>/<token>.release` inside the lock
before the search; `E2E-RELSRC-FAIL` fails the first computation of each revision as an outage;
every computation appends a line to `<call dir>/<revision id>.calls`.
"""

from __future__ import annotations

import logging
import re
import tempfile
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from book_core.search.related import (
    RelatedCandidate,
    corpus_fingerprint,
    is_searchable_document,
    merge_related,
    related_excerpt,
    related_query,
    touches_question_part,
)
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from quiz_api.api.search import get_search_engine
from quiz_api.api.shared import QuestionRepo, Shared
from quiz_api.ask_retrieval import (
    AskRetrieval,
    RetrievalScope,
    RetrievalUnavailableError,
    question_part_blocks,
    relevance_scorer,
)
from quiz_api.auth import CurrentUser
from quiz_api.authz import Action
from quiz_api.authz.dependencies import ResourceAccess, authorize_resource
from quiz_api.authz.permissions import Role
from quiz_api.authz.repository import ResourceType, SqlAccessRepository
from quiz_api.db import Database, get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.repositories.related_sources import (
    BANK,
    MOCK,
    Kind,
    RelatedSourcesRepository,
    RevisionContent,
    SourceRef,
    StoredList,
    lock_lists,
)
from quiz_api.repositories.search import ChapterRow, SearchableDocument, SearchRepository
from quiz_api.search_engine import SearchEngine, SearchUnavailableError
from quiz_api.settings import Environment, Settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["related-sources"], responses=problem_responses(409, 503))
shared_router = APIRouter(
    prefix="/shared/{share_id}", tags=["shared"], responses=problem_responses(503)
)

NOT_FOUND = "Not found."
RETRIEVAL_VERSION = "a1"
DEGRADED_DENSE: Literal["dense_unavailable"] = "dense_unavailable"
EDIT_ROLES = frozenset({Role.OWNER, Role.EDITOR})
# Candidate passages asked from the retrieval per list (dedup and the floor drop some).
CANDIDATE_FACTOR = 4
MAX_CANDIDATE_CHARS = 1_000_000

HOLD_MARKER = re.compile(r"E2E-RELSRC-HOLD-([A-Za-z0-9]{1,64})")
FAIL_MARKER = "E2E-RELSRC-FAIL"
HOLD_TIMEOUT_SECONDS = 60.0
HOLD_DIR_NAME = "quiz-e2e-related-sources-hold"
FAULT_DIR_NAME = "quiz-e2e-related-sources-faults"
CALL_DIR_NAME = "quiz-e2e-related-sources-calls"


# --- schemas ------------------------------------------------------------------------------------


class TextSpan(BaseModel):
    start: int
    end: int


class SharedRelatedSource(BaseModel):
    rank: int = Field(description="1-based position in the list.")
    document_id: uuid.UUID
    document_title: str
    chapter_id: uuid.UUID | None = Field(description="Top-level chapter of the passage.")
    chapter_title: str | None
    block_id: str = Field(description="The passage's first block (DOC-02 / excerpt panel).")
    block_ids: list[str] = Field(
        description="The passage's blocks in reading order (the first is `block_id`); the excerpt "
        "panel shows all of them."
    )
    page_start: int
    page_end: int
    excerpt: str = Field(description="At most 300 characters, whole paragraphs where possible.")
    highlights: list[TextSpan] = Field(description="Query-term ranges in `excerpt` (<mark>).")
    from_question_source: bool = Field(description="One of the question's own sources (문제 출처).")


class RelatedSource(SharedRelatedSource):
    revision_id: uuid.UUID = Field(description="The document revision the passage is from.")
    stale: bool = Field(description="The revision is no longer the document's published one.")
    score: float | None = Field(
        default=None, description="Relevance (or fusion) score of a search hit; null for sources."
    )


class RelatedSources(BaseModel):
    id: uuid.UUID | None = Field(
        description="The stored list (the same for every reader of the key); null when the list "
        "was computed but not stored (archived workspace, degraded search)."
    )
    question_revision_id: uuid.UUID
    stored: bool
    degraded: list[Literal["dense_unavailable"]] = Field(
        description="`dense_unavailable`: keyword (BM25) results only, not stored."
    )
    items: list[RelatedSource]


class MockRelatedSources(BaseModel):
    id: uuid.UUID | None
    mock_exam_question_revision_id: uuid.UUID
    stored: bool
    degraded: list[Literal["dense_unavailable"]]
    items: list[RelatedSource]


class SharedRelatedSources(BaseModel):
    items: list[SharedRelatedSource]


# --- dependencies -------------------------------------------------------------------------------


@dataclass(frozen=True)
class RelatedDeps:
    settings: Settings
    database: Database
    engine: SearchEngine


def get_related_deps(
    request: Request, engine: Annotated[SearchEngine, Depends(get_search_engine)]
) -> RelatedDeps:
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")
    return RelatedDeps(request.app.state.settings, database, engine)


Deps = Annotated[RelatedDeps, Depends(get_related_deps)]
DbSession = Annotated[Session, Depends(get_db_session)]


def _question_access(
    question_id: Annotated[uuid.UUID, PathParam()], user: CurrentUser, session: DbSession
) -> ResourceAccess:
    try:
        return authorize_resource(
            SqlAccessRepository(session), user.id, ResourceType.QUESTION, question_id, Action.READ
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None
        raise


def _mock_access(
    mock_exam_question_id: Annotated[uuid.UUID, PathParam()],
    user: CurrentUser,
    session: DbSession,
) -> ResourceAccess:
    try:
        return authorize_resource(
            SqlAccessRepository(session),
            user.id,
            ResourceType.MOCK_EXAM_QUESTION,
            mock_exam_question_id,
            Action.READ,
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None
        raise


QuestionAccess = Annotated[ResourceAccess, Depends(_question_access)]
MockAccess = Annotated[ResourceAccess, Depends(_mock_access)]


# --- problems -----------------------------------------------------------------------------------


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _before_submit() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.RELATED_BEFORE_SUBMIT,
        detail="Related passages are shown after you submit an answer.",
    )


class RelatedUnavailableError(RuntimeError):
    pass


def _unavailable() -> ProblemException:
    return ProblemException(
        503,
        ProblemType.RELATED_UNAVAILABLE,
        detail="Related passages are temporarily unavailable. Try again shortly.",
    )


# --- computation --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    kind: Kind
    workspace_id: uuid.UUID
    owner_id: uuid.UUID
    revision_id: uuid.UUID
    current: bool
    archived: bool


@dataclass(frozen=True)
class Outcome:
    row_id: uuid.UUID | None
    degraded: tuple[str, ...]
    items: list[dict[str, Any]]


def retrieval_version(settings: Settings) -> str:
    """The method plus the list settings: changing either recomputes on the next read."""
    return (
        f"{RETRIEVAL_VERSION};limit={settings.related_sources_limit};"
        f"floor={settings.related_sources_min_relevance:g}"
    )


def _books(repo: SearchRepository, workspace_id: uuid.UUID) -> dict[uuid.UUID, SearchableDocument]:
    """The searchable books (what `ask_retrieval` may search): published, live, no question
    paper."""
    return {
        d.id: d
        for d in repo.searchable_documents(workspace_id)
        if is_searchable_document(d.document_type)
    }


def _fingerprint(session: Session, engine: SearchEngine, workspace_id: uuid.UUID) -> str:
    books = _books(SearchRepository(session), workspace_id)
    try:
        model = engine.model_key()
    except SearchUnavailableError:
        raise _unavailable() from None
    return corpus_fingerprint(
        ((str(d.id), str(d.revision_id)) for d in books.values()), embedding_model=model
    )


def _query(content: RevisionContent) -> str:
    return related_query(
        content.stem,
        question_type=content.question_type,
        options=content.options,
        correct_option_ids=content.correct_option_ids,
        accepted_answers=content.accepted_answers,
        rubric=content.rubric,
    )


def _test_dir(configured: str | None, name: str) -> Path:
    return (
        Path(configured.strip())
        if configured and configured.strip()
        else (Path(tempfile.gettempdir()) / name)
    )


def _test_hooks(settings: Settings, content: RevisionContent, revision_id: uuid.UUID) -> None:
    """APP_ENV=test only: hold barrier, first-computation fault, search-call record."""
    if settings.app_env is not Environment.TEST:
        return
    match = HOLD_MARKER.search(content.stem)
    if match:
        hold = _test_dir(settings.related_sources_hold_dir, HOLD_DIR_NAME)
        hold.mkdir(parents=True, exist_ok=True)
        token = match.group(1)
        (hold / f"{token}.held").touch()
        deadline = time.monotonic() + HOLD_TIMEOUT_SECONDS
        while not (hold / f"{token}.release").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
    if FAIL_MARKER in content.stem:
        faults = _test_dir(settings.related_sources_fault_dir, FAULT_DIR_NAME)
        faults.mkdir(parents=True, exist_ok=True)
        marker = faults / f"{revision_id}.failed"
        if not marker.exists():
            marker.touch()
            raise RelatedUnavailableError("injected test outage")
    calls = _test_dir(settings.related_sources_call_log_dir, CALL_DIR_NAME)
    calls.mkdir(parents=True, exist_ok=True)
    with (calls / f"{revision_id}.calls").open("a", encoding="utf-8") as fh:
        fh.write(f"{datetime.now(UTC).isoformat()}\n")


def _source_refs(
    repo: RelatedSourcesRepository, target: Target, content: RevisionContent
) -> list[SourceRef]:
    if target.kind is BANK:
        return repo.question_sources(target.owner_id)
    refs: list[SourceRef] = []
    for raw in content.evidence:
        if not isinstance(raw, dict):
            continue
        try:
            doc = uuid.UUID(str(raw.get("document_id")))
        except ValueError:
            continue
        blocks = tuple(str(b) for b in raw.get("block_ids") or () if isinstance(b, str))
        refs.append(SourceRef(doc, blocks))
    return refs


def _with_pages(
    repo: RelatedSourcesRepository, revision_id: uuid.UUID, block_ids: tuple[str, ...]
) -> tuple[tuple[str, ...], int, int] | None:
    found = repo.blocks(revision_id, block_ids)
    kept = tuple(b for b in block_ids if b in found)
    if not kept:
        return None
    pages = [found[b].page for b in kept]
    return kept, min(pages), max(pages)


def _compute(
    session: Session, deps: RelatedDeps, target: Target, content: RevisionContent
) -> tuple[list[dict[str, Any]], tuple[str, ...]]:
    settings = deps.settings
    _test_hooks(settings, content, target.revision_id)
    repo = RelatedSourcesRepository(session)
    search_repo = SearchRepository(session)
    books = _books(search_repo, target.workspace_id)
    chapters = search_repo.chapters_of([d.revision_id for d in books.values()])

    sources: list[RelatedCandidate] = []
    for ref in _source_refs(repo, target, content):
        doc = books.get(ref.document_id)
        if doc is None or not ref.block_ids:
            continue  # question paper, deleted / unpublished document, page-only source
        excluded = question_part_blocks(search_repo, doc, chapters) if _mixed(session, doc) else ()
        for block in ref.block_ids:
            if touches_question_part((block,), excluded):
                continue
            located = _with_pages(repo, doc.revision_id, (block,))
            if located is None:
                continue  # not in the published revision any more
            kept, first, last = located
            sources.append(
                RelatedCandidate(str(doc.id), str(doc.revision_id), kept, first, last, True)
            )

    limit = settings.related_sources_limit
    retrieval = AskRetrieval(session, deps.engine, scorer=relevance_scorer(settings))
    try:
        result = retrieval.retrieve(
            target.workspace_id,
            _query(content),
            RetrievalScope(),
            top_k=limit * CANDIDATE_FACTOR,
            max_context_chars=MAX_CANDIDATE_CHARS,
        )
    except RetrievalUnavailableError:
        raise RelatedUnavailableError("search index unavailable") from None
    hits: list[RelatedCandidate] = []
    for hit in result.sources:
        located = _with_pages(repo, hit.revision_id, hit.matched_block_ids or hit.block_ids)
        if located is None:
            continue
        kept, first, last = located
        hits.append(
            RelatedCandidate(
                str(hit.document_id),
                str(hit.revision_id),
                kept,
                first,
                last,
                score=hit.score,
                relevance=hit.relevance,
            )
        )
    merged = merge_related(
        sources, hits, limit=limit, min_relevance=settings.related_sources_min_relevance
    )
    items = [
        {
            "rank": rank,
            "document_id": c.document_id,
            "revision_id": c.revision_id,
            "block_ids": list(c.block_ids),
            "page_start": c.page_start,
            "page_end": c.page_end,
            "score": c.relevance if c.relevance is not None else c.score,
            "from_question_source": c.from_question_source,
        }
        for rank, c in enumerate(merged, start=1)
    ]
    return items, tuple(d for d in result.degraded if d == DEGRADED_DENSE)


def _mixed(session: Session, doc: SearchableDocument) -> bool:
    kind = session.execute(
        text("select content_kind from public.documents where id = :d"), {"d": doc.id}
    ).scalar_one_or_none()
    return kind == "mixed"


def _stored_outcome(row: StoredList) -> Outcome:
    return Outcome(row.id, (), row.items)


def resolve(session: Session, deps: RelatedDeps, target: Target) -> tuple[Outcome, RevisionContent]:
    """The stored list of the current key, else a computed one (stored unless archived or
    degraded). Raises 404 / 503 problems."""
    repo = RelatedSourcesRepository(session)
    content = repo.revision(target.kind, target.revision_id)
    if content is None:
        raise _not_found()
    fingerprint = _fingerprint(session, deps.engine, target.workspace_id)
    version = retrieval_version(deps.settings)
    row = repo.stored(target.kind, target.revision_id, fingerprint, version)
    if row is not None and (target.archived or not row.superseded or not target.current):
        session.rollback()
        return _stored_outcome(row), content
    if target.archived:
        try:
            items, degraded = _compute(session, deps, target, content)
        except RelatedUnavailableError:
            raise _unavailable() from None
        finally:
            session.rollback()
        return Outcome(None, degraded, items), content
    session.rollback()  # free the request's connection before waiting on the lock
    with deps.database.engine.connect() as raw, lock_lists(raw, target.kind, target.owner_id):
        # One REPEATABLE READ snapshot, taken after the lock: the key (fingerprint) and the
        # computation read the same corpus even if a book is published meanwhile.
        conn = raw.execution_options(isolation_level="REPEATABLE READ")
        with (
            conn.begin(),
            Session(bind=conn, join_transaction_mode="create_savepoint") as locked,
        ):
            locked_repo = RelatedSourcesRepository(locked)
            fingerprint = _fingerprint(locked, deps.engine, target.workspace_id)
            row = locked_repo.stored(target.kind, target.revision_id, fingerprint, version)
            if row is not None:
                if row.superseded and target.current:
                    locked_repo.make_current(target.kind, target.owner_id, row.id)
                    locked.commit()
                return _stored_outcome(row), content
            try:
                items, degraded = _compute(locked, deps, target, content)
            except RelatedUnavailableError:
                raise _unavailable() from None
            if degraded:
                return Outcome(None, degraded, items), content
            row_id = locked_repo.insert(
                target.kind,
                workspace_id=target.workspace_id,
                owner_id=target.owner_id,
                revision_id=target.revision_id,
                fingerprint=fingerprint,
                version=version,
                items=items,
                current=target.current,
            )
            locked.commit()
    return Outcome(row_id, (), items), content


# --- rendering ----------------------------------------------------------------------------------


def _root_chapters(chapters: list[ChapterRow]) -> dict[uuid.UUID, ChapterRow]:
    by_id = {c.id: c for c in chapters}
    roots: dict[uuid.UUID, ChapterRow] = {}
    for chapter in chapters:
        root, seen = chapter, {chapter.id}
        while root.parent_id is not None and root.parent_id in by_id and root.parent_id not in seen:
            root = by_id[root.parent_id]
            seen.add(root.id)
        roots[chapter.id] = root
    return roots


def render(
    session: Session, workspace_id: uuid.UUID, items: list[dict[str, Any]], query: str
) -> list[RelatedSource]:
    """Stored references → rows with excerpts from the blocks (in memory only)."""
    search_repo = SearchRepository(session)
    repo = RelatedSourcesRepository(session)
    live = {d.id: d for d in search_repo.searchable_documents(workspace_id)}
    wanted: dict[uuid.UUID, list[str]] = defaultdict(list)
    parsed: list[tuple[dict[str, Any], uuid.UUID, uuid.UUID]] = []
    for item in items:
        try:
            doc_id = uuid.UUID(str(item["document_id"]))
            rev_id = uuid.UUID(str(item["revision_id"]))
        except (KeyError, ValueError):
            continue
        if doc_id not in live:
            continue  # deleted since
        parsed.append((item, doc_id, rev_id))
        wanted[rev_id].extend(str(b) for b in item.get("block_ids") or ())
    blocks = {rev: repo.blocks(rev, ids) for rev, ids in wanted.items()}
    roots = _root_chapters(search_repo.chapters_of(list(wanted)))
    out: list[RelatedSource] = []
    for item, doc_id, rev_id in parsed:
        rows = [blocks[rev_id][b] for b in item.get("block_ids") or () if b in blocks[rev_id]]
        if not rows:
            continue
        excerpt, spans = related_excerpt([r.text for r in rows], query)
        root = roots.get(rows[0].chapter_id) if rows[0].chapter_id else None
        doc = live[doc_id]
        score = item.get("score")
        out.append(
            RelatedSource(
                rank=len(out) + 1,
                document_id=doc_id,
                document_title=doc.title,
                revision_id=rev_id,
                chapter_id=root.id if root else None,
                chapter_title=root.title if root else None,
                block_id=rows[0].block_id,
                block_ids=[r.block_id for r in rows],
                page_start=int(item.get("page_start") or rows[0].page),
                page_end=int(item.get("page_end") or rows[-1].page),
                excerpt=excerpt,
                highlights=[TextSpan(start=s, end=e) for s, e in spans],
                from_question_source=bool(item.get("from_question_source")),
                stale=doc.revision_id != rev_id,
                score=float(score) if isinstance(score, int | float) else None,
            )
        )
    session.rollback()
    return out


# --- routes -------------------------------------------------------------------------------------


@router.get("/questions/{question_id}/related-sources", operation_id="getQuestionRelatedSources")
def get_question_related_sources(
    access: QuestionAccess,
    session: DbSession,
    deps: Deps,
    practice_session_id: Annotated[
        uuid.UUID | None,
        Query(description="The caller's own submitted practice session of this question."),
    ] = None,
    view: Annotated[
        Literal["detail"] | None, Query(description="`detail`: the 문제 상세 dialog.")
    ] = None,
) -> RelatedSources:
    """Related passages of a registered question after a submission or in its details."""
    user = access.workspace.user_id
    repo = RelatedSourcesRepository(session)
    question = repo.bank_question(access.resource_id)
    if question is None:
        raise _not_found()
    if practice_session_id is not None:
        proof = repo.bank_session(practice_session_id, user, question.id)
        if proof is None:
            raise _not_found()
        if not proof.submitted:
            raise _before_submit()
        revision_id = proof.revision_id
    elif view == "detail":
        if question.status == "DRAFT" or question.active_revision_id is None:
            raise ProblemException(
                409,
                ProblemType.RELATED_DRAFT_UNAVAILABLE,
                detail="Draft questions have no related passages.",
            )
        revision_id = question.active_revision_id
    else:
        raise _before_submit()
    target = Target(
        kind=BANK,
        workspace_id=question.workspace_id,
        owner_id=question.id,
        revision_id=revision_id,
        current=revision_id == question.active_revision_id,
        archived=access.workspace.status != "active",
    )
    outcome, content = resolve(session, deps, target)
    return RelatedSources(
        id=outcome.row_id,
        question_revision_id=revision_id,
        stored=outcome.row_id is not None,
        degraded=[DEGRADED_DENSE] if outcome.degraded else [],
        items=render(session, question.workspace_id, outcome.items, _query(content)),
    )


@router.get(
    "/mock-exam-questions/{mock_exam_question_id}/related-sources",
    operation_id="getMockExamQuestionRelatedSources",
)
def get_mock_exam_question_related_sources(
    access: MockAccess,
    session: DbSession,
    deps: Deps,
    mock_practice_session_id: Annotated[
        uuid.UUID | None,
        Query(description="The caller's own submitted mock practice session of this question."),
    ] = None,
    view: Annotated[
        Literal["manage"] | None,
        Query(description="`manage`: 모의고사 문제 관리 (edit rights, active workspace)."),
    ] = None,
) -> MockRelatedSources:
    """Related passages of a mock exam question (its own list; evidence book blocks first)."""
    user = access.workspace.user_id
    repo = RelatedSourcesRepository(session)
    question = repo.mock_question(access.resource_id)
    if question is None or question.active_revision_id is None:
        raise _not_found()
    archived = access.workspace.status != "active"
    if mock_practice_session_id is not None:
        proof = repo.mock_session(mock_practice_session_id, user, question.id)
        if proof is None:
            raise _not_found()
        if not proof.submitted:
            raise _before_submit()
        revision_id = proof.revision_id
    elif view == "manage":
        if access.workspace.role not in EDIT_ROLES:
            raise ProblemException(
                403,
                ProblemType.INSUFFICIENT_ROLE,
                detail="Your role in this workspace does not allow this action.",
            )
        if archived:
            raise ProblemException(
                403, ProblemType.WORKSPACE_ARCHIVED, detail="This workspace is archived."
            )
        revision_id = question.active_revision_id
    else:
        raise _before_submit()
    target = Target(
        kind=MOCK,
        workspace_id=question.workspace_id,
        owner_id=question.id,
        revision_id=revision_id,
        current=revision_id == question.active_revision_id,
        archived=archived,
    )
    outcome, content = resolve(session, deps, target)
    return MockRelatedSources(
        id=outcome.row_id,
        mock_exam_question_revision_id=revision_id,
        stored=outcome.row_id is not None,
        degraded=[DEGRADED_DENSE] if outcome.degraded else [],
        items=render(session, question.workspace_id, outcome.items, _query(content)),
    )


@shared_router.get(
    "/questions/{question_id}/related-sources", operation_id="getSharedQuestionRelatedSources"
)
def get_shared_question_related_sources(
    link: Shared,
    question_id: Annotated[str, PathParam(max_length=64)],
    questions: QuestionRepo,
    session: DbSession,
    engine: Annotated[SearchEngine, Depends(get_search_engine)],
    request: Request,
) -> SharedRelatedSources:
    """The stored list of a published question's active revision and the current corpus;
    guests never compute (404 until a member's read stored one)."""
    try:
        qid = uuid.UUID(question_id)
    except ValueError:
        raise _not_found() from None
    found = questions.get(qid, with_sources=False)
    if (
        found is None
        or found.workspace_id != link.workspace_id
        or found.publication_status != "CONFIRMED"
    ):
        raise _not_found()
    settings: Settings = request.app.state.settings
    repo = RelatedSourcesRepository(session)
    revision_id = found.revision.id
    content = repo.revision(BANK, revision_id)
    if content is None:
        raise _not_found()
    fingerprint = _fingerprint(session, engine, link.workspace_id)
    row = repo.stored(BANK, revision_id, fingerprint, retrieval_version(settings))
    if row is None:
        raise _not_found()
    items = render(session, link.workspace_id, row.items, _query(content))
    return SharedRelatedSources(
        items=[
            SharedRelatedSource(**i.model_dump(exclude={"revision_id", "stale", "score"}))
            for i in items
        ]
    )
