"""Rebuild the Qdrant document index from PostgreSQL (M7.3, docs/deployment.md §7).

PostgreSQL is canonical and Qdrant is a rebuildable index: after a lost or replaced Qdrant
(restore, new cluster, wiped volume) or a missed mirror, this re-indexes every live document's
*published active revision* from the DB rows, with the worker's own code path:

    load the revision content (chapters + content blocks) -> `chunk_revision` ->
    `QdrantIndexStore.index_revision` -> `mirror_active_revision` (activate + collect older
    revisions, the same step `document.parse` / `document.index_sync` run).

Run (worker environment: WORKER_DATABASE_URL as the least-privilege `quiz_worker` role, QDRANT_*,
QDRANT_COLLECTION_PREFIX and the embedder settings of the worker that will keep indexing):

    python -m quiz_worker.reindex --all [--dry-run]
    python -m quiz_worker.reindex --workspace <uuid> [--workspace <uuid> ...]
    python -m quiz_worker.reindex --all --after <document uuid>   # resume after an interruption

Properties:

- Idempotent: points already stored for a revision are reused, not embedded again, so a second
  run only re-checks (`embedded == 0`). Safe while API and workers are running: each document is
  handled under the same advisory lock the jobs take, and a document whose active revision
  changed meanwhile is skipped (its own job keeps the index in sync).
- Resumable: documents are processed in document-id order and every finished one is printed, so
  `--after <last printed id>` continues an interrupted run (re-running from the start is also
  cheap, see above).
- `--dry-run` reads the DB only (which documents/revisions, chunk counts); it never connects to
  Qdrant or loads an embedding model.
- Scope: documents that are not soft-deleted and have an active revision. Archived workspaces
  stay searchable and are included. The worker role cannot read workspace rows, so documents of a
  soft-deleted workspace are re-indexed too; search never reaches them (the API scopes every query
  by DB-visible workspace and revision ids).
- Output: ids and counts only, never titles or book text.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, TextIO

from book_core.chunker import chunk_revision
from sqlalchemy import Engine, text

from quiz_worker.document_job import IndexWriter, mirror_active_revision
from quiz_worker.document_store import DocumentBusyError, DocumentStore, PostgresDocumentStore
from quiz_worker.errors import sanitize_error
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

PAGE_SIZE = 200

Status = Literal["indexed", "planned", "skipped", "busy", "failed"]


@dataclass(frozen=True)
class Target:
    workspace_id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID


@dataclass(frozen=True)
class Outcome:
    document_id: str
    workspace_id: str
    revision_id: str
    status: Status
    chunks: int | None = None
    embedded: int | None = None
    reused: int | None = None
    reason: str | None = None


@dataclass
class Summary:
    outcomes: list[Outcome] = field(default_factory=list)

    def count(self, status: Status) -> int:
        return sum(1 for o in self.outcomes if o.status == status)

    @property
    def ok(self) -> bool:
        return self.count("failed") == 0 and self.count("busy") == 0

    def as_dict(self) -> dict[str, Any]:
        statuses: tuple[Status, ...] = ("indexed", "planned", "skipped", "busy", "failed")
        last = self.outcomes[-1].document_id if self.outcomes else None
        return {
            "documents": len(self.outcomes),
            **{s: self.count(s) for s in statuses},
            "embedded": sum(o.embedded or 0 for o in self.outcomes),
            "last_document_id": last,
        }


# --------------------------------------------------------------------------------------------
# Source: live documents with an active revision, keyset-paginated by document id
# --------------------------------------------------------------------------------------------

_TARGETS = text(
    """
    select d.workspace_id, d.id as document_id, d.active_revision_id as revision_id
      from public.documents d
     where d.deleted_at is null
       and d.active_revision_id is not null
       and (cast(:all_workspaces as boolean) or d.workspace_id = any(cast(:workspaces as uuid[])))
       and (cast(:after as uuid) is null or d.id > cast(:after as uuid))
     order by d.id
     limit :limit
    """
)


def iter_targets(
    engine: Engine,
    workspaces: Sequence[uuid.UUID] | None,
    *,
    after: uuid.UUID | None = None,
    page_size: int = PAGE_SIZE,
) -> Iterator[Target]:
    """Every live document with an active revision (all, or only in `workspaces`), by id."""
    cursor = after
    while True:
        with engine.connect() as conn:
            rows = (
                conn.execute(
                    _TARGETS,
                    {
                        "all_workspaces": workspaces is None,
                        "workspaces": list(workspaces or []),
                        "after": cursor,
                        "limit": page_size,
                    },
                )
                .mappings()
                .all()
            )
        for row in rows:
            yield Target(row["workspace_id"], row["document_id"], row["revision_id"])
        if len(rows) < page_size:
            return
        cursor = rows[-1]["document_id"]


# --------------------------------------------------------------------------------------------
# One document
# --------------------------------------------------------------------------------------------


def reindex_document(
    documents: DocumentStore,
    index: IndexWriter | None,
    target: Target,
    *,
    lock_wait_seconds: float = 60,
) -> Outcome:
    """Re-index `target` from the DB (`index=None`: dry run, DB reads only)."""

    def outcome(status: Status, **extra: Any) -> Outcome:
        return Outcome(
            str(target.document_id),
            str(target.workspace_id),
            str(target.revision_id),
            status,
            **extra,
        )

    try:
        with documents.document_lock(
            target.document_id, wait_seconds=lock_wait_seconds, check=lambda: None
        ):
            found = documents.load(target.workspace_id, target.document_id, target.revision_id)
            if found is None:
                return outcome("skipped", reason="not_found")
            document, revision = found
            if (
                document.deleted
                or not revision.published
                or document.active_revision_id != revision.id
            ):
                # Changed since it was listed; the job that changed it owns the index.
                return outcome("skipped", reason="no_longer_active")
            content = documents.load_content(document, revision)
            chunks = list(chunk_revision(content, document_title=document.title).chunks)
            if index is None:
                return outcome("planned", chunks=len(chunks))
            report = index.index_revision(
                str(document.workspace_id),
                str(document.id),
                str(revision.id),
                chunks,
                document_type=document.document_type,
            )
            mirror_active_revision(documents, index, document, revision)
    except DocumentBusyError:
        return outcome("busy", reason="document_busy")
    except Exception as exc:
        # Sanitized: never connection strings or book text.
        return outcome("failed", reason=sanitize_error(exc))
    try:
        # A still-pending `document.index_sync` obligation for this revision is now satisfied.
        documents.resolve_index_sync(document.workspace_id, revision.id)
    except Exception as exc:
        logger.warning("could not resolve the index sync obligation: %s", type(exc).__name__)
    return outcome("indexed", chunks=len(chunks), embedded=report.embedded, reused=report.reused)


def run(
    targets: Iterator[Target],
    documents: DocumentStore,
    index: IndexWriter | None,
    *,
    lock_wait_seconds: float = 60,
    limit: int | None = None,
    fail_fast: bool = False,
    on_outcome: Callable[[Outcome], None] = lambda _: None,
) -> Summary:
    summary = Summary()
    for target in targets:
        if limit is not None and len(summary.outcomes) >= limit:
            break
        outcome = reindex_document(documents, index, target, lock_wait_seconds=lock_wait_seconds)
        summary.outcomes.append(outcome)
        on_outcome(outcome)
        if fail_fast and outcome.status in ("failed", "busy"):
            break
    return summary


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m quiz_worker.reindex",
        description="Rebuild the Qdrant document index from PostgreSQL published active revisions.",
    )
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--all", action="store_true", help="every workspace")
    scope.add_argument(
        "--workspace",
        action="append",
        type=uuid.UUID,
        metavar="UUID",
        help="only this workspace (repeatable)",
    )
    parser.add_argument(
        "--after", type=uuid.UUID, metavar="DOCUMENT_UUID", help="resume after this document id"
    )
    parser.add_argument("--limit", type=int, help="stop after this many documents")
    parser.add_argument(
        "--dry-run", action="store_true", help="list what would be indexed (DB reads only)"
    )
    parser.add_argument(
        "--fail-fast", action="store_true", help="stop at the first failed or busy document"
    )
    parser.add_argument(
        "--lock-wait-seconds",
        type=float,
        help="wait this long for a document a job holds "
        "(default: WORKER_DOCUMENT_LOCK_WAIT_SECONDS)",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be >= 1")
    return args


def _print_json(stream: TextIO, value: dict[str, Any]) -> None:
    stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    stream.flush()


def main(
    argv: Sequence[str] | None = None,
    *,
    settings: WorkerSettings | None = None,
    out: TextIO = sys.stdout,
) -> int:
    args = parse_args(argv)
    settings = settings or WorkerSettings()
    from quiz_worker.logging_config import configure_logging

    configure_logging(settings.log_level)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if settings.worker_database_url is None:
        print("reindex: WORKER_DATABASE_URL is not set", file=sys.stderr)
        return 2
    from quiz_worker.adapters import build_index_store
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=2,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    try:
        documents = PostgresDocumentStore(engine)
        index = None if args.dry_run else build_index_store(settings)
        workspaces = None if args.all else list(dict.fromkeys(args.workspace))
        summary = run(
            iter_targets(engine, workspaces, after=args.after),
            documents,
            index,
            lock_wait_seconds=(
                args.lock_wait_seconds
                if args.lock_wait_seconds is not None
                else settings.document_lock_wait_seconds
            ),
            limit=args.limit,
            fail_fast=args.fail_fast,
            on_outcome=lambda o: _print_json(
                out, {k: v for k, v in asdict(o).items() if v is not None}
            ),
        )
    finally:
        engine.dispose()
    _print_json(out, {"summary": summary.as_dict(), "dry_run": args.dry_run})
    return 0 if summary.ok else 1


if __name__ == "__main__":
    sys.exit(main())
