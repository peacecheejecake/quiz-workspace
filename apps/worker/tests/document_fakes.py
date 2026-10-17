"""In-memory stand-ins for the document job's DB and Storage (unit and `models` tests).

`FakeDocumentStore` stores content through the same row encoding as the Postgres store
(`chapter_rows` / `block_rows` / `revision_from_rows`), so the round trip is exercised too.
Qdrant runs in qdrant-client's local in-memory mode.
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from book_core.contracts import DocumentRevision
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_worker.adapters import FailureInjectingEmbedder
from quiz_worker.document_store import (
    ContentChangedError,
    DocumentBusyError,
    DocumentDeletedError,
    DocumentRow,
    JobRow,
    RevisionRow,
    block_rows,
    chapter_rows,
    revision_from_rows,
)
from quiz_worker.storage import (
    SOURCE_BUCKET,
    DownloadedObject,
    ObjectMissingError,
    ObjectTooLargeError,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"


@dataclass
class FakeDocumentStore:
    documents: dict[uuid.UUID, DocumentRow] = field(default_factory=dict)
    revisions: dict[uuid.UUID, RevisionRow] = field(default_factory=dict)
    chapters: dict[uuid.UUID, list[dict[str, Any]]] = field(default_factory=dict)
    blocks: dict[uuid.UUID, list[dict[str, Any]]] = field(default_factory=dict)
    last_errors: dict[uuid.UUID, str | None] = field(default_factory=dict)
    jobs: dict[uuid.UUID, JobRow] = field(default_factory=dict)
    progress: list[tuple[str, int]] = field(default_factory=list)
    writes: int = 0
    busy: bool = False
    locked: set[uuid.UUID] = field(default_factory=set)
    # Reads the job row (e.g. from a JobStore); defaults to `jobs`.
    job_source: Callable[[uuid.UUID], JobRow | None] | None = None
    _mutex: threading.Lock = field(default_factory=threading.Lock)

    # -- seeding -----------------------------------------------------------------------------
    def add_document(
        self, data: bytes, *, document_type: str = "book", title: str = "Book"
    ) -> tuple[DocumentRow, RevisionRow]:
        workspace_id, document_id, revision_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        key = (
            f"workspaces/{workspace_id}/documents/{document_id}/revisions/{revision_id}/source.pdf"
        )
        document = DocumentRow(
            id=document_id,
            workspace_id=workspace_id,
            document_type=document_type,
            title=title,
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            source_object_key=key,
            status="processing",
            active_revision_id=None,
            deleted=False,
        )
        revision = RevisionRow(revision_id, document_id, 1, None, "draft", None, None)
        self.documents[document_id] = document
        self.revisions[revision_id] = revision
        return document, revision

    def add_draft(self, document_id: uuid.UUID, content: DocumentRevision) -> RevisionRow:
        """A corrected draft revision whose content is already stored (M3.4 shape)."""
        previous = [r for r in self.revisions.values() if r.document_id == document_id]
        revision = RevisionRow(
            id=uuid.UUID(content.revision_id),
            document_id=document_id,
            revision_number=max(r.revision_number for r in previous) + 1,
            parent_revision_id=uuid.UUID(content.parent_revision_id)
            if content.parent_revision_id
            else None,
            status="draft",
            content_hash=None,
            parsed_object_key=None,
        )
        self.revisions[revision.id] = revision
        self.write_content(
            self.documents[document_id], revision, content, parser_version="x", parsed_object_key=""
        )
        self.revisions[revision.id] = replace(self.revisions[revision.id], parsed_object_key=None)
        return self.revisions[revision.id]

    # -- DocumentStore -------------------------------------------------------------------------
    @contextmanager
    def document_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        with self._mutex:
            if self.busy or document_id in self.locked:
                raise DocumentBusyError("another job is processing this document")
            self.locked.add(document_id)
        try:
            yield
        finally:
            self.locked.discard(document_id)

    def load(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, revision_id: uuid.UUID
    ) -> tuple[DocumentRow, RevisionRow] | None:
        document = self.documents.get(document_id)
        revision = self.revisions.get(revision_id)
        if document is None or revision is None or document.workspace_id != workspace_id:
            return None
        if revision.document_id != document_id:
            return None
        return document, revision

    def mark_processing(self, document_id: uuid.UUID) -> None:
        doc = self.documents[document_id]
        if doc.active_revision_id is None:
            self.documents[document_id] = replace(doc, status="processing")
            self.last_errors[document_id] = None

    def write_content(
        self,
        document: DocumentRow,
        revision: RevisionRow,
        content: DocumentRevision,
        *,
        parser_version: str,
        parsed_object_key: str,
    ) -> None:
        current = self.revisions[revision.id]
        if current.status != "draft" or current.content_hash is not None:
            return
        chapters, ids = chapter_rows(document, revision, content)
        self.chapters[revision.id] = chapters
        self.blocks[revision.id] = block_rows(document, revision, content, ids)
        self.revisions[revision.id] = replace(
            current, content_hash=content.content_hash, parsed_object_key=parsed_object_key
        )
        self.writes += 1

    def load_content(self, document: DocumentRow, revision: RevisionRow) -> DocumentRevision:
        return revision_from_rows(
            document, revision, self.chapters[revision.id], self.blocks[revision.id]
        )

    def publish(
        self,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
        content_hash: str,
        *,
        before_commit: Callable[[], None],
    ) -> uuid.UUID | None:
        document = self.documents[document_id]
        if document.deleted:
            raise DocumentDeletedError("the document was deleted")
        revision = self.revisions[revision_id]
        if revision.content_hash != content_hash:
            raise ContentChangedError("changed")
        before_commit()
        previous = document.active_revision_id
        self.revisions[revision_id] = replace(revision, status="published")
        self.documents[document_id] = replace(
            document, status="ready", active_revision_id=revision_id
        )
        self.last_errors[document_id] = None
        return previous

    def record_failure(self, document_id: uuid.UUID, revision_id: uuid.UUID, error: str) -> None:
        document = self.documents[document_id]
        if document.active_revision_id == revision_id:
            return
        status = "failed" if document.active_revision_id is None else document.status
        self.documents[document_id] = replace(document, status=status)
        self.last_errors[document_id] = error

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        self.progress.append((stage, percent))

    def job(self, job_id: uuid.UUID) -> JobRow | None:
        if self.job_source is not None:
            return self.job_source(job_id)
        return self.jobs.get(job_id)


@dataclass
class FakeStorage:
    objects: dict[tuple[str, str], bytes] = field(default_factory=dict)
    downloads: int = 0
    deleted: list[tuple[str, str]] = field(default_factory=list)

    def put_source(self, document: DocumentRow, data: bytes) -> None:
        self.objects[(SOURCE_BUCKET, document.source_object_key)] = data

    def download(self, bucket: str, key: str, dest: Path, *, max_bytes: int) -> DownloadedObject:
        self.downloads += 1
        data = self.objects.get((bucket, key))
        if data is None:
            raise ObjectMissingError("source object not found")
        if len(data) > max_bytes:
            raise ObjectTooLargeError("too large")
        dest.write_bytes(data)
        return DownloadedObject(dest, len(data), hashlib.sha256(data).hexdigest())

    def upload(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        self.objects[(bucket, key)] = data

    def delete(self, bucket: str, key: str) -> None:
        self.deleted.append((bucket, key))
        self.objects.pop((bucket, key), None)


def memory_index(prefix: str = "unit_") -> tuple[QdrantIndexStore, QdrantClient]:
    client = QdrantClient(location=":memory:")
    store = QdrantIndexStore(
        client,
        FailureInjectingEmbedder(FakeEmbedder()),
        names=CollectionNames(prefix=prefix),
    )
    return store, client


def points(
    store: QdrantIndexStore, client: QdrantClient, document_id: uuid.UUID
) -> list[dict[str, Any]]:
    collection = store.ensure_collection()
    flt = qm.Filter(
        must=[qm.FieldCondition(key="document_id", match=qm.MatchValue(value=str(document_id)))]
    )
    records, _ = client.scroll(collection, scroll_filter=flt, limit=10_000, with_payload=True)
    return [dict(r.payload or {}) for r in records]
