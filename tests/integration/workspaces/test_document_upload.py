"""M3.2a upload flow against the local stack: authorization, re-verification, private Storage.

Complements the DOC-01 contract tests (test_document_api_contract.py) with what the browser
cannot observe: only the uploader completes an intent, the stored bytes are re-hashed
server-side, the parse job row carries the verified `created_by`, the buckets refuse direct
client access, and signed read URLs are issued to members only. Fixtures: conftest.py.

Needs the M3.2a migration (20261017200000_documents.sql) applied and `SUPABASE_SECRET_KEY` in the
environment / `.env` (the API's server-side Storage key).
"""

from __future__ import annotations

import base64
import hashlib
import os
import uuid
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
UPLOAD_MISMATCH = "urn:quiz-workspace:problem:upload-mismatch"
UPLOAD_INCOMPLETE = "urn:quiz-workspace:problem:upload-incomplete"
PDF = b"%PDF-1.4\n% synthetic M3.2a upload fixture\n%%EOF\n"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _intent(client: Any, workspace_id: str, data: bytes = PDF, **overrides: Any) -> dict[str, Any]:
    body = {
        "filename": "synthetic.pdf",
        "size_bytes": len(data),
        "content_type": "application/pdf",
        "sha256": _sha(data),
        **overrides,
    }
    res = client.call("POST", f"/workspaces/{workspace_id}/documents/upload-intent", body)
    assert res.status_code == 201, f"upload-intent: HTTP {res.status_code}: {res.text[:300]}"
    intent: dict[str, Any] = res.json()
    return intent


def _put(intent: dict[str, Any], data: bytes) -> httpx.Response:
    return httpx.put(
        intent["upload_url"],
        content=data,
        headers={"content-type": "application/pdf", **intent["upload_headers"]},
        timeout=30,
    )


def _complete(client: Any, upload_id: str, data: bytes = PDF) -> httpx.Response:
    res: httpx.Response = client.call(
        "POST", "/documents/complete-upload", {"upload_id": upload_id, "sha256": _sha(data)}
    )
    return res


def _upload(client: Any, workspace_id: str, data: bytes = PDF) -> dict[str, Any]:
    intent = _intent(client, workspace_id, data)
    assert _put(intent, data).is_success
    res = _complete(client, intent["upload_id"], data)
    assert res.status_code == 202, f"complete-upload: HTTP {res.status_code}: {res.text[:300]}"
    done: dict[str, Any] = res.json()
    return done


def _db(sql: str, *params: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL) as conn:
        return conn.execute(sql, params).fetchall()


def test_m32a_only_the_uploader_completes_an_intent(seed: Any) -> None:
    owner, editor, outsider = (
        seed.client("m32a-owner"),
        seed.client("m32a-editor"),
        seed.client("m32a-outsider"),
    )
    ws = owner.create_workspace()
    seed.membership(ws["id"], editor.user, "editor")
    intent = _intent(owner, ws["id"])
    assert _put(intent, PDF).is_success

    for other in (editor, outsider):
        problem = seed.problem(_complete(other, intent["upload_id"]), 404)
        assert problem["detail"] == "Upload not found."
    unknown = seed.problem(_complete(owner, str(uuid.uuid4())), 404)
    assert unknown["detail"] == "Upload not found."

    assert _complete(owner, intent["upload_id"]).status_code == 202
    # An editor uploads with an intent of their own.
    assert _upload(editor, ws["id"])["document_id"]


def test_m32a_viewer_and_archived_workspace_cannot_upload(seed: Any) -> None:
    owner, viewer = seed.client("m32a-owner2"), seed.client("m32a-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    body = {
        "filename": "a.pdf",
        "size_bytes": len(PDF),
        "content_type": "application/pdf",
        "sha256": _sha(PDF),
    }
    seed.problem(
        viewer.call("POST", f"/workspaces/{ws['id']}/documents/upload-intent", body),
        403,
        seed.INSUFFICIENT_ROLE,
    )

    # An intent issued before the workspace was archived cannot be completed afterwards.
    intent = _intent(owner, ws["id"])
    assert _put(intent, PDF).is_success
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    seed.problem(_complete(owner, intent["upload_id"]), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{ws['id']}/restore")
    assert _complete(owner, intent["upload_id"]).status_code == 202


def test_m32a_complete_upload_rehashes_the_stored_bytes(seed: Any) -> None:
    alice = seed.client("m32a-hash")
    ws = alice.create_workspace()

    # Declared bytes A, uploaded bytes B of the same length: Storage accepts the PUT, the API
    # does not accept the object.
    tampered = PDF.replace(b"synthetic", b"SYNTHETIC")
    assert len(tampered) == len(PDF)
    intent = _intent(alice, ws["id"])
    assert _put(intent, tampered).is_success
    seed.problem(_complete(alice, intent["upload_id"]), 422, UPLOAD_MISMATCH)
    # The mismatched object was discarded: the same intent now reports a missing object.
    seed.problem(_complete(alice, intent["upload_id"]), 409, UPLOAD_INCOMPLETE)

    # A client that claims a different digest than its intent is refused before Storage is read.
    other = _intent(alice, ws["id"])
    res = alice.call(
        "POST",
        "/documents/complete-upload",
        {"upload_id": other["upload_id"], "sha256": "f" * 64},
    )
    seed.problem(res, 422, UPLOAD_MISMATCH)

    # Not a PDF despite the declared type.
    fake = b"MZ" + b"\x00" * 30
    exe = _intent(alice, ws["id"], fake)
    assert _put(exe, fake).is_success
    seed.problem(_complete(alice, exe["upload_id"], fake), 415, UPLOAD_MISMATCH)

    assert alice.ok("GET", f"/workspaces/{ws['id']}/documents")["items"] == []


def test_m32a_completion_creates_document_revision_and_parse_job(seed: Any) -> None:
    alice = seed.client("m32a-rows")
    ws = alice.create_workspace()
    done = _upload(alice, ws["id"])

    doc = alice.ok("GET", f"/documents/{done['document_id']}")
    assert doc["status"] == "processing"
    assert doc["sha256"] == _sha(PDF)
    assert doc["size_bytes"] == len(PDF)
    assert doc["title"] == "synthetic"
    assert doc["document_type"] == "book"
    assert doc["active_revision"] is None
    assert doc["latest_revision"]["revision_number"] == 1
    assert doc["latest_revision"]["status"] == "draft"

    [(job_type, status, created_by, key, workspace_id, payload)] = _db(
        "select job_type, status, created_by::text, idempotency_key, workspace_id::text, payload "
        "from public.async_jobs where id = %s",
        done["job_id"],
    )
    assert (job_type, status, created_by, workspace_id) == (
        "document.parse",
        "queued",
        alice.user.id,
        ws["id"],
    )
    assert key.startswith("upload:")
    assert payload == {
        "document_id": done["document_id"],
        "revision_id": doc["latest_revision"]["id"],
    }
    [(event_type, actor)] = _db(
        "select event_type, actor_id::text from public.activity_events "
        "where workspace_id = %s and target_type = 'document'",
        ws["id"],
    )
    assert (event_type, actor) == ("document.uploaded", alice.user.id)


def test_m32a_storage_is_private_and_source_urls_need_membership(seed: Any) -> None:
    alice, mallory = seed.client("m32a-store"), seed.client("m32a-store-mallory")
    ws = alice.create_workspace()
    intent = _intent(alice, ws["id"])
    assert _put(intent, PDF).is_success
    # The signed upload URL is single-use for its key: it cannot overwrite the stored object.
    assert not _put(intent, PDF.replace(b"fixture", b"FIXTURE")).is_success
    done = _complete(alice, intent["upload_id"]).json()
    bucket = intent["resumable"]["metadata"]["bucketName"]
    key = intent["resumable"]["metadata"]["objectName"]
    assert key.startswith(f"workspaces/{ws['id']}/documents/{done['document_id']}/revisions/")
    assert key.endswith("/source.pdf")

    # Neither the public key nor a user's own access token reaches the object directly.
    publishable = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    for headers in (
        {"apikey": publishable},
        {"apikey": publishable, "Authorization": f"Bearer {alice.user.token}"},
    ):
        for url in (
            f"{SUPABASE_URL}/storage/v1/object/{bucket}/{key}",
            f"{SUPABASE_URL}/storage/v1/object/authenticated/{bucket}/{key}",
            f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}",
        ):
            res = httpx.get(url, headers=headers, timeout=10)
            assert not res.is_success, f"{url}: HTTP {res.status_code}"
            assert PDF not in res.content

    signed = alice.ok("GET", f"/documents/{done['document_id']}/source-url")
    assert signed["expires_at"]
    fetched = httpx.get(signed["url"], timeout=10)
    assert fetched.status_code == 200
    assert fetched.content == PDF
    seed.problem(mallory.call("GET", f"/documents/{done['document_id']}/source-url"), 404)
    seed.problem(mallory.call("GET", f"/documents/{done['document_id']}"), 404)


def test_m32a_resumable_upload_completes_like_a_put(seed: Any) -> None:
    """DOC-01-AC04: the TUS path of the same intent (offset-based resume) is accepted."""
    alice = seed.client("m32a-tus")
    ws = alice.create_workspace()
    intent = _intent(alice, ws["id"])
    tus = intent["resumable"]
    metadata = ",".join(
        f"{k} {base64.b64encode(v.encode()).decode()}" for k, v in tus["metadata"].items()
    )
    base = {"Tus-Resumable": "1.0.0", **tus["headers"]}
    created = httpx.post(
        tus["endpoint"],
        headers={**base, "Upload-Length": str(len(PDF)), "Upload-Metadata": metadata},
        timeout=30,
    )
    assert created.status_code == 201, f"TUS create: HTTP {created.status_code}"
    location = created.headers["location"]
    half = len(PDF) // 2
    chunk = {**base, "Content-Type": "application/offset+octet-stream"}
    first = httpx.patch(location, headers={**chunk, "Upload-Offset": "0"}, content=PDF[:half])
    assert first.status_code == 204
    # "Resume": ask the server where it stopped, then send the rest.
    offset = httpx.head(location, headers=base, timeout=10).headers["upload-offset"]
    assert int(offset) == half
    rest = httpx.patch(location, headers={**chunk, "Upload-Offset": offset}, content=PDF[half:])
    assert rest.status_code == 204

    res = _complete(alice, intent["upload_id"])
    assert res.status_code == 202
    again = _complete(alice, intent["upload_id"])
    assert again.json() == res.json()


def test_m32a_soft_deleted_documents_disappear(seed: Any) -> None:
    owner, viewer = seed.client("m32a-del"), seed.client("m32a-del-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    doc = _upload(owner, ws["id"])["document_id"]

    seed.problem(viewer.call("DELETE", f"/documents/{doc}"), 403, seed.INSUFFICIENT_ROLE)
    assert owner.call("DELETE", f"/documents/{doc}").status_code == 204
    for method, path in (
        ("GET", f"/documents/{doc}"),
        ("GET", f"/documents/{doc}/source-url"),
        ("DELETE", f"/documents/{doc}"),
    ):
        problem = seed.problem(owner.call(method, path), 404)
        assert problem["detail"] == "Document not found."
    assert owner.ok("GET", f"/workspaces/{ws['id']}/documents")["items"] == []
    [(event_type,)] = _db(
        "select event_type from public.activity_events "
        "where target_id = %s and event_type = 'document.deleted'",
        doc,
    )
    assert event_type == "document.deleted"
