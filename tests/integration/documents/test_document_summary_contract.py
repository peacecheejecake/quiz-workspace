"""DOCSUM-01 server guarantees C01-C07 (docs/screens/documents-summary.md, architecture.md §5-§6).

Summaries are content-addressed per chapter and reused across revisions of one document only
(C01); a publish or restore starts a run in the same transaction only for opted-in books with the
feature on (C02); a newer revision supersedes unfinished runs (C03); no book or summary text in
logs, job results or activities (C04); the authorization matrix, auto-refresh off and the shared
read rule (C05); limits, page validation and usage (C06); fork copies (C07). Shapes are
assumptions D1-D8 in tests/e2e/fixtures/summary.ts. Jobs run in this process (conftest.py).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

# RED (DOCSUM.0): DOCSUM-B removes `red` when the summary API, job and migration make these GREEN.
pytestmark = [pytest.mark.infra, pytest.mark.red]

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
BOOK_KO = PDF_DIR / "book-ko.pdf"
BOOK_EN = PDF_DIR / "book-en.pdf"
PAPER = PDF_DIR / "questions-ko.pdf"
TRUTH = json.loads((PDF_DIR / "book-ko.truth.json").read_text(encoding="utf-8"))
BLOCK_TEXTS = [b["text"] for b in TRUTH["blocks"] if b["type"] == "text" and len(b["text"]) > 30]
CHLORINE = "염소와 같은 소독제"  # chapter B (page 4)
FAILURE_MARKER = "E2E-FAIL-SUMMARY"
HOLD_MARKER = "E2E-HOLD-SUMMARY"
JOB_TYPE = "document.summarize"
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
P = "urn:quiz-workspace:problem:"
NOT_APPLICABLE = P + "summary-not-applicable"
NOT_READY = P + "document-not-ready"
DISABLED = P + "summary-disabled"
NOT_FAILED = P + "summary-not-failed"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
TERMINAL = {"succeeded", "failed", "cancelled"}


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser reads only where no API exposes the guarantee)
# ---------------------------------------------------------------------------------------------


def upload(
    client: Any,
    workspace_id: str,
    pdf: Path = BOOK_KO,
    filename: str | None = None,
    document_type: str = "book",
    worker: Any = None,
    drain: bool = True,
) -> str:
    """upload-intent -> PUT -> complete-upload; drains the parse job unless `drain` is False."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": filename or pdf.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": document_type,
        },
        (200, 201),
    )
    url = str(intent["upload_url"])
    assert urlsplit(url).hostname in LOOPBACK, "upload URL must stay on the local stack"
    put = httpx.put(
        url,
        content=data,
        headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
        timeout=30,
    )
    assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
    done: dict[str, Any] = client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )
    if drain:
        run_job(client, str(done["job_id"]), worker)
    return str(done["document_id"])


def run_job(client: Any, job_id: str, worker: Any = None, expected: str = "succeeded") -> None:
    """Drains the job with `worker` (default: the module's), then reads it like a client."""
    (worker or client.worker).drain(job_id)
    deadline = time.monotonic() + 120
    status = ""
    while time.monotonic() < deadline:
        status = str(client.ok("GET", f"/jobs/{job_id}")["status"])
        if status in TERMINAL:
            break
        time.sleep(0.25)
    assert status == expected, f"job ended as {status or 'timeout'}, expected {expected}"


def state(client: Any, document_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/documents/{document_id}/summary")
    return out


def post_summary(client: Any, document_id: str, key: str | None = None) -> httpx.Response:
    headers = {"Idempotency-Key": key} if key else {}
    res: httpx.Response = client.send(
        "POST", f"/documents/{document_id}/summary", {}, headers=headers
    )
    return res


def enable(client: Any, document_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok_response(
        post_summary(client, document_id), "POST", "summary", (202,)
    )
    return out


def finish(
    client: Any, document_id: str, expected: str = "succeeded", worker: Any = None
) -> dict[str, Any]:
    """Drains the current revision's run (D1 `run.job_id`) and returns the state after it."""
    run = state(client, document_id)["run"]
    assert run is not None, "the current revision has no summary run"
    (worker or client.worker).drain(str(run["job_id"]))
    after = state(client, document_id)
    assert after["run"]["id"] == run["id"]
    assert after["run"]["status"] == expected, after["run"]
    return after


def summarized(client: Any, workspace_id: str, **upload_args: Any) -> str:
    document_id = upload(client, workspace_id, **upload_args)
    enable(client, document_id)
    finish(client, document_id)
    return document_id


def correct(client: Any, document_id: str, page: int, contains: str, text: str) -> None:
    blocks = client.ok(
        "GET", f"/documents/{document_id}/blocks?revision=latest&page={page}&limit=200"
    )
    [block] = [b for b in blocks["items"] if contains in b["text"]]
    client.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{block['block_id']}",
        {"text": text, "base_version": block["version"]},
    )


def publish(client: Any, document_id: str, worker: Any = None) -> str:
    """Publishes the draft and drains its parse job; returns the new active revision id."""
    job_id = str(client.ok("POST", f"/documents/{document_id}/publish", {}, (202,))["job_id"])
    run_job(client, job_id, worker)
    return active_revision(client, document_id)


def active_revision(client: Any, document_id: str) -> str:
    return str(client.ok("GET", f"/documents/{document_id}")["active_revision_id"])


def correct_b_and_publish(client: Any, document_id: str, lead: str, worker: Any = None) -> str:
    correct(client, document_id, 4, CHLORINE, f"{lead} 마지막으로 {CHLORINE}를 넣는다.")
    return publish(client, document_id, worker)


def runs(db: Any, document_id: str) -> list[dict[str, Any]]:
    rows = db(
        "select id::text, document_revision_id::text, status, trigger, job_id::text, usage, "
        "error_code from public.document_summary_runs where document_id = %s order by created_at",
        (document_id,),
    )
    keys = ("id", "revision_id", "status", "trigger", "job_id", "usage", "error_code")
    return [dict(zip(keys, row, strict=True)) for row in rows]


def unit_count(db: Any, document_id: str) -> int:
    return int(
        db(
            "select count(*) from public.document_summary_units where document_id = %s",
            (document_id,),
        )[0][0]
    )


def usage(st: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = st["summary"]["usage"]
    return out


def texts_of(st: dict[str, Any]) -> list[str]:
    """Every generated text of a state's summary (to look for it where it must not be)."""
    s = st["summary"]
    units = [s["document"], *s["chapters"]]
    found = [u["summary_md"] for u in units] + [k["text"] for u in units for k in u["key_points"]]
    return [t for t in found if len(t) >= 8]


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


def editor_member(seed: Any, workspace_id: str, label: str, role: str) -> Any:
    client = seed.client(label)
    seed.membership(workspace_id, client.user, role)
    return client


# ---------------------------------------------------------------------------------------------
# C01 unit reuse
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c01_unchanged_chapters_and_reduce_are_reused_by_content_hash(
    seed: Any, db: Any
) -> None:
    owner = seed.client("docsum-c01")
    ws = owner.create_workspace()
    doc = upload(owner, ws["id"])
    first_revision = active_revision(owner, doc)
    enable(owner, doc)
    first = finish(owner, doc)
    assert usage(first)["generated_units"] == 3, "two chapters + the document reduce"
    assert usage(first)["reused_units"] == 0
    assert [c["title"] for c in first["summary"]["chapters"]] == ["1장 물의 순환", "2장 정수 처리"]

    second_revision = correct_b_and_publish(owner, doc, f"교정{uuid.uuid4().hex[:6]} 문장이다.")
    second = finish(owner, doc)
    assert second["run"]["trigger"] == "publish"
    assert second["summary"]["revision_id"] == second_revision
    assert (usage(second)["reused_units"], usage(second)["generated_units"]) == (1, 2)
    assert first["summary"]["chapters"][0] == second["summary"]["chapters"][0], "chapter A reused"
    assert unit_count(db, doc) == 5

    # Back to revision 1's content: every chapter hash and the reduce input are known again.
    owner.ok("POST", f"/documents/{doc}/revisions/{first_revision}/restore")
    publish(owner, doc)
    third = finish(owner, doc)
    assert usage(third)["generated_units"] == 0, "no LLM call for known content"
    assert usage(third)["reused_units"] >= 2
    assert third["summary"]["document"] == first["summary"]["document"]
    assert unit_count(db, doc) == 5

    # Same bytes in another document (same and other workspace): nothing is shared.
    twin = summarized(owner, ws["id"], filename="book-ko-twin.pdf")
    other_ws = owner.create_workspace()
    foreign = summarized(owner, other_ws["id"])
    for other in (twin, foreign):
        assert usage(state(owner, other))["generated_units"] == 3
        assert unit_count(db, other) == 3
    assert unit_count(db, doc) == 5


# ---------------------------------------------------------------------------------------------
# C02 start conditions
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c02_publish_and_restore_start_one_run_only_for_enabled_books(
    seed: Any, db: Any, worker_with: Any
) -> None:
    owner = seed.client("docsum-c02")
    ws = owner.create_workspace()
    enabled = summarized(owner, ws["id"])
    plain = upload(owner, ws["id"], BOOK_EN)
    first_revision = runs(db, enabled)[0]["revision_id"]

    # A draft save starts nothing.
    correct(owner, enabled, 4, CHLORINE, f"초안 {CHLORINE}만 저장한다.")
    assert len(runs(db, enabled)) == 1
    revision = publish(owner, enabled)
    started = [r for r in runs(db, enabled) if r["revision_id"] == revision]
    assert [(r["status"], r["trigger"]) for r in started] == [("queued", "publish")]
    jobs = owner.ok("GET", f"/workspaces/{ws['id']}/jobs?limit=100")["items"]
    assert started[0]["job_id"] in {j["id"] for j in jobs if j["job_type"] == JOB_TYPE}
    finish(owner, enabled)

    # A restore is published through the same path.
    owner.ok("POST", f"/documents/{enabled}/revisions/{first_revision}/restore")
    restored = publish(owner, enabled)
    assert [r["trigger"] for r in runs(db, enabled) if r["revision_id"] == restored] == ["publish"]
    finish(owner, enabled)

    # Never opted in: no run, no LLM call.
    correct(owner, plain, 4, "Raw water", "Raw water is corrected first. Raw water.")
    publish(owner, plain)
    assert runs(db, plain) == []

    # A book that became a question paper: no run.
    owner.ok("PATCH", f"/documents/{enabled}", {"kind": "question_paper", "extract": False})
    before = len(runs(db, enabled))
    correct_b_and_publish(owner, enabled, "문제지 교정 문장이다.")
    assert len(runs(db, enabled)) == before

    # The worker's feature switch is off: the publish transaction starts nothing.
    off = worker_with(WORKER_DOCUMENT_SUMMARY="false")
    other = summarized(owner, ws["id"], filename="book-ko-c02-off.pdf")
    correct_b_and_publish(owner, other, "꺼진 worker 교정 문장이다.", worker=off)
    assert len(runs(db, other)) == 1
    assert state(owner, other)["stale"] is True


# ---------------------------------------------------------------------------------------------
# C03 supersession
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c03_a_newer_revision_supersedes_unfinished_runs(seed: Any, db: Any) -> None:
    owner = seed.client("docsum-c03")
    ws = owner.create_workspace()
    doc = summarized(owner, ws["id"])

    second = correct_b_and_publish(owner, doc, "두번째 교정 문장이다.")
    [older] = [r for r in runs(db, doc) if r["revision_id"] == second]
    third = correct_b_and_publish(owner, doc, "세번째 교정 문장이다.")
    by_id = {r["id"]: r for r in runs(db, doc)}
    assert by_id[older["id"]]["status"] == "superseded"

    # The superseded job still gets delivered: it writes nothing.
    owner.worker.drain(older["job_id"])
    assert {r["id"]: r for r in runs(db, doc)}[older["id"]]["status"] == "superseded"
    linked = db(
        "select count(*) from public.document_summary_run_units where run_id = %s", (older["id"],)
    )
    assert linked[0][0] == 0
    final = finish(owner, doc)
    assert final["summary"]["revision_id"] == third
    assert final["stale"] is False

    # Mid-flight: revision N's run is held inside the fake (D7 barrier) while N+1 is published.
    token = uuid.uuid4().hex[:12]
    hold_dir = Path(os.environ["WORKER_SUMMARY_HOLD_DIR"])
    fourth = correct_b_and_publish(owner, doc, f"{HOLD_MARKER}-{token} 네번째 교정 문장이다.")
    [held] = [r for r in runs(db, doc) if r["revision_id"] == fourth]
    thread = threading.Thread(target=owner.worker.drain, args=(held["job_id"],), daemon=True)
    thread.start()
    deadline = time.monotonic() + 60
    while not (hold_dir / f"{token}.held").exists():
        assert time.monotonic() < deadline, "the run never reached the hold barrier"
        assert thread.is_alive(), "the summary job ended before the barrier"
        time.sleep(0.1)
    assert {r["id"]: r for r in runs(db, doc)}[held["id"]]["status"] == "running"
    fifth = correct_b_and_publish(owner, doc, "다섯번째 교정 문장이다.")
    assert {r["id"]: r for r in runs(db, doc)}[held["id"]]["status"] == "superseded"
    (hold_dir / f"{token}.release").touch()
    thread.join(120)
    assert not thread.is_alive()
    # The released run re-checks under the lock and commits nothing.
    assert {r["id"]: r for r in runs(db, doc)}[held["id"]]["status"] == "superseded"
    linked = db(
        "select count(*) from public.document_summary_run_units where run_id = %s", (held["id"],)
    )
    assert linked[0][0] == 0
    assert state(owner, doc)["summary"]["revision_id"] == third
    latest = finish(owner, doc)
    assert latest["summary"]["revision_id"] == fifth
    assert latest["stale"] is False


# ---------------------------------------------------------------------------------------------
# C04 no text in logs, job results, activities
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c04_no_book_or_summary_text_in_logs_job_results_or_activities(
    seed: Any, db: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    owner = seed.client("docsum-c04")
    ws = owner.create_workspace()
    doc = summarized(owner, ws["id"])
    done = state(owner, doc)
    token = f"유출금지{uuid.uuid4().hex[:8]}"
    correct_b_and_publish(owner, doc, f"{FAILURE_MARKER} {token} 문장이다.")
    failed = finish(owner, doc, expected="failed")
    assert failed["run"]["error_code"] == "llm_invalid_output"

    forbidden = [token, *[t[:24] for t in BLOCK_TEXTS], *[t[:24] for t in texts_of(done)]]
    for run in runs(db, doc):
        job = owner.ok("GET", f"/jobs/{run['job_id']}")
        dumped = json.dumps(job, ensure_ascii=False)
        assert not [f for f in forbidden if f in dumped], "job holds book or summary text"
        # Counts, usage and error codes only: every string in the result is a short code.
        assert all(len(s) <= 64 and "\n" not in s for s in strings(job.get("result"))), job
        row = json.dumps([run["usage"], run["error_code"]], ensure_ascii=False)
        assert not [f for f in forbidden if f in row]
    events = db(
        "select event_type, payload::text from public.activity_events "
        "where target_id = %s and event_type like 'document.summary%%'",
        (doc,),
    )
    assert {e for e, _ in events} >= {"document.summary_enabled"}
    for _, payload in events:
        assert not [f for f in forbidden if f in payload]
    log_text = caplog.text
    assert not [f for f in forbidden if f in log_text], "logs hold book or summary text"


# ---------------------------------------------------------------------------------------------
# C05 authorization matrix, auto refresh off, feature off, shared reads
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c05_roles_document_states_and_idempotency(seed: Any) -> None:
    owner = seed.client("docsum-c05-owner")
    outsider = seed.client("docsum-c05-outsider")
    ws = owner.create_workspace()
    editor = editor_member(seed, ws["id"], "docsum-c05-editor", "editor")
    viewer = editor_member(seed, ws["id"], "docsum-c05-viewer", "viewer")
    doc = upload(owner, ws["id"])
    paper = upload(owner, ws["id"], PAPER, document_type="question_paper")
    processing = upload(owner, ws["id"], BOOK_EN, drain=False)

    for member in (owner, editor, viewer):
        assert state(member, doc)["summary"] is None
    unknown = outsider.call("GET", f"/documents/{RANDOM_ID}/summary")
    assert seed.problem(outsider.call("GET", f"/documents/{doc}/summary"), 404) == seed.problem(
        unknown, 404
    )

    seed.problem(post_summary(viewer, doc), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(post_summary(outsider, doc), 404)
    seed.problem(post_summary(owner, paper), 409, NOT_APPLICABLE)
    seed.problem(post_summary(owner, processing), 409, NOT_READY)
    seed.problem(post_summary(owner, RANDOM_ID), 404)

    key = str(uuid.uuid4())
    first = editor.ok_response(post_summary(editor, doc, key), "POST", "summary", (202,))
    again = editor.ok_response(post_summary(editor, doc, key), "POST", "summary", (200, 202))
    assert first["run"]["id"] == again["run"]["id"], "same Idempotency-Key, same run"
    assert first["enabled"] is True
    retry = editor.call("POST", f"/documents/{doc}/summary/retry", {})
    seed.problem(retry, 409, NOT_FAILED)
    finish(editor, doc)
    # Already summarized at the current revision: enabling again starts no run.
    again = owner.ok_response(post_summary(owner, doc), "POST", "summary", (200,))
    assert again["run"]["id"] == first["run"]["id"]

    seed.problem(
        viewer.call("POST", f"/documents/{doc}/summary/retry", {}), 403, seed.INSUFFICIENT_ROLE
    )
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert state(viewer, doc)["summary"] is not None, "archived: still readable"
    seed.problem(post_summary(owner, doc), 403, seed.ARCHIVED)
    seed.problem(owner.call("POST", f"/documents/{doc}/summary/retry", {}), 403, seed.ARCHIVED)
    seed.problem(owner.call("DELETE", f"/documents/{doc}/summary/auto"), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{ws['id']}/restore")

    assert owner.call("DELETE", f"/documents/{doc}").status_code == 204
    seed.problem(owner.call("GET", f"/documents/{doc}/summary"), 404)
    seed.problem(post_summary(owner, doc), 404)


def test_docsum_01_c05_retry_only_after_a_failed_run_of_the_current_revision(seed: Any) -> None:
    owner = seed.client("docsum-c05-retry")
    ws = owner.create_workspace()
    doc = summarized(owner, ws["id"])
    revision = correct_b_and_publish(owner, doc, f"{FAILURE_MARKER} 재시도 문장이다.")
    failed = finish(owner, doc, expected="failed")
    retried = owner.ok("POST", f"/documents/{doc}/summary/retry", {}, (202,))
    assert retried["run"]["id"] != failed["run"]["id"]
    assert (retried["run"]["revision_id"], retried["run"]["trigger"]) == (revision, "retry")
    again = finish(owner, doc, expected="failed")
    assert again["summary"]["revision_id"] != revision, "the previous summary stays"
    assert again["stale"] is True


def test_docsum_01_c05_auto_refresh_off_is_idempotent_and_stops_publish_runs(
    seed: Any, db: Any
) -> None:
    owner = seed.client("docsum-c05-auto")
    outsider = seed.client("docsum-c05-auto-out")
    ws = owner.create_workspace()
    viewer = editor_member(seed, ws["id"], "docsum-c05-auto-viewer", "viewer")
    editor = editor_member(seed, ws["id"], "docsum-c05-auto-editor", "editor")
    doc = summarized(owner, ws["id"])
    first_revision = active_revision(owner, doc)

    seed.problem(
        viewer.call("DELETE", f"/documents/{doc}/summary/auto"), 403, seed.INSUFFICIENT_ROLE
    )
    seed.problem(outsider.call("DELETE", f"/documents/{doc}/summary/auto"), 404)
    assert editor.call("DELETE", f"/documents/{doc}/summary/auto").status_code == 204
    assert editor.call("DELETE", f"/documents/{doc}/summary/auto").status_code == 204
    assert state(owner, doc)["enabled"] is False
    events = db(
        "select count(*) from public.activity_events where target_id = %s "
        "and event_type = 'document.summary_auto_disabled'",
        (doc,),
    )
    assert events[0][0] == 1, "recorded only when it actually changes"

    correct_b_and_publish(owner, doc, "꺼진 뒤 교정 문장이다.")
    owner.ok("POST", f"/documents/{doc}/revisions/{first_revision}/restore")
    publish(owner, doc)
    assert len(runs(db, doc)) == 1, "neither publish nor restore starts a run"
    st = state(owner, doc)
    assert (st["run"], st["stale"]) == (None, True)

    # Turning it back on summarizes the current revision (or just enables when it has one).
    correct_b_and_publish(owner, doc, "다시 켜기 전 교정 문장이다.")
    on = owner.ok_response(post_summary(owner, doc), "POST", "summary", (202,))
    assert on["enabled"] is True
    assert usage(finish(owner, doc))["reused_units"] >= 1


def test_docsum_01_c05_feature_off_refuses_create_but_serves_stored_summaries(
    seed: Any, off_app: Any
) -> None:
    owner = seed.client("docsum-c05-off")
    ws = owner.create_workspace()
    with_summary = summarized(owner, ws["id"])
    without = upload(owner, ws["id"], BOOK_EN)
    off_owner = type(owner)(off_app, owner.user)
    assert off_owner.ok("GET", f"/documents/{without}/summary")["available"] is False
    seed.problem(post_summary(off_owner, without), 409, DISABLED)
    stored = off_owner.ok("GET", f"/documents/{with_summary}/summary")
    assert stored["available"] is False
    assert stored["summary"] is not None
    assert state(owner, without)["available"] is True


def test_docsum_01_c05_shared_api_serves_only_the_current_succeeded_summary(seed: Any) -> None:
    owner = seed.client("docsum-c05-share")
    ws = owner.create_workspace()
    doc = summarized(owner, ws["id"])
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    res = guest.read(link["id"], cookie, f"/documents/{doc}/summary")
    seed.assert_status(res, 200, "shared summary")
    seed.assert_privacy_headers(res, "shared summary")
    body = res.json()
    for key in ("run", "run_id", "usage", "enabled", "available", "stale"):
        assert key not in body, key
    assert "cost_usd" not in res.text
    assert body["revision_id"] == active_revision(owner, doc)

    # A newer revision without its summary yet: the previous one is not served.
    correct_b_and_publish(owner, doc, "공유 교정 문장이다.")
    unknown = guest.read(link["id"], cookie, f"/documents/{RANDOM_ID}/summary")
    pending = guest.read(link["id"], cookie, f"/documents/{doc}/summary")
    seed.assert_status(pending, 404, "summary of an older revision")
    assert seed.stable(pending) == seed.stable(unknown)
    finish(owner, doc)
    seed.assert_status(guest.read(link["id"], cookie, f"/documents/{doc}/summary"), 200, "current")

    other_ws = owner.create_workspace()
    foreign = summarized(owner, other_ws["id"])
    foreign_res = guest.read(link["id"], cookie, f"/documents/{foreign}/summary")
    assert seed.stable(foreign_res) == seed.stable(unknown)
    seed.assert_status(owner.revoke(ws["id"], link["id"]), 200, "revoke")
    seed.assert_status(guest.read(link["id"], cookie, f"/documents/{doc}/summary"), 404, "revoked")


# ---------------------------------------------------------------------------------------------
# C06 limits, page validation, usage
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c06_limits_page_ranges_and_usage(seed: Any, worker_with: Any) -> None:
    owner = seed.client("docsum-c06")
    ws = owner.create_workspace()
    doc = summarized(owner, ws["id"])
    st = state(owner, doc)
    summary = st["summary"]
    run_usage = st["run"]["usage"]
    for key in ("reused_units", "generated_units", "cost_usd"):
        assert key in run_usage, key
    for chapter in summary["chapters"]:
        assert chapter["page_from"] <= chapter["page_to"]
        for point in chapter["key_points"]:
            if point["pages"] is not None:
                assert chapter["page_from"] <= point["pages"]["from"], point
                assert point["pages"]["from"] <= point["pages"]["to"] <= chapter["page_to"], point
    for point in summary["document"]["key_points"]:
        if point["pages"] is not None:
            assert 2 <= point["pages"]["from"] <= point["pages"]["to"] <= 4, point

    # Chapters longer than WORKER_SUMMARY_CHAPTER_CHARS are split, summarized and merged.
    split = worker_with(WORKER_SUMMARY_CHAPTER_CHARS="300")
    small = upload(owner, ws["id"], filename="book-ko-c06-split.pdf")
    enable(owner, small)
    merged = finish(owner, small, worker=split)
    assert len(merged["summary"]["chapters"]) == 2
    assert all(c["summary_md"].strip() for c in merged["summary"]["chapters"])

    # A document over WORKER_SUMMARY_MAX_INPUT_CHARS fails without any LLM call.
    tiny = worker_with(WORKER_SUMMARY_MAX_INPUT_CHARS="500")
    big = upload(owner, ws["id"], filename="book-ko-c06-big.pdf")
    enable(owner, big)
    too_large = finish(owner, big, expected="failed", worker=tiny)
    assert too_large["run"]["error_code"] == "summary_too_large"
    assert (too_large["run"]["usage"] or {}).get("generated_units", 0) == 0
    assert too_large["summary"] is None


# ---------------------------------------------------------------------------------------------
# C07 fork
# ---------------------------------------------------------------------------------------------


def test_docsum_01_c07_fork_copies_the_snapshot_summary_and_the_auto_setting(
    seed: Any, db: Any
) -> None:
    owner = seed.client("docsum-c07-owner")
    recipient = seed.client("docsum-c07-recipient")
    ws = owner.create_workspace()
    kept = summarized(owner, ws["id"], filename="kept-summary.pdf")
    failing = summarized(owner, ws["id"], filename="failed-summary.pdf")
    correct_b_and_publish(owner, failing, f"{FAILURE_MARKER} 포크 실패 문장이다.")
    finish(owner, failing, expected="failed")
    off = summarized(owner, ws["id"], filename="off-summary.pdf")
    assert owner.call("DELETE", f"/documents/{off}/summary/auto").status_code == 204
    source = {d: state(owner, d) for d in (kept, failing, off)}

    link = owner.create_link(ws["id"], allow_fork=True)
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, f"docsum fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(res, 202, "fork")
    fork = recipient.wait_fork(str(res.json()["id"]), "COMPLETED")
    target = str(fork["target_workspace_id"])
    docs = recipient.ok("GET", f"/workspaces/{target}/documents")["items"]
    by_file = {str(d["filename"]): str(d["id"]) for d in docs}

    copy = state(recipient, by_file["kept-summary.pdf"])
    assert copy["enabled"] is True
    assert copy["summary"]["document"] == source[kept]["summary"]["document"]
    assert copy["summary"]["chapters"] == source[kept]["summary"]["chapters"]
    assert copy["summary"]["run_id"] != source[kept]["summary"]["run_id"]
    [copied_run] = runs(db, by_file["kept-summary.pdf"])
    assert copied_run["status"] == "succeeded"
    assert copied_run["usage"] in (None, {}), "usage is not copied"

    # The snapshot revision's run failed: nothing to copy, failed runs stay behind.
    assert state(recipient, by_file["failed-summary.pdf"])["summary"] is None
    assert runs(db, by_file["failed-summary.pdf"]) == []
    assert state(recipient, by_file["failed-summary.pdf"])["enabled"] is True
    off_copy = state(recipient, by_file["off-summary.pdf"])
    assert (off_copy["enabled"], off_copy["summary"] is not None) == (False, True)

    # The copy keeps auto refresh: its next publish re-summarizes in the fork.
    forked = by_file["kept-summary.pdf"]
    correct_b_and_publish(recipient, forked, "포크 교정 문장이다.")
    assert state(recipient, forked)["run"]["trigger"] == "publish"
    assert len(runs(db, kept)) == 1, "the source is untouched"
