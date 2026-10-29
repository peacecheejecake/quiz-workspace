"""`document.summarize` v1: the AI summary of one published revision (DOCSUM-B, DOCSUM-01).

Payload (written by `worker_start_document_summary` in a publish transaction, or by apps/api
`POST /documents/{id}/summary` and `/summary/retry`): `{run_id, document_id}`. The job works only
for the run's own job (`document_summary_runs.job_id`) in the envelope's workspace.

Pipeline, serialised per document by an advisory lock of its own (a publish never waits on it):

1. load the run; a run that is no longer queued/running (superseded by a newer revision's run,
   or already finished) is skipped and writes nothing; mark it `running`;
2. read the run's revision from the DB and split it into top-level chapter inputs
   (book_core.summary.chapter_inputs; a `mixed` book leaves the question segments out);
3. map/reduce with unit reuse (book_core.summary.summarize_revision): unchanged chapters and an
   unchanged chapter list reuse their stored units without an LLM call; a document over
   WORKER_SUMMARY_MAX_INPUT_CHARS fails `summary_too_large` before any call; chapters over
   WORKER_SUMMARY_CHAPTER_CHARS are summarized in parts and merged;
4. in one transaction re-check the run and the document's active revision under the document row
   lock, link the units and mark the run `succeeded` with its usage — or `superseded` and write
   nothing (DOCSUM-01-C03).

Failures end the run `failed` with a code only: `llm_unavailable` / `llm_timeout` (retried),
`llm_invalid_output`, `summary_too_large`, `document_unavailable`, `workspace_unavailable` (the
workspace was archived/deleted or the run's user can no longer edit it: checked before any LLM
call, with every unit write and under the row locks before the commit). Usage accumulates over
attempts. Logs, the job result and the
run carry ids, counts, usage and codes; never book text, prompts, summaries or provider messages
(DOCSUM-01-C04).

Summarizer: APP_ENV=test uses the deterministic `ExtractiveFakeSummarizer` (and, for a document
whose file name carries `E2E-SLOW-SUMMARY`, waits WORKER-side before running and before each
generated unit; tests/e2e/fixtures/summary.ts D7). Elsewhere `LLMSummarizer` over the configured
provider (`LLM_API_KEY` / `LLM_MODEL`, no model default); without one the run fails
`llm_unavailable`.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from book_core.llm import LLMOutputError, LLMProviderError, LLMUsage
from book_core.summary import (
    PROMPT_VERSION,
    SUMMARY_SLOW_MARKER,
    ExtractiveFakeSummarizer,
    LLMSummarizer,
    Summarizer,
    SummaryLimits,
    SummaryTally,
    SummaryTooLargeError,
    chapter_inputs,
    summarize_revision,
)
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.document_store import (
    DocumentStore,
    PostgresDocumentStore,
    WorkspaceUnavailableError,
)
from quiz_worker.errors import JobCancelledError, JobError, NonRetryableJobError, is_retryable
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings
from quiz_worker.summary_store import JOB_TYPE, PostgresSummaryStore, RunRow, SummaryStore

logger = logging.getLogger(__name__)

MIXED = "mixed"
SLOW_STEP_SECONDS = 4.0
ERROR_CODES = frozenset(
    {
        "llm_unavailable",
        "llm_timeout",
        "llm_invalid_output",
        "summary_too_large",
        "document_unavailable",
        "workspace_unavailable",
    }
)


class SummaryRunNotFoundError(NonRetryableJobError):
    code = "document_unavailable"


class DocumentUnavailableError(NonRetryableJobError):
    code = "document_unavailable"


class SummaryTooLargeJobError(NonRetryableJobError):
    code = "summary_too_large"


class LLMInvalidOutputError(NonRetryableJobError):
    code = "llm_invalid_output"


class LLMUnavailableError(JobError):
    """Provider failures (network, 5xx, rate limit) or no provider configured; retried."""

    code = "llm_unavailable"


class LLMTimeoutError(JobError):
    code = "llm_timeout"


class DocumentSummarizePayloadV1(BaseModel):
    model_config = ConfigDict(extra="ignore")

    run_id: uuid.UUID
    document_id: uuid.UUID | None = None


@dataclass
class SummaryJobDeps:
    summaries: SummaryStore
    documents: DocumentStore
    summarizer: Summarizer | None
    limits: SummaryLimits = field(default_factory=SummaryLimits)
    lock_wait_seconds: float = 60
    # APP_ENV=test only: honour SUMMARY_SLOW_MARKER in the file name (seconds per step).
    slow_step_seconds: float | None = None
    sleep: Callable[[float], None] = time.sleep


def error_code_of(exc: BaseException) -> str:
    if isinstance(exc, JobError) and exc.code in ERROR_CODES:
        return exc.code
    return "llm_unavailable"


def _usage(tally: SummaryTally) -> dict[str, Any]:
    return {
        "reused_units": tally.reused_units,
        "generated_units": tally.generated_units,
        "input_tokens": tally.usage.input_tokens,
        "output_tokens": tally.usage.output_tokens,
        "cost_usd": tally.usage.cost_usd,
    }


def _translate(exc: Exception) -> Exception:
    """Summarizer errors as job errors (codes and fixed messages only)."""
    if isinstance(exc, SummaryTooLargeError):
        return SummaryTooLargeJobError("the document is over WORKER_SUMMARY_MAX_INPUT_CHARS")
    if isinstance(exc, LLMOutputError):
        return LLMInvalidOutputError("the summary output did not match the schema")
    if isinstance(exc, LLMProviderError):
        if exc.kind == "timeout":
            return LLMTimeoutError("the LLM provider timed out")
        if exc.kind in {"refusal", "max_tokens"}:
            return LLMInvalidOutputError(f"the LLM stopped early ({exc.kind})")
        return LLMUnavailableError(f"the LLM provider failed ({exc.kind})")
    return exc


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_document_summary(
    deps: SummaryJobDeps, ctx: JobContext, payload: DocumentSummarizePayloadV1
) -> JobResult:
    run = deps.summaries.load_run(ctx.workspace_id, payload.run_id)
    if run is None:
        raise SummaryRunNotFoundError("summary run not found in this workspace")
    if run.job_id != ctx.job_id:
        return {"run_id": str(run.id), "skipped": "other_job"}
    if run.status not in {"queued", "running"}:
        return {"run_id": str(run.id), "skipped": run.status}
    tally = _resumed_tally(run)
    try:
        slow = deps.slow_step_seconds if SUMMARY_SLOW_MARKER in run.document_filename else None
        if slow:
            deps.sleep(slow)  # observable `queued` state (APP_ENV=test only)
        with deps.summaries.summary_lock(
            run.document_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
        ):
            return _pipeline(deps, ctx, run, tally, slow)
    except JobCancelledError:
        raise
    except Exception as exc:
        error = _translate(exc)
        if not is_retryable(error) or ctx.is_final_attempt:
            _mark_failed(deps, run, ctx.job_id, error_code_of(error), tally)
        else:
            _record_usage(deps, run, ctx.job_id, tally)
        if error is exc:
            raise
        raise error from None


def _resumed_tally(run: RunRow) -> SummaryTally:
    """The tokens and cost an earlier attempt of this run already spent (unit counts are
    recounted: the run's own units from that attempt count as generated)."""
    tally = SummaryTally(run_id=str(run.id))
    earlier = run.usage or {}
    tally.usage = LLMUsage(
        input_tokens=int(earlier.get("input_tokens") or 0),
        output_tokens=int(earlier.get("output_tokens") or 0),
        cost_usd=earlier.get("cost_usd"),
    )
    return tally


def _record_usage(
    deps: SummaryJobDeps, run: RunRow, job_id: uuid.UUID, tally: SummaryTally
) -> None:
    try:
        deps.summaries.record_usage(run.id, job_id, _usage(tally))
    except Exception as exc:  # best effort: the next attempt then under-reports
        logger.warning("could not record the summary usage: %s", type(exc).__name__)


def _mark_failed(
    deps: SummaryJobDeps, run: RunRow, job_id: uuid.UUID, code: str, tally: SummaryTally | None
) -> None:
    try:
        deps.summaries.mark_failed(run.id, job_id, code, _usage(tally) if tally else None)
    except Exception as exc:
        # The cleanup obligation marks it again.
        logger.warning("could not record the summary failure: %s", type(exc).__name__)


def _pipeline(
    deps: SummaryJobDeps,
    ctx: JobContext,
    run: RunRow,
    tally: SummaryTally,
    slow: float | None,
) -> JobResult:
    if run.document_deleted:
        raise DocumentUnavailableError("the document was deleted")
    if deps.summarizer is None:
        raise LLMUnavailableError("document summaries need LLM_API_KEY / LLM_MODEL")
    summarizer = deps.summarizer
    # Nothing goes to the provider for a workspace that was archived or deleted (or whose
    # user can no longer edit it) after the run was queued; re-checked when units are written
    # and under the row locks before the run commits.
    if not deps.summaries.workspace_writable(run.workspace_id, ctx.created_by):
        raise WorkspaceUnavailableError("the workspace is no longer writable")
    if not deps.summaries.mark_running(
        run.id, ctx.job_id, prompt_version=PROMPT_VERSION, model=summarizer.model_name
    ):
        return {"run_id": str(run.id), "skipped": "superseded"}

    found = deps.documents.load(run.workspace_id, run.document_id, run.revision_id)
    if found is None:
        raise DocumentUnavailableError("the revision is gone")
    document, revision = found
    if document.deleted or not revision.published:
        raise DocumentUnavailableError("the document or revision is not available")
    content = deps.documents.load_content(document, revision)
    chapters = chapter_inputs(
        content,
        document_title=run.document_title,
        exclude_questions=run.content_kind == MIXED,
    )
    ctx.check_cancelled()

    def progress(done: int, total: int) -> None:
        try:
            deps.summaries.report_progress(run.id, ctx.job_id, done, total)
        except Exception as exc:  # best effort
            logger.warning("summary progress update failed: %s", type(exc).__name__)

    def before_generate() -> None:
        ctx.check_cancelled()
        if slow:
            deps.sleep(slow)

    units = deps.summaries.unit_store(
        run, ctx.created_by, prompt_version=PROMPT_VERSION, model=summarizer.model_name
    )
    result = summarize_revision(
        chapters,
        document_title=run.document_title,
        summarizer=summarizer,
        store=units,
        limits=deps.limits,
        tally=tally,
        on_progress=progress,
        before_generate=before_generate,
    )
    outcome = deps.summaries.finish(
        run,
        ctx.job_id,
        [result.document.id, *(u.id for u in result.chapters)],
        _usage(tally),
        user_id=ctx.created_by,
        before_commit=ctx.check_cancelled,
    )
    if outcome == "document_unavailable":
        raise DocumentUnavailableError("the document was deleted")
    if outcome == "workspace_unavailable":
        raise WorkspaceUnavailableError("the workspace is no longer writable")
    out: dict[str, Any] = {
        "run_id": str(run.id),
        "chapters": len(result.chapters),
        "reused_units": tally.reused_units,
        "generated_units": tally.generated_units,
    }
    if outcome != "succeeded":
        out["skipped"] = outcome
    logger.info(
        "summary run finished: %s chapters=%d reused=%d generated=%d",
        outcome,
        len(result.chapters),
        tally.reused_units,
        tally.generated_units,
    )
    return out


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_document_summary(deps: SummaryJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    """Records the run's end if this job still owns an unfinished run (a lost worker's last
    attempt, a cancel): `failed` with the job's error code, else `llm_unavailable`."""
    found = deps.summaries.job_payload(ctx.job_id)
    if found is None:
        return
    payload, last_error = found
    try:
        parsed = DocumentSummarizePayloadV1.model_validate(payload)
    except ValidationError:
        return
    code = (last_error or "").split(":", 1)[0].strip()
    if reason == "cancelled" or code not in ERROR_CODES:
        code = "llm_unavailable"
    deps.summaries.mark_failed(parsed.run_id, ctx.job_id, code, None)


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], SummaryJobDeps]


def document_summarize_definition(
    provider: DepsProvider,
) -> JobDefinition[DocumentSummarizePayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: DocumentSummarizePayloadV1},
        handler=lambda ctx, payload: run_document_summary(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API and the publish insert.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=30, max_delay_seconds=600),
        cleanup=lambda ctx, reason: cleanup_document_summary(provider(), ctx, reason),
    )


def build_summarizer(settings: WorkerSettings) -> Summarizer | None:
    """APP_ENV=test: the deterministic extractive fake (never a real provider). Elsewhere the
    configured provider, or None when `LLM_API_KEY` is unset (runs fail `llm_unavailable`)."""
    from book_core.llm import LLMConfig, LLMConfigError, create_llm_client

    if settings.is_test:
        return ExtractiveFakeSummarizer()
    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    return LLMSummarizer(create_llm_client(config)) if config is not None else None


def deps_from_settings(settings: WorkerSettings) -> SummaryJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return summary_deps(settings, engine)


def summary_deps(settings: WorkerSettings, engine: Any) -> SummaryJobDeps:
    """The job's dependencies over an existing engine (also used by the in-process test
    worker)."""
    return SummaryJobDeps(
        summaries=PostgresSummaryStore(engine),
        documents=PostgresDocumentStore(engine),
        summarizer=build_summarizer(settings),
        limits=SummaryLimits(
            chapter_chars=settings.summary_chapter_chars,
            max_input_chars=settings.summary_max_input_chars,
        ),
        lock_wait_seconds=settings.document_lock_wait_seconds,
        slow_step_seconds=SLOW_STEP_SECONDS if settings.is_test else None,
    )


class LazySummaryDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: SummaryJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> SummaryJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
