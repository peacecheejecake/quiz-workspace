"""Document upload and library API (M3.2a, DOC-01; docs/deployment.md §2, docs/auth.md §4).

    POST   /workspaces/{id}/documents/upload-intent  editor+; validate name/size/type, reserve ids,
                                                     return a short-lived signed upload URL
    POST   /documents/complete-upload                the uploader; re-verify the stored object,
                                                     create document + draft revision + parse job;
                                                     202, idempotent per upload
    GET    /workspaces/{id}/documents                any member; live documents, newest first
    GET    /documents/{id}                           any member; status + active revision
    GET    /documents/{id}/source-url                any member; short-lived signed PDF read URL
    DELETE /documents/{id}                           editor+; soft delete, 204, then 404 everywhere

Upload flow: the browser PUTs the bytes (or uploads them with TUS) straight into the private
`source-pdfs` bucket with the signed URL; Storage itself enforces the bucket's 50 MiB / PDF-only
limits. complete-upload never trusts the client or a Storage event: it streams the stored object
server-side and checks that it exists, has the declared size, starts with the PDF signature and
has the declared SHA-256 (Storage metadata only offers an MD5 ETag, so reading the object is the
only way to verify the SHA-256 the document is recorded with; at most 50 MiB over the internal
network). Only then does it create the rows and enqueue `document.parse` (M3.2b).

Signed URLs and upload tokens appear only in the response to the caller who asked (responses
under /api/v1 are `Cache-Control: no-store`); they are never logged, stored or put in an
idempotency record.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    LockMode,
    ResourceAccess,
    ResourceType,
    WorkspaceAccess,
    authorize_resource,
    get_access_repository,
    require_resource_access,
    require_workspace_access,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.jobs import JobMessage, JobPublisher, build_job_publisher
from quiz_api.repositories.documents import (
    DocumentRecord,
    DocumentRepository,
    DocumentStatus,
    DocumentType,
    JobRow,
    RevisionStatus,
    UploadRecord,
)
from quiz_api.settings import Settings
from quiz_api.storage import (
    PDF_MAGIC,
    SOURCE_BUCKET,
    Storage,
    StorageUnavailableError,
    build_storage,
    object_key,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"], responses=problem_responses(503))

PDF_CONTENT_TYPE = "application/pdf"
# Storage `file_size_limit` of the `source-pdfs` bucket (and the global limit in config.toml).
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UPLOAD_NOT_FOUND = "Upload not found."
_NOT_PDF = "Only PDF files (.pdf, application/pdf) can be uploaded."

# A display name: no control characters, no path separators.
Filename = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f/\\]+$"
    ),
]
Title = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]+$"
    ),
]
Sha256 = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, pattern=r"^[0-9a-fA-F]{64}$"),
]


# --- schemas ------------------------------------------------------------------------------------


class UploadIntentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: Filename = Field(description="Original file name; must end in `.pdf`.")
    size_bytes: int = Field(ge=1, description=f"Exact size in bytes (at most {MAX_UPLOAD_BYTES}).")
    content_type: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] = Field(
        description="Must be `application/pdf`."
    )
    sha256: Sha256 = Field(description="Hex SHA-256 of the file; re-verified on completion.")
    title: Title | None = Field(default=None, description="Defaults to the file name stem.")
    document_type: DocumentType = Field(
        default="book", description="`question_paper` for question PDFs to import."
    )


class ResumableUpload(BaseModel):
    """TUS (resumable) alternative to the single PUT, for large files and flaky networks."""

    endpoint: str = Field(description="TUS creation endpoint.")
    headers: dict[str, str] = Field(description="Send on every TUS request (carries the token).")
    metadata: dict[str, str] = Field(description="TUS `Upload-Metadata` entries.")


class UploadIntent(BaseModel):
    upload_id: uuid.UUID
    upload_url: str = Field(description="Short-lived signed URL: `PUT` the raw PDF bytes here.")
    upload_method: Literal["PUT"] = "PUT"
    upload_headers: dict[str, str] = Field(description="Headers to send with the PUT.")
    resumable: ResumableUpload
    expires_at: datetime = Field(description="Complete the upload before this time.")
    max_size_bytes: int = MAX_UPLOAD_BYTES


class CompleteUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upload_id: uuid.UUID
    sha256: Sha256 = Field(description="Hex SHA-256 of the uploaded bytes.")


class UploadCompleted(BaseModel):
    document_id: uuid.UUID
    job_id: uuid.UUID = Field(description="The parse job; poll `GET /jobs/{id}`.")


class DocumentSummary(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_type: DocumentType
    title: str
    filename: str
    size_bytes: int
    sha256: str
    status: DocumentStatus = Field(description="uploading | processing | ready | failed")
    active_revision_id: uuid.UUID | None = Field(
        description="The published revision search and the viewer use (null until ready)."
    )
    last_error: str | None = Field(description="Why the last processing attempt failed.")
    created_at: datetime
    updated_at: datetime


class DocumentList(BaseModel):
    items: list[DocumentSummary]


class RevisionSummary(BaseModel):
    id: uuid.UUID
    revision_number: int
    status: RevisionStatus
    published_at: datetime | None


class DocumentDetail(DocumentSummary):
    active_revision: RevisionSummary | None
    latest_revision: RevisionSummary | None = Field(
        description="The newest revision (a draft while a parse or correction is pending)."
    )


class SignedReadUrl(BaseModel):
    url: str = Field(description="Short-lived signed URL of the original PDF. Do not store it.")
    expires_at: datetime


# --- dependencies -------------------------------------------------------------------------------


def get_document_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> DocumentRepository:
    return DocumentRepository(session)


def get_storage(request: Request) -> Storage:
    """The app's Storage client (built on first use); 503 when Storage is not configured."""
    state = request.app.state
    storage: Storage | None = getattr(state, "storage", None)
    if storage is None:
        settings: Settings = state.settings
        storage = build_storage(settings)
        if storage is None:
            raise HTTPException(status_code=503, detail="File storage is not configured.")
        state.storage = storage
    return storage


def get_job_publisher(request: Request) -> JobPublisher | None:
    """`None` without a broker (jobs then wait for the worker's reconciler)."""
    state = request.app.state
    if not hasattr(state, "job_publisher"):
        state.job_publisher = build_job_publisher(state.settings)
    publisher: JobPublisher | None = state.job_publisher
    return publisher


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


DocumentRepo = Annotated[DocumentRepository, Depends(get_document_repository)]
StorageDep = Annotated[Storage, Depends(get_storage)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


def _workspace(action: Action) -> Any:
    return Depends(require_workspace_access(action))


def _document(action: Action) -> Any:
    return Depends(require_resource_access(ResourceType.DOCUMENT, action, param="document_id"))


# --- helpers ------------------------------------------------------------------------------------


def _summary(doc: DocumentRecord) -> DocumentSummary:
    return DocumentSummary(
        id=doc.id,
        workspace_id=doc.workspace_id,
        document_type=doc.document_type,
        title=doc.title,
        filename=doc.filename,
        size_bytes=doc.size_bytes,
        sha256=doc.sha256,
        status=doc.status,
        active_revision_id=doc.active_revision_id,
        last_error=doc.last_error,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def _default_title(filename: str) -> str:
    stem = PurePosixPath(filename).stem.strip()
    return re.sub(r"\s+", " ", stem)[:300] or filename[:300]


def _storage_unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="File storage is temporarily unavailable.")


def _completed(upload: UploadRecord, job_id: uuid.UUID) -> UploadCompleted:
    return UploadCompleted(document_id=upload.document_id, job_id=job_id)


def publish_job(repo: DocumentRepository, publisher: JobPublisher | None, job: JobRow) -> None:
    """Send a queued, unpublished job to the broker and record it; failures are left to the
    worker's reconciler (the row stays queued with `published_at` null)."""
    if publisher is None or job.status != "queued" or job.published_at is not None:
        return
    message = JobMessage(
        job_id=job.id,
        job_type=job.job_type,
        schema_version=job.schema_version,
        workspace_id=job.workspace_id,
        created_by=job.created_by,
        idempotency_key=job.idempotency_key,
        payload=job.payload,
    )
    try:
        publisher.publish(message)
    except Exception as exc:
        logger.warning("job publish failed (reconciler will retry): %s", type(exc).__name__)
        return
    repo.mark_published(job.id)
    repo.commit()


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/documents/upload-intent",
    status_code=status.HTTP_201_CREATED,
    operation_id="createDocumentUploadIntent",
    responses=problem_responses(413, 415),
)
def create_upload_intent(
    access: Annotated[WorkspaceAccess, _workspace(Action.DOCUMENT_EDIT)],
    body: UploadIntentCreate,
    repo: DocumentRepo,
    storage: StorageDep,
    settings: SettingsDep,
) -> UploadIntent:
    """Reserve a document and return where to upload its PDF (DOC-01-AC03).

    Rejects non-PDF names/types (415) and files over 50 MiB (413) before any URL is issued.
    Each call is a new intent; an intent that is never completed creates no document.
    """
    if body.content_type.lower() != PDF_CONTENT_TYPE or not body.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail=_NOT_PDF)
    if body.size_bytes > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail="PDF files can be at most 50 MiB (52428800 bytes)."
        )

    document_id, revision_id = uuid.uuid4(), uuid.uuid4()
    key = object_key(access.workspace_id, document_id, revision_id)
    upload = repo.create_upload(
        workspace_id=access.workspace_id,
        user_id=access.user_id,
        document_type=body.document_type,
        title=body.title or _default_title(body.filename),
        filename=body.filename,
        size_bytes=body.size_bytes,
        sha256=body.sha256,
        object_key=key,
        document_id=document_id,
        revision_id=revision_id,
        ttl_seconds=settings.upload_intent_ttl_seconds,
    )
    try:
        signed = storage.create_signed_upload(SOURCE_BUCKET, key)
    except StorageUnavailableError:
        repo.rollback()
        raise _storage_unavailable() from None
    repo.commit()
    return UploadIntent(
        upload_id=upload.id,
        upload_url=signed.url,
        upload_headers={"content-type": PDF_CONTENT_TYPE},
        resumable=ResumableUpload(
            endpoint=signed.resumable_endpoint,
            headers={"x-signature": signed.token},
            metadata={
                "bucketName": SOURCE_BUCKET,
                "objectName": key,
                "contentType": PDF_CONTENT_TYPE,
            },
        ),
        expires_at=upload.expires_at,
    )


@router.post(
    "/documents/complete-upload",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="completeDocumentUpload",
    responses=problem_responses(409, 415),
)
def complete_upload(
    body: CompleteUpload,
    user: CurrentUser,
    access_repo: AccessRepo,
    repo: DocumentRepo,
    storage: StorageDep,
    publisher: PublisherDep,
) -> UploadCompleted:
    """Verify the uploaded object and start parsing it (202 + job id, DOC-01-AC03/AC04).

    Idempotent per upload: repeating it returns the same document and job. 409
    `upload-incomplete` = nothing stored yet (finish the upload, then retry); 409
    `upload-expired` = start over with a new intent; 422 `upload-mismatch` = the stored bytes
    differ from the declared size/SHA-256 (the object is discarded).
    """

    def authorize(lock: LockMode) -> UploadRecord:
        # Workspace from the DB (never from the client); archived/role checks as for any write.
        authorize_resource(
            access_repo,
            user.id,
            ResourceType.UPLOAD,
            body.upload_id,
            Action.DOCUMENT_EDIT,
            lock=lock,
        )
        found = repo.get_upload(body.upload_id, lock=lock is not LockMode.NONE)
        # Only the uploader can complete an intent; for anyone else it does not exist.
        if found is None or found.user_id != user.id:
            raise HTTPException(status_code=404, detail=UPLOAD_NOT_FOUND)
        return found

    upload = authorize(LockMode.NONE)
    if upload.status == "completed":
        return _replay(repo, publisher, upload)
    if body.sha256 != upload.expected_sha256:
        raise ProblemException(
            422,
            ProblemType.UPLOAD_MISMATCH,
            detail="The SHA-256 does not match the one declared for this upload.",
        )
    if upload.expired:
        raise ProblemException(
            409,
            ProblemType.UPLOAD_EXPIRED,
            detail="This upload expired. Start a new upload.",
        )
    # No transaction (or row lock) stays open while the object is read.
    repo.rollback()
    _verify_object(storage, upload)

    # Write phase: re-check access with the content-write lock and serialise on the intent.
    upload = authorize(LockMode.SHARE)
    if upload.status == "completed":  # a concurrent completion won
        repo.rollback()
        return _replay(repo, publisher, upload)
    job_id = uuid.uuid4()
    repo.complete_upload(upload, job_id=job_id, actor_id=user.id)
    job = repo.find_parse_job(upload.workspace_id, user.id, upload.id)
    assert job is not None  # noqa: S101 - created in complete_upload
    repo.commit()
    publish_job(repo, publisher, job)
    return _completed(upload, job.id)


def _replay(
    repo: DocumentRepository, publisher: JobPublisher | None, upload: UploadRecord
) -> UploadCompleted:
    job = repo.get_job(upload.completed_job_id) if upload.completed_job_id else None
    if job is None:
        # The job row was removed out of band; the document exists, the parse job does not.
        raise HTTPException(status_code=409, detail="The parse job of this upload is gone.")
    publish_job(repo, publisher, job)  # recovers a publish that failed the first time
    return _completed(upload, job.id)


def _verify_object(storage: Storage, upload: UploadRecord) -> None:
    try:
        digest = storage.digest(SOURCE_BUCKET, upload.object_key, max_bytes=MAX_UPLOAD_BYTES)
    except StorageUnavailableError:
        raise _storage_unavailable() from None
    if digest is None:
        raise ProblemException(
            409,
            ProblemType.UPLOAD_INCOMPLETE,
            detail="No uploaded file was found for this upload. Finish the upload and retry.",
        )
    problem: ProblemException | None = None
    if digest.head != PDF_MAGIC:
        problem = ProblemException(415, ProblemType.UPLOAD_MISMATCH, detail=_NOT_PDF)
    elif digest.size != upload.expected_size_bytes or digest.sha256 != upload.expected_sha256:
        problem = ProblemException(
            422,
            ProblemType.UPLOAD_MISMATCH,
            detail="The uploaded file does not match the declared size and SHA-256.",
        )
    if problem is not None:
        # Discard the bad bytes so the reserved key cannot be completed with them later.
        try:
            storage.delete(SOURCE_BUCKET, upload.object_key)
        except StorageUnavailableError:
            logger.warning("could not discard a mismatched upload object")
        raise problem


@router.get("/workspaces/{workspace_id}/documents", operation_id="listDocuments")
def list_documents(
    access: Annotated[WorkspaceAccess, _workspace(Action.READ)],
    repo: DocumentRepo,
    document_type: Annotated[
        DocumentType | None, Query(description="Only this document type.")
    ] = None,
) -> DocumentList:
    """The workspace's documents (not soft-deleted), newest first."""
    return DocumentList(
        items=[_summary(d) for d in repo.list_documents(access.workspace_id, document_type)]
    )


def _revision(repo: DocumentRepository, revision_id: uuid.UUID | None) -> RevisionSummary | None:
    record = repo.get_revision(revision_id) if revision_id else None
    return RevisionSummary(**vars(record)) if record else None


@router.get("/documents/{document_id}", operation_id="getDocument")
def get_document(
    access: Annotated[ResourceAccess, _document(Action.READ)], repo: DocumentRepo
) -> DocumentDetail:
    doc = repo.get_document(access.resource_id)
    latest = repo.latest_revision(doc.id)
    return DocumentDetail(
        **_summary(doc).model_dump(),
        active_revision=_revision(repo, doc.active_revision_id),
        latest_revision=RevisionSummary(**vars(latest)) if latest else None,
    )


@router.get("/documents/{document_id}/source-url", operation_id="getDocumentSourceUrl")
def get_document_source_url(
    access: Annotated[ResourceAccess, _document(Action.READ)],
    repo: DocumentRepo,
    storage: StorageDep,
    settings: SettingsDep,
) -> SignedReadUrl:
    """A short-lived signed URL of the original PDF for the viewer; ask again when it expires."""
    doc = repo.get_document(access.resource_id)
    repo.rollback()
    ttl = settings.signed_read_url_ttl_seconds
    try:
        url = storage.create_signed_read_url(SOURCE_BUCKET, doc.source_object_key, ttl)
    except StorageUnavailableError:
        raise _storage_unavailable() from None
    return SignedReadUrl(url=url, expires_at=datetime.now(UTC) + timedelta(seconds=ttl))


@router.delete(
    "/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="deleteDocument",
)
def delete_document(
    access: Annotated[ResourceAccess, _document(Action.DOCUMENT_EDIT)], repo: DocumentRepo
) -> Response:
    """Soft delete (editor+). The document then answers 404 everywhere and leaves the library;
    the original stays in Storage until the retention cleanup (follow-up)."""
    repo.soft_delete(repo.get_document(access.resource_id), access.workspace.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
