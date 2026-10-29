"""`chapter_note.generate` with fakes (no DB): the job reads only the pinned revisions, validates
citations through book_core.notes with the APP_ENV=test scenario LLM, writes a version with
counts-only results, and fails with stable codes (CHNOTE-01-C01, C02, C06). The real stack is
tests/integration/questions/chapter_notes/test_chapter_notes_contract.py.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from book_core.llm import FakeLLMClient, LLMProviderError, LLMRequest
from book_core.llm.scenarios import ScenarioLLMClient
from book_core.notes import TASK
from quiz_worker.celery_app import default_definitions
from quiz_worker.chapter_note_job import (
    ChapterNoteJobDeps,
    HoldBarrierLLMClient,
    build_chapter_note_llm,
    chapter_note_definition,
)
from quiz_worker.chapter_note_store import JOB_TYPE, NoteRef, NoteRow, RevisionRow
from quiz_worker.envelope import JobEnvelope
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import FakeClock

SCENARIO_FILE = (
    Path(__file__).resolve().parents[3] / "tests/fixtures/llm/chapter-note-scenarios.json"
)
CHAPTER = "물이 에너지를 얻어 수증기가 된다. 이 과정을 증발이라고 한다."


@dataclass
class FakeNoteStore:
    notes: dict[uuid.UUID, NoteRow] = field(default_factory=dict)
    revisions: dict[uuid.UUID, RevisionRow] = field(default_factory=dict)
    results: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    failures: dict[uuid.UUID, str] = field(default_factory=dict)
    batches: dict[uuid.UUID, tuple[int, int]] = field(default_factory=dict)
    payloads: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    reference: str = CHAPTER
    writable: bool = True
    versions: int = 0
    _mutex: threading.Lock = field(default_factory=threading.Lock)

    @contextmanager
    def run_lock(
        self, note_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        with self._mutex:
            yield

    def load_note(self, workspace_id: uuid.UUID, note_id: uuid.UUID) -> NoteRow | None:
        note = self.notes.get(note_id)
        return note if note and note.workspace_id == workspace_id else None

    def load_revisions(
        self, workspace_id: uuid.UUID, refs: Sequence[NoteRef]
    ) -> dict[uuid.UUID, RevisionRow]:
        return {
            r.question_revision_id: self.revisions[r.question_revision_id]
            for r in refs
            if r.question_revision_id in self.revisions
        }

    def reference_text(self, revision_id: uuid.UUID, section_key: str) -> str:
        return self.reference

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        return self.writable

    def _set(self, note_id: uuid.UUID, status: str) -> None:
        self.notes[note_id] = replace(self.notes[note_id], status=status)

    def mark_running(self, note_id: uuid.UUID, job_id: uuid.UUID, batches_total: int) -> None:
        if self.notes[note_id].job_id == job_id:
            self._set(note_id, "running")
            self.batches[note_id] = (0, batches_total)

    def report_batches(self, note_id: uuid.UUID, job_id: uuid.UUID, done: int) -> None:
        self.batches[note_id] = (done, self.batches[note_id][1])

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        note_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        body: dict[str, Any],
        usage: dict[str, Any],
        dropped_items: int,
        model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> int:
        before_commit()
        self.versions += 1
        self.results[note_id] = {
            "body": body,
            "usage": usage,
            "dropped": dropped_items,
            "model": model,
            "prompt_version": prompt_version,
            "version": self.versions,
        }
        self._set(note_id, "succeeded")
        return self.versions

    def mark_failed(self, note_id: uuid.UUID, job_id: uuid.UUID, error_code: str) -> None:
        note = self.notes[note_id]
        if note.job_id == job_id and note.status in {"queued", "running"}:
            self._set(note_id, "failed")
            self.failures[note_id] = error_code

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        return self.payloads.get(job_id)


class World:
    def __init__(self, llm: Any = None, *, enabled: bool = True) -> None:
        self.store = FakeNoteStore()
        self.clock = FakeClock()
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.llm = llm if llm is not None else ScenarioLLMClient.from_file(SCENARIO_FILE)
        self.deps = ChapterNoteJobDeps(
            notes=self.store, llm=self.llm, enabled=enabled, lock_wait_seconds=0
        )
        self.definition = chapter_note_definition(lambda: self.deps)
        self.workspace_id = uuid.uuid4()
        self.user = uuid.uuid4()

    def question(self, stem: str, explanation: str = "해설") -> RevisionRow:
        row = RevisionRow(
            question_id=uuid.uuid4(),
            revision_id=uuid.uuid4(),
            question_type="MCQ",
            stem=stem,
            options=[{"id": "a", "text": "가"}, {"id": "b", "text": "나"}],
            correct_option_ids=["a"],
            accepted_answers=None,
            explanation=explanation,
        )
        self.store.revisions[row.revision_id] = row
        return row

    def note(self, rows: Sequence[RevisionRow]) -> tuple[NoteRow, JobEnvelope]:
        note_id = uuid.uuid4()
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"chapter_note:{note_id}:1",
            workspace_id=self.workspace_id,
            created_by=self.user,
            payload={"note_id": str(note_id)},
        )
        note = NoteRow(
            id=note_id,
            workspace_id=self.workspace_id,
            status="queued",
            job_id=envelope.job_id,
            document_id=uuid.uuid4(),
            document_revision_id=uuid.uuid4(),
            section_key="ch1",
            refs=tuple(
                NoteRef(f"Q{i + 1}", r.question_id, r.revision_id, f"1장 {i + 1}번")
                for i, r in enumerate(rows)
            ),
        )
        self.store.notes[note_id] = note
        self.store.payloads[envelope.job_id] = {"note_id": str(note_id)}
        self.jobs.create(envelope, max_attempts=3)
        return note, envelope

    def run(self, envelope: JobEnvelope) -> Any:
        return self.runner.run(self.definition, envelope.to_message())

    def drain(self, envelope: JobEnvelope) -> Any:
        result = None
        for _ in range(5):
            result = self.run(envelope)
            if result.outcome is not RunOutcome.RETRY:
                return result
            self.clock.advance(3600)
        return result


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


def test_a_note_is_generated_from_the_pinned_revisions_with_counts_only_results(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    world = World()
    rows = [
        world.question(f"stem-{n} [E2E-NOTE-MIXED]", f"secret-explanation-{n}") for n in (1, 2, 3)
    ]
    # A newer revision of q1 exists, but the note pinned the first one.
    world.question("stem-1 revised [E2E-NOTE-MIXED]", "newer-explanation")
    note, envelope = world.note(rows)

    result = world.run(envelope)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    stored = world.store.results[note.id]
    tokens = [i["text"].split()[-1] for s in stored["body"]["sections"] for i in s["items"]]
    assert tokens == ["NOTE-MIX-A", "NOTE-MIX-B", "NOTE-MIX-C", "NOTE-MIX-D"]
    items = [i for s in stored["body"]["sections"] for i in s["items"]]
    assert all(set(i["tags"]) <= {"Q1", "Q2", "Q3"} for i in items)
    assert stored["usage"]["llm_calls"] == 2
    assert (stored["usage"]["items"], stored["dropped"]) == (4, 3)
    assert stored["prompt_version"] == "chapter_notes.generate/v1"
    assert world.store.batches[note.id] == (1, 1)
    prompts = [r.prompt for _, r in world.llm.calls]
    assert all("secret-explanation-2" in p for p in prompts)
    assert not any("newer-explanation" in p for p in prompts)

    job = world.jobs.get(envelope.job_id)
    assert job is not None
    assert job.status is JobStatus.SUCCEEDED
    assert job.result is not None
    assert all(len(s) <= 64 and "\n" not in s for s in strings(dict(job.result)))
    dumped = json.dumps(dict(job.result), ensure_ascii=False)
    for forbidden in ("stem-", "secret-explanation", "NOTE-MIX", "증발"):
        assert forbidden not in dumped
        assert forbidden not in caplog.text


def test_an_essay_without_explanation_sends_its_model_answer() -> None:
    world = World()
    essay = RevisionRow(
        question_id=uuid.uuid4(),
        revision_id=uuid.uuid4(),
        question_type="ESSAY",
        stem="essay-stem [E2E-NOTE-OK]",
        options=[],
        correct_option_ids=None,
        accepted_answers=None,
        explanation=None,
        rubric="essay-model-answer: 증발과 응결을 함께 설명한다",
    )
    world.store.revisions[essay.revision_id] = essay
    note, envelope = world.note([essay, world.question("q2 [E2E-NOTE-OK]")])
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    [prompt] = [r.prompt for _, r in world.llm.calls]
    assert "essay-model-answer: 증발과 응결을 함께 설명한다" in prompt
    assert "(채점 기준)" in prompt
    assert note.id in world.store.results


@pytest.mark.parametrize(
    ("marker", "code"),
    [("E2E-NOTE-INVALID", "note_citation_invalid"), ("E2E-NOTE-FAIL", "llm_invalid_output")],
)
def test_invalid_notes_fail_with_a_code_and_no_version(marker: str, code: str) -> None:
    world = World()
    note, envelope = world.note([world.question(f"q{n} [{marker}]") for n in (1, 2)])
    result = world.run(envelope)
    assert result.outcome is RunOutcome.FAILED
    assert world.store.failures[note.id] == code
    assert note.id not in world.store.results
    assert (result.error or "").startswith(code)


def test_provider_errors_are_retried_then_recorded() -> None:
    llm = FakeLLMClient()
    llm.script(TASK, LLMProviderError("timed out", kind="timeout"))
    world = World(llm)
    note, envelope = world.note([world.question("q1")])
    first = world.run(envelope)
    assert first.outcome is RunOutcome.RETRY
    assert world.store.notes[note.id].status == "running"
    final = world.drain(envelope)
    assert final.outcome is RunOutcome.FAILED
    assert world.store.failures[note.id] == "llm_timeout"


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        (lambda w: setattr(w.deps, "enabled", False), "note_generation_disabled"),
        (lambda w: setattr(w.deps, "llm", None), "llm_not_configured"),
        (lambda w: setattr(w.store, "writable", False), "workspace_unavailable"),
        (lambda w: w.store.revisions.clear(), "note_input_missing"),
    ],
)
def test_preconditions_fail_without_calling_the_llm(
    setup: Callable[[World], None], code: str
) -> None:
    world = World()
    note, envelope = world.note([world.question("q1 [E2E-NOTE-OK]")])
    setup(world)
    result = world.run(envelope)
    assert result.outcome is RunOutcome.FAILED
    assert world.store.failures[note.id] == code
    assert world.llm.calls == []


def test_a_finished_or_superseded_row_is_skipped() -> None:
    world = World()
    note, envelope = world.note([world.question(f"q{n} [E2E-NOTE-OK]") for n in (1, 2)])
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    # A second job for the same row (e.g. a stale message) never runs the LLM again.
    other = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key="other",
        workspace_id=world.workspace_id,
        created_by=world.user,
        payload={"note_id": str(note.id)},
    )
    world.jobs.create(other, max_attempts=3)
    calls = len(world.llm.calls)
    result = world.run(other)
    assert result.outcome is RunOutcome.SUCCEEDED
    assert len(world.llm.calls) == calls
    assert world.store.versions == 1


def test_cancellation_during_generation_marks_the_note_failed() -> None:
    scenario = ScenarioLLMClient.from_file(SCENARIO_FILE)
    holder: dict[str, Any] = {}

    class CancellingLLM:
        model_name = "cancel"
        calls = scenario.calls

        def complete(self, request: LLMRequest, schema: Any) -> Any:
            holder["world"].jobs.request_cancel(holder["job_id"])
            return scenario.complete(request, schema)

    world = World(CancellingLLM())
    holder["world"] = world
    note, envelope = world.note([world.question(f"q{n} [E2E-NOTE-OK]") for n in (1, 2)])
    holder["job_id"] = envelope.job_id
    result = world.run(envelope)
    assert result.outcome is RunOutcome.CANCELLED
    assert world.store.failures[note.id] == "cancelled"
    assert note.id not in world.store.results


def test_the_test_llm_is_the_scenario_fake_behind_the_hold_barrier(tmp_path: Path) -> None:
    settings = WorkerSettings(
        APP_ENV=Environment.TEST,
        WORKER_CHAPTER_NOTES=True,
        WORKER_CHAPTER_NOTE_HOLD_DIR=str(tmp_path),
    )  # type: ignore[call-arg]
    client = build_chapter_note_llm(settings)
    assert isinstance(client, HoldBarrierLLMClient)
    token = uuid.uuid4().hex[:16]
    request = LLMRequest(
        task=TASK,
        prompt_version=f"{TASK}/v1",
        prompt=f"Q1 a [E2E-NOTE-OK] [E2E-HOLD-NOTE-{token}]\nQ2 b [E2E-NOTE-OK]",
    )
    done = threading.Event()

    def call() -> None:
        from book_core.notes import LLMNoteOutput

        client.complete(request, LLMNoteOutput)
        done.set()

    thread = threading.Thread(target=call)
    thread.start()
    held = tmp_path / f"{token}.held"
    for _ in range(100):
        if held.exists():
            break
        threading.Event().wait(0.05)
    assert held.exists(), "the barrier reports the held generation"
    assert not done.is_set()
    (tmp_path / f"{token}.release").touch()
    thread.join(timeout=10)
    assert done.is_set()
    assert len(client.calls) == 1


def test_the_job_is_registered() -> None:
    settings = WorkerSettings(APP_ENV=Environment.TEST)  # type: ignore[call-arg]
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}
