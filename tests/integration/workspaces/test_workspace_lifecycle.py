"""M3.1a workspace API against the local stack: lifecycle, roles, activity, idempotency.

Complements the WS-01 contract tests (test_workspace_api_contract.py) with the workspace-only
guarantees that do not depend on later document/search endpoints. Fixtures: conftest.py.

The idempotency tests run the app on ONE connection inside a transaction that is rolled back at
the end (each request gets a savepoint session), so they need no committed `idempotency_keys`
table: if the M3.1a migration is not applied to the local DB yet, it is applied inside that
transaction and disappears with it.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from quiz_api.db import get_db_session
from quiz_api.main import create_app
from quiz_api.settings import Settings
from sqlalchemy import Connection, create_engine, text
from sqlalchemy.orm import Session

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATION = REPO_ROOT / "supabase/migrations/20261017190000_idempotency_keys.sql"
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
)
REUSED = "urn:quiz-workspace:problem:idempotency-key-reused"


def _events(workspace_id: str) -> list[tuple[str, str | None, dict[str, Any]]]:
    with psycopg.connect(DB_ADMIN_URL) as conn:
        rows = conn.execute(
            "select event_type, actor_id::text, metadata from public.activity_events "
            "where workspace_id = %s and target_type = 'workspace' and target_id = %s "
            "order by created_at, id",
            (workspace_id, workspace_id),
        ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def _row(workspace_id: str) -> dict[str, Any]:
    with psycopg.connect(DB_ADMIN_URL) as conn:
        row = conn.execute(
            "select name, status, archived_at, deleted_at from public.workspaces where id = %s",
            (workspace_id,),
        ).fetchone()
    assert row is not None
    return dict(zip(("name", "status", "archived_at", "deleted_at"), row, strict=True))


# --- lifecycle ----------------------------------------------------------------------------------


def test_create_validates_and_trims_the_name(seed: Any) -> None:
    alice = seed.client("m31a-name")
    assert alice.create_workspace("  Trimmed  ")["name"] == "Trimmed"
    assert alice.create_workspace("가" * 200)["name"] == "가" * 200
    for body in (
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 201},
        {"name": "line\nbreak"},
        {},
        {"name": "ok", "owner_id": str(uuid.uuid4())},
    ):
        seed.problem(alice.call("POST", "/workspaces", body), 422)
    assert len(alice.list_workspaces("active")) == 2


def test_get_returns_the_workspace_with_the_callers_role(seed: Any) -> None:
    alice = seed.client("m31a-get")
    ws = alice.create_workspace("Getter")
    got = alice.ok("GET", f"/workspaces/{ws['id']}")
    assert got == ws
    assert set(got) == {"id", "name", "role", "status", "archived_at", "created_at", "updated_at"}


def test_archive_restore_rename_and_their_repeats(seed: Any) -> None:
    alice = seed.client("m31a-cycle")
    ws = alice.create_workspace("Cycle")
    wid = ws["id"]

    archived = alice.ok("POST", f"/workspaces/{wid}/archive")
    assert (archived["status"], archived["role"]) == ("archived", "owner")
    assert archived["archived_at"] is not None
    # Repeating archive is a no-op: same timestamp, no new event.
    again = alice.ok("POST", f"/workspaces/{wid}/archive")
    assert again["archived_at"] == archived["archived_at"]
    assert alice.ok("GET", f"/workspaces/{wid}")["status"] == "archived"
    seed.problem(alice.call("PATCH", f"/workspaces/{wid}", {"name": "nope"}), 403, seed.ARCHIVED)

    restored = alice.ok("POST", f"/workspaces/{wid}/restore")
    assert (restored["status"], restored["archived_at"]) == ("active", None)
    assert alice.ok("POST", f"/workspaces/{wid}/restore")["status"] == "active"

    assert alice.ok("PATCH", f"/workspaces/{wid}", {"name": "Renamed"})["name"] == "Renamed"
    # Same name again: no change, no event.
    assert alice.ok("PATCH", f"/workspaces/{wid}", {"name": " Renamed "})["name"] == "Renamed"
    seed.problem(alice.call("PATCH", f"/workspaces/{wid}", {"name": " "}), 422)

    alice.ok("DELETE", f"/workspaces/{wid}", expected=(204,))

    user = alice.user.id
    assert _events(wid) == [
        ("workspace.created", user, {"name": "Cycle"}),
        ("workspace.archived", user, {}),
        ("workspace.restored", user, {}),
        ("workspace.renamed", user, {"previous_name": "Cycle", "name": "Renamed"}),
        ("workspace.deleted", user, {"previous_status": "active"}),
    ]


def test_soft_delete_hides_the_workspace_everywhere(seed: Any) -> None:
    alice = seed.client("m31a-delete")
    ws = alice.create_workspace("Doomed")
    wid = ws["id"]
    alice.ok("POST", f"/workspaces/{wid}/archive")
    res = alice.call("DELETE", f"/workspaces/{wid}")
    assert (res.status_code, res.content) == (204, b"")

    row = _row(wid)
    assert row["status"] == "deleted"
    assert row["deleted_at"] is not None
    assert row["archived_at"] is not None, "archived_at is kept when deleting from archived"
    assert _events(wid)[-1][2] == {"previous_status": "archived"}

    assert alice.list_workspaces("active") == []
    assert alice.list_workspaces("archived") == []
    assert alice.ok("GET", "/me/workspaces")["items"] == []
    missing = seed.problem(alice.call("GET", f"/workspaces/{uuid.uuid4()}"), 404)
    for method, path, body in (
        ("GET", f"/workspaces/{wid}", None),
        ("PATCH", f"/workspaces/{wid}", {"name": "x"}),
        ("POST", f"/workspaces/{wid}/archive", None),
        ("POST", f"/workspaces/{wid}/restore", None),
        ("DELETE", f"/workspaces/{wid}", None),
    ):
        assert seed.problem(alice.call(method, path, body), 404) == missing, f"{method} {path}"
    assert len(_events(wid)) == 3, "no event for rejected calls"


def test_foreign_workspace_is_404_for_every_lifecycle_route(seed: Any) -> None:
    alice, mallory = seed.client("m31a-alice"), seed.client("m31a-mallory")
    ws = alice.create_workspace("Alice Only")
    wid = ws["id"]
    missing = seed.problem(mallory.call("GET", f"/workspaces/{uuid.uuid4()}"), 404)
    for method, path, body in (
        ("GET", f"/workspaces/{wid}", None),
        ("PATCH", f"/workspaces/{wid}", {"name": "pwned"}),
        ("PATCH", f"/workspaces/{wid}", {"name": ""}),
        ("POST", f"/workspaces/{wid}/archive", None),
        ("POST", f"/workspaces/{wid}/restore", None),
        ("DELETE", f"/workspaces/{wid}", None),
    ):
        res = mallory.call(method, path, body)
        assert seed.problem(res, 404) == missing, f"{method} {path}"
        assert "Alice Only" not in res.text
    assert mallory.list_workspaces("active") == []
    assert _row(wid)["status"] == "active"
    assert alice.ok("GET", f"/workspaces/{wid}") == ws
    assert [e[0] for e in _events(wid)] == ["workspace.created"]


@pytest.mark.parametrize("role", ["editor", "viewer"])
def test_non_owner_members_can_read_but_not_manage(seed: Any, role: str) -> None:
    alice, bob = seed.client(f"m31a-owner-{role}"), seed.client(f"m31a-{role}")
    ws = alice.create_workspace("Shared")
    wid = ws["id"]
    seed.membership(wid, bob.user, role)

    assert bob.ok("GET", f"/workspaces/{wid}")["role"] == role
    assert [(w["id"], w["role"]) for w in bob.list_workspaces("active")] == [(wid, role)]
    for method, path, body in (
        ("PATCH", f"/workspaces/{wid}", {"name": "x"}),
        ("POST", f"/workspaces/{wid}/archive", None),
        ("POST", f"/workspaces/{wid}/restore", None),
        ("DELETE", f"/workspaces/{wid}", None),
    ):
        seed.problem(bob.call(method, path, body), 403, seed.INSUFFICIENT_ROLE)

    alice.ok("POST", f"/workspaces/{wid}/archive")
    assert [w["id"] for w in bob.list_workspaces("archived")] == [wid]
    assert bob.ok("GET", f"/workspaces/{wid}")["status"] == "archived"
    assert [e[0] for e in _events(wid)] == ["workspace.created", "workspace.archived"]


def test_archived_list_is_ordered_by_archive_time(seed: Any) -> None:
    alice = seed.client("m31a-order")
    first, second, third = (alice.create_workspace(n) for n in ("first", "second", "third"))
    assert [w["id"] for w in alice.list_workspaces("active")] == [
        third["id"],
        second["id"],
        first["id"],
    ]
    for ws in (second, first):
        alice.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert [w["id"] for w in alice.list_workspaces("archived")] == [first["id"], second["id"]]
    seed.problem(alice.call("GET", "/workspaces?status=deleted"), 422)


# --- idempotency (rolled-back transaction) ------------------------------------------------------
# Users are created *before* the transaction opens: applying the migration in it takes a lock on
# auth.users (the new foreign key) that would block the Auth admin API until rollback.


@dataclass
class Tx:
    conn: Connection
    http: TestClient

    def post(self, token: str, body: Any, key: str | None) -> Any:
        headers = {"Authorization": f"Bearer {token}"}
        if key is not None:
            headers["Idempotency-Key"] = key
        return self.http.post("/api/v1/workspaces", json=body, headers=headers)

    def lifecycle(self, token: str, workspace_id: str, action: str, key: str | None) -> Any:
        headers = {"Authorization": f"Bearer {token}"}
        if key is not None:
            headers["Idempotency-Key"] = key
        return self.http.post(f"/api/v1/workspaces/{workspace_id}/{action}", headers=headers)

    def events(self, workspace_id: str) -> list[str]:
        rows = self.conn.execute(
            text(
                "select event_type from public.activity_events where workspace_id = :w "
                "order by created_at, id"
            ),
            {"w": workspace_id},
        )
        return [r[0] for r in rows]

    def status(self, workspace_id: str) -> str:
        return str(
            self.conn.execute(
                text("select status from public.workspaces where id = :w"), {"w": workspace_id}
            ).scalar_one()
        )

    def count(self, user_id: str) -> int:
        return int(
            self.conn.execute(
                text("select count(*) from public.workspaces where owner_id = :u"), {"u": user_id}
            ).scalar_one()
        )


@contextmanager
def _rolled_back_app() -> Iterator[Tx]:
    """The production app on one admin connection acting as `quiz_api`; always rolled back."""
    engine = create_engine(DB_ADMIN_URL.replace("postgresql://", "postgresql+psycopg://"))
    try:
        with engine.connect() as conn:
            trans = conn.begin()
            try:
                exists = conn.execute(text("select to_regclass('public.idempotency_keys')"))
                if exists.scalar() is None:
                    conn.exec_driver_sql(MIGRATION.read_text())
                conn.exec_driver_sql("grant quiz_api to postgres")
                conn.exec_driver_sql("set local role quiz_api")
                yield Tx(conn, _client(conn))
            finally:
                trans.rollback()
    finally:
        engine.dispose()


def _client(conn: Connection) -> TestClient:
    settings = Settings(
        DATABASE_URL=API_DATABASE_URL,
        SUPABASE_JWT_ISSUER=ISSUER,
        SUPABASE_JWKS_URL=f"{ISSUER}/.well-known/jwks.json",
    )
    app = create_app(settings, readiness_checkers=[])

    def session() -> Iterator[Session]:
        # Each request: a savepoint; the route's commit releases it, errors roll it back.
        with Session(bind=conn, join_transaction_mode="create_savepoint") as s:
            try:
                yield s
            except Exception:
                s.rollback()
                raise

    app.dependency_overrides[get_db_session] = session
    return TestClient(app, raise_server_exceptions=False)


def test_idempotency_key_replays_the_first_response(seed: Any) -> None:
    alice = seed.client("m31a-idem")
    token, key = alice.user.token, f"create-{uuid.uuid4()}"
    with _rolled_back_app() as tx:
        first = tx.post(token, {"name": "Once"}, key)
        assert first.status_code == 201, first.text
        assert "Idempotent-Replayed" not in first.headers
        retry = tx.post(token, {"name": " Once "}, key)
        assert retry.status_code == 201
        assert retry.headers["Idempotent-Replayed"] == "true"
        assert retry.json() == first.json()
        assert tx.count(alice.user.id) == 1
        events = tx.conn.execute(
            text("select count(*) from public.activity_events where workspace_id = :w"),
            {"w": first.json()["id"]},
        ).scalar_one()
        assert events == 1

        reused = tx.post(token, {"name": "Twice"}, key)
        seed.problem(reused, 409, REUSED)
        assert "Once" not in reused.text
        assert tx.count(alice.user.id) == 1

        # Without a key every POST creates; a new key creates once more.
        assert tx.post(token, {"name": "Once"}, None).status_code == 201
        assert tx.post(token, {"name": "Once"}, f"other-{uuid.uuid4()}").status_code == 201
        assert tx.count(alice.user.id) == 3


def test_idempotency_key_is_scoped_per_user_and_expires(seed: Any) -> None:
    alice, bob = seed.client("m31a-idem-a"), seed.client("m31a-idem-b")
    key = f"shared-{uuid.uuid4()}"
    with _rolled_back_app() as tx:
        a = tx.post(alice.user.token, {"name": "Alice"}, key)
        b = tx.post(bob.user.token, {"name": "Bob"}, key)
        assert (a.status_code, b.status_code) == (201, 201)
        assert a.json()["id"] != b.json()["id"]
        assert "Idempotent-Replayed" not in b.headers

        tx.conn.execute(
            text(
                "update public.idempotency_keys set created_at = now() - interval '2 days', "
                "expires_at = now() - interval '1 day' where user_id = :u"
            ),
            {"u": alice.user.id},
        )
        again = tx.post(alice.user.token, {"name": "Alice"}, key)
        assert again.status_code == 201
        assert "Idempotent-Replayed" not in again.headers
        assert again.json()["id"] != a.json()["id"]
        assert tx.count(alice.user.id) == 2


def test_invalid_idempotency_keys_are_rejected(seed: Any) -> None:
    alice = seed.client("m31a-idem-bad")
    with _rolled_back_app() as tx:
        for key in ("has space", "x" * 201, ""):
            seed.problem(tx.post(alice.user.token, {"name": "Bad"}, key), 422)
        assert tx.count(alice.user.id) == 0


# Events inside one transaction share `now()`, so they are compared as multisets.


@pytest.mark.parametrize(("action", "opposite"), [("archive", "restore"), ("restore", "archive")])
def test_lost_lifecycle_response_is_replayed_without_redoing_it(
    seed: Any, action: str, opposite: str
) -> None:
    alice = seed.client(f"m31a-idem-{action}")
    token, key = alice.user.token, f"{action}-{uuid.uuid4()}"
    with _rolled_back_app() as tx:
        wid = tx.post(token, {"name": "Lifecycle"}, None).json()["id"]
        if action == "restore":
            assert tx.lifecycle(token, wid, "archive", None).status_code == 200
        first = tx.lifecycle(token, wid, action, key)
        assert first.status_code == 200, first.text
        # Response lost; the opposite action happens in between; then the client retries.
        assert tx.lifecycle(token, wid, opposite, None).status_code == 200
        state, events = tx.status(wid), sorted(tx.events(wid))

        retry = tx.lifecycle(token, wid, action, key)
        assert retry.status_code == 200
        assert retry.headers["Idempotent-Replayed"] == "true"
        assert retry.json() == first.json()
        assert tx.status(wid) == state, "the replay does not redo the action"
        assert sorted(tx.events(wid)) == events, "the replay records no event"

        # Same key on the other action of this workspace: 409; on another workspace: independent.
        seed.problem(tx.lifecycle(token, wid, opposite, key), 409, REUSED)
        other = tx.post(token, {"name": "Other"}, None).json()["id"]
        if action == "restore":
            assert tx.lifecycle(token, other, "archive", None).status_code == 200
        independent = tx.lifecycle(token, other, action, key)
        assert independent.status_code == 200
        assert "Idempotent-Replayed" not in independent.headers
        assert independent.json()["id"] == other
        assert tx.status(other) == ("archived" if action == "archive" else "active")


def test_lifecycle_replay_after_delete_is_404(seed: Any) -> None:
    alice = seed.client("m31a-idem-deleted")
    token, key = alice.user.token, f"gone-{uuid.uuid4()}"
    with _rolled_back_app() as tx:
        wid = tx.post(token, {"name": "Gone"}, None).json()["id"]
        assert tx.lifecycle(token, wid, "archive", key).status_code == 200
        delete = tx.http.delete(
            f"/api/v1/workspaces/{wid}", headers={"Authorization": f"Bearer {token}"}
        )
        assert delete.status_code == 204
        seed.problem(tx.lifecycle(token, wid, "archive", key), 404)
