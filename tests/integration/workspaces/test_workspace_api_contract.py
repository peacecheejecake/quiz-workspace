"""WS-01 server guarantees (docs/screens/workspaces.md, implementation-plan §7 authz policy).

Owner on create, archived = read-only (403 workspace-archived), soft delete = 404 for everyone,
foreign workspace ids = 404 with the same body as a missing workspace. Fixtures: conftest.py.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

pytestmark = pytest.mark.infra

# RED (M3.0) until the search endpoint they also probe exists (M3.6a). Their workspace and
# document steps are GREEN since M3.1a / M3.2a; remove `red` when M3.6a lands.
_RED_UNTIL_SEARCH = pytest.mark.red


def test_ws_01_ac02_created_workspace_lists_the_creator_as_owner(seed: Any) -> None:
    alice = seed.client("ws01-ac02")
    created = alice.create_workspace("Contract Alpha")
    assert created["name"] == "Contract Alpha"
    assert created["role"] == "owner"
    assert created["status"] == "active"

    active = alice.list_workspaces("active")
    assert [(w["id"], w["role"], w["status"]) for w in active] == [
        (created["id"], "owner", "active")
    ]
    assert alice.list_workspaces("archived") == []
    # `/me/workspaces` (A1.3) sees the same membership.
    mine = alice.ok("GET", "/me/workspaces")["items"]
    assert [(w["id"], w["role"]) for w in mine] == [(created["id"], "owner")]


def test_ws_01_ac03_archived_workspace_rejects_writes(seed: Any) -> None:
    alice = seed.client("ws01-ac03")
    ws = alice.create_workspace()
    archived = alice.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert archived["status"] == "archived"
    assert [w["id"] for w in alice.list_workspaces("archived")] == [ws["id"]]
    assert alice.list_workspaces("active") == []

    for method, path, body in (
        ("PATCH", f"/workspaces/{ws['id']}", {"name": "renamed"}),
        (
            "POST",
            f"/workspaces/{ws['id']}/documents/upload-intent",
            {
                "filename": "a.pdf",
                "size_bytes": 1024,
                "content_type": "application/pdf",
            },
        ),
    ):
        seed.problem(alice.call(method, path, body), 403, seed.ARCHIVED)

    # Restore brings writes back.
    assert alice.ok("POST", f"/workspaces/{ws['id']}/restore")["status"] == "active"
    renamed = alice.ok("PATCH", f"/workspaces/{ws['id']}", {"name": "renamed"})
    assert renamed["name"] == "renamed"


@_RED_UNTIL_SEARCH
def test_ws_01_ac04_soft_deleted_workspace_answers_404_like_a_missing_one(seed: Any) -> None:
    alice = seed.client("ws01-ac04")
    ws = alice.create_workspace()
    alice.ok("DELETE", f"/workspaces/{ws['id']}", expected=(200, 202, 204))

    assert alice.list_workspaces("active") == []
    assert alice.list_workspaces("archived") == []
    missing = seed.problem(alice.call("PATCH", f"/workspaces/{uuid.uuid4()}", {"name": "x"}), 404)
    for method, path, body in (
        ("PATCH", f"/workspaces/{ws['id']}", {"name": "x"}),
        ("POST", f"/workspaces/{ws['id']}/restore", None),
        ("POST", f"/workspaces/{ws['id']}/archive", None),
        ("GET", f"/workspaces/{ws['id']}/documents", None),
        ("POST", f"/workspaces/{ws['id']}/search", {"query": "x", "mode": "keyword"}),
    ):
        assert seed.problem(alice.call(method, path, body), 404) == missing, f"{method} {path}"


@_RED_UNTIL_SEARCH
def test_ws_01_ac05_foreign_workspace_ids_are_404_and_leave_it_untouched(seed: Any) -> None:
    alice, mallory = seed.client("ws01-ac05-alice"), seed.client("ws01-ac05-mallory")
    ws = alice.create_workspace("Alice Private")

    missing = seed.problem(mallory.call("PATCH", f"/workspaces/{uuid.uuid4()}", {"name": "x"}), 404)
    for method, path, body in (
        ("PATCH", f"/workspaces/{ws['id']}", {"name": "pwned"}),
        ("DELETE", f"/workspaces/{ws['id']}", None),
        ("POST", f"/workspaces/{ws['id']}/archive", None),
        ("POST", f"/workspaces/{ws['id']}/restore", None),
        ("GET", f"/workspaces/{ws['id']}/documents", None),
        (
            "POST",
            f"/workspaces/{ws['id']}/documents/upload-intent",
            {
                "filename": "a.pdf",
                "size_bytes": 1024,
                "content_type": "application/pdf",
            },
        ),
        ("POST", f"/workspaces/{ws['id']}/search", {"query": "x", "mode": "keyword"}),
    ):
        res = mallory.call(method, path, body)
        assert seed.problem(res, 404) == missing, f"{method} {path}"
        assert "Alice Private" not in res.text

    assert mallory.list_workspaces("active") == []
    mine = alice.list_workspaces("active")
    assert [(w["id"], w["name"], w["status"]) for w in mine] == [
        (ws["id"], "Alice Private", "active")
    ]
