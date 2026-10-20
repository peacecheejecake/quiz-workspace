"""M3.2b end to end: upload through the API, run `document.parse` as the worker, read the job
status (and its SSE stream) back through the API.

The worker side runs in-process without Celery (JobRunner = what the Celery task executes) with
the real dependencies: Postgres as the least-privilege `quiz_worker` role, Supabase Storage with
the server key, Qdrant (collections under a per-module prefix, dropped afterwards). Adapters are
the APP_ENV=test ones: the fixture-truth parser (book-ko's SHA-256 matches its truth file) and
the deterministic fake embedder with the `E2E-FAIL-INDEXING` failure marker.

Needs `make infra-up`, the quiz_api / quiz_worker login steps (AGENTS.md §7) and SUPABASE_SECRET_KEY
in `.env`. Fixtures: conftest.py.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
from book_core.chunker import chunk_revision
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from book_core.structure import apply_edits
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_worker.adapters import INDEX_FAILURE_MARKER, FailureInjectingEmbedder, build_parser
from quiz_worker.document_job import (
    DocumentJobDeps,
    Limits,
    document_parse_definition,
    parsed_object_key,
)
from quiz_worker.document_store import PostgresDocumentStore
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.runner import JobRunner, RunOutcome, RunResult
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import PARSED_BUCKET, SOURCE_BUCKET, SupabaseStorage

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
WORKER_DATABASE_URL = os.environ.get(
    "WORKER_DATABASE_URL", "postgresql://quiz_worker:change-me-local@127.0.0.1:54322/postgres"
)
BOOK_KO_SECTIONS = 6
BOOK_KO_BLOCKS = 23


class FlakyIndex:
    """The real index store; `crash_after_index` fails once right after a complete write."""

    def __init__(self, inner: QdrantIndexStore) -> None:
        self.inner = inner
        self.crash_after_index = False

    def index_revision(self, *args: Any, **kwargs: Any) -> Any:
        report = self.inner.index_revision(*args, **kwargs)
        if self.crash_after_index:
            self.crash_after_index = False
            raise ConnectionError("worker lost between indexing and publishing")
        return report

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class CountingParser:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = 0

    @property
    def parser_version(self) -> str:
        return str(self.inner.parser_version)

    def parse(self, path: Any, *, source_path: str | None = None) -> Any:
        self.calls += 1
        return self.inner.parse(path, source_path=source_path)


class ProgressProbe:
    """Wraps the document store; after each progress write, reads the job through the API."""

    def __init__(self, inner: PostgresDocumentStore) -> None:
        self.inner = inner
        self.reader: Any = None
        self.seen: list[tuple[str, int | None, str | None]] = []
        # Also read the document list (`/workspaces/{id}/documents`) after each progress write.
        self.list_path: str | None = None
        self.listed: list[dict[str, Any] | None] = []

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        self.inner.report_progress(job_id, attempt, stage, percent)
        if self.reader is not None:
            body = self.reader.ok("GET", f"/jobs/{job_id}")
            self.seen.append((body["status"], body["progress"], body["stage"]))
        if self.reader is not None and self.list_path is not None:
            items = self.reader.ok("GET", self.list_path)["items"]
            self.listed.extend(item["processing_job"] for item in items)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


@dataclass
class Worker:
    jobs: PostgresJobStore
    runner: JobRunner
    deps: DocumentJobDeps
    index: FlakyIndex
    parser: CountingParser
    documents: ProgressProbe
    qdrant: QdrantClient
    storage: SupabaseStorage

    def run(self, job_id: str) -> RunResult:
        record = self.jobs.get(uuid.UUID(job_id))
        assert record is not None, "job row missing"
        definition = document_parse_definition(lambda: self.deps)
        return self.runner.run(definition, record.to_envelope().to_message())

    def points(self, document_id: str) -> list[dict[str, Any]]:
        collection = self.index.inner.ensure_collection()
        flt = qm.Filter(
            must=[qm.FieldCondition(key="document_id", match=qm.MatchValue(value=document_id))]
        )
        records, _ = self.qdrant.scroll(
            collection, scroll_filter=flt, limit=10_000, with_payload=True
        )
        return [dict(r.payload or {}) for r in records]


@pytest.fixture(scope="module")
def env() -> WorkerSettings:
    settings = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    if not settings.supabase_secret_key or not settings.supabase_url:
        pytest.fail("SUPABASE_SECRET_KEY / SUPABASE_URL missing from .env (Storage access)")
    return settings.model_copy(update={"app_env": Environment.TEST})


@pytest.fixture(scope="module")
def qdrant(env: WorkerSettings) -> Iterator[tuple[QdrantClient, CollectionNames]]:
    client = QdrantClient(url=env.qdrant_url or "http://127.0.0.1:6333", timeout=30)
    names = CollectionNames(prefix=f"it_m32b_{uuid.uuid4().hex[:8]}_")
    try:
        yield client, names
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


@pytest.fixture
def worker(
    env: WorkerSettings, qdrant: tuple[QdrantClient, CollectionNames], seed: Any
) -> Iterator[Worker]:
    client, names = qdrant
    engine = create_job_store_engine(WORKER_DATABASE_URL, pool_size=4)
    secret = env.supabase_secret_key
    assert secret is not None
    assert env.supabase_url
    storage = SupabaseStorage(env.supabase_url, secret.get_secret_value())
    index = FlakyIndex(
        QdrantIndexStore(client, FailureInjectingEmbedder(FakeEmbedder()), names=names)
    )
    parser = CountingParser(build_parser(env))
    documents = ProgressProbe(PostgresDocumentStore(engine))
    deps = DocumentJobDeps(
        documents=documents,  # type: ignore[arg-type]
        storage=storage,
        index=index,  # type: ignore[arg-type]
        parser=parser,
        limits=Limits(lock_wait_seconds=10),
    )
    jobs = PostgresJobStore(engine)
    try:
        yield Worker(
            jobs=jobs,
            runner=JobRunner(jobs, worker_id="it-m32b", lease_seconds=600),
            deps=deps,
            index=index,
            parser=parser,
            documents=documents,
            qdrant=client,
            storage=storage,
        )
    finally:
        storage.close()
        engine.dispose()


def _admin(sql: str, *params: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


def _content_counts(revision_id: str) -> tuple[int, int]:
    rows = _admin(
        "select (select count(*) from public.chapters where document_revision_id = %s), "
        "(select count(*) from public.content_blocks where document_revision_id = %s)",
        revision_id,
        revision_id,
    )
    return int(rows[0][0]), int(rows[0][1])


def _upload(seed: Any, label: str) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    alice = seed.client(label)
    ws = alice.create_workspace()
    _, _, done = alice.upload_book(ws["id"])
    return alice, ws, done


def test_m32b_upload_is_parsed_indexed_and_published(seed: Any, worker: Worker) -> None:
    alice, ws, done = _upload(seed, "m32b-happy")
    doc_id, job_id = done["document_id"], done["job_id"]
    queued = alice.ok("GET", f"/jobs/{job_id}")
    assert (queued["status"], queued["job_type"], queued["progress"]) == (
        "queued",
        "document.parse",
        None,
    )
    worker.documents.reader = alice

    result = worker.run(job_id)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    # Progress was visible through GET /jobs while the job ran, in order.
    assert {s for s, _, _ in worker.documents.seen} == {"running"}
    assert [stage for _, _, stage in worker.documents.seen] == [
        "downloading",
        "parsing",
        "structuring",
        "chunking",
        "indexing",
        "publishing",
    ]
    job = alice.ok("GET", f"/jobs/{job_id}")
    assert (job["status"], job["progress"], job["error_code"]) == ("succeeded", 100, None)

    document = alice.ok("GET", f"/documents/{doc_id}")
    revision_id = document["latest_revision"]["id"]
    assert document["status"] == "ready"
    assert document["active_revision_id"] == revision_id
    assert document["active_revision"]["status"] == "published"
    assert _content_counts(revision_id) == (BOOK_KO_SECTIONS, BOOK_KO_BLOCKS)
    titles = _admin(
        "select title, section_key, level from public.chapters "
        "where document_revision_id = %s order by sort_order",
        revision_id,
    )
    assert titles[0] == ("1장 물의 순환", "sec-ch1-heading", 1)
    key = _admin(
        "select parsed_object_key from public.document_revisions where id = %s", revision_id
    )[0][0]
    assert key.endswith(f"/revisions/{revision_id}/parsed_document.json")

    points = worker.points(doc_id)
    assert points
    assert {p["workspace_id"] for p in points} == {ws["id"]}
    assert {p["revision_id"] for p in points} == {revision_id}
    assert {p["document_type"] for p in points} == {"book"}
    assert {p["active"] for p in points} == {True}
    # The Qdrant mirror was synced inline, so its durable obligation is already resolved.
    sync = _admin(
        "select status, attempts from public.async_jobs where job_type = 'document.index_sync' "
        "and idempotency_key = %s",
        f"index_sync:{revision_id}",
    )
    assert sync == [("succeeded", 0)]

    # The SSE stream of a finished job: one `job` event with the terminal status, then the end.
    res = alice.call("GET", f"/jobs/{job_id}/events")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert res.text.count("event: job") == 1
    assert '"status":"succeeded"' in res.text

    worker.storage.delete(PARSED_BUCKET, key)


class ColdParser:
    """The test parser behind a model load (`prepare`), like a cold Docling (UX3-JOB)."""

    def __init__(self, inner: CountingParser) -> None:
        self.inner = inner
        self.prepared = False

    @property
    def parser_version(self) -> str:
        return self.inner.parser_version

    def prepare(self) -> None:
        self.prepared = True

    def parse(self, path: Path, *, source_path: str | None = None) -> Any:
        return self.inner.parse(path, source_path=source_path)


def test_ux3_job_document_list_shows_the_running_job_and_its_stage(
    seed: Any, worker: Worker
) -> None:
    """DOC-01-AC05 data: the library list carries the queued/running parse job (status, stage,
    queued/started times) read in the caller's workspace, and drops it once the job is done."""
    alice, ws, done = _upload(seed, "ux3-job-list")
    doc_id, job_id = done["document_id"], done["job_id"]
    list_path = f"/workspaces/{ws['id']}/documents"
    queued = alice.ok("GET", list_path)["items"][0]
    assert queued["id"] == doc_id
    assert queued["processing_job"]["id"] == job_id
    assert queued["processing_job"]["status"] == "queued"
    assert queued["processing_job"]["created_at"]
    assert queued["processing_job"]["started_at"] is None
    assert alice.ok("GET", f"/documents/{doc_id}")["processing_job"]["id"] == job_id
    # Another user's workspace list never shows it, and this one is not theirs to read.
    mallory = seed.client("ux3-job-mallory")
    other = mallory.create_workspace()
    assert mallory.ok("GET", f"/workspaces/{other['id']}/documents")["items"] == []
    seed.problem(mallory.call("GET", list_path), 404)

    worker.deps.parser = ColdParser(worker.parser)
    worker.documents.reader = alice
    worker.documents.list_path = list_path
    result = worker.run(job_id)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    listed = worker.documents.listed
    assert listed
    assert all(job is not None and job["status"] == "running" for job in listed)
    assert all(job is not None and job["started_at"] for job in listed)
    stages = [job["stage"] for job in listed if job is not None]
    assert stages[:3] == ["preparing", "downloading", "parsing"]
    assert stages == [stage for _, _, stage in worker.documents.seen]
    finished = alice.ok("GET", list_path)["items"][0]
    assert (finished["status"], finished["processing_job"]) == ("ready", None)


def test_m32b_retry_after_a_crash_does_not_duplicate(seed: Any, worker: Worker) -> None:
    alice, _ws, done = _upload(seed, "m32b-retry")
    doc_id, job_id = done["document_id"], done["job_id"]
    worker.index.crash_after_index = True

    first = worker.run(job_id)

    assert first.outcome is RunOutcome.RETRY
    assert alice.ok("GET", f"/jobs/{job_id}")["status"] == "queued"
    document = alice.ok("GET", f"/documents/{doc_id}")
    revision_id = document["latest_revision"]["id"]
    assert (document["status"], document["active_revision_id"]) == ("processing", None)
    counts = _content_counts(revision_id)
    assert counts == (BOOK_KO_SECTIONS, BOOK_KO_BLOCKS)
    written = worker.points(doc_id)
    assert written
    assert {p["active"] for p in written} == {False}

    second = worker.run(job_id)
    duplicate = worker.run(job_id)

    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    assert duplicate.outcome is RunOutcome.DUPLICATE_FINISHED
    assert worker.parser.calls == 1, "the retry must reuse the stored content"
    assert _content_counts(revision_id) == counts
    final = worker.points(doc_id)
    assert len(final) == len(written)
    assert len({p["chunk_id"] for p in final}) == len(final)
    assert {p["active"] for p in final} == {True}
    assert alice.ok("GET", f"/documents/{doc_id}")["status"] == "ready"
    job = alice.ok("GET", f"/jobs/{job_id}")
    assert (job["status"], job["attempts"]) == ("succeeded", 2)


def test_m32b_failed_reindex_keeps_the_previous_revision(seed: Any, worker: Worker) -> None:
    alice, ws, done = _upload(seed, "m32b-fail")
    doc_id = done["document_id"]
    assert worker.run(done["job_id"]).outcome is RunOutcome.SUCCEEDED
    first_id = alice.ok("GET", f"/documents/{doc_id}")["active_revision_id"]
    live = sorted(p["chunk_id"] for p in worker.points(doc_id))

    # A corrected draft (as M3.4 will create) whose new text trips the E2E failure marker.
    store = worker.documents.inner
    loaded = store.load(uuid.UUID(ws["id"]), uuid.UUID(doc_id), uuid.UUID(first_id))
    assert loaded is not None
    document, first = loaded
    base = store.load_content(document, first)
    target = next(b for b in base.blocks if b.type.value == "text")
    second_id = uuid.uuid4()
    draft = apply_edits(
        base, {target.id: f"{INDEX_FAILURE_MARKER} 교정된 문단"}, revision_id=str(second_id)
    )
    _admin(
        "insert into public.document_revisions (id, workspace_id, document_id, revision_number, "
        "parent_revision_id, source_object_key, created_by) "
        "values (%s, %s, %s, 2, %s, %s, %s)",
        second_id,
        ws["id"],
        doc_id,
        first_id,
        document.source_object_key,
        alice.user.id,
    )
    loaded2 = store.load(uuid.UUID(ws["id"]), uuid.UUID(doc_id), second_id)
    assert loaded2 is not None
    store.write_content(
        document,
        loaded2[1],
        draft,
        parser_version="test",
        parsed_object_key=parsed_object_key(document, second_id),
    )
    job_id = uuid.uuid4()
    _admin(
        "insert into public.async_jobs (id, workspace_id, created_by, job_type, schema_version, "
        "idempotency_key, payload) values (%s, %s, %s, 'document.parse', 1, %s, %s::jsonb)",
        job_id,
        ws["id"],
        alice.user.id,
        f"reindex:{second_id}",
        f'{{"document_id": "{doc_id}", "revision_id": "{second_id}"}}',
    )

    result = worker.run(str(job_id))

    assert result.outcome is RunOutcome.FAILED
    job = alice.ok("GET", f"/jobs/{job_id}")
    assert (job["status"], job["error_code"]) == ("failed", "indexing_failed")
    assert INDEX_FAILURE_MARKER not in str(job)
    after = alice.ok("GET", f"/documents/{doc_id}")
    assert (after["status"], after["active_revision_id"]) == ("ready", first_id)
    assert after["last_error"].startswith("indexing_failed")
    assert after["latest_revision"]["status"] == "draft"
    # The live revision is untouched and still the only one in the index (cleanup removed the
    # draft's partial points).
    points = worker.points(doc_id)
    assert sorted(p["chunk_id"] for p in points) == live
    assert {(p["revision_id"], p["active"]) for p in points} == {(first_id, True)}
    cleanup = _admin("select cleanup_pending from public.async_jobs where id = %s", job_id)
    assert cleanup == [(False,)]
    content = store.load_content(document, first)
    assert len(chunk_revision(content, document_title=document.title).chunks) == len(live)

    worker.storage.delete(PARSED_BUCKET, parsed_object_key(document, uuid.UUID(first_id)))


def test_m32b_jobs_of_other_users_are_404(seed: Any) -> None:
    alice, _ws, done = _upload(seed, "m32b-owner")
    mallory = seed.client("m32b-mallory")
    job = done["job_id"]

    assert alice.ok("GET", f"/jobs/{job}")["id"] == job
    for path in (f"/jobs/{job}", f"/jobs/{job}/events"):
        foreign = seed.problem(mallory.call("GET", path), 404)
        missing = seed.problem(mallory.call("GET", path.replace(job, str(uuid.uuid4()))), 404)
        assert foreign == missing
    res = mallory.call("GET", f"/jobs/{job}/events")
    assert "event:" not in res.text
    assert SOURCE_BUCKET not in res.text
