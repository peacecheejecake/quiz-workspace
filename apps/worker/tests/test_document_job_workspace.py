"""Review fixes of M3.2b against Postgres (as `quiz_worker`): workspace access is re-checked
before a document job starts and under a lock inside the publish transaction (P1), and the Qdrant
mirror of a committed publish is a durable `document.index_sync` obligation (P2).

Storage is the in-memory fake and Qdrant runs in local mode; everything that decides access or
publishes runs the real SQL (supabase/migrations/20261017230000_worker_workspace_access.sql).
`QUIZ_TEST_ADMIN_DATABASE_URL` points the suite at another database (e.g. a throwaway one).
"""

from __future__ import annotations

import hashlib
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from book_core.parser import FakeParser
from quiz_worker.document_job import (
    JOB_TYPE,
    DocumentJobDeps,
    Limits,
    document_parse_definition,
    index_sync_definition,
)
from quiz_worker.document_store import INDEX_SYNC_JOB_TYPE, PostgresDocumentStore
from quiz_worker.envelope import JobEnvelope
from quiz_worker.pg_store import PostgresJobStore
from quiz_worker.runner import JobRunner, RunOutcome, RunResult
from sqlalchemy import text

from .conftest import PgEngines, PgTenancy
from .document_fakes import PDF_DIR, FakeStorage, memory_index, points

pytestmark = pytest.mark.infra

BOOK = (PDF_DIR / "book-ko.pdf").read_bytes()


class WorkerKilled(BaseException):
    """The worker process dying (nothing in the worker catches a BaseException)."""


class Index:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.after_index: Any = None
        self.fail_activate: BaseException | None = None

    def index_revision(self, *args: Any, **kwargs: Any) -> Any:
        report = self.inner.index_revision(*args, **kwargs)
        if self.after_index is not None:
            self.after_index()
        return report

    def activate_revision(self, *args: Any) -> None:
        if self.fail_activate is not None:
            raise self.fail_activate
        self.inner.activate_revision(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


@dataclass
class Setup:
    engines: PgEngines
    tenancy: PgTenancy
    jobs: PostgresJobStore
    runner: JobRunner
    index: Index
    client: Any
    deps: DocumentJobDeps
    storage: FakeStorage

    def admin(self, sql: str, **params: Any) -> list[Any]:
        with self.engines.admin.begin() as conn:
            result = conn.execute(text(sql), params)
            return list(result) if result.returns_rows else []

    def upload(self, document_type: str = "book") -> tuple[uuid.UUID, uuid.UUID, JobEnvelope]:
        ws = self.tenancy.workspace_id
        doc, rev = uuid.uuid4(), uuid.uuid4()
        key = f"workspaces/{ws}/documents/{doc}/revisions/{rev}/source.pdf"
        self.admin(
            "insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256, "
            "source_object_key, created_by, document_type) "
            "values (:d, :w, 'Book', 'book.pdf', :n, :h, :k, :u, :t)",
            d=doc,
            t=document_type,
            w=ws,
            n=len(BOOK),
            h=hashlib.sha256(BOOK).hexdigest(),
            k=key,
            u=self.tenancy.user_id,
        )
        self.admin(
            "insert into public.document_revisions (id, workspace_id, document_id, "
            "revision_number, source_object_key, created_by) values (:r, :w, :d, 1, :k, :u)",
            r=rev,
            w=ws,
            d=doc,
            k=key,
            u=self.tenancy.user_id,
        )
        self.storage.objects[("source-pdfs", key)] = BOOK
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"upload:{uuid.uuid4()}",
            workspace_id=ws,
            created_by=self.tenancy.user_id,
            payload={"document_id": str(doc), "revision_id": str(rev)},
        )
        self.jobs.create(envelope, max_attempts=3)
        return doc, rev, envelope

    def run(self, envelope: JobEnvelope) -> RunResult:
        return self.runner.run(document_parse_definition(lambda: self.deps), envelope.to_message())

    def document(self, doc: uuid.UUID) -> Any:
        return self.admin(
            "select d.status, d.active_revision_id, d.last_error, r.status as revision_status "
            "from public.documents d join public.document_revisions r on r.document_id = d.id "
            "where d.id = :d order by r.revision_number desc limit 1",
            d=doc,
        )[0]

    def sync_rows(self, rev: uuid.UUID) -> list[Any]:
        return self.admin(
            "select id, status, published_at, attempts, max_attempts, result, created_by "
            "from public.async_jobs where workspace_id = :w and job_type = :t "
            "and idempotency_key = :k",
            w=self.tenancy.workspace_id,
            t=INDEX_SYNC_JOB_TYPE,
            k=f"index_sync:{rev}",
        )

    def run_sync(self, job_id: uuid.UUID) -> RunResult:
        record = self.jobs.get(job_id)
        assert record is not None
        return self.runner.run(
            index_sync_definition(lambda: self.deps), record.to_envelope().to_message()
        )

    def points(self, doc: uuid.UUID) -> list[dict[str, Any]]:
        return points(self.index.inner, self.client, doc)


@pytest.fixture
def setup(pg_engines: PgEngines, pg_tenancy: PgTenancy) -> Setup:
    with pg_engines.admin.begin() as conn:
        conn.execute(
            text(
                "insert into public.workspace_memberships (workspace_id, user_id, role) "
                "values (:w, :u, 'owner')"
            ),
            {"w": pg_tenancy.workspace_id, "u": pg_tenancy.user_id},
        )
    inner, client = memory_index("ws_")
    index = Index(inner)
    storage = FakeStorage()
    jobs = pg_tenancy.store(pg_engines.worker, None)
    deps = DocumentJobDeps(
        documents=PostgresDocumentStore(pg_engines.worker),
        storage=storage,
        index=index,
        parser=FakeParser.from_truth_files(sorted(PDF_DIR.glob("*.truth.json"))),
        limits=Limits(lock_wait_seconds=5),
    )
    return Setup(
        engines=pg_engines,
        tenancy=pg_tenancy,
        jobs=jobs,
        runner=JobRunner(jobs, worker_id="ws-test", lease_seconds=600),
        index=index,
        client=client,
        deps=deps,
        storage=storage,
    )


# -- P1: workspace access ------------------------------------------------------------------------


def test_success_resolves_the_index_sync_obligation_inline(setup: Setup) -> None:
    doc, rev, envelope = setup.upload()

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert setup.document(doc).active_revision_id == rev
    [sync] = setup.sync_rows(rev)
    assert (sync.status, sync.attempts, sync.result) == (
        "succeeded",
        0,
        {"synced_by": "publishing_job"},
    )
    assert sync.created_by == setup.tenancy.user_id
    assert {p["active"] for p in setup.points(doc)} == {True}


@pytest.mark.parametrize(
    "change",
    [
        "update public.workspaces set status = 'archived', archived_at = now() where id = :w",
        "update public.workspaces set status = 'deleted', deleted_at = now() where id = :w",
        "delete from public.workspace_memberships where workspace_id = :w and user_id = :u",
        "update public.workspace_memberships set role = 'viewer' "
        "where workspace_id = :w and user_id = :u",
    ],
    ids=["archived", "deleted", "membership-revoked", "downgraded-to-viewer"],
)
def test_workspace_lost_before_start_fails_without_work(setup: Setup, change: str) -> None:
    doc, rev, envelope = setup.upload()
    setup.admin(change, w=setup.tenancy.workspace_id, u=setup.tenancy.user_id)

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert result.error == "workspace_unavailable: the workspace is no longer writable"
    assert setup.storage.downloads == 0
    state = setup.document(doc)
    assert (state.status, state.active_revision_id, state.revision_status) == (
        "failed",
        None,
        "draft",
    )
    assert setup.points(doc) == []
    assert setup.sync_rows(rev) == []


@pytest.mark.parametrize(
    "change",
    [
        "update public.workspaces set status = 'deleted', deleted_at = now() where id = :w",
        "delete from public.workspace_memberships where workspace_id = :w and user_id = :u",
    ],
    ids=["deleted-while-indexing", "revoked-while-indexing"],
)
def test_workspace_lost_during_indexing_never_publishes(setup: Setup, change: str) -> None:
    doc, rev, envelope = setup.upload()
    setup.index.after_index = lambda: setup.admin(
        change, w=setup.tenancy.workspace_id, u=setup.tenancy.user_id
    )

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("workspace_unavailable")
    state = setup.document(doc)
    assert (state.active_revision_id, state.revision_status) == (None, "draft")
    assert setup.sync_rows(rev) == []
    # The cleanup obligation removed the draft's points.
    assert setup.points(doc) == []
    cleanup = setup.admin(
        "select cleanup_pending from public.async_jobs where id = :j", j=envelope.job_id
    )
    assert cleanup == [(False,)]


def test_publish_serialises_with_a_concurrent_archive(setup: Setup) -> None:
    """The API archives with FOR NO KEY UPDATE on the workspace row; the publish transaction's
    FOR SHARE waits for it and then sees the archived workspace."""
    doc, _rev, envelope = setup.upload()
    ws = setup.tenancy.workspace_id
    locked = threading.Event()

    def archive_concurrently() -> None:
        with setup.engines.admin.begin() as conn:
            conn.execute(
                text("select 1 from public.workspaces where id = :w for no key update"), {"w": ws}
            )
            locked.set()
            time.sleep(1.0)  # the worker's publish is blocked on the row meanwhile
            conn.execute(
                text(
                    "update public.workspaces set status = 'archived', archived_at = now() "
                    "where id = :w"
                ),
                {"w": ws},
            )

    archiver = threading.Thread(target=archive_concurrently)

    def start_archive() -> None:
        archiver.start()
        assert locked.wait(5)

    setup.index.after_index = start_archive

    started = time.monotonic()
    result = setup.run(envelope)
    archiver.join(5)

    assert time.monotonic() - started >= 0.9, "publish must wait for the archive to commit"
    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("workspace_unavailable")
    assert setup.document(doc).active_revision_id is None


# -- P2: index sync after the publish commit -----------------------------------------------------


def test_activation_failing_after_commit_succeeds_and_the_obligation_syncs(setup: Setup) -> None:
    doc, rev, envelope = setup.upload()
    setup.index.fail_activate = ConnectionError("qdrant down")

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert result.record is not None
    assert result.record.result is not None
    assert result.record.result["index_sync"] == "pending"
    state = setup.document(doc)
    assert (state.status, state.active_revision_id) == ("ready", rev)
    [sync] = setup.sync_rows(rev)
    assert (sync.status, sync.published_at, sync.max_attempts) == ("queued", None, 8)
    assert {p["active"] for p in setup.points(doc)} == {False}

    # Qdrant still down: the obligation retries (backoff), it does not fail.
    retry = setup.run_sync(sync.id)
    assert retry.outcome is RunOutcome.RETRY
    setup.index.fail_activate = None
    # The retry countdown is a broker delay; redeliver right away here.
    synced = setup.run_sync(sync.id)
    assert synced.outcome is RunOutcome.SUCCEEDED, synced.error
    assert {p["active"] for p in setup.points(doc)} == {True}


def test_worker_death_right_after_commit_is_recovered_by_the_reconciler(setup: Setup) -> None:
    doc, rev, envelope = setup.upload()
    setup.index.fail_activate = WorkerKilled()

    with pytest.raises(WorkerKilled):
        setup.run(envelope)
    setup.index.fail_activate = None

    [sync] = setup.sync_rows(rev)
    assert sync.status == "queued"
    # The reconciler publishes queued rows nobody handed to the broker.
    candidates = setup.jobs.find_republish_candidates(
        unpublished_grace_seconds=0, stale_after_seconds=3600, limit=50
    )
    assert sync.id in {c.job_id for c in candidates}

    synced = setup.run_sync(sync.id)

    assert synced.outcome is RunOutcome.SUCCEEDED, synced.error
    assert setup.document(doc).active_revision_id == rev
    assert {p["active"] for p in setup.points(doc)} == {True}


# -- QIMP-AUTO: the publish of a question paper starts its import (20261021120000) ---------------


def _import_runs(setup: Setup, doc: uuid.UUID) -> list[Any]:
    return setup.admin(
        "select r.id, r.workspace_id, r.created_by, r.source_document_revision_id, r.status, "
        "r.started_by, j.id as job_id, j.job_type, j.created_by as job_created_by, "
        "j.idempotency_key, j.payload, j.status as job_status, j.published_at "
        "from public.question_import_runs r join public.async_jobs j on j.id = r.async_job_id "
        "where r.source_document_id = :d",
        d=doc,
    )


def test_qimport_01_ac06_a_processed_question_paper_starts_exactly_one_import(
    setup: Setup,
) -> None:
    doc, rev, envelope = setup.upload("question_paper")

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    [run] = _import_runs(setup, doc)
    assert (run.workspace_id, run.created_by, run.job_created_by) == (
        setup.tenancy.workspace_id,
        setup.tenancy.user_id,
        setup.tenancy.user_id,
    )
    assert (run.source_document_revision_id, run.status, run.started_by) == (
        rev,
        "queued",
        "system",
    )
    assert (run.job_type, run.idempotency_key, run.payload) == (
        "question.import",
        f"question_import:{run.id}:1",
        {"import_id": str(run.id)},
    )
    # Unpublished: the Celery task hands it to the broker once the parse job is done.
    assert (run.job_status, run.published_at) == ("queued", None)
    assert result.record is not None
    assert result.record.result is not None
    assert result.record.result["question_import_id"] == str(run.id)
    assert result.record.result["question_import_job_id"] == str(run.job_id)
    [event] = setup.admin(
        "select actor_id, metadata from public.activity_events "
        "where target_id = :r and event_type = 'question_import.started'",
        r=run.id,
    )
    assert event == (setup.tenancy.user_id, {"started_by": "system"})


def test_qimport_01_ac06_reruns_and_redeliveries_start_no_second_import(setup: Setup) -> None:
    doc, rev, envelope = setup.upload("question_paper")
    assert setup.run(envelope).outcome is RunOutcome.SUCCEEDED
    [run] = _import_runs(setup, doc)

    assert setup.run(envelope).outcome is RunOutcome.DUPLICATE_FINISHED
    rerun = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key=f"upload:{uuid.uuid4()}",
        workspace_id=setup.tenancy.workspace_id,
        created_by=setup.tenancy.user_id,
        payload={"document_id": str(doc), "revision_id": str(rev)},
    )
    setup.jobs.create(rerun, max_attempts=3)
    assert setup.run(rerun).outcome is RunOutcome.SUCCEEDED

    assert [r.id for r in _import_runs(setup, doc)] == [run.id]


def test_qimport_01_ac06_worker_death_after_the_publish_leaves_one_import_for_the_reconciler(
    setup: Setup,
) -> None:
    """The worker dies right after the publish committed: the import it started exists exactly
    once, unpublished, and is a reconciler candidate; a later attempt starts nothing more."""
    doc, rev, envelope = setup.upload("question_paper")
    setup.index.fail_activate = WorkerKilled()
    with pytest.raises(WorkerKilled):
        setup.run(envelope)
    setup.index.fail_activate = None

    [run] = _import_runs(setup, doc)
    candidates = setup.jobs.find_republish_candidates(
        unpublished_grace_seconds=0, stale_after_seconds=3600, limit=50
    )
    assert run.job_id in {c.job_id for c in candidates}
    again = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key=f"upload:{uuid.uuid4()}",
        workspace_id=setup.tenancy.workspace_id,
        created_by=setup.tenancy.user_id,
        payload={"document_id": str(doc), "revision_id": str(rev)},
    )
    setup.jobs.create(again, max_attempts=3)
    assert setup.run(again).outcome is RunOutcome.SUCCEEDED
    assert [r.id for r in _import_runs(setup, doc)] == [run.id]


def test_qimport_01_ac06_books_start_no_import(setup: Setup) -> None:
    doc, _, envelope = setup.upload()

    assert setup.run(envelope).outcome is RunOutcome.SUCCEEDED
    assert _import_runs(setup, doc) == []


def test_qimport_01_ac06_failed_or_archived_question_papers_start_no_import(setup: Setup) -> None:
    doc, _, envelope = setup.upload("question_paper")
    setup.admin(
        "update public.workspaces set status = 'archived', archived_at = now() where id = :w",
        w=setup.tenancy.workspace_id,
    )

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert _import_runs(setup, doc) == []


def test_qimport_01_ac06_an_archive_during_indexing_starts_no_import(setup: Setup) -> None:
    doc, _, envelope = setup.upload("question_paper")
    setup.index.after_index = lambda: setup.admin(
        "update public.workspaces set status = 'archived', archived_at = now() where id = :w",
        w=setup.tenancy.workspace_id,
    )

    result = setup.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("workspace_unavailable")
    assert _import_runs(setup, doc) == []
