"""`document.parse` pipeline with fakes (no DB, Storage or models; Qdrant in local mode).

The same flow against the real stack (API upload, Postgres as quiz_worker, Supabase Storage,
Qdrant) is in tests/integration/workspaces/test_document_parse_job.py; the Docling path is in
test_document_job_models.py.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from book_core.chunker import chunk_revision
from book_core.contracts import ParsedDocument
from book_core.parser import FakeParser, ParserError
from book_core.structure import apply_edits
from pydantic import SecretStr
from qdrant_client import QdrantClient
from quiz_worker.adapters import (
    INDEX_FAILURE_MARKER,
    FailureInjectingEmbedder,
    FixtureParser,
    IndexingFailedError,
    build_embedder,
    build_parser,
)
from quiz_worker.celery_app import default_definitions
from quiz_worker.document_job import (
    JOB_TYPE,
    DocumentJobDeps,
    DocumentParsePayloadV1,
    Limits,
    document_parse_definition,
    index_sync_definition,
    parsed_object_key,
)
from quiz_worker.document_store import (
    INDEX_SYNC_JOB_TYPE,
    INDEX_SYNC_MAX_ATTEMPTS,
    DocumentRow,
    JobRow,
    RevisionRow,
)
from quiz_worker.envelope import JobEnvelope
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import EmbedderMode, Environment, ParserMode, WorkerSettings
from quiz_worker.storage import PARSED_BUCKET
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import FakeClock
from .document_fakes import PDF_DIR, FakeDocumentStore, FakeStorage, memory_index, points

BOOK = (PDF_DIR / "book-ko.pdf").read_bytes()
TRUTH = sorted(PDF_DIR.glob("*.truth.json"))


class CountingParser:
    def __init__(self, inner: FakeParser | None = None, *, fail: bool = False) -> None:
        self.inner = inner or FakeParser.from_truth_files(TRUTH)
        self.calls = 0
        self.fail = fail

    @property
    def parser_version(self) -> str:
        return self.inner.parser_version

    def parse(self, path: Any, *, source_path: str | None = None) -> ParsedDocument:
        self.calls += 1
        if self.fail:
            raise ParserError("synthetic parser failure quoting BOOK TEXT")
        return self.inner.parse(path, source_path=source_path)


class FlakyIndex:
    """Delegates to the real store; `crash_after_index` raises once after a complete write
    (a worker dying between indexing and publishing)."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.crash_after_index = False
        self.index_calls = 0
        # Raised by every activate_revision call while set (Qdrant down / worker killed).
        self.fail_activate: BaseException | None = None
        self.after_index: Callable[[], None] | None = None

    def index_revision(self, *args: Any, **kwargs: Any) -> Any:
        self.index_calls += 1
        report = self.inner.index_revision(*args, **kwargs)
        if self.after_index is not None:
            self.after_index()
        if self.crash_after_index:
            self.crash_after_index = False
            raise ConnectionError("worker lost")
        return report

    def activate_revision(self, *args: Any) -> None:
        if self.fail_activate is not None:
            raise self.fail_activate
        self.inner.activate_revision(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class WorkerKilled(BaseException):
    """Stands in for the process dying (not an Exception: nothing in the worker catches it)."""


class World:
    def __init__(self, *, max_pages: int = 100) -> None:
        self.store = FakeDocumentStore()
        self.storage = FakeStorage()
        index, self.client = memory_index()
        self.index = FlakyIndex(index)
        self.parser = CountingParser()
        self.deps = DocumentJobDeps(
            documents=self.store,
            storage=self.storage,
            index=self.index,
            parser=self.parser,
            limits=Limits(max_bytes=10_000_000, max_pages=max_pages, lock_wait_seconds=0),
        )
        self.clock = FakeClock()
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.store.job_source = self._job_row
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.definition = document_parse_definition(lambda: self.deps)
        self.sync_definition = index_sync_definition(lambda: self.deps)
        self.sync_envelopes: dict[uuid.UUID, JobEnvelope] = {}
        self.store.on_sync_enqueued = self._enqueue_sync

    def _enqueue_sync(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
        job_id: uuid.UUID,
    ) -> None:
        envelope = JobEnvelope(
            job_id=job_id,
            job_type=INDEX_SYNC_JOB_TYPE,
            schema_version=1,
            idempotency_key=f"index_sync:{revision_id}",
            workspace_id=workspace_id,
            created_by=user_id,
            payload={"document_id": str(document_id), "revision_id": str(revision_id)},
        )
        self.jobs.create(envelope, max_attempts=INDEX_SYNC_MAX_ATTEMPTS)
        self.sync_envelopes[revision_id] = envelope

    def run_sync(self, revision_id: uuid.UUID) -> Any:
        return self.runner.run(self.sync_definition, self.sync_envelopes[revision_id].to_message())

    def _job_row(self, job_id: uuid.UUID) -> JobRow | None:
        record = self.jobs.get(job_id)
        if record is None:
            return None
        return JobRow(dict(record.payload), record.status.value, record.last_error)

    def upload(self, data: bytes = BOOK, **kw: Any) -> tuple[DocumentRow, RevisionRow]:
        document, revision = self.store.add_document(data, **kw)
        self.storage.put_source(document, data)
        return document, revision

    def submit(self, document: DocumentRow, revision_id: uuid.UUID) -> JobEnvelope:
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"upload:{uuid.uuid4()}",
            workspace_id=document.workspace_id,
            created_by=uuid.uuid4(),
            payload={"document_id": str(document.id), "revision_id": str(revision_id)},
        )
        self.jobs.create(envelope, max_attempts=3)
        return envelope

    def run(self, envelope: JobEnvelope) -> Any:
        return self.runner.run(self.definition, envelope.to_message())

    def points(self, document: DocumentRow) -> list[dict[str, Any]]:
        return points(self.index.inner, self.client, document.id)


@pytest.fixture
def world() -> World:
    return World()


def test_parse_job_writes_content_indexes_and_publishes(world: World) -> None:
    document, revision = world.upload(document_type="question_paper", title="합성 교재")
    envelope = world.submit(document, revision.id)

    result = world.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert result.record.result["revision_id"] == str(revision.id)
    doc = world.store.documents[document.id]
    assert (doc.status, doc.active_revision_id) == ("ready", revision.id)
    rev = world.store.revisions[revision.id]
    assert rev.status == "published"
    assert rev.parsed_object_key == parsed_object_key(document, revision.id)
    assert (PARSED_BUCKET, rev.parsed_object_key) in world.storage.objects
    # Chapter tree and blocks of the fixture (book-ko: 6 sections, 23 canonical blocks).
    assert [c["title"] for c in world.store.chapters[revision.id]][:2] == [
        "1장 물의 순환",
        "1.1 증발과 응결",
    ]
    assert len(world.store.blocks[revision.id]) == 23
    # Every point carries the tenant/document/revision payload and is active.
    stored = world.points(document)
    content = world.store.load_content(document, rev)
    assert len(stored) == len(chunk_revision(content, document_title="합성 교재").chunks)
    assert {p["workspace_id"] for p in stored} == {str(document.workspace_id)}
    assert {p["revision_id"] for p in stored} == {str(revision.id)}
    assert {p["document_type"] for p in stored} == {"question_paper"}
    assert {p["active"] for p in stored} == {True}
    stages = [stage for stage, _ in world.store.progress]
    assert stages == ["downloading", "parsing", "structuring", "chunking", "indexing", "publishing"]
    percents = [p for _, p in world.store.progress]
    assert percents == sorted(percents)


def test_redelivery_after_success_changes_nothing(world: World) -> None:
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    world.run(envelope)
    before = (world.store.writes, world.parser.calls, len(world.points(document)))

    again = world.run(envelope)

    assert again.outcome is RunOutcome.DUPLICATE_FINISHED
    assert (world.store.writes, world.parser.calls, len(world.points(document))) == before


def test_retry_after_a_crash_resumes_without_duplicates(world: World) -> None:
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    world.index.crash_after_index = True

    first = world.run(envelope)
    assert first.outcome is RunOutcome.RETRY
    # Nothing is live yet: the document is still processing, its points inactive.
    assert world.store.documents[document.id].status == "processing"
    assert {p["active"] for p in world.points(document)} == {False}
    count = len(world.points(document))

    second = world.run(envelope)

    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    # Content was parsed and written once; the retry read it back from the store.
    assert (world.parser.calls, world.store.writes) == (1, 1)
    assert len(world.points(document)) == count
    assert world.store.documents[document.id].status == "ready"


def test_rerun_of_a_published_revision_only_finishes_the_index(world: World) -> None:
    document, revision = world.upload()
    world.run(world.submit(document, revision.id))
    calls = world.index.index_calls

    second = world.run(world.submit(document, revision.id))

    assert second.outcome is RunOutcome.SUCCEEDED
    assert world.index.index_calls == calls


def _ready_with_failing_draft(world: World) -> tuple[DocumentRow, RevisionRow, RevisionRow]:
    document, first = world.upload()
    world.run(world.submit(document, first.id))
    base = world.store.load_content(document, world.store.revisions[first.id])
    target = next(b for b in base.blocks if b.type.value == "text")
    draft = apply_edits(
        base,
        {target.id: f"{INDEX_FAILURE_MARKER} 교정된 문단"},
        revision_id=str(uuid.uuid4()),
    )
    second = world.store.add_draft(document.id, draft)
    return world.store.documents[document.id], first, second


def test_failed_reindex_keeps_the_previous_revision_active(world: World) -> None:
    document, first, second = _ready_with_failing_draft(world)
    live = world.points(document)

    result = world.run(world.submit(document, second.id))

    assert result.outcome is RunOutcome.FAILED
    assert result.error
    assert result.error.startswith("indexing_failed")
    doc = world.store.documents[document.id]
    assert (doc.status, doc.active_revision_id) == ("ready", first.id)
    assert world.store.revisions[second.id].status == "draft"
    assert (world.store.last_errors[document.id] or "").startswith("indexing_failed")
    # The cleanup obligation removed the draft's partial points; the live revision is intact.
    assert world.points(document) == live
    assert {p["revision_id"] for p in live} == {str(first.id)}
    assert all(INDEX_FAILURE_MARKER not in p["content"] for p in live)


def test_first_parse_failure_marks_the_document_failed(world: World) -> None:
    world.parser.fail = True
    document, revision = world.upload()

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert result.error == "parse_failed: the PDF could not be parsed"
    assert "BOOK TEXT" not in (result.error or "")
    assert world.store.documents[document.id].status == "failed"
    assert world.store.last_errors[document.id] == result.error
    assert world.points(document) == []


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda w, d: w.storage.objects.clear(), "source_missing"),
        (lambda w, d: w.storage.put_source(d, BOOK + b"x"), "source_too_large"),
        (lambda w, d: w.storage.put_source(d, BOOK[:-1] + b"\0"), "source_invalid"),
    ],
)
def test_source_problems_fail_without_retry(
    world: World, mutate: Callable[[World, DocumentRow], None], code: str
) -> None:
    document, revision = world.upload()
    mutate(world, document)

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith(code)
    assert world.parser.calls == 0


def test_non_pdf_and_page_limits_are_enforced() -> None:
    text_world = World()
    document, revision = text_world.upload(b"plain text, not a pdf")
    assert (text_world.run(text_world.submit(document, revision.id)).error or "").startswith(
        "source_invalid"
    )

    small = World(max_pages=2)
    document, revision = small.upload()
    result = small.run(small.submit(document, revision.id))
    assert (result.error or "").startswith("too_many_pages")
    assert small.parser.calls == 0


def test_busy_document_is_retried(world: World) -> None:
    document, revision = world.upload()
    world.store.busy = True

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.RETRY
    assert (result.error or "").startswith("document_busy")


def test_foreign_workspace_payload_is_not_found(world: World) -> None:
    document, revision = world.upload()
    other, _ = world.upload()
    # The envelope's workspace is the other document's: the lookup is scoped to it.
    envelope = world.submit(other, revision.id)
    envelope = envelope.model_copy(
        update={"payload": {"document_id": str(document.id), "revision_id": str(revision.id)}}
    )
    world.jobs.create(envelope.model_copy(update={"job_id": uuid.uuid4()}), max_attempts=3)

    result = world.run(world.submit(other, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("document_not_found")
    assert world.store.documents[document.id].active_revision_id is None


def test_cancelled_job_cleanup_removes_partial_index(world: World) -> None:
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    world.index.crash_after_index = True
    world.run(envelope)  # retry pending: points written, nothing published
    assert world.points(document)
    world.jobs.request_cancel(envelope.job_id)

    result = world.run(envelope)

    assert result.outcome is RunOutcome.CANCELLED
    record = world.jobs.get(envelope.job_id)
    assert record is not None
    assert record.status is JobStatus.CANCELLED
    assert not record.cleanup_pending
    assert world.points(document) == []
    assert world.store.documents[document.id].status == "failed"
    assert world.store.last_errors[document.id] == "cancelled"


def test_payload_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError, match="extra"):
        DocumentParsePayloadV1.model_validate(
            {"document_id": str(uuid.uuid4()), "revision_id": str(uuid.uuid4()), "x": 1}
        )


# -- adapters / settings ---------------------------------------------------------------------


def test_failure_injecting_embedder_refuses_only_marked_text() -> None:
    from book_core.embedding import FakeEmbedder

    embedder = FailureInjectingEmbedder(FakeEmbedder())
    assert len(embedder.embed_documents(["fine"])) == 1
    with pytest.raises(IndexingFailedError):
        embedder.embed_documents(["fine", f"x {INDEX_FAILURE_MARKER} y"])
    assert embedder.model_name == FakeEmbedder().model_name


def _settings(**values: Any) -> WorkerSettings:
    return WorkerSettings.model_validate(values)


def test_test_environment_uses_fixture_parser_and_marker_aware_fake_embedder() -> None:
    settings = _settings(APP_ENV="test")
    parser = build_parser(settings)
    assert isinstance(parser, FixtureParser)
    embedder = build_embedder(settings)
    assert isinstance(embedder, FailureInjectingEmbedder)
    assert embedder.model_name == "fake-embedder"


def test_production_never_injects_failures_or_uses_fakes() -> None:
    settings = _settings(APP_ENV="local", WORKER_EMBEDDER="fake", WORKER_PARSER="fake")
    assert not isinstance(build_embedder(settings), FailureInjectingEmbedder)
    for env in ("preview", "production"):
        with pytest.raises(ValueError, match="fake"):
            _settings(APP_ENV=env, WORKER_EMBEDDER="fake", WORKER_DATABASE_URL="postgresql://x")
        with pytest.raises(ValueError, match="fake"):
            _settings(APP_ENV=env, WORKER_PARSER="fake", WORKER_DATABASE_URL="postgresql://x")
    production = WorkerSettings.model_construct(
        app_env=Environment.PRODUCTION, parser=ParserMode.AUTO, embedder=EmbedderMode.AUTO
    )
    assert type(build_parser(production)).__name__ == "LazyDoclingParser"


def test_document_parse_is_registered_and_unconfigured_runs_fail_cleanly() -> None:
    settings = WorkerSettings.model_construct(
        app_env=Environment.TEST,
        worker_database_url=None,
        supabase_url=None,
        supabase_secret_key=SecretStr(""),
    )
    definitions = {d.job_type: d for d in default_definitions(settings)}
    assert JOB_TYPE in definitions
    jobs = InMemoryJobStore()
    envelope = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key=None,
        workspace_id=uuid.uuid4(),
        created_by=None,
        payload={"document_id": str(uuid.uuid4()), "revision_id": str(uuid.uuid4())},
    )
    jobs.create(envelope, max_attempts=3)
    result = JobRunner(jobs, worker_id="unit", lease_seconds=60).run(
        definitions[JOB_TYPE], envelope.to_message()
    )
    assert result.outcome is RunOutcome.FAILED
    assert result.error == "worker_not_configured: WORKER_DATABASE_URL is not set"


def test_memory_qdrant_is_isolated_per_world() -> None:
    a, b = World(), World()
    document, revision = a.upload()
    a.run(a.submit(document, revision.id))
    assert isinstance(b.client, QdrantClient)
    assert points(b.index.inner, b.client, document.id) == []


# -- workspace access (review P1) ---------------------------------------------------------------


def test_archived_or_revoked_before_start_fails_without_work(world: World) -> None:
    document, revision = world.upload()
    world.store.writable = lambda _w, _u: False

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert result.error == "workspace_unavailable: the workspace is no longer writable"
    assert world.parser.calls == 0
    assert world.storage.downloads == 0
    assert world.store.revisions[revision.id].status == "draft"
    assert world.store.documents[document.id].status == "failed"
    assert world.points(document) == []


def test_access_lost_during_indexing_never_publishes_and_cleans_the_draft(world: World) -> None:
    document, revision = world.upload()
    # Archive / delete / membership revocation lands while the draft is being indexed.
    world.index.after_index = lambda: setattr(world.store, "writable", lambda _w, _u: False)

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("workspace_unavailable")
    assert world.store.revisions[revision.id].status == "draft"
    doc = world.store.documents[document.id]
    assert (doc.status, doc.active_revision_id) == ("failed", None)
    assert world.store.sync_jobs == {}
    # Cleanup obligation: the draft's points are gone.
    assert world.points(document) == []


def test_access_is_checked_for_the_jobs_creator(world: World) -> None:
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    seen: list[tuple[uuid.UUID, uuid.UUID | None]] = []

    def writable(ws: uuid.UUID, user: uuid.UUID | None) -> bool:
        seen.append((ws, user))
        return True

    world.store.writable = writable
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    # Before starting and again inside the publish transaction.
    assert seen == [(document.workspace_id, envelope.created_by)] * 2


# -- index sync after publish (review P2) -------------------------------------------------------


def test_inline_sync_resolves_the_obligation(world: World) -> None:
    document, revision = world.upload()

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.SUCCEEDED
    assert "index_sync" not in result.record.result
    sync_id = world.store.sync_jobs[revision.id]
    assert world.store.sync_status[sync_id] == "resolved"


def test_activation_failing_after_publish_still_succeeds_and_the_obligation_syncs(
    world: World,
) -> None:
    document, revision = world.upload()
    world.index.fail_activate = ConnectionError("qdrant down")

    result = world.run(world.submit(document, revision.id))

    # The DB switch committed: the job succeeded, with the mirror pending.
    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert result.record.result["index_sync"] == "pending"
    doc = world.store.documents[document.id]
    assert (doc.status, doc.active_revision_id) == ("ready", revision.id)
    assert {p["active"] for p in world.points(document)} == {False}
    assert world.store.sync_status[world.store.sync_jobs[revision.id]] == "queued"

    # The obligation retries while Qdrant is still down ...
    assert world.run_sync(revision.id).outcome is RunOutcome.RETRY
    # ... and syncs once it is back.
    world.index.fail_activate = None
    world.clock.advance(3600)
    synced = world.run_sync(revision.id)
    assert synced.outcome is RunOutcome.SUCCEEDED, synced.error
    assert synced.record.result["synced"] is True
    assert {p["active"] for p in world.points(document)} == {True}


def test_worker_death_right_after_publish_is_recovered(world: World) -> None:
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    world.index.fail_activate = WorkerKilled()

    with pytest.raises(WorkerKilled):
        world.run(envelope)

    # Committed in the DB, obligation durable, Qdrant not switched yet.
    assert world.store.documents[document.id].active_revision_id == revision.id
    assert world.store.sync_status[world.store.sync_jobs[revision.id]] == "queued"
    assert {p["active"] for p in world.points(document)} == {False}

    world.index.fail_activate = None
    # Either the obligation (handed to the broker by the reconciler) ...
    assert world.run_sync(revision.id).outcome is RunOutcome.SUCCEEDED
    assert {p["active"] for p in world.points(document)} == {True}
    # ... or the parse job's own redelivery after its lease ran out finishes cleanly.
    world.clock.advance(120)
    again = world.run(envelope)
    assert again.outcome is RunOutcome.SUCCEEDED, again.error
    assert world.parser.calls == 1


def test_sync_of_a_superseded_revision_does_nothing(world: World) -> None:
    document, revision = world.upload()
    world.index.fail_activate = ConnectionError("qdrant down")
    assert world.run(world.submit(document, revision.id)).outcome is RunOutcome.SUCCEEDED
    world.index.fail_activate = None
    # Another revision became active before the obligation ran: its own obligation owns the
    # mirror, so this one must not re-activate the old revision.
    world.store.documents[document.id] = dataclasses.replace(
        world.store.documents[document.id], active_revision_id=uuid.uuid4()
    )

    result = world.run_sync(revision.id)

    assert result.outcome is RunOutcome.SUCCEEDED
    assert result.record.result == {"skipped": "not_active"}
    assert {p["active"] for p in world.points(document)} == {False}


class ColdParser(CountingParser):
    """A parser whose models load on `prepare` (a cold Docling, UX3-JOB)."""

    def __init__(self, *, fail_prepare: bool = False) -> None:
        super().__init__()
        self.prepared = False
        self.prepare_calls = 0
        self.fail_prepare = fail_prepare

    def prepare(self) -> None:
        self.prepare_calls += 1
        if self.fail_prepare:
            raise OSError("model weights not found")
        self.prepared = True


def test_doc_01_ac05_cold_parser_reports_the_preparing_stage_first(world: World) -> None:
    parser = ColdParser()
    world.deps.parser = parser
    document, revision = world.upload()

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert parser.prepare_calls == 1
    stages = [stage for stage, _ in world.store.progress]
    assert stages[:3] == ["preparing", "downloading", "parsing"]
    percents = [p for _, p in world.store.progress]
    assert percents == sorted(percents)

    # A warm parser (warmed up at worker start or by this job) skips the stage.
    world.store.progress.clear()
    other, other_revision = world.upload(BOOK + b"\n%warm\n")
    world.run(world.submit(other, other_revision.id))
    assert "preparing" not in [stage for stage, _ in world.store.progress]
    assert parser.prepare_calls == 1


def test_doc_01_ac05_retry_from_stored_content_needs_no_parser(world: World) -> None:
    """A draft that already has content is not parsed again, so no models are loaded."""
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)
    world.index.crash_after_index = True
    assert world.run(envelope).outcome is RunOutcome.RETRY
    parser = ColdParser()
    world.deps.parser = parser
    world.store.progress.clear()

    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    assert parser.prepare_calls == 0
    assert "preparing" not in [stage for stage, _ in world.store.progress]


def test_doc_01_ac05_warm_up_prepares_the_shared_parser_and_never_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from quiz_worker import document_job

    cold = ColdParser()
    monkeypatch.setattr(document_job, "build_parser", lambda settings: cold)
    deps = document_job.LazyDeps(_settings(APP_ENV="test"))
    assert deps.warm_up() is True
    assert (cold.prepared, cold.prepare_calls) == (True, 1)
    assert deps.parser() is cold
    assert deps.warm_up() is True
    assert cold.prepare_calls == 1

    broken = ColdParser(fail_prepare=True)
    monkeypatch.setattr(document_job, "build_parser", lambda settings: broken)
    assert document_job.LazyDeps(_settings(APP_ENV="test")).warm_up() is False


@pytest.mark.parametrize(
    ("env", "parser", "override", "expected"),
    [
        (Environment.TEST, ParserMode.AUTO, None, False),
        (Environment.LOCAL, ParserMode.AUTO, None, False),
        (Environment.PRODUCTION, ParserMode.AUTO, None, True),
        (Environment.PREVIEW, ParserMode.DOCLING, None, True),
        (Environment.PRODUCTION, ParserMode.AUTO, False, False),
        (Environment.LOCAL, ParserMode.AUTO, True, True),
    ],
)
def test_doc_01_ac05_parser_warm_up_is_opt_in_outside_deployments(
    env: Environment, parser: ParserMode, override: bool | None, expected: bool
) -> None:
    from quiz_worker.celery_app import install_parser_warm_up
    from quiz_worker.document_job import LazyDeps

    values: dict[str, Any] = {"APP_ENV": env.value, "WORKER_PARSER": parser.value}
    if override is not None:
        values["WORKER_WARM_PARSER"] = override
    settings = (
        _settings(**values)
        if env not in {Environment.PREVIEW, Environment.PRODUCTION}
        else WorkerSettings.model_construct(app_env=env, parser=parser, warm_parser=override)
    )
    assert settings.warms_parser is expected
    from celery import signals
    from quiz_worker.celery_app import PARSER_WARM_UP_UID

    try:
        assert install_parser_warm_up(settings, LazyDeps(settings)) is expected
    finally:
        signals.worker_process_init.disconnect(dispatch_uid=PARSER_WARM_UP_UID)
