"""QBANK-01 server guarantees (docs/architecture.md §6, docs/questions.md §2/§4, auth.md §4).

Questions are validated on save (MCQ options with unique stable ids and an answer among them),
edits append a revision without touching the history attempts point at, option ids survive
edits, and only members with an editing role in a non-archived workspace can write; other users
get the same 404 as for a missing question. Fixtures: conftest.py (assumptions A1-A3 in
tests/e2e/fixtures/questions.ts).
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

# RED (M4.0): remove `red` when M4.2a makes these GREEN.
pytestmark = [pytest.mark.infra, pytest.mark.red]


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def test_qbank_01_ac02_mcq_is_validated_and_confirmed_on_save(seed: Any) -> None:
    alice = seed.client("qbank01-ac02")
    ws = alice.create_workspace()
    assert alice.list_questions(ws["id"]) == []

    base = seed.mcq(_stem("물이 기체로 변하는 과정은?"), ["응결", "증발", "강수", "침전"], 1)
    invalid = [
        {**base, "correct_option_ids": []},  # MCQ without an answer
        {**base, "correct_option_ids": ["opt-9"]},  # answer not among the options
        {**base, "options": [{"id": "dup", "text": "a"}, {"id": "dup", "text": "b"}]},
        {**base, "options": [{"id": "opt-1", "text": "   "}]},  # blank option
        {**base, "options": []},
        {**base, "stem": "  "},
        {**base, "question_type": "TRUE_FALSE"},
        {**base, "correct_option_ids": ["opt-1", "opt-2"], "is_multi_answer": False},
    ]
    for body in invalid:
        res = alice.call("POST", f"/workspaces/{ws['id']}/questions", body)
        assert res.status_code == 422, f"{body}: HTTP {res.status_code}"
    assert alice.list_questions(ws["id"]) == []

    saved = alice.create_question(ws["id"], base)
    assert saved["publication_status"] == "CONFIRMED"
    assert saved["question_type"] == "MCQ"
    rev = saved["revision"]
    assert rev["version"] == 1
    assert rev["options"] == base["options"]
    assert rev["correct_option_ids"] == ["opt-2"]

    short = alice.create_question(
        ws["id"],
        {"question_type": "SHORT_ANSWER", "stem": _stem("여과 단계는?"), "accepted_answers": None},
    )
    essay = alice.create_question(
        ws["id"],
        {"question_type": "ESSAY", "stem": _stem("서술하시오."), "rubric": "침투와 유출"},
    )
    # A short answer without accepted answers is allowed (not auto-gradable) and stays null.
    assert short["revision"]["accepted_answers"] is None
    assert essay["revision"]["correct_option_ids"] is None
    listed = {q["id"] for q in alice.list_questions(ws["id"])}
    assert listed == {saved["id"], short["id"], essay["id"]}


def test_qbank_01_ac03_edit_appends_a_revision_and_keeps_option_ids_and_history(seed: Any) -> None:
    alice = seed.client("qbank01-ac03")
    ws = alice.create_workspace()
    original = _stem("염소 소독의 목적은?")
    q = alice.create_question(ws["id"], seed.mcq(original, ["색", "미생물 감소", "온도"], 1))
    v1 = q["revision"]
    attempt = seed.graded_attempt(ws["id"], q["id"], v1["id"], alice.user.id)

    edited_options = [
        {"id": "opt-1", "text": "물의 색을 진하게 한다"},
        {"id": "opt-2", "text": "병원성 미생물을 줄인다"},
        {"id": "opt-3", "text": "물의 온도를 높인다"},
        {"id": "opt-new", "text": "침전물을 늘린다"},
    ]
    edited = alice.ok(
        "PATCH",
        f"/questions/{q['id']}",
        {
            "base_revision_id": v1["id"],
            "stem": _stem("염소 소독의 주된 목적은?"),
            "options": edited_options,
            "correct_option_ids": ["opt-2"],
        },
    )
    v2 = edited["revision"]
    assert v2["version"] == 2
    assert v2["id"] != v1["id"]
    # Existing option ids survive the edit; the new option keeps the id it was given.
    assert [o["id"] for o in v2["options"]] == ["opt-1", "opt-2", "opt-3", "opt-new"]
    assert v2["correct_option_ids"] == ["opt-2"]
    assert alice.get_question(q["id"])["revision"]["id"] == v2["id"]

    # The attempt still points at revision 1, whose content is unchanged.
    assert seed.attempt_revision(attempt) == (v1["id"], 1, original)

    # Revision consistency: an edit based on a stale revision is refused, nothing changes.
    stale = alice.call(
        "PATCH", f"/questions/{q['id']}", {"base_revision_id": v1["id"], "stem": "stale edit"}
    )
    assert stale.status_code == 409, f"HTTP {stale.status_code}"
    assert alice.get_question(q["id"])["revision"] == v2


def test_qbank_01_ac04_foreign_questions_are_404_like_missing_ones(seed: Any) -> None:
    alice, mallory = seed.client("qbank01-ac04-alice"), seed.client("qbank01-ac04-mallory")
    ws = alice.create_workspace()
    secret = _stem("앨리스의 비공개 문제")
    q = alice.create_question(ws["id"], seed.mcq(secret, ["가", "나"], 0))
    mallory.create_workspace()

    missing = seed.problem(mallory.call("GET", f"/questions/{seed.new_id()}"), 404)
    for method, path, body in (
        ("GET", f"/questions/{q['id']}", None),
        ("PATCH", f"/questions/{q['id']}", {"base_revision_id": q["revision"]["id"], "stem": "x"}),
        ("GET", f"/workspaces/{ws['id']}/questions", None),
        ("POST", f"/workspaces/{ws['id']}/questions", seed.mcq("mallory", ["a", "b"], 0)),
    ):
        res = mallory.call(method, path, body)
        assert seed.problem(res, 404) == missing, path
        assert secret not in res.text
    assert alice.get_question(q["id"])["revision"] == q["revision"]


def test_qbank_01_ac04_viewer_is_403_insufficient_role_and_archived_is_403(seed: Any) -> None:
    owner, viewer = seed.client("qbank01-ac04-owner"), seed.client("qbank01-ac04-viewer")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq(_stem("읽기 전용 확인"), ["가", "나"], 0))
    seed.membership(ws["id"], viewer.user, "viewer")

    assert [x["id"] for x in viewer.list_questions(ws["id"])] == [q["id"]]
    assert viewer.get_question(q["id"])["revision"] == q["revision"]
    edit = {"base_revision_id": q["revision"]["id"], "stem": "viewer edit"}
    for method, path, body in (
        ("PATCH", f"/questions/{q['id']}", edit),
        ("POST", f"/workspaces/{ws['id']}/questions", seed.mcq("viewer", ["a", "b"], 0)),
    ):
        seed.problem(viewer.call(method, path, body), 403, seed.INSUFFICIENT_ROLE)

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    for method, path, body in (
        ("PATCH", f"/questions/{q['id']}", {**edit, "stem": "archived edit"}),
        ("POST", f"/workspaces/{ws['id']}/questions", seed.mcq("archived", ["a", "b"], 0)),
    ):
        seed.problem(owner.call(method, path, body), 403, seed.ARCHIVED)
    # Archived is read-only, not hidden.
    assert owner.get_question(q["id"])["revision"] == q["revision"]
