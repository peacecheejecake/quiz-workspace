"""`question.generate` with fakes (no DB): book-ko.pdf is parsed and published by the real
`document.parse` job over the document fakes, the LLM is the APP_ENV=test ScenarioLLMClient over
tests/fixtures/llm/generation-scenarios.json.

The same flow against the real stack (API, Postgres as quiz_worker) is
tests/integration/questions/test_generation_api_contract.py and test_generation_api.py.
"""

from __future__ import annotations

import json
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import QuestionDraft, ValidationSeverity
from book_core.generation import PROMPT_VERSIONS, source_fingerprint
from book_core.llm import LLMCallInfo, LLMProviderError, LLMRequest, LLMResult
from book_core.llm.scenarios import ScenarioLLMClient
from book_core.parser import FakeParser
from book_core.search import SearchService
from pydantic import BaseModel
from quiz_worker.celery_app import default_definitions
from quiz_worker.document_job import DocumentJobDeps, Limits, document_parse_definition
from quiz_worker.document_store import DocumentBusyError, DocumentRow, JobRow
from quiz_worker.envelope import JobEnvelope
from quiz_worker.question_generation_job import (
    GenerationJobDeps,
    build_generation_llm,
    question_generate_definition,
    run_prompt_version,
    source_question,
)
from quiz_worker.question_generation_store import (
    JOB_TYPE,
    GenerationDraftRow,
    GenerationRunRow,
    LiveDocument,
    QuestionContentRow,
    SearchableRevision,
    SourceQuestionRow,
    SourceRow,
    TerminalRunStatus,
)
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.store import InMemoryJobStore, JobStatus

from .conftest import FakeClock
from .document_fakes import PDF_DIR, FakeDocumentStore, FakeStorage, memory_index

BOOK = (PDF_DIR / "book-ko.pdf").read_bytes()
TRUTH = sorted(PDF_DIR.glob("*.truth.json"))
SCENARIO_FILE = Path(__file__).resolve().parents[3] / "tests/fixtures/llm/generation-scenarios.json"
SCENARIOS: dict[str, Any] = json.loads(SCENARIO_FILE.read_text(encoding="utf-8"))


@dataclass
class FakeGenerationStore:
    documents: FakeDocumentStore
    runs: dict[uuid.UUID, GenerationRunRow] = field(default_factory=dict)
    sources: dict[uuid.UUID, SourceQuestionRow] = field(default_factory=dict)
    questions: list[QuestionContentRow] = field(default_factory=list)
    drafts: dict[tuple[uuid.UUID, int], GenerationDraftRow] = field(default_factory=dict)
    provenance: dict[uuid.UUID, tuple[str | None, str | None, list[dict[str, Any]]]] = field(
        default_factory=dict
    )
    evidence: dict[uuid.UUID, list[dict[str, Any]]] = field(default_factory=dict)
    payloads: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    writable: bool = True
    statuses: list[str] = field(default_factory=list)
    locked: set[uuid.UUID] = field(default_factory=set)
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

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> GenerationRunRow | None:
        run = self.runs.get(run_id)
        return run if run is not None and run.workspace_id == workspace_id else None

    def load_source(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, revision_id: uuid.UUID
    ) -> SourceQuestionRow | None:
        found = self.sources.get(question_id)
        return found if found is not None and found.revision_id == revision_id else None

    def searchable_revisions(self, workspace_id: uuid.UUID) -> list[SearchableRevision]:
        out = []
        for doc in self.documents.documents.values():
            rev = self.documents.revisions.get(doc.active_revision_id)  # type: ignore[arg-type]
            live = doc.workspace_id == workspace_id and not doc.deleted
            if live and rev is not None and rev.published and doc.document_type != "question_paper":
                out.append(SearchableRevision(doc.id, rev.id))
        return out

    def live_documents(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> list[LiveDocument]:
        docs = self.documents.documents
        return [
            LiveDocument(d, docs[d].active_revision_id)
            for d in document_ids
            if d in docs and docs[d].workspace_id == workspace_id and not docs[d].deleted
        ]

    def workspace_questions(self, workspace_id: uuid.UUID) -> list[QuestionContentRow]:
        return list(self.questions)

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        return self.writable

    def _set(self, run_id: uuid.UUID, status: str) -> None:
        self.runs[run_id] = replace(self.runs[run_id], status=status)
        self.statuses.append(status)

    def mark_running(self, run_id: uuid.UUID, job_id: uuid.UUID) -> None:
        run = self.runs[run_id]
        if run.async_job_id == job_id and run.status in {"queued", "running"}:
            self._set(run_id, "running")

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[GenerationDraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        passages: list[dict[str, Any]],
        source_evidence: list[dict[str, Any]],
        before_commit: Callable[[], None],
    ) -> int:
        if not self.writable:
            from quiz_worker.document_store import WorkspaceUnavailableError

            raise WorkspaceUnavailableError("no")
        before_commit()
        created = 0
        for draft in drafts:
            if (run_id, draft.position) not in self.drafts:
                self.drafts[(run_id, draft.position)] = draft
                created += 1
        self._set(run_id, "succeeded")
        self.provenance[run_id] = (llm_model, prompt_version, passages)
        self.evidence[run_id] = source_evidence
        return created

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None:
        run = self.runs[run_id]
        if run.async_job_id == job_id and run.status in {"queued", "running"}:
            self._set(run_id, status)

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        pass

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        return self.payloads.get(job_id)

    def run_drafts(self, run_id: uuid.UUID) -> list[GenerationDraftRow]:
        ordered = sorted(self.drafts.items(), key=lambda i: i[0][1])
        return [d for (r, _), d in ordered if r == run_id]


class World:
    def __init__(self) -> None:
        self.documents = FakeDocumentStore()
        self.storage = FakeStorage()
        self.generations = FakeGenerationStore(self.documents)
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
        self.llm: Any = ScenarioLLMClient.from_file(SCENARIO_FILE)
        self.deps = GenerationJobDeps(
            generations=self.generations,
            documents=self.documents,
            llm=self.llm,
            lock_wait_seconds=0,
            search=SearchService(index),
        )
        self.definition = question_generate_definition(lambda: self.deps)
        self.user = uuid.uuid4()
        self.book = self._publish_book()

    def _job_row(self, job_id: uuid.UUID) -> JobRow | None:
        record = self.jobs.get(job_id)
        if record is None:
            return None
        return JobRow(dict(record.payload), record.status.value, record.last_error)

    def _publish_book(self) -> DocumentRow:
        document, revision = self.documents.add_document(BOOK, title="book-ko.pdf")
        self.storage.put_source(document, BOOK)
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

    @property
    def workspace_id(self) -> uuid.UUID:
        return self.book.workspace_id

    def source(
        self, name: str, *, page: int | None = None, cited: bool = True
    ) -> SourceQuestionRow:
        """The scenario source question (marker at the end of the stem) citing book-ko p.4."""
        s = SCENARIOS["sources"][name]
        page = s["source_page"] if page is None else page
        row = SourceQuestionRow(
            question_id=uuid.uuid4(),
            revision_id=uuid.uuid4(),
            question_type=s["question_type"],
            stem=f"{s['stem']} [{s['marker']}]",
            options=s["options"],
            correct_option_ids=s["correct_option_ids"],
            accepted_answers=None,
            is_multi_answer=s["is_multi_answer"],
            explanation=s["explanation"],
            sources=(SourceRow(self.book.id, self.book.active_revision_id, page, page, (), []),)
            if cited
            else (),
        )
        self.generations.sources[row.question_id] = row
        return row

    def start(self, source: SourceQuestionRow, *variations: str) -> GenerationRunRow:
        run = GenerationRunRow(
            id=uuid.uuid4(),
            workspace_id=self.workspace_id,
            created_by=self.user,
            status="queued",
            async_job_id=None,
            source_question_id=source.question_id,
            source_revision_id=source.revision_id,
            variation_types=variations,
            candidate_count=1,
            params={},
        )
        self.generations.runs[run.id] = run
        return run

    def submit(self, run: GenerationRunRow, *, max_attempts: int = 3) -> JobEnvelope:
        envelope = JobEnvelope(
            job_id=uuid.uuid4(),
            job_type=JOB_TYPE,
            schema_version=1,
            idempotency_key=f"question_generation:{run.id}:1",
            workspace_id=run.workspace_id,
            created_by=self.user,
            payload={"generation_id": str(run.id)},
        )
        self.jobs.create(envelope, max_attempts=max_attempts)
        self.generations.payloads[envelope.job_id] = {"generation_id": str(run.id)}
        current = self.generations.runs[run.id]
        self.generations.runs[run.id] = replace(
            current, async_job_id=envelope.job_id, status="queued"
        )
        return envelope

    def run(self, envelope: JobEnvelope) -> Any:
        return self.runner.run(self.definition, envelope.to_message())


@pytest.fixture
def world() -> World:
    return World()


def _payload(row: GenerationDraftRow) -> QuestionDraft:
    return QuestionDraft.model_validate(row.payload)


def _errors(row: GenerationDraftRow) -> set[str]:
    return {v["code"] for v in row.validations if v["severity"] == ValidationSeverity.ERROR.value}


def test_paraphrase_becomes_one_pending_draft_with_lineage_and_block_evidence(
    world: World,
) -> None:
    source = world.source("disinfection")
    run = world.start(source, "PARAPHRASE")

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert result.record.result == {
        "generation_id": str(run.id),
        "drafts": 1,
        "created": 1,
        "rejected": [],
    }
    assert world.generations.statuses == ["running", "succeeded"]
    [row] = world.generations.run_drafts(run.id)
    draft = _payload(row)
    assert row.position == 0
    assert row.question_type == "MCQ"
    assert row.is_multi_answer is False
    assert _errors(row) == set()
    assert draft.parent_question_id == str(source.question_id)
    assert draft.source_question_revision_id == str(source.revision_id)
    assert draft.variation_type is not None
    assert draft.variation_type.value == "PARAPHRASE"
    assert [o.id for o in draft.options] == ["opt-1", "opt-2", "opt-3", "opt-4"]
    assert draft.correct_option_ids == ("opt-1",)
    # The quote is narrowed from its passage (section 2.2 on p.4) to the block it occurs in.
    [evidence] = draft.evidence
    assert evidence.document_id == str(world.book.id)
    assert len(evidence.block_ids) == 1
    assert [loc.page for loc in evidence.locations] == [4]
    assert {loc.block_id for loc in evidence.locations} == set(evidence.block_ids)
    model, prompt_version, passages = world.generations.provenance[run.id]
    assert model == "fake-scenario-llm"
    assert prompt_version == PROMPT_VERSIONS[draft.variation_type]
    # One passage per section on p.4 (P1 intro, P2 2.1, P3 2.2): the scenario cites P3.
    assert len(passages) == 3
    assert "염소와 같은 소독제" in passages[2]["text"]
    assert set(evidence.block_ids) <= set(passages[2]["block_ids"])


def test_inversion_keeping_the_options_is_blocked_until_the_answer_is_resolved(
    world: World,
) -> None:
    run = world.start(world.source("not-correct"), "INVERT_POLARITY")
    assert world.run(world.submit(run)).outcome is RunOutcome.SUCCEEDED
    [row] = world.generations.run_drafts(run.id)
    assert "inverted_answer_mismatch" in _errors(row)
    assert row.is_multi_answer is False


@pytest.mark.parametrize("name", ["malformed", "schema-invalid"])
def test_invalid_llm_output_fails_the_run_without_drafts(world: World, name: str) -> None:
    run = world.start(world.source(name), "PARAPHRASE")
    result = world.run(world.submit(run))
    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("llm_output_invalid")
    assert world.generations.runs[run.id].status == "failed"
    assert world.generations.run_drafts(run.id) == []


def test_several_variations_in_one_run(world: World) -> None:
    run = world.start(world.source("disinfection"), "PARAPHRASE", "ANALOGOUS_CONCEPT")
    assert world.run(world.submit(run)).outcome is RunOutcome.SUCCEEDED
    rows = world.generations.run_drafts(run.id)
    assert [_payload(r).variation_type for r in rows] == ["PARAPHRASE", "ANALOGOUS_CONCEPT"]
    assert len({_payload(r).id for r in rows}) == 2
    _model, prompt_version, _passages = world.generations.provenance[run.id]
    assert prompt_version == "questions.generate/paraphrase/v1+analogous_concept/v1"
    assert run_prompt_version(["INVERT_POLARITY"]) == "questions.generate.invert_polarity/v1"


def test_a_duplicate_of_an_existing_question_is_not_drafted(world: World) -> None:
    candidate = SCENARIOS["scenarios"][0]["responses"]["questions.generate.paraphrase"][
        "candidates"
    ][0]
    world.generations.questions.append(
        QuestionContentRow(
            question_type="MCQ",
            stem=candidate["stem"],
            options=[{"id": f"x{o['label']}", "text": o["text"]} for o in candidate["options"]],
            correct_option_ids=["x1"],
            accepted_answers=None,
        )
    )
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    result = world.run(world.submit(run))
    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith("no_valid_candidates")
    assert world.generations.run_drafts(run.id) == []


def test_a_redelivered_job_of_a_finished_run_does_nothing(world: World) -> None:
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    envelope = world.submit(run)
    assert world.run(envelope).outcome is RunOutcome.SUCCEEDED
    calls = len(world.llm.calls)

    again = world.run(envelope)
    assert again.outcome is RunOutcome.DUPLICATE_FINISHED
    assert len(world.llm.calls) == calls
    assert len(world.generations.run_drafts(run.id)) == 1

    # A stale job of the run (another job owns it now) does nothing either.
    stale = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key=f"question_generation:{run.id}:stale",
        workspace_id=run.workspace_id,
        created_by=world.user,
        payload={"generation_id": str(run.id)},
    )
    world.jobs.create(stale, max_attempts=3)
    result = world.run(stale)
    assert result.outcome is RunOutcome.SUCCEEDED
    assert result.record.result == {"generation_id": str(run.id), "skipped": "superseded"}
    assert len(world.llm.calls) == calls


class FlakyLLM:
    """Fails the first `failures` calls like an unreachable provider, then answers."""

    def __init__(self, inner: ScenarioLLMClient, failures: int) -> None:
        self._inner = inner
        self.failures = failures

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        if self.failures > 0:
            self.failures -= 1
            raise LLMProviderError("provider unreachable", kind="connection")
        return self._inner.complete(request, schema)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


def test_provider_failures_are_retried_and_the_retry_drafts_once(world: World) -> None:
    world.deps.llm = FlakyLLM(world.llm, failures=1)
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    envelope = world.submit(run)

    first = world.run(envelope)
    assert first.outcome is RunOutcome.RETRY
    assert (first.error or "").startswith("llm_unavailable")
    assert world.generations.runs[run.id].status == "running"
    assert world.generations.run_drafts(run.id) == []

    world.clock.advance(3600)
    second = world.run(envelope)
    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    assert len(world.generations.run_drafts(run.id)) == 1
    assert world.generations.statuses == ["running", "running", "succeeded"]


def test_the_final_failed_attempt_marks_the_run_failed(world: World) -> None:
    world.deps.llm = FlakyLLM(world.llm, failures=5)
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    envelope = world.submit(run, max_attempts=1)
    result = world.run(envelope)
    assert result.outcome is RunOutcome.FAILED
    assert world.generations.runs[run.id].status == "failed"
    assert world.jobs.get(envelope.job_id).status is JobStatus.FAILED  # type: ignore[union-attr]


def test_refusals_before_any_llm_call(world: World) -> None:
    calls = len(world.llm.calls)
    # Workspace archived / membership revoked since the run started.
    world.generations.writable = False
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    result = world.run(world.submit(run))
    assert (result.error or "").startswith("workspace_unavailable")
    assert world.generations.runs[run.id].status == "failed"
    world.generations.writable = True

    # The source question was deleted.
    source = world.source("disinfection")
    run = world.start(source, "PARAPHRASE")
    del world.generations.sources[source.question_id]
    assert (world.run(world.submit(run)).error or "").startswith("source_question_deleted")

    # ANALOGOUS_CONCEPT needs passages: the source cites a page without text.
    world.deps.search = None
    run = world.start(world.source("disinfection", page=99), "ANALOGOUS_CONCEPT")
    assert (world.run(world.submit(run)).error or "").startswith("source_passages_missing")

    # Nothing indexed in the workspace either (another workspace's book is out of scope).
    world.deps.search = SearchService(memory_index("empty_")[0])
    run = world.start(world.source("disinfection", cited=False), "ANALOGOUS_CONCEPT")
    assert (world.run(world.submit(run)).error or "").startswith("source_passages_missing")

    # No LLM configured.
    world.deps.llm = None
    run = world.start(world.source("disinfection"), "PARAPHRASE")
    assert (world.run(world.submit(run)).error or "").startswith("llm_not_configured")
    assert len(world.llm.calls) == calls


def test_source_question_view_and_fingerprint(world: World) -> None:
    source = source_question(world.source("disinfection"))
    assert source.correct_option_ids == ("opt-1",)
    [evidence] = source.evidence
    assert [loc.page for loc in evidence.locations] == [4]
    assert len(source_fingerprint(source)) == 64


def test_the_job_is_registered_with_the_scenario_llm_in_test_only() -> None:
    settings = WorkerSettings.model_construct(app_env=Environment.LOCAL)
    assert JOB_TYPE in {d.job_type for d in default_definitions(settings)}
    test_env = WorkerSettings.model_construct(app_env=Environment.TEST, llm_scenario_file=None)
    assert isinstance(build_generation_llm(test_env), ScenarioLLMClient)


class CitingLLM:
    """Answers ANALOGOUS_CONCEPT with a candidate citing the first sentence of passage `tag`
    (whatever the search ranked there), so the test does not depend on ranking."""

    model_name = "fake-citing-llm"

    def __init__(self, tag: str = "P1") -> None:
        self.tag = tag
        self.prompts: list[str] = []

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        self.prompts.append(request.prompt)
        passage = request.prompt.split(f"[{self.tag}]", 1)[1].split("\n", 2)[1]
        quote = passage.split(". ")[0][:60]
        candidate = {
            "question_type": "MCQ",
            "multi_select": False,
            "stem": "다음 중 지문의 내용과 일치하는 것은? (유사 개념)",
            "options": [
                {"label": "1", "text": quote},
                {"label": "2", "text": "지문에 없는 설명"},
            ],
            "correct_option_labels": ["1"],
            "accepted_answers": None,
            "explanation": None,
            "justification": "지문에 그대로 나온다.",
            "citations": [{"passage_id": self.tag, "quote": quote}],
        }
        output = schema.model_validate({"candidates": [candidate]})
        info = LLMCallInfo(
            task=request.task,
            prompt_version=request.prompt_version,
            model=self.model_name,
            request_fingerprint="x",
        )
        return LLMResult(output=output, info=info)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


def test_analogous_without_cited_pages_uses_related_indexed_passages(world: World) -> None:
    world.deps.llm = CitingLLM()
    source = world.source("disinfection", cited=False)
    run = world.start(source, "ANALOGOUS_CONCEPT")

    result = world.run(world.submit(run))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    _model, _version, passages = world.generations.provenance[run.id]
    assert 1 <= len(passages) <= 8
    assert {p["document_id"] for p in passages} == {str(world.book.id)}
    # Related passages are distinct regions of the book.
    blocks = [b for p in passages for b in p["block_ids"]]
    assert len(blocks) == len(set(blocks))
    [row] = world.generations.run_drafts(run.id)
    [evidence] = _payload(row).evidence
    assert evidence.document_id == str(world.book.id)
    assert set(evidence.block_ids) <= set(passages[0]["block_ids"])
    assert _errors(row) == set()
    assert world.generations.evidence[run.id] == []


def test_analogous_with_cited_pages_appends_related_passages(world: World) -> None:
    run = world.start(world.source("disinfection"), "ANALOGOUS_CONCEPT")
    assert world.run(world.submit(run)).outcome is RunOutcome.SUCCEEDED
    _model, _version, passages = world.generations.provenance[run.id]
    # P1..P3 stay the cited page's sections; search adds other regions after them (cap 8).
    assert "염소와 같은 소독제" in passages[2]["text"]
    assert 3 < len(passages) <= 8
    blocks = [(p["revision_id"], b) for p in passages for b in p["block_ids"]]
    assert len(blocks) == len(set(blocks))
    # The source evidence snapshot is what re-validation of reviewer edits uses.
    [evidence] = world.generations.evidence[run.id]
    assert evidence["document_id"] == str(world.book.id)
    assert [loc["page"] for loc in evidence["locations"]] == [4]


class BrokenSearch:
    def search(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("index down")


def test_a_failing_index_is_retried_only_when_no_other_passage_exists(world: World) -> None:
    world.deps.search = BrokenSearch()  # type: ignore[assignment]
    run = world.start(world.source("disinfection", cited=False), "ANALOGOUS_CONCEPT")
    result = world.run(world.submit(run))
    assert result.outcome is RunOutcome.RETRY
    assert (result.error or "").startswith("search_unavailable")

    # With cited pages the run goes on with them.
    run = world.start(world.source("disinfection"), "ANALOGOUS_CONCEPT")
    assert world.run(world.submit(run)).outcome is RunOutcome.SUCCEEDED
    _model, _version, passages = world.generations.provenance[run.id]
    assert len(passages) == 3
