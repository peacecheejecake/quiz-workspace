"""QOV-01 server guarantees (docs/questions.md §2-§3, §7-§8; architecture.md §6).

The overview lists one item per CONFIRMED question for the caller (drafts and option shuffles
never add items), derives the status with retry > incorrect > correct > viewed > unseen, keeps
favorite independent of the status, counts statuses mutually exclusively with an overlapping
favorite count, never carries answers, and reading it (or the question detail) never records a
view. Endpoint shapes are assumptions A8-A13 in tests/e2e/fixtures/questions.ts; fixtures come
from conftest.py.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

# RED (M5.0): remove `red` when M5.1/M5.2 make these GREEN.
pytestmark = [pytest.mark.infra, pytest.mark.red]

ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
STATUSES = ("unseen", "viewed", "incorrect", "correct", "retry")


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def overview(client: Any, workspace_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    assert not (_keys(out) & ANSWER_KEYS), "the overview must never carry answers"
    return out


def by_id(view: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {i["question_id"]: i for i in view["items"]}


def start(client: Any, question_id: str) -> str:
    return str(client.ok("POST", f"/questions/{question_id}/practice-sessions", {}, (201,))["id"])


def answer(client: Any, question_id: str, option_id: str) -> str:
    session = start(client, question_id)
    body = {"selected_option_ids": [option_id]}
    return str(client.ok("POST", f"/practice-sessions/{session}/submit", body)["result"])


def set_state(client: Any, question_id: str, **state: bool) -> None:
    client.ok("PATCH", f"/questions/{question_id}/my-state", state)


def numbered(seed: Any, n: int) -> dict[str, Any]:
    body: dict[str, Any] = seed.mcq(_stem(f"{n}번"), ["a", "b", "c", "d"], 0)
    return {**body, "question_number": n}


def test_qov_01_ac01_one_item_per_confirmed_question_drafts_and_shuffles_add_none(
    seed: Any,
) -> None:
    alice = seed.client("qov01-ac01")
    ws = alice.create_workspace()
    created = [alice.create_question(ws["id"], numbered(seed, n)) for n in range(1, 101)]
    run, drafts = alice.import_paper(ws["id"])  # A13: drafts stay out of the overview
    assert drafts
    assert all(d["published_question_id"] is None for d in drafts)

    view = overview(alice, ws["id"])
    assert [i["question_id"] for i in view["items"]] == [q["id"] for q in created]
    assert [i["question_number"] for i in view["items"]] == list(range(1, 101))
    assert view["counts"]["total"] == 100
    assert view["counts"]["unseen"] == 100

    for _ in range(30):  # option shuffles (practice sessions) never add items
        start(alice, created[0]["id"])
    view = overview(alice, ws["id"])
    assert len(view["items"]) == 100
    assert view["counts"]["total"] == 100

    approved = [seed.draft_for(drafts, n)["id"] for n in (1, 4, 5)]
    published = alice.ok_response(alice.publish(run["id"], approved), "POST", "publish", (200,))
    new_ids = {p["question_id"] for p in published["items"]}
    view = overview(alice, ws["id"])
    assert len(view["items"]) == 103
    assert new_ids <= set(by_id(view))
    assert view["counts"]["total"] == 103


def test_qov_01_ac02_reading_the_overview_or_detail_never_records_a_view(seed: Any) -> None:
    alice = seed.client("qov01-ac02")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], numbered(seed, 1))
    for _ in range(10):
        assert by_id(overview(alice, ws["id"]))[q["id"]]["status"] == "unseen"
        alice.get_question(q["id"])  # bank/editor view is not a study view
    assert by_id(overview(alice, ws["id"]))[q["id"]]["status"] == "unseen"
    start(alice, q["id"])
    assert by_id(overview(alice, ws["id"]))[q["id"]]["status"] == "viewed"


def test_qov_01_ac03_favorite_is_independent_of_the_status(seed: Any) -> None:
    alice = seed.client("qov01-ac03")
    ws = alice.create_workspace()
    q1, q2 = (alice.create_question(ws["id"], numbered(seed, n)) for n in (1, 2))
    set_state(alice, q1["id"], is_favorite=True)
    item = by_id(overview(alice, ws["id"]))[q1["id"]]
    assert (item["status"], item["is_favorite"]) == ("unseen", True)

    assert answer(alice, q1["id"], "opt-2") == "incorrect"
    view = overview(alice, ws["id"])
    item = by_id(view)[q1["id"]]
    assert (item["status"], item["is_favorite"]) == ("incorrect", True)
    assert view["counts"] == {
        "total": 2,
        "unseen": 1,
        "viewed": 0,
        "incorrect": 1,
        "correct": 0,
        "retry": 0,
        "favorite": 1,
    }
    set_state(alice, q1["id"], is_favorite=False)
    assert by_id(overview(alice, ws["id"]))[q1["id"]]["status"] == "incorrect"
    assert by_id(overview(alice, ws["id"]))[q2["id"]]["is_favorite"] is False


def test_qov_01_ac05_retry_outranks_the_last_result_and_counts_are_exclusive(seed: Any) -> None:
    alice = seed.client("qov01-ac05")
    ws = alice.create_workspace()
    qs = [alice.create_question(ws["id"], numbered(seed, n)) for n in range(1, 8)]
    ids = [q["id"] for q in qs]
    assert answer(alice, ids[0], "opt-1") == "correct"
    set_state(alice, ids[0], needs_retry=True)  # correct + retry → retry
    assert answer(alice, ids[1], "opt-2") == "incorrect"
    set_state(alice, ids[1], needs_retry=True)  # incorrect + retry → retry
    assert answer(alice, ids[2], "opt-1") == "correct"
    assert answer(alice, ids[3], "opt-2") == "incorrect"
    start(alice, ids[4])  # viewed
    # ids[5] stays unseen
    assert answer(alice, ids[6], "opt-1") == "correct"
    set_state(alice, ids[6], is_favorite=True)

    view = overview(alice, ws["id"])
    items = by_id(view)
    assert [items[i]["status"] for i in ids] == [
        "retry",
        "retry",
        "correct",
        "incorrect",
        "viewed",
        "unseen",
        "correct",
    ]
    assert items[ids[0]]["last_graded_result"] == "correct"
    counts = view["counts"]
    assert counts == {
        "total": 7,
        "retry": 2,
        "correct": 2,
        "incorrect": 1,
        "viewed": 1,
        "unseen": 1,
        "favorite": 1,
    }
    assert sum(counts[s] for s in STATUSES) == counts["total"]

    set_state(alice, ids[0], needs_retry=False)  # back to the last graded result
    assert by_id(overview(alice, ws["id"]))[ids[0]]["status"] == "correct"
