"""Question PDF import runs and their drafts (M4.4a) over `question_import_runs` /
`question_drafts` (20261017180000_question_domain.sql, 20261018100000_question_import_worker.sql).

The API creates runs and their `question.import` jobs, reviews and publishes drafts; the worker
(`quiz_worker.question_import_job`) moves the run state and inserts drafts. Routes commit once.

Job idempotency: every job of a run has the key `question_import:<run id>:<n>` (n = 1 for the
start, +1 per retry) in the `(workspace_id, created_by, job_type, idempotency_key)` scope, so a
repeated insert inside one request finds the row instead of duplicating it.

Run status as presented: the worker writes `status`; a run whose job already ended `failed` /
`cancelled` while the run row still says `queued`/`running` (the worker died before it could
record the end, and the cleanup obligation has not run yet) is presented with the job's status.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import and_, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.repositories.jobs import error_code
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    documents,
    question_drafts,
    question_import_runs,
    question_sources,
)

IMPORT_JOB_TYPE = "question.import"
IMPORT_JOB_SCHEMA_VERSION = 1

RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
ReviewStatus = Literal["pending", "approved", "rejected"]
TERMINAL: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})


def import_job_key(run_id: uuid.UUID, attempt: int) -> str:
    return f"question_import:{run_id}:{attempt}"


@dataclass(frozen=True)
class RunRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: RunStatus
    job_id: uuid.UUID | None
    error_code: str | None
    source_document_id: uuid.UUID | None
    source_document_revision_id: uuid.UUID | None
    document_title: str | None
    draft_count: int
    published_count: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


@dataclass(frozen=True)
class DraftRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    import_run_id: uuid.UUID | None
    source_type: str
    position: int
    question_type: str
    question_number: int | None
    is_multi_answer: bool
    rubric: str | None
    payload: dict[str, Any]
    validations: list[dict[str, Any]]
    review_status: ReviewStatus
    reviewed_at: datetime | None
    published_question_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class PaperRecord:
    """A live document of the workspace, as a question import needs it."""

    id: uuid.UUID
    document_type: str
    status: str
    active_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class JobRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    job_type: str
    schema_version: int
    idempotency_key: str | None
    payload: dict[str, Any]
    status: str
    published_at: datetime | None


def present_status(run_status: str, job_status: str | None) -> RunStatus:
    if run_status in {"queued", "running"} and job_status in {"failed", "cancelled"}:
        return cast(RunStatus, job_status)
    return cast(RunStatus, run_status)


_draft_counts = (
    select(
        question_drafts.c.import_run_id.label("run_id"),
        func.count().label("drafts"),
        func.count(question_drafts.c.published_question_id).label("published"),
    )
    .where(question_drafts.c.import_run_id.is_not(None))
    .group_by(question_drafts.c.import_run_id)
    .subquery()
)


def _run_select() -> Any:
    return select(
        question_import_runs.c.id,
        question_import_runs.c.workspace_id,
        question_import_runs.c.status,
        question_import_runs.c.async_job_id,
        question_import_runs.c.source_document_id,
        question_import_runs.c.source_document_revision_id,
        question_import_runs.c.created_by,
        question_import_runs.c.created_at,
        question_import_runs.c.updated_at,
        question_import_runs.c.finished_at,
        async_jobs.c.status.label("job_status"),
        async_jobs.c.last_error.label("job_error"),
        documents.c.title.label("document_title"),
        func.coalesce(_draft_counts.c.drafts, 0).label("drafts"),
        func.coalesce(_draft_counts.c.published, 0).label("published"),
    ).select_from(
        question_import_runs.outerjoin(
            async_jobs,
            and_(
                async_jobs.c.id == question_import_runs.c.async_job_id,
                async_jobs.c.workspace_id == question_import_runs.c.workspace_id,
            ),
        )
        .outerjoin(
            documents,
            and_(
                documents.c.id == question_import_runs.c.source_document_id,
                documents.c.workspace_id == question_import_runs.c.workspace_id,
                documents.c.deleted_at.is_(None),
            ),
        )
        .outerjoin(_draft_counts, _draft_counts.c.run_id == question_import_runs.c.id)
    )


def _run(row: Any) -> RunRecord:
    status = present_status(row.status, row.job_status)
    return RunRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        status=status,
        job_id=row.async_job_id,
        error_code=error_code(status, row.job_error),
        source_document_id=row.source_document_id,
        source_document_revision_id=row.source_document_revision_id,
        document_title=row.document_title,
        draft_count=int(row.drafts),
        published_count=int(row.published),
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        finished_at=row.finished_at,
    )


_DRAFT_COLUMNS = (
    question_drafts.c.id,
    question_drafts.c.workspace_id,
    question_drafts.c.import_run_id,
    question_drafts.c.source_type,
    question_drafts.c.position,
    question_drafts.c.question_type,
    question_drafts.c.question_number,
    question_drafts.c.is_multi_answer,
    question_drafts.c.rubric,
    question_drafts.c.payload,
    question_drafts.c.validations,
    question_drafts.c.review_status,
    question_drafts.c.reviewed_at,
    question_drafts.c.published_question_id,
    question_drafts.c.created_at,
    question_drafts.c.updated_at,
)


def _draft(row: Any) -> DraftRecord:
    return DraftRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        import_run_id=row.import_run_id,
        source_type=row.source_type,
        position=row.position,
        question_type=row.question_type,
        question_number=row.question_number,
        is_multi_answer=row.is_multi_answer,
        rubric=row.rubric,
        payload=dict(row.payload),
        validations=list(row.validations),
        review_status=cast(ReviewStatus, row.review_status),
        reviewed_at=row.reviewed_at,
        published_question_id=row.published_question_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


_JOB_COLUMNS = (
    async_jobs.c.id,
    async_jobs.c.workspace_id,
    async_jobs.c.created_by,
    async_jobs.c.job_type,
    async_jobs.c.schema_version,
    async_jobs.c.idempotency_key,
    async_jobs.c.payload,
    async_jobs.c.status,
    async_jobs.c.published_at,
)


class QuestionImportRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- documents ------------------------------------------------------------------------------

    def paper(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> PaperRecord | None:
        """A live document of this workspace (FOR SHARE: it cannot be deleted or re-pointed while
        the run that pins its active revision is created)."""
        row = self._session.execute(
            select(
                documents.c.id,
                documents.c.document_type,
                documents.c.status,
                documents.c.active_revision_id,
            )
            .where(
                documents.c.workspace_id == workspace_id,
                documents.c.id == document_id,
                documents.c.deleted_at.is_(None),
            )
            .with_for_update(read=True)
        ).one_or_none()
        if row is None:
            return None
        return PaperRecord(row.id, row.document_type, row.status, row.active_revision_id)

    # --- runs -----------------------------------------------------------------------------------

    def get_run(self, run_id: uuid.UUID, *, lock: bool = False) -> RunRecord | None:
        if lock:
            self._session.execute(
                select(question_import_runs.c.id)
                .where(question_import_runs.c.id == run_id)
                .with_for_update()
            )
        row = self._session.execute(
            _run_select().where(question_import_runs.c.id == run_id)
        ).one_or_none()
        return _run(row) if row is not None else None

    def list_runs(self, workspace_id: uuid.UUID, *, limit: int) -> list[RunRecord]:
        rows = self._session.execute(
            _run_select()
            .where(question_import_runs.c.workspace_id == workspace_id)
            .order_by(question_import_runs.c.created_at.desc(), question_import_runs.c.id.desc())
            .limit(limit)
        )
        return [_run(r) for r in rows]

    def _insert_job(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID, run_id: uuid.UUID, attempt: int
    ) -> uuid.UUID:
        key = import_job_key(run_id, attempt)
        self._session.execute(
            pg_insert(async_jobs)
            .values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                created_by=actor_id,
                job_type=IMPORT_JOB_TYPE,
                schema_version=IMPORT_JOB_SCHEMA_VERSION,
                idempotency_key=key,
                payload={"import_id": str(run_id)},
            )
            .on_conflict_do_nothing()
        )
        job_id: uuid.UUID = self._session.execute(
            select(async_jobs.c.id).where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.created_by == actor_id,
                async_jobs.c.job_type == IMPORT_JOB_TYPE,
                async_jobs.c.idempotency_key == key,
            )
        ).scalar_one()
        return job_id

    def create_run(
        self,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
    ) -> uuid.UUID:
        """The run (pinned to the document's active revision) + its first job + activity."""
        run_id = uuid.uuid4()
        job_id = self._insert_job(workspace_id, actor_id, run_id, 1)
        self._session.execute(
            insert(question_import_runs).values(
                id=run_id,
                workspace_id=workspace_id,
                created_by=actor_id,
                source_document_id=document_id,
                source_document_revision_id=revision_id,
                async_job_id=job_id,
                status="queued",
            )
        )
        self._activity(workspace_id, actor_id, "question_import.started", run_id, {})
        return run_id

    def retry_run(self, run: RunRecord, actor_id: uuid.UUID) -> None:
        """A new job on the same run (the caller locked the run row)."""
        attempts = self._session.execute(
            select(func.count()).where(
                async_jobs.c.workspace_id == run.workspace_id,
                async_jobs.c.job_type == IMPORT_JOB_TYPE,
                async_jobs.c.payload["import_id"].astext == str(run.id),
            )
        ).scalar_one()
        job_id = self._insert_job(run.workspace_id, actor_id, run.id, int(attempts) + 1)
        self._session.execute(
            update(question_import_runs)
            .where(question_import_runs.c.id == run.id)
            .values(status="queued", finished_at=None, async_job_id=job_id)
        )
        self._activity(
            run.workspace_id,
            actor_id,
            "question_import.retried",
            run.id,
            {"attempt": int(attempts) + 1},
        )

    def get_job(self, job_id: uuid.UUID) -> JobRecord | None:
        row = self._session.execute(
            select(*_JOB_COLUMNS).where(async_jobs.c.id == job_id)
        ).one_or_none()
        if row is None:
            return None
        return JobRecord(
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

    # --- drafts ---------------------------------------------------------------------------------

    def list_drafts(self, run_id: uuid.UUID) -> list[DraftRecord]:
        rows = self._session.execute(
            select(*_DRAFT_COLUMNS)
            .where(question_drafts.c.import_run_id == run_id)
            .order_by(question_drafts.c.position, question_drafts.c.id)
        )
        return [_draft(r) for r in rows]

    def get_draft(self, draft_id: uuid.UUID, *, lock: bool = False) -> DraftRecord | None:
        stmt = select(*_DRAFT_COLUMNS).where(question_drafts.c.id == draft_id)
        if lock:
            stmt = stmt.with_for_update()
        row = self._session.execute(stmt).one_or_none()
        return _draft(row) if row is not None else None

    def lock_drafts(self, run_id: uuid.UUID, draft_ids: Iterable[uuid.UUID]) -> list[DraftRecord]:
        """The run's drafts among `draft_ids`, FOR UPDATE in position order (one lock order for
        every publisher, so concurrent publishes of overlapping sets cannot deadlock)."""
        ids = list(set(draft_ids))
        if not ids:
            return []
        rows = self._session.execute(
            select(*_DRAFT_COLUMNS)
            .where(question_drafts.c.import_run_id == run_id, question_drafts.c.id.in_(ids))
            .order_by(question_drafts.c.position, question_drafts.c.id)
            .with_for_update()
        )
        return [_draft(r) for r in rows]

    def update_draft(self, draft_id: uuid.UUID, **values: Any) -> None:
        self._session.execute(
            update(question_drafts).where(question_drafts.c.id == draft_id).values(**values)
        )

    def mark_draft_reviewed(
        self,
        draft_id: uuid.UUID,
        *,
        actor_id: uuid.UUID,
        review_status: ReviewStatus,
        payload: dict[str, Any],
        published_question_id: uuid.UUID | None = None,
    ) -> None:
        values: dict[str, Any] = {
            "review_status": review_status,
            "payload": payload,
            "reviewed_by": actor_id if review_status != "pending" else None,
            "reviewed_at": func.now() if review_status != "pending" else None,
        }
        if published_question_id is not None:
            values["published_question_id"] = published_question_id
        self.update_draft(draft_id, **values)

    # --- publishing -----------------------------------------------------------------------------

    def insert_import_source(
        self,
        *,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        run_id: uuid.UUID,
        document_id: uuid.UUID | None,
        revision_id: uuid.UUID | None,
        page_start: int | None,
        page_end: int | None,
        block_ids: Sequence[str],
        locations: list[dict[str, Any]],
    ) -> None:
        self._session.execute(
            insert(question_sources).values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                question_id=question_id,
                document_id=document_id,
                document_revision_id=revision_id if document_id is not None else None,
                page_start=page_start,
                page_end=page_end,
                block_ids=list(block_ids),
                locations=locations,
                import_run_id=run_id,
            )
        )

    def _activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: str,
        run_id: uuid.UUID,
        metadata: dict[str, Any],
    ) -> None:
        """Ids and counts only: never question text or answers."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="question_import",
                target_id=run_id,
                metadata=metadata,
            )
        )

    def record_published(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID, run_id: uuid.UUID, count: int
    ) -> None:
        self._activity(
            workspace_id, actor_id, "question_import.published", run_id, {"count": count}
        )
