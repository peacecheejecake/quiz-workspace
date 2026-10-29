"""Fixtures for the DOC-03 full-text export contract tests (DOCTXT.0 RED).

Reuses the S0 sharing contract stack (tests/integration/sharing/conftest.py, which itself loads
the M3 and M4 contract conftests): the in-process production app with APP_ENV=test, per-test
local Auth users, the `quiz_api` DB role, the in-process job worker (fixture-truth parser, fake
embedder, per-module Qdrant prefix) and the guest share session. Loaded by path because conftest
modules are not importable under `--import-mode=importlib`.

Request shape assumed by DOCTXT.0 for DOCTXT (mirrors tests/e2e/fixtures/export.ts, whose header
lists every assumption; keep both in sync):
    GET /documents/{id}/text?format=md|txt[&revision=draft]
        → 200 file body; `Content-Disposition: attachment; filename*=UTF-8''<name>`
        → 404 `draft-not-found`, 409 `document-not-ready`, 403 insufficient-role (draft, viewer)

The `postgres` superuser is used for teardown (inherited) and for one documented seed: holding a
document in `processing` / `failed` (no public API keeps a document there deterministically while
a worker may be running; DOC-03-C01 is about the server-side 409).
"""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

_SHARING_CONFTEST = Path(__file__).resolve().parents[1] / "sharing" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_s0_contract_conftest_documents", _SHARING_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_s0 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _s0  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_s0)
_m3 = _s0._m3

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _s0.stack
job_worker = _s0.job_worker
app_client = _s0.app_client

DOCUMENT_NOT_READY = "urn:quiz-workspace:problem:document-not-ready"
DRAFT_NOT_FOUND = "urn:quiz-workspace:problem:draft-not-found"
INSUFFICIENT_ROLE: str = _m3.INSUFFICIENT_ROLE
DB_ADMIN_URL: str = _m3.DB_ADMIN_URL
BOOK = "book-ko"


def text_path(document_id: str, fmt: str = "md", revision: str | None = None) -> str:
    query = f"format={fmt}" + (f"&revision={revision}" if revision else "")
    return f"/documents/{document_id}/text?{query}"


def attachment_filename(res: httpx.Response) -> str | None:
    """The RFC 5987 `filename*` of an attachment Content-Disposition (decoded), else None."""
    header = res.headers.get("content-disposition", "")
    if not header.lower().startswith("attachment"):
        return None
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name.lower() == "filename*" and value.lower().startswith("utf-8''"):
            return unquote(value[len("utf-8''") :], encoding="utf-8", errors="strict")
    return None


class ExportClient(_s0.ShareClient):
    """`ShareClient` plus the export call and the document helpers DOC-03 needs."""

    def export(
        self, document_id: str, fmt: str = "md", revision: str | None = None
    ) -> httpx.Response:
        return self.call("GET", text_path(document_id, fmt, revision))

    def upload_ready_book(self, workspace_id: str, title: str | None = None) -> str:
        """book-ko through the public upload flow (optional `title`), parsed in-process."""
        pdf = (_m3.PDF_DIR / f"{BOOK}.pdf").read_bytes()
        res = self.upload_intent(workspace_id, **({"title": title} if title else {}))
        intent: dict[str, Any] = self.ok_response(res, "POST", "/upload-intent", (200, 201))
        url = str(intent["upload_url"])
        assert urlsplit(url).hostname in _m3.LOOPBACK, "upload URL must stay on the local stack"
        put = httpx.put(
            url,
            content=pdf,
            headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
            timeout=30,
        )
        assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
        done: dict[str, Any] = self.ok(
            "POST",
            "/documents/complete-upload",
            {"upload_id": intent["upload_id"], "sha256": hashlib.sha256(pdf).hexdigest()},
            (202,),
        )
        self.wait_for_job(str(done["job_id"]))
        return str(done["document_id"])

    def blocks(self, document_id: str, revision: str = "active") -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok(
            "GET", f"/documents/{document_id}/blocks?revision={revision}&limit=500"
        )["items"]
        return items

    def correct(self, document_id: str, starts_with: str, text: str) -> str:
        """Saves a correction of the block whose text starts with `starts_with` into the draft
        (DOC-02 `PATCH /documents/{id}/blocks/{blockId}`); returns the block id."""
        found = [b for b in self.blocks(document_id) if str(b["text"]).startswith(starts_with)]
        assert len(found) == 1, f"expected one block starting with {starts_with!r}"
        block_id = str(found[0]["block_id"])
        self.ok("PATCH", f"/documents/{document_id}/blocks/{block_id}", {"text": text})
        return block_id


class ExportSeed(_s0.ShareSeed):
    DOCUMENT_NOT_READY = DOCUMENT_NOT_READY
    DRAFT_NOT_FOUND = DRAFT_NOT_FOUND
    INSUFFICIENT_ROLE = INSUFFICIENT_ROLE
    attachment_filename = staticmethod(attachment_filename)
    text_path = staticmethod(text_path)

    def client(self, label: str) -> ExportClient:
        base = super().client(f"doc03-{label}")
        client = ExportClient(self._http, base.user)
        client.worker = self.worker
        return client

    def set_document_status(self, document_id: str, status: str) -> None:
        """Documented seed (module docstring): `processing` / `failed` / back to `ready`."""
        assert status in {"processing", "failed", "ready"}
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            cur = conn.execute(
                "update public.documents set status = %s where id = %s returning id",
                (status, document_id),
            )
            assert cur.fetchone() is not None, "document row not found"

    def counts(self, workspace_id: str) -> dict[str, int]:
        """Rows an export must never add: activity events and jobs of the workspace."""
        out: dict[str, int] = {}
        for table in ("activity_events", "async_jobs"):
            rows = self._admin(
                f"select count(*) from public.{table} where workspace_id = %s",  # noqa: S608
                (workspace_id,),
            )
            out[table] = int(rows[0][0])
        return out


@pytest.fixture
def seed(stack: Any, app_client: TestClient, job_worker: Any) -> Iterator[ExportSeed]:
    s = ExportSeed(stack, app_client)
    s.worker = job_worker
    try:
        yield s
    finally:
        job_worker.join()
        s.cleanup()
