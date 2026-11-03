"""RETRY-01 contracts C01-C02 (docs/screens/retry-correct.md, docs/questions.md §16).

`다시 풀기` can be turned on only for a question whose last graded result is correct
(409 `retry-requires-correct` otherwise; off is always allowed), and a new incorrect grading
turns the flag off, on the merged duplicates' rows too. The clearing rule is the trigger of
supabase/migrations/20261104220000_retry_correct_only.sql (the C02 tests need it applied); its
pgTAP twin is supabase/tests/21_retry_correct.test.sql.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
PROBLEM = "urn:quiz-workspace:problem:retry-requires-correct"
RIGHT, WRONG = "opt-1", "opt-2"


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _start(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def _choose(client: Any, question_id: str, option_id: str) -> str:
    session = _start(client, question_id)
    out = client.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": [option_id]}
    )
    return str(out["result"])


def _my_state(client: Any, question_id: str, body: dict[str, Any]) -> httpx.Response:
    res: httpx.Response = client.call("PATCH", f"/questions/{question_id}/my-state", body)
    return res


def _item(client: Any, workspace_id: str, question_id: str) -> dict[str, Any]:
    overview = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    found = [i for i in overview["items"] if i["question_id"] == question_id]
    assert len(found) == 1
    return dict(found[0])


def _row_flag(user_id: str, question_id: str) -> bool | None:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select needs_retry from public.question_user_states "
            "where user_id = %s and question_id = %s",
            (user_id, question_id),
        ).fetchone()
    return None if row is None else bool(row[0])


def _refused(res: httpx.Response) -> None:
    assert res.status_code == 409, res.text
    assert res.json()["type"] == PROBLEM, res.text


def test_retry_01_c01_turning_retry_on_needs_a_correct_last_result(seed: Any) -> None:
    alice = seed.client("retry01-c01")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("다시 풀기"), ["a", "b"], 0))
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("서술"), "rubric": "r"}
    )

    # Unattempted (no state row yet), then viewed only.
    _refused(_my_state(alice, q["id"], {"needs_retry": True}))
    _start(alice, q["id"])
    _refused(_my_state(alice, q["id"], {"needs_retry": True}))
    # Nothing else in the same request is written.
    _refused(_my_state(alice, q["id"], {"is_favorite": True, "needs_retry": True}))
    assert _item(alice, ws["id"], q["id"])["is_favorite"] is False
    # A favorite change alone is still fine, and off is always allowed.
    assert _my_state(alice, q["id"], {"is_favorite": True}).status_code == 200
    assert _my_state(alice, q["id"], {"needs_retry": False}).status_code == 200

    # Incorrect last result.
    assert _choose(alice, q["id"], WRONG) == "incorrect"
    _refused(_my_state(alice, q["id"], {"needs_retry": True}))

    # Pending only (an essay submitted, not graded).
    session = _start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{session['id']}/submit", {"answer_text": "답"})
    _refused(_my_state(alice, essay["id"], {"needs_retry": True}))

    # Correct last result: allowed.
    assert _choose(alice, q["id"], RIGHT) == "correct"
    on = _my_state(alice, q["id"], {"needs_retry": True})
    assert on.status_code == 200, on.text
    assert on.json()["needs_retry"] is True
    assert _my_state(alice, q["id"], {"needs_retry": True}).status_code == 200  # no change
    assert _my_state(alice, q["id"], {"needs_retry": False}).json()["needs_retry"] is False


def test_retry_01_c02_an_incorrect_grading_turns_retry_off(seed: Any) -> None:
    alice = seed.client("retry01-c02")
    bob = seed.client("retry01-c02-bob")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("오답 해제"), ["a", "b"], 0))
    other = alice.create_question(ws["id"], seed.mcq(_stem("다른 문제"), ["a", "b"], 0))
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("서술 해제"), "rubric": "r"}
    )

    for target in (q, other):
        assert _choose(alice, target["id"], RIGHT) == "correct"
        assert _my_state(alice, target["id"], {"needs_retry": True}).status_code == 200
    # A correct grading keeps the flag.
    assert _choose(alice, q["id"], RIGHT) == "correct"
    assert _item(alice, ws["id"], q["id"])["needs_retry"] is True

    # An incorrect grading turns it off (only this question's, only this user's).
    assert _choose(alice, q["id"], WRONG) == "incorrect"
    state = _item(alice, ws["id"], q["id"])
    assert (state["needs_retry"], state["status"]) == (False, "incorrect")
    assert _item(alice, ws["id"], other["id"])["needs_retry"] is True
    assert _row_flag(bob.user.id, q["id"]) is None

    # Self-grading `incorrect` of an essay does the same.
    first = _start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{first['id']}/submit", {"answer_text": "첫 답"})
    alice.ok("POST", f"/practice-sessions/{first['id']}/self-grade", {"result": "correct"})
    assert _my_state(alice, essay["id"], {"needs_retry": True}).status_code == 200
    # A pending resubmission is not a grading: the flag stays.
    second = _start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{second['id']}/submit", {"answer_text": "둘째 답"})
    assert _item(alice, ws["id"], essay["id"])["needs_retry"] is True
    alice.ok("POST", f"/practice-sessions/{second['id']}/self-grade", {"result": "incorrect"})
    assert _item(alice, ws["id"], essay["id"])["needs_retry"] is False


def test_retry_01_c02_merged_duplicates_follow_the_merged_state(seed: Any) -> None:
    owner = seed.client("retry01-c02-merge")
    ws = owner.create_workspace()
    stem = _stem("합친 문제")
    keep = owner.create_question(ws["id"], seed.mcq(stem, ["a", "b"], 0))
    dup = owner.create_question(ws["id"], seed.mcq(stem, ["a", "b"], 0))
    for q in (dup, keep):
        assert _choose(owner, q["id"], RIGHT) == "correct"
        assert _my_state(owner, q["id"], {"needs_retry": True}).status_code == 200
    merged = owner.call(
        "POST",
        f"/workspaces/{ws['id']}/question-duplicates/merge",
        {"groups": [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}]},
    )
    assert merged.status_code == 200, merged.text
    assert _item(owner, ws["id"], keep["id"])["needs_retry"] is True

    # An incorrect grading of the kept question turns the flag off on the duplicate's row too.
    assert _choose(owner, keep["id"], WRONG) == "incorrect"
    assert _row_flag(owner.user.id, keep["id"]) is False
    assert _row_flag(owner.user.id, dup["id"]) is False
    state = _item(owner, ws["id"], keep["id"])
    assert (state["needs_retry"], state["status"]) == (False, "incorrect")
    # Turning on is refused on the merged (incorrect) state.
    _refused(_my_state(owner, keep["id"], {"needs_retry": True}))


def test_retry_01_c01_a_legacy_flag_does_not_let_a_retry_on_request_through(seed: Any) -> None:
    alice = seed.client("retry01-c01-legacy")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("기존 플래그"), ["a", "b"], 0))
    assert _my_state(alice, q["id"], {"is_favorite": True}).status_code == 200
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:  # a flag from before the rule
        conn.execute(
            "update public.question_user_states set needs_retry = true "
            "where user_id = %s and question_id = %s",
            (alice.user.id, q["id"]),
        )
    # Asking for retry-on is refused although the stored flag already is on; nothing is written.
    _refused(_my_state(alice, q["id"], {"needs_retry": True, "is_favorite": False}))
    state = _item(alice, ws["id"], q["id"])
    assert (state["needs_retry"], state["is_favorite"]) == (True, True)
    # Off is allowed, and the flag stays off.
    assert _my_state(alice, q["id"], {"needs_retry": False}).json()["needs_retry"] is False


def test_retry_01_c01_a_pending_latest_submission_is_not_eligible(seed: Any) -> None:
    alice = seed.client("retry01-c01-pending")
    ws = alice.create_workspace()
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("서술 대기"), "rubric": "r"}
    )
    first = _start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{first['id']}/submit", {"answer_text": "첫 답"})
    alice.ok("POST", f"/practice-sessions/{first['id']}/self-grade", {"result": "correct"})
    assert _my_state(alice, essay["id"], {"needs_retry": True}).status_code == 200
    assert _my_state(alice, essay["id"], {"needs_retry": False}).status_code == 200

    # A newer submission waits for grading: not eligible, although the last graded result is
    # still correct.
    second = _start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{second['id']}/submit", {"answer_text": "둘째 답"})
    assert _item(alice, ws["id"], essay["id"])["is_pending_grading"] is True
    _refused(_my_state(alice, essay["id"], {"needs_retry": True}))
    # Graded correct: eligible again.
    alice.ok("POST", f"/practice-sessions/{second['id']}/self-grade", {"result": "correct"})
    assert _my_state(alice, essay["id"], {"needs_retry": True}).status_code == 200
