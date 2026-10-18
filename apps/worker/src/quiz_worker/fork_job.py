"""`workspace.fork` v1: copy a shared workspace's pinned published snapshot (S3a).

Payload (written by apps/api `POST /shared/{id}/forks`): `{fork_id}`. The job runs in the
*source* workspace for `created_by` = the forking user; the fork row says what to copy
(`source_snapshot_manifest`, pinned by the API) and where (`worker_fork_documents`).

Pipeline (docs/workspace-sharing.md §6):

1. load the fork; a COMPLETED fork (an earlier attempt committed) only re-runs step 6, a
   CANCELLED / FAILED one ends the job the same way;
2. re-check the link (revoked / expired / allow_fork off / source deleted → CANCELLED) and mark
   the fork COPYING;
3. copy every pinned document's original PDF (and parse artifact) inside the private buckets to
   the target keys (`workspaces/{new ws}/documents/{new doc}/revisions/{new rev}/...`),
   server-side; re-check the link between documents;
4. index the copied revisions in Qdrant as *inactive* revisions of the target workspace: the
   content is the pinned source revision's (read from the DB) under the new document / revision
   ids, chunked like `document.parse` does (existing points are never embedded again, so a retry
   is cheap);
5. `worker_fork_commit`: re-check the link under a lock and write the whole copy in one
   transaction (or nothing: an unusable link → CANCELLED). The commit also enqueues one
   `document.index_sync` obligation per copied revision;
6. mirror the switch in Qdrant (`activate_revision`) under each copied document's lock, only
   while the copied revision is still the document's active revision in the DB (a retry after
   the new owner published a newer revision must not re-activate revision 1), and resolve the
   obligations; a failure here is left to them (the fork is already COMPLETED).

Every step is idempotent (deterministic target ids and keys, upserting copies, idempotent
indexing, an idempotent commit), so a redelivery or a retry resumes. Cancellation and failure:
the fork is marked CANCELLED / FAILED first (the commit then refuses it), and the cleanup
obligation (also for a lost worker's final attempt) removes the copied Storage objects and the
Qdrant points; no DB rows exist for an uncommitted fork.

Fault injection (APP_ENV=test only, tests/e2e/fixtures/sharing.ts S6): a fork name containing
`E2E-FORK-PAUSE` holds in COPYING right before the commit until the link stops being usable or
60 s pass; `E2E-FAIL-FORK` fails the job after copying.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NoReturn

from book_core.chunker import chunk_revision
from book_core.contracts import DocumentRevision
from pydantic import BaseModel, ConfigDict, ValidationError

from quiz_worker.adapters import WorkerNotConfiguredError, build_index_store
from quiz_worker.document_job import IndexWriter
from quiz_worker.document_store import DocumentStore, PostgresDocumentStore
from quiz_worker.errors import (
    JobCancelledError,
    NonRetryableJobError,
    is_retryable,
    sanitize_error,
)
from quiz_worker.fork_store import ForkDocument, ForkRow, ForkStore, PostgresForkStore
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings
from quiz_worker.storage import (
    PARSED_BUCKET,
    SOURCE_BUCKET,
    ObjectCopier,
    ObjectMissingError,
    SupabaseStorage,
)

logger = logging.getLogger(__name__)

JOB_TYPE = "workspace.fork"
PAUSE_MARKER = "E2E-FORK-PAUSE"
FAILURE_MARKER = "E2E-FAIL-FORK"
# Stable codes in workspace_forks.last_error (GET /me/forks error_code).
SHARE_UNAVAILABLE = "share_unavailable"


class ForkNotFoundError(NonRetryableJobError):
    code = "fork_not_found"


class ForkFailedError(NonRetryableJobError):
    code = "fork_failed"


class ForkContentInvalidError(NonRetryableJobError):
    code = "content_invalid"


class InjectedForkFailureError(NonRetryableJobError):
    code = "fork_injected_failure"


class WorkspaceForkPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    fork_id: uuid.UUID


@dataclass
class ForkJobDeps:
    forks: ForkStore
    documents: DocumentStore
    storage: ObjectCopier
    index: IndexWriter
    inject_failures: bool = False
    pause_seconds: float = 60.0
    poll_seconds: float = 0.25
    lock_wait_seconds: float = 30.0
    sleep: Callable[[float], None] = field(default=time.sleep)
    clock: Callable[[], float] = field(default=time.monotonic)


# --------------------------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------------------------


def run_workspace_fork(
    deps: ForkJobDeps, ctx: JobContext, payload: WorkspaceForkPayloadV1
) -> JobResult:
    fork = deps.forks.get(payload.fork_id)
    # The job's identity must match the request it serves (same workspace, same user).
    if (
        fork is None
        or fork.source_workspace_id != ctx.workspace_id
        or fork.forked_by != ctx.created_by
    ):
        raise ForkNotFoundError("the fork does not exist for this job")
    if fork.status == "COMPLETED":
        return _finish(deps, fork, deps.forks.documents(fork.id))
    if fork.status == "CANCELLED":
        raise JobCancelledError()
    if fork.status == "FAILED":
        raise ForkFailedError("the fork already failed")
    try:
        return _copy(deps, ctx, fork)
    except JobCancelledError:
        raise
    except Exception as exc:
        if not is_retryable(exc) or ctx.is_final_attempt:
            deps.forks.mark(fork.id, "FAILED", error=sanitize_error(exc))
        raise


def _copy(deps: ForkJobDeps, ctx: JobContext, fork: ForkRow) -> JobResult:
    _ensure_usable(deps, ctx, fork)
    deps.forks.mark(fork.id, "COPYING", progress=5)
    documents = deps.forks.documents(fork.id)
    total = max(1, len(documents))

    for i, doc in enumerate(documents, start=1):
        _copy_objects(deps, doc)
        _ensure_usable(deps, ctx, fork)
        deps.forks.mark(fork.id, "COPYING", progress=5 + 35 * i // total)

    for i, doc in enumerate(documents, start=1):
        _index_copy(deps, ctx, doc)
        _ensure_usable(deps, ctx, fork)
        deps.forks.mark(fork.id, "COPYING", progress=40 + 50 * i // total)

    if deps.inject_failures and FAILURE_MARKER in fork.name:
        raise InjectedForkFailureError("injected fork failure")
    if deps.inject_failures and PAUSE_MARKER in fork.name:
        _pause(deps, ctx, fork)
    ctx.check_cancelled()

    outcome = deps.forks.commit(fork.id)
    if outcome == "completed":
        return _finish(deps, deps.forks.get(fork.id) or fork, documents)
    if outcome == "unusable":
        _cancel(deps, fork)
    if outcome == "cancelled":
        raise JobCancelledError()
    if outcome == "failed":
        raise ForkFailedError("the fork already failed")
    raise ForkNotFoundError("the fork disappeared")


def _ensure_usable(deps: ForkJobDeps, ctx: JobContext, fork: ForkRow) -> None:
    ctx.check_cancelled()
    if not deps.forks.source_usable(fork.id):
        _cancel(deps, fork)


def _cancel(deps: ForkJobDeps, fork: ForkRow) -> NoReturn:
    """The link was revoked / expired / set to no-fork, or its workspace deleted: CANCELLED."""
    deps.forks.mark(fork.id, "CANCELLED", error=SHARE_UNAVAILABLE)
    raise JobCancelledError()


def _copy_objects(deps: ForkJobDeps, doc: ForkDocument) -> None:
    deps.storage.copy(SOURCE_BUCKET, doc.source_object_key, doc.target_object_key)
    if doc.source_parsed_object_key and doc.target_parsed_object_key:
        try:
            deps.storage.copy(
                PARSED_BUCKET, doc.source_parsed_object_key, doc.target_parsed_object_key
            )
        except ObjectMissingError:
            # A derived artifact (the published content lives in the DB); never fatal.
            logger.warning("fork: parse artifact of a pinned revision is missing")


def target_content(content: DocumentRevision, doc: ForkDocument) -> DocumentRevision:
    """The pinned source revision's content under the copy's document / revision ids."""
    try:
        return DocumentRevision.model_validate(
            {
                **content.model_dump(),
                "document_id": str(doc.target_document_id),
                "revision_id": str(doc.target_revision_id),
                "revision_number": 1,
                "parent_revision_id": None,
            }
        )
    except ValidationError:
        # Never the validation text: it quotes block content.
        raise ForkContentInvalidError("the pinned revision content is inconsistent") from None


def _index_copy(deps: ForkJobDeps, ctx: JobContext, doc: ForkDocument) -> None:
    found = deps.documents.load(ctx.workspace_id, doc.source_document_id, doc.source_revision_id)
    if found is None:  # pragma: no cover - the plan only lists rows that exist
        raise ForkContentInvalidError("a pinned document is missing")
    content = target_content(deps.documents.load_content(*found), doc)
    chunks = list(chunk_revision(content, document_title=doc.title).chunks)
    if chunks:
        deps.index.index_revision(
            str(doc.target_workspace_id),
            str(doc.target_document_id),
            str(doc.target_revision_id),
            chunks,
            document_type=doc.document_type,
        )


def _pause(deps: ForkJobDeps, ctx: JobContext, fork: ForkRow) -> None:
    """Test-only hold right before the commit (S6), until the link is unusable or time is up."""
    deadline = deps.clock() + deps.pause_seconds
    while deps.clock() < deadline:
        if not deps.forks.source_usable(fork.id):
            return  # the commit's locked re-check cancels the fork
        ctx.check_cancelled()
        deps.sleep(deps.poll_seconds)


def _finish(deps: ForkJobDeps, fork: ForkRow, documents: list[ForkDocument]) -> JobResult:
    """Activate the committed copies in Qdrant (else left to their index_sync obligations)."""
    synced = True
    for doc in documents:
        try:
            _activate_copy(deps, doc)
        except Exception as exc:
            synced = False
            logger.warning("fork index activation left to index_sync: %s", sanitize_error(exc))
    result: dict[str, Any] = {
        "fork_id": str(fork.id),
        "target_workspace_id": str(fork.target_workspace_id) if fork.target_workspace_id else None,
        "documents": len(documents),
    }
    if not synced:
        result["index_sync"] = "pending"
    return result


def _activate_copy(deps: ForkJobDeps, doc: ForkDocument) -> None:
    """Mirror the commit for one copied document, like `document.index_sync`: under the
    document's lock and only while the copied revision is still the DB's active revision. A
    retried (or late) fork job must never re-activate revision 1 after the new owner published
    a newer revision; PostgreSQL is authoritative and the newer publish owns the mirror."""
    with deps.documents.document_lock(
        doc.target_document_id, wait_seconds=deps.lock_wait_seconds, check=lambda: None
    ):
        found = deps.documents.load(
            doc.target_workspace_id, doc.target_document_id, doc.target_revision_id
        )
        if found is None:
            return  # not committed, or removed since
        document, revision = found
        if revision.published and document.active_revision_id == revision.id:
            deps.index.activate_revision(
                str(doc.target_workspace_id),
                str(doc.target_document_id),
                str(doc.target_revision_id),
            )
    # Done either way: activated now, or superseded by a newer publish (its own obligation).
    deps.documents.resolve_index_sync(doc.target_workspace_id, doc.target_revision_id)


# --------------------------------------------------------------------------------------------
# Cleanup obligation (failed / cancelled)
# --------------------------------------------------------------------------------------------


def cleanup_workspace_fork(deps: ForkJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    job = deps.documents.job(ctx.job_id)
    if job is None:
        return
    try:
        payload = WorkspaceForkPayloadV1.model_validate(job.payload)
    except ValidationError:
        return  # the job never had a usable payload, so it never started work
    fork = deps.forks.get(payload.fork_id)
    if fork is None or fork.source_workspace_id not in (None, ctx.workspace_id):
        return
    # Terminal first: from here on the commit refuses this fork, so nothing can go live while
    # (or after) its copies are removed.
    if reason == "cancelled":
        deps.forks.mark(fork.id, "CANCELLED", error="cancelled")
    else:
        deps.forks.mark(fork.id, "FAILED", error=job.last_error or "job_failed")
    current = deps.forks.get(fork.id)
    if current is None or current.status == "COMPLETED":
        return
    for doc in deps.forks.documents(fork.id):
        deps.index.delete_revision(
            str(doc.target_workspace_id), str(doc.target_document_id), str(doc.target_revision_id)
        )
        deps.storage.delete(SOURCE_BUCKET, doc.target_object_key)
        if doc.target_parsed_object_key:
            deps.storage.delete(PARSED_BUCKET, doc.target_parsed_object_key)


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], ForkJobDeps]


def workspace_fork_definition(provider: DepsProvider) -> JobDefinition[WorkspaceForkPayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: WorkspaceForkPayloadV1},
        handler=lambda ctx, payload: run_workspace_fork(provider(), ctx, payload),
        # Matches async_jobs.max_attempts (default 3) the API inserts.
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=10, max_delay_seconds=300),
        cleanup=lambda ctx, reason: cleanup_workspace_fork(provider(), ctx, reason),
    )


def deps_from_settings(settings: WorkerSettings) -> ForkJobDeps:
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
    return ForkJobDeps(
        forks=PostgresForkStore(engine),
        documents=PostgresDocumentStore(engine),
        storage=SupabaseStorage(
            settings.supabase_url,
            secret.get_secret_value(),
            timeout=settings.storage_timeout_seconds,
        ),
        index=build_index_store(settings),
        inject_failures=settings.is_test,
        lock_wait_seconds=settings.document_lock_wait_seconds,
    )


class LazyForkDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: ForkJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> ForkJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
