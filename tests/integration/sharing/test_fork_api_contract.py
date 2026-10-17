"""S0 RED security contract: Workspace fork (docs/workspace-sharing.md §3-§6).

Fork needs a valid share session AND a Supabase JWT, allow_fork re-checked at request and at
commit; the result is an independent snapshot with new ids and no personal data. Shapes, the
fault-injection markers (S6) and the assumed rate limit (S7) are in tests/e2e/fixtures/sharing.ts.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

# RED (S0): S3a removes `red` when the fork worker makes these GREEN.
pytestmark = [pytest.mark.infra, pytest.mark.red]


def _shared(
    seed: Any, label: str, *, allow_fork: bool = True
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    owner = seed.client(f"{label}-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"], allow_fork=allow_fork)
    return owner, ws, link


def test_ws_fork_01_ac02_fork_requires_jwt_share_session_allow_fork_and_a_live_link(
    seed: Any,
) -> None:
    owner, ws, off = _shared(seed, "ac02", allow_fork=False)
    on = owner.create_link(ws["id"], allow_fork=True)
    recipient = seed.client("ac02-recipient")
    guest = seed.guest()
    off_cookie = guest.session(off["id"], off["secret"])
    on_cookie = guest.session(on["id"], on["secret"])

    seed.assert_status(recipient.fork(on["id"], on_cookie, "x", jwt=False), 401, "no JWT")
    seed.assert_status(recipient.fork(on["id"], None, "x"), {403, 404}, "no share session")
    seed.assert_status(recipient.fork(on["id"], off_cookie, "x"), {403, 404}, "other link session")
    seed.assert_status(recipient.fork(off["id"], off_cookie, "x"), 403, "allow_fork OFF")
    seed.assert_status(recipient.fork(on["id"], on_cookie, "x", origin=None), 403, "no Origin")
    seed.assert_status(
        recipient.fork(on["id"], on_cookie, "x", origin=seed.FOREIGN_ORIGIN), 403, "foreign Origin"
    )

    expired = owner.create_link(ws["id"], allow_fork=True)
    expired_cookie = guest.session(expired["id"], expired["secret"])
    seed.expire_now(expired["id"])
    seed.assert_status(recipient.fork(expired["id"], expired_cookie, "x"), 404, "expired link")
    seed.assert_status(owner.revoke(ws["id"], on["id"]), 200, "revoke")
    seed.assert_status(recipient.fork(on["id"], on_cookie, "x"), 404, "revoked link")

    deleted = owner.create_workspace()
    gone = owner.create_link(deleted["id"], allow_fork=True)
    gone_cookie = guest.session(gone["id"], gone["secret"])
    owner.ok("DELETE", f"/workspaces/{deleted['id']}", expected=(200, 202, 204))
    seed.assert_status(recipient.fork(gone["id"], gone_cookie, "x"), 404, "deleted source")

    assert seed.workspaces_owned_by(recipient.user.id) == 0, "a rejected fork left a workspace"


def test_ws_fork_01_ac04_fork_start_is_202_idempotent_and_private_to_the_requester(
    seed: Any,
) -> None:
    owner, _ws, link = _shared(seed, "ac04")
    recipient = seed.client("ac04-recipient")
    other = seed.client("ac04-other")
    cookie = seed.guest().session(link["id"], link["secret"])

    key = str(uuid.uuid4())
    first = recipient.fork(link["id"], cookie, "S0 fork 멱등", key)
    seed.assert_status(first, 202, "fork start")
    fork = first.json()
    assert fork["job_id"], "202 carries a job id"
    assert fork["status"] in {"PENDING", "COPYING", "COMPLETED"}
    again = recipient.fork(link["id"], cookie, "S0 fork 멱등", key)
    seed.assert_status(again, 202, "same key replay")
    assert again.json()["id"] == fork["id"], "same Idempotency-Key → same fork"
    conflict = recipient.fork(link["id"], cookie, "S0 fork 다른 이름", key)
    seed.assert_status(conflict, 409, "same key, different body")

    for stranger in (other, owner):
        seed.assert_status(stranger.get_fork(fork["id"]), 404, "someone else's fork")
    done = recipient.wait_fork(fork["id"], "COMPLETED")
    assert done["target_workspace_id"]
    ids = [w["id"] for w in recipient.list_workspaces()]
    assert ids == [done["target_workspace_id"]], "one fork, one workspace"


def test_ws_fork_01_ac04_a_failed_fork_reports_failed_and_leaves_nothing(seed: Any) -> None:
    _owner, _ws, link = _shared(seed, "ac04f")
    recipient = seed.client("ac04f-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, f"S0 {seed.FORK_FAILURE_MARKER}")
    seed.assert_status(res, 202, "fork start")
    failed = recipient.wait_fork(res.json()["id"], "FAILED")
    assert failed["target_workspace_id"] is None
    assert seed.workspaces_owned_by(recipient.user.id) == 0


def test_ws_fork_01_ac05_fork_copies_the_published_snapshot_with_new_ids_and_no_personal_data(
    seed: Any,
) -> None:
    owner, ws, link = _shared(seed, "ac05")
    recipient = seed.client("ac05-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    q1 = owner.create_question(ws["id"], "S0 fork 문제 하나", answer=1)
    q2 = owner.create_question(ws["id"], "S0 fork 문제 둘", answer=3)
    seed.study_state(owner.user.id, ws["id"], q1["id"])
    seed.graded_attempt(ws["id"], q1["id"], q1["revision"]["id"], owner.user.id)
    seed.unpublished_questions(owner, ws["id"])
    source_counts = seed.private_counts(ws["id"])
    assert source_counts["workspace_share_links"] == 1

    res = recipient.fork(link["id"], cookie, "S0 내 fork")
    seed.assert_status(res, 202, "fork start")
    fork = recipient.wait_fork(res.json()["id"], "COMPLETED")
    target = str(fork["target_workspace_id"])
    assert target != ws["id"]

    # An independent workspace owned by the recipient only.
    (listed,) = recipient.list_workspaces()
    assert (listed["id"], listed["name"], listed["role"]) == (target, "S0 내 fork", "owner")
    assert seed.memberships(target) == [(recipient.user.id, "owner")]
    assert seed.memberships(ws["id"]) == [(owner.user.id, "owner")]

    # Same published content, new ids everywhere.
    copies = recipient.list_questions(target)
    by_stem = {q["revision"]["stem"]: q for q in copies}
    assert set(by_stem) == {"S0 fork 문제 하나", "S0 fork 문제 둘"}
    # Only the CONFIRMED snapshot: no DRAFT/ARCHIVED/deleted question rows, in any state.
    assert seed.question_rows(target) == [
        ("CONFIRMED", False, "S0 fork 문제 둘"),
        ("CONFIRMED", False, "S0 fork 문제 하나"),
    ]
    for src in (q1, q2):
        dst = by_stem[src["revision"]["stem"]]
        assert dst["id"] != src["id"]
        assert dst["revision"]["id"] != src["revision"]["id"]
        assert dst["workspace_id"] == target
        for field in ("options", "correct_option_ids", "explanation"):
            assert dst["revision"][field] == src["revision"][field], field
    assert not {q1["id"], q2["id"]} & {q["id"] for q in copies}

    # No attempts, states, favourites/retry, drafts, share links or owner activity copied.
    assert seed.private_counts(target) == {
        "question_user_states": 0,
        "question_attempts": 0,
        "practice_sessions": 0,
        "question_drafts": 0,
        "workspace_share_links": 0,
    }
    assert seed.activity_by(target, owner.user.id) == 0
    # The source is untouched; the fork is editable by its new owner only.
    assert seed.private_counts(ws["id"]) == source_counts
    recipient.ok("PATCH", f"/workspaces/{target}", {"name": "S0 내 fork 2"})
    seed.assert_status(owner.call("PATCH", f"/workspaces/{target}", {"name": "x"}), 404, "owner")
    assert [w["name"] for w in owner.list_workspaces()] == [ws["name"]]


@pytest.mark.parametrize("change", ["revoke", "allow_fork_off"])
def test_ws_fork_01_ac06_a_policy_change_mid_fork_cancels_and_cleans_up(
    seed: Any, change: str
) -> None:
    owner, ws, link = _shared(seed, f"ac06-{change}")
    owner.create_question(ws["id"], "S0 취소될 fork 문제")
    recipient = seed.client(f"ac06-{change}-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])

    res = recipient.fork(link["id"], cookie, f"S0 {seed.FORK_PAUSE_MARKER}")
    seed.assert_status(res, 202, "fork start")
    fork_id = res.json()["id"]
    recipient.wait_fork(fork_id, "COPYING")
    if change == "revoke":
        seed.assert_status(owner.revoke(ws["id"], link["id"]), 200, "revoke mid-fork")
    else:
        seed.assert_status(owner.patch_link(ws["id"], link["id"], allow_fork=False), 200, "OFF")

    cancelled = recipient.wait_fork(fork_id, "CANCELLED")
    assert cancelled["target_workspace_id"] is None
    assert recipient.list_workspaces() == []
    assert seed.workspaces_owned_by(recipient.user.id) == 0, "temporary copy not cleaned up"


def test_ws_fork_01_ac06_a_completed_fork_survives_source_revoke_and_delete(seed: Any) -> None:
    owner, ws, link = _shared(seed, "ac06-done")
    owner.create_question(ws["id"], "S0 살아남는 fork 문제")
    recipient = seed.client("ac06-done-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, "S0 완료된 fork")
    seed.assert_status(res, 202, "fork start")
    target = recipient.wait_fork(res.json()["id"], "COMPLETED")["target_workspace_id"]

    seed.assert_status(owner.revoke(ws["id"], link["id"]), 200, "revoke")
    owner.ok("DELETE", f"/workspaces/{ws['id']}", expected=(200, 202, 204))

    assert [w["id"] for w in recipient.list_workspaces()] == [target]
    stems = [q["revision"]["stem"] for q in recipient.list_questions(str(target))]
    assert stems == ["S0 살아남는 fork 문제"]
    fork = recipient.get_fork(res.json()["id"])
    seed.assert_status(fork, 200, "fork record after source delete")
    assert fork.json()["status"] == "COMPLETED"


def test_fork_requests_are_rate_limited(seed: Any) -> None:
    """Assumed limit S7: <= 5 fork starts/min per user; a burst of 10 hits 429."""
    _owner, _ws, link = _shared(seed, "rate")
    recipient = seed.client("rate-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    statuses: list[int] = []
    limited = None
    for i in range(seed.FORK_BURST):
        res = recipient.fork(link["id"], cookie, f"S0 rate {i}")
        statuses.append(res.status_code)
        if res.status_code == 429:
            limited = res
            break
    assert limited is not None, f"no 429 in {len(statuses)} fork requests: {sorted(set(statuses))}"
    assert set(statuses[:-1]) <= {202}
    assert limited.headers.get("retry-after"), "429 carries Retry-After"
