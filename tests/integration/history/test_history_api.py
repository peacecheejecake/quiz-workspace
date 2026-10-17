"""HISTORY-01 read APIs (M7.1) beyond the AC contract: keyset pagination, authorization and
no-leak boundaries, and index-bounded page queries.

Runs on the history contract stack (conftest.py: in-process app, local Auth users, `quiz_api`
role, in-process JobWorker with the APP_ENV=test fake embedder). The `postgres` superuser is used
for two documented cases only: seeding an activity event whose target lives in another workspace
(no API writes one) and EXPLAIN-ing the page queries.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
import pytest
from quiz_api.repositories.history import (
    Cursor,
    activities_query,
    attempts_query,
    jobs_query,
)
from sqlalchemy import Select, create_engine
from sqlalchemy.engine import Connection

pytestmark = [pytest.mark.infra]

INDEX_FAILURE_MARKER = "E2E-FAIL-INDEXING"
CHLORINE = "염소와 같은 소독제"


def walk(client: Any, path: str, page_size: int) -> list[str]:
    """Ids of every item, following `next_cursor` page by page."""
    ids: list[str] = []
    cursor: str | None = None
    for _ in range(100):
        query = f"{path}?limit={page_size}" + (f"&cursor={cursor}" if cursor else "")
        page = client.ok("GET", query)
        assert len(page["items"]) <= page_size
        ids += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            return ids
    raise AssertionError("pagination did not end")


def all_ids(client: Any, path: str) -> list[str]:
    return [item["id"] for item in client.ok("GET", f"{path}?limit=100")["items"]]


def answer(client: Any, question_id: str, option: str) -> str:
    session = client.ok("POST", f"/questions/{question_id}/practice-sessions", {}, (201,))
    out = client.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": [option]}
    )
    return str(out["attempt_id"])


def forged_cursor(payload: Any) -> str:
    raw = json.dumps(payload).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_history_lists_walk_by_keyset_cursor_and_reject_forged_cursors(seed: Any) -> None:
    owner = seed.client("history-pages")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq("history pages", ["가", "나"], 0))
    for i in range(3):
        owner.create_question(
            ws["id"], seed.mcq(f"history pages {i}", ["가", "나"], 0, question_number=i + 2)
        )
    for _ in range(3):
        answer(owner, q["id"], "opt-1")

    for path in (
        f"/workspaces/{ws['id']}/activities",
        f"/workspaces/{ws['id']}/attempts",
        f"/workspaces/{ws['id']}/jobs",
    ):
        full = all_ids(owner, path)
        assert walk(owner, path, 1) == full, path
        assert walk(owner, path, 2) == full, path
    assert len(all_ids(owner, f"/workspaces/{ws['id']}/activities")) >= 5
    assert len(all_ids(owner, f"/workspaces/{ws['id']}/attempts")) == 3

    base = f"/workspaces/{ws['id']}/activities"
    for bad in (
        "not-a-cursor",
        forged_cursor(["2026-10-18T00:00:00", str(uuid.uuid4())]),  # naive timestamp
        forged_cursor(["2026-10-18T00:00:00+00:00", "x"]),
        forged_cursor({"at": "2026-10-18T00:00:00+00:00"}),
    ):
        seed.problem(owner.call("GET", f"{base}?cursor={bad}"), 422)
    for limit in (0, 101):
        seed.problem(owner.call("GET", f"{base}?limit={limit}"), 422)


def test_activity_labels_and_revisions_never_come_from_another_workspace(
    seed: Any, admin_db_url: str
) -> None:
    owner = seed.client("history-labels")
    mine = owner.create_workspace()
    other = owner.create_workspace(f"secret workspace {uuid.uuid4().hex[:8]}")
    stem = f"secret stem {uuid.uuid4().hex[:8]}"
    foreign = owner.create_question(other["id"], seed.mcq(stem, ["가", "나"], 0, question_number=7))

    # Direct seed: events of `mine` pointing at targets of `other` (no API writes such rows).
    with psycopg.connect(admin_db_url, autocommit=True) as conn:
        conn.execute(
            "insert into public.activity_events (workspace_id, actor_id, event_type, "
            "target_type, target_id, metadata) values "
            "(%s, %s, 'question.updated', 'question', %s, '{\"version\": 1}'), "
            "(%s, %s, 'workspace.updated', 'workspace', %s, '{}'), "
            "(%s, %s, 'document.block_corrected', 'document', %s, %s)",
            (
                mine["id"],
                owner.user.id,
                foreign["id"],
                mine["id"],
                owner.user.id,
                other["id"],
                mine["id"],
                owner.user.id,
                str(uuid.uuid4()),
                json.dumps({"revision_id": foreign["revision"]["id"]}),
            ),
        )

    res = owner.call("GET", f"/workspaces/{mine['id']}/activities?limit=100")
    feed = owner.ok_response(res, "GET", "activities", (200,))["items"]
    by_type = {a["event_type"]: a for a in feed}
    question = by_type["question.updated"]
    assert question["target_id"] == foreign["id"]
    assert question["target_label"] is None, "no label from another workspace"
    assert question["revision"] == {"id": None, "number": 1}
    assert by_type["workspace.updated"]["target_label"] is None
    assert by_type["document.block_corrected"]["target_label"] is None
    assert by_type["document.block_corrected"]["revision"] is None
    assert other["name"] not in res.text
    assert stem not in res.text
    assert foreign["revision"]["id"] not in res.text
    # The workspace's own events still carry their labels.
    created = [a for a in feed if a["event_type"] == "workspace.created"]
    assert created
    assert created[0]["target_label"] == mine["name"]

    # The other workspace's own feed is not mixed in.
    other_feed = all_ids(owner, f"/workspaces/{other['id']}/activities")
    assert not set(other_feed) & {a["id"] for a in feed}


def test_attempts_are_the_callers_own_and_refuse_a_user_id(seed: Any) -> None:
    owner = seed.client("history-attempts-owner")
    editor = seed.client("history-attempts-editor")
    ws = owner.create_workspace()
    q1 = owner.create_question(ws["id"], seed.mcq("history a1", ["가", "나"], 0, question_number=1))
    q2 = owner.create_question(ws["id"], seed.mcq("history a2", ["가", "나"], 0, question_number=2))
    seed.membership(ws["id"], editor.user, "editor")

    mine = [answer(owner, q1["id"], "opt-1"), answer(owner, q2["id"], "opt-2")]
    theirs = answer(editor, q1["id"], "opt-1")

    path = f"/workspaces/{ws['id']}/attempts"
    listed = owner.ok("GET", f"{path}?limit=100")["items"]
    assert [a["id"] for a in listed] == list(reversed(mine))
    assert [a["question_number"] for a in listed] == [2, 1]
    assert {a["question_type"] for a in listed} == {"MCQ"}
    assert [a["id"] for a in editor.ok("GET", f"{path}?limit=100")["items"]] == [theirs]

    for query in (f"user_id={editor.user.id}", f"user_id={owner.user.id}", "user_id="):
        seed.problem(owner.call("GET", f"{path}?{query}"), 422)

    # Attempts on a deleted question leave the list with it (soft-deleted = no access).
    owner.ok("DELETE", f"/questions/{q2['id']}", None, (204,))
    assert all_ids(owner, path) == [mine[0]]


@pytest.fixture
def failed_reindex(seed: Any) -> tuple[Any, dict[str, Any], str, str, str]:
    """(owner, workspace, document id, upload job id, failed reindex job id)."""
    owner = seed.client("history-retry")
    ws = owner.create_workspace()
    _upload, _sha, done = owner.upload_book(ws["id"])
    document_id, upload_job = str(done["document_id"]), str(done["job_id"])
    owner.wait_for_job(upload_job)
    blocks = owner.ok("GET", f"/documents/{document_id}/blocks?revision=latest&page=4&limit=200")
    [block] = [b for b in blocks["items"] if CHLORINE in b["text"]]
    owner.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{block['block_id']}",
        {"text": f"{INDEX_FAILURE_MARKER} 교정", "base_version": block["version"]},
    )
    failed = str(owner.ok("POST", f"/documents/{document_id}/publish", {}, (202,))["job_id"])
    owner.wait_for_job(failed, "failed")
    return owner, ws, document_id, upload_job, failed


def test_job_retry_is_offered_to_editors_of_an_active_workspace_only(
    seed: Any, failed_reindex: tuple[Any, dict[str, Any], str, str, str]
) -> None:
    owner, ws, document_id, upload_job, failed = failed_reindex
    viewer = seed.client("history-retry-viewer")
    outsider = seed.client("history-retry-outsider")
    seed.membership(ws["id"], viewer.user, "viewer")
    path = f"/workspaces/{ws['id']}/jobs?limit=100"

    def jobs(client: Any) -> dict[str, dict[str, Any]]:
        return {j["id"]: j for j in client.ok("GET", path)["items"]}

    as_owner, as_viewer = jobs(owner), jobs(viewer)
    assert as_owner[failed]["retryable"] is True
    assert as_owner[upload_job]["retryable"] is False, "a succeeded upload parse"
    assert as_owner[upload_job]["target_label"] == as_owner[failed]["target_label"]
    # Viewers see the same jobs and cause but cannot start them again.
    assert as_viewer[failed]["error_code"] == "indexing_failed"
    assert as_viewer[failed]["target_id"] == document_id
    assert as_viewer[failed]["retryable"] is False
    # Job payloads and raw results never leave the API.
    for job in as_owner.values():
        assert "payload" not in job
        assert "result" not in job

    # Archived: still readable, nothing retryable.
    owner.ok("POST", f"/workspaces/{ws['id']}/archive", {}, (200,))
    assert jobs(owner)[failed]["retryable"] is False

    # Soft-deleted: every history list answers like an unknown workspace.
    owner.ok("POST", f"/workspaces/{ws['id']}/restore", {}, (200,))
    owner.ok("DELETE", f"/workspaces/{ws['id']}", None, (200, 202, 204))
    random_ws = str(uuid.uuid4())
    for kind in ("activities", "jobs", "attempts"):
        gone = owner.call("GET", f"/workspaces/{ws['id']}/{kind}")
        unknown = owner.call("GET", f"/workspaces/{random_ws}/{kind}")
        assert seed.problem(gone, 404) == seed.problem(unknown, 404), kind
        assert seed.problem(outsider.call("GET", f"/workspaces/{ws['id']}/{kind}"), 404)


def test_document_retry_is_pinned_to_the_failed_jobs_revision(
    seed: Any, failed_reindex: tuple[Any, dict[str, Any], str, str, str]
) -> None:
    """A History retry publishes the revision the failed job indexed, never a newer draft that
    replaced it while the page was open (another editor published the fix and started again)."""
    owner, ws, document_id, _upload_job, failed = failed_reindex
    path = f"/workspaces/{ws['id']}/jobs?limit=100"
    listed = {j["id"]: j for j in owner.ok("GET", path)["items"]}[failed]
    failed_revision = listed["target_revision_id"]
    assert failed_revision
    assert listed["retryable"] is True

    # Another editor fixes the draft and publishes it, then opens a new correction draft.
    page = owner.ok("GET", f"/documents/{document_id}/blocks?revision=latest&page=4&limit=200")
    [marked] = [b for b in page["items"] if INDEX_FAILURE_MARKER in b["text"]]
    owner.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{marked['block_id']}",
        {"text": "교정 완료", "base_version": marked["version"]},
    )
    published = owner.ok(
        "POST", f"/documents/{document_id}/publish", {"revision_id": failed_revision}, (202,)
    )
    owner.wait_for_job(str(published["job_id"]))
    page = owner.ok("GET", f"/documents/{document_id}/blocks?revision=latest&page=4&limit=200")
    other = next(b for b in page["items"] if b["block_id"] != marked["block_id"])
    newer = owner.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{other['block_id']}",
        {"text": f"{other['text']} (새 교정)", "base_version": other["version"]},
    )
    assert newer["revision"]["id"] != failed_revision

    # The stale retry (what the History button sends) is refused and publishes nothing.
    jobs_before = {j["id"] for j in owner.ok("GET", path)["items"]}
    stale = owner.call(
        "POST", f"/documents/{document_id}/publish", {"revision_id": failed_revision}
    )
    seed.problem(stale, 409, "urn:quiz-workspace:problem:edit-conflict")
    assert {j["id"] for j in owner.ok("GET", path)["items"]} == jobs_before
    # A refreshed list no longer offers the retry.
    after = {j["id"]: j for j in owner.ok("GET", path)["items"]}[failed]
    assert after["retryable"] is False
    assert after["target_revision_id"] == failed_revision


# --- index-bounded page queries -------------------------------------------------------------------


def _plan_nodes(plan: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield plan
    for child in plan.get("Plans", []):
        yield from _plan_nodes(child)


def _explain(conn: Connection, stmt: Select[Any]) -> list[dict[str, Any]]:
    compiled = stmt.compile(dialect=conn.dialect)
    row = conn.exec_driver_sql(f"EXPLAIN (FORMAT JSON) {compiled.string}", compiled.params).one()
    raw = row[0]
    doc = json.loads(raw) if isinstance(raw, str) else raw
    return list(_plan_nodes(doc[0]["Plan"]))


@pytest.fixture
def explain_conn(admin_db_url: str, history_index_migration: Path) -> Iterator[Connection]:
    """A rolled-back superuser transaction that has the M7.1 indexes (created in the transaction
    when the migration is not applied yet) and prefers indexes over sequential scans, so the
    plan shows which index bounds each page query even on a small local table."""
    url = admin_db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("set local lock_timeout = '2s'")
            present = conn.exec_driver_sql(
                "select count(*) from pg_indexes where schemaname = 'public' and indexname in "
                "('async_jobs_workspace_created_id_idx', "
                "'question_attempts_workspace_user_submitted_idx')"
            ).scalar_one()
            if present != 2:
                conn.exec_driver_sql(history_index_migration.read_text(encoding="utf-8"))
            conn.exec_driver_sql("set local enable_seqscan = off")
            conn.exec_driver_sql("set local enable_bitmapscan = off")
            yield conn
            conn.rollback()
    finally:
        engine.dispose()


@pytest.mark.parametrize("with_cursor", [False, True])
def test_history_page_queries_are_served_by_their_keyset_index(
    explain_conn: Connection, with_cursor: bool
) -> None:
    ws, user = uuid.uuid4(), uuid.uuid4()
    after = Cursor(at=datetime.now(UTC), id=uuid.uuid4())
    cursor = after if with_cursor else None
    cases = {
        "activity_events_workspace_created_idx": activities_query(ws, user, limit=50, after=cursor),
        "async_jobs_workspace_created_id_idx": jobs_query(ws, limit=50, after=cursor),
        "question_attempts_workspace_user_submitted_idx": attempts_query(
            ws, user, limit=50, after=cursor
        ),
    }
    for index, stmt in cases.items():
        nodes = _explain(explain_conn, stmt)
        assert nodes[0]["Node Type"] == "Limit", index
        used = [n for n in nodes if n.get("Index Name") == index]
        assert used, f"{index} not used: {[n['Node Type'] for n in nodes]}"
        # The index order is the page order: no sort of the workspace's rows.
        assert not [n for n in nodes if "Sort" in n["Node Type"]], index
        assert "workspace_id" in used[0].get("Index Cond", ""), index
