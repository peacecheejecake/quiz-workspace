"""S1a owner share-link API against the local stack: digest-only storage, idempotent issue without
the secret, atomic rotation, authorization and the archived/deleted rules (WS-SHARE-01 AC02-AC05,
owner side only; the guest half is S1b's and stays in test_share_api_contract.py).

Every test runs the production app on ONE admin connection acting as `quiz_api` inside a
transaction that is rolled back at the end (each request gets a savepoint session), so nothing
is committed and the tests do not need the S1a migration on the shared DB: if
`workspace_share_links` does not exist yet it is created inside that transaction. Users are created
before the transaction opens, because the migration's foreign key locks auth.users until rollback.
"""

from __future__ import annotations

import base64
import hashlib
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from quiz_api.db import get_db_session
from quiz_api.main import create_app
from quiz_api.settings import Settings
from sqlalchemy import Connection, create_engine, text
from sqlalchemy.orm import Session

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATION = REPO_ROOT / "supabase/migrations/20261017224000_workspace_share_links.sql"
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
)
WEB = "https://web.s1a.example"
INACTIVE = "urn:quiz-workspace:problem:share-link-inactive"
FUTURE = "2099-01-31T00:00:00Z"


@dataclass
class Tx:
    conn: Connection
    http: TestClient

    def call(
        self, token: str, method: str, path: str, body: Any = None, key: str | None = None
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}"}
        if key is not None:
            headers["Idempotency-Key"] = key
        return self.http.request(method, f"/api/v1{path}", json=body, headers=headers)

    def ok(self, token: str, method: str, path: str, body: Any = None, status: int = 200) -> Any:
        res = self.call(token, method, path, body)
        assert res.status_code == status, f"{method} {path}: {res.status_code} {res.text[:300]}"
        return res.json()

    def workspace(self, token: str) -> str:
        return str(self.ok(token, "POST", "/workspaces", {"name": "s1a"}, 201)["id"])

    def sql(self, statement: str, **params: Any) -> list[Any]:
        result = self.conn.execute(text(statement), params)
        return list(result) if result.returns_rows else []


@contextmanager
def _rolled_back_app() -> Iterator[Tx]:
    engine = create_engine(DB_ADMIN_URL.replace("postgresql://", "postgresql+psycopg://"))
    try:
        with engine.connect() as conn:
            trans = conn.begin()
            try:
                exists = conn.execute(text("select to_regclass('public.workspace_share_links')"))
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
        WEB_ORIGIN=WEB,
    )
    app = create_app(settings, readiness_checkers=[])

    def session() -> Iterator[Session]:
        with Session(bind=conn, join_transaction_mode="create_savepoint") as s:
            try:
                yield s
            except Exception:
                s.rollback()
                raise

    app.dependency_overrides[get_db_session] = session
    return TestClient(app, raise_server_exceptions=False)


def _problem(res: httpx.Response, status: int, problem_type: str = "about:blank") -> None:
    assert res.status_code == status, f"expected {status}, got {res.status_code}: {res.text[:300]}"
    assert res.json()["type"] == problem_type


def _raw(secret: str) -> bytes:
    return base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))


def test_issue_stores_only_the_sha256_digest_and_never_logs_the_secret(seed: Any) -> None:
    owner = seed.client("s1a-digest")
    token = owner.user.token
    with _rolled_back_app() as tx:
        ws = tx.workspace(token)
        res = tx.call(token, "POST", f"/workspaces/{ws}/share-links", {}, key="issue-1")
        assert res.status_code == 201, res.text
        assert res.headers["cache-control"] == "no-store"
        link = res.json()
        secret = link["secret"]
        assert len(_raw(secret)) == 32
        assert link["share_url"] == f"{WEB}/share/{link['id']}#k={secret}"

        (row,) = tx.sql(
            "select row_to_json(l)::text, token_digest, created_by::text "
            "from public.workspace_share_links l where id = :id",
            id=link["id"],
        )
        assert (secret in row[0]) is False
        assert bytes(row[1]) == hashlib.sha256(_raw(secret)).digest()
        assert row[2] == owner.user.id
        stored = tx.sql(
            "select response_body::text from public.idempotency_keys where user_id = :u",
            u=owner.user.id,
        )
        assert len(stored) == 1
        assert (secret in stored[0][0]) is False
        events = tx.sql(
            "select event_type, target_type, metadata::text from public.activity_events "
            "where workspace_id = :w and target_type = 'share_link'",
            w=ws,
        )
        assert [(e[0], e[1]) for e in events] == [("share_link.created", "share_link")]
        assert (secret in events[0][2]) is False

        # Replay: same link, no secret, nothing new written.
        again = tx.call(token, "POST", f"/workspaces/{ws}/share-links", {}, key="issue-1")
        assert again.status_code == 201
        assert again.headers["idempotent-replayed"] == "true"
        body = again.json()
        assert (body["id"], body["secret"], body["share_url"]) == (link["id"], None, None)
        assert body["secret_already_issued"] is True
        assert (secret in again.text) is False
        count = tx.sql(
            "select count(*) from public.workspace_share_links where workspace_id = :w", w=ws
        )
        assert count[0][0] == 1

        listed = tx.call(token, "GET", f"/workspaces/{ws}/share-links")
        assert (secret in listed.text) is False
        assert [i["id"] for i in listed.json()["items"]] == [link["id"]]
        # A link is not a membership.
        members = tx.sql(
            "select user_id::text from public.workspace_memberships where workspace_id = :w", w=ws
        )
        assert members == [(owner.user.id,)]


def test_rotate_revokes_and_replaces_atomically(seed: Any) -> None:
    owner = seed.client("s1a-rotate")
    token = owner.user.token
    with _rolled_back_app() as tx:
        ws = tx.workspace(token)
        base = f"/workspaces/{ws}/share-links"
        first = tx.ok(token, "POST", base, {"allow_fork": True, "expires_at": FUTURE}, 201)
        second = tx.ok(token, "POST", f"{base}/{first['id']}/rotate", None, 201)
        assert second["id"] != first["id"]
        assert (second["secret"] == first["secret"]) is False
        assert second["rotated_from_id"] == first["id"]
        assert second["allow_fork"] is True
        assert second["expires_at"].startswith("2099-01-31")

        # (One transaction shares one now(), so "newest first" is not observable here.)
        items = {i["id"]: i for i in tx.ok(token, "GET", base)["items"]}
        assert set(items) == {second["id"], first["id"]}
        assert items[first["id"]]["status"] == "revoked"
        assert items[first["id"]]["revoked_at"] is not None
        assert items[second["id"]]["status"] == "active"
        digests = tx.sql(
            "select count(distinct token_digest) from public.workspace_share_links "
            "where workspace_id = :w",
            w=ws,
        )
        assert digests[0][0] == 2

        _problem(tx.call(token, "POST", f"{base}/{first['id']}/rotate"), 409, INACTIVE)
        _problem(
            tx.call(token, "PATCH", f"{base}/{first['id']}", {"allow_fork": False}), 409, INACTIVE
        )
        revoked = tx.ok(token, "POST", f"{base}/{second['id']}/revoke")
        assert revoked["status"] == "revoked"
        assert (
            tx.ok(token, "POST", f"{base}/{second['id']}/revoke")["revoked_at"]
            == (revoked["revoked_at"])
        )
        events = tx.sql(
            "select event_type, target_id::text from public.activity_events "
            "where workspace_id = :w and target_type = 'share_link' order by created_at, id",
            w=ws,
        )
        # One transaction shares one now(): compare as a multiset.
        assert sorted(events) == sorted(
            [
                ("share_link.created", first["id"]),
                ("share_link.rotated", first["id"]),
                ("share_link.revoked", second["id"]),
            ]
        )


def test_policy_changes_and_expiry(seed: Any) -> None:
    owner = seed.client("s1a-policy")
    token = owner.user.token
    with _rolled_back_app() as tx:
        ws = tx.workspace(token)
        base = f"/workspaces/{ws}/share-links"
        link = tx.ok(token, "POST", base, {}, 201)
        url = f"{base}/{link['id']}"
        patched = tx.ok(token, "PATCH", url, {"allow_fork": True, "expires_at": FUTURE})
        assert (patched["allow_fork"], patched["status"]) == (True, "active")
        _problem(tx.call(token, "PATCH", url, {"expires_at": "2000-01-01T00:00:00Z"}), 422)

        tx.sql(
            "update public.workspace_share_links set expires_at = now() - interval '1 minute' "
            "where id = :id",
            id=link["id"],
        )
        assert tx.ok(token, "GET", base)["items"][0]["status"] == "expired"
        _problem(tx.call(token, "POST", f"{url}/rotate"), 409, INACTIVE)
        # The owner can bring an expired link back with a new expiry, or drop the expiry.
        assert tx.ok(token, "PATCH", url, {"expires_at": FUTURE})["status"] == "active"
        cleared = tx.ok(token, "PATCH", url, {"expires_at": None})
        assert (cleared["expires_at"], cleared["allow_fork"]) == (None, True)
        types = tx.sql(
            "select metadata from public.activity_events "
            "where workspace_id = :w and event_type = 'share_link.updated'",
            w=ws,
        )
        assert len(types) == 3
        first_change = {"allow_fork": True, "expires_at": "2099-01-31T00:00:00+00:00"}
        assert first_change in [t[0] for t in types]


def test_owner_only_and_archived_and_deleted_rules(seed: Any) -> None:
    owner, editor, stranger = (seed.client(f"s1a-authz-{r}") for r in ("o", "e", "s"))
    with _rolled_back_app() as tx:
        ws = tx.workspace(owner.user.token)
        tx.sql(
            "insert into public.workspace_memberships (workspace_id, user_id, role) "
            "values (:w, :u, 'editor')",
            w=ws,
            u=editor.user.id,
        )
        base = f"/workspaces/{ws}/share-links"
        link = tx.ok(owner.user.token, "POST", base, {}, 201)["id"]
        routes = [
            ("GET", base, None),
            ("POST", base, {}),
            ("PATCH", f"{base}/{link}", {"allow_fork": True}),
            ("POST", f"{base}/{link}/revoke", None),
            ("POST", f"{base}/{link}/rotate", None),
        ]
        for method, path, body in routes:
            _problem(
                tx.call(editor.user.token, method, path, body),
                403,
                "urn:quiz-workspace:problem:insufficient-role",
            )
            _problem(tx.call(stranger.user.token, method, path, body), 404)
        # A link id under another workspace of the same owner is not found.
        other = tx.workspace(owner.user.token)
        _problem(
            tx.call(owner.user.token, "POST", f"/workspaces/{other}/share-links/{link}/revoke"), 404
        )

        tx.ok(owner.user.token, "POST", f"/workspaces/{ws}/archive")
        archived = "urn:quiz-workspace:problem:workspace-archived"
        _problem(tx.call(owner.user.token, "POST", base, {}), 403, archived)
        _problem(tx.call(owner.user.token, "POST", f"{base}/{link}/rotate"), 403, archived)
        tx.ok(owner.user.token, "PATCH", f"{base}/{link}", {"allow_fork": True})
        tx.ok(owner.user.token, "POST", f"{base}/{link}/revoke")
        assert tx.ok(owner.user.token, "GET", base)["items"][0]["status"] == "revoked"

        tx.call(owner.user.token, "DELETE", f"/workspaces/{ws}")
        for method, path, body in routes:
            _problem(tx.call(owner.user.token, method, path, body), 404)
