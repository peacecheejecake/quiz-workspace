"""`document.parse` v1: parse an uploaded PDF and index it, then make it the active revision.

Payload (written by apps/api complete-upload, M3.2a): `{document_id, revision_id}`. The job runs
for `created_by` in the envelope's workspace; the document and revision are looked up inside that
workspace only.

Pipeline (docs/architecture.md §4 indexing flow), serialised per document by an advisory lock:

1. load the document + draft revision (`quiz_worker` role); a deleted document fails the job;
2. if the draft has no content yet: download the original from the private `source-pdfs`
   bucket, check it (stored size + SHA-256, PDF signature, page limit), parse it (Docling, CPU,
   with a conversion timeout), store `parsed_document.json` in `parsed-artifacts`, build the
   canonical revision (`build_revision`) and write chapters + blocks + content hash in one
   transaction; a draft that already has content (retry, or a corrected draft) is read back from
   the DB instead;
3. chunk (`chunk_revision`) and index into Qdrant as an *inactive* revision (payload carries
   workspace / document / revision ids and `document_type`);
4. in one DB transaction: publish the revision, make it the document's active revision and set
   the document `ready` — the DB is the authority search filters on;
5. mirror the switch in Qdrant (`activate_revision`) and garbage-collect older revisions except the
   previous active one (kept for a quick rollback).

Every step is idempotent, so an at-least-once redelivery or a retry resumes where the last attempt
stopped: a published+active revision only re-runs step 5, content in the DB is not parsed again,
existing points are not embedded again.

Failure: until step 4 commits, the previous published revision stays active and searchable. On the
final failure the document gets a sanitized `last_error` (and `failed` if it never had an active
revision). The cleanup obligation (failed/cancelled job, including a lost worker's last attempt)
removes the draft's Qdrant points and an orphaned parse artifact, and records the failure.
"""

from __future__ import annotations

import logging
import tempfile
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from book_core.chunker import chunk_revision
from book_core.contracts import DocumentRevision, SearchChunk
from book_core.indexing import IndexReport
from book_core.parser import ParserError, PdfParser
from book_core.structure import build_revision
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import (
    WorkerNotConfiguredError,
    build_index_store,
    build_parser,
    page_count,
)
from quiz_worker.document_store import (
    DocumentDeletedError,
    DocumentRow,
    DocumentStore,
    PostgresDocumentStore,
    RevisionRow,
)
from quiz_worker.errors import (
    JobCancelledError,
    NonRetryableJobError,
    is_retryable,
    sanitize_error,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings
from quiz_worker.storage import PARSED_BUCKET, SOURCE_BUCKET, ObjectStorage, SupabaseStorage

logger = logging.getLogger(__name__)

JOB_TYPE = "document.parse"
PDF_MAGIC = b"%PDF-"
CANCELLED_ERROR = "cancelled"


class DocumentNotFoundError(NonRetryableJobError):
    code = "document_not_found"


class SourceInvalidError(NonRetryableJobError):
    code = "source_invalid"


class TooManyPagesError(NonRetryableJobError):
    code = "too_many_pages"


class ParseFailedError(NonRetryableJobError):
    code = "parse_failed"


class NoIndexableTextError(NonRetryableJobError):
    code = "no_indexable_text"


class DocumentParsePayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    document_id: uuid.UUID
    revision_id: uuid.UUID


class IndexWriter(Protocol):
    """The `QdrantIndexStore` operations the job uses."""

    def index_revision(
        self,
        workspace_id: str,
        document_id: str,
        revision_id: str,
        chunks: list[SearchChunk],
        *,
        base_revision_id: str | None = None,
        document_type: str | None = None,
    ) -> IndexReport: ...

    def activate_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None: ...

    def delete_inactive_revisions(
        self, workspace_id: str, document_id: str, *, keep: Any = ()
    ) -> None: ...

    def delete_revision(self, workspace_id: str, document_id: str, revision_id: str) -> None: ...


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 50 * 1024 * 1024
    max_pages: int = 1500
    lock_wait_seconds: float = 60


@dataclass
class DocumentJobDeps:
    documents: DocumentStore
    storage: ObjectStorage
    index: IndexWriter
    parser: PdfParser
    limits: Limits
    page_counter: Callable[[Path], int | None] = page_count


def parsed_object_key(document: DocumentRow, revision_id: uuid.UUID) -> str:
    return (
        f"workspaces/{document.workspace_id}/documents/{document.id}/revisions/{revision_id}"
        "/parsed_document.json"
    )


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_document_parse(
    deps: DocumentJobDeps, ctx: JobContext, payload: DocumentParsePayloadV1
) -> JobResult:
    def progress(stage: str, percent: int) -> None:
        try:
            deps.documents.report_progress(ctx.job_id, ctx.attempt, stage, percent)
        except Exception as exc:  # progress is best effort
            logger.warning("progress update failed: %s", type(exc).__name__)

    try:
        with deps.documents.document_lock(
            payload.document_id,
            wait_seconds=deps.limits.lock_wait_seconds,
            check=ctx.check_cancelled,
        ):
            return _pipeline(deps, ctx, payload, progress)
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            _record_failure(deps, payload, sanitize_error(exc))
        raise


def _record_failure(deps: DocumentJobDeps, payload: DocumentParsePayloadV1, error: str) -> None:
    try:
        deps.documents.record_failure(payload.document_id, payload.revision_id, error)
    except Exception as exc:
        # The cleanup obligation records it again.
        logger.warning("could not record the document failure: %s", type(exc).__name__)


def _pipeline(
    deps: DocumentJobDeps,
    ctx: JobContext,
    payload: DocumentParsePayloadV1,
    progress: Callable[[str, int], None],
) -> JobResult:
    found = deps.documents.load(ctx.workspace_id, payload.document_id, payload.revision_id)
    if found is None:
        raise DocumentNotFoundError("document or revision not found in this workspace")
    document, revision = found
    ws, doc_id, rev_id = str(document.workspace_id), str(document.id), str(revision.id)

    if revision.published:
        if document.active_revision_id == revision.id:
            # A previous attempt committed the switch; finish the index side only (older
            # revisions are collected by the next publish: the rollback target is unknown here).
            deps.index.activate_revision(ws, doc_id, rev_id)
            return _result(document, revision, chunks=None)
        # Published but no longer active (superseded or rolled back): nothing to do.
        return _result(document, revision, chunks=None)
    if document.deleted:
        raise DocumentDeletedError("the document was deleted")

    deps.documents.mark_processing(document.id)
    if revision.content_hash is None:
        content = _parse_and_store(deps, ctx, document, revision, progress)
    else:
        progress("loading", 40)
        content = deps.documents.load_content(document, revision)
    ctx.check_cancelled()

    progress("chunking", 50)
    chunks = list(chunk_revision(content, document_title=document.title).chunks)
    if not any(c.level.value == "child" for c in chunks):
        raise NoIndexableTextError("the document has no text to index")

    progress("indexing", 60)
    deps.index.index_revision(ws, doc_id, rev_id, chunks, document_type=document.document_type)
    ctx.check_cancelled()

    progress("publishing", 90)
    assert content.content_hash is not None  # noqa: S101 - build_revision / DB always set it
    previous = deps.documents.publish(
        document.id, revision.id, content.content_hash, before_commit=ctx.check_cancelled
    )
    _activate(deps, ws, doc_id, rev_id, previous=previous)
    return _result(document, revision, chunks=len(chunks))


def _parse_and_store(
    deps: DocumentJobDeps,
    ctx: JobContext,
    document: DocumentRow,
    revision: RevisionRow,
    progress: Callable[[str, int], None],
) -> DocumentRevision:
    progress("downloading", 5)
    with tempfile.TemporaryDirectory(prefix="quiz-parse-") as tmp:
        path = Path(tmp) / "source.pdf"
        downloaded = deps.storage.download(
            SOURCE_BUCKET,
            document.source_object_key,
            path,
            max_bytes=min(deps.limits.max_bytes, document.size_bytes),
        )
        if downloaded.size != document.size_bytes or downloaded.sha256 != document.sha256:
            raise SourceInvalidError("the stored file does not match its recorded checksum")
        with path.open("rb") as fh:
            if fh.read(len(PDF_MAGIC)) != PDF_MAGIC:
                raise SourceInvalidError("the stored file is not a PDF")
        pages = deps.page_counter(path)
        if pages is not None and pages < 0:
            raise SourceInvalidError("the PDF cannot be read")
        if pages is not None and pages > deps.limits.max_pages:
            raise TooManyPagesError(f"the PDF has more than {deps.limits.max_pages} pages")
        ctx.check_cancelled()

        progress("parsing", 15)
        try:
            parsed = deps.parser.parse(path, source_path=document.source_object_key)
        except ParserError:
            # Never the parser's message: it can quote document text.
            raise ParseFailedError("the PDF could not be parsed") from None
    if len(parsed.pages) > deps.limits.max_pages:
        raise TooManyPagesError(f"the PDF has more than {deps.limits.max_pages} pages")
    ctx.check_cancelled()

    progress("structuring", 30)
    key = parsed_object_key(document, revision.id)
    deps.storage.upload(
        PARSED_BUCKET, key, parsed.model_dump_json().encode(), content_type="application/json"
    )
    structured = build_revision(parsed, document_id=str(document.id), revision_id=str(revision.id))
    try:
        content = DocumentRevision.model_validate(
            {
                **structured.revision.model_dump(),
                "revision_number": revision.revision_number,
                "parent_revision_id": (
                    str(revision.parent_revision_id) if revision.parent_revision_id else None
                ),
                "source_sha256": document.sha256,
            }
        )
    except ValidationError:
        raise ParseFailedError("the parsed document is inconsistent") from None
    deps.documents.write_content(
        document,
        revision,
        content,
        parser_version=parsed.parser_version,
        parsed_object_key=key,
    )
    return content


def _activate(
    deps: DocumentJobDeps, ws: str, doc_id: str, rev_id: str, *, previous: uuid.UUID | None
) -> None:
    deps.index.activate_revision(ws, doc_id, rev_id)
    keep = {str(previous)} if previous is not None and str(previous) != rev_id else set()
    deps.index.delete_inactive_revisions(ws, doc_id, keep=keep)


def _result(document: DocumentRow, revision: RevisionRow, *, chunks: int | None) -> JobResult:
    result: dict[str, Any] = {"document_id": str(document.id), "revision_id": str(revision.id)}
    if chunks is not None:
        result["chunks"] = chunks
    return result


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_document_parse(deps: DocumentJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    job = deps.documents.job(ctx.job_id)
    if job is None:
        return
    try:
        payload = DocumentParsePayloadV1.model_validate(job.payload)
    except ValidationError:
        return  # the job never had a usable payload, so it never started work
    with deps.documents.document_lock(
        payload.document_id, wait_seconds=deps.limits.lock_wait_seconds, check=lambda: None
    ):
        found = deps.documents.load(ctx.workspace_id, payload.document_id, payload.revision_id)
        if found is None:
            return
        document, revision = found
        if revision.published:
            return  # it went live after all; nothing partial is left
        deps.index.delete_revision(str(document.workspace_id), str(document.id), str(revision.id))
        if revision.content_hash is None:
            # An artifact uploaded by an attempt that never committed the content.
            deps.storage.delete(PARSED_BUCKET, parsed_object_key(document, revision.id))
        error = CANCELLED_ERROR if reason == "cancelled" else (job.last_error or "job_failed")
        deps.documents.record_failure(document.id, revision.id, error)


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], DocumentJobDeps]


def document_parse_definition(provider: DepsProvider) -> JobDefinition[DocumentParsePayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: DocumentParsePayloadV1},
        handler=lambda ctx, payload: run_document_parse(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_document_parse(provider(), ctx, reason),
    )


def deps_from_settings(settings: WorkerSettings) -> DocumentJobDeps:
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
    return DocumentJobDeps(
        documents=PostgresDocumentStore(engine),
        storage=SupabaseStorage(
            settings.supabase_url,
            secret.get_secret_value(),
            timeout=settings.storage_timeout_seconds,
        ),
        index=build_index_store(settings),
        parser=build_parser(settings),
        limits=Limits(
            max_bytes=settings.pdf_max_bytes,
            max_pages=settings.pdf_max_pages,
            lock_wait_seconds=settings.document_lock_wait_seconds,
        ),
    )


class LazyDeps:
    """Builds the dependencies once per process, on the first job (prefork children build
    their own; models load on first use)."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: DocumentJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> DocumentJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
