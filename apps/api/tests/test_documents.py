"""Document upload API (M3.2a) route logic with in-memory fakes (no infra).

SQL, Storage and the real upload flow are covered against the local stack in
tests/integration/workspaces/test_document_upload.py and test_document_api_contract.py.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api.documents import (
    MAX_UPLOAD_BYTES,
    get_document_repository,
    get_job_publisher,
    get_storage,
)
from quiz_api.authz import LockMode, MembershipRecord, ResourceType, Role, get_access_repository
from quiz_api.authz.repository import TwoStepResourceMembership
from quiz_api.errors import ProblemType
from quiz_api.jobs import JobMessage
from quiz_api.main import create_app
from quiz_api.repositories.documents import (
    DocumentRecord,
    JobRow,
    ProcessingJobRecord,
    RevisionRecord,
    UploadRecord,
    parse_job_key,
)
from quiz_api.settings import Settings
from quiz_api.storage import (
    PDF_MAGIC,
    SOURCE_BUCKET,
    ObjectDigest,
    SignedUpload,
    StorageUnavailableError,
)

API = "/api/v1"
PROBLEM = "application/problem+json"
T0 = datetime(2026, 10, 1, tzinfo=UTC)
PDF = b"%PDF-1.7 synthetic"
PDF_SHA = hashlib.sha256(PDF).hexdigest()
SECRET_TOKEN = "signed-upload-token-SECRET"  # noqa: S105 - fake


@dataclass
class World(TwoStepResourceMembership):
    """Fake AccessRepository + DocumentRepository over shared in-memory state."""

    members: dict[tuple[uuid.UUID, uuid.UUID], Role] = field(default_factory=dict)
    archived: set[uuid.UUID] = field(default_factory=set)
    uploads: dict[uuid.UUID, UploadRecord] = field(default_factory=dict)
    documents: dict[uuid.UUID, DocumentRecord] = field(default_factory=dict)
    deleted: set[uuid.UUID] = field(default_factory=set)
    jobs: dict[uuid.UUID, JobRow] = field(default_factory=dict)
    revisions: dict[uuid.UUID, tuple[uuid.UUID, RevisionRecord]] = field(default_factory=dict)
    # document id -> its queued/running parse job, as `processing_jobs` reads it
    processing: dict[uuid.UUID, ProcessingJobRecord] = field(default_factory=dict)
    processing_reads: list[tuple[uuid.UUID, list[uuid.UUID]]] = field(default_factory=list)
    # document id -> its newest question import run, as `latest_imports` reads it
    imports: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    import_reads: list[tuple[uuid.UUID, list[uuid.UUID]]] = field(default_factory=list)
    # UX6-UPLOAD-B: document id -> imported question count; documents in use as books;
    # started imports (document id, revision id, actor); kind changes (document id, kind)
    question_count: dict[uuid.UUID, int] = field(default_factory=dict)
    in_use: set[uuid.UUID] = field(default_factory=set)
    started: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = field(default_factory=list)
    kind_changes: list[tuple[uuid.UUID, str]] = field(default_factory=list)
    locks: list[LockMode] = field(default_factory=list)
    commits: int = 0
    rollbacks: int = 0
    calls: list[str] = field(default_factory=list)

    def workspace(self, owner: uuid.UUID) -> uuid.UUID:
        ws = uuid.uuid4()
        self.members[(ws, owner)] = Role.OWNER
        return ws

    # AccessRepository
    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        self.locks.append(lock)
        role = self.members.get((workspace_id, user_id))
        if role is None:
            return None
        status = "archived" if workspace_id in self.archived else "active"
        return MembershipRecord(workspace_id, user_id, role, status, None)

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        if resource_type is ResourceType.UPLOAD and resource_id in self.uploads:
            return self.uploads[resource_id].workspace_id
        if resource_type is ResourceType.DOCUMENT and resource_id in self.documents:
            if resource_id in self.deleted:
                return None
            return self.documents[resource_id].workspace_id
        return None

    # DocumentRepository
    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def create_upload(self, **kw: Any) -> UploadRecord:
        self.calls.append("create_upload")
        upload = UploadRecord(
            id=uuid.uuid4(),
            workspace_id=kw["workspace_id"],
            user_id=kw["user_id"],
            document_id=kw["document_id"],
            revision_id=kw["revision_id"],
            document_type="book" if kw["document_type"] == "auto" else kw["document_type"],
            auto_classify=kw["document_type"] == "auto",
            title=kw["title"],
            filename=kw["filename"],
            expected_size_bytes=kw["size_bytes"],
            expected_sha256=kw["sha256"],
            object_key=kw["object_key"],
            status="pending",
            expires_at=T0 + timedelta(seconds=kw["ttl_seconds"]),
            expired=False,
            completed_job_id=None,
        )
        self.uploads[upload.id] = upload
        return upload

    def get_upload(self, upload_id: uuid.UUID, *, lock: bool = False) -> UploadRecord | None:
        self.calls.append(f"get_upload(lock={lock})")
        return self.uploads.get(upload_id)

    def complete_upload(
        self, upload: UploadRecord, *, job_id: uuid.UUID, actor_id: uuid.UUID
    ) -> None:
        self.calls.append("complete_upload")
        self.documents[upload.document_id] = DocumentRecord(
            id=upload.document_id,
            workspace_id=upload.workspace_id,
            document_type=upload.document_type,
            title=upload.title,
            filename=upload.filename,
            size_bytes=upload.expected_size_bytes,
            sha256=upload.expected_sha256,
            source_object_key=upload.object_key,
            status="processing",
            active_revision_id=None,
            last_error=None,
            created_at=T0,
            updated_at=T0,
            type_source="auto" if upload.auto_classify else "user",
            content_kind=None if upload.auto_classify else upload.document_type,
        )
        self.revisions[upload.revision_id] = (
            upload.document_id,
            RevisionRecord(upload.revision_id, 1, "draft", None),
        )
        self.jobs[job_id] = JobRow(
            id=job_id,
            workspace_id=upload.workspace_id,
            created_by=actor_id,
            job_type="document.parse",
            schema_version=1,
            idempotency_key=parse_job_key(upload.id),
            payload={"document_id": str(upload.document_id)},
            status="queued",
            published_at=None,
        )
        self.uploads[upload.id] = replace(upload, status="completed", completed_job_id=job_id)

    def find_parse_job(
        self, workspace_id: uuid.UUID, created_by: uuid.UUID, upload_id: uuid.UUID
    ) -> JobRow | None:
        key = parse_job_key(upload_id)
        return next((j for j in self.jobs.values() if j.idempotency_key == key), None)

    def get_job(self, job_id: uuid.UUID) -> JobRow | None:
        return self.jobs.get(job_id)

    def mark_published(self, job_id: uuid.UUID) -> None:
        self.jobs[job_id] = replace(self.jobs[job_id], published_at=T0)

    def list_documents(self, workspace_id: uuid.UUID, document_type: Any = None) -> list[Any]:
        return [
            d
            for d in self.documents.values()
            if d.workspace_id == workspace_id
            and d.id not in self.deleted
            and document_type in (None, d.document_type)
        ]

    def latest_imports(
        self, workspace_id: uuid.UUID, document_ids: Any
    ) -> dict[uuid.UUID, uuid.UUID]:
        self.import_reads.append((workspace_id, list(document_ids)))
        return {
            d: run
            for d, run in self.imports.items()
            if d in document_ids and self.documents[d].workspace_id == workspace_id
        }

    def processing_jobs(
        self, workspace_id: uuid.UUID, document_ids: Any
    ) -> dict[uuid.UUID, ProcessingJobRecord]:
        self.processing_reads.append((workspace_id, list(document_ids)))
        return {
            d: job
            for d, job in self.processing.items()
            if d in document_ids and self.documents[d].workspace_id == workspace_id
        }

    def get_document(self, document_id: uuid.UUID) -> DocumentRecord:
        return self.documents[document_id]

    def question_counts(self, workspace_id: uuid.UUID, document_ids: Any) -> dict[uuid.UUID, int]:
        return {
            d: n
            for d, n in self.question_count.items()
            if d in document_ids and self.documents[d].workspace_id == workspace_id
        }

    def lock_document(self, document_id: uuid.UUID) -> DocumentRecord:
        self.calls.append("lock_document")
        return self.documents[document_id]

    def in_use_as_book(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> bool:
        return document_id in self.in_use

    def change_kind(self, document: DocumentRecord, kind: Any, actor_id: uuid.UUID) -> None:
        self.kind_changes.append((document.id, kind))
        self.documents[document.id] = replace(
            document,
            document_type="question_paper" if kind == "question_paper" else "book",
            content_kind=kind,
            type_source="user",
        )

    def has_import_run(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> bool:
        return document_id in self.imports

    def start_import(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
    ) -> uuid.UUID:
        self.started.append((document_id, revision_id, actor_id))
        run_id, job_id = uuid.uuid4(), uuid.uuid4()
        self.imports[document_id] = run_id
        self.jobs[job_id] = JobRow(
            id=job_id,
            workspace_id=workspace_id,
            created_by=actor_id,
            job_type="question.import",
            schema_version=1,
            idempotency_key=f"question_import:{run_id}:1",
            payload={"import_id": str(run_id)},
            status="queued",
            published_at=None,
        )
        return job_id

    def get_revision(self, revision_id: uuid.UUID) -> RevisionRecord | None:
        entry = self.revisions.get(revision_id)
        return entry[1] if entry else None

    def latest_revision(self, document_id: uuid.UUID) -> RevisionRecord | None:
        found = [r for d, r in self.revisions.values() if d == document_id]
        return max(found, key=lambda r: r.revision_number) if found else None

    def soft_delete(self, document: DocumentRecord, actor_id: uuid.UUID) -> None:
        self.calls.append("soft_delete")
        self.deleted.add(document.id)


@dataclass
class FakeStorage:
    objects: dict[tuple[str, str], bytes] = field(default_factory=dict)
    signed: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    down: bool = False

    def create_signed_upload(self, bucket: str, key: str) -> SignedUpload:
        if self.down:
            raise StorageUnavailableError("sign-upload")
        self.signed.append(key)
        return SignedUpload(
            url=f"http://storage.test/upload/{bucket}/{key}?token={SECRET_TOKEN}",
            token=SECRET_TOKEN,
            resumable_endpoint="http://storage.test/upload/resumable/sign",
        )

    def digest(self, bucket: str, key: str, *, max_bytes: int) -> ObjectDigest | None:
        if self.down:
            raise StorageUnavailableError("download")
        data = self.objects.get((bucket, key))
        if data is None:
            return None
        return ObjectDigest(len(data), hashlib.sha256(data).hexdigest(), data[: len(PDF_MAGIC)])

    def create_signed_read_url(self, bucket: str, key: str, expires_in: int) -> str:
        return f"http://storage.test/sign/{bucket}/{key}?token=READ-{expires_in}"

    def delete(self, bucket: str, key: str) -> None:
        self.deleted.append(key)
        self.objects.pop((bucket, key), None)


@dataclass
class FakePublisher:
    sent: list[JobMessage] = field(default_factory=list)
    fail: bool = False

    def publish(self, message: JobMessage) -> None:
        if self.fail:
            raise ConnectionError("broker down")
        self.sent.append(message)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture
def publisher() -> FakePublisher:
    return FakePublisher()


@pytest.fixture
def app(
    make_verifier: Callable[..., Any],
    world: World,
    storage: FakeStorage,
    publisher: FakePublisher,
    auth_kit: Any,
) -> FastAPI:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_document_repository] = lambda: world
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_job_publisher] = lambda: publisher
    return app


@pytest.fixture
def api(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Callable[[uuid.UUID], dict[str, str]]:
    def make(user_id: uuid.UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}"}

    return make


def _problem(res: Any, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    assert res.status_code == status, res.text
    assert res.headers["content-type"] == PROBLEM
    body: dict[str, Any] = res.json()
    assert body["type"] == problem_type
    return body


def _intent_body(**overrides: Any) -> dict[str, Any]:
    return {
        "filename": "Book One.pdf",
        "size_bytes": len(PDF),
        "content_type": "application/pdf",
        "sha256": PDF_SHA.upper(),
        **overrides,
    }


Bearer = Callable[[uuid.UUID], dict[str, str]]


def _intent(
    api: TestClient, bearer: Bearer, user: uuid.UUID, ws: uuid.UUID, **overrides: Any
) -> dict[str, Any]:
    res = api.post(
        f"{API}/workspaces/{ws}/documents/upload-intent",
        json=_intent_body(**overrides),
        headers=bearer(user),
    )
    assert res.status_code == 201, res.text
    body: dict[str, Any] = res.json()
    return body


def _complete(
    api: TestClient, bearer: Bearer, user: uuid.UUID, upload_id: str, sha: str = PDF_SHA
) -> Any:
    return api.post(
        f"{API}/documents/complete-upload",
        json={"upload_id": upload_id, "sha256": sha},
        headers=bearer(user),
    )


# --- upload-intent ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/workspaces/{id}/documents/upload-intent"),
        ("POST", "/documents/complete-upload"),
        ("GET", "/workspaces/{id}/documents"),
        ("GET", "/documents/{id}"),
        ("GET", "/documents/{id}/source-url"),
        ("PATCH", "/documents/{id}"),
        ("DELETE", "/documents/{id}"),
    ],
)
def test_every_document_route_requires_a_token(
    api: TestClient, world: World, method: str, path: str
) -> None:
    res = api.request(method, API + path.format(id=uuid.uuid4()), json={})
    _problem(res, 401)
    assert world.locks == []


def test_upload_intent_reserves_ids_and_returns_signed_upload(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    body = _intent(api, bearer, user, ws)

    [upload] = world.uploads.values()
    assert body["upload_id"] == str(upload.id)
    assert upload.object_key == (
        f"workspaces/{ws}/documents/{upload.document_id}/revisions/{upload.revision_id}/source.pdf"
    )
    assert storage.signed == [upload.object_key]
    assert upload.expected_sha256 == PDF_SHA  # normalised to lowercase
    assert upload.title == "Book One"
    assert upload.document_type == "book"
    assert body["upload_url"].endswith(SECRET_TOKEN)
    assert body["upload_method"] == "PUT"
    assert body["resumable"]["headers"] == {"x-signature": SECRET_TOKEN}
    assert body["resumable"]["metadata"] == {
        "bucketName": SOURCE_BUCKET,
        "objectName": upload.object_key,
        "contentType": "application/pdf",
    }
    assert body["max_size_bytes"] == MAX_UPLOAD_BYTES
    assert world.commits == 1
    assert world.locks == [LockMode.SHARE]


@pytest.mark.parametrize(
    "overrides",
    [
        {"filename": "notes.txt", "content_type": "text/plain"},
        {"filename": "image.png", "content_type": "image/png"},
        {"filename": "book.pdf.exe", "content_type": "application/octet-stream"},
        {"filename": "book.pdf", "content_type": "application/x-msdownload"},
        {"filename": "book.exe", "content_type": "application/pdf"},
    ],
)
def test_upload_intent_rejects_non_pdf(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer, overrides: Any
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    res = api.post(
        f"{API}/workspaces/{ws}/documents/upload-intent",
        json=_intent_body(**overrides),
        headers=bearer(user),
    )
    assert "pdf" in _problem(res, 415)["detail"].lower()
    assert world.uploads == {}
    assert storage.signed == []


def test_upload_intent_rejects_oversize_and_bad_input(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    url = f"{API}/workspaces/{ws}/documents/upload-intent"
    big = api.post(url, json=_intent_body(size_bytes=MAX_UPLOAD_BYTES + 1), headers=bearer(user))
    assert "50 MiB" in _problem(big, 413)["detail"]
    for overrides in (
        {"size_bytes": 0},
        {"size_bytes": -1},
        {"sha256": "abc"},
        {"filename": "../../etc/passwd.pdf"},
        {"filename": "a\nb.pdf"},
        {"document_type": "novel"},
        {"unexpected": 1},
    ):
        res = api.post(url, json=_intent_body(**overrides), headers=bearer(user))
        _problem(res, 422)
    assert world.uploads == {}
    assert storage.signed == []


def test_upload_intent_checks_role_and_archive_before_the_body(
    api: TestClient, world: World, bearer: Bearer
) -> None:
    owner, viewer, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    url = f"{API}/workspaces/{ws}/documents/upload-intent"
    # An incomplete body still gets the authorization answer first.
    body = {"filename": "a.pdf", "size_bytes": 1, "content_type": "application/pdf"}
    _problem(api.post(url, json=body, headers=bearer(viewer)), 403, ProblemType.INSUFFICIENT_ROLE)
    _problem(api.post(url, json=body, headers=bearer(stranger)), 404)
    world.archived.add(ws)
    _problem(api.post(url, json=body, headers=bearer(owner)), 403, ProblemType.WORKSPACE_ARCHIVED)
    assert world.uploads == {}


def test_upload_intent_is_503_when_storage_fails(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    storage.down = True
    res = api.post(
        f"{API}/workspaces/{ws}/documents/upload-intent", json=_intent_body(), headers=bearer(user)
    )
    _problem(res, 503)
    assert world.commits == 0
    assert world.rollbacks == 1


def test_storage_not_configured_is_503(
    make_verifier: Callable[..., Any], world: World, auth_kit: Any, bearer: Bearer
) -> None:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_document_repository] = lambda: world
    user = uuid.uuid4()
    ws = world.workspace(user)
    with TestClient(app, raise_server_exceptions=False) as client:
        res = client.post(
            f"{API}/workspaces/{ws}/documents/upload-intent",
            json=_intent_body(),
            headers=bearer(user),
        )
    assert _problem(res, 503)["detail"] == "File storage is not configured."


# --- complete-upload ----------------------------------------------------------------------------


def test_complete_upload_verifies_then_creates_and_publishes(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    publisher: FakePublisher,
    bearer: Bearer,
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
    world.locks.clear()

    res = _complete(api, bearer, user, intent["upload_id"])
    assert res.status_code == 202, res.text
    job_id = uuid.UUID(res.json()["job_id"])
    assert res.json()["document_id"] == str(upload.document_id)
    # Read check without locks, then the write under the content-write lock + intent row lock.
    assert world.locks == [LockMode.NONE, LockMode.SHARE]
    assert "get_upload(lock=True)" in world.calls
    [message] = publisher.sent
    assert message.job_id == job_id
    assert message.job_type == "document.parse"
    assert message.created_by == user
    assert message.workspace_id == ws
    assert message.idempotency_key == parse_job_key(upload.id)
    assert world.jobs[job_id].published_at is not None

    # Repeating it returns the same ids and neither re-verifies nor re-publishes.
    storage.objects.clear()
    again = _complete(api, bearer, user, intent["upload_id"])
    assert again.status_code == 202
    assert again.json() == res.json()
    assert len(publisher.sent) == 1
    assert world.calls.count("complete_upload") == 1


def test_complete_upload_retry_recovers_a_failed_publish(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    publisher: FakePublisher,
    bearer: Bearer,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF

    publisher.fail = True
    with caplog.at_level(logging.WARNING):
        first = _complete(api, bearer, user, intent["upload_id"])
    assert first.status_code == 202  # the job row exists; the reconciler can publish it
    job_id = uuid.UUID(first.json()["job_id"])
    assert world.jobs[job_id].published_at is None
    assert "reconciler will retry" in caplog.text

    publisher.fail = False
    again = _complete(api, bearer, user, intent["upload_id"])
    assert again.json() == first.json()
    assert [m.job_id for m in publisher.sent] == [job_id]
    assert world.jobs[job_id].published_at is not None


def test_complete_upload_without_object_is_409(
    api: TestClient, world: World, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    res = _complete(api, bearer, user, intent["upload_id"])
    _problem(res, 409, ProblemType.UPLOAD_INCOMPLETE)
    assert world.documents == {}


@pytest.mark.parametrize(
    ("stored", "status"),
    [
        (PDF + b"extra", 422),  # size differs
        (PDF.replace(b"synthetic", b"SYNTHETIC"), 422),  # same size, other bytes
        (b"MZ" + PDF[2:], 415),  # not a PDF
    ],
)
def test_complete_upload_discards_mismatched_objects(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    bearer: Bearer,
    stored: bytes,
    status: int,
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = stored
    _problem(_complete(api, bearer, user, intent["upload_id"]), status, ProblemType.UPLOAD_MISMATCH)
    assert storage.deleted == [upload.object_key]
    assert world.documents == {}


def test_complete_upload_rejects_a_different_declared_digest(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    res = _complete(api, bearer, user, intent["upload_id"], sha="0" * 64)
    _problem(res, 422, ProblemType.UPLOAD_MISMATCH)
    assert storage.deleted == []


def test_complete_upload_expired_is_409(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    upload_id = uuid.UUID(intent["upload_id"])
    world.uploads[upload_id] = replace(world.uploads[upload_id], expired=True)
    storage.objects[(SOURCE_BUCKET, world.uploads[upload_id].object_key)] = PDF
    _problem(_complete(api, bearer, user, intent["upload_id"]), 409, ProblemType.UPLOAD_EXPIRED)
    assert world.documents == {}


def test_complete_upload_is_the_uploaders_only(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner, editor, viewer, stranger = (uuid.uuid4() for _ in range(4))
    ws = world.workspace(owner)
    world.members[(ws, editor)] = Role.EDITOR
    world.members[(ws, viewer)] = Role.VIEWER
    intent = _intent(api, bearer, owner, ws)
    storage.objects[(SOURCE_BUCKET, world.uploads[uuid.UUID(intent["upload_id"])].object_key)] = PDF

    def stable(body: dict[str, Any]) -> dict[str, Any]:
        return {k: body[k] for k in ("type", "title", "status", "detail")}

    missing = stable(_problem(_complete(api, bearer, owner, str(uuid.uuid4())), 404))
    for other in (editor, stranger):
        assert stable(_problem(_complete(api, bearer, other, intent["upload_id"]), 404)) == missing
    _problem(
        _complete(api, bearer, viewer, intent["upload_id"]), 403, ProblemType.INSUFFICIENT_ROLE
    )
    world.archived.add(ws)
    _problem(
        _complete(api, bearer, owner, intent["upload_id"]), 403, ProblemType.WORKSPACE_ARCHIVED
    )
    assert world.documents == {}


def test_storage_outage_during_verification_is_503(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    intent = _intent(api, bearer, user, ws)
    storage.down = True
    _problem(_complete(api, bearer, user, intent["upload_id"]), 503)
    assert world.documents == {}


def test_signed_urls_never_reach_the_logs(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    bearer: Bearer,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = uuid.uuid4()
    ws = world.workspace(user)
    with caplog.at_level(logging.DEBUG):
        intent = _intent(api, bearer, user, ws)
        storage.objects[
            (SOURCE_BUCKET, world.uploads[uuid.UUID(intent["upload_id"])].object_key)
        ] = PDF
        done = _complete(api, bearer, user, intent["upload_id"]).json()
        read = api.get(f"{API}/documents/{done['document_id']}/source-url", headers=bearer(user))
    assert read.status_code == 200
    assert read.headers["cache-control"] == "no-store"
    assert SECRET_TOKEN not in caplog.text
    assert "READ-" not in caplog.text


# --- reads / delete -----------------------------------------------------------------------------


def test_list_get_source_url_and_soft_delete(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner, viewer, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    intent = _intent(api, bearer, owner, ws)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
    doc_id = _complete(api, bearer, owner, intent["upload_id"]).json()["document_id"]

    listed = api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(viewer)).json()
    assert [(d["id"], d["title"], d["filename"], d["status"]) for d in listed["items"]] == [
        (doc_id, "Book One", "Book One.pdf", "processing")
    ]
    papers = api.get(
        f"{API}/workspaces/{ws}/documents?document_type=question_paper", headers=bearer(viewer)
    ).json()
    assert papers["items"] == []

    detail = api.get(f"{API}/documents/{doc_id}", headers=bearer(viewer)).json()
    assert detail["active_revision"] is None
    assert detail["latest_revision"]["id"] == str(upload.revision_id)
    assert detail["latest_revision"]["status"] == "draft"

    signed = api.get(f"{API}/documents/{doc_id}/source-url", headers=bearer(viewer)).json()
    assert signed["url"].startswith(f"http://storage.test/sign/{SOURCE_BUCKET}/{upload.object_key}")
    _problem(api.get(f"{API}/documents/{doc_id}/source-url", headers=bearer(stranger)), 404)

    _problem(
        api.delete(f"{API}/documents/{doc_id}", headers=bearer(viewer)),
        403,
        ProblemType.INSUFFICIENT_ROLE,
    )
    assert api.delete(f"{API}/documents/{doc_id}", headers=bearer(owner)).status_code == 204
    for method, path in (
        ("GET", f"/documents/{doc_id}"),
        ("GET", f"/documents/{doc_id}/source-url"),
        ("DELETE", f"/documents/{doc_id}"),
    ):
        assert _problem(api.request(method, API + path, headers=bearer(owner)), 404)["detail"] == (
            "Document not found."
        )
    assert api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(owner)).json() == {
        "items": []
    }


def test_doc_01_ac05_list_and_detail_carry_the_processing_job(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    """UX3-JOB: a library that does not follow the job live still shows its status and stage
    (a cold worker's `preparing`) and since when it runs, from the list alone."""
    owner, viewer, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    intent = _intent(api, bearer, owner, ws)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
    done = _complete(api, bearer, owner, intent["upload_id"]).json()
    doc_id, job_id = uuid.UUID(done["document_id"]), uuid.UUID(done["job_id"])

    def listed_job() -> Any:
        items = api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(viewer)).json()["items"]
        assert [d["id"] for d in items] == [str(doc_id)]
        return items[0]["processing_job"]

    assert listed_job() is None  # no queued/running job reported (yet)
    world.processing[doc_id] = ProcessingJobRecord(
        id=job_id, status="queued", stage=None, progress=None, created_at=T0, started_at=None
    )
    assert listed_job() == {
        "id": str(job_id),
        "status": "queued",
        "stage": None,
        "progress": None,
        "created_at": "2026-10-01T00:00:00Z",
        "started_at": None,
    }
    started = T0 + timedelta(seconds=5)
    world.processing[doc_id] = ProcessingJobRecord(
        id=job_id,
        status="running",
        stage="preparing",
        progress=2,
        created_at=T0,
        started_at=started,
    )
    job = listed_job()
    assert (job["status"], job["stage"], job["progress"]) == ("running", "preparing", 2)
    assert job["started_at"] == "2026-10-01T00:00:05Z"
    # Jobs are read inside the authorized workspace only, for the listed documents.
    assert world.processing_reads[-1] == (ws, [doc_id])

    detail = api.get(f"{API}/documents/{doc_id}", headers=bearer(viewer)).json()
    assert detail["processing_job"]["stage"] == "preparing"
    _problem(api.get(f"{API}/documents/{doc_id}", headers=bearer(stranger)), 404)
    _problem(api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(stranger)), 404)

    del world.processing[doc_id]
    assert listed_job() is None


def test_qimport_01_ac06_question_papers_carry_their_latest_import(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    """The 문제 PDF 관리 rows decide 문제 추출 / 문제 검토 from this field: it is read for every
    listed question paper (inside the authorized workspace), never from a truncated run list."""
    owner, viewer = uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    papers = []
    for _ in range(2):
        intent = _intent(api, bearer, owner, ws, document_type="question_paper")
        upload = world.uploads[uuid.UUID(intent["upload_id"])]
        storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
        papers.append(
            uuid.UUID(_complete(api, bearer, owner, intent["upload_id"]).json()["document_id"])
        )
    book_intent = _intent(api, bearer, owner, ws)
    upload = world.uploads[uuid.UUID(book_intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
    book = uuid.UUID(_complete(api, bearer, owner, book_intent["upload_id"]).json()["document_id"])
    run, book_run = uuid.uuid4(), uuid.uuid4()
    world.imports[papers[0]] = run
    world.imports[book] = book_run

    items = api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(viewer)).json()["items"]
    latest = {d["id"]: d["latest_import_id"] for d in items}
    assert latest == {str(papers[0]): str(run), str(papers[1]): None, str(book): str(book_run)}
    # Every listed document is looked up (UX6-UPLOAD-B: books can have imports too), all of them,
    # in the authorized workspace.
    assert world.import_reads[-1][0] == ws
    assert sorted(world.import_reads[-1][1]) == sorted([*papers, book])
    detail = api.get(f"{API}/documents/{papers[0]}", headers=bearer(viewer)).json()
    assert detail["latest_import_id"] == str(run)


def test_openapi_documents_the_document_routes(api: TestClient) -> None:
    spec = api.get(f"{API}/openapi.json").json()
    ops = {
        (method, path): op["operationId"]
        for path, item in spec["paths"].items()
        for method, op in item.items()
        if "documents" in op.get("tags", [])
    }
    assert ops == {
        (
            "post",
            "/api/v1/workspaces/{workspace_id}/documents/upload-intent",
        ): "createDocumentUploadIntent",
        ("post", "/api/v1/documents/complete-upload"): "completeDocumentUpload",
        ("get", "/api/v1/workspaces/{workspace_id}/documents"): "listDocuments",
        ("get", "/api/v1/documents/{document_id}"): "getDocument",
        ("get", "/api/v1/documents/{document_id}/source-url"): "getDocumentSourceUrl",
        ("patch", "/api/v1/documents/{document_id}"): "updateDocumentKind",
        ("delete", "/api/v1/documents/{document_id}"): "deleteDocument",
        # M3.4 (quiz_api.api.document_revisions)
        ("get", "/api/v1/documents/{document_id}/outline"): "getDocumentOutline",
        ("get", "/api/v1/documents/{document_id}/blocks"): "listDocumentBlocks",
        ("get", "/api/v1/documents/{document_id}/blocks/{block_id}"): "getDocumentBlock",
        ("patch", "/api/v1/documents/{document_id}/blocks/{block_id}"): "correctDocumentBlock",
        ("post", "/api/v1/documents/{document_id}/publish"): "publishDocumentDraft",
        ("get", "/api/v1/documents/{document_id}/revisions"): "listDocumentRevisions",
        (
            "post",
            "/api/v1/documents/{document_id}/revisions/{revision_id}/restore",
        ): "restoreDocumentRevision",
    }
    intent = spec["paths"]["/api/v1/workspaces/{workspace_id}/documents/upload-intent"]["post"]
    assert {"201", "403", "404", "413", "415", "422", "503"} <= set(intent["responses"])
    complete = spec["paths"]["/api/v1/documents/complete-upload"]["post"]
    assert {"202", "404", "409", "415", "422", "503"} <= set(complete["responses"])


# --- UX6-UPLOAD-B: automatic kinds and 종류 변경 ---------------------------------------------


def _uploaded(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    bearer: Bearer,
    user: uuid.UUID,
    ws: uuid.UUID,
    **overrides: Any,
) -> uuid.UUID:
    intent = _intent(api, bearer, user, ws, **overrides)
    upload = world.uploads[uuid.UUID(intent["upload_id"])]
    storage.objects[(SOURCE_BUCKET, upload.object_key)] = PDF
    return uuid.UUID(_complete(api, bearer, user, intent["upload_id"]).json()["document_id"])


def _make_ready(world: World, doc_id: uuid.UUID, **changes: Any) -> uuid.UUID:
    revision = uuid.uuid4()
    world.documents[doc_id] = replace(
        world.documents[doc_id], status="ready", active_revision_id=revision, **changes
    )
    return revision


def test_ux6_auto_upload_starts_as_an_unclassified_book(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    doc_id = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    upload = next(iter(world.uploads.values()))
    assert (upload.document_type, upload.auto_classify) == ("book", True)

    detail = api.get(f"{API}/documents/{doc_id}", headers=bearer(owner)).json()
    assert (detail["document_type"], detail["kind"], detail["kind_source"]) == (
        "book",
        None,
        "auto",
    )
    assert detail["question_count"] == 0
    # Explicit uploads keep their kind (the current web still sends them).
    paper = _uploaded(api, world, storage, bearer, owner, ws, document_type="question_paper")
    got = api.get(f"{API}/documents/{paper}", headers=bearer(owner)).json()
    assert (got["document_type"], got["kind"], got["kind_source"]) == (
        "question_paper",
        "question_paper",
        "user",
    )
    _problem(
        api.post(
            f"{API}/workspaces/{ws}/documents/upload-intent",
            json=_intent_body(document_type="mixed"),
            headers=bearer(owner),
        ),
        422,
    )


def test_ux6_list_carries_kinds_and_imported_question_counts(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    mixed = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    _make_ready(world, mixed, content_kind="mixed")
    world.question_count[mixed] = 7
    items = api.get(f"{API}/workspaces/{ws}/documents", headers=bearer(owner)).json()["items"]
    assert [(d["kind"], d["kind_source"], d["question_count"]) for d in items] == [
        ("mixed", "auto", 7)
    ]


def test_ux6_kind_change_authorization(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner, viewer, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    doc_id = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    _make_ready(world, doc_id, content_kind="book")
    path = f"{API}/documents/{doc_id}"

    _problem(api.patch(path, json={"kind": "mixed"}, headers=bearer(stranger)), 404)
    _problem(
        api.patch(path, json={"kind": "mixed"}, headers=bearer(viewer)),
        403,
        ProblemType.INSUFFICIENT_ROLE,
    )
    _problem(api.patch(path, json={"kind": "novel"}, headers=bearer(owner)), 422)
    _problem(
        api.patch(path, json={"kind": "mixed", "document_type": "book"}, headers=bearer(owner)),
        422,
    )
    world.archived.add(ws)
    _problem(
        api.patch(path, json={"kind": "mixed"}, headers=bearer(owner)),
        403,
        ProblemType.WORKSPACE_ARCHIVED,
    )
    world.archived.discard(ws)
    world.deleted.add(doc_id)
    _problem(api.patch(path, json={"kind": "mixed"}, headers=bearer(owner)), 404)
    assert world.kind_changes == []
    assert world.started == []


def test_ux6_kind_change_needs_a_ready_document(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    doc_id = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    _problem(
        api.patch(f"{API}/documents/{doc_id}", json={"kind": "book"}, headers=bearer(owner)),
        409,
        ProblemType.DOCUMENT_NOT_READY,
    )
    assert world.kind_changes == []


def test_ux6_a_book_in_use_cannot_become_a_question_paper(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    doc_id = _uploaded(api, world, storage, bearer, owner, ws)
    _make_ready(world, doc_id)
    world.in_use.add(doc_id)
    path = f"{API}/documents/{doc_id}"
    _problem(
        api.patch(path, json={"kind": "question_paper"}, headers=bearer(owner)),
        409,
        ProblemType.DOCUMENT_IN_USE,
    )
    assert world.kind_changes == []
    assert world.started == []
    # Staying body text is allowed (document_type does not change).
    res = api.patch(path, json={"kind": "mixed", "extract": False}, headers=bearer(owner))
    assert res.status_code == 200, res.text
    assert (res.json()["kind"], res.json()["document_type"]) == ("mixed", "book")


def test_ux6_kind_change_pins_the_kind_and_starts_one_import(
    api: TestClient,
    world: World,
    storage: FakeStorage,
    publisher: FakePublisher,
    bearer: Bearer,
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    doc_id = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    revision = _make_ready(world, doc_id, content_kind="book")
    path = f"{API}/documents/{doc_id}"
    sent_before = len(publisher.sent)

    res = api.patch(path, json={"kind": "question_paper"}, headers=bearer(owner))
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["document_type"], body["kind"], body["kind_source"]) == (
        "question_paper",
        "question_paper",
        "user",
    )
    assert world.started == [(doc_id, revision, owner)]
    assert body["latest_import_id"] == str(world.imports[doc_id])
    # The import job was handed to the broker after the commit.
    assert [m.job_type for m in publisher.sent[sent_before:]] == ["question.import"]

    # Repeating it, or moving to another kind with questions, starts nothing new.
    for kind in ("question_paper", "mixed"):
        again = api.patch(path, json={"kind": kind}, headers=bearer(owner))
        assert again.status_code == 200, again.text
    assert len(world.started) == 1
    assert world.kind_changes == [(doc_id, "question_paper"), (doc_id, "mixed")]
    # Back to a book: nothing is deleted, the run stays visible.
    book = api.patch(path, json={"kind": "book"}, headers=bearer(owner)).json()
    assert (book["kind"], book["latest_import_id"]) == ("book", str(world.imports[doc_id]))


def test_ux6_kind_change_without_extract_or_to_book_starts_nothing(
    api: TestClient, world: World, storage: FakeStorage, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    doc_id = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    _make_ready(world, doc_id, content_kind="question_paper", document_type="question_paper")
    path = f"{API}/documents/{doc_id}"
    for body in ({"kind": "mixed", "extract": False}, {"kind": "book"}):
        res = api.patch(path, json=body, headers=bearer(owner))
        assert res.status_code == 200, res.text
    assert world.started == []
    # An auto kind confirmed as it is gets pinned (the worker never reclassifies a user kind).
    other = _uploaded(api, world, storage, bearer, owner, ws, document_type="auto")
    _make_ready(world, other, content_kind="book")
    res = api.patch(f"{API}/documents/{other}", json={"kind": "book"}, headers=bearer(owner))
    assert res.json()["kind_source"] == "user"


def test_ux6_in_use_check_covers_chapters_drafts_pending_registrations_and_sources() -> None:
    """The SQL of `in_use_as_book` (run against the stack in
    tests/integration/questions/test_document_kinds.py): every kind of reliance on the book is
    looked up inside the workspace, including a submitted registration whose chapter lives only in
    its pending item (Codex P2)."""
    from quiz_api.repositories.documents import DocumentRepository
    from sqlalchemy.dialects import postgresql

    class Recorder:
        def __init__(self) -> None:
            self.sql: list[str] = []

        def execute(self, stmt: Any) -> Any:
            self.sql.append(str(stmt.compile(dialect=postgresql.dialect())))  # type: ignore[no-untyped-call]

            class _Result:
                @staticmethod
                def first() -> None:
                    return None

            return _Result()

    session = Recorder()
    repo = DocumentRepository(session)  # type: ignore[arg-type]
    assert repo.in_use_as_book(uuid.uuid4(), uuid.uuid4()) is False
    joined = "\n".join(session.sql)
    assert len(session.sql) == 4
    assert all("workspace_id" in sql for sql in session.sql)
    assert "FROM public.questions" in joined
    assert "FROM public.question_drafts" in joined
    assert "public.question_drafts.published_question_id IS NULL" in joined
    pending = next(s for s in session.sql if "question_import_registration_items" in s)
    assert "public.question_import_registration_items.state =" in pending
    assert "public.question_import_registration_items.chapter_id IN" in pending
    assert "public.question_sources.import_run_id IS NULL" in joined
