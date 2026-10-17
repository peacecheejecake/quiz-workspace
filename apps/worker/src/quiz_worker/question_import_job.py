"""`question.import` v1: extract import drafts from a question paper (M4.4a, QIMPORT-01).

Payload (written by apps/api `POST /workspaces/{id}/question-imports` and `.../retry`):
`{import_id}`. The run pins the document and the revision that was active when the import
started; the job runs for `created_by` in the envelope's workspace and only for the run's current
job (`question_import_runs.async_job_id`), so a superseded job does nothing.

Pipeline, serialised per run by an advisory lock:

1. load the run; refuse a run of another job, a deleted question paper, and a workspace that is
   archived/deleted or that the job's user can no longer edit (`workspace_unavailable`, re-checked
   under a lock in step 4); mark the run `running`;
2. read the pinned revision's `ParsedDocument` from `parsed-artifacts` (the extractor works on the
   parser's line structure; block ids are mapped onto the revision's canonical `content_blocks`
   ids). A revision without its own artifact (e.g. a user correction) is read from the DB blocks;
3. run `QuestionExtractor`: rule-based pre-extraction, plus the optional LLM refinement only when
   `WORKER_QUESTION_IMPORT_LLM` is on and an LLM is configured (off by default). Answers come only
   from the printed key; a missing answer stays null with a warning (QIMPORT-01-AC02);
4. in one transaction: re-check workspace access (rows locked FOR SHARE), insert the drafts whose
   position has none yet and mark the run `succeeded`.

Drafts stay isolated in `question_drafts` (`pending`) until a human publishes them through the API.

Failure: the run is marked `failed` (or `cancelled`) by the final attempt and again by the cleanup
obligation. Drafts a failed attempt already persisted are deliberately kept: the import screen
shows them, and `POST /question-imports/{id}/retry` starts a new job on the same run that inserts
only the missing positions (never duplicates, never overwrites a reviewed draft).

Fault injection (APP_ENV=test only, implementation-plan §7, tests/e2e/fixtures/questions.ts A7):
a question paper whose file name contains `E2E-FAIL-IMPORT-ONCE` fails the run's first job after
persisting the first half of its drafts (by position); later jobs of the run succeed.
"""

from __future__ import annotations

import logging
import re
import tempfile
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from book_core.contracts import (
    DocumentRevision,
    ParsedDocument,
    QuestionDraft,
    QuestionType,
    SourceEvidence,
)
from book_core.extractor import EXTRACT_PROMPT_VERSION, ExtractedQuestion, QuestionExtractor
from book_core.llm import LLMClient
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.document_store import (
    DocumentDeletedError,
    DocumentStore,
    PostgresDocumentStore,
    WorkspaceUnavailableError,
)
from quiz_worker.errors import JobCancelledError, NonRetryableJobError, is_retryable
from quiz_worker.question_import_store import (
    JOB_TYPE,
    DraftRow,
    ImportStore,
    PostgresImportStore,
    RunRow,
    TerminalRunStatus,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings
from quiz_worker.storage import PARSED_BUCKET, ObjectMissingError, ObjectStorage, SupabaseStorage

logger = logging.getLogger(__name__)

IMPORT_FAILURE_MARKER = "E2E-FAIL-IMPORT-ONCE"
# A parse artifact is the JSON of one PDF's blocks; far below the 50 MiB bucket limit.
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
_DRAFT_NUMBER = re.compile(r"-q(\d{3,})(?:-\d+)?$")


class ImportNotFoundError(NonRetryableJobError):
    code = "import_not_found"


class DocumentNotReadyError(NonRetryableJobError):
    code = "document_not_ready"


class SourceInvalidError(NonRetryableJobError):
    code = "source_invalid"


class InjectedImportFailureError(NonRetryableJobError):
    code = "import_failed"


class QuestionImportPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    import_id: uuid.UUID


@dataclass
class ImportJobDeps:
    imports: ImportStore
    documents: DocumentStore
    storage: ObjectStorage
    llm: LLMClient | None = None
    llm_model: str | None = None
    # APP_ENV=test: honour IMPORT_FAILURE_MARKER.
    inject_failures: bool = False
    lock_wait_seconds: float = 60


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_question_import(
    deps: ImportJobDeps, ctx: JobContext, payload: QuestionImportPayloadV1
) -> JobResult:
    try:
        with deps.imports.run_lock(
            payload.import_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
        ):
            return _pipeline(deps, ctx, payload)
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            _mark(deps, payload.import_id, ctx.job_id, "failed")
        raise


def _mark(
    deps: ImportJobDeps, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
) -> None:
    try:
        deps.imports.mark_terminal(run_id, job_id, status)
    except Exception as exc:
        # The cleanup obligation marks it again.
        logger.warning("could not record the import failure: %s", type(exc).__name__)


def _pipeline(deps: ImportJobDeps, ctx: JobContext, payload: QuestionImportPayloadV1) -> JobResult:
    def progress(stage: str, percent: int) -> None:
        try:
            deps.imports.report_progress(ctx.job_id, ctx.attempt, stage, percent)
        except Exception as exc:  # best effort
            logger.warning("progress update failed: %s", type(exc).__name__)

    run = deps.imports.load_run(ctx.workspace_id, payload.import_id)
    if run is None:
        raise ImportNotFoundError("import run not found in this workspace")
    if run.async_job_id != ctx.job_id:
        # The run was retried: the newer job owns it.
        return {"import_id": str(run.id), "skipped": "superseded"}
    if run.status == "succeeded":
        return {"import_id": str(run.id), "skipped": "succeeded"}
    if run.status not in {"queued", "running"}:
        return {"import_id": str(run.id), "skipped": run.status}
    if run.document_id is None or run.revision_id is None or run.document_deleted:
        raise DocumentDeletedError("the question paper was deleted")
    if not deps.imports.workspace_writable(ctx.workspace_id, ctx.created_by):
        raise WorkspaceUnavailableError("the workspace is no longer writable")

    deps.imports.mark_running(run.id, ctx.job_id)
    progress("loading", 10)
    source, canonical = _load_source(deps, ctx, run)
    ctx.check_cancelled()

    progress("extracting", 40)
    extraction = QuestionExtractor(deps.llm).extract(
        source, document_id=str(run.document_id), revision_id=str(run.revision_id)
    )
    drafts = [
        draft_row(position, question, canonical)
        for position, question in enumerate(extraction.questions)
    ]
    refined = any(q.refined_by_llm for q in extraction.questions)
    ctx.check_cancelled()

    if (
        deps.inject_failures
        and IMPORT_FAILURE_MARKER in (run.document_filename or "")
        and deps.imports.job_count(ctx.workspace_id, run.id) <= 1
    ):
        deps.imports.insert_drafts(ctx.workspace_id, run.id, drafts[: len(drafts) // 2])
        raise InjectedImportFailureError("import failed (injected test failure)")

    progress("saving", 80)
    created = deps.imports.finish(
        ctx.workspace_id,
        ctx.created_by,
        run.id,
        ctx.job_id,
        drafts,
        llm_model=deps.llm_model if refined else None,
        prompt_version=EXTRACT_PROMPT_VERSION if refined else None,
        before_commit=ctx.check_cancelled,
    )
    return {
        "import_id": str(run.id),
        "drafts": len(drafts),
        "created": created,
        # Codes only (never text): e.g. answer_key_missing, question_number_gap.
        "warnings": [str(code) for code in sorted({w.code for w in extraction.warnings})],
    }


def _load_source(
    deps: ImportJobDeps, ctx: JobContext, run: RunRow
) -> tuple[ParsedDocument | DocumentRevision, Mapping[str, str] | None]:
    """The parser's `ParsedDocument` of the pinned revision (+ parser id -> canonical block id),
    or the revision's canonical DB content when it has no artifact of its own."""
    assert run.document_id is not None  # noqa: S101 - checked by the caller
    assert run.revision_id is not None  # noqa: S101 - checked by the caller
    found = deps.documents.load(ctx.workspace_id, run.document_id, run.revision_id)
    if found is None:
        raise DocumentDeletedError("the question paper was deleted")
    document, revision = found
    if document.deleted:
        raise DocumentDeletedError("the question paper was deleted")
    if not revision.published or revision.content_hash is None:
        raise DocumentNotReadyError("the question paper revision is not published")
    content = deps.documents.load_content(document, revision)
    if revision.parsed_object_key:
        parsed = _download_parsed(deps.storage, revision.parsed_object_key)
        if parsed is not None:
            return parsed, canonical_ids(content)
    return content, None


def _download_parsed(storage: ObjectStorage, key: str) -> ParsedDocument | None:
    with tempfile.TemporaryDirectory(prefix="quiz-import-") as tmp:
        path = Path(tmp) / "parsed_document.json"
        try:
            storage.download(PARSED_BUCKET, key, path, max_bytes=MAX_ARTIFACT_BYTES)
        except ObjectMissingError:
            logger.warning("parse artifact missing; importing from the revision's blocks")
            return None
        try:
            return ParsedDocument.model_validate_json(path.read_bytes())
        except ValidationError:
            # Never the validation text: it quotes document content.
            raise SourceInvalidError("the parse artifact cannot be read") from None


def canonical_ids(content: DocumentRevision) -> dict[str, str]:
    """Parser block id -> the canonical block that contains it."""
    return {source: block.id for block in content.blocks for source in block.source_block_ids}


def _remap(evidence: SourceEvidence, canonical: Mapping[str, str]) -> SourceEvidence:
    block_ids = tuple(dict.fromkeys(canonical.get(b, b) for b in evidence.block_ids))
    locations = tuple(
        loc.model_copy(update={"block_id": canonical.get(loc.block_id, loc.block_id)})
        if loc.block_id is not None
        else loc
        for loc in evidence.locations
    )
    return evidence.model_copy(update={"block_ids": block_ids, "locations": locations})


def draft_number(draft: QuestionDraft) -> int | None:
    """The printed number, from the extractor's deterministic id `{document_id}-q{NNN}`."""
    match = _DRAFT_NUMBER.search(draft.id)
    if match is None:
        return None
    number = int(match.group(1))
    return number if 0 < number <= 2147483647 else None


def draft_row(
    position: int, question: ExtractedQuestion, canonical: Mapping[str, str] | None
) -> DraftRow:
    draft = question.draft
    if canonical:
        draft = draft.model_copy(
            update={"evidence": tuple(_remap(e, canonical) for e in draft.evidence)}
        )
        draft = QuestionDraft.model_validate(draft.model_dump())
    multi = question.draft.question_type is QuestionType.MCQ and (
        question.multi_select or len(draft.correct_option_ids or ()) > 1
    )
    return DraftRow(
        position=position,
        question_type=draft.question_type.value,
        question_number=question.number if question.number > 0 else draft_number(draft),
        is_multi_answer=multi,
        payload=draft.model_dump(mode="json"),
        validations=[v.model_dump(mode="json") for v in draft.validations],
    )


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_question_import(deps: ImportJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    """Records the run's end (`failed`/`cancelled`) if this job still owns it. Drafts that were
    persisted are kept on purpose: the retry reconciles with them."""
    payload = deps.imports.job_payload(ctx.job_id)
    if payload is None:
        return
    try:
        parsed = QuestionImportPayloadV1.model_validate(payload)
    except ValidationError:
        return
    deps.imports.mark_terminal(
        parsed.import_id, ctx.job_id, "cancelled" if reason == "cancelled" else "failed"
    )


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], ImportJobDeps]


def question_import_definition(provider: DepsProvider) -> JobDefinition[QuestionImportPayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: QuestionImportPayloadV1},
        handler=lambda ctx, payload: run_question_import(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_question_import(provider(), ctx, reason),
    )


def build_llm(settings: WorkerSettings) -> tuple[LLMClient | None, str | None]:
    """The extraction LLM: only with `WORKER_QUESTION_IMPORT_LLM` on and `LLM_API_KEY` /
    `LLM_MODEL` set; never in APP_ENV=test (E2E use the rule-based path)."""
    if not settings.question_import_llm or settings.is_test:
        return None, None
    from book_core.llm import LLMConfig, LLMConfigError, create_llm_client

    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    if config is None:
        raise WorkerNotConfiguredError("WORKER_QUESTION_IMPORT_LLM needs LLM_API_KEY / LLM_MODEL")
    return create_llm_client(config), config.model


def deps_from_settings(settings: WorkerSettings) -> ImportJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    secret = settings.supabase_secret_key
    if not settings.supabase_url or secret is None or not secret.get_secret_value():
        raise WorkerNotConfiguredError("SUPABASE_URL / SUPABASE_SECRET_KEY are not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    llm, model = build_llm(settings)
    return ImportJobDeps(
        imports=PostgresImportStore(engine),
        documents=PostgresDocumentStore(engine),
        storage=SupabaseStorage(
            settings.supabase_url,
            secret.get_secret_value(),
            timeout=settings.storage_timeout_seconds,
        ),
        llm=llm,
        llm_model=model,
        inject_failures=settings.is_test,
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


class LazyImportDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: ImportJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> ImportJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
