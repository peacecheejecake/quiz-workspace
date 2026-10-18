"""Workspace search route (M3.6a) with an in-memory Qdrant index and a fake DB repository.

The synthetic books are parsed with the fixture parser, chunked and indexed exactly like the
worker does (FakeEmbedder); the repository fake serves the rows the worker would have written.
SQL and the real worker are covered in tests/integration/workspaces/test_search_api.py.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Collection, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from book_core.chunker import chunk_revision
from book_core.contracts import DocumentRevision
from book_core.embedding import EmbedderMode, FakeEmbedder, select_embedder
from book_core.indexing import QdrantIndexStore
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision, publish
from fastapi import FastAPI
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient
from quiz_api.api.search import get_search_repository, subtree_keys
from quiz_api.authz import LockMode, MembershipRecord, ResourceType, Role, get_access_repository
from quiz_api.document_content import block_attributes
from quiz_api.main import create_app
from quiz_api.rate_limit import TokenBucketLimiter
from quiz_api.repositories.search import ChapterRow, SearchableDocument
from quiz_api.search_engine import SearchEngine, SearchUnavailableError
from quiz_api.settings import Environment, InsecureConfigurationError, Settings

API = "/api/v1"
PROBLEM = "application/problem+json"
PDF_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "pdfs"
STALE_MARKER = "zebracorn"


def _parsed(book: str) -> Any:
    return FakeParser.from_truth_files([PDF_DIR / f"{book}.truth.json"]).parse(
        PDF_DIR / f"{book}.pdf"
    )


@dataclass
class Doc:
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    document_type: str
    revision: DocumentRevision
    chapters: list[ChapterRow]
    blocks: list[dict[str, Any]]
    deleted: bool = False
    published: bool = True

    @property
    def revision_id(self) -> uuid.UUID:
        return uuid.UUID(self.revision.revision_id)

    def chapter(self, title_part: str) -> ChapterRow:
        return next(c for c in self.chapters if title_part in c.title)


def _rows(
    doc_id: uuid.UUID, revision: DocumentRevision
) -> tuple[list[ChapterRow], list[dict[str, Any]]]:
    revision_id = uuid.UUID(revision.revision_id)
    ids = {s.id: uuid.uuid4() for s in revision.sections}
    chapters = [
        ChapterRow(
            id=ids[s.id],
            document_id=doc_id,
            revision_id=revision_id,
            parent_id=ids[s.parent_id] if s.parent_id else None,
            section_key=s.id,
            title=s.title,
            level=s.level,
            sort_order=order,
            heading_block_id=s.heading_block_id,
        )
        for order, s in enumerate(revision.sections)
    ]
    blocks = [
        {
            "block_id": b.id,
            "ordinal": b.ordinal if b.ordinal is not None else i,
            "chapter_id": ids[b.section_id] if b.section_id else None,
            "block_type": b.type.value,
            "text": b.text,
            "page": b.locations[0].page,
            "provenance": {
                "locations": [loc.model_dump(mode="json") for loc in b.locations],
                "source_block_ids": list(b.source_block_ids),
            },
            "attributes": block_attributes(b),
            "edited": b.edited,
        }
        for i, b in enumerate(revision.blocks)
    ]
    return chapters, blocks


@dataclass
class World:
    """Fake AccessRepository + SearchRepository over the indexed documents."""

    store: QdrantIndexStore
    members: dict[tuple[uuid.UUID, uuid.UUID], Role] = field(default_factory=dict)
    archived: set[uuid.UUID] = field(default_factory=set)
    docs: dict[uuid.UUID, Doc] = field(default_factory=dict)
    old_chapters: list[ChapterRow] = field(default_factory=list)
    block_queries: list[tuple[uuid.UUID, bool]] = field(default_factory=list)
    ended_reads: int = 0

    def add(
        self,
        workspace_id: uuid.UUID,
        book: str,
        *,
        document_type: str = "book",
        title: str | None = None,
        edits: dict[str, str] | None = None,
    ) -> Doc:
        doc_id = uuid.uuid4()
        revision = publish(
            build_revision(
                _parsed(book), document_id=str(doc_id), revision_id=str(uuid.uuid4())
            ).revision
        )
        if edits:
            revision = publish(apply_edits(revision, edits, revision_id=str(uuid.uuid4())))
        title = title or f"{book} title"
        chunks = chunk_revision(revision, document_title=title).chunks
        self.store.index_revision(
            str(workspace_id),
            str(doc_id),
            revision.revision_id,
            chunks,
            document_type=document_type,
        )
        chapters, blocks = _rows(doc_id, revision)
        doc = Doc(doc_id, workspace_id, title, document_type, revision, chapters, blocks)
        self.docs[doc_id] = doc
        return doc

    def supersede(self, doc: Doc, edits: dict[str, str]) -> Doc:
        """Index a new revision with `edits` and make it the DB-active one (the old revision's
        points stay in Qdrant, like before GC)."""
        old = doc.revision
        new = publish(apply_edits(old, edits, revision_id=str(uuid.uuid4())))
        chunks = chunk_revision(new, document_title=doc.title).chunks
        self.store.index_revision(
            str(doc.workspace_id), str(doc.id), new.revision_id, chunks, document_type="book"
        )
        self.old_chapters.extend(doc.chapters)
        chapters, blocks = _rows(doc.id, new)
        doc.revision, doc.chapters, doc.blocks = new, chapters, blocks
        return doc

    # AccessRepository
    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        role = self.members.get((workspace_id, user_id))
        if role is None:
            return None
        status = "archived" if workspace_id in self.archived else "active"
        return MembershipRecord(workspace_id, user_id, role, status, None)

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        return None

    # SearchRepository
    def end_read(self) -> None:
        self.ended_reads += 1

    def searchable_documents(self, workspace_id: uuid.UUID) -> list[SearchableDocument]:
        return [
            SearchableDocument(
                id=d.id,
                title=d.title,
                document_type=d.document_type,
                sha256=d.revision.source_sha256,
                revision_id=d.revision_id,
                revision_number=d.revision.revision_number,
            )
            for d in self.docs.values()
            if d.workspace_id == workspace_id and not d.deleted and d.published
        ]

    def existing_documents(
        self, workspace_id: uuid.UUID, document_ids: Collection[uuid.UUID]
    ) -> set[uuid.UUID]:
        return {
            d.id
            for d in self.docs.values()
            if d.id in document_ids and d.workspace_id == workspace_id and not d.deleted
        }

    def chapters_by_id(
        self, workspace_id: uuid.UUID, chapter_ids: Collection[uuid.UUID]
    ) -> list[ChapterRow]:
        live = [c for d in self.docs.values() for c in d.chapters] + self.old_chapters
        return [
            c
            for c in live
            if c.id in chapter_ids
            and self.docs[c.document_id].workspace_id == workspace_id
            and not self.docs[c.document_id].deleted
        ]

    def chapters_of(self, revision_ids: Collection[uuid.UUID]) -> list[ChapterRow]:
        return [c for d in self.docs.values() if d.revision_id in revision_ids for c in d.chapters]

    def blocks(
        self,
        revision_id: uuid.UUID,
        *,
        chapter_ids: Sequence[uuid.UUID] | None = None,
        without_chapter: bool = False,
    ) -> list[dict[str, Any]]:
        self.block_queries.append((revision_id, chapter_ids is None))
        doc = next(d for d in self.docs.values() if d.revision_id == revision_id)
        if chapter_ids is None:
            return list(doc.blocks)
        return [
            b
            for b in doc.blocks
            if b["chapter_id"] in chapter_ids or (without_chapter and b["chapter_id"] is None)
        ]


@pytest.fixture
def world() -> Iterator[World]:
    client = QdrantClient(":memory:")
    yield World(store=QdrantIndexStore(client, FakeEmbedder()))
    client.close()


@pytest.fixture
def app(make_verifier: Callable[..., Any], world: World, auth_kit: Any) -> FastAPI:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer,
        supabase_jwks_url=auth_kit.jwks_url,
        search_rate_per_minute=6000,
        search_rate_burst=1000,
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.state.search_engine = SearchEngine(settings, store_factory=lambda _s: world.store)
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_search_repository] = lambda: world
    return app


@pytest.fixture
def api(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@dataclass
class Caller:
    api: TestClient
    user_id: uuid.UUID
    headers: dict[str, str]

    def search(self, workspace_id: uuid.UUID, **body: Any) -> Any:
        body.setdefault("mode", "keyword")
        return self.api.post(
            f"{API}/workspaces/{workspace_id}/search",
            json=json.loads(json.dumps(body, default=str)),
            headers=self.headers,
        )

    def items(self, workspace_id: uuid.UUID, **body: Any) -> list[dict[str, Any]]:
        res = self.search(workspace_id, **body)
        assert res.status_code == 200, res.text
        items: list[dict[str, Any]] = res.json()["items"]
        return items


@pytest.fixture
def caller(api: TestClient, signing_key: Any, auth_kit: Any) -> Callable[[], Caller]:
    def make() -> Caller:
        user = uuid.uuid4()
        token = signing_key.sign(auth_kit.claims(user))
        return Caller(api, user, {"Authorization": f"Bearer {token}"})

    return make


def _member(world: World, who: Caller, role: Role = Role.OWNER) -> uuid.UUID:
    ws = uuid.uuid4()
    world.members[(ws, who.user_id)] = role
    return ws


def _strs(items: list[dict[str, Any]], key: str) -> set[str]:
    return {str(i[key]) for i in items}


# --- scope --------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["keyword", "semantic", "hybrid"])
def test_hits_carry_location_and_a_paragraph_excerpt(
    world: World, caller: Callable[[], Caller], mode: str
) -> None:
    alice = caller()
    ws = _member(world, alice, Role.VIEWER)
    en = world.add(ws, "book-en", title="Water Book")
    res = alice.search(ws, query="chlorine disinfection", mode=mode, limit=5)
    assert res.status_code == 200, res.text
    assert res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["mode"] == mode
    hit = next(i for i in body["items"] if "chlorine" in i["text"].lower())
    assert hit["document_id"] == str(en.id)
    assert hit["revision_id"] == str(en.revision_id)
    assert hit["document_title"] == "Water Book"
    assert hit["breadcrumb"][0] == "Water Book"
    assert hit["page"] == 4
    assert hit["bbox"] is not None
    assert hit["block_id"] in hit["block_ids"]
    assert set(hit["block_ids"]) <= set(hit["context_block_ids"])
    chapter = en.chapter("Water Treatment")
    assert hit["chapter_id"] == str(chapter.id)
    assert hit["section_id"] == str(en.chapter("Disinfection").id)
    assert hit["highlights"]
    assert any(
        hit["text"][t["start"] : t["end"]].lower().startswith("chlorin")
        for t in hit["term_highlights"]
    )
    assert hit["score_type"] == {"keyword": "bm25", "semantic": "cosine", "hybrid": "rrf"}[mode]
    assert [i["rank"] for i in body["items"]] == list(range(1, len(body["items"]) + 1))
    assert world.ended_reads == 1


def test_excerpt_blocks_are_read_per_section_not_the_whole_book(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    world.add(ws, "book-en")
    alice.items(ws, query="chlorine")
    assert world.block_queries
    assert not any(full for _, full in world.block_queries)


def test_stale_revisions_never_match_even_while_still_indexed(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    en = world.add(ws, "book-en")
    target = next(b for b in en.revision.blocks if "chlorine" in b.text.lower())
    # Revision 2 carries the marker and is searchable while it is the published one ...
    world.supersede(en, {target.id: f"{target.text} {STALE_MARKER}"})
    hits = alice.items(ws, query=STALE_MARKER)
    assert hits
    assert {h["revision_id"] for h in hits} == {str(en.revision_id)}
    assert STALE_MARKER in hits[0]["text"]
    # ... revision 3 drops it; revision 2's points are still in the index (GC pending).
    world.supersede(en, {target.id: f"{target.text} fixed"})
    for mode in ("keyword", "semantic", "hybrid"):
        found = alice.items(ws, query=STALE_MARKER, mode=mode)
        assert all(STALE_MARKER not in h["text"] for h in found), mode
        assert {h["revision_id"] for h in found} <= {str(en.revision_id)}, mode


def test_question_papers_are_left_out_unless_asked_for(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    book = world.add(ws, "book-en")
    paper = world.add(ws, "book-en", document_type="question_paper", title="Paper")
    assert _strs(alice.items(ws, query="chlorine"), "document_id") == {str(book.id)}
    both = alice.items(ws, query="chlorine", include_question_papers=True, limit=20)
    assert _strs(both, "document_id") == {str(book.id), str(paper.id)}
    named = alice.items(ws, query="chlorine", document_ids=[str(paper.id)])
    assert _strs(named, "document_id") == {str(paper.id)}
    assert {h["document_type"] for h in named} == {"question_paper"}


def test_chapter_filter_includes_sub_sections_and_stays_in_its_document(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    en = world.add(ws, "book-en")
    ko = world.add(ws, "book-ko")
    chapter2 = en.chapter("Water Treatment")
    subsections = {str(c.id) for c in en.chapters if c.parent_id == chapter2.id}
    assert subsections
    for mode in ("keyword", "semantic", "hybrid"):
        control = alice.items(ws, query="water 물", mode=mode, limit=50)
        assert _strs(control, "document_id") == {str(en.id), str(ko.id)}, mode
        hits = alice.items(ws, query="water", mode=mode, chapter_ids=[chapter2.id], limit=50)
        assert hits, mode
        assert _strs(hits, "document_id") == {str(en.id)}, mode
        assert _strs(hits, "chapter_id") == {str(chapter2.id)}, mode
        assert {h["page"] for h in hits} == {4}, mode
        assert _strs(hits, "section_id") & subsections, f"{mode}: sub-sections searched"

    # Chapters of two documents combine without leaking each other's sections.
    ko_chapter1 = ko.chapter("1장")
    mixed = alice.items(
        ws, query="water 물", chapter_ids=[chapter2.id, ko_chapter1.id], mode="hybrid", limit=50
    )
    for hit in mixed:
        expected = chapter2.id if hit["document_id"] == str(en.id) else ko_chapter1.id
        assert hit["chapter_id"] == str(expected)


def test_chapter_ids_of_an_older_revision_map_to_the_published_one(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    en = world.add(ws, "book-en")
    old_chapter = en.chapter("Water Treatment")
    target = next(b for b in en.revision.blocks if "chlorine" in b.text.lower())
    world.supersede(en, {target.id: f"{target.text} corrected"})
    hits = alice.items(ws, query="water", chapter_ids=[old_chapter.id], limit=50)
    assert hits
    assert _strs(hits, "chapter_id") == {str(en.chapter("Water Treatment").id)}
    assert _strs(hits, "revision_id") == {str(en.revision_id)}


def test_foreign_document_and_chapter_ids_are_404(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice, mallory = caller(), caller()
    ws = _member(world, alice)
    theirs = _member(world, mallory)
    world.add(ws, "book-en")
    secret = world.add(theirs, "book-ko")
    for body in (
        {"document_ids": [str(secret.id)]},
        {"document_ids": [str(uuid.uuid4())]},
    ):
        res = alice.search(ws, query="물", **body)
        assert res.status_code == 404, res.text
        assert res.json()["detail"] == "Document not found."
    for body in (
        {"chapter_ids": [str(secret.chapters[0].id)]},
        {"chapter_ids": [str(uuid.uuid4())]},
    ):
        res = alice.search(ws, query="물", **body)
        assert res.status_code == 404
        assert res.json()["detail"] == "Chapter not found."
        assert "물" not in res.text


def test_non_members_get_the_missing_workspace_404_and_no_content(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice, mallory = caller(), caller()
    ws = _member(world, alice)
    world.add(ws, "book-en", title="Alice Private")
    missing = mallory.search(uuid.uuid4(), query="chlorine")
    assert missing.status_code == 404
    for mode in ("keyword", "semantic", "hybrid"):
        res = mallory.search(ws, query="chlorine", mode=mode)
        assert res.status_code == 404
        assert res.headers["content-type"] == PROBLEM
        assert res.json()["detail"] == missing.json()["detail"]
        assert "chlorine" not in res.text.lower()
        assert "Alice Private" not in res.text


def test_other_workspaces_and_deleted_documents_never_match(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    other = _member(world, alice)
    mine = world.add(ws, "book-en")
    world.add(other, "book-en")
    assert _strs(alice.items(ws, query="chlorine", limit=50), "document_id") == {str(mine.id)}
    mine.deleted = True
    body = alice.search(ws, query="chlorine").json()
    assert body["items"] == []
    assert "no published documents in the search scope" in body["warnings"]


def test_archived_workspaces_stay_searchable(world: World, caller: Callable[[], Caller]) -> None:
    alice = caller()
    ws = _member(world, alice, Role.VIEWER)
    world.add(ws, "book-en")
    world.archived.add(ws)
    assert alice.items(ws, query="chlorine")


def test_language_filter_and_query_validation(world: World, caller: Callable[[], Caller]) -> None:
    alice = caller()
    ws = _member(world, alice)
    en = world.add(ws, "book-en")
    world.add(ws, "book-ko")
    only_en = alice.items(ws, query="water 물", mode="hybrid", languages=["en"], limit=50)
    assert only_en
    assert _strs(only_en, "document_id") == {str(en.id)}
    assert {h["language"] for h in only_en} == {"en"}

    blank = alice.search(ws, query="   ")
    assert blank.status_code == 422
    assert blank.headers["content-type"] == PROBLEM
    for bad in ({"mode": "fuzzy"}, {"limit": 0}, {"limit": 51}, {"document_ids": ["x"]}, {"x": 1}):
        assert alice.search(ws, query="water", **bad).status_code == 422, bad
    long = alice.search(ws, query="water " * 300).json()
    assert long["truncated"] is True
    assert any("truncated" in w for w in long["warnings"])


def test_a_workspace_without_published_documents_answers_an_empty_list(
    world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    pending = world.add(ws, "book-en")
    pending.published = False
    body = alice.search(ws, query="chlorine", mode="hybrid").json()
    assert body["items"] == []


def test_index_outage_is_503_without_details(
    app: FastAPI, world: World, caller: Callable[[], Caller]
) -> None:
    alice = caller()
    ws = _member(world, alice)
    world.add(ws, "book-en")

    def broken(_settings: Settings) -> Any:
        raise ConnectionRefusedError("http://secret-host:6333 refused")

    app.state.search_engine = SearchEngine(app.state.settings, store_factory=broken)
    res = alice.search(ws, query="chlorine")
    assert res.status_code == 503
    assert "secret-host" not in res.text


def test_rate_limit_answers_429_with_retry_after(
    app: FastAPI, world: World, caller: Callable[[], Caller]
) -> None:
    alice, bob = caller(), caller()
    ws = _member(world, alice)
    world.members[(ws, bob.user_id)] = Role.VIEWER
    app.state.search_limiter = TokenBucketLimiter(60, 2)
    assert alice.search(ws, query="x").status_code == 200
    assert alice.search(ws, query="x").status_code == 200
    limited = alice.search(ws, query="x")
    assert limited.status_code == 429
    assert limited.headers["content-type"] == PROBLEM
    assert int(limited.headers["retry-after"]) >= 1
    assert bob.search(ws, query="x").status_code == 200, "buckets are per user"


# --- units --------------------------------------------------------------------------------------


def test_token_bucket_refills_and_prunes_idle_keys() -> None:
    now = [0.0]
    limiter = TokenBucketLimiter(60, 2, clock=lambda: now[0], max_keys=2)
    assert limiter.acquire("a") is None
    assert limiter.acquire("a") is None
    wait = limiter.acquire("a")
    assert wait is not None
    assert 0 < wait <= 1
    now[0] += 1.0
    assert limiter.acquire("a") is None
    assert limiter.acquire("b") is None
    now[0] += 10
    assert limiter.acquire("c") is None  # prunes the refilled buckets
    assert TokenBucketLimiter(0, 1).acquire("a") is None


def test_subtree_keys_follow_parents_within_one_revision() -> None:
    doc, rev = uuid.uuid4(), uuid.uuid4()
    ids = [uuid.uuid4() for _ in range(4)]

    def row(i: int, parent: int | None, key: str) -> ChapterRow:
        return ChapterRow(
            ids[i], doc, rev, ids[parent] if parent is not None else None, key, key, 1, i, None
        )

    rows = [row(0, None, "a"), row(1, 0, "a1"), row(2, 1, "a1x"), row(3, None, "b")]
    assert subtree_keys(rows, [ids[0]]) == {"a", "a1", "a1x"}
    assert subtree_keys(rows, [ids[1], ids[3]]) == {"a1", "a1x", "b"}
    assert subtree_keys(rows, [uuid.uuid4()]) == set()


def test_search_engine_uses_the_worker_embedder_and_prefix() -> None:
    from quiz_worker.adapters import build_embedder
    from quiz_worker.settings import WorkerSettings

    env = {"APP_ENV": "test", "QDRANT_COLLECTION_PREFIX": "pfx_", "WORKER_EMBEDDER": "auto"}
    api_settings = Settings.model_validate(env)
    worker_settings = WorkerSettings.model_validate(env)
    assert api_settings.qdrant_collection_prefix == worker_settings.qdrant_collection_prefix
    assert api_settings.search_embedder.value == worker_settings.embedder.value

    api_embedder = select_embedder(
        api_settings.search_embedder, test_env=api_settings.app_env is Environment.TEST
    )
    assert api_embedder.model_name == build_embedder(worker_settings).model_name

    with pytest.raises(SearchUnavailableError):
        SearchEngine(Settings.model_construct(qdrant_url=None)).service()


def test_deployed_settings_refuse_the_fake_embedder() -> None:
    settings = Settings.model_construct(
        app_env=Environment.PRODUCTION,
        supabase_jwt_issuer="https://auth.example/auth/v1",
        supabase_jwks_url="https://auth.example/auth/v1/.well-known/jwks.json",
        cors_allowed_origins=("https://app.example",),
        search_embedder=EmbedderMode.FAKE,
    )
    with pytest.raises(InsecureConfigurationError, match="WORKER_EMBEDDER"):
        settings.ensure_secure_deployment()
