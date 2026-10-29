"""`document.summarize` (DOCSUM-B, DOCSUM-01-C01/C03/C04/C06) over in-memory stores.

The run/unit store is a dict-backed stand-in for `PostgresSummaryStore` (the SQL side is covered
by supabase/tests/19_document_summaries.test.sql and the infra contract tests); revisions come
from the fixture truth through `FakeDocumentStore`'s row encoding.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from book_core.llm import LLMProviderError, LLMUsage
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision
from book_core.summary import (
    SUMMARY_FAILURE_MARKER,
    SUMMARY_HOLD_MARKER,
    ExtractiveFakeSummarizer,
    StoredUnit,
    SummaryBody,
    SummaryLimits,
)
from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.envelope import JobEnvelope
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore
from quiz_worker.summary_job import (
    SummaryJobDeps,
    build_summarizer,
    document_summarize_definition,
)
from quiz_worker.summary_store import JOB_TYPE, FinishOutcome, RunRow

from .conftest import FakeClock
from .document_fakes import PDF_DIR, FakeDocumentStore

BOOK = (PDF_DIR / "book-ko.pdf").read_bytes()
TRUTH = sorted(PDF_DIR.glob("*.truth.json"))


@dataclass
class FakeSummaryStore:
    runs: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    units: dict[tuple[uuid.UUID, str, str, str, str, str], StoredUnit] = field(default_factory=dict)
    links: dict[uuid.UUID, list[str]] = field(default_factory=dict)
    progress: list[tuple[int, int]] = field(default_factory=list)
    documents: FakeDocumentStore | None = None
    writable: bool = True
    # Owners/editors of the workspace (None = anyone): worker_workspace_writable per user.
    editors: set[uuid.UUID] | None = None
    usage_records: list[dict[str, Any]] = field(default_factory=list)

    @contextmanager
    def summary_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        yield

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> RunRow | None:
        run = self.runs.get(run_id)
        if run is None or run["workspace_id"] != workspace_id:
            return None
        assert self.documents is not None
        doc = self.documents.documents[run["document_id"]]
        return RunRow(
            id=run_id,
            workspace_id=workspace_id,
            document_id=doc.id,
            revision_id=run["revision_id"],
            status=run["status"],
            job_id=run["job_id"],
            document_title=doc.title,
            document_filename=run.get("filename", "book.pdf"),
            document_type=doc.document_type,
            content_kind=doc.content_kind,
            document_deleted=doc.deleted,
            active_revision_id=doc.active_revision_id,
            usage=run.get("usage"),
        )

    def mark_running(
        self, run_id: uuid.UUID, job_id: uuid.UUID, *, prompt_version: str, model: str
    ) -> bool:
        run = self.runs[run_id]
        if run["job_id"] != job_id or run["status"] not in {"queued", "running"}:
            return False
        run.update(status="running", model=model, prompt_version=prompt_version)
        return True

    def report_progress(self, run_id: uuid.UUID, job_id: uuid.UUID, done: int, total: int) -> None:
        self.progress.append((done, total))

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        return self.writable and (self.editors is None or user_id in self.editors)

    def record_usage(self, run_id: uuid.UUID, job_id: uuid.UUID, usage: Mapping[str, Any]) -> None:
        row = self.runs[run_id]
        if row["job_id"] == job_id and row["status"] in {"queued", "running"}:
            row["usage"] = dict(usage)
            self.usage_records.append(dict(usage))

    def unit_store(
        self, run: RunRow, user_id: uuid.UUID | None, *, prompt_version: str, model: str
    ) -> Any:
        store = self

        class Units:
            def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None:
                key = (run.document_id, scope, section_key, input_hash, prompt_version, model)
                return store.units.get(key)

            def save(
                self,
                scope: str,
                section_key: str,
                input_hash: str,
                body: SummaryBody,
                page_from: int | None,
                page_to: int | None,
                usage: LLMUsage | None,
            ) -> StoredUnit:
                if not store.workspace_writable(run.workspace_id, user_id):
                    raise WorkspaceUnavailableError("the workspace is no longer writable")
                key = (run.document_id, scope, section_key, input_hash, prompt_version, model)
                unit = StoredUnit(str(uuid.uuid4()), body, page_from, page_to, str(run.id))
                return store.units.setdefault(key, unit)

        return Units()

    def finish(
        self,
        run: RunRow,
        job_id: uuid.UUID,
        unit_ids: Sequence[str],
        usage: Mapping[str, Any],
        *,
        user_id: uuid.UUID | None,
        before_commit: Callable[[], None],
    ) -> FinishOutcome:
        if not self.workspace_writable(run.workspace_id, user_id):
            return "workspace_unavailable"
        row = self.runs[run.id]
        if row["status"] != "running":
            return "not_running"
        assert self.documents is not None
        if self.documents.documents[run.document_id].active_revision_id != run.revision_id:
            row["status"] = "superseded"
            return "superseded"
        self.links[run.id] = list(unit_ids)
        row.update(status="succeeded", usage=dict(usage))
        return "succeeded"

    def mark_failed(
        self,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        error_code: str,
        usage: Mapping[str, Any] | None,
    ) -> None:
        row = self.runs[run_id]
        if row["job_id"] == job_id and row["status"] in {"queued", "running"}:
            row.update(status="failed", error_code=error_code, usage=dict(usage or {}))

    def job_payload(self, job_id: uuid.UUID) -> tuple[Mapping[str, Any], str | None] | None:
        for run_id, run in self.runs.items():
            if run["job_id"] == job_id:
                return {"run_id": str(run_id)}, run.get("last_error")
        return None


class World:
    def __init__(self, limits: SummaryLimits | None = None) -> None:
        self.documents = FakeDocumentStore()
        self.summaries = FakeSummaryStore(documents=self.documents)
        self.sleeps: list[float] = []
        self.deps = SummaryJobDeps(
            summaries=self.summaries,
            documents=self.documents,
            summarizer=ExtractiveFakeSummarizer(hold_dir=lambda: None),
            limits=limits or SummaryLimits(),
            lock_wait_seconds=0,
            slow_step_seconds=4.0,
            sleep=self.sleeps.append,
        )
        self.clock = FakeClock()
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.definition = document_summarize_definition(lambda: self.deps)
        self.envelopes: dict[uuid.UUID, JobEnvelope] = {}
        parser = FakeParser.from_truth_files(TRUTH)
        parsed = parser.parse(PDF_DIR / "book-ko.pdf")
        document, revision = self.documents.add_document(BOOK, title="물의 순환과 정수 처리")
        self.content = build_revision(
            parsed, document_id=str(document.id), revision_id=str(revision.id)
        ).revision
        self.documents.write_content(
            document, revision, self.content, parser_version="x", parsed_object_key=""
        )
        self.document_id = document.id
        self._publish(revision.id)

    def _publish(self, revision_id: uuid.UUID) -> None:
        rev = self.documents.revisions[revision_id]
        self.documents.revisions[revision_id] = replace(rev, status="published")
        doc = self.documents.documents[self.document_id]
        self.documents.documents[self.document_id] = replace(
            doc, status="ready", active_revision_id=revision_id
        )

    @property
    def document(self) -> Any:
        return self.documents.documents[self.document_id]

    def correct(self, text: str) -> uuid.UUID:
        """A new published revision with the chlorine block of chapter B replaced."""
        block = next(b for b in self.content.blocks if "염소" in b.text)
        new_id = uuid.uuid4()
        edited = apply_edits(self.content, {block.id: text}, revision_id=str(new_id))
        self.documents.add_draft(self.document_id, edited)
        self._publish(new_id)
        return new_id

    def start(
        self,
        revision_id: uuid.UUID | None = None,
        filename: str = "book.pdf",
        created_by: uuid.UUID | None = None,
    ) -> uuid.UUID:
        run_id, job_id = uuid.uuid4(), uuid.uuid4()
        self.summaries.runs[run_id] = {
            "workspace_id": self.document.workspace_id,
            "document_id": self.document_id,
            "revision_id": revision_id or self.document.active_revision_id,
            "status": "queued",
            "job_id": job_id,
            "filename": filename,
        }
        envelope = JobEnvelope(
            job_id=job_id,
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"document_summary:{run_id}",
            workspace_id=self.document.workspace_id,
            created_by=created_by or uuid.uuid4(),
            payload={"run_id": str(run_id), "document_id": str(self.document_id)},
        )
        self.jobs.create(envelope, max_attempts=3)
        self.envelopes[run_id] = envelope
        return run_id

    def run(self, run_id: uuid.UUID) -> Any:
        return self.runner.run(self.definition, self.envelopes[run_id].to_message())

    def run_row(self, run_id: uuid.UUID) -> dict[str, Any]:
        return self.summaries.runs[run_id]


@pytest.fixture
def world() -> World:
    return World()


def test_docsum_01_c01_a_run_summarizes_chapters_and_reuses_unchanged_ones(world: World) -> None:
    first = world.start()
    result = world.run(first)
    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    row = world.run_row(first)
    assert row["status"] == "succeeded"
    assert (row["usage"]["generated_units"], row["usage"]["reused_units"]) == (3, 0)
    assert "cost_usd" in row["usage"]
    assert len(world.summaries.links[first]) == 3
    assert world.summaries.progress[-1] == (2, 2)
    assert result.record.result == {
        "run_id": str(first),
        "chapters": 2,
        "reused_units": 0,
        "generated_units": 3,
    }

    world.correct("교정 문장이다. 마지막으로 염소를 넣는다.")
    second = world.start()
    assert world.run(second).outcome is RunOutcome.SUCCEEDED
    usage = world.run_row(second)["usage"]
    assert (usage["generated_units"], usage["reused_units"]) == (2, 1)
    assert world.summaries.links[first][1] == world.summaries.links[second][1], "chapter A"


def test_docsum_01_c03_superseded_runs_write_nothing(world: World) -> None:
    run_id = world.start()
    world.run_row(run_id)["status"] = "superseded"
    result = world.run(run_id)
    assert result.outcome is RunOutcome.SUCCEEDED
    assert result.record.result == {"run_id": str(run_id), "skipped": "superseded"}
    assert run_id not in world.summaries.links

    # The revision stopped being the active one while the run was generating.
    stale = world.start()
    world.correct("새 발행 문장이다.")
    assert world.run(stale).outcome is RunOutcome.SUCCEEDED
    assert world.run_row(stale)["status"] == "superseded"
    assert stale not in world.summaries.links


def test_docsum_01_c04_failure_marker_fails_with_a_code_and_no_text(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    leak = "유출금지문장XYZ"
    world.correct(f"{SUMMARY_FAILURE_MARKER} {leak} 문장이다.")
    run_id = world.start()
    result = world.run(run_id)
    assert result.outcome is RunOutcome.FAILED, "invalid output is not retried"
    row = world.run_row(run_id)
    assert (row["status"], row["error_code"]) == ("failed", "llm_invalid_output")
    assert row["usage"]["generated_units"] == 1, "chapter A was summarized before B failed"
    record = world.jobs.get(world.envelopes[run_id].job_id)
    assert record is not None
    assert record.last_error is not None
    assert record.last_error.startswith("llm_invalid_output")
    for text in (caplog.text, record.last_error, str(row)):
        assert leak not in text
        assert "물의 순환" not in text


def test_docsum_01_c06_too_large_fails_without_generating() -> None:
    world = World(SummaryLimits(max_input_chars=500))
    run_id = world.start()
    assert world.run(run_id).outcome is RunOutcome.FAILED
    row = world.run_row(run_id)
    assert (row["error_code"], row["usage"]["generated_units"]) == ("summary_too_large", 0)


def test_docsum_b_slow_marker_waits_before_running_and_each_generated_unit(world: World) -> None:
    run_id = world.start(filename="book-ko-E2E-SLOW-SUMMARY.pdf")
    assert world.run(run_id).outcome is RunOutcome.SUCCEEDED
    assert world.sleeps == [4.0] * 4, "queued + two chapters + the document"
    again = world.start(filename="book-ko-E2E-SLOW-SUMMARY.pdf")
    world.sleeps.clear()
    world.run(again)
    assert world.sleeps == [4.0], "reused units do not wait"


def test_docsum_b_without_an_llm_the_run_fails_after_retries(world: World) -> None:
    world.deps.summarizer = None
    run_id = world.start()
    for _ in range(3):
        world.run(run_id)
        world.clock.advance(3600)
    row = world.run_row(run_id)
    assert (row["status"], row["error_code"]) == ("failed", "llm_unavailable")


def test_docsum_b_a_deleted_document_is_unavailable(world: World) -> None:
    run_id = world.start()
    world.documents.documents[world.document_id] = replace(world.document, deleted=True)
    assert world.run(run_id).outcome is RunOutcome.FAILED
    assert world.run_row(run_id)["error_code"] == "document_unavailable"


def test_docsum_b_fake_summarizer_only_under_app_env_test(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    test_env = WorkerSettings(_env_file=None, APP_ENV="test")  # type: ignore[call-arg]
    assert isinstance(build_summarizer(test_env), ExtractiveFakeSummarizer)
    assert build_summarizer(WorkerSettings(_env_file=None)) is None  # type: ignore[call-arg]


class CountingSummarizer(ExtractiveFakeSummarizer):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.calls = 0
        self.fail_document_once = False

    def summarize_chapter(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        return super().summarize_chapter(*args, **kwargs)

    def summarize_document(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        if self.fail_document_once:
            self.fail_document_once = False
            raise LLMProviderError("timed out", kind="timeout")
        return super().summarize_document(*args, **kwargs)


def test_docsum_b_an_archived_workspace_sends_nothing_to_the_llm(world: World) -> None:
    fake = CountingSummarizer(hold_dir=lambda: None)
    world.deps.summarizer = fake
    run_id = world.start()
    world.summaries.writable = False
    assert world.run(run_id).outcome is RunOutcome.FAILED
    row = world.run_row(run_id)
    assert (row["status"], row["error_code"]) == ("failed", "workspace_unavailable")
    assert fake.calls == 0
    assert world.summaries.units == {}


def test_docsum_b_archived_between_generation_and_commit_writes_nothing_more(
    world: World, tmp_path: Path
) -> None:
    world.deps.summarizer = ExtractiveFakeSummarizer(hold_dir=lambda: str(tmp_path))
    world.correct(f"{SUMMARY_HOLD_MARKER}-arch1 보류 문장이다.")
    run_id = world.start()
    results: list[Any] = []
    thread = threading.Thread(target=lambda: results.append(world.run(run_id)), daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not (tmp_path / "arch1.held").exists():
        assert time.monotonic() < deadline, "never reached the hold barrier"
        time.sleep(0.02)
    before = dict(world.summaries.units)
    world.summaries.writable = False  # archived while chapter B is being generated
    (tmp_path / "arch1.release").touch()
    thread.join(10)
    assert results
    assert results[0].outcome is RunOutcome.FAILED
    row = world.run_row(run_id)
    assert (row["status"], row["error_code"]) == ("failed", "workspace_unavailable")
    assert world.summaries.units == before, "no unit written after the archive"
    assert run_id not in world.summaries.links


def test_docsum_b_usage_accumulates_over_retried_attempts(world: World) -> None:
    fake = CountingSummarizer(hold_dir=lambda: None)
    fake.fail_document_once = True
    world.deps.summarizer = fake
    run_id = world.start()
    assert world.run(run_id).outcome is RunOutcome.RETRY
    first = dict(world.run_row(run_id)["usage"])
    assert first["generated_units"] == 2
    world.clock.advance(3600)
    assert world.run(run_id).outcome is RunOutcome.SUCCEEDED
    row = world.run_row(run_id)
    usage = row["usage"]
    assert row["status"] == "succeeded"
    assert (usage["generated_units"], usage["reused_units"]) == (3, 0), "its own chapters"
    assert usage["input_tokens"] > first["input_tokens"]
    assert fake.calls == 4, "chapters once, the document twice"


def test_docsum_01_ac02_a_publish_run_is_the_publishers_after_the_opt_in_editor_left(
    world: World,
) -> None:
    opted_in_by, publisher = uuid.uuid4(), uuid.uuid4()
    world.summaries.editors = {publisher}  # A was demoted to viewer; B still edits
    # The publish path attributes the run and its job to the publishing user (B).
    world.correct("B가 교정한 문장이다.")
    run_id = world.start(created_by=publisher)
    assert world.run(run_id).outcome is RunOutcome.SUCCEEDED
    assert world.run_row(run_id)["status"] == "succeeded"
    # Attributed to the opt-in editor instead, the same run could not write.
    world.correct("A 기준 교정 문장이다.")
    stale = world.start(created_by=opted_in_by)
    assert world.run(stale).outcome is RunOutcome.FAILED
    assert world.run_row(stale)["error_code"] == "workspace_unavailable"
