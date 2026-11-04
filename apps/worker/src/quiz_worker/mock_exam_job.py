"""`mock_exam.generate` v1: the questions of one mock exam generation (MOCK-B, MOCK-01,
docs/questions.md §11, architecture.md §6).

Payload (written by apps/api `POST /workspaces/{id}/mock-exams` and `POST /mock-exams/{id}/
generations`): `{generation_id}`. The generation pins its plan at request time (source question
revisions and variation types, seed); the job reads only those revisions. It runs for
`created_by` in the envelope's workspace and only as the generation's job (`job_id`).

Pipeline, serialised per mock exam by an advisory lock:

1. load the generation; skip one of another job or one that already finished; refuse a deleted
   mock exam (`mock_exam_unavailable`) or a workspace the user can no longer edit; AI variation
   types need the feature (`WORKER_MOCK_EXAMS`) and an LLM (`mock_llm_disabled`);
2. mark it running and create the per-item checkpoints once (`mock_exam_generation_items`);
3. `OPTION_SHUFFLE` items: the pinned revision copied with a seeded option order (no LLM);
4. AI items: each source's cited-page passages (`quiz_worker.question_sources`), packed
   into as few calls as the budgets allow (`book_core.mock_exam.pack_batches`); oversized
   sources are narrowed or skipped `source_too_large`. Batches run up to
   `MOCK_EXAM_GENERATION_CONCURRENCY` at a time; each answered batch is validated item by item
   (every `error` blocks) and checkpointed in one transaction. An unreadable or truncated answer
   is split in halves and re-requested (a one-source batch that fails again fails its item).
   After the first round every failed item is re-requested once, packed together; items failing
   again are skipped;
5. finish: `succeeded` / `partial` / `failed` (`no_valid_questions`), and a generation with
   questions becomes the mock exam's current one.

A provider failure stops scheduling, lets in-flight batches checkpoint and retries the job
(`llm_unavailable` / `llm_timeout` once attempts run out); the retry resumes from the checkpoints.
Every write re-checks the generation (cancelled by a delete) and the workspace.

The job result holds counts, usage (`llm_calls`, `batches`, tokens) and codes only; nothing here
logs or stores prompts or LLM output, and logs carry ids and counts only (MOCK-01-C07).

LLM (APP_ENV=test only): `book_core.llm.mock_exam_scenarios.MockExamScenarioLLM` over the
`mock_exam` block of tests/fixtures/llm/generation-scenarios.json (K5-K7 of
tests/e2e/fixtures/mock-exams.ts). Elsewhere the provider comes from `LLM_API_KEY` / `LLM_MODEL`.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import deque
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from book_core.contracts import DocumentRevision, Excerpt, QuestionType, VariationType
from book_core.generation import Difficulty, SourceQuestion
from book_core.llm import LLMCallInfo, LLMClient, LLMOutputError, LLMProviderError
from book_core.mock_exam import (
    PROMPT_VERSION,
    SOURCE_TOO_LARGE,
    BatchSource,
    Budget,
    ItemOutcome,
    LLMMockBatch,
    PackSource,
    PlanItem,
    base_prompt_text,
    batch_passage_tag,
    build_batch_request,
    check_batch,
    estimate_tokens,
    halves,
    pack_batches,
    shuffled_options,
    source_block,
    source_tag,
)
from book_core.mock_exam.prompts import passage_block
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.document_store import (
    DocumentStore,
    PostgresDocumentStore,
    WorkspaceUnavailableError,
)
from quiz_worker.errors import JobCancelledError, JobError, NonRetryableJobError, is_retryable
from quiz_worker.mock_exam_store import (
    JOB_TYPE,
    BatchWrite,
    ItemRow,
    MadeQuestion,
    MockExamUnavailableError,
    PinnedSource,
    PostgresMockExamStore,
)
from quiz_worker.question_sources import (
    PublishedContents,
    build_passages,
    narrow_evidence_items,
    source_pages,
    source_question,
    workspace_fingerprints,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

_REPO_SCENARIOS = (
    Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "llm" / "generation-scenarios.json"
)
MAX_PASSAGES_PER_SOURCE = 8
DIFFICULTIES = {"easy": Difficulty.EASIER, "medium": Difficulty.SAME, "hard": Difficulty.HARDER}


class GenerationNotFoundError(NonRetryableJobError):
    code = "generation_not_found"


class MockLLMDisabledError(NonRetryableJobError):
    code = "mock_llm_disabled"


class LLMUnavailableError(JobError):
    """Provider failures (network, 5xx, rate limit): the job is retried."""

    code = "llm_unavailable"


class LLMTimeoutError(JobError):
    code = "llm_timeout"


class MockExamGeneratePayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    generation_id: uuid.UUID


@dataclass
class MockExamJobDeps:
    store: PostgresMockExamStore
    documents: DocumentStore
    llm: LLMClient | None
    enabled: bool = True
    budget: Budget = field(default_factory=Budget)
    concurrency: int = 2
    lock_wait_seconds: float = 60


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def error_code_of(exc: BaseException) -> str:
    return exc.code if isinstance(exc, JobError) else "unexpected_error"


def run_mock_exam_generation(
    deps: MockExamJobDeps, ctx: JobContext, payload: MockExamGeneratePayloadV1
) -> JobResult:
    generation = deps.store.load_generation(ctx.workspace_id, payload.generation_id)
    if generation is None:
        raise GenerationNotFoundError("mock exam generation not found in this workspace")
    try:
        with deps.store.run_lock(
            generation.mock_exam_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
        ):
            return _Pipeline(deps, ctx, payload).run()
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            _mark(deps, payload.generation_id, ctx.job_id, error_code_of(exc))
        raise


def _mark(deps: MockExamJobDeps, generation_id: uuid.UUID, job_id: uuid.UUID, code: str) -> None:
    try:
        deps.store.mark_terminal(generation_id, job_id, "failed", code)
    except Exception as exc:
        # The cleanup obligation marks it again.
        logger.warning("could not record the mock exam failure: %s", type(exc).__name__)


@dataclass(frozen=True)
class _Task:
    positions: tuple[int, ...]
    retry: bool


@dataclass
class _Answer:
    task: _Task
    sources: list[BatchSource]
    passages: list[Excerpt]
    output: LLMMockBatch | None = None
    info: LLMCallInfo | None = None
    unreadable: bool = False
    provider_error: LLMProviderError | None = None


class _Pipeline:
    def __init__(
        self, deps: MockExamJobDeps, ctx: JobContext, payload: MockExamGeneratePayloadV1
    ) -> None:
        self.deps = deps
        self.ctx = ctx
        self.payload = payload
        self.model: str | None = None
        self._failed: set[int] = set()

    # -- top level ------------------------------------------------------------------------------

    def run(self) -> JobResult:
        deps, ctx = self.deps, self.ctx
        generation = deps.store.load_generation(ctx.workspace_id, self.payload.generation_id)
        if generation is None:
            raise GenerationNotFoundError("mock exam generation not found in this workspace")
        if generation.job_id != ctx.job_id:
            return {"generation_id": str(generation.id), "skipped": "superseded"}
        if generation.status not in {"queued", "running"}:
            return {"generation_id": str(generation.id), "skipped": generation.status}
        if generation.exam_deleted:
            raise MockExamUnavailableError("the mock exam was deleted")
        if not deps.store.workspace_writable(ctx.workspace_id, ctx.created_by):
            raise WorkspaceUnavailableError("the workspace is no longer writable")
        plan = [PlanItem.from_json(p) for p in generation.plan]
        ai = any(p.variation_type is not VariationType.OPTION_SHUFFLE for p in plan)
        if ai and (not deps.enabled or deps.llm is None):
            raise MockLLMDisabledError("AI variation types are off here (WORKER_MOCK_EXAMS / LLM)")
        self.generation = generation
        self.plan = {p.position: p for p in plan}
        self.difficulty = DIFFICULTIES.get(str(generation.config.get("difficulty") or ""))
        items = deps.store.start(generation, ctx.job_id, generation.plan)
        open_items = {i.position: i for i in items if i.status in {"pending", "failed"}}
        self.pinned = deps.store.load_sources(
            ctx.workspace_id, [i.source_question_revision_id for i in open_items.values()]
        )
        ctx.check_cancelled()

        self._shuffle(open_items)
        llm_items = {
            p: i
            for p, i in open_items.items()
            if i.variation_type != VariationType.OPTION_SHUFFLE.value
        }
        if llm_items:
            self._generate(llm_items)
        ctx.check_cancelled()
        status, created, skipped = deps.store.finish(
            generation,
            ctx.job_id,
            ctx.created_by,
            model=(self.model or "")[:200] or None,
            prompt_version=PROMPT_VERSION if ai else None,
            before_commit=ctx.check_cancelled,
        )
        calls, batches, input_tokens, output_tokens = deps.store.usage(generation.id)
        logger.info(
            "mock exam generated generation=%s status=%s created=%d skipped=%d calls=%d batches=%d",
            generation.id,
            status,
            created,
            skipped,
            calls,
            batches,
        )
        return {
            "generation_id": str(generation.id),
            "status": status,
            "created_count": created,
            "skipped_count": skipped,
            "usage": {
                "llm_calls": calls,
                "batches": batches,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
            "error_code": "no_valid_questions" if status == "failed" else None,
        }

    def _store(self, write: BatchWrite) -> None:
        self.deps.store.store_batch(
            self.generation,
            self.ctx.job_id,
            self.ctx.created_by,
            write,
            before_commit=self.ctx.check_cancelled,
        )

    # -- OPTION_SHUFFLE -------------------------------------------------------------------------

    def _shuffle(self, open_items: dict[int, ItemRow]) -> None:
        write = BatchWrite()
        for position, item in sorted(open_items.items()):
            if item.variation_type != VariationType.OPTION_SHUFFLE.value:
                continue
            pinned = self.pinned.get(item.source_question_revision_id)
            if pinned is None:
                write.settled[position] = ("skipped", "source_missing")
                continue
            row = pinned.row
            source = source_question(row)
            write.made.append(
                MadeQuestion(
                    position=position,
                    question_type=row.question_type,
                    variation_type=item.variation_type,
                    source_question_id=row.question_id,
                    source_question_revision_id=row.revision_id,
                    stem=row.stem,
                    options=shuffled_options(row.options, self.generation.seed, position),
                    correct_option_ids=row.correct_option_ids,
                    accepted_answers=row.accepted_answers,
                    is_multi_answer=row.is_multi_answer,
                    explanation=row.explanation,
                    rubric=pinned.rubric,
                    evidence=[e.model_dump(mode="json") for e in source.evidence],
                    validation_issues=[],
                )
            )
        if write.made or write.settled:
            self._store(write)

    # -- AI variation types ---------------------------------------------------------------------

    def _generate(self, items: dict[int, ItemRow]) -> None:
        deps, ctx = self.deps, self.ctx
        assert deps.llm is not None  # noqa: S101 - checked in run()
        self.llm = deps.llm
        self.contents = PublishedContents(deps.documents, ctx.workspace_id)
        self.sources: dict[int, SourceQuestion] = {}
        self.source_passages: dict[int, list[str]] = {}
        self.passages: dict[str, Excerpt] = {}
        missing = BatchWrite()
        for position, item in sorted(items.items()):
            pinned = self.pinned.get(item.source_question_revision_id)
            if pinned is None:
                missing.settled[position] = ("skipped", "source_missing")
                continue
            self.sources[position] = source_question(pinned.row)
            self.source_passages[position] = self._passages_of(pinned)
        if missing.settled:
            self._store(missing)
        fingerprints = workspace_fingerprints(deps.store.workspace_questions(ctx.workspace_id))
        self.existing = fingerprints
        self.siblings = set(
            workspace_fingerprints(deps.store.generation_questions(self.generation.id))
        )
        first = [p for p, i in items.items() if i.status == "pending" and p in self.sources]
        again = [p for p, i in items.items() if i.status == "failed" and p in self.sources]
        self._round(first, retry=False)
        self._round(sorted(self._failed | set(again)), retry=True)

    def _passages_of(self, pinned: PinnedSource) -> list[str]:
        keys: list[str] = []
        pages = source_pages(pinned.row)
        for document_id, revision_id in self.deps.store.live_documents(
            self.ctx.workspace_id, list(pages)
        ):
            if revision_id is None:
                continue
            found = self.contents.get(document_id, revision_id)
            if found is None:
                continue
            content, title = found
            for passage in build_passages(content, pages[document_id], title=title):
                key = f"{passage.revision_id}:{','.join(passage.block_ids)}"
                self.passages.setdefault(key, passage)
                if key not in keys:
                    keys.append(key)
        return keys[:MAX_PASSAGES_PER_SOURCE]

    def _round(self, positions: list[int], *, retry: bool) -> None:
        if not positions:
            return
        budget = self.deps.budget
        budget = Budget(
            max_prompt_tokens=budget.max_prompt_tokens,
            max_output_tokens=budget.max_output_tokens,
            sources_per_call=budget.sources_per_call,
            output_tokens_per_item=budget.output_tokens_per_item,
            base_prompt_tokens=estimate_tokens(base_prompt_text(self.difficulty)),
        )
        packed = pack_batches(
            [
                PackSource(
                    position=p,
                    chapter_rank=self.plan[p].chapter_rank,
                    source_tokens=self._source_tokens(p),
                    passages=tuple(self.source_passages[p]),
                    requires_passage=self.plan[p].variation_type is VariationType.ANALOGOUS_CONCEPT,
                )
                for p in positions
            ],
            {k: estimate_tokens(passage_block("P00", v)) for k, v in self.passages.items()},
            budget,
        )
        for position, kept in packed.narrowed.items():
            self.source_passages[position] = list(kept)
        if packed.too_large:
            write = BatchWrite()
            for position in packed.too_large:
                write.settled[position] = ("skipped", SOURCE_TOO_LARGE)
                self._failed.discard(position)
            self._store(write)
        if retry:
            self._failed -= set(positions)
        self.deps.store.set_batches_total(self.generation.id, self.ctx.job_id, len(packed.batches))
        self._run([_Task(b.positions, retry) for b in packed.batches])

    def _source_tokens(self, position: int) -> int:
        item = BatchSource(
            tag="S00",
            position=position,
            source=self.sources[position],
            variation_type=self.plan[position].variation_type,
            passage_tags=tuple("P00" for _ in self.source_passages[position]),
        )
        return estimate_tokens(source_block(item)) + 8

    # -- calls ----------------------------------------------------------------------------------

    def _build(self, task: _Task) -> tuple[list[BatchSource], list[Excerpt]]:
        keys: list[str] = []
        for position in task.positions:
            for key in self.source_passages[position]:
                if key not in keys:
                    keys.append(key)
        tags = {key: batch_passage_tag(i) for i, key in enumerate(keys)}
        sources = [
            BatchSource(
                tag=source_tag(i),
                position=position,
                source=self.sources[position],
                variation_type=self.plan[position].variation_type,
                passage_tags=tuple(tags[k] for k in self.source_passages[position]),
            )
            for i, position in enumerate(task.positions)
        ]
        return sources, [self.passages[k] for k in keys]

    def _call(self, task: _Task) -> _Answer:
        sources, passages = self._build(task)
        answer = _Answer(task=task, sources=sources, passages=passages)
        request = build_batch_request(sources, passages, difficulty=self.difficulty)
        try:
            result = self.llm.complete(request, LLMMockBatch)
        except LLMOutputError as exc:
            answer.unreadable, answer.info = True, exc.call_info
        except LLMProviderError as exc:
            if exc.kind == "max_tokens":
                answer.unreadable = True
            else:
                answer.provider_error = exc
        else:
            answer.output, answer.info = result.output, result.info
        return answer

    def _run(self, tasks: list[_Task]) -> None:
        pending: deque[_Task] = deque(tasks)
        error: JobError | None = None
        concurrency = max(1, self.deps.concurrency)
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="mock-exam") as pool:
            running: dict[Future[_Answer], _Task] = {}
            while pending or running:
                while pending and error is None and len(running) < concurrency:
                    self.ctx.check_cancelled()
                    task = pending.popleft()
                    running[pool.submit(self._call, task)] = task
                if not running:
                    break
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in done:
                    running.pop(future)
                    answer = future.result()  # a BaseException (e.g. a kill) propagates
                    if answer.provider_error is not None:
                        error = error or _provider_error(answer.provider_error)
                        continue
                    pending.extendleft(reversed(self._settle(answer)))
            if error is not None:
                raise error

    def _settle(self, answer: _Answer) -> list[_Task]:
        """Checkpoints one answered call; returns the halves of an unreadable one."""
        task = answer.task
        write = BatchWrite(llm_calls=1)
        if answer.info is not None:
            self.model = self.model or answer.info.model
            write.input_tokens = answer.info.usage.input_tokens
            write.output_tokens = answer.info.usage.output_tokens
        follow: list[_Task] = []
        if answer.unreadable or answer.output is None:
            if len(task.positions) > 1:
                first, second = halves(task.positions)
                follow = [_Task(first, task.retry), _Task(second, task.retry)]
            else:
                self._fail(write, task, task.positions[0], "llm_output_invalid")
            self._store(write)
            return follow
        write.batches_done = 1
        outcomes = check_batch(
            answer.output,
            answer.sources,
            answer.passages,
            existing_fingerprints=self.existing,
            sibling_fingerprints=self.siblings,
        )
        for outcome in outcomes:
            if outcome.accepted:
                write.made.append(self._made(outcome))
            else:
                self._fail(write, task, outcome.position, (outcome.codes or ("invalid",))[0])
        self._store(write)
        for made in write.made:
            self._failed.discard(made.position)
        return follow

    def _fail(self, write: BatchWrite, task: _Task, position: int, code: str) -> None:
        if task.retry:
            write.settled[position] = ("skipped", code[:64])
            self._failed.discard(position)
        else:
            write.settled[position] = ("failed", code[:64])
            self._failed.add(position)

    def _made(self, outcome: ItemOutcome) -> MadeQuestion:
        content = outcome.content
        assert content is not None  # noqa: S101 - accepted outcomes carry content
        self.siblings.add(content.fingerprint())
        plan = self.plan[outcome.position]
        source = self.sources[outcome.position]
        revisions: dict[str, DocumentRevision] = self.contents.revisions
        evidence = narrow_evidence_items(content.evidence, revisions)
        multi = content.question_type is QuestionType.MCQ and (
            len(content.correct_option_ids or ()) > 1
        )
        return MadeQuestion(
            position=outcome.position,
            question_type=content.question_type.value,
            variation_type=plan.variation_type.value,
            source_question_id=uuid.UUID(source.question_id),
            source_question_revision_id=uuid.UUID(source.revision_id),
            stem=content.stem,
            options=[{"id": o.id, "text": o.text} for o in content.options],
            correct_option_ids=list(content.correct_option_ids)
            if content.correct_option_ids is not None
            else None,
            accepted_answers=list(content.accepted_answers)
            if content.accepted_answers is not None
            else None,
            is_multi_answer=multi,
            explanation=content.explanation,
            rubric=None,
            evidence=[e.model_dump(mode="json") for e in evidence],
            validation_issues=[
                {"code": i.code, "severity": i.severity.value, "field": i.field}
                for i in outcome.issues
            ],
        )


def _provider_error(exc: LLMProviderError) -> JobError:
    if exc.kind == "timeout":
        return LLMTimeoutError("the LLM provider timed out")
    return LLMUnavailableError(f"the LLM provider call failed ({exc.kind})")


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_mock_exam_generation(
    deps: MockExamJobDeps, ctx: JobContext, reason: TerminalReason
) -> None:
    """Records the generation's end if this job still owns it."""
    payload = deps.store.job_payload(ctx.job_id)
    if payload is None:
        return
    try:
        parsed = MockExamGeneratePayloadV1.model_validate(payload)
    except ValidationError:
        return
    if reason == "cancelled":
        deps.store.mark_terminal(parsed.generation_id, ctx.job_id, "cancelled", "cancelled")
    else:
        deps.store.mark_terminal(parsed.generation_id, ctx.job_id, "failed", "job_failed")


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], MockExamJobDeps]


def mock_exam_generate_definition(
    provider: DepsProvider,
) -> JobDefinition[MockExamGeneratePayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: MockExamGeneratePayloadV1},
        handler=lambda ctx, payload: run_mock_exam_generation(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_mock_exam_generation(provider(), ctx, reason),
    )


def build_mock_exam_llm(settings: WorkerSettings) -> LLMClient | None:
    """APP_ENV=test: the batched scenario fake (never a real provider). Elsewhere the configured
    provider, or None when `LLM_API_KEY` is unset."""
    from book_core.llm import LLMConfig, LLMConfigError, create_llm_client

    if settings.is_test:
        from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM

        path = Path(settings.llm_scenario_file) if settings.llm_scenario_file else _REPO_SCENARIOS
        if not path.is_file():
            raise WorkerNotConfiguredError("LLM scenario file not found (WORKER_LLM_SCENARIO_FILE)")
        return MockExamScenarioLLM.from_file(
            path,
            hold_dir=Path(settings.mock_exam_hold_dir) if settings.mock_exam_hold_dir else None,
            fault_dir=Path(settings.mock_exam_fault_dir) if settings.mock_exam_fault_dir else None,
            max_output_tokens=settings.mock_exam_max_output_tokens,
        )
    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    if config is None:
        return None
    # A dedicated client: its output ceiling is the mock exam output budget the batches are
    # packed for (MOCK_EXAM_MAX_OUTPUT_TOKENS <= LLM_MAX_TOKENS, checked by the settings).
    config = config.model_copy(update={"max_tokens": settings.mock_exam_max_output_tokens})
    return create_llm_client(config)


def budget_from_settings(settings: WorkerSettings) -> Budget:
    return Budget(
        max_prompt_tokens=settings.mock_exam_max_prompt_tokens,
        max_output_tokens=settings.mock_exam_max_output_tokens,
        sources_per_call=settings.mock_exam_sources_per_call,
    )


def mock_exam_deps(settings: WorkerSettings, engine: Any) -> MockExamJobDeps:
    return MockExamJobDeps(
        store=PostgresMockExamStore(engine),
        documents=PostgresDocumentStore(engine),
        llm=build_mock_exam_llm(settings) if settings.mock_exams else None,
        enabled=settings.mock_exams,
        budget=budget_from_settings(settings),
        concurrency=settings.mock_exam_generation_concurrency,
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


def deps_from_settings(settings: WorkerSettings) -> MockExamJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2 + settings.mock_exam_generation_concurrency,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return mock_exam_deps(settings, engine)


class LazyMockExamDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: MockExamJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> MockExamJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
