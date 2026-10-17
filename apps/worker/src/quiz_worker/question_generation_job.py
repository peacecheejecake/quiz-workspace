"""`question.generate` v1: LLM variant drafts of one CONFIRMED question (M6.2, QGEN-01).

Payload (written by apps/api `POST /questions/{id}/generations`): `{generation_id}`. The run pins
the source question revision, the variation types and the candidate count; the job runs for
`created_by` in the envelope's workspace and only for the run's current job
(`question_generation_runs.async_job_id`).

Pipeline, serialised per run by an advisory lock:

1. load the run; refuse a run of another job and a workspace that is archived/deleted or that the
   job's user can no longer edit (`workspace_unavailable`, re-checked under a lock in step 5);
   the source question must still be live (`source_question_deleted`); mark the run `running`;
2. passages: the published blocks of the source question's `sources` pages, read from each live
   document's *active* revision, one paragraph-complete excerpt per section on those pages in
   reading order (tagged P1..Pn for the LLM, at most `MAX_PASSAGES`);
3. `VariantGenerator` (book_core.generation): one structured LLM call per variation type, then
   schema, answer-count, duplicate-fingerprint (against every live question of the workspace)
   and citation checks. The LLM's declared answer is never trusted: blocking validations stay
   on the draft and only a human approval (API) can make it a question;
4. each cited quote is narrowed to the block(s) it occurs in (block ids + their locations);
5. in one transaction: re-check workspace access (rows locked FOR SHARE), insert the drafts
   (pending; position = order of generation), record model/prompt provenance and the passages
   (for re-validation of reviewer edits) and mark the run `succeeded`.

A run where no candidate survives fails with the most specific code: `llm_output_invalid` (the
model output did not match the schema), `llm_unavailable` (provider errors; retried), or
`no_valid_candidates`. Partial results succeed; the job result lists rejection codes only.

Fake LLM (APP_ENV=test only, implementation-plan §7): `ScenarioLLMClient` answers from
tests/fixtures/llm/generation-scenarios.json by the marker in the source stem
(tests/e2e/fixtures/generation.ts G1). Elsewhere the provider comes from `LLM_API_KEY` /
`LLM_MODEL` (no model default); without it the job fails `llm_not_configured`.

Nothing here logs or returns question or book text: logs and results carry ids, counts and codes.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.contracts import (
    BlockType,
    DocumentRevision,
    Excerpt,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    SourceEvidence,
    VariationType,
)
from book_core.generation import (
    MAX_PASSAGES,
    MAX_SOURCE_PAGES,
    PROMPT_VERSIONS,
    Difficulty,
    SourceQuestion,
    VariantGenerationResult,
    VariantGenerator,
    VariantRequest,
    stored_source_evidence,
)
from book_core.llm import LLMClient
from book_core.question import normalize_text, question_fingerprint
from book_core.search.excerpt import ExcerptConfig, ExcerptError, ExcerptResolver
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.document_store import (
    DocumentStore,
    PostgresDocumentStore,
    WorkspaceUnavailableError,
)
from quiz_worker.errors import JobCancelledError, JobError, NonRetryableJobError, is_retryable
from quiz_worker.question_generation_store import (
    JOB_TYPE,
    GenerationDraftRow,
    GenerationStore,
    PostgresGenerationStore,
    SourceQuestionRow,
    TerminalRunStatus,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

_REPO_SCENARIOS = (
    Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "llm" / "generation-scenarios.json"
)
# One passage is a section's text on the source pages; generous so a page is rarely cut.
PASSAGE_MAX_CHARS = 6000


class GenerationNotFoundError(NonRetryableJobError):
    code = "generation_not_found"


class SourceQuestionDeletedError(NonRetryableJobError):
    code = "source_question_deleted"


class SourcePassagesMissingError(NonRetryableJobError):
    code = "source_passages_missing"


class LLMNotConfiguredError(NonRetryableJobError):
    code = "llm_not_configured"


class LLMOutputInvalidError(NonRetryableJobError):
    code = "llm_output_invalid"


class LLMUnavailableError(JobError):
    """Provider failures (network, 5xx, rate limit): the job is retried."""

    code = "llm_unavailable"


class NoValidCandidatesError(NonRetryableJobError):
    code = "no_valid_candidates"


class QuestionGeneratePayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    generation_id: uuid.UUID


@dataclass
class GenerationJobDeps:
    generations: GenerationStore
    documents: DocumentStore
    llm: LLMClient | None
    lock_wait_seconds: float = 60


# --------------------------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------------------------


def source_question(row: SourceQuestionRow) -> SourceQuestion:
    """The core view of the pinned source revision, with its sources as page provenance."""
    question_type = QuestionType(row.question_type)
    return SourceQuestion(
        question_id=str(row.question_id),
        revision_id=str(row.revision_id),
        question_type=question_type,
        stem=row.stem,
        options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in row.options),
        correct_option_ids=tuple(row.correct_option_ids)
        if row.correct_option_ids is not None
        else None,
        accepted_answers=tuple(a for a in row.accepted_answers if a.strip())
        if row.accepted_answers
        else None,
        is_multi_answer=row.is_multi_answer,
        explanation=row.explanation,
        evidence=tuple(_source_evidence(row)),
    )


def _source_evidence(row: SourceQuestionRow) -> Iterable[SourceEvidence]:
    for source in row.sources:
        if source.document_id is None:
            continue
        evidence = stored_source_evidence(
            document_id=str(source.document_id),
            revision_id=str(source.document_revision_id) if source.document_revision_id else None,
            page_start=source.page_start,
            page_end=source.page_end,
            block_ids=source.block_ids,
            locations=source.locations,
        )
        if evidence is not None:
            yield evidence


def source_pages(row: SourceQuestionRow) -> dict[uuid.UUID, set[int]]:
    """document id -> pages the source question cites (page ranges and located blocks)."""
    pages: dict[uuid.UUID, set[int]] = {}
    for source in row.sources:
        if source.document_id is None:
            continue
        found = pages.setdefault(source.document_id, set())
        if source.page_start is not None:
            end = min(source.page_end or source.page_start, source.page_start + MAX_SOURCE_PAGES)
            found.update(range(source.page_start, end + 1))
        for raw in source.locations:
            page = raw.get("page") if isinstance(raw, dict) else None
            if isinstance(page, int) and page > 0:
                found.add(page)
    return {doc: p for doc, p in pages.items() if p}


def build_passages(
    revision: DocumentRevision, pages: set[int], *, title: str | None = None
) -> list[Excerpt]:
    """One excerpt per section on `pages`, in reading order: the section's non-heading blocks
    located on those pages (a table/figure travels with its caption)."""
    resolver = ExcerptResolver(revision, document_title=title)
    config = ExcerptConfig(context_before=0, context_after=0, max_chars=PASSAGE_MAX_CHARS)
    groups: list[list[str]] = []
    last_section: object = object()
    for block in revision.blocks:
        if block.type is BlockType.HEADING:
            continue
        if not block.text.strip() and block.caption_block_id is None:
            continue
        if not any(loc.page in pages for loc in block.locations):
            continue
        if block.section_id != last_section or not groups:
            groups.append([])
            last_section = block.section_id
        groups[-1].append(block.id)
    passages: list[Excerpt] = []
    for ids in groups:
        try:
            passages.append(resolver.resolve(ids, config=config))
        except ExcerptError:
            continue
    return passages


def narrow_evidence(draft: QuestionDraft, revisions: dict[str, DocumentRevision]) -> QuestionDraft:
    """Each quoted evidence points at the block(s) of its passage that contain the quote."""
    narrowed: list[SourceEvidence] = []
    for evidence in draft.evidence:
        revision = revisions.get(f"{evidence.document_id}:{evidence.revision_id}")
        if evidence.quote is None or revision is None:
            narrowed.append(evidence)
            continue
        needle = normalize_text(evidence.quote)
        texts = {b.id: b.text for b in revision.blocks}
        hits = tuple(b for b in evidence.block_ids if needle in normalize_text(texts.get(b, "")))
        locations = tuple(loc for loc in evidence.locations if loc.block_id in hits)
        if not hits or not locations:
            narrowed.append(evidence)
            continue
        narrowed.append(evidence.model_copy(update={"block_ids": hits, "locations": locations}))
    return QuestionDraft.model_validate(
        {**draft.model_dump(), "evidence": [e.model_dump() for e in narrowed]}
    )


def draft_row(position: int, draft: QuestionDraft) -> GenerationDraftRow:
    multi = draft.question_type is QuestionType.MCQ and len(draft.correct_option_ids or ()) > 1
    return GenerationDraftRow(
        position=position,
        question_type=draft.question_type.value,
        is_multi_answer=multi,
        payload=draft.model_dump(mode="json"),
        validations=[v.model_dump(mode="json") for v in draft.validations],
    )


def run_prompt_version(variation_types: Sequence[str]) -> str:
    """The run's prompt provenance: the variation's prompt version, or a compact list of them
    (`questions.generate/paraphrase/v1+...`) for several variations. Drafts carry their own."""
    versions = [PROMPT_VERSIONS[VariationType(v)] for v in variation_types]
    if len(versions) == 1:
        return versions[0]
    return "questions.generate/" + "+".join(v.removeprefix("questions.generate.") for v in versions)


def _difficulty(value: object) -> Difficulty | None:
    try:
        return Difficulty(value) if isinstance(value, str) else None
    except ValueError:
        return None


def failure_for(result: VariantGenerationResult) -> JobError:
    """Why a run without any draft failed (most specific code first)."""
    found = {code for r in result.rejected for code in (i.code for i in r.reasons)}
    if "llm_output_invalid" in found:
        return LLMOutputInvalidError("the LLM output does not match the variant schema")
    if found and found <= {"llm_unavailable"}:
        return LLMUnavailableError("the LLM provider call failed")
    return NoValidCandidatesError("no candidate passed validation")


def workspace_fingerprints(rows: Iterable[Any]) -> frozenset[str]:
    out: set[str] = set()
    for row in rows:
        try:
            out.add(
                question_fingerprint(
                    question_type=QuestionType(row.question_type),
                    stem=row.stem,
                    options=[QuestionOption(id=o["id"], text=o["text"]) for o in row.options],
                    correct_option_ids=row.correct_option_ids,
                    accepted_answers=row.accepted_answers,
                )
            )
        except (ValidationError, ValueError, KeyError, TypeError):
            continue
    return frozenset(out)


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_question_generation(
    deps: GenerationJobDeps, ctx: JobContext, payload: QuestionGeneratePayloadV1
) -> JobResult:
    try:
        with deps.generations.run_lock(
            payload.generation_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
        ):
            return _pipeline(deps, ctx, payload)
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            _mark(deps, payload.generation_id, ctx.job_id, "failed")
        raise


def _mark(
    deps: GenerationJobDeps, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
) -> None:
    try:
        deps.generations.mark_terminal(run_id, job_id, status)
    except Exception as exc:
        # The cleanup obligation marks it again.
        logger.warning("could not record the generation failure: %s", type(exc).__name__)


def _pipeline(
    deps: GenerationJobDeps, ctx: JobContext, payload: QuestionGeneratePayloadV1
) -> JobResult:
    def progress(stage: str, percent: int) -> None:
        try:
            deps.generations.report_progress(ctx.job_id, ctx.attempt, stage, percent)
        except Exception as exc:  # best effort
            logger.warning("progress update failed: %s", type(exc).__name__)

    run = deps.generations.load_run(ctx.workspace_id, payload.generation_id)
    if run is None:
        raise GenerationNotFoundError("generation run not found in this workspace")
    if run.async_job_id != ctx.job_id:
        return {"generation_id": str(run.id), "skipped": "superseded"}
    if run.status not in {"queued", "running"}:
        return {"generation_id": str(run.id), "skipped": run.status}
    if not deps.generations.workspace_writable(ctx.workspace_id, ctx.created_by):
        raise WorkspaceUnavailableError("the workspace is no longer writable")
    if deps.llm is None:
        raise LLMNotConfiguredError("question generation needs LLM_API_KEY / LLM_MODEL")
    source_row = deps.generations.load_source(
        ctx.workspace_id, run.source_question_id, run.source_revision_id
    )
    if source_row is None:
        raise SourceQuestionDeletedError("the source question was deleted")

    deps.generations.mark_running(run.id, ctx.job_id)
    progress("loading", 10)
    passages, revisions = _passages(deps, ctx, source_row)
    variations = tuple(VariationType(v) for v in run.variation_types)
    if VariationType.ANALOGOUS_CONCEPT in variations and not passages:
        raise SourcePassagesMissingError("the source question cites no readable document page")
    fingerprints = workspace_fingerprints(deps.generations.workspace_questions(ctx.workspace_id))
    ctx.check_cancelled()

    progress("generating", 30)
    request = VariantRequest(
        source=source_question(source_row),
        variation_types=variations,
        candidate_count=run.candidate_count,
        passages=tuple(passages),
        difficulty=_difficulty(run.params.get("difficulty")),
        existing_fingerprints=fingerprints,
        draft_id_prefix=f"gen-{run.id}",
    )
    result = VariantGenerator(deps.llm).generate(request)
    ctx.check_cancelled()
    if not result.variants:
        raise failure_for(result)

    drafts = [
        draft_row(position, narrow_evidence(variant.draft, revisions))
        for position, variant in enumerate(result.variants)
    ]
    model = next((c.model for c in result.llm_calls), deps.llm.model_name)
    progress("saving", 80)
    created = deps.generations.finish(
        ctx.workspace_id,
        ctx.created_by,
        run.id,
        ctx.job_id,
        drafts,
        llm_model=model[:200],
        prompt_version=run_prompt_version(run.variation_types),
        passages=[p.model_dump(mode="json") for p in passages],
        before_commit=ctx.check_cancelled,
    )
    return {
        "generation_id": str(run.id),
        "drafts": len(drafts),
        "created": created,
        # Codes only (never text): e.g. duplicate_of_existing, citation_not_in_passage.
        "rejected": [str(c) for c in sorted({i.code for r in result.rejected for i in r.reasons})],
    }


def _passages(
    deps: GenerationJobDeps, ctx: JobContext, source: SourceQuestionRow
) -> tuple[list[Excerpt], dict[str, DocumentRevision]]:
    pages = source_pages(source)
    passages: list[Excerpt] = []
    revisions: dict[str, DocumentRevision] = {}
    for document in deps.generations.live_documents(ctx.workspace_id, list(pages)):
        if document.active_revision_id is None or len(passages) >= MAX_PASSAGES:
            continue
        found = deps.documents.load(ctx.workspace_id, document.id, document.active_revision_id)
        if found is None:
            continue
        row, revision = found
        if row.deleted or not revision.published or revision.content_hash is None:
            continue
        content = deps.documents.load_content(row, revision)
        revisions[f"{content.document_id}:{content.revision_id}"] = content
        passages += build_passages(content, pages[document.id], title=row.title)
    return passages[:MAX_PASSAGES], revisions


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_question_generation(
    deps: GenerationJobDeps, ctx: JobContext, reason: TerminalReason
) -> None:
    """Records the run's end (`failed`/`cancelled`) if this job still owns it."""
    payload = deps.generations.job_payload(ctx.job_id)
    if payload is None:
        return
    try:
        parsed = QuestionGeneratePayloadV1.model_validate(payload)
    except ValidationError:
        return
    deps.generations.mark_terminal(
        parsed.generation_id, ctx.job_id, "cancelled" if reason == "cancelled" else "failed"
    )


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], GenerationJobDeps]


def question_generate_definition(
    provider: DepsProvider,
) -> JobDefinition[QuestionGeneratePayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: QuestionGeneratePayloadV1},
        handler=lambda ctx, payload: run_question_generation(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_question_generation(provider(), ctx, reason),
    )


def build_generation_llm(settings: WorkerSettings) -> LLMClient | None:
    """APP_ENV=test: the scenario fake (never a real provider). Elsewhere the configured
    provider, or None when `LLM_API_KEY` is unset (the job then fails `llm_not_configured`)."""
    from book_core.llm import LLMConfig, LLMConfigError, create_llm_client

    if settings.is_test:
        from book_core.llm.scenarios import ScenarioLLMClient

        path = Path(settings.llm_scenario_file) if settings.llm_scenario_file else _REPO_SCENARIOS
        if not path.is_file():
            raise WorkerNotConfiguredError("LLM scenario file not found (WORKER_LLM_SCENARIO_FILE)")
        return ScenarioLLMClient.from_file(path)
    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    return create_llm_client(config) if config is not None else None


def deps_from_settings(settings: WorkerSettings) -> GenerationJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return GenerationJobDeps(
        generations=PostgresGenerationStore(engine),
        documents=PostgresDocumentStore(engine),
        llm=build_generation_llm(settings),
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


class LazyGenerationDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: GenerationJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> GenerationJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
