"""Fork requests (S3a; docs/workspace-sharing.md §4-§6) over `public.workspace_forks`.

The API side of a fork only *records* the request, in one transaction with its job:

1. `snapshot()` pins the published snapshot of the link's workspace: the active published
   revision of every live document and the active revision of every CONFIRMED live question
   (exactly what the shared view shows; drafts, archived/deleted questions and import drafts are
   never pinned), each question with its source records as they are now (`question_sources` is
   replaced on edit, so sources are pinned by value and not read again at commit);
2. `create()` inserts the `workspace.fork` job (in the *source* workspace, `created_by` = the
   forking user, payload `{fork_id}`) and the PENDING fork row with the manifest, a random id
   salt and the id the new workspace will get.

Everything else (copying, the commit-time re-check, cleanup) is the worker's
(apps/worker quiz_worker.fork_job, `public.worker_fork_commit`). The workspace itself does not
exist before the worker commits, so `target_workspace_id` stays null until COMPLETED.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import func, insert, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from quiz_api.repositories.search import SearchRepository
from quiz_api.repositories.tables import async_jobs, workspace_forks

FORK_JOB_TYPE = "workspace.fork"
FORK_JOB_SCHEMA_VERSION = 1
# 2: questions carry their pinned sources (20261018200000_workspace_fork_source_snapshot.sql).
MANIFEST_VERSION = 2

# `workspace_forks_manifest_size`: pg_column_size(source_snapshot_manifest) <= 4 MiB.
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_MANIFEST_CHECK = "workspace_forks_manifest_size"


class ForkTooLargeError(Exception):
    """The pinned snapshot does not fit the manifest column (route: 409 fork-too-large)."""


ForkStatus = Literal["PENDING", "COPYING", "COMPLETED", "FAILED", "CANCELLED"]


@dataclass(frozen=True)
class PinnedQuestion:
    question_id: uuid.UUID
    revision_id: uuid.UUID
    # The question's `question_sources` rows as they were with this revision (JSON-ready).
    sources: list[dict[str, Any]]


@dataclass(frozen=True)
class Snapshot:
    documents: list[tuple[uuid.UUID, uuid.UUID]]  # (document id, published revision id)
    questions: list[PinnedQuestion]

    def manifest_entries(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        return (
            [{"document_id": str(d), "revision_id": str(r)} for d, r in self.documents],
            [
                {
                    "question_id": str(q.question_id),
                    "revision_id": str(q.revision_id),
                    "sources": q.sources,
                }
                for q in self.questions
            ],
        )


@dataclass(frozen=True)
class ForkRecord:
    id: uuid.UUID
    forked_by: uuid.UUID
    name: str
    status: ForkStatus
    progress: int
    target_workspace_id: uuid.UUID | None
    async_job_id: uuid.UUID | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


@dataclass(frozen=True)
class ForkJob:
    id: uuid.UUID
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    job_type: str
    schema_version: int
    idempotency_key: str | None
    payload: dict[str, Any]
    status: str
    published_at: datetime | None


_COLUMNS = (
    workspace_forks.c.id,
    workspace_forks.c.forked_by,
    workspace_forks.c.name,
    workspace_forks.c.status,
    workspace_forks.c.progress,
    workspace_forks.c.target_workspace_id,
    workspace_forks.c.async_job_id,
    workspace_forks.c.last_error,
    workspace_forks.c.created_at,
    workspace_forks.c.updated_at,
    workspace_forks.c.completed_at,
)


_PINNED_QUESTIONS = text(
    """
    select q.id, q.active_revision_id,
           coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'document_id', s.document_id,
             'document_revision_id', s.document_revision_id,
             'page_start', s.page_start, 'page_end', s.page_end,
             'block_ids', to_jsonb(s.block_ids), 'locations', s.locations)
             order by s.created_at, s.id) filter (where s.id is not null),
             '[]'::jsonb) as sources
      from public.questions q
      left join public.question_sources s
        on s.question_id = q.id and s.workspace_id = q.workspace_id
     where q.workspace_id = :ws and q.publication_status = 'CONFIRMED'
       and q.deleted_at is null and q.active_revision_id is not null
     group by q.id
     order by q.created_at, q.id
    """
)


def fork_job_key(fork_id: uuid.UUID) -> str:
    return f"fork:{fork_id}"


class ForkRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    def snapshot(self, workspace_id: uuid.UUID) -> Snapshot:
        docs = SearchRepository(self._session).searchable_documents(workspace_id)
        # One statement: each question's active revision and its sources come from the same
        # snapshot (an edit replaces both in one transaction), so the copy never mixes versions.
        rows = self._session.execute(_PINNED_QUESTIONS, {"ws": workspace_id}).all()
        return Snapshot(
            documents=[(d.id, d.revision_id) for d in docs],
            questions=[PinnedQuestion(r.id, r.active_revision_id, list(r.sources)) for r in rows],
        )

    def create(
        self,
        *,
        source_workspace_id: uuid.UUID,
        source_workspace_name: str,
        share_link_id: uuid.UUID,
        user_id: uuid.UUID,
        name: str,
        snapshot: Snapshot,
    ) -> tuple[ForkRecord, ForkJob]:
        fork_id, job_id = uuid.uuid4(), uuid.uuid4()
        pinned_documents, pinned_questions = snapshot.manifest_entries()
        manifest = {
            "version": MANIFEST_VERSION,
            "id_salt": str(uuid.uuid4()),
            "target_workspace_id": str(uuid.uuid4()),
            "documents": pinned_documents,
            "questions": pinned_questions,
        }
        # Measured as the DB measures it: the CHECK sees the uncompressed JSONB datum, whose size
        # is not bounded by the length of compact JSON text (binary headers, offsets, numerics).
        size = self._session.execute(
            text("select pg_column_size(cast(:manifest as jsonb))"),
            {"manifest": json.dumps(manifest)},
        ).scalar_one()
        if size > MAX_MANIFEST_BYTES:
            raise ForkTooLargeError
        self._session.execute(
            insert(async_jobs).values(
                id=job_id,
                workspace_id=source_workspace_id,
                created_by=user_id,
                job_type=FORK_JOB_TYPE,
                schema_version=FORK_JOB_SCHEMA_VERSION,
                idempotency_key=fork_job_key(fork_id),
                payload={"fork_id": str(fork_id)},
            )
        )
        try:
            with self._session.begin_nested():
                row = self._insert_fork(
                    fork_id=fork_id,
                    source_workspace_id=source_workspace_id,
                    source_workspace_name=source_workspace_name,
                    share_link_id=share_link_id,
                    user_id=user_id,
                    name=name,
                    job_id=job_id,
                    manifest=manifest,
                )
        except IntegrityError as exc:
            # Defence in depth: the size check above and the DB must never disagree, but if they
            # do the client still gets 409 fork-too-large rather than a 500.
            if _MANIFEST_CHECK in str(exc.orig):
                raise ForkTooLargeError from None
            raise
        job = self.job(job_id)
        assert job is not None  # noqa: S101 - inserted above
        return _record(row), job

    def _insert_fork(
        self,
        *,
        fork_id: uuid.UUID,
        source_workspace_id: uuid.UUID,
        source_workspace_name: str,
        share_link_id: uuid.UUID,
        user_id: uuid.UUID,
        name: str,
        job_id: uuid.UUID,
        manifest: dict[str, Any],
    ) -> Any:
        return self._session.execute(
            insert(workspace_forks)
            .values(
                id=fork_id,
                source_workspace_id=source_workspace_id,
                source_share_link_id=share_link_id,
                forked_by=user_id,
                name=name,
                async_job_id=job_id,
                source_snapshot_manifest=manifest,
                origin_attribution={
                    "source_workspace_id": str(source_workspace_id),
                    "source_workspace_name": source_workspace_name,
                    "source_share_link_id": str(share_link_id),
                },
            )
            .returning(*_COLUMNS)
        ).one()

    def get_for_user(self, fork_id: uuid.UUID, user_id: uuid.UUID) -> ForkRecord | None:
        """The caller's own fork; someone else's is indistinguishable from a missing one."""
        row = self._session.execute(
            select(*_COLUMNS).where(
                workspace_forks.c.id == fork_id, workspace_forks.c.forked_by == user_id
            )
        ).one_or_none()
        return _record(row) if row is not None else None

    def job(self, job_id: uuid.UUID) -> ForkJob | None:
        row = self._session.execute(
            select(
                async_jobs.c.id,
                async_jobs.c.workspace_id,
                async_jobs.c.created_by,
                async_jobs.c.job_type,
                async_jobs.c.schema_version,
                async_jobs.c.idempotency_key,
                async_jobs.c.payload,
                async_jobs.c.status,
                async_jobs.c.published_at,
            ).where(async_jobs.c.id == job_id)
        ).one_or_none()
        if row is None:
            return None
        return ForkJob(
            id=row.id,
            workspace_id=row.workspace_id,
            created_by=row.created_by,
            job_type=row.job_type,
            schema_version=row.schema_version,
            idempotency_key=row.idempotency_key,
            payload=dict(row.payload),
            status=row.status,
            published_at=row.published_at,
        )

    def mark_published(self, job_id: uuid.UUID) -> None:
        self._session.execute(
            update(async_jobs)
            .where(
                async_jobs.c.id == job_id,
                async_jobs.c.status == "queued",
                async_jobs.c.published_at.is_(None),
            )
            .values(published_at=func.now())
        )


def _record(row: Any) -> ForkRecord:
    status = cast(ForkStatus, row.status)
    return ForkRecord(
        id=row.id,
        forked_by=row.forked_by,
        name=row.name,
        status=status,
        progress=int(row.progress),
        # Defensive: only a COMPLETED fork has a workspace to show (DB check enforces it too).
        target_workspace_id=row.target_workspace_id if status == "COMPLETED" else None,
        async_job_id=row.async_job_id,
        last_error=row.last_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
        completed_at=row.completed_at,
    )
