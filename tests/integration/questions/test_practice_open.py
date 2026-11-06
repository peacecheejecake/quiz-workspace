"""UX12-OPEN: `POST /questions/{id}/practice-open` (docs/screens/ux12-question-open.md).

One transaction confirms the latest result and reuses or opens a session, so the panel no longer
needs two requests. Fixtures come from conftest.py.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = [pytest.mark.infra, pytest.mark.red]

DB_ADMIN_URL = os.environ.get(
    "QUIZ_DB_ADMIN_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
RESET_PROBLEM = "urn:quiz-workspace:problem:practice-session-reset"
ANSWER_KEYS = {
    "correct_option_ids",
    "accepted_answers",
    "explanation",
    "rubric",
    "correct_answer",
    "outcome",
}


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _mcq(seed: Any, label: str) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    owner = seed.client(label)
    ws = owner.create_workspace()
    return owner, ws, owner.create_question(ws["id"], seed.mcq(_stem(label), ["a", "b", "c"], 0))


def answer_keys(value: Any) -> list[str]:
    if isinstance(value, list):
        return [k for v in value for k in answer_keys(v)]
    if not isinstance(value, dict):
        return []
    return [k for k in value if k in ANSWER_KEYS] + [
        k for v in value.values() for k in answer_keys(v)
    ]


def start(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def choose(client: Any, session_id: str, option_id: str) -> str:
    out = client.ok(
        "POST", f"/practice-sessions/{session_id}/submit", {"selected_option_ids": [option_id]}
    )
    return str(out["result"])


def open_call(
    client: Any, question_id: str, body: dict[str, Any] | None = None, key: str | None = None
) -> httpx.Response:
    path = f"/questions/{question_id}/practice-open"
    if key is None:
        res: httpx.Response = client.call("POST", path, body or {})
        return res
    res = client.call_with_headers("POST", path, body or {}, {"Idempotency-Key": key})
    return res


def open_practice(
    client: Any, question_id: str, body: dict[str, Any] | None = None, key: str | None = None
) -> dict[str, Any]:
    res = open_call(client, question_id, body, key)
    assert res.status_code == 200, res.text
    out: dict[str, Any] = res.json()
    return out


def _status(client: Any, workspace_id: str, question_id: str) -> str:
    overview = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    [item] = [i for i in overview["items"] if i["question_id"] == question_id]
    return str(item["status"])


def test_ux12_open_ac04_fresh_open_records_the_view_in_authored_order(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-fresh")
    opened = open_practice(owner, q["id"])
    session = opened["session"]
    assert opened["reused"] is False
    assert opened["result"] is None
    assert opened["reset_epoch"] == 0
    assert opened["active_revision_id"] == q["revision"]["id"]
    assert opened["latest_attempt_id"] is None
    assert opened["previous_revision"] is False
    assert session["state"] == "open"
    assert session["displayed_option_ids"] == [o["id"] for o in q["revision"]["options"]]
    assert _status(owner, ws["id"], q["id"]) == "viewed"


def test_ux12_open_ac04_same_key_opens_one_session_and_replays(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-replay")
    key = uuid.uuid4().hex
    first = open_practice(owner, q["id"], key=key)
    res = open_call(owner, q["id"], key=key)
    assert res.status_code == 200
    assert res.headers["Idempotent-Replayed"] == "true"
    assert res.json()["session"]["id"] == first["session"]["id"]


def test_ux12_open_ac04_concurrent_requests_with_one_key_open_one_session(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-race")
    key = uuid.uuid4().hex
    barrier = threading.Barrier(4)
    out: list[httpx.Response] = []

    def call() -> None:
        barrier.wait(timeout=10)
        out.append(open_call(owner, q["id"], key=key))

    threads = [threading.Thread(target=call) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert [r.status_code for r in out] == [200] * 4
    assert len({r.json()["session"]["id"] for r in out}) == 1


def test_ux12_open_ac04_a_replayed_key_never_revives_a_submitted_session(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-replay-submitted")
    key = uuid.uuid4().hex
    first = open_practice(owner, q["id"], key=key)["session"]
    assert choose(owner, first["id"], "opt-1") == "correct"
    again = open_practice(owner, q["id"], key=key)
    assert again["session"] is None
    assert again["result"]["id"] == first["id"]

    forced = uuid.uuid4().hex
    second = open_practice(owner, q["id"], {"force_new": True}, key=forced)["session"]
    assert choose(owner, second["id"], "opt-2") == "incorrect"
    replayed = open_practice(owner, q["id"], {"force_new": True}, key=forced)
    assert replayed["session"] is None
    assert replayed["result"]["id"] == second["id"]


def test_ux12_open_ac04_another_body_with_one_key_is_rejected(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-key-reused")
    key = uuid.uuid4().hex
    open_practice(owner, q["id"], key=key)
    res = open_call(owner, q["id"], {"force_new": True}, key)
    assert res.status_code == 409
    assert res.json()["type"] == "urn:quiz-workspace:problem:idempotency-key-reused"


def test_ux12_open_ac04_reuses_only_a_current_open_session(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-reuse")
    first = open_practice(owner, q["id"])["session"]
    reused = open_practice(owner, q["id"], {"cached_session_id": first["id"]})
    assert reused["reused"] is True
    assert reused["session"]["id"] == first["id"]

    # An attempt made elsewhere: the baseline no longer matches, its result wins.
    other = start(owner, q["id"])
    assert choose(owner, other["id"], "opt-1") == "correct"
    stale = open_practice(owner, q["id"], {"cached_session_id": first["id"]})
    assert stale["reused"] is False
    assert stale["session"] is None
    assert stale["result"]["id"] == other["id"]

    # The baseline the client recorded when it opened the session still matches.
    fresh = open_practice(owner, q["id"], {"force_new": True})
    current = fresh["latest_attempt_id"]
    assert current is not None
    matched = open_practice(
        owner,
        q["id"],
        {"cached_session_id": fresh["session"]["id"], "baseline_attempt_id": current},
    )
    assert matched["reused"] is True


def test_ux12_open_ac04_a_submitted_cached_session_shows_its_result(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-cached-submitted")
    first = open_practice(owner, q["id"])["session"]
    assert choose(owner, first["id"], "opt-2") == "incorrect"
    out = open_practice(owner, q["id"], {"cached_session_id": first["id"]})
    assert out["reused"] is False
    assert out["session"] is None
    assert out["result"]["outcome"]["result"] == "incorrect"
    assert out["submitted_answer"] == {"selected_option_ids": ["opt-2"]}


def test_ux12_open_ac04_a_new_revision_is_not_reused(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-revision")
    first = open_practice(owner, q["id"])["session"]
    assert choose(owner, first["id"], "opt-1") == "correct"
    cached = open_practice(owner, q["id"], {"force_new": True})
    body = seed.mcq(_stem("새 문제"), ["a", "b", "c"], 0)
    owner.ok("PATCH", f"/questions/{q['id']}", {**body, "base_revision_id": q["revision"]["id"]})
    out = open_practice(
        owner,
        q["id"],
        {
            "cached_session_id": cached["session"]["id"],
            "baseline_attempt_id": cached["latest_attempt_id"],
        },
    )
    assert out["reused"] is False
    assert out["session"]["id"] != cached["session"]["id"]
    assert out["session"]["question_revision_id"] != q["revision"]["id"]
    assert out["previous_revision"] is True
    assert out["result"] is None


def test_ux12_open_ac04_a_run_session_is_not_reused(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-run")
    run = owner.ok(
        "POST",
        f"/workspaces/{ws['id']}/practice-runs",
        {"source": "bank", "range": {"all": True}, "random_order": False},
        (201,),
    )
    session = owner.ok(
        "POST",
        f"/questions/{q['id']}/practice-sessions",
        {"practice_run_id": run["id"], "run_position": 1},
        (201,),
    )
    out = open_practice(owner, q["id"], {"cached_session_id": session["id"]})
    assert out["reused"] is False
    assert out["session"]["id"] != session["id"]


def test_ux12_open_ac04_a_session_of_another_question_is_not_reused(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-other-question")
    other = owner.create_question(ws["id"], seed.mcq(_stem("다른 문제"), ["a", "b"], 0))
    first = open_practice(owner, other["id"])["session"]
    out = open_practice(owner, q["id"], {"cached_session_id": first["id"]})
    assert out["reused"] is False
    assert out["session"]["question_id"] == q["id"]


def test_ux12_open_ac04_cached_id_and_force_new_exclude_each_other(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-exclusive")
    res = open_call(owner, q["id"], {"cached_session_id": str(uuid.uuid4()), "force_new": True})
    assert res.status_code == 422


def test_ux12_open_ac05_unsubmitted_payloads_hold_no_answers(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-answers")
    opened = open_practice(owner, q["id"])
    assert answer_keys(opened) == []
    reused = open_practice(owner, q["id"], {"cached_session_id": opened["session"]["id"]})
    assert answer_keys(reused) == []
    replay_key = uuid.uuid4().hex
    forced = open_practice(owner, q["id"], {"force_new": True}, key=replay_key)
    assert answer_keys(forced) == []
    assert answer_keys(open_practice(owner, q["id"], {"force_new": True}, key=replay_key)) == []


def test_ux12_open_ac05_force_new_hides_the_previous_result(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-force")
    first = open_practice(owner, q["id"])["session"]
    assert choose(owner, first["id"], "opt-1") == "correct"
    forced = open_practice(owner, q["id"], {"force_new": True})
    assert forced["session"]["id"] != first["id"]
    assert forced["result"] is None
    assert forced["submitted_answer"] is None
    assert answer_keys(forced) == []


def test_ux12_open_ac05_the_schema_keeps_answers_out_of_the_session_field(
    seed: Any, app_client: Any
) -> None:
    spec = app_client.get("/api/v1/openapi.json").json()
    field = spec["components"]["schemas"]["PracticeOpened"]["properties"]["session"]
    refs = [option.get("$ref", "") for option in field["anyOf"]]
    assert "#/components/schemas/PracticeSession" in refs
    session = spec["components"]["schemas"]["PracticeSession"]["properties"]
    assert "outcome" not in session


def test_ux12_open_ac05_foreign_sessions_and_workspaces_are_denied(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-owner")
    member = seed.client("ux12-open-member")
    seed.membership(ws["id"], member.user, "viewer")
    stranger = seed.client("ux12-open-stranger")
    mine = open_practice(owner, q["id"])["session"]

    theirs = open_practice(member, q["id"], {"cached_session_id": mine["id"]})
    assert theirs["reused"] is False
    assert theirs["session"]["id"] != mine["id"]

    denied = open_call(stranger, q["id"])
    assert denied.status_code == 404
    assert denied.json().get("session") is None
    unknown = open_call(owner, str(uuid.uuid4()))
    assert unknown.status_code == 404
    assert unknown.json().get("detail") == denied.json().get("detail")


def test_ux12_open_ac05_archived_workspace_is_read_only(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-archived")
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    res = open_call(owner, q["id"])
    assert res.status_code == 403
    assert res.json()["type"] == "urn:quiz-workspace:problem:workspace-archived"


def test_ux12_open_ac06_reset_drops_the_cached_session(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-reset")
    first = open_practice(owner, q["id"])["session"]
    owner.ok("POST", f"/questions/{q['id']}/practice-reset")
    assert _status(owner, ws["id"], q["id"]) == "unseen"
    out = open_practice(owner, q["id"], {"cached_session_id": first["id"]})
    assert out["reused"] is False
    assert out["reset_epoch"] == 1
    assert out["session"]["id"] != first["id"]
    stale = owner.call(
        "POST", f"/practice-sessions/{first['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    assert stale.status_code == 409
    assert stale.json()["type"] == RESET_PROBLEM
    assert choose(owner, out["session"]["id"], "opt-1") == "correct"


def test_ux12_open_ac06_a_replayed_key_after_reset_is_refused(seed: Any) -> None:
    owner, _, q = _mcq(seed, "ux12-open-reset-replay")
    key = uuid.uuid4().hex
    open_practice(owner, q["id"], key=key)
    owner.ok("POST", f"/questions/{q['id']}/practice-reset")
    res = open_call(owner, q["id"], key=key)
    assert res.status_code == 409
    assert res.json()["type"] == RESET_PROBLEM


def test_ux12_open_ac06_an_open_queued_behind_a_reset_cannot_undo_it(seed: Any) -> None:
    owner, ws, q = _mcq(seed, "ux12-open-queued")
    lock_text = f"practice-reset:{owner.user.id}:{q['id']}"
    responses: dict[str, httpx.Response] = {}
    failures: list[BaseException] = []

    def call(name: str, path: str) -> None:
        try:
            responses[name] = owner.call("POST", path, {})
        except BaseException as exc:
            failures.append(exc)

    with psycopg.connect(DB_ADMIN_URL) as conn:
        (lock_id,) = conn.execute("select hashtextextended(%s, 0)", (lock_text,)).fetchone()
        conn.execute("select pg_advisory_xact_lock(%s)", (lock_id,))
        high, low = (lock_id >> 32) & 0xFFFFFFFF, lock_id & 0xFFFFFFFF

        def waiters(count: int) -> None:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                (waiting,) = conn.execute(
                    "select count(*) from pg_locks where locktype = 'advisory' and not granted "
                    "and classid = %s::oid and objid = %s::oid and objsubid = 1",
                    (high, low),
                ).fetchone()
                if waiting >= count:
                    return
                time.sleep(0.02)
            raise AssertionError(f"expected {count} waiting requests")

        reset = threading.Thread(
            target=call, args=("reset", f"/questions/{q['id']}/practice-reset")
        )
        opened = threading.Thread(target=call, args=("open", f"/questions/{q['id']}/practice-open"))
        try:
            reset.start()
            waiters(1)
            opened.start()
            waiters(2)
        finally:
            conn.commit()
            reset.join(timeout=10)
            if opened.ident is not None:
                opened.join(timeout=10)
    assert failures == []
    assert responses["reset"].status_code == 200
    assert responses["open"].status_code == 409
    assert responses["open"].json()["type"] == RESET_PROBLEM
    assert _status(owner, ws["id"], q["id"]) == "unseen"
