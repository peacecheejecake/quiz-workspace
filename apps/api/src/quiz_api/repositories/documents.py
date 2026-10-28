"""Document, upload-intent and parse-job writes/reads (M3.2a).

Every method runs in the request session after the route authorized the caller (A1.3); nothing
here commits on its own. Upload completion is serialised per intent by locking the
`document_uploads` row (`lock_upload`), so a retried or concurrent complete-upload sees the first
one's result instead of creating a second document.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, cast

from sqlalchemy import and_, func, insert, select, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.repositories.jobs import progress_of
from quiz_api.repositories.question_imports import QuestionImportRepository
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    chapters,
    document_revisions,
    document_uploads,
    documents,
    question_drafts,
    question_import_registration_items,
    question_import_runs,
    question_sources,
    questions,
)

DocumentType = Literal["book", "question_paper"]
# What an upload intent may ask for: `auto` = the server classifies (UX6-UPLOAD-B).
UploadDocumentType = Literal["book", "question_paper", "auto"]
# book | question_paper | mixed (a book that also prints questions; document_type book).
ContentKind = Literal["book", "question_paper", "mixed"]
TypeSource = Literal["user", "auto"]
DocumentStatus = Literal["uploading", "processing", "ready", "failed"]
RevisionStatus = Literal["draft", "published"]

PARSE_JOB_TYPE = "document.parse"
PARSE_JOB_SCHEMA_VERSION = 1
ACTIVE_JOB_STATUSES = ("queued", "running")


@dataclass(frozen=True)
class UploadRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID
    document_type: DocumentType
    auto_classify: bool
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
class ProcessingJobRecord:
    """A document's queued or running `document.parse` job, reduced to presentable fields."""

    id: uuid.UUID
    status: Literal["queued", "running"]
    stage: str | None
    progress: int | None
    created_at: datetime
    started_at: datetime | None


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
    type_source: TypeSource = "user"
    content_kind: ContentKind | None = None

    @property
    def kind(self) -> ContentKind | None:
        """The kind shown to people: the classified or chosen one; for a document from before
        UX6-UPLOAD-B its document_type; None while an auto document is not classified yet."""
        if self.content_kind is not None:
            return self.content_kind
        return None if self.type_source == "auto" else self.document_type


def document_type_of(kind: ContentKind) -> DocumentType:
    """`document_type` is "is this body text?": a mixed document is a book."""
    return "question_paper" if kind == "question_paper" else "book"


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
    document_uploads.c.auto_classify,
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
    documents.c.type_source,
    documents.c.content_kind,
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
        auto_classify=bool(row.auto_classify),
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
        type_source=cast(TypeSource, row.type_source),
        content_kind=cast(ContentKind | None, row.content_kind),
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
        document_type: UploadDocumentType,
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
                # An auto-classified document starts as a book (body text) until the parse job
                # classifies it.
                document_type="book" if document_type == "auto" else document_type,
                auto_classify=document_type == "auto",
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
                type_source="auto" if upload.auto_classify else "user",
                content_kind=None if upload.auto_classify else upload.document_type,
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
                    "document_type": "auto" if upload.auto_classify else upload.document_type,
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

    def latest_imports(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, uuid.UUID]:
        """document id -> its newest question import run (QIMPORT-01-AC06; any kind of document
        since UX6-UPLOAD-B), read inside the authorized workspace only. One query for the whole
        list, never a truncated window."""
        if not document_ids:
            return {}
        rows = self._session.execute(
            select(question_import_runs.c.source_document_id, question_import_runs.c.id)
            .where(
                question_import_runs.c.workspace_id == workspace_id,
                question_import_runs.c.source_document_id.in_(list(document_ids)),
            )
            .order_by(
                question_import_runs.c.source_document_id,
                question_import_runs.c.created_at.desc(),
                question_import_runs.c.id.desc(),
            )
            .ext(distinct_on(question_import_runs.c.source_document_id))
        )
        return {row.source_document_id: row.id for row in rows}

    def question_counts(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, int]:
        """document id -> live questions imported from it (a source row of one of its import
        runs), inside the authorized workspace only."""
        if not document_ids:
            return {}
        rows = self._session.execute(
            select(
                question_sources.c.document_id,
                func.count(func.distinct(question_sources.c.question_id)).label("n"),
            )
            .join(
                questions,
                and_(
                    questions.c.id == question_sources.c.question_id,
                    questions.c.workspace_id == question_sources.c.workspace_id,
                ),
            )
            .where(
                question_sources.c.workspace_id == workspace_id,
                question_sources.c.document_id.in_(list(document_ids)),
                question_sources.c.import_run_id.is_not(None),
                questions.c.deleted_at.is_(None),
            )
            .group_by(question_sources.c.document_id)
        )
        return {row.document_id: int(row.n) for row in rows}

    def processing_jobs(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, ProcessingJobRecord]:
        """document id -> its newest queued or running `document.parse` job (UX3-JOB), read
        inside the authorized workspace only."""
        if not document_ids:
            return {}
        document_key = async_jobs.c.payload["document_id"].astext
        rows = self._session.execute(
            select(
                document_key.label("document_id"),
                async_jobs.c.id,
                async_jobs.c.status,
                async_jobs.c.result,
                async_jobs.c.created_at,
                async_jobs.c.started_at,
            )
            .where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.job_type == PARSE_JOB_TYPE,
                async_jobs.c.status.in_(ACTIVE_JOB_STATUSES),
                document_key.in_([str(d) for d in document_ids]),
            )
            .order_by(document_key, async_jobs.c.created_at.desc(), async_jobs.c.id.desc())
            .ext(distinct_on(document_key))
        )
        found: dict[uuid.UUID, ProcessingJobRecord] = {}
        for row in rows:
            progress, stage = progress_of(row.status, row.result)
            found[uuid.UUID(row.document_id)] = ProcessingJobRecord(
                id=row.id,
                status=cast(Literal["queued", "running"], row.status),
                stage=stage,
                progress=progress,
                created_at=row.created_at,
                started_at=row.started_at,
            )
        return found

    def get_document(self, document_id: uuid.UUID) -> DocumentRecord:
        """A document the route already authorized (so it exists and is not deleted)."""
        row = self._session.execute(
            select(*_DOCUMENT_COLUMNS).where(documents.c.id == document_id)
        ).one()
        return _document(row)

    def lock_document(self, document_id: uuid.UUID) -> DocumentRecord:
        """A document the route already authorized, row locked FOR UPDATE: serialises a kind
        change with the parse job's publish (which classifies and auto-starts an import under the
        same lock) and with question import starts (QIMP-AUTO)."""
        row = self._session.execute(
            select(*_DOCUMENT_COLUMNS).where(documents.c.id == document_id).with_for_update()
        ).one()
        return _document(row)

    def in_use_as_book(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> bool:
        """Whether people rely on the document being body text: a live question or an unpublished
        import draft is registered under one of its chapters (any revision), a submitted
        registration (QIMP-JOB) still waits to file a draft under one of them (the chapter an
        auto-matched draft was submitted with lives only in the item), or a live question cites it
        as a source other than the import it came from. Chapter suggestions of drafts that were
        not submitted are recomputed from books on every read and checked again at publish
        (409 `chapter-changed`), so they need no check here."""
        doc_chapters = select(chapters.c.id).where(
            chapters.c.workspace_id == workspace_id, chapters.c.document_id == document_id
        )
        under_chapter = (
            select(questions.c.id)
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.deleted_at.is_(None),
                questions.c.chapter_id.in_(doc_chapters),
            )
            .limit(1)
        )
        draft_under_chapter = (
            select(question_drafts.c.id)
            .where(
                question_drafts.c.workspace_id == workspace_id,
                question_drafts.c.published_question_id.is_(None),
                question_drafts.c.review_status != "rejected",
                question_drafts.c.chapter_id.in_(doc_chapters),
            )
            .limit(1)
        )
        pending_registration = (
            select(question_import_registration_items.c.draft_id)
            .where(
                question_import_registration_items.c.workspace_id == workspace_id,
                question_import_registration_items.c.state == "pending",
                question_import_registration_items.c.chapter_id.in_(doc_chapters),
            )
            .limit(1)
        )
        cited = (
            select(question_sources.c.id)
            .join(
                questions,
                and_(
                    questions.c.id == question_sources.c.question_id,
                    questions.c.workspace_id == question_sources.c.workspace_id,
                ),
            )
            .where(
                question_sources.c.workspace_id == workspace_id,
                question_sources.c.document_id == document_id,
                question_sources.c.import_run_id.is_(None),
                questions.c.deleted_at.is_(None),
            )
            .limit(1)
        )
        return any(
            self._session.execute(stmt).first() is not None
            for stmt in (under_chapter, draft_under_chapter, pending_registration, cited)
        )

    def change_kind(self, document: DocumentRecord, kind: ContentKind, actor_id: uuid.UUID) -> None:
        """Set the kind a person chose (document_type with it) and pin it: the parse job never
        reclassifies a `user` document. The classifier's `detection` stays for calibration."""
        self._session.execute(
            update(documents)
            .where(documents.c.id == document.id)
            .values(
                document_type=document_type_of(kind),
                content_kind=kind,
                type_source="user",
                updated_at=func.now(),
            )
        )
        self._session.execute(
            insert(activity_events).values(
                workspace_id=document.workspace_id,
                actor_id=actor_id,
                event_type="document.kind_changed",
                target_type="document",
                target_id=document.id,
                metadata={"from": document.kind, "to": kind},
            )
        )

    def has_import_run(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> bool:
        return (
            self._session.execute(
                select(question_import_runs.c.id)
                .where(
                    question_import_runs.c.workspace_id == workspace_id,
                    question_import_runs.c.source_document_id == document_id,
                )
                .limit(1)
            ).first()
            is not None
        )

    def start_import(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
    ) -> uuid.UUID:
        """A user-started import run of the active revision + its first (unpublished) job, as
        `POST /question-imports` creates it; returns the job id."""
        imports = QuestionImportRepository(self._session)
        run_id = imports.create_run(
            workspace_id=workspace_id,
            actor_id=actor_id,
            document_id=document_id,
            revision_id=revision_id,
        )
        job_id = self._session.execute(
            select(question_import_runs.c.async_job_id).where(question_import_runs.c.id == run_id)
        ).scalar_one()
        return uuid.UUID(str(job_id))

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
