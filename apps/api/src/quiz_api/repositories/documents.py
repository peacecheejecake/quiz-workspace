"""Document, upload-intent and parse-job writes/reads (M3.2a).

Every method runs in the request session after the route authorized the caller (A1.3); nothing
here commits on its own. Upload completion is serialised per intent by locking the
`document_uploads` row (`lock_upload`), so a retried or concurrent complete-upload sees the first
one's result instead of creating a second document.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, cast

from sqlalchemy import func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    document_revisions,
    document_uploads,
    documents,
)

DocumentType = Literal["book", "question_paper"]
DocumentStatus = Literal["uploading", "processing", "ready", "failed"]
RevisionStatus = Literal["draft", "published"]

PARSE_JOB_TYPE = "document.parse"
PARSE_JOB_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class UploadRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID
    document_type: DocumentType
    title: str
    filename: str
    expected_size_bytes: int
    expected_sha256: str
    object_key: str
    status: Literal["pending", "completed"]
    expires_at: datetime
    expired: bool
    completed_job_id: uuid.UUID | None


@dataclass(frozen=True)
class RevisionRecord:
    id: uuid.UUID
    revision_number: int
    status: RevisionStatus
    published_at: datetime | None


@dataclass(frozen=True)
class DocumentRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_type: DocumentType
    title: str
    filename: str
    size_bytes: int
    sha256: str
    source_object_key: str
    status: DocumentStatus
    active_revision_id: uuid.UUID | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class JobRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    job_type: str
    schema_version: int
    idempotency_key: str | None
    payload: dict[str, Any]
    status: str
    published_at: datetime | None


_UPLOAD_COLUMNS = (
    document_uploads.c.id,
    document_uploads.c.workspace_id,
    document_uploads.c.user_id,
    document_uploads.c.document_id,
    document_uploads.c.revision_id,
    document_uploads.c.document_type,
    document_uploads.c.title,
    document_uploads.c.filename,
    document_uploads.c.expected_size_bytes,
    document_uploads.c.expected_sha256,
    document_uploads.c.object_key,
    document_uploads.c.status,
    document_uploads.c.expires_at,
    (document_uploads.c.expires_at <= func.now()).label("expired"),
    document_uploads.c.completed_job_id,
)

_DOCUMENT_COLUMNS = (
    documents.c.id,
    documents.c.workspace_id,
    documents.c.document_type,
    documents.c.title,
    documents.c.filename,
    documents.c.size_bytes,
    documents.c.sha256,
    documents.c.source_object_key,
    documents.c.status,
    documents.c.active_revision_id,
    documents.c.last_error,
    documents.c.created_at,
    documents.c.updated_at,
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


def _upload(row: Any) -> UploadRecord:
    return UploadRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        document_id=row.document_id,
        revision_id=row.revision_id,
        document_type=cast(DocumentType, row.document_type),
        title=row.title,
        filename=row.filename,
        expected_size_bytes=row.expected_size_bytes,
        expected_sha256=row.expected_sha256,
        object_key=row.object_key,
        status=row.status,
        expires_at=row.expires_at,
        expired=bool(row.expired),
        completed_job_id=row.completed_job_id,
    )


def _document(row: Any) -> DocumentRecord:
    return DocumentRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        document_type=cast(DocumentType, row.document_type),
        title=row.title,
        filename=row.filename,
        size_bytes=row.size_bytes,
        sha256=row.sha256,
        source_object_key=row.source_object_key,
        status=cast(DocumentStatus, row.status),
        active_revision_id=row.active_revision_id,
        last_error=row.last_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _job(row: Any) -> JobRow:
    return JobRow(
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


def parse_job_key(upload_id: uuid.UUID) -> str:
    """Server-derived idempotency key of the parse job an upload creates."""
    return f"upload:{upload_id}"


class DocumentRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- upload intents -------------------------------------------------------------------------

    def create_upload(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        document_type: DocumentType,
        title: str,
        filename: str,
        size_bytes: int,
        sha256: str,
        object_key: str,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
        ttl_seconds: int,
    ) -> UploadRecord:
        upload_id = uuid.uuid4()
        self._session.execute(
            insert(document_uploads).values(
                id=upload_id,
                workspace_id=workspace_id,
                user_id=user_id,
                document_id=document_id,
                revision_id=revision_id,
                document_type=document_type,
                title=title,
                filename=filename,
                content_type="application/pdf",
                expected_size_bytes=size_bytes,
                expected_sha256=sha256,
                object_key=object_key,
                expires_at=func.now() + timedelta(seconds=ttl_seconds),
            )
        )
        upload = self.get_upload(upload_id)
        assert upload is not None  # noqa: S101 - inserted above in this transaction
        return upload

    def get_upload(self, upload_id: uuid.UUID, *, lock: bool = False) -> UploadRecord | None:
        stmt = select(*_UPLOAD_COLUMNS).where(document_uploads.c.id == upload_id)
        if lock:
            stmt = stmt.with_for_update(of=document_uploads)
        row = self._session.execute(stmt).one_or_none()
        return _upload(row) if row is not None else None

    def complete_upload(
        self, upload: UploadRecord, *, job_id: uuid.UUID, actor_id: uuid.UUID
    ) -> None:
        """Create the document, its first (draft) revision and the parse job; close the intent."""
        self._session.execute(
            insert(documents).values(
                id=upload.document_id,
                workspace_id=upload.workspace_id,
                document_type=upload.document_type,
                title=upload.title,
                filename=upload.filename,
                content_type="application/pdf",
                size_bytes=upload.expected_size_bytes,
                sha256=upload.expected_sha256,
                source_object_key=upload.object_key,
                status="processing",
                created_by=actor_id,
            )
        )
        self._session.execute(
            insert(document_revisions).values(
                id=upload.revision_id,
                workspace_id=upload.workspace_id,
                document_id=upload.document_id,
                revision_number=1,
                status="draft",
                source_object_key=upload.object_key,
                created_by=actor_id,
            )
        )
        self._session.execute(
            pg_insert(async_jobs)
            .values(
                id=job_id,
                workspace_id=upload.workspace_id,
                created_by=actor_id,
                job_type=PARSE_JOB_TYPE,
                schema_version=PARSE_JOB_SCHEMA_VERSION,
                idempotency_key=parse_job_key(upload.id),
                payload={
                    "document_id": str(upload.document_id),
                    "revision_id": str(upload.revision_id),
                },
            )
            .on_conflict_do_nothing()
        )
        # A leftover job with the same idempotency scope (none is expected: the intent row is
        # locked and still pending) is reused rather than duplicated.
        job = self.find_parse_job(upload.workspace_id, actor_id, upload.id)
        assert job is not None  # noqa: S101 - inserted or found above
        self._session.execute(
            update(document_uploads)
            .where(document_uploads.c.id == upload.id)
            .values(
                status="completed",
                completed_at=func.now(),
                completed_document_id=upload.document_id,
                completed_job_id=job.id,
            )
        )
        self._session.execute(
            insert(activity_events).values(
                workspace_id=upload.workspace_id,
                actor_id=actor_id,
                event_type="document.uploaded",
                target_type="document",
                target_id=upload.document_id,
                metadata={
                    "document_type": upload.document_type,
                    "size_bytes": upload.expected_size_bytes,
                },
            )
        )

    # --- jobs -----------------------------------------------------------------------------------

    def find_parse_job(
        self, workspace_id: uuid.UUID, created_by: uuid.UUID, upload_id: uuid.UUID
    ) -> JobRow | None:
        row = self._session.execute(
            select(*_JOB_COLUMNS).where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.created_by == created_by,
                async_jobs.c.job_type == PARSE_JOB_TYPE,
                async_jobs.c.idempotency_key == parse_job_key(upload_id),
            )
        ).one_or_none()
        return _job(row) if row is not None else None

    def get_job(self, job_id: uuid.UUID) -> JobRow | None:
        row = self._session.execute(
            select(*_JOB_COLUMNS).where(async_jobs.c.id == job_id)
        ).one_or_none()
        return _job(row) if row is not None else None

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

    # --- documents ------------------------------------------------------------------------------

    def list_documents(
        self, workspace_id: uuid.UUID, document_type: DocumentType | None = None
    ) -> list[DocumentRecord]:
        stmt = (
            select(*_DOCUMENT_COLUMNS)
            .where(documents.c.workspace_id == workspace_id, documents.c.deleted_at.is_(None))
            .order_by(documents.c.created_at.desc(), documents.c.id.desc())
        )
        if document_type is not None:
            stmt = stmt.where(documents.c.document_type == document_type)
        return [_document(row) for row in self._session.execute(stmt)]

    def get_document(self, document_id: uuid.UUID) -> DocumentRecord:
        """A document the route already authorized (so it exists and is not deleted)."""
        row = self._session.execute(
            select(*_DOCUMENT_COLUMNS).where(documents.c.id == document_id)
        ).one()
        return _document(row)

    def get_revision(self, revision_id: uuid.UUID) -> RevisionRecord | None:
        row = self._session.execute(
            select(
                document_revisions.c.id,
                document_revisions.c.revision_number,
                document_revisions.c.status,
                document_revisions.c.published_at,
            ).where(document_revisions.c.id == revision_id)
        ).one_or_none()
        if row is None:
            return None
        return RevisionRecord(
            id=row.id,
            revision_number=row.revision_number,
            status=cast(RevisionStatus, row.status),
            published_at=row.published_at,
        )

    def latest_revision(self, document_id: uuid.UUID) -> RevisionRecord | None:
        row = self._session.execute(
            select(
                document_revisions.c.id,
                document_revisions.c.revision_number,
                document_revisions.c.status,
                document_revisions.c.published_at,
            )
            .where(document_revisions.c.document_id == document_id)
            .order_by(document_revisions.c.revision_number.desc())
            .limit(1)
        ).one_or_none()
        if row is None:
            return None
        return RevisionRecord(
            id=row.id,
            revision_number=row.revision_number,
            status=cast(RevisionStatus, row.status),
            published_at=row.published_at,
        )

    def soft_delete(self, document: DocumentRecord, actor_id: uuid.UUID) -> None:
        self._session.execute(
            update(documents)
            .where(documents.c.id == document.id, documents.c.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )
        self._session.execute(
            insert(activity_events).values(
                workspace_id=document.workspace_id,
                actor_id=actor_id,
                event_type="document.deleted",
                target_type="document",
                target_id=document.id,
                metadata={},
            )
        )
