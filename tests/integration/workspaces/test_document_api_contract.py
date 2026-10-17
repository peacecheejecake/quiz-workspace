"""DOC-01 / DOC-02 server guarantees (docs/deployment.md §2 upload flow, auth.md §4 roles).

Upload-intent validates type and size before issuing an upload URL; complete-upload re-checks
the stored object and is idempotent per upload; documents are reachable only through their real
workspace; viewers and archived workspaces cannot write. Fixtures: conftest.py.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

pytestmark = pytest.mark.infra

# RED (M3.0) until their remaining routes exist: GET /jobs/{id} (M3.2b), outline/blocks/publish
# (M3.4). The upload steps are GREEN since M3.2a; remove `red` when those Tasks land.
_RED_UNTIL_REVISIONS = pytest.mark.red


def test_doc_01_ac03_upload_intent_rejects_unsupported_type_and_oversize(seed: Any) -> None:
    alice = seed.client("doc01-ac03")
    ws = alice.create_workspace()

    valid = alice.upload_intent(ws["id"])
    assert valid.status_code in {200, 201}, seed.route_of(valid.request.url.path)
    assert valid.json()["upload_url"]

    for overrides in (
        {"filename": "notes.txt", "content_type": "text/plain"},
        {"filename": "image.png", "content_type": "image/png"},
        {"filename": "book.pdf.exe", "content_type": "application/octet-stream"},
    ):
        res = alice.upload_intent(ws["id"], **overrides)
        assert res.status_code in {415, 422}, f"{overrides}: HTTP {res.status_code}"
        assert "pdf" in res.json()["detail"].lower()
        assert "upload_url" not in res.text

    for size in (seed.MAX_UPLOAD_BYTES + 1, 0, -1):
        res = alice.upload_intent(ws["id"], size_bytes=size)
        assert res.status_code in {413, 422}, f"size {size}: HTTP {res.status_code}"
        assert res.json().get("detail") or res.json().get("errors")
        assert "upload_url" not in res.text

    assert alice.ok("GET", f"/workspaces/{ws['id']}/documents")["items"] == []


def test_doc_01_ac03_complete_upload_rechecks_the_stored_object(seed: Any) -> None:
    alice = seed.client("doc01-ac03-complete")
    ws = alice.create_workspace()
    res = alice.upload_intent(ws["id"])
    intent = alice.ok_response(res, "POST", "upload-intent", (200, 201))

    # Nothing was uploaded to the signed URL: the server must not trust the client.
    missing = alice.call(
        "POST", "/documents/complete-upload", {"upload_id": intent["upload_id"], "sha256": "0" * 64}
    )
    assert missing.status_code in {409, 422}, f"HTTP {missing.status_code}"
    assert alice.ok("GET", f"/workspaces/{ws['id']}/documents")["items"] == []


def test_doc_01_ac04_complete_upload_is_idempotent(seed: Any) -> None:
    alice = seed.client("doc01-ac04")
    ws = alice.create_workspace()
    upload_id, sha256, first = alice.upload_book(ws["id"])
    assert first["document_id"]
    assert first["job_id"]

    # A retried completion (e.g. after a dropped response) returns the same document and job.
    again = alice.call(
        "POST", "/documents/complete-upload", {"upload_id": upload_id, "sha256": sha256}
    )
    assert again.status_code in {200, 202}, f"HTTP {again.status_code}"
    assert again.json()["document_id"] == first["document_id"]
    assert again.json()["job_id"] == first["job_id"]
    docs = alice.ok("GET", f"/workspaces/{ws['id']}/documents")["items"]
    assert [d["id"] for d in docs] == [first["document_id"]]


@_RED_UNTIL_REVISIONS
def test_ws_01_ac05_foreign_documents_and_jobs_are_404(seed: Any) -> None:
    alice, mallory = seed.client("docs-alice"), seed.client("docs-mallory")
    ws = alice.create_workspace()
    _, _, done = alice.upload_book(ws["id"])
    doc, job = done["document_id"], done["job_id"]
    assert alice.ok("GET", f"/jobs/{job}")["id"] == job

    missing = seed.problem(mallory.call("GET", f"/documents/{uuid.uuid4()}/outline"), 404)
    for method, path, body in (
        ("GET", f"/documents/{doc}/outline", None),
        ("GET", f"/documents/{doc}/blocks/{uuid.uuid4()}", None),
        ("PATCH", f"/documents/{doc}/blocks/{uuid.uuid4()}", {"text": "x"}),
        ("POST", f"/documents/{doc}/publish", {}),
        ("GET", f"/jobs/{job}", None),
    ):
        res = mallory.call(method, path, body)
        problem = seed.problem(res, 404)
        assert problem["status"] == missing["status"]
        assert problem["type"] == missing["type"]
        assert "book-ko" not in res.text


@_RED_UNTIL_REVISIONS
def test_doc_02_ac05_viewer_and_archived_workspace_cannot_write_documents(seed: Any) -> None:
    owner, viewer = seed.client("doc02-ac05-owner"), seed.client("doc02-ac05-viewer")
    ws = owner.create_workspace()
    _, _, done = owner.upload_book(ws["id"])
    doc = done["document_id"]
    seed.membership(ws["id"], viewer.user, "viewer")

    # Viewers read …
    assert [d["id"] for d in viewer.ok("GET", f"/workspaces/{ws['id']}/documents")["items"]] == [
        doc
    ]
    # … but every document write is refused for the role (role is checked before the block).
    for method, path, body in (
        ("PATCH", f"/documents/{doc}/blocks/{uuid.uuid4()}", {"text": "viewer edit"}),
        ("POST", f"/documents/{doc}/publish", {}),
        (
            "POST",
            f"/workspaces/{ws['id']}/documents/upload-intent",
            {
                "filename": "a.pdf",
                "size_bytes": 1024,
                "content_type": "application/pdf",
            },
        ),
    ):
        seed.problem(viewer.call(method, path, body), 403, seed.INSUFFICIENT_ROLE)

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    for method, path, body in (
        ("PATCH", f"/documents/{doc}/blocks/{uuid.uuid4()}", {"text": "archived edit"}),
        ("POST", f"/documents/{doc}/publish", {}),
    ):
        seed.problem(owner.call(method, path, body), 403, seed.ARCHIVED)
