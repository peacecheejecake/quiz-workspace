"""Fork requests (S3a; docs/workspace-sharing.md §4-§6) over `public.workspace_forks`.

The API side of a fork only *records* the request, in one transaction with its job:

1. `snapshot()` pins the published snapshot of the link's workspace: the active published
   revision of every live document and the active revision of every CONFIRMED live question
   (exactly what the shared view shows; drafts, archived/deleted questions and import drafts are
   never pinned);
2. `create()` inserts the `workspace.fork` job (in the *source* workspace, `created_by` = the
   forking user, payload `{fork_id}`) and the PENDING fork row with the manifest, a random id
   salt and the id the new workspace will get.

Everything else (copying, the commit-time re-check, cleanup) is the worker's
(apps/worker quiz_worker.fork_job, `public.worker_fork_commit`). The workspace itself does not
exist before the worker commits, so `target_workspace_id` stays null until COMPLETED.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import func, insert, select, update
from sqlalchemy.orm import Session

from quiz_api.repositories.search import SearchRepository
from quiz_api.repositories.tables import async_jobs, questions, workspace_forks

FORK_JOB_TYPE = "workspace.fork"
FORK_JOB_SCHEMA_VERSION = 1
MANIFEST_VERSION = 1

ForkStatus = Literal["PENDING", "COPYING", "COMPLETED", "FAILED", "CANCELLED"]


@dataclass(frozen=True)
class Snapshot:
    documents: list[tuple[uuid.UUID, uuid.UUID]]  # (document id, published revision id)
    questions: list[tuple[uuid.UUID, uuid.UUID]]  # (question id, active revision id)


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
        rows = self._session.execute(
            select(questions.c.id, questions.c.active_revision_id)
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.publication_status == "CONFIRMED",
                questions.c.deleted_at.is_(None),
                questions.c.active_revision_id.is_not(None),
            )
            .order_by(questions.c.created_at, questions.c.id)
        ).all()
        return Snapshot(
            documents=[(d.id, d.revision_id) for d in docs],
            questions=[(r.id, r.active_revision_id) for r in rows],
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
        manifest = {
            "version": MANIFEST_VERSION,
            "id_salt": str(uuid.uuid4()),
            "target_workspace_id": str(uuid.uuid4()),
            "documents": [
                {"document_id": str(d), "revision_id": str(r)} for d, r in snapshot.documents
            ],
            "questions": [
                {"question_id": str(q), "revision_id": str(r)} for q, r in snapshot.questions
            ],
        }
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
        row = self._session.execute(
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
        job = self.job(job_id)
        assert job is not None  # noqa: S101 - inserted above
        return _record(row), job

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
