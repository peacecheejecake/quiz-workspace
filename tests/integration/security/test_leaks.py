"""S4 leak checks: credentials, share secrets, signed Storage URLs, passwords and book text never
reach logs, job rows, activity metadata, stored idempotent responses or fork records.

One test drives a realistic session through the in-process production app and the in-process
worker (upload → parse → publish, signed read URL, practice, share link with an idempotency key,
guest exchange and shared reads incl. the PDF proxy, a completed fork, rotate, and hostile
requests that put secrets into headers and query strings) while every log record of every logger
is captured raw, i.e. before any redaction: the services must not log these values at all
(redaction is only the second line of defence, book_core.log_redaction).

Lines the *test harness* produces are excluded: TestClient's own httpx line for each request (it
plays the browser, whose URL bar is not a server log) and the direct browser-style PUT to the
signed upload URL.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import psycopg
import pytest

pytestmark = pytest.mark.infra


def _service_lines(lines: list[str]) -> list[str]:
    out = []
    for line in lines:
        if line.startswith("httpx ") and "http://testserver/" in line:
            continue  # TestClient = the browser
        if line.startswith("httpx ") and " PUT " in line and "/object/upload/sign/" in line:
            continue  # the browser's direct upload to the signed URL
        out.append(line)
    return out


def _refresh_token(seed: Any, client: Any) -> str:
    res = seed._stack.auth.post(
        "/token",
        params={"grant_type": "password"},
        json={"email": client.user.email, "password": client.user.password},
    )
    assert res.status_code == 200
    return str(res.json()["refresh_token"])


def test_secrets_and_book_text_never_reach_logs_jobs_or_metadata(
    seed: Any, logs: Any, app_client: Any
) -> None:
    owner = seed.client("s4-leak-owner")
    forker = seed.client("s4-leak-forker")
    refresh = _refresh_token(seed, owner)
    ws = owner.create_workspace("S4 leak")
    wid = str(ws["id"])

    upload_id, _, done = owner.upload_book(wid)
    owner.wait_for_job(str(done["job_id"]))
    doc = str(done["document_id"])
    blocks = owner.ok("GET", f"/documents/{doc}/blocks?limit=50")["items"]
    book_text = max((str(b["text"]) for b in blocks), key=len)
    assert len(book_text) >= 30, "need a distinctive passage of the book"
    signed = str(owner.ok("GET", f"/documents/{doc}/source-url")["url"])
    signed_token = signed.split("token=", 1)[1] if "token=" in signed else signed

    question = owner.create_question(wid, "S4 leak 문제", answer=1)
    session = owner.ok("POST", f"/questions/{question['id']}/practice-sessions", None, (200, 201))
    owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": ["opt-2"]},
        (200, 201),
    )

    key = str(uuid.uuid4())
    created = owner._http.post(
        f"/api/v1/workspaces/{wid}/share-links",
        json={"allow_fork": True},
        headers={"Authorization": f"Bearer {owner.user.token}", "Idempotency-Key": key},
    )
    assert created.status_code == 201
    link = created.json()
    secret = str(link["secret"])
    guest = seed.guest()
    exchanged = guest.exchange(link["id"], secret)
    cookie_value = str(seed.share_cookie_of(exchanged).value)
    cookie = f"{seed.SHARE_COOKIE}={cookie_value}"
    for path in ("", "/questions", f"/documents/{doc}", f"/documents/{doc}/pdf"):
        assert guest.read(link["id"], cookie, path).status_code == 200
    guest.send("POST", f"/shared/{link['id']}/search", {"query": book_text[:40]}, cookie=cookie)

    fork = forker.fork(link["id"], cookie, "S4 leak fork")
    assert fork.status_code == 202
    forker.wait_fork(fork.json()["id"], "COMPLETED")

    # Hostile and careless requests: secrets in headers, query strings and bodies.
    me = owner._http
    for value in (owner.user.token, refresh, secret, cookie_value):
        me.get(f"/api/v1/me?access_token={value}&password={owner.user.password}&k={value}")
        me.get("/api/v1/me", headers={"Authorization": f"Bearer {value}x"})
        me.get(f"/api/v1/shared/{link['id']}", headers={"Cookie": f"{seed.SHARE_COOKIE}={value}"})
        me.post(
            f"/api/v1/shared/{link['id']}/sessions",
            json={"secret": value[:200]},
            headers={"Origin": seed.web_origin()},
        )
        me.cookies.clear()
    rotated = owner.rotate(wid, link["id"])
    assert rotated.status_code in (200, 201)
    new_secret = str(rotated.json()["secret"])
    digest = seed.link_row(link["id"])[1].hex()

    sensitive = {
        "owner JWT": owner.user.token,
        "forker JWT": forker.user.token,
        "refresh token": refresh,
        "password": owner.user.password,
        "share secret": secret,
        "rotated secret": new_secret,
        "share session cookie": cookie_value,
        "secret digest": digest,
        "signed read URL token": signed_token,
        "book text": book_text,
        "owner email": owner.user.email,
    }

    lines = _service_lines(logs.lines)
    assert any("quiz_api.access" in line for line in lines), "log capture is not wired"
    text = "\n".join(lines)
    leaked = [what for what, value in sensitive.items() if value in text]
    assert not leaked, f"logs contain: {leaked}"
    assert "eyJ" not in text, "a JWT-shaped value reached the logs"
    assert "token=" not in text, "a token query parameter reached the logs"

    # Rows the services persist (jobs incl. errors, activity metadata, stored idempotent
    # responses, fork records, upload intents).
    target = str(forker.ok("GET", f"/me/forks/{fork.json()['id']}")["target_workspace_id"])
    with psycopg.connect(seed.DB_ADMIN_URL) as conn:
        rows = conn.execute(
            "select 'async_jobs', concat_ws(' ', payload::text, result::text, last_error, "
            "cleanup_last_error, idempotency_key) from public.async_jobs "
            "where workspace_id = any(%(w)s::uuid[]) "
            "union all select 'activity_events', metadata::text from public.activity_events "
            "where workspace_id = any(%(w)s::uuid[]) "
            "union all select 'idempotency_keys', response_body::text from public.idempotency_keys "
            "where user_id = any(%(u)s::uuid[]) "
            "union all select 'workspace_forks', concat_ws(' ', source_snapshot_manifest::text, "
            "origin_attribution::text, last_error, name) from public.workspace_forks "
            "where forked_by = any(%(u)s::uuid[]) "
            "union all select 'documents', concat_ws(' ', last_error, source_object_key) "
            "from public.documents where workspace_id = any(%(w)s::uuid[]) "
            "union all select 'document_uploads', concat_ws(' ', object_key, filename) "
            "from public.document_uploads where id = %(up)s",
            {"w": [wid, target], "u": [owner.user.id, forker.user.id], "up": upload_id},
        ).fetchall()
    assert {r[0] for r in rows} >= {"async_jobs", "activity_events", "idempotency_keys"}
    for table, value in rows:
        stored = str(value or "")
        for what, needle in sensitive.items():
            if what == "book text" and table == "workspace_forks":
                continue  # the manifest pins ids, never text; checked below
            assert (needle in stored) is False, f"{table} stores the {what}"
        assert "eyJ" not in stored, f"{table} stores a JWT-shaped value"
        assert "token=" not in stored, f"{table} stores a signed URL"
    manifest = json.dumps([r[1] for r in rows if r[0] == "workspace_forks"])
    assert book_text not in manifest
