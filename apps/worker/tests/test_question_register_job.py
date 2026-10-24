"""`question.import_register` with a fake store (no DB): batching, progress, idempotent retries
and the stop conditions (QIMP-JOB, QIMPORT-01-AC07).

The SQL side (`worker_register_import_drafts`: approval, question rows, version fencing, chapter
resolution) is supabase/tests/15_question_import_registration.test.sql; the whole flow against
the real stack is tests/integration/questions/test_question_import_registration.py.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

import pytest
from quiz_worker.celery_app import default_definitions
from quiz_worker.document_store import DocumentBusyError
from quiz_worker.envelope import JobEnvelope
from quiz_worker.question_register_job import (
    JOB_TYPE,
    BatchOutcome,
    RegisterJobDeps,
    RegistrationCounts,
    question_register_definition,
)
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import FakeClock


@dataclass
class FakeRegisterStore:
    """Items of one job: state per draft; `fail_after` raises after that many batches."""

    states: dict[uuid.UUID, str] = field(default_factory=dict)
    registered_twice: list[uuid.UUID] = field(default_factory=list)
    questions: dict[uuid.UUID, int] = field(default_factory=dict)
    stale: set[uuid.UUID] = field(default_factory=set)
    outcome: str = "ok"
    fail_after: int | None = None
    calls: int = 0
    progress: list[int] = field(default_factory=list)
    locked: set[uuid.UUID] = field(default_factory=set)
    on_batch: Callable[[int], None] | None = None
    _mutex: threading.Lock = field(default_factory=threading.Lock)

    @contextmanager
    def job_lock(
        self, job_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        with self._mutex:
            if job_id in self.locked:
                raise DocumentBusyError("busy")
            self.locked.add(job_id)
        try:
            yield
        finally:
            self.locked.discard(job_id)

    def register_batch(self, job_id: uuid.UUID, limit: int) -> BatchOutcome:
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            self.fail_after = None
            raise ConnectionError("database went away")
        if self.outcome != "ok":
            return BatchOutcome(self.outcome, 0, 0, 0, self._pending())
        done = {"registered": 0, "skipped": 0, "refused": 0}
        for draft in [d for d, s in self.states.items() if s == "pending"][:limit]:
            if draft in self.stale:
                self.states[draft] = "refused"
                done["refused"] += 1
                continue
            if draft in self.questions:
                self.registered_twice.append(draft)
            self.questions[draft] = self.questions.get(draft, 0) + 1
            self.states[draft] = "registered"
            done["registered"] += 1
        if self.on_batch is not None:
            self.on_batch(self.calls)
        return BatchOutcome(
            "ok", done["registered"], done["skipped"], done["refused"], self._pending()
        )

    def _pending(self) -> int:
        return sum(1 for s in self.states.values() if s == "pending")

    def counts(self, job_id: uuid.UUID) -> RegistrationCounts:
        found = list(self.states.values())
        return RegistrationCounts(
            total=len(found),
            pending=found.count("pending"),
            registered=found.count("registered"),
            skipped=found.count("skipped"),
            refused=found.count("refused"),
        )

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        assert stage == "registering"
        self.progress.append(percent)


class World:
    def __init__(self, drafts: int = 250) -> None:
        self.store = FakeRegisterStore(states={uuid.uuid4(): "pending" for _ in range(drafts)})
        self.clock = FakeClock()
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.definition = question_register_definition(
            lambda: RegisterJobDeps(store=self.store, batch_size=100, lock_wait_seconds=0)
        )
        self.envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"question_import_register:{uuid.uuid4()}:1",
            workspace_id=uuid.uuid4(),
            created_by=uuid.uuid4(),
            payload={"import_id": str(uuid.uuid4())},
        )
        self.jobs.create(self.envelope, max_attempts=3)

    def run(self) -> RunOutcome:
        return self.runner.run(self.definition, self.envelope.to_message()).outcome


@pytest.fixture
def world() -> World:
    return World()


def test_qimport_01_ac07_registers_every_pending_draft_in_batches_with_progress(
    world: World,
) -> None:
    world.store.stale = set(list(world.store.states)[:3])

    assert world.run() is RunOutcome.SUCCEEDED

    counts = world.store.counts(world.envelope.job_id)
    assert (counts.registered, counts.refused, counts.pending) == (247, 3, 0)
    assert world.store.calls == 3  # 100 + 100 + 50
    assert world.store.progress == [40, 80, 99]
    record = world.jobs.get(world.envelope.job_id)
    assert record is not None
    assert record.status is JobStatus.SUCCEEDED
    assert record.result == {
        "import_id": world.envelope.payload["import_id"],
        "total": 250,
        "registered": 247,
        "skipped": 0,
        "refused": 3,
        "pending": 0,
    }


def test_qimport_01_ac07_a_retried_attempt_resumes_without_registering_twice(
    world: World,
) -> None:
    """A database error after the first batch: the runner retries and the next attempt continues
    with the pending items only."""
    world.store.fail_after = 1

    assert world.run() is RunOutcome.RETRY
    assert world.store.counts(world.envelope.job_id).registered == 100
    world.clock.advance(600)
    assert world.run() is RunOutcome.SUCCEEDED

    assert world.store.counts(world.envelope.job_id).registered == 250
    assert world.store.registered_twice == []
    # A re-delivered message of the finished job does nothing.
    assert world.run() is RunOutcome.DUPLICATE_FINISHED
    assert all(n == 1 for n in world.store.questions.values())


def test_qimport_01_ac07_an_archived_workspace_stops_the_registration(world: World) -> None:
    world.store.outcome = "workspace_unavailable"

    assert world.run() is RunOutcome.FAILED

    record = world.jobs.get(world.envelope.job_id)
    assert record is not None
    assert record.status is JobStatus.FAILED
    assert (record.last_error or "").startswith("workspace_unavailable")
    assert world.store.counts(world.envelope.job_id).pending == 250
    assert world.store.questions == {}


@pytest.mark.parametrize(
    ("outcome", "code"),
    [("not_found", "registration_not_found"), ("not_running", "registration_superseded")],
)
def test_lost_jobs_fail_without_registering(world: World, outcome: str, code: str) -> None:
    world.store.outcome = outcome

    assert world.run() is RunOutcome.FAILED

    record = world.jobs.get(world.envelope.job_id)
    assert record is not None
    assert (record.last_error or "").startswith(code)


def test_nothing_pending_finishes_at_once() -> None:
    world = World(drafts=0)
    assert world.run() is RunOutcome.SUCCEEDED
    assert world.store.calls == 1


def test_the_job_is_registered_on_the_default_worker() -> None:
    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}
