"""`workspace.fork` with fakes (no DB or Storage; Qdrant in local mode).

The same flow against the real stack (API request, `worker_fork_commit` as quiz_worker, Supabase
Storage, Qdrant) is in tests/integration/sharing/test_fork_worker.py and
test_fork_api_contract.py; the commit's SQL is covered by supabase/tests/12_workspace_forks.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from book_core.chunker import chunk_revision
from book_core.parser import FakeParser
from book_core.structure import build_revision
from quiz_worker.celery_app import default_definitions
from quiz_worker.document_store import DocumentRow, JobRow, RevisionRow
from quiz_worker.envelope import JobEnvelope
from quiz_worker.errors import JobError
from quiz_worker.fork_job import (
    FAILURE_MARKER,
    JOB_TYPE,
    PAUSE_MARKER,
    ForkJobDeps,
    target_content,
    workspace_fork_definition,
)
from quiz_worker.fork_store import CommitOutcome, ForkDocument, ForkRow, ForkStatus
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import PARSED_BUCKET, SOURCE_BUCKET, ObjectMissingError
from quiz_worker.store import InMemoryJobStore

from .conftest import FakeClock
from .document_fakes import PDF_DIR, FakeDocumentStore, FakeStorage, memory_index, points

BOOK = (PDF_DIR / "book-ko.pdf").read_bytes()
TRUTH = sorted(PDF_DIR.glob("*.truth.json"))
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}


@dataclass
class FakeForks:
    rows: dict[uuid.UUID, ForkRow] = field(default_factory=dict)
    plans: dict[uuid.UUID, list[ForkDocument]] = field(default_factory=dict)
    errors: dict[uuid.UUID, str | None] = field(default_factory=dict)
    progress: list[int] = field(default_factory=list)
    usable: bool = True
    # Called on every usability check (e.g. to revoke the link mid-copy).
    on_check: Callable[[], None] | None = None
    commits: int = 0
    # Writes the committed copy into the document store (what worker_fork_commit does in SQL).
    on_commit: Callable[[list[ForkDocument]], None] | None = None

    def get(self, fork_id: uuid.UUID) -> ForkRow | None:
        return self.rows.get(fork_id)

    def documents(self, fork_id: uuid.UUID) -> list[ForkDocument]:
        return list(self.plans.get(fork_id, []))

    def source_usable(self, fork_id: uuid.UUID) -> bool:
        if self.on_check is not None:
            self.on_check()
        row = self.rows.get(fork_id)
        return row is not None and row.status in ("PENDING", "COPYING") and self.usable

    def mark(
        self,
        fork_id: uuid.UUID,
        status: ForkStatus,
        *,
        progress: int | None = None,
        error: str | None = None,
    ) -> bool:
        row = self.rows[fork_id]
        if row.status in TERMINAL:
            return False
        self.rows[fork_id] = dataclasses.replace(row, status=status)
        if progress is not None:
            self.progress.append(progress)
        if error is not None:
            self.errors[fork_id] = error
        return True

    def commit(self, fork_id: uuid.UUID) -> CommitOutcome:
        row = self.rows[fork_id]
        if row.status == "COMPLETED":
            return "completed"
        if row.status in TERMINAL:
            return "cancelled" if row.status == "CANCELLED" else "failed"
        if not self.usable:
            return "unusable"
        self.commits += 1
        target = self.plans[fork_id][0].target_workspace_id if self.plans[fork_id] else None
        self.rows[fork_id] = dataclasses.replace(
            row, status="COMPLETED", target_workspace_id=target or uuid.uuid4()
        )
        if self.on_commit is not None:
            self.on_commit(self.plans[fork_id])
        return "completed"


@dataclass
class FakeCopier:
    storage: FakeStorage
    copies: list[tuple[str, str, str]] = field(default_factory=list)
    fail_next: BaseException | None = None

    def copy(self, bucket: str, source_key: str, dest_key: str) -> None:
        if self.fail_next is not None:
            exc, self.fail_next = self.fail_next, None
            raise exc
        data = self.storage.objects.get((bucket, source_key))
        if data is None:
            raise ObjectMissingError("source object not found")
        self.storage.objects[(bucket, dest_key)] = data
        self.copies.append((bucket, source_key, dest_key))

    def delete(self, bucket: str, key: str) -> None:
        self.storage.delete(bucket, key)


class World:
    def __init__(self) -> None:
        self.documents = FakeDocumentStore()
        self.storage = FakeStorage()
        self.copier = FakeCopier(self.storage)
        self.index, self.client = memory_index()
        self.forks = FakeForks()
        self.clock = FakeClock()
        self.sleeps: list[float] = []
        self.ticks = 0.0
        self.deps = ForkJobDeps(
            forks=self.forks,
            documents=self.documents,
            storage=self.copier,
            index=self.index,
            inject_failures=True,
            pause_seconds=60,
            poll_seconds=1,
            sleep=self._sleep,
            clock=lambda: self.ticks,
        )
        self.deps.lock_wait_seconds = 0
        self.forks.on_commit = self._commit_copies
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.documents.job_source = self._job_row
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.definition = workspace_fork_definition(lambda: self.deps)
        self.source_ws = uuid.uuid4()
        self.user = uuid.uuid4()

    def _commit_copies(self, plan: list[ForkDocument]) -> None:
        for doc in plan:
            source = self.documents.documents[doc.source_document_id]
            self.documents.documents[doc.target_document_id] = dataclasses.replace(
                source,
                id=doc.target_document_id,
                workspace_id=doc.target_workspace_id,
                source_object_key=doc.target_object_key,
                active_revision_id=doc.target_revision_id,
            )
            self.documents.revisions[doc.target_revision_id] = RevisionRow(
                doc.target_revision_id, doc.target_document_id, 1, None, "published", None, None
            )

    def publish_newer_copy_revision(self, doc: ForkDocument) -> uuid.UUID:
        """The new owner corrects the copy: revision 2 is indexed, published and activated."""
        source = self.documents.load_content(
            self.documents.documents[doc.source_document_id],
            self.documents.revisions[doc.source_revision_id],
        )
        newer = uuid.uuid4()
        content = target_content(source, doc).model_copy(update={"revision_id": str(newer)})
        ws, tdoc = str(doc.target_workspace_id), str(doc.target_document_id)
        chunks = list(chunk_revision(content, document_title=doc.title).chunks)
        self.index.index_revision(ws, tdoc, str(newer), chunks)
        self.index.activate_revision(ws, tdoc, str(newer))
        self.documents.revisions[newer] = RevisionRow(
            newer, doc.target_document_id, 2, doc.target_revision_id, "published", None, None
        )
        self.documents.documents[doc.target_document_id] = dataclasses.replace(
            self.documents.documents[doc.target_document_id], active_revision_id=newer
        )
        return newer

    def redeliver(self, envelope: JobEnvelope) -> Any:
        """A new attempt of the same request (e.g. the job row was reset after a lost ack)."""
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.jobs.create(envelope, max_attempts=3)
        return self.run(envelope)

    def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.ticks += seconds

    def _job_row(self, job_id: uuid.UUID) -> JobRow | None:
        record = self.jobs.get(job_id)
        if record is None:
            return None
        return JobRow(dict(record.payload), record.status.value, record.last_error)

    def published_book(self, *, parsed: bool = True) -> tuple[DocumentRow, RevisionRow]:
        """A ready source document (parsed fixture content, published revision 1)."""
        document, revision = self.documents.add_document(BOOK, title="합성 교재")
        document = dataclasses.replace(document, workspace_id=self.source_ws)
        self.documents.documents[document.id] = document
        parsed_doc = FakeParser.from_truth_files(TRUTH).parse(
            PDF_DIR / "book-ko.pdf", source_path="book-ko.pdf"
        )
        content = build_revision(
            parsed_doc, document_id=str(document.id), revision_id=str(revision.id)
        ).revision.model_copy(update={"source_sha256": document.sha256})
        key = f"{document.source_object_key.rsplit('/', 1)[0]}/parsed_document.json"
        self.documents.write_content(
            document, revision, content, parser_version="fake", parsed_object_key=key
        )
        revision = dataclasses.replace(self.documents.revisions[revision.id], status="published")
        self.documents.revisions[revision.id] = revision
        document = dataclasses.replace(document, status="ready", active_revision_id=revision.id)
        self.documents.documents[document.id] = document
        self.storage.objects[(SOURCE_BUCKET, document.source_object_key)] = BOOK
        if parsed:
            self.storage.objects[(PARSED_BUCKET, key)] = b"{}"
        return document, revision

    def request(self, name: str = "내 fork", documents: int = 1) -> tuple[ForkRow, JobEnvelope]:
        target_ws = uuid.uuid4()
        plan = []
        for _ in range(documents):
            document, revision = self.published_book()
            tdoc, trev = uuid.uuid4(), uuid.uuid4()
            prefix = f"workspaces/{target_ws}/documents/{tdoc}/revisions/{trev}"
            plan.append(
                ForkDocument(
                    source_document_id=document.id,
                    source_revision_id=revision.id,
                    target_workspace_id=target_ws,
                    target_document_id=tdoc,
                    target_revision_id=trev,
                    document_type=document.document_type,
                    title=document.title,
                    source_object_key=document.source_object_key,
                    target_object_key=f"{prefix}/source.pdf",
                    source_parsed_object_key=revision.parsed_object_key,
                    target_parsed_object_key=f"{prefix}/parsed_document.json",
                )
            )
        fork = ForkRow(
            id=uuid.uuid4(),
            status="PENDING",
            name=name,
            forked_by=self.user,
            source_workspace_id=self.source_ws,
            target_workspace_id=None,
        )
        self.forks.rows[fork.id] = fork
        self.forks.plans[fork.id] = plan
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"fork:{fork.id}",
            workspace_id=self.source_ws,
            created_by=self.user,
            payload={"fork_id": str(fork.id)},
        )
        self.jobs.create(envelope, max_attempts=3)
        return fork, envelope

    def run(self, envelope: JobEnvelope) -> Any:
        return self.runner.run(self.definition, envelope.to_message())

    def status(self, fork: ForkRow) -> str:
        return self.forks.rows[fork.id].status

    def target_points(self, doc: ForkDocument) -> list[dict[str, Any]]:
        return points(self.index, self.client, doc.target_document_id)

    def target_objects(self, doc: ForkDocument) -> set[tuple[str, str]]:
        keys = {(SOURCE_BUCKET, doc.target_object_key)}
        if doc.target_parsed_object_key:
            keys.add((PARSED_BUCKET, doc.target_parsed_object_key))
        return keys & set(self.storage.objects)


@pytest.fixture
def world() -> World:
    return World()


def test_fork_copies_objects_indexes_the_copy_commits_and_activates(world: World) -> None:
    fork, envelope = world.request(documents=2)
    plan = world.forks.plans[fork.id]

    result = world.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert world.status(fork) == "COMPLETED"
    assert world.forks.commits == 1
    assert result.record.result == {
        "fork_id": str(fork.id),
        "target_workspace_id": str(plan[0].target_workspace_id),
        "documents": 2,
    }
    for doc in plan:
        assert world.storage.objects[(SOURCE_BUCKET, doc.target_object_key)] == BOOK
        assert doc.target_parsed_object_key is not None
        assert (PARSED_BUCKET, doc.target_parsed_object_key) in world.storage.objects
        stored = world.target_points(doc)
        assert stored, "the copy was not indexed"
        assert {p["workspace_id"] for p in stored} == {str(doc.target_workspace_id)}
        assert {p["revision_id"] for p in stored} == {str(doc.target_revision_id)}
        assert world.index.active_revision(
            str(doc.target_workspace_id), str(doc.target_document_id)
        ) == str(doc.target_revision_id)
        # The source's own points (none were indexed here) are never touched.
        assert points(world.index, world.client, doc.source_document_id) == []
    assert world.forks.progress == sorted(world.forks.progress)
    assert world.forks.progress[-1] == 90


def test_target_content_keeps_the_content_and_hash_under_the_new_ids(world: World) -> None:
    fork, _ = world.request()
    (doc,) = world.forks.plans[fork.id]
    document = world.documents.documents[doc.source_document_id]
    source = world.documents.load_content(
        document, world.documents.revisions[doc.source_revision_id]
    )

    copy = target_content(source, doc)

    assert (copy.document_id, copy.revision_id) == (
        str(doc.target_document_id),
        str(doc.target_revision_id),
    )
    assert (copy.revision_number, copy.parent_revision_id) == (1, None)
    assert copy.content_hash == source.content_hash
    assert copy.blocks == source.blocks
    assert copy.sections == source.sections


def test_a_revoke_mid_copy_cancels_and_cleans_up(world: World) -> None:
    fork, envelope = world.request(documents=2)
    plan = world.forks.plans[fork.id]
    checks = 0

    def revoke_after_first_document() -> None:
        nonlocal checks
        checks += 1
        if checks == 2:  # the check after the first document's copy
            world.forks.usable = False

    world.forks.on_check = revoke_after_first_document

    result = world.run(envelope)

    assert result.outcome is RunOutcome.CANCELLED
    assert world.status(fork) == "CANCELLED"
    assert world.forks.errors[fork.id] == "share_unavailable"
    assert world.forks.commits == 0
    for doc in plan:
        assert world.target_objects(doc) == set(), "copied objects were left behind"
        assert world.target_points(doc) == []
    # The sources are untouched.
    for doc in plan:
        assert world.storage.objects[(SOURCE_BUCKET, doc.source_object_key)] == BOOK


def test_the_commit_re_check_cancels_a_fork_whose_link_died_at_the_end(world: World) -> None:
    fork, envelope = world.request()
    (doc,) = world.forks.plans[fork.id]
    original = world.forks.commit

    def commit_after_revoke(fork_id: uuid.UUID) -> CommitOutcome:
        world.forks.usable = False  # revoked between the last check and the locked re-check
        return original(fork_id)

    world.forks.commit = commit_after_revoke  # type: ignore[method-assign]

    result = world.run(envelope)

    assert result.outcome is RunOutcome.CANCELLED
    assert world.status(fork) == "CANCELLED"
    assert world.target_objects(doc) == set()
    assert world.target_points(doc) == []


def test_the_failure_marker_fails_after_copying_and_cleans_up(world: World) -> None:
    fork, envelope = world.request(name=f"S0 {FAILURE_MARKER}")
    (doc,) = world.forks.plans[fork.id]

    result = world.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert world.status(fork) == "FAILED"
    assert (world.forks.errors[fork.id] or "").startswith("fork_injected_failure")
    assert world.forks.commits == 0
    assert world.copier.copies, "the failure is injected after copying"
    assert world.target_objects(doc) == set()
    assert world.target_points(doc) == []


def test_markers_are_ignored_without_fault_injection(world: World) -> None:
    world.deps.inject_failures = False
    fork, envelope = world.request(name=f"{FAILURE_MARKER} {PAUSE_MARKER}")

    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    assert world.status(fork) == "COMPLETED"
    assert world.sleeps == []


def test_the_pause_marker_holds_until_the_link_dies(world: World) -> None:
    fork, envelope = world.request(name=f"S0 {PAUSE_MARKER}")

    def revoke_while_paused() -> None:
        if len(world.sleeps) >= 3:
            world.forks.usable = False

    world.forks.on_check = revoke_while_paused

    result = world.run(envelope)

    assert result.outcome is RunOutcome.CANCELLED
    assert len(world.sleeps) == 3
    assert world.status(fork) == "CANCELLED"


def test_the_pause_marker_commits_after_its_time_is_up(world: World) -> None:
    fork, envelope = world.request(name=f"S0 {PAUSE_MARKER}")

    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    assert sum(world.sleeps) == 60
    assert world.status(fork) == "COMPLETED"


def test_a_transient_storage_error_is_retried_and_copies_once(world: World) -> None:
    fork, envelope = world.request()
    world.copier.fail_next = JobError("storage timeout")

    first = world.run(envelope)
    assert first.outcome is RunOutcome.RETRY
    assert world.status(fork) == "COPYING", "a retried fork is still running"
    second = world.run(envelope)

    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    assert second.record.attempts == 2
    assert world.forks.commits == 1
    assert world.status(fork) == "COMPLETED"


def test_a_redelivered_completed_fork_only_activates(world: World) -> None:
    fork, envelope = world.request()
    (doc,) = world.forks.plans[fork.id]
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    copies = list(world.copier.copies)

    assert world.redeliver(envelope).outcome is RunOutcome.SUCCEEDED
    assert world.copier.copies == copies
    assert world.forks.commits == 1
    assert world.target_points(doc)


def test_a_job_for_another_workspace_or_user_never_copies(world: World) -> None:
    fork, envelope = world.request()
    world.forks.rows[fork.id] = dataclasses.replace(
        world.forks.rows[fork.id], forked_by=uuid.uuid4()
    )

    result = world.run(envelope)

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("fork_not_found")
    assert world.copier.copies == []


def test_a_missing_source_pdf_fails_the_fork_and_a_missing_parse_artifact_does_not(
    world: World,
) -> None:
    fork, envelope = world.request()
    (doc,) = world.forks.plans[fork.id]
    assert doc.source_parsed_object_key is not None
    del world.storage.objects[(PARSED_BUCKET, doc.source_parsed_object_key)]
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED

    other, other_envelope = world.request()
    (other_doc,) = world.forks.plans[other.id]
    del world.storage.objects[(SOURCE_BUCKET, other_doc.source_object_key)]
    result = world.run(other_envelope)
    assert result.outcome is RunOutcome.FAILED
    assert world.status(other) == "FAILED"
    assert (world.forks.errors[other.id] or "").startswith("source_missing")


def test_the_worker_registers_the_fork_job() -> None:
    settings = WorkerSettings.model_construct(app_env=Environment.TEST, task_always_eager=True)
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}


def test_a_late_retry_never_reactivates_revision_1_over_a_newer_publish(world: World) -> None:
    fork, envelope = world.request()
    (doc,) = world.forks.plans[fork.id]
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    newer = world.publish_newer_copy_revision(doc)

    result = world.redeliver(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED
    assert "index_sync" not in (result.record.result or {})
    assert world.index.active_revision(
        str(doc.target_workspace_id), str(doc.target_document_id)
    ) == str(newer), "the retry re-activated the superseded revision 1"


def test_activation_waits_for_the_document_lock_and_else_leaves_it_to_index_sync(
    world: World,
) -> None:
    fork, envelope = world.request()
    (doc,) = world.forks.plans[fork.id]
    world.documents.locked.add(doc.target_document_id)  # a publish of the copy is running

    result = world.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED
    assert world.status(fork) == "COMPLETED"
    assert result.record.result["index_sync"] == "pending"
    assert (
        world.index.active_revision(str(doc.target_workspace_id), str(doc.target_document_id))
        is None
    )
