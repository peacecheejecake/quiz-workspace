"""HISTORY-01 server guarantees (architecture.md §5-§6, questions.md §2/§4, auth.md §4).

The activity feed names actor, time, target and revision for document corrections and question
changes without carrying raw book or question text; the workspace job list exposes a failed
reindex with its cause and whether it can be retried, and a retry is a new job; attempts and
personal study-state events are visible to their own user only; every list is scoped to members
of the workspace. Shapes are assumptions H1-H4 in tests/e2e/fixtures/history.ts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

pytestmark = [pytest.mark.infra]

RANDOM_ID = "00000000-0000-4000-8000-000000000000"
INDEX_FAILURE_MARKER = "E2E-FAIL-INDEXING"
CHLORINE = "염소와 같은 소독제"


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def page_of(client: Any, path: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", path)
    return out


def items(client: Any, path: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = page_of(client, path)["items"]
    return found


def ready_book(client: Any, workspace_id: str) -> tuple[str, str]:
    """(document id, upload job id) of book-ko.pdf after its parse job succeeded."""
    _upload, _sha, done = client.upload_book(workspace_id)
    client.wait_for_job(str(done["job_id"]))
    return str(done["document_id"]), str(done["job_id"])


def correct(client: Any, document_id: str, text: str) -> dict[str, Any]:
    """Corrects the page-4 chlorine block; returns the BlockDetail (with the draft revision)."""
    blocks = page_of(client, f"/documents/{document_id}/blocks?revision=latest&page=4&limit=200")
    [block] = [b for b in blocks["items"] if CHLORINE in b["text"]]
    out: dict[str, Any] = client.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{block['block_id']}",
        {"text": text, "base_version": block["version"]},
    )
    return out


def publish(client: Any, document_id: str) -> str:
    return str(client.ok("POST", f"/documents/{document_id}/publish", {}, (202,))["job_id"])


def denied_like_unknown(seed: Any, outsider: Any, path: str, workspace_id: str) -> None:
    foreign: httpx.Response = outsider.call("GET", path)
    unknown: httpx.Response = outsider.call("GET", path.replace(workspace_id, RANDOM_ID))
    assert seed.problem(foreign, 404) == seed.problem(unknown, 404), path


def test_history_01_ac01_activities_name_actor_time_target_and_revision(seed: Any) -> None:
    started = datetime.now(UTC) - timedelta(minutes=1)
    owner = seed.client("history01-ac01")
    ws = owner.create_workspace()
    document_id, _job = ready_book(owner, ws["id"])
    token = f"교정표지{uuid.uuid4().hex[:8]}"
    corrected = correct(owner, document_id, f"마지막으로 {token} 처리를 한다.")
    question = owner.create_question(ws["id"], seed.mcq("history 원본", ["가", "나"], 0))
    new_stem = f"history 수정 {uuid.uuid4().hex[:8]}"
    edited = owner.ok(
        "PATCH",
        f"/questions/{question['id']}",
        {"base_revision_id": question["revision"]["id"], "stem": new_stem},
    )
    assert edited["revision"]["version"] == 2

    res = owner.call("GET", f"/workspaces/{ws['id']}/activities?limit=100")
    body = owner.ok_response(res, "GET", "activities", (200,))
    feed: list[dict[str, Any]] = body["items"]
    stamps = [_parse(a["created_at"]) for a in feed]
    assert stamps == sorted(stamps, reverse=True), "newest first"
    for a in feed:
        assert started <= _parse(a["created_at"]) <= datetime.now(UTC) + timedelta(minutes=1)

    def one(event_type: str, target_id: str) -> dict[str, Any]:
        found = [a for a in feed if a["event_type"] == event_type and a["target_id"] == target_id]
        assert len(found) == 1, f"{event_type}: {len(found)} events"
        return found[0]

    fix = one("document.block_corrected", document_id)
    assert fix["target_type"] == "document"
    assert fix["target_label"], "the document is named"
    assert fix["actor"]["id"] == owner.user.id
    assert fix["revision"] == {
        "id": corrected["revision"]["id"],
        "number": corrected["revision"]["revision_number"],
    }
    change = one("question.updated", question["id"])
    assert change["target_type"] == "question"
    assert change["actor"]["id"] == owner.user.id
    assert change["revision"] == {"id": edited["revision"]["id"], "number": 2}
    assert one("question.created", question["id"])["revision"]["number"] == 1

    # Ids, labels and revisions only: no corrected book text, no question text.
    assert token not in res.text
    assert new_stem not in res.text

    # Keyset pages walk the same feed.
    first = page_of(owner, f"/workspaces/{ws['id']}/activities?limit=1")
    assert len(first["items"]) == 1
    assert first["next_cursor"]
    second = page_of(
        owner, f"/workspaces/{ws['id']}/activities?limit=1&cursor={first['next_cursor']}"
    )
    assert [a["id"] for a in first["items"] + second["items"]] == [a["id"] for a in feed[:2]]

    outsider = seed.client("history01-ac01-outsider")
    denied_like_unknown(seed, outsider, f"/workspaces/{ws['id']}/activities", ws["id"])


def test_history_01_ac02_failed_reindex_job_lists_cause_and_retryability(seed: Any) -> None:
    owner = seed.client("history01-ac02")
    ws = owner.create_workspace()
    document_id, upload_job = ready_book(owner, ws["id"])
    correct(owner, document_id, f"{INDEX_FAILURE_MARKER} 교정")
    failed_id = publish(owner, document_id)
    owner.wait_for_job(failed_id, "failed")

    res = owner.call("GET", f"/workspaces/{ws['id']}/jobs?limit=100")
    jobs = owner.ok_response(res, "GET", "jobs", (200,))["items"]
    by_id = {j["id"]: j for j in jobs}
    assert by_id[failed_id]["status"] == "failed"
    assert by_id[failed_id]["job_type"] == "document.parse"
    assert by_id[failed_id]["error_code"] == "indexing_failed"
    assert by_id[failed_id]["retryable"] is True
    assert by_id[failed_id]["target_type"] == "document"
    assert by_id[failed_id]["target_id"] == document_id
    assert by_id[upload_job]["status"] == "succeeded"
    assert by_id[upload_job]["retryable"] is False
    stamps = [_parse(j["created_at"]) for j in jobs]
    assert stamps == sorted(stamps, reverse=True), "newest first"

    # The retry action is a new job; the failed one stays as it was.
    retried = publish(owner, document_id)
    assert retried != failed_id
    owner.wait_for_job(retried, "failed")
    after = {j["id"]: j for j in items(owner, f"/workspaces/{ws['id']}/jobs?limit=100")}
    assert after[retried]["target_id"] == document_id
    assert after[failed_id]["status"] == "failed"
    assert after[failed_id]["error_code"] == "indexing_failed"

    outsider = seed.client("history01-ac02-outsider")
    denied_like_unknown(seed, outsider, f"/workspaces/{ws['id']}/jobs", ws["id"])


def test_history_01_ac03_attempts_and_study_state_history_are_private(seed: Any) -> None:
    owner = seed.client("history01-ac03-owner")
    viewer = seed.client("history01-ac03-viewer")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq("history 풀이", ["가", "나"], 0))
    seed.membership(ws["id"], viewer.user, "viewer")

    def answer(client: Any, option: str) -> str:
        session = client.ok("POST", f"/questions/{q['id']}/practice-sessions", {}, (201,))
        out = client.ok(
            "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": [option]}
        )
        return str(out["attempt_id"])

    owner_attempt = answer(owner, "opt-2")
    viewer_attempt = answer(viewer, "opt-1")
    viewer.ok("PATCH", f"/questions/{q['id']}/my-state", {"is_favorite": True})
    owner.ok("PATCH", f"/questions/{q['id']}/my-state", {"needs_retry": True})

    path = f"/workspaces/{ws['id']}/attempts?limit=100"
    res = viewer.call("GET", path)
    mine = viewer.ok_response(res, "GET", "attempts", (200,))["items"]
    assert [a["id"] for a in mine] == [viewer_attempt]
    assert mine[0]["question_id"] == q["id"]
    assert mine[0]["result"] == "correct"
    assert owner_attempt not in res.text
    assert [a["id"] for a in items(owner, path)] == [owner_attempt]

    probe = viewer.call("GET", f"{path}&user_id={owner.user.id}")
    if probe.status_code == 200:
        assert owner_attempt not in probe.text
    else:
        assert probe.status_code in {400, 403, 422}

    # Shared events are visible to every member; study-state events only to their actor.
    def study(client: Any) -> list[str]:
        feed = items(client, f"/workspaces/{ws['id']}/activities?limit=100")
        assert any(a["event_type"] == "question.created" for a in feed)
        return [a["actor"]["id"] for a in feed if a["event_type"] == "question.study_state_changed"]

    assert study(viewer) == [viewer.user.id]
    assert study(owner) == [owner.user.id]

    outsider = seed.client("history01-ac03-outsider")
    denied_like_unknown(seed, outsider, f"/workspaces/{ws['id']}/attempts", ws["id"])
