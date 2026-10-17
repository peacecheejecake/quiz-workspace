"""QPLAY-01 server guarantees (docs/questions.md §2/§4, architecture.md §6, auth.md §4).

The practice API never discloses answers before submission (checked on the whole response JSON
and on the OpenAPI response schema), grades by stable option ids whatever the displayed order,
keeps attempts immutable and pinned to the revision the session was opened on, keeps every
user's study state private, and treats practice as a write (archived workspace → 403
workspace-archived, implementation-plan §7). Endpoint shapes are assumptions A8-A12 in
tests/e2e/fixtures/questions.ts; fixtures come from conftest.py (A1-A3).
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.infra

ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
# A10: everything a practice session may carry. A new field is a deliberate, reviewed change.
SESSION_KEYS = {
    "id",
    "question_id",
    "question_revision_id",
    "question_type",
    "stem",
    "options",
    "is_multi_answer",
    "state",
    "workspace_id",
    "chapter_id",
    "question_number",
    "displayed_option_ids",
    "opened_at",
}
RANDOM_ID = "00000000-0000-4000-8000-000000000000"


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def answer_keys(value: Any, path: str = "$") -> list[str]:
    """Every ANSWER_KEYS key anywhere in a JSON value, as `$.path.key`."""
    if isinstance(value, list):
        return [k for i, v in enumerate(value) for k in answer_keys(v, f"{path}[{i}]")]
    if not isinstance(value, dict):
        return []
    found = [f"{path}.{k}" for k in value if k in ANSWER_KEYS]
    return found + [k for key, v in value.items() for k in answer_keys(v, f"{path}.{key}")]


def start(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def submit(client: Any, session_id: str, body: dict[str, Any]) -> httpx.Response:
    res: httpx.Response = client.call("POST", f"/practice-sessions/{session_id}/submit", body)
    return res


def submit_ok(client: Any, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("POST", f"/practice-sessions/{session_id}/submit", body)
    return out


def choose(client: Any, session_id: str, *option_ids: str) -> str:
    return str(submit_ok(client, session_id, {"selected_option_ids": list(option_ids)})["result"])


def self_grade(client: Any, session_id: str, result: str) -> httpx.Response:
    res: httpx.Response = client.call(
        "POST", f"/practice-sessions/{session_id}/self-grade", {"result": result}
    )
    return res


def my_state(client: Any, question_id: str, body: dict[str, Any]) -> httpx.Response:
    res: httpx.Response = client.call("PATCH", f"/questions/{question_id}/my-state", body)
    return res


def attempts(client: Any, question_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok("GET", f"/questions/{question_id}/attempts")["items"]
    return items


def item(client: Any, workspace_id: str, question_id: str) -> dict[str, Any]:
    overview = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    found = [i for i in overview["items"] if i["question_id"] == question_id]
    assert len(found) == 1, "question missing from the overview"
    return dict(found[0])


def _schema_answer_keys(spec: dict[str, Any], node: Any, seen: set[str]) -> list[str]:
    """ANSWER_KEYS property names reachable from an OpenAPI schema node ($refs resolved)."""
    if isinstance(node, list):
        return [k for n in node for k in _schema_answer_keys(spec, n, seen)]
    if not isinstance(node, dict):
        return []
    ref = node.get("$ref")
    if isinstance(ref, str):
        if ref in seen:
            return []
        seen.add(ref)
        target: Any = spec
        for part in ref.removeprefix("#/").split("/"):
            target = target[part]
        return _schema_answer_keys(spec, target, seen)
    found = [k for k in node.get("properties", {}) if k in ANSWER_KEYS]
    return found + [k for v in node.values() for k in _schema_answer_keys(spec, v, seen)]


def test_qplay_01_ac01_practice_session_never_discloses_answers_and_records_the_view(
    seed: Any, app_client: Any
) -> None:
    alice = seed.client("qplay01-ac01")
    ws = alice.create_workspace()
    secrets = {
        "explanation": f"해설-{uuid.uuid4().hex}",
        "accepted": f"응결-{uuid.uuid4().hex[:6]}",
        "rubric": f"채점기준-{uuid.uuid4().hex}",
    }
    single = alice.create_question(
        ws["id"],
        seed.mcq(
            _stem("증발이란?"), ["응결", "증발", "강수"], 1, explanation=secrets["explanation"]
        ),
    )
    multi_body = seed.mcq(_stem("모두 고르시오"), ["가", "나", "다", "라"], 0)
    multi = alice.create_question(
        ws["id"],
        {**multi_body, "is_multi_answer": True, "correct_option_ids": ["opt-1", "opt-3"]},
    )
    short = alice.create_question(
        ws["id"],
        {
            "question_type": "SHORT_ANSWER",
            "stem": _stem("수증기가 물이 되는 현상은?"),
            "accepted_answers": [secrets["accepted"]],
            "explanation": secrets["explanation"],
        },
    )
    essay = alice.create_question(
        ws["id"],
        {"question_type": "ESSAY", "stem": _stem("서술하시오."), "rubric": secrets["rubric"]},
    )

    # The OpenAPI response schema of the practice-session endpoint has no answer fields at all.
    spec = app_client.app.openapi()
    route = re.compile(r"^/api/v1/questions/\{[^}]+\}/practice-sessions$")
    ops = [v["post"] for p, v in spec["paths"].items() if route.match(p) and "post" in v]
    assert ops, "POST /api/v1/questions/{id}/practice-sessions not implemented (not in OpenAPI)"
    op = ops[0]
    schema = op["responses"]["201"]["content"]["application/json"]["schema"]
    assert _schema_answer_keys(spec, schema, set()) == []

    overview = alice.call("GET", f"/workspaces/{ws['id']}/questions/overview")
    assert overview.status_code == 200, f"overview: HTTP {overview.status_code}"
    assert answer_keys(overview.json()) == []
    for question in (single, multi, short, essay):
        assert item(alice, ws["id"], question["id"])["status"] == "unseen"
        res = alice.call("POST", f"/questions/{question['id']}/practice-sessions", {})
        assert res.status_code == 201, f"practice-session: HTTP {res.status_code}"
        session = res.json()
        assert answer_keys(session) == []
        assert set(session) <= SESSION_KEYS, f"unexpected fields {set(session) - SESSION_KEYS}"
        for secret in secrets.values():
            assert secret not in res.text
        assert session["question_revision_id"] == question["revision"]["id"]
        assert session["state"] == "open"
        rev_options = {(o["id"], o["text"]) for o in question["revision"]["options"] or []}
        assert {(o["id"], o["text"]) for o in session["options"]} == rev_options
        assert all(set(o) == {"id", "text"} for o in session["options"])
        # Opening the practice session (not reading the overview) records the view.
        state = item(alice, ws["id"], question["id"])
        assert state["status"] == "viewed"
        assert state["last_graded_result"] is None
    assert answer_keys(alice.ok("GET", f"/workspaces/{ws['id']}/questions/overview")) == []

    # Answers are revealed by the submit response only.
    session = start(alice, single["id"])
    graded = submit_ok(alice, session["id"], {"selected_option_ids": ["opt-2"]})
    assert graded["result"] == "correct"
    assert graded["correct_option_ids"] == ["opt-2"]
    assert graded["explanation"] == secrets["explanation"]


def test_qplay_01_ac02_grading_uses_option_ids_across_100_shuffles(seed: Any) -> None:
    alice = seed.client("qplay01-ac02")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("정답은 셋째"), ["a", "b", "c", "d"], 2))
    all_ids = ["opt-1", "opt-2", "opt-3", "opt-4"]

    orders: dict[str, list[str]] = {}
    position_hits = 0
    for i in range(100):
        session = start(alice, q["id"])
        displayed = [o["id"] for o in session["options"]]
        assert sorted(displayed) == all_ids
        orders[session["id"]] = displayed
        if i % 2 == 0:
            assert choose(alice, session["id"], "opt-3") == "correct"
        else:
            # Whatever sits at the original answer's position is graded by its own id.
            at_position = displayed[2]
            expected = "correct" if at_position == "opt-3" else "incorrect"
            assert choose(alice, session["id"], at_position) == expected
            position_hits += at_position == "opt-3"
    assert len({tuple(o) for o in orders.values()}) > 1, "options are never shuffled"
    assert position_hits < 50, "grading looks positional"

    history = attempts(alice, q["id"])
    assert len(history) == 100
    for attempt in history:
        assert attempt["displayed_option_ids"] == orders[attempt["practice_session_id"]]
        assert attempt["question_revision_id"] == q["revision"]["id"]
        assert attempt["grading_method"] == "auto"


def test_qplay_01_ac02_multi_answer_is_set_equality_and_bad_answers_are_rejected(
    seed: Any,
) -> None:
    alice = seed.client("qplay01-ac02-multi")
    ws = alice.create_workspace()
    body = seed.mcq(_stem("모두 고르시오"), ["가", "나", "다", "라"], 0)
    multi = alice.create_question(
        ws["id"], {**body, "is_multi_answer": True, "correct_option_ids": ["opt-1", "opt-3"]}
    )
    single = alice.create_question(ws["id"], seed.mcq(_stem("하나만"), ["가", "나"], 0))

    assert choose(alice, start(alice, multi["id"])["id"], "opt-3", "opt-1") == "correct"
    assert choose(alice, start(alice, multi["id"])["id"], "opt-1") == "incorrect"
    assert choose(alice, start(alice, multi["id"])["id"], "opt-1", "opt-2", "opt-3") == "incorrect"

    session = start(alice, single["id"])
    invalid: list[dict[str, Any]] = [
        {"selected_option_ids": ["opt-9"]},  # not an option of this revision
        {"selected_option_ids": ["opt-1", "opt-2"]},  # two answers, single-answer MCQ
        {"selected_option_ids": []},
        {"answer_text": "가"},  # free text for an MCQ
    ]
    for bad in invalid:
        res = submit(alice, session["id"], bad)
        assert res.status_code == 422, f"{bad}: HTTP {res.status_code}"
    assert attempts(alice, single["id"]) == []
    assert choose(alice, session["id"], "opt-1") == "correct"
    # A session is answered once; the attempt is never replaced.
    res = submit(alice, session["id"], {"selected_option_ids": ["opt-2"]})
    assert res.status_code == 409, f"second submit: HTTP {res.status_code}"
    assert [a["result"] for a in attempts(alice, single["id"])] == ["correct"]


def test_qplay_01_ac02_short_answers_are_normalized_and_ungradable_ones_stay_pending(
    seed: Any,
) -> None:
    alice = seed.client("qplay01-ac02-short")
    ws = alice.create_workspace()
    short = alice.create_question(
        ws["id"],
        {
            "question_type": "SHORT_ANSWER",
            "stem": _stem("액체가 기체로 변하는 현상은?"),
            "accepted_answers": ["Evaporation", "증발"],
        },
    )
    cases = {
        "Evaporation": "correct",
        "  EVAPORATION  ": "correct",
        # NFKC: the full-width spelling of "evaporation".
        "".join(chr(ord(ch) + 0xFEE0) for ch in "evaporation"): "correct",
        "증발": "correct",
        " 증발\n": "correct",
        "응결": "incorrect",
        "evaporat": "incorrect",
    }
    for text, expected in cases.items():
        res = submit_ok(alice, start(alice, short["id"])["id"], {"answer_text": text})
        assert res["result"] == expected, f"{text!r}: {res['result']}"
        assert res["accepted_answers"] == ["Evaporation", "증발"]

    # No accepted answers → not auto-gradable → pending, then the user's own grade.
    open_ended = alice.create_question(
        ws["id"],
        {"question_type": "SHORT_ANSWER", "stem": _stem("자유 응답"), "accepted_answers": None},
    )
    session = start(alice, open_ended["id"])
    assert submit_ok(alice, session["id"], {"answer_text": "무엇이든"})["result"] == "pending"
    assert item(alice, ws["id"], open_ended["id"])["status"] == "viewed"
    graded = self_grade(alice, session["id"], "incorrect")
    assert graded.status_code == 200, f"self-grade: HTTP {graded.status_code}"
    assert item(alice, ws["id"], open_ended["id"])["status"] == "incorrect"


def test_qplay_01_ac03_a_correct_answer_never_clears_the_retry_flag(seed: Any) -> None:
    alice = seed.client("qplay01-ac03")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("다시 풀기"), ["a", "b"], 0))
    res = my_state(alice, q["id"], {"needs_retry": True})
    assert res.status_code == 200, f"my-state: HTTP {res.status_code}"
    assert res.json()["needs_retry"] is True

    assert choose(alice, start(alice, q["id"])["id"], "opt-1") == "correct"
    state = item(alice, ws["id"], q["id"])
    assert state["status"] == "retry"
    assert state["needs_retry"] is True
    assert state["last_graded_result"] == "correct"

    assert my_state(alice, q["id"], {"needs_retry": False}).status_code == 200
    state = item(alice, ws["id"], q["id"])
    assert (state["status"], state["needs_retry"]) == ("correct", False)
    assert [a["result"] for a in attempts(alice, q["id"])] == ["correct"]


def test_qplay_01_ac04_essay_stays_pending_until_self_graded_once(seed: Any) -> None:
    alice = seed.client("qplay01-ac04")
    ws = alice.create_workspace()
    rubric = f"증발과 응결 언급 {uuid.uuid4().hex[:6]}"
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("물의 순환"), "rubric": rubric}
    )
    mcq = alice.create_question(ws["id"], seed.mcq(_stem("객관식"), ["a", "b"], 0))

    session = start(alice, essay["id"])
    early = self_grade(alice, session["id"], "correct")
    assert early.status_code == 409, f"self-grade before submit: HTTP {early.status_code}"
    res = submit_ok(alice, session["id"], {"answer_text": "바닷물이 증발해 구름이 된다."})
    assert res["result"] == "pending"
    assert res["rubric"] == rubric  # revealed after submission, for the self-grade
    state = item(alice, ws["id"], essay["id"])
    assert state["status"] == "viewed"
    assert state["last_graded_result"] is None
    assert state["is_pending_grading"] is True
    [pending] = attempts(alice, essay["id"])
    assert (pending["result"], pending["grading_method"]) == ("pending", None)

    assert self_grade(alice, session["id"], "maybe").status_code == 422
    graded = self_grade(alice, session["id"], "correct")
    assert graded.status_code == 200, f"self-grade: HTTP {graded.status_code}"
    assert graded.json()["grades_attempt_id"] == pending["id"]
    again = self_grade(alice, session["id"], "incorrect")
    assert again.status_code == 409, f"second self-grade: HTTP {again.status_code}"

    newest, original = attempts(alice, essay["id"])
    assert original == pending
    assert newest["result"] == "correct"
    assert newest["grading_method"] == "self"
    assert newest["grades_attempt_id"] == pending["id"]
    state = item(alice, ws["id"], essay["id"])
    assert (state["status"], state["is_pending_grading"]) == ("correct", False)

    # Auto-graded sessions cannot be self-graded.
    auto = start(alice, mcq["id"])
    assert choose(alice, auto["id"], "opt-2") == "incorrect"
    assert self_grade(alice, auto["id"], "correct").status_code == 409


def test_qplay_01_attempts_are_immutable_and_pinned_to_the_session_revision(seed: Any) -> None:
    alice = seed.client("qplay01-pinned")
    ws = alice.create_workspace()
    body = seed.mcq(_stem("v1 정답은 첫째"), ["a", "b", "c"], 0)
    q = alice.create_question(ws["id"], body)
    v1 = q["revision"]["id"]

    first = start(alice, q["id"])
    assert choose(alice, first["id"], "opt-1") == "correct"
    [graded_v1] = attempts(alice, q["id"])
    stale = start(alice, q["id"])  # opened on v1, answered after the edit

    edit = {**body, "base_revision_id": v1, "stem": _stem("v2 정답은 둘째")}
    edit["correct_option_ids"] = ["opt-2"]
    v2 = alice.ok("PATCH", f"/questions/{q['id']}", edit)["revision"]["id"]
    assert v2 != v1

    assert stale["question_revision_id"] == v1
    assert choose(alice, stale["id"], "opt-1") == "correct"  # graded against v1
    fresh = start(alice, q["id"])
    assert fresh["question_revision_id"] == v2
    assert choose(alice, fresh["id"], "opt-1") == "incorrect"

    history = attempts(alice, q["id"])
    assert [(a["question_revision_id"], a["result"]) for a in history] == [
        (v2, "incorrect"),
        (v1, "correct"),
        (v1, "correct"),
    ]
    assert history[-1] == graded_v1  # the first attempt is untouched by the edit
    assert submit(alice, first["id"], {"selected_option_ids": ["opt-2"]}).status_code == 409
    for method in ("PATCH", "PUT", "DELETE"):
        res = alice.call(method, f"/questions/{q['id']}/attempts", {})
        assert res.status_code in {404, 405}, f"{method} attempts: HTTP {res.status_code}"
    assert attempts(alice, q["id"]) == history


def test_qplay_01_viewer_practises_with_private_state_only(seed: Any) -> None:
    owner, viewer = seed.client("qplay01-viewer-owner"), seed.client("qplay01-viewer")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq(_stem("뷰어"), ["a", "b"], 0))
    seed.membership(ws["id"], viewer.user, "viewer")

    session = start(viewer, q["id"])
    assert choose(viewer, session["id"], "opt-1") == "correct"
    assert my_state(viewer, q["id"], {"is_favorite": True}).status_code == 200
    mine = item(viewer, ws["id"], q["id"])
    assert (mine["status"], mine["is_favorite"]) == ("correct", True)
    assert len(attempts(viewer, q["id"])) == 1

    # The owner's state and history are untouched and the viewer's are invisible to them.
    theirs = item(owner, ws["id"], q["id"])
    assert (theirs["status"], theirs["is_favorite"]) == ("unseen", False)
    assert attempts(owner, q["id"]) == []

    # Neither can act on the other's session.
    owner_session = start(owner, q["id"])
    unknown = seed.problem(submit(viewer, RANDOM_ID, {"selected_option_ids": ["opt-1"]}), 404)
    foreign = seed.problem(
        submit(viewer, owner_session["id"], {"selected_option_ids": ["opt-1"]}), 404
    )
    assert foreign == unknown
    assert seed.problem(self_grade(owner, session["id"], "correct"), 404) == seed.problem(
        self_grade(owner, RANDOM_ID, "correct"), 404
    )
    assert attempts(owner, q["id"]) == []
    assert choose(owner, owner_session["id"], "opt-2") == "incorrect"
    assert len(attempts(viewer, q["id"])) == 1


def test_qplay_01_archived_workspace_rejects_practice_writes(seed: Any) -> None:
    alice = seed.client("qplay01-archived")
    ws = alice.create_workspace()
    mcq = alice.create_question(ws["id"], seed.mcq(_stem("보관"), ["a", "b"], 0))
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("보관 서술"), "rubric": "r"}
    )
    open_session = start(alice, mcq["id"])
    pending = start(alice, essay["id"])
    assert submit_ok(alice, pending["id"], {"answer_text": "답"})["result"] == "pending"
    before = (attempts(alice, mcq["id"]), attempts(alice, essay["id"]))

    alice.ok("POST", f"/workspaces/{ws['id']}/archive")
    writes = [
        alice.call("POST", f"/questions/{mcq['id']}/practice-sessions", {}),
        submit(alice, open_session["id"], {"selected_option_ids": ["opt-1"]}),
        self_grade(alice, pending["id"], "correct"),
        my_state(alice, mcq["id"], {"is_favorite": True}),
        my_state(alice, mcq["id"], {"needs_retry": True}),
    ]
    for res in writes:
        seed.problem(res, 403, seed.ARCHIVED)
    # Read-only: the overview and history stay readable and unchanged.
    assert (attempts(alice, mcq["id"]), attempts(alice, essay["id"])) == before
    state = item(alice, ws["id"], mcq["id"])
    assert (state["is_favorite"], state["needs_retry"]) == (False, False)


def test_qplay_01_other_users_cannot_reach_sessions_state_or_history(seed: Any) -> None:
    alice, mallory = seed.client("qplay01-iso-alice"), seed.client("qplay01-iso-mallory")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("격리"), ["a", "b"], 0))
    session = start(alice, q["id"])
    essay = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("격리 서술"), "rubric": "r"}
    )
    pending = start(alice, essay["id"])
    assert submit_ok(alice, pending["id"], {"answer_text": "답"})["result"] == "pending"

    pairs = [
        (
            mallory.call("POST", f"/questions/{q['id']}/practice-sessions", {}),
            mallory.call("POST", f"/questions/{RANDOM_ID}/practice-sessions", {}),
        ),
        (
            submit(mallory, session["id"], {"selected_option_ids": ["opt-1"]}),
            submit(mallory, RANDOM_ID, {"selected_option_ids": ["opt-1"]}),
        ),
        (self_grade(mallory, pending["id"], "correct"), self_grade(mallory, RANDOM_ID, "correct")),
        (
            my_state(mallory, q["id"], {"is_favorite": True}),
            my_state(mallory, RANDOM_ID, {"is_favorite": True}),
        ),
        (
            mallory.call("GET", f"/questions/{q['id']}/attempts"),
            mallory.call("GET", f"/questions/{RANDOM_ID}/attempts"),
        ),
        (
            mallory.call("GET", f"/workspaces/{ws['id']}/questions/overview"),
            mallory.call("GET", f"/workspaces/{RANDOM_ID}/questions/overview"),
        ),
    ]
    for foreign, unknown in pairs:
        assert seed.problem(foreign, 404) == seed.problem(unknown, 404)

    # Alice's session is still open and her state untouched.
    assert choose(alice, session["id"], "opt-1") == "correct"
    state = item(alice, ws["id"], q["id"])
    assert (state["status"], state["is_favorite"]) == ("correct", False)
    assert [a["result"] for a in attempts(alice, essay["id"])] == ["pending"]
