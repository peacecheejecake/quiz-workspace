"""`chapter_note.generate` v1: a chapter note from the chapter's CONFIRMED questions (CHNOTE-B,
docs/screens/chapter-notes.md, docs/questions.md §9).

Payload (written by apps/api `POST /chapters/{chapterId}/note`): `{note_id}`. The note row pins
the input at request time: `question_refs` (the chapter's live CONFIRMED questions in Heatmap
order, tagged Q1..Qn, with their revision ids) and the chapter (`document_revision_id`,
`section_key`). The job reads exactly those revisions, so a question added, edited or deleted
after the request never reaches this generation (CHNOTE-01-C01). It runs for `created_by` in
the envelope's workspace and only as the row's job (`chapter_notes.job_id`).

Pipeline, serialised per note by an advisory lock:

1. load the row; skip a row of another job or one that already finished; refuse when the feature
   is off (`note_generation_disabled`), no LLM is configured (`llm_not_configured`) or the
   workspace is archived/deleted or the user can no longer edit it (`workspace_unavailable`,
   re-checked under a lock in step 4);
2. the pinned revisions (stem, options with the correct ones, accepted answers, explanation) and
   the chapter's published text (reference only: quotes are checked against it);
3. `ChapterNoteGenerator` (book_core.notes): contiguous batches, one LLM call each, a response
   with an unknown tag or a quote missing from the chapter is re-requested once, then invalid
   and untagged items are dropped; batches are merged by heading with chapter-wide tags;
4. in one transaction: re-check workspace access, mark the row `succeeded` with the chapter's
   next version and supersede the previous version (older versions are kept).

Failure codes (the row's `error_code`): `llm_unavailable` / `llm_timeout` (provider; retried),
`llm_invalid_output` (schema), `note_citation_invalid` (no item survived), and the generic ones
above. The job result holds counts, usage and codes only; nothing here logs or stores question,
explanation, note, prompt or LLM output text (CHNOTE-01-C06).

LLM (APP_ENV=test only, implementation-plan §7): `ScenarioLLMClient` over
tests/fixtures/llm/chapter-note-scenarios.json (WORKER_CHAPTER_NOTE_SCENARIO_FILE), wrapped in the
E2E hold barrier (`HoldBarrierLLMClient`, assumption N8 of tests/e2e/fixtures/chapter-notes.ts).
Elsewhere the provider comes from `LLM_API_KEY` / `LLM_MODEL`.
"""

from __future__ import annotations

import logging
import re
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.llm import LLMClient, LLMOutputError, LLMProviderError, LLMRequest, LLMResult
from book_core.notes import (
    ChapterNoteGenerator,
    NoteCitationError,
    NoteOption,
    NoteQuestion,
    NoteRequest,
    plan_batches,
    question_size,
)
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.chapter_note_store import (
    JOB_TYPE,
    ChapterNoteStore,
    NoteRow,
    PostgresChapterNoteStore,
    RevisionRow,
)
from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.errors import JobCancelledError, JobError, NonRetryableJobError, is_retryable
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

_REPO_SCENARIOS = (
    Path(__file__).resolve().parents[4]
    / "tests"
    / "fixtures"
    / "llm"
    / "chapter-note-scenarios.json"
)
HOLD_MARKER = "E2E-HOLD-NOTE"
HOLD_DIR_NAME = "quiz-e2e-chapter-note-hold"
HOLD_TIMEOUT_SECONDS = 120.0
_HOLD = re.compile(rf"{HOLD_MARKER}-([A-Za-z0-9]{{1,64}})")


class NoteNotFoundError(NonRetryableJobError):
    code = "note_not_found"


class NoteGenerationDisabledError(NonRetryableJobError):
    code = "note_generation_disabled"


class LLMNotConfiguredError(NonRetryableJobError):
    code = "llm_not_configured"


class LLMInvalidOutputError(NonRetryableJobError):
    code = "llm_invalid_output"


class NoteCitationInvalidError(NonRetryableJobError):
    code = "note_citation_invalid"


class NoteInputMissingError(NonRetryableJobError):
    """A pinned question revision no longer exists (the question was purged)."""

    code = "note_input_missing"


class LLMUnavailableError(JobError):
    """Provider failures (network, 5xx, rate limit): the job is retried."""

    code = "llm_unavailable"


class LLMTimeoutError(JobError):
    code = "llm_timeout"


class ChapterNoteGeneratePayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    note_id: uuid.UUID


@dataclass
class ChapterNoteJobDeps:
    notes: ChapterNoteStore
    llm: LLMClient | None
    enabled: bool = True
    lock_wait_seconds: float = 60


# --------------------------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------------------------


def note_question(tag: str, label: str, row: RevisionRow) -> NoteQuestion:
    correct = set(row.correct_option_ids or ())
    return NoteQuestion(
        tag=tag,
        label=label,
        question_type=row.question_type,
        stem=row.stem,
        options=tuple(
            NoteOption(text=str(o.get("text", "")), correct=o.get("id") in correct)
            for o in row.options
            if isinstance(o, dict)
        ),
        accepted_answers=tuple(a for a in (row.accepted_answers or ()) if a.strip()),
        explanation=row.explanation,
    )


def error_code_of(exc: BaseException) -> str:
    return exc.code if isinstance(exc, JobError) else "unexpected_error"


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_chapter_note(
    deps: ChapterNoteJobDeps, ctx: JobContext, payload: ChapterNoteGeneratePayloadV1
) -> JobResult:
    try:
        with deps.notes.run_lock(
            payload.note_id, wait_seconds=deps.lock_wait_seconds, check=ctx.check_cancelled
        ):
            return _pipeline(deps, ctx, payload)
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            _mark_failed(deps, payload.note_id, ctx.job_id, error_code_of(exc))
        raise


def _mark_failed(
    deps: ChapterNoteJobDeps, note_id: uuid.UUID, job_id: uuid.UUID, code: str
) -> None:
    try:
        deps.notes.mark_failed(note_id, job_id, code)
    except Exception as exc:
        # The cleanup obligation marks it again.
        logger.warning("could not record the chapter note failure: %s", type(exc).__name__)


def _pipeline(
    deps: ChapterNoteJobDeps, ctx: JobContext, payload: ChapterNoteGeneratePayloadV1
) -> JobResult:
    note = deps.notes.load_note(ctx.workspace_id, payload.note_id)
    if note is None:
        raise NoteNotFoundError("chapter note not found in this workspace")
    if note.job_id != ctx.job_id:
        return {"note_id": str(note.id), "skipped": "superseded"}
    if note.status not in {"queued", "running"}:
        return {"note_id": str(note.id), "skipped": note.status}
    if not deps.enabled:
        raise NoteGenerationDisabledError("chapter notes are off (WORKER_CHAPTER_NOTES)")
    if deps.llm is None:
        raise LLMNotConfiguredError("chapter notes need LLM_API_KEY / LLM_MODEL")
    if not deps.notes.workspace_writable(ctx.workspace_id, ctx.created_by):
        raise WorkspaceUnavailableError("the workspace is no longer writable")

    request = _request(deps, note)
    ctx.check_cancelled()
    batches = plan_batches([question_size(q) for q in request.questions])
    deps.notes.mark_running(note.id, ctx.job_id, len(batches))

    def progress(done: int, total: int) -> None:
        try:
            deps.notes.report_batches(note.id, ctx.job_id, done)
        except Exception as exc:  # best effort
            logger.warning("chapter note progress update failed: %s", type(exc).__name__)

    try:
        result = ChapterNoteGenerator(deps.llm).generate(
            request, progress=progress, check=ctx.check_cancelled
        )
    except NoteCitationError:
        raise NoteCitationInvalidError("no note item cites an input question") from None
    except LLMOutputError:
        # The detail is sanitised, but nothing of the output is needed here.
        raise LLMInvalidOutputError("the LLM output does not match the note schema") from None
    except LLMProviderError as exc:
        if exc.kind == "timeout":
            raise LLMTimeoutError("the LLM provider timed out") from None
        raise LLMUnavailableError(f"the LLM provider call failed ({exc.kind})") from None
    ctx.check_cancelled()

    usage = result.usage.as_dict()
    version = deps.notes.finish(
        ctx.workspace_id,
        ctx.created_by,
        note.id,
        ctx.job_id,
        body=result.body(),
        usage=usage,
        dropped_items=result.usage.dropped_items,
        model=(result.model or "")[:200] or None,
        prompt_version=result.prompt_version,
        before_commit=ctx.check_cancelled,
    )
    logger.info(
        "chapter note generated note=%s version=%d items=%d dropped=%d batches=%d calls=%d",
        note.id,
        version,
        result.usage.items,
        result.usage.dropped_items,
        result.usage.batches,
        result.usage.llm_calls,
    )
    return {
        "note_id": str(note.id),
        "version": version,
        "items": result.usage.items,
        "dropped_items": result.usage.dropped_items,
        "batches": result.usage.batches,
        "llm_calls": result.usage.llm_calls,
        "input_tokens": result.usage.input_tokens,
        "output_tokens": result.usage.output_tokens,
        # Codes only (never text), e.g. unknown_question_tag, item_without_citation.
        "rejected": list(result.rejected_codes),
    }


def _request(deps: ChapterNoteJobDeps, note: NoteRow) -> NoteRequest:
    revisions = deps.notes.load_revisions(note.workspace_id, note.refs)
    questions: list[NoteQuestion] = []
    for ref in note.refs:
        row = revisions.get(ref.question_revision_id)
        if row is None or row.question_id != ref.question_id:
            raise NoteInputMissingError("a pinned question revision no longer exists")
        questions.append(note_question(ref.tag, ref.label, row))
    reference = deps.notes.reference_text(note.document_revision_id, note.section_key)
    return NoteRequest(questions=tuple(questions), reference_text=reference)


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_chapter_note(deps: ChapterNoteJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    """Records the row's end if this job still owns it (`failed`; code `cancelled` or
    `job_failed`)."""
    payload = deps.notes.job_payload(ctx.job_id)
    if payload is None:
        return
    try:
        parsed = ChapterNoteGeneratePayloadV1.model_validate(payload)
    except ValidationError:
        return
    deps.notes.mark_failed(
        parsed.note_id, ctx.job_id, "cancelled" if reason == "cancelled" else "job_failed"
    )


# --------------------------------------------------------------------------------------------
# APP_ENV=test hold barrier (assumption N8)
# --------------------------------------------------------------------------------------------


def default_hold_dir() -> Path:
    return Path(tempfile.gettempdir()) / HOLD_DIR_NAME


class HoldBarrierLLMClient:
    """Test-only wrapper: a request carrying `E2E-HOLD-NOTE-<token>` creates `<dir>/<token>.held`
    and waits (at most `timeout` seconds) until `<dir>/<token>.release` exists, then answers
    from the wrapped client. Makes "generating" and the running 409 deterministic in E2E."""

    def __init__(self, inner: Any, hold_dir: Path, timeout: float = HOLD_TIMEOUT_SECONDS) -> None:
        self._inner = inner
        self._dir = hold_dir
        self._timeout = timeout

    @property
    def model_name(self) -> str:
        return str(self._inner.model_name)

    @property
    def calls(self) -> Any:
        """The wrapped scenario client's recorded calls (contract tests read them)."""
        return self._inner.calls

    def _hold(self, request: LLMRequest) -> None:
        tokens = dict.fromkeys(_HOLD.findall(f"{request.system or ''}\n{request.prompt}"))
        for token in tokens:
            self._dir.mkdir(parents=True, exist_ok=True)
            (self._dir / f"{token}.held").touch()
            deadline = time.monotonic() + self._timeout
            release = self._dir / f"{token}.release"
            while not release.exists() and time.monotonic() < deadline:
                time.sleep(0.1)

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        self._hold(request)
        result: LLMResult[T] = self._inner.complete(request, schema)
        return result

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], ChapterNoteJobDeps]


def chapter_note_definition(provider: DepsProvider) -> JobDefinition[ChapterNoteGeneratePayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: ChapterNoteGeneratePayloadV1},
        handler=lambda ctx, payload: run_chapter_note(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_chapter_note(provider(), ctx, reason),
    )


def build_chapter_note_llm(settings: WorkerSettings) -> LLMClient | None:
    """APP_ENV=test: the chapter note scenario fake behind the hold barrier (never a real
    provider). Elsewhere the configured provider, or None when `LLM_API_KEY` is unset."""
    from book_core.llm import LLMConfig, LLMConfigError, create_llm_client

    if settings.is_test:
        from book_core.llm.scenarios import ScenarioLLMClient

        configured = settings.chapter_note_scenario_file
        path = Path(configured) if configured else _REPO_SCENARIOS
        if not path.is_file():
            raise WorkerNotConfiguredError(
                "chapter note scenario file not found (WORKER_CHAPTER_NOTE_SCENARIO_FILE)"
            )
        hold_dir = (
            Path(settings.chapter_note_hold_dir)
            if settings.chapter_note_hold_dir
            else default_hold_dir()
        )
        return HoldBarrierLLMClient(ScenarioLLMClient.from_file(path), hold_dir)
    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    return create_llm_client(config) if config is not None else None


def deps_from_settings(settings: WorkerSettings) -> ChapterNoteJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return ChapterNoteJobDeps(
        notes=PostgresChapterNoteStore(engine),
        llm=build_chapter_note_llm(settings) if settings.chapter_notes else None,
        enabled=settings.chapter_notes,
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


class LazyChapterNoteDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: ChapterNoteJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> ChapterNoteJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
