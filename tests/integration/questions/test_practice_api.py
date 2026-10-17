"""M5.2 practice API guarantees beyond the QPLAY-01 contract tests.

Concurrency (double submit / double self-grade race on one session), `Idempotency-Key` on
session open, resuming a session (answers only after submit), the stored shuffle seed, CONFIRMED
only, soft-deleted questions, my-state validation and its actor-private activity event, and
attempt history pagination. Fixtures come from conftest.py.
"""

from __future__ import annotations

import threading
import uuid
from typing import Any

import httpx
import psycopg
import pytest
from quiz_api.practice_grading import shuffled_option_ids

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def start(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def _race(calls: list[Any]) -> list[httpx.Response]:
    barrier = threading.Barrier(len(calls))
    results: list[httpx.Response] = []
    errors: list[BaseException] = []

    def run(call: Any) -> None:
        try:
            barrier.wait(timeout=10)
            results.append(call())
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(c,)) for c in calls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert errors == []
    return results


def _db_one(sql: str, params: tuple[Any, ...]) -> Any:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(sql, params).fetchone()
    assert row is not None
    return row


def test_concurrent_submits_grade_the_session_once(seed: Any) -> None:
    alice = seed.client("m52-race-submit")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("경합"), ["a", "b", "c"], 0))
    session = start(alice, q["id"])
    path = f"/practice-sessions/{session['id']}/submit"
    bodies = [{"selected_option_ids": [f"opt-{1 + i % 3}"]} for i in range(6)]

    results = _race([lambda b=b: alice.call("POST", path, b) for b in bodies])

    assert sorted(r.status_code for r in results) == [200] + [409] * 5
    for r in results:
        if r.status_code == 409:
            assert r.json()["type"] == "urn:quiz-workspace:problem:practice-session-submitted"
    items = alice.ok("GET", f"/questions/{q['id']}/attempts")["items"]
    assert len(items) == 1
    [winner] = [r.json() for r in results if r.status_code == 200]
    assert items[0]["id"] == winner["attempt_id"]


def test_concurrent_self_grades_settle_the_pending_attempt_once(seed: Any) -> None:
    alice = seed.client("m52-race-grade")
    ws = alice.create_workspace()
    essay = alice.create_question(ws["id"], {"question_type": "ESSAY", "stem": _stem("서술")})
    session = start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{session['id']}/submit", {"answer_text": "답"})
    path = f"/practice-sessions/{session['id']}/self-grade"

    results = _race(
        [lambda r=r: alice.call("POST", path, {"result": r}) for r in ["correct", "incorrect"] * 3]
    )

    assert sorted(r.status_code for r in results) == [200] + [409] * 5
    items = alice.ok("GET", f"/questions/{essay['id']}/attempts")["items"]
    assert [i["result"] for i in items][1:] == ["pending"]
    assert len(items) == 2


def test_idempotent_open_returns_the_same_session(seed: Any) -> None:
    alice = seed.client("m52-idem")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("멱등"), ["a", "b", "c", "d"], 0))
    path = f"/questions/{q['id']}/practice-sessions"
    key = {"Idempotency-Key": f"open-{uuid.uuid4()}"}

    first = alice.call_with_headers("POST", path, {}, key)
    again = alice.call_with_headers("POST", path, {}, key)
    assert (first.status_code, again.status_code) == (201, 201)
    assert again.json() == first.json()
    assert again.headers.get("Idempotent-Replayed") == "true"
    other = alice.call_with_headers("POST", path, {"x": 1}, key)
    assert other.status_code == 422  # unknown body field

    (count,) = _db_one(
        "select count(*) from public.practice_sessions where question_id = %s", (q["id"],)
    )
    assert count == 1


def test_the_stored_seed_reproduces_the_displayed_order(seed: Any) -> None:
    alice = seed.client("m52-seed")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("씨앗"), ["a", "b", "c", "d", "e"], 0))
    session = start(alice, q["id"])
    seed_value, displayed = _db_one(
        "select shuffle_seed, displayed_option_ids from public.practice_sessions where id = %s",
        (session["id"],),
    )
    assert displayed == session["displayed_option_ids"] == [o["id"] for o in session["options"]]
    authored = [o["id"] for o in q["revision"]["options"]]
    assert shuffled_option_ids(authored, seed_value) == displayed

    short = alice.create_question(
        ws["id"],
        {"question_type": "SHORT_ANSWER", "stem": _stem("단답"), "accepted_answers": ["x"]},
    )
    plain = start(alice, short["id"])
    assert (plain["options"], plain["displayed_option_ids"]) == ([], [])


def test_resume_reveals_answers_only_after_submit(seed: Any) -> None:
    alice, bob = seed.client("m52-resume"), seed.client("m52-resume-bob")
    ws = alice.create_workspace()
    seed.membership(ws["id"], bob.user, "editor")
    q = alice.create_question(
        ws["id"], seed.mcq(_stem("재개"), ["a", "b"], 1, explanation="해설 비밀")
    )
    session = start(alice, q["id"])

    opened = alice.ok("GET", f"/practice-sessions/{session['id']}")
    assert not _keys({k: v for k, v in opened.items() if k != "outcome"}) & ANSWER_KEYS
    assert opened["outcome"] is None
    assert "해설 비밀" not in str(opened)
    assert opened["options"] == session["options"]
    # A member of the same workspace cannot read someone else's session.
    assert bob.call("GET", f"/practice-sessions/{session['id']}").status_code == 404

    alice.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    done = alice.ok("GET", f"/practice-sessions/{session['id']}")
    assert done["state"] == "graded"
    assert done["outcome"]["result"] == "incorrect"
    assert done["outcome"]["correct_option_ids"] == ["opt-2"]
    assert done["outcome"]["explanation"] == "해설 비밀"


def test_only_confirmed_live_questions_are_practised(seed: Any) -> None:
    alice = seed.client("m52-confirmed")
    ws = alice.create_workspace()
    draft = alice.create_question(
        ws["id"], {**seed.mcq(_stem("초안"), ["a", "b"], 0), "publication_status": "DRAFT"}
    )
    res = alice.call("POST", f"/questions/{draft['id']}/practice-sessions", {})
    assert res.status_code == 409
    assert res.json()["type"] == "urn:quiz-workspace:problem:question-not-confirmed"

    q = alice.create_question(ws["id"], seed.mcq(_stem("삭제"), ["a", "b"], 0))
    session = start(alice, q["id"])
    assert alice.call("DELETE", f"/questions/{q['id']}").status_code == 204
    unknown = alice.call("POST", f"/practice-sessions/{uuid.uuid4()}/submit", {"answer_text": "x"})
    gone = alice.call(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    assert seed.problem(gone, 404) == seed.problem(unknown, 404)


def test_my_state_validation_and_private_history(seed: Any) -> None:
    alice = seed.client("m52-mystate")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("상태"), ["a", "b"], 0))
    path = f"/questions/{q['id']}/my-state"
    for bad in ({}, {"is_favorite": None}, {"is_favorite": "yes"}, {"other": True}):
        assert alice.call("PATCH", path, bad).status_code == 422, bad

    state = alice.ok("PATCH", path, {"is_favorite": True})
    assert state == {
        "question_id": q["id"],
        "status": "unseen",
        "is_favorite": True,
        "needs_retry": False,
        "last_graded_result": None,
    }
    alice.ok("PATCH", path, {"is_favorite": True})  # no change, no new history entry
    alice.ok("PATCH", path, {"needs_retry": True, "is_favorite": False})

    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        rows = conn.execute(
            "select actor_id::text, event_type, metadata from public.activity_events "
            "where target_id = %s and event_type = 'question.study_state_changed' "
            "order by created_at, id",
            (q["id"],),
        ).fetchall()
    assert [r[2] for r in rows] == [
        {"visibility": "actor", "changed": {"is_favorite": True}},
        {"visibility": "actor", "changed": {"is_favorite": False, "needs_retry": True}},
    ]
    assert {r[0] for r in rows} == {alice.user.id}


def test_attempt_history_pages_newest_first(seed: Any) -> None:
    alice = seed.client("m52-pages")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("이력"), ["a", "b"], 0))
    ids = []
    for i in range(5):
        session = start(alice, q["id"])
        body = {"selected_option_ids": [f"opt-{1 + i % 2}"]}
        ids.append(
            alice.ok("POST", f"/practice-sessions/{session['id']}/submit", body)["attempt_id"]
        )

    seen: list[str] = []
    cursor = None
    while True:
        query = "?limit=2" + (f"&cursor={cursor}" if cursor else "")
        page = alice.ok("GET", f"/questions/{q['id']}/attempts{query}")
        seen += [a["id"] for a in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ids[::-1]
    assert alice.call("GET", f"/questions/{q['id']}/attempts?cursor=bogus").status_code == 422
    first = alice.ok("GET", f"/questions/{q['id']}/attempts")["items"][-1]
    assert first["submitted_answer"] == {"selected_option_ids": ["opt-1"], "answer_text": None}
    assert first["revision_version"] == 1
