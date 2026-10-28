"""UX6-UPLOAD-B against the local stack: automatic PDF kinds and the `종류 변경` override.

`document_type: auto` uploads are classified by the `document.parse` job (run in-process by the
suite's JobWorker over the fixture-truth parser) before their first revision is published; a
question paper then starts its import by itself, a book does not. `PATCH /documents/{id}` is the
override: the authorization boundary (other users 404, viewers 403, archived 403, deleted 404),
the in-use refusal, idempotency, and that it never deletes runs or drafts.

Needs migration 20261028120000_document_auto_classification.sql applied.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
PDF_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "pdfs"
BOOK = PDF_DIR / "book-ko.pdf"
PAPER = PDF_DIR / "questions-ko.pdf"
NOT_READY = "urn:quiz-workspace:problem:document-not-ready"
IN_USE = "urn:quiz-workspace:problem:document-in-use"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _upload(client: Any, workspace_id: str, pdf: Path, document_type: str) -> dict[str, Any]:
    """upload-intent -> PUT -> complete-upload; returns the 202 body (the job is not run)."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": pdf.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": document_type,
        },
        (201,),
    )
    assert urlsplit(str(intent["upload_url"])).hostname in LOOPBACK
    put = httpx.put(
        str(intent["upload_url"]),
        content=data,
        headers={"content-type": "application/pdf", **intent["upload_headers"]},
        timeout=30,
    )
    assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
    done: dict[str, Any] = client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )
    return done


def _ready(client: Any, workspace_id: str, pdf: Path, document_type: str) -> dict[str, Any]:
    done = _upload(client, workspace_id, pdf, document_type)
    client.wait_for_job(str(done["job_id"]))
    doc: dict[str, Any] = client.ok("GET", f"/documents/{done['document_id']}")
    assert doc["status"] == "ready"
    return doc


def _db(sql: str, *params: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL) as conn:
        return conn.execute(sql, params).fetchall()


def _runs(document_id: str) -> list[tuple[str, str]]:
    return [
        (str(r[0]), r[1])
        for r in _db(
            "select id, started_by from public.question_import_runs "
            "where source_document_id = %s order by created_at",
            document_id,
        )
    ]


def _patch(client: Any, document_id: str, **body: Any) -> httpx.Response:
    res: httpx.Response = client.call("PATCH", f"/documents/{document_id}", body)
    return res


def test_ux6_auto_upload_is_analyzed_then_classified(seed: Any) -> None:
    alice = seed.client("ux6-auto")
    ws = alice.create_workspace()
    paper = _upload(alice, ws["id"], PAPER, "auto")
    book = _upload(alice, ws["id"], BOOK, "auto")

    # Before the parse job ran: a book that is still being analyzed.
    pending = alice.ok("GET", f"/documents/{paper['document_id']}")
    assert (pending["document_type"], pending["kind"], pending["kind_source"]) == (
        "book",
        None,
        "auto",
    )
    [(upload_type, auto)] = _db(
        "select document_type, auto_classify from public.document_uploads where document_id = %s",
        paper["document_id"],
    )
    assert (upload_type, auto) == ("book", True)

    alice.wait_for_job(str(paper["job_id"]))
    alice.wait_for_job(str(book["job_id"]))
    items = {d["id"]: d for d in alice.ok("GET", f"/workspaces/{ws['id']}/documents")["items"]}
    got_paper, got_book = items[paper["document_id"]], items[book["document_id"]]
    assert (got_paper["document_type"], got_paper["kind"], got_paper["kind_source"]) == (
        "question_paper",
        "question_paper",
        "auto",
    )
    assert got_paper["latest_import_id"] is not None
    assert _runs(paper["document_id"]) == [(got_paper["latest_import_id"], "system")]
    assert (got_book["document_type"], got_book["kind"], got_book["latest_import_id"]) == (
        "book",
        "book",
        None,
    )
    assert _runs(book["document_id"]) == []
    # The stored detection is numbers only.
    [(detection,)] = _db(
        "select detection from public.documents where id = %s", paper["document_id"]
    )
    assert detection["kind"] == "question_paper"
    assert "물" not in str(detection)


def test_ux6_explicit_uploads_keep_their_kind(seed: Any) -> None:
    alice = seed.client("ux6-explicit")
    ws = alice.create_workspace()
    # questions-ko uploaded as a book (the uploader's choice) is never reclassified.
    doc = _ready(alice, ws["id"], PAPER, "book")
    assert (doc["document_type"], doc["kind"], doc["kind_source"]) == ("book", "book", "user")
    assert _runs(doc["id"]) == []


def test_ux6_kind_change_boundary(seed: Any) -> None:
    owner = seed.client("ux6-patch")
    viewer = seed.client("ux6-patch-viewer")
    mallory = seed.client("ux6-patch-mallory")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    doc = _ready(owner, ws["id"], BOOK, "auto")

    seed.problem(_patch(mallory, doc["id"], kind="mixed"), 404)
    seed.problem(_patch(viewer, doc["id"], kind="mixed"), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(_patch(owner, doc["id"], kind="novel"), 422)
    seed.problem(_patch(owner, doc["id"], kind="mixed", document_type="book"), 422)
    processing = _upload(owner, ws["id"], PAPER, "auto")
    seed.problem(_patch(owner, processing["document_id"], kind="book"), 409, NOT_READY)
    assert owner.ok("GET", f"/documents/{doc['id']}")["kind"] == "book"

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    seed.problem(_patch(owner, doc["id"], kind="mixed"), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{ws['id']}/restore")
    assert owner.call("DELETE", f"/documents/{doc['id']}").status_code == 204
    seed.problem(_patch(owner, doc["id"], kind="mixed"), 404)


def test_ux6_kind_change_pins_the_kind_keeps_runs_and_starts_one_import(seed: Any) -> None:
    alice = seed.client("ux6-pin")
    ws = alice.create_workspace()
    paper = _ready(alice, ws["id"], PAPER, "auto")
    [(system_run, _)] = _runs(paper["id"])

    # question_paper -> mixed: a book now, pinned, the server's run kept (no second run).
    mixed = alice.ok_response(_patch(alice, paper["id"], kind="mixed"), "PATCH", "k", (200,))
    assert (mixed["document_type"], mixed["kind"], mixed["kind_source"]) == (
        "book",
        "mixed",
        "user",
    )
    assert mixed["latest_import_id"] == system_run
    # -> book: drafts and the run stay.
    book = alice.ok_response(_patch(alice, paper["id"], kind="book"), "PATCH", "k", (200,))
    assert (book["kind"], book["latest_import_id"]) == ("book", system_run)
    assert _runs(paper["id"]) == [(system_run, "system")]

    # A book without a run: mixed (extract by default) starts one user run, once.
    other = _ready(alice, ws["id"], BOOK, "auto")
    first = alice.ok_response(_patch(alice, other["id"], kind="mixed"), "PATCH", "k", (200,))
    again = alice.ok_response(_patch(alice, other["id"], kind="mixed"), "PATCH", "k", (200,))
    assert first["latest_import_id"] is not None
    assert again["latest_import_id"] == first["latest_import_id"]
    assert _runs(other["id"]) == [(first["latest_import_id"], "user")]
    # extract: false changes the kind only.
    third = _ready(alice, ws["id"], BOOK, "auto")
    quiet = alice.ok_response(
        _patch(alice, third["id"], kind="question_paper", extract=False), "PATCH", "k", (200,)
    )
    assert (quiet["kind"], quiet["latest_import_id"]) == ("question_paper", None)
    events = _db(
        "select metadata from public.activity_events "
        "where target_id = %s and event_type = 'document.kind_changed' order by created_at",
        paper["id"],
    )
    assert [e[0] for e in events] == [
        {"from": "question_paper", "to": "mixed"},
        {"from": "mixed", "to": "book"},
    ]


def test_ux6_a_book_in_use_cannot_become_a_question_paper(seed: Any) -> None:
    alice = seed.client("ux6-in-use")
    ws = alice.create_workspace()
    book = _ready(alice, ws["id"], BOOK, "book")
    [(chapter_id,)] = _db(
        "select id::text from public.chapters where document_revision_id = %s "
        "order by sort_order limit 1",
        book["active_revision_id"],
    )
    alice.create_question(
        ws["id"], seed.mcq("물의 순환 단계가 아닌 것은?", ["증발", "광합성"], chapter_id=chapter_id)
    )

    seed.problem(_patch(alice, book["id"], kind="question_paper"), 409, IN_USE)
    assert alice.ok("GET", f"/documents/{book['id']}")["kind"] == "book"
    # Staying body text is fine.
    mixed = alice.ok_response(_patch(alice, book["id"], kind="mixed"), "PATCH", "k", (200,))
    assert mixed["kind"] == "mixed"


def test_ux6_a_book_with_a_pending_registration_cannot_become_a_question_paper(
    seed: Any,
) -> None:
    """Codex P2: an auto-matched draft submitted for registration keeps its chapter only in the
    registration item (the draft's own chapter_id stays null) until the job runs."""
    alice = seed.client("ux6-pending-reg")
    ws = alice.create_workspace()
    titled = alice.upload_question_paper(ws["id"], "chapter-book.pdf", document_type="book")
    run, drafts = alice.import_paper(ws["id"])
    q4 = seed.draft_for(drafts, 4)
    assert q4["chapter"] is not None
    assert q4["chapter_choice"] == "auto"
    submitted = alice.ok_response(
        alice.register(run["id"], [{"draft_id": q4["id"], "version": q4["version"]}]),
        "POST",
        "registrations",
        (202,),
    )

    seed.problem(_patch(alice, titled, kind="question_paper"), 409, IN_USE)
    alice.wait_for_job(submitted["job_id"])
    [question] = alice.list_questions(ws["id"])
    assert question["chapter_id"] == q4["chapter"]["id"]
    # Registered under the book's chapter: still in use.
    seed.problem(_patch(alice, titled, kind="question_paper"), 409, IN_USE)
