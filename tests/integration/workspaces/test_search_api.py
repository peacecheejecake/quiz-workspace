"""M3.6a end to end: workspace search over documents the worker parsed and indexed.

The API runs in-process (conftest.py) with APP_ENV=test (the fake embedder) and the same Qdrant
collection prefix as the in-process worker, which runs `document.parse` like the M3.4 test
(JobRunner, `quiz_worker` role, Supabase Storage, the fixture parser). The scope is checked
against the DB: superseded revisions stay in Qdrant (the worker keeps the previous published
revision for rollback) but are never returned; question papers are left out by default; chapter
filters include sub-sections; other workspaces answer 404 or contribute nothing.

Needs `make infra-up`, the quiz_api / quiz_worker login steps (AGENTS.md §7) and
SUPABASE_SECRET_KEY in `.env`.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_api.main import create_app
from quiz_api.settings import Settings
from quiz_worker.adapters import FailureInjectingEmbedder, build_parser
from quiz_worker.document_job import DocumentJobDeps, Limits, document_parse_definition
from quiz_worker.document_store import PostgresDocumentStore
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import SupabaseStorage

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
API_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
)
WORKER_DATABASE_URL = os.environ.get(
    "WORKER_DATABASE_URL", "postgresql://quiz_worker:change-me-local@127.0.0.1:54322/postgres"
)
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
CHLORINE_KO = "마지막으로 염소와 같은 소독제를"  # book-ko ch2-s2-p2 (page 4)
MARKER = "M36A검색표식"
MODES = ("keyword", "semantic", "hybrid")
# Matches both chapters of book-ko (순환: chapter 1, 정수 처리: chapter 2) and book-en.
QUERY = "순환 정수 처리 water"


@pytest.fixture(scope="module")
def env() -> WorkerSettings:
    settings = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    if not settings.supabase_secret_key or not settings.supabase_url:
        pytest.fail("SUPABASE_SECRET_KEY / SUPABASE_URL missing from .env (Storage access)")
    return settings.model_copy(update={"app_env": Environment.TEST})


@pytest.fixture(scope="module")
def names() -> CollectionNames:
    return CollectionNames(prefix=f"it_m36a_{uuid.uuid4().hex[:8]}_")


@pytest.fixture(scope="module")
def qdrant(env: WorkerSettings, names: CollectionNames) -> Iterator[QdrantClient]:
    client = QdrantClient(url=env.qdrant_url or "http://127.0.0.1:6333", timeout=30)
    try:
        yield client
    finally:
        for alias in client.get_aliases().aliases:
            if alias.alias_name == names.alias:
                client.update_collection_aliases(
                    change_aliases_operations=[
                        qm.DeleteAliasOperation(
                            delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                        )
                    ]
                )
        for collection in client.get_collections().collections:
            if names.owns(collection.name):
                client.delete_collection(collection.name)
        client.close()


@pytest.fixture(scope="module")
def app_client(stack: Any, names: CollectionNames, qdrant: QdrantClient) -> Iterator[TestClient]:
    """Overrides conftest's app: the API searches the worker's test collections."""
    settings = Settings(
        DATABASE_URL=API_DATABASE_URL,
        SUPABASE_JWT_ISSUER=ISSUER,
        SUPABASE_JWKS_URL=f"{ISSUER}/.well-known/jwks.json",
        APP_ENV="test",
        QDRANT_COLLECTION_PREFIX=names.prefix,
        WORKER_EMBEDDER="auto",
    )
    with TestClient(
        create_app(settings, readiness_checkers=[]), raise_server_exceptions=False
    ) as c:
        yield c


@dataclass
class Worker:
    jobs: PostgresJobStore
    runner: JobRunner
    deps: DocumentJobDeps
    qdrant: QdrantClient
    store: QdrantIndexStore

    def run(self, job_id: str) -> None:
        record = self.jobs.get(uuid.UUID(job_id))
        assert record is not None, "job row missing"
        definition = document_parse_definition(lambda: self.deps)
        result = self.runner.run(definition, record.to_envelope().to_message())
        assert result.outcome is RunOutcome.SUCCEEDED, result.error

    def revisions_indexed(self, document_id: str) -> set[str]:
        collection = self.store.ensure_collection()
        flt = qm.Filter(
            must=[qm.FieldCondition(key="document_id", match=qm.MatchValue(value=document_id))]
        )
        records, _ = self.qdrant.scroll(
            collection, scroll_filter=flt, limit=10_000, with_payload=True
        )
        return {str((r.payload or {})["revision_id"]) for r in records}


@pytest.fixture
def worker(
    env: WorkerSettings, names: CollectionNames, qdrant: QdrantClient, seed: Any
) -> Iterator[Worker]:
    engine = create_job_store_engine(WORKER_DATABASE_URL, pool_size=4)
    secret = env.supabase_secret_key
    assert secret is not None
    assert env.supabase_url
    storage = SupabaseStorage(env.supabase_url, secret.get_secret_value())
    store = QdrantIndexStore(qdrant, FailureInjectingEmbedder(FakeEmbedder()), names=names)
    deps = DocumentJobDeps(
        documents=PostgresDocumentStore(engine),
        storage=storage,
        index=store,
        parser=build_parser(env),
        limits=Limits(lock_wait_seconds=10),
    )
    jobs = PostgresJobStore(engine)
    try:
        yield Worker(
            jobs=jobs,
            runner=JobRunner(jobs, worker_id="it-m36a", lease_seconds=600),
            deps=deps,
            qdrant=qdrant,
            store=store,
        )
    finally:
        storage.close()
        engine.dispose()


# --- helpers --------------------------------------------------------------------------------------


def _upload(client: Any, workspace_id: str, pdf_name: str, document_type: str = "book") -> Any:
    pdf = (PDF_DIR / pdf_name).read_bytes()
    sha256 = hashlib.sha256(pdf).hexdigest()
    intent = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": pdf_name,
            "size_bytes": len(pdf),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": document_type,
        },
        (200, 201),
    )
    url = str(intent["upload_url"])
    assert urlsplit(url).hostname in {"127.0.0.1", "localhost"}
    put = httpx.put(
        url,
        content=pdf,
        headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
        timeout=30,
    )
    assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
    return client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )


def _ready(client: Any, worker: Worker, workspace_id: str, pdf: str, kind: str = "book") -> str:
    done = _upload(client, workspace_id, pdf, kind)
    worker.run(str(done["job_id"]))
    return str(done["document_id"])


def _search(client: Any, workspace_id: str, **body: Any) -> list[dict[str, Any]]:
    body.setdefault("mode", "keyword")
    items: list[dict[str, Any]] = client.ok("POST", f"/workspaces/{workspace_id}/search", body)[
        "items"
    ]
    return items


def _active(client: Any, document_id: str) -> str:
    return str(client.ok("GET", f"/documents/{document_id}")["active_revision_id"])


def _flatten(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for item in items:
        out.append(item)
        out.extend(_flatten(item["children"]))
    return out


# --- tests ----------------------------------------------------------------------------------------


def test_m36a_stale_revision_is_never_returned_after_the_publish_switch(
    seed: Any, worker: Worker
) -> None:
    owner = seed.client("m36a-stale")
    ws = owner.create_workspace()["id"]
    doc = _ready(owner, worker, ws, "book-ko.pdf")
    first = _active(owner, doc)

    hits = _search(owner, ws, query="염소 소독제")
    hit = next(h for h in hits if CHLORINE_KO in h["text"])
    assert (hit["document_id"], hit["revision_id"], hit["page"]) == (doc, first, 4)
    assert hit["bbox"] is not None
    assert any(CHLORINE_KO in hit["text"][s["start"] : s["end"]] for s in hit["highlights"])
    assert hit["breadcrumb"][-1] == "2.2 여과와 소독"

    blocks = owner.ok("GET", f"/documents/{doc}/blocks?page=4")["items"]
    block = next(b for b in blocks if CHLORINE_KO in b["text"])
    assert block["block_id"] in hit["block_ids"]
    owner.ok(
        "PATCH",
        f"/documents/{doc}/blocks/{block['block_id']}",
        {"text": block["text"].replace("염소", MARKER), "base_version": block["version"]},
    )
    # The draft is not searchable; the published text still is.
    for mode in MODES:
        assert not any(MARKER in h["text"] for h in _search(owner, ws, query=MARKER, mode=mode))
    assert any(CHLORINE_KO in h["text"] for h in _search(owner, ws, query="염소 소독제"))

    job = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))
    worker.run(job["job_id"])
    second = _active(owner, doc)
    assert second != first
    # The superseded revision is still indexed (kept for rollback) but never searched.
    assert {first, second} <= worker.revisions_indexed(doc)
    for mode in MODES:
        found = _search(owner, ws, query=f"{MARKER} 염소 소독제", mode=mode, limit=50)
        assert found, mode
        assert {h["revision_id"] for h in found} == {second}, mode
        assert not any(CHLORINE_KO in h["text"] for h in found), mode
    assert any(MARKER in h["text"] for h in _search(owner, ws, query=MARKER))


def test_m36a_question_papers_are_excluded_unless_requested(seed: Any, worker: Worker) -> None:
    owner = seed.client("m36a-papers")
    ws = owner.create_workspace()["id"]
    book = _ready(owner, worker, ws, "book-ko.pdf")
    paper = _ready(owner, worker, ws, "book-en.pdf", "question_paper")

    for mode in MODES:
        default = _search(owner, ws, query="chlorine 염소", mode=mode, limit=50)
        assert {h["document_id"] for h in default} == {book}, mode
    both = _search(owner, ws, query="chlorine 염소", include_question_papers=True, limit=50)
    assert {h["document_id"] for h in both} == {book, paper}
    named = _search(owner, ws, query="chlorine", document_ids=[paper])
    assert named
    assert {(h["document_id"], h["document_type"]) for h in named} == {(paper, "question_paper")}


def test_m36a_chapter_filter_includes_sub_sections_in_every_mode(seed: Any, worker: Worker) -> None:
    owner = seed.client("m36a-chapter")
    viewer = seed.client("m36a-chapter-viewer")
    ws = owner.create_workspace()["id"]
    seed.membership(ws, viewer.user, "viewer")
    ko = _ready(owner, worker, ws, "book-ko.pdf")
    en = _ready(owner, worker, ws, "book-en.pdf")

    outline = owner.ok("GET", f"/documents/{ko}/outline")["items"]
    chapter2 = next(n for n in outline if n["title"] == "2장 정수 처리")
    subsections = {c["id"] for c in chapter2["children"]}
    nodes = {n["id"] for n in _flatten([chapter2])}
    for mode in MODES:
        control = _search(viewer, ws, query=QUERY, mode=mode, limit=50)
        assert {h["document_id"] for h in control} == {ko, en}, mode
        assert {h["page"] for h in control if h["document_id"] == ko} - {4}, f"{mode} control"
        hits = _search(viewer, ws, query=QUERY, mode=mode, chapter_ids=[chapter2["id"]])
        assert hits, mode
        assert {h["document_id"] for h in hits} == {ko}, mode
        assert {h["chapter_id"] for h in hits} == {chapter2["id"]}, mode
        assert {h["section_id"] for h in hits} <= nodes, mode
        assert {h["page"] for h in hits} == {4}, mode
    deep = _search(viewer, ws, query="염소 소독제", chapter_ids=[chapter2["id"]])
    assert {h["section_id"] for h in deep} & subsections, "sub-sections are searched"
    sub = next(c for c in chapter2["children"] if c["title"] == "2.1 응집과 침전")
    only_sub = _search(viewer, ws, query="물", mode="hybrid", chapter_ids=[sub["id"]], limit=50)
    assert only_sub
    assert {h["section_id"] for h in only_sub} == {sub["id"]}


def test_m36a_other_workspaces_are_404_or_contribute_nothing(seed: Any, worker: Worker) -> None:
    alice, mallory = seed.client("m36a-x-alice"), seed.client("m36a-x-mallory")
    ws = alice.create_workspace("Alice Search Private")["id"]
    secret_doc = _ready(alice, worker, ws, "book-ko.pdf")
    outline = alice.ok("GET", f"/documents/{secret_doc}/outline")["items"]
    theirs = mallory.create_workspace()["id"]
    _ready(mallory, worker, theirs, "book-en.pdf")

    missing = seed.problem(
        mallory.call("POST", f"/workspaces/{uuid.uuid4()}/search", {"query": "물"}), 404
    )
    for mode in MODES:
        res = mallory.call("POST", f"/workspaces/{ws}/search", {"query": "염소", "mode": mode})
        assert seed.problem(res, 404) == missing, mode
        assert "염소" not in res.text
        assert "Alice Search Private" not in res.text
        # Alice's documents never surface in Mallory's own workspace.
        own = _search(mallory, theirs, query="염소 소독제 chlorine", mode=mode, limit=50)
        assert secret_doc not in {h["document_id"] for h in own}, mode
        assert not any(CHLORINE_KO in h["text"] for h in own), mode
    for body in ({"document_ids": [secret_doc]}, {"chapter_ids": [outline[0]["id"]]}):
        res = mallory.call("POST", f"/workspaces/{theirs}/search", {"query": "물", **body})
        seed.problem(res, 404)
        assert "물의 순환" not in res.text

    # A soft-deleted document leaves the scope at once.
    alice.ok("DELETE", f"/documents/{secret_doc}", expected=(200, 202, 204))
    assert _search(alice, ws, query="염소 소독제", mode="hybrid") == []
    with psycopg.connect(DB_ADMIN_URL) as conn:
        deleted = conn.execute(
            "select deleted_at is not null from public.documents where id = %s", (secret_doc,)
        ).fetchone()
    assert deleted == (True,)
