"""`question.import` with fakes (no DB or Storage; the question paper is parsed and published by the
real `document.parse` job over the same fakes first).

The same flow against the real stack (API, Postgres as quiz_worker, Supabase Storage) is
tests/integration/questions/test_question_import_contract.py.
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from typing import Any

import pytest
from book_core.contracts import ParsedDocument
from book_core.parser import FakeParser, document_from_pages
from quiz_worker.celery_app import default_definitions
from quiz_worker.document_job import (
    DocumentJobDeps,
    Limits,
    document_parse_definition,
)
from quiz_worker.document_store import DocumentBusyError, DocumentRow, JobRow
from quiz_worker.envelope import JobEnvelope
from quiz_worker.question_import_job import (
    IMPORT_FAILURE_MARKER,
    ImportJobDeps,
    build_llm,
    question_import_definition,
)
from quiz_worker.question_import_store import JOB_TYPE, DraftRow, RunRow, TerminalRunStatus
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import PARSED_BUCKET
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import FakeClock
from .document_fakes import PDF_DIR, FakeDocumentStore, FakeStorage, memory_index

PAPER = (PDF_DIR / "questions-ko.pdf").read_bytes()
TRUTH = sorted(PDF_DIR.glob("*.truth.json"))


@dataclass
class FakeImportStore:
    runs: dict[uuid.UUID, RunRow] = field(default_factory=dict)
    drafts: dict[tuple[uuid.UUID, int], DraftRow] = field(default_factory=dict)
    jobs_per_run: dict[uuid.UUID, int] = field(default_factory=dict)
    payloads: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    writable: bool = True
    statuses: list[str] = field(default_factory=list)
    llm: list[tuple[str | None, str | None]] = field(default_factory=list)
    progress: list[str] = field(default_factory=list)
    locked: set[uuid.UUID] = field(default_factory=set)
    on_progress: Callable[[str], object] | None = None
    _mutex: threading.Lock = field(default_factory=threading.Lock)

    @contextmanager
    def run_lock(
        self, run_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        with self._mutex:
            if run_id in self.locked:
                raise DocumentBusyError("busy")
            self.locked.add(run_id)
        try:
            yield
        finally:
            self.locked.discard(run_id)

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> RunRow | None:
        run = self.runs.get(run_id)
        return run if run is not None and run.workspace_id == workspace_id else None

    def job_count(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> int:
        return self.jobs_per_run.get(run_id, 0)

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        return self.writable

    def _set(self, run_id: uuid.UUID, status: str) -> None:
        self.runs[run_id] = replace(self.runs[run_id], status=status)
        self.statuses.append(status)

    def mark_running(self, run_id: uuid.UUID, job_id: uuid.UUID) -> None:
        run = self.runs[run_id]
        if run.async_job_id == job_id and run.status in {"queued", "running"}:
            self._set(run_id, "running")

    def insert_drafts(
        self, workspace_id: uuid.UUID, run_id: uuid.UUID, drafts: Sequence[DraftRow]
    ) -> int:
        created = 0
        for draft in drafts:
            if (run_id, draft.position) not in self.drafts:
                self.drafts[(run_id, draft.position)] = draft
                created += 1
        return created

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[DraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> int:
        if not self.writable:
            from quiz_worker.document_store import WorkspaceUnavailableError

            raise WorkspaceUnavailableError("no")
        before_commit()
        created = self.insert_drafts(workspace_id, run_id, drafts)
        self._set(run_id, "succeeded")
        self.llm.append((llm_model, prompt_version))
        return created

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None:
        run = self.runs[run_id]
        if run.async_job_id == job_id and run.status in {"queued", "running"}:
            self._set(run_id, status)

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        self.progress.append(stage)
        if self.on_progress is not None:
            self.on_progress(stage)

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        return self.payloads.get(job_id)

    def run_drafts(self, run_id: uuid.UUID) -> list[DraftRow]:
        return [
            d for (r, _), d in sorted(self.drafts.items(), key=lambda i: i[0][1]) if r == run_id
        ]


class World:
    def __init__(self) -> None:
        self.documents = FakeDocumentStore()
        self.storage = FakeStorage()
        self.imports = FakeImportStore()
        index, _ = memory_index()
        self.clock = FakeClock()
        self.jobs = InMemoryJobStore(clock=self.clock)
        self.documents.job_source = self._job_row
        self.runner = JobRunner(self.jobs, worker_id="unit", lease_seconds=60, clock=self.clock)
        self.parse = document_parse_definition(
            lambda: DocumentJobDeps(
                documents=self.documents,
                storage=self.storage,
                index=index,
                parser=FakeParser.from_truth_files(TRUTH),
                limits=Limits(lock_wait_seconds=0),
            )
        )
        self.deps = ImportJobDeps(
            imports=self.imports,
            documents=self.documents,
            storage=self.storage,
            inject_failures=True,
            lock_wait_seconds=0,
        )
        self.definition = question_import_definition(lambda: self.deps)
        self.user = uuid.uuid4()

    def _job_row(self, job_id: uuid.UUID) -> JobRow | None:
        record = self.jobs.get(job_id)
        if record is None:
            return None
        return JobRow(dict(record.payload), record.status.value, record.last_error)

    def paper(self, title: str = "questions-ko.pdf") -> DocumentRow:
        """A question paper parsed and published by `document.parse`."""
        document, revision = self.documents.add_document(
            PAPER, document_type="question_paper", title=title
        )
        self.storage.put_source(document, PAPER)
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type="document.parse",
            schema_version=1,
            idempotency_key=f"upload:{uuid.uuid4()}",
            workspace_id=document.workspace_id,
            created_by=self.user,
            payload={"document_id": str(document.id), "revision_id": str(revision.id)},
        )
        self.jobs.create(envelope, max_attempts=3)
        result = self.runner.run(self.parse, envelope.to_message())
        assert result.outcome is RunOutcome.SUCCEEDED, result.error
        return self.documents.documents[document.id]

    def start(self, document: DocumentRow, *, filename: str = "questions-ko.pdf") -> RunRow:
        assert document.active_revision_id is not None
        run = RunRow(
            id=uuid.uuid4(),
            workspace_id=document.workspace_id,
            created_by=self.user,
            status="queued",
            async_job_id=None,
            document_id=document.id,
            revision_id=document.active_revision_id,
            document_filename=filename,
            document_deleted=False,
        )
        self.imports.runs[run.id] = run
        return run

    def submit(self, run: RunRow) -> JobEnvelope:
        """A new job of the run (start or API retry): points the run at it."""
        attempt = self.imports.jobs_per_run.get(run.id, 0) + 1
        self.imports.jobs_per_run[run.id] = attempt
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"question_import:{run.id}:{attempt}",
            workspace_id=run.workspace_id,
            created_by=self.user,
            payload={"import_id": str(run.id)},
        )
        self.jobs.create(envelope, max_attempts=3)
        self.imports.payloads[envelope.job_id] = {"import_id": str(run.id)}
        current = self.imports.runs[run.id]
        self.imports.runs[run.id] = replace(current, async_job_id=envelope.job_id, status="queued")
        return envelope

    def run(self, envelope: JobEnvelope) -> Any:
        return self.runner.run(self.definition, envelope.to_message())


@pytest.fixture
def world() -> World:
    return World()


def test_import_extracts_one_pending_draft_per_question_with_provenance(world: World) -> None:
    document = world.paper()
    run = world.start(document)

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert result.record.result["drafts"] == 8
    assert world.imports.runs[run.id].status == "succeeded"
    assert world.imports.statuses == ["running", "succeeded"]
    drafts = world.imports.run_drafts(run.id)
    assert [d.position for d in drafts] == list(range(8))
    assert [d.question_number for d in drafts] == list(range(1, 9))
    assert [d.question_type for d in drafts] == [
        "MCQ", "MCQ", "MCQ", "SHORT_ANSWER", "MCQ", "SHORT_ANSWER", "ESSAY", "MCQ"
    ]  # fmt: skip
    # Answers only from the printed key: 3, 6 and 7 have none and are never filled in.
    answers = {
        d.question_number: (d.payload["correct_option_ids"], d.payload["accepted_answers"])
        for d in drafts
    }
    assert answers[1] == (["opt-2"], None)
    assert answers[2] == (["opt-A", "opt-C", "opt-D"], None)
    assert answers[4] == (None, ["응결"])
    for number in (3, 6, 7):
        assert answers[number] == (None, None)
        draft = drafts[number - 1]
        assert "answer_missing" in {v["code"] for v in draft.validations}
    assert [d.is_multi_answer for d in drafts] == [
        False, True, False, False, False, False, False, True
    ]  # fmt: skip
    # Provenance: the paper's pinned revision, its pages, and the canonical block ids of
    # content_blocks (not the parser's ids).
    assert document.active_revision_id is not None
    canonical = {row["block_id"] for row in world.documents.blocks[document.active_revision_id]}
    for draft in drafts:
        payload = draft.payload
        assert payload["origin"] == "pdf_import"
        assert payload["review_status"] == "pending"
        evidence = payload["evidence"][0]
        assert evidence["document_id"] == str(document.id)
        assert evidence["revision_id"] == str(document.active_revision_id)
        assert set(evidence["block_ids"]) <= canonical
        assert evidence["locations"][0]["page"] in {1, 2}
    assert world.imports.llm == [(None, None)]  # rule-based only by default


def test_a_redelivered_job_after_success_changes_nothing(world: World) -> None:
    run = world.start(world.paper())
    envelope = world.submit(run)
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    before = dict(world.imports.drafts)

    again = world.run(envelope)

    assert again.outcome is RunOutcome.DUPLICATE_FINISHED
    assert world.imports.drafts == before


def test_failure_marker_fails_the_first_job_after_half_and_the_retry_reconciles(
    world: World,
) -> None:
    run = world.start(world.paper(), filename=f"questions-ko-{IMPORT_FAILURE_MARKER}.pdf")
    first = world.submit(run)

    failed = world.run(first)

    assert failed.outcome is RunOutcome.FAILED
    assert failed.error is not None
    assert failed.error.startswith("import_failed")
    assert world.imports.runs[run.id].status == "failed"
    partial = world.imports.run_drafts(run.id)
    assert [d.position for d in partial] == [0, 1, 2, 3]  # the first half (A7)

    retry = world.submit(run)
    done = world.run(retry)

    assert done.outcome is RunOutcome.SUCCEEDED, done.error
    assert done.record.result["created"] == 4
    drafts = world.imports.run_drafts(run.id)
    assert [d.position for d in drafts] == list(range(8))
    # The kept drafts are the ones the failed job wrote (not replaced).
    assert all(drafts[i] is partial[i] for i in range(4))
    assert world.imports.runs[run.id].status == "succeeded"


def test_a_superseded_job_does_nothing(world: World) -> None:
    run = world.start(world.paper())
    old = world.submit(run)
    world.submit(run)  # retried meanwhile: the run points at the newer job

    result = world.run(old)

    assert result.outcome is RunOutcome.SUCCEEDED
    assert result.record.result["skipped"] == "superseded"
    assert world.imports.drafts == {}
    assert world.imports.runs[run.id].status == "queued"


def test_a_workspace_that_is_no_longer_writable_fails_the_run_without_drafts(
    world: World,
) -> None:
    run = world.start(world.paper())
    world.imports.writable = False

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.FAILED
    assert result.error is not None
    assert result.error.startswith("workspace_unavailable")
    assert world.imports.runs[run.id].status == "failed"
    assert world.imports.drafts == {}


def test_a_deleted_paper_fails_the_run(world: World) -> None:
    document = world.paper()
    run = world.start(document)
    world.documents.documents[document.id] = replace(document, deleted=True)

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.FAILED
    assert result.error is not None
    assert result.error.startswith("document_deleted")
    assert world.imports.runs[run.id].status == "failed"


def test_without_a_parse_artifact_the_revision_blocks_are_imported(world: World) -> None:
    document = world.paper()
    revision = world.documents.revisions[document.active_revision_id or uuid.uuid4()]
    assert revision.parsed_object_key is not None
    del world.storage.objects[(PARSED_BUCKET, revision.parsed_object_key)]
    run = world.start(document)

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    drafts = world.imports.run_drafts(run.id)
    assert len(drafts) == 8
    assert drafts[0].payload["correct_option_ids"] == ["opt-2"]


def test_cancel_while_running_marks_the_run_cancelled_and_keeps_drafts(world: World) -> None:
    run = world.start(world.paper())
    envelope = world.submit(run)
    world.imports.drafts[(run.id, 0)] = DraftRow(0, "MCQ", 1, False, {}, [])
    world.imports.on_progress = lambda stage: (
        world.jobs.request_cancel(envelope.job_id) if stage == "extracting" else None
    )

    result = world.run(envelope)

    assert result.outcome is RunOutcome.CANCELLED
    assert world.jobs.get(envelope.job_id).status is JobStatus.CANCELLED  # type: ignore[union-attr]
    # The cleanup obligation records the end; the persisted draft stays for a retry.
    assert world.imports.runs[run.id].status == "cancelled"
    assert list(world.imports.drafts) == [(run.id, 0)]


def test_the_import_job_is_registered_and_the_llm_is_opt_in() -> None:
    settings = WorkerSettings.model_construct(
        app_env=Environment.TEST, question_import_llm=False, task_always_eager=True
    )
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}
    assert build_llm(settings) == (None, None)
    # Never in APP_ENV=test, even when opted in.
    test_opt_in = WorkerSettings.model_construct(app_env=Environment.TEST, question_import_llm=True)
    assert build_llm(test_opt_in) == (None, None)


def test_a_printed_essay_answer_becomes_the_rubric_not_an_accepted_answer(world: World) -> None:
    """The key prints a model answer for essay question 7: the extractor reports it as text
    answers, the job stores it as the draft's rubric (never accepted_answers, codex P2)."""
    document = world.paper()
    assert document.active_revision_id is not None
    key = world.documents.revisions[document.active_revision_id].parsed_object_key
    assert key is not None
    parsed = ParsedDocument.model_validate_json(world.storage.objects[(PARSED_BUCKET, key)])
    blocks = list(parsed.blocks)
    last_key_line = next(i for i, b in enumerate(blocks) if b.text.startswith("8. B"))
    model = "도시화로 불투수면이 늘어 침투가 줄고 유출이 증가한다."
    blocks.insert(
        last_key_line + 1,
        blocks[last_key_line].model_copy(
            update={"text": f"7. {model}", "id": blocks[last_key_line].id + "-x"}
        ),
    )
    edited = parsed.model_copy(update={"blocks": tuple(blocks)})
    world.storage.objects[(PARSED_BUCKET, key)] = edited.model_dump_json().encode()
    run = world.start(document)

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    essay = world.imports.run_drafts(run.id)[6]
    assert essay.question_type == "ESSAY"
    assert essay.rubric == model
    assert essay.payload["accepted_answers"] is None
    assert "answer_missing" not in {v["code"] for v in essay.validations}


# -- UX6-UPLOAD-B: a mixed book whose import starts by itself yields every chapter's questions --


def _chapter_keys_book() -> ParsedDocument:
    """Three chapters, each with numbered headings, three exercises and its own answer key."""
    prose = "물은 증발과 응결을 거치며 지구 표면과 대기 사이를 끊임없이 순환한다. " * 3
    pages: list[list[str]] = []
    for chapter in range(1, 4):
        pages.append([f"# 제{chapter}장 물의 순환", "1. 개요", prose, prose, "2. 증발", prose])
        exercises = ["# 확인 문제"]
        for n in range(1, 4):
            exercises += [f"{n}. 제{chapter}장 {n}번: 다음 중 옳은 것은?", "① 가", "② 나", "③ 다"]
        pages.append([*exercises, "정답", "1. ③ 2. ① 3. ②"])
    data = b"%PDF-1.4 synthetic book with chapter keys"
    return document_from_pages(
        pages, source_path="book.pdf", source_sha256=hashlib.sha256(data).hexdigest()
    )


def test_ux6_auto_mixed_book_imports_the_questions_of_every_chapter(world: World) -> None:
    data = b"%PDF-1.4 synthetic book with chapter keys"
    parser = FakeParser.from_truth_files(TRUTH)
    parser.register(_chapter_keys_book())
    index, _ = memory_index("ux6_")
    parse = document_parse_definition(
        lambda: DocumentJobDeps(
            documents=world.documents,
            storage=world.storage,
            index=index,
            parser=parser,
            limits=Limits(lock_wait_seconds=0),
            page_counter=lambda _path: None,
        )
    )
    document, revision = world.documents.add_document(data, title="교재", type_source="auto")
    world.storage.put_source(document, data)
    envelope = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type="document.parse",
        schema_version=1,
        idempotency_key=f"upload:{uuid.uuid4()}",
        workspace_id=document.workspace_id,
        created_by=world.user,
        payload={"document_id": str(document.id), "revision_id": str(revision.id)},
    )
    world.jobs.create(envelope, max_attempts=3)
    parsed = world.runner.run(parse, envelope.to_message())
    assert parsed.outcome is RunOutcome.SUCCEEDED, parsed.error
    stored = world.documents.documents[document.id]
    assert (stored.document_type, stored.content_kind) == ("book", "mixed")
    assert document.id in world.documents.import_starts  # started by the publish

    run = world.start(stored, filename="book.pdf")
    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    exercises = [
        d for d in world.imports.run_drafts(run.id) if "다음 중 옳은 것은" in d.payload["stem"]
    ]
    assert [d.payload["stem"] for d in exercises] == [
        f"제{c}장 {n}번: 다음 중 옳은 것은?" for c in range(1, 4) for n in range(1, 4)
    ]
    assert [d.payload["correct_option_ids"] for d in exercises] == [
        ["opt-3"],
        ["opt-1"],
        ["opt-2"],
    ] * 3
