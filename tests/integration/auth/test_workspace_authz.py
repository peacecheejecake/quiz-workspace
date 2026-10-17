"""A1.3 workspace authorization and profile upsert against the local stack (AUTH-API-AC02 basis).

The authorization dependencies are exercised through test-only probe routes mounted on an
in-process `create_app` (never part of the production router), wired exactly like production:
real Supabase Auth tokens verified over the local JWKS, and the DB reached as the least-privilege
`quiz_api` role. Users come from the local Auth admin API; workspaces, memberships and jobs are
seeded with the `postgres` superuser and removed afterwards (same pattern as the A0 AC02 tests).

Needs `make infra-up` plus the one-time `quiz_api` login step (AGENTS.md §7). Without the stack
these skip with a reason; `make test-infra` (QUIZ_REQUIRE_INFRA=1) fails instead.
"""

import json
import os
import subprocess
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient
from pydantic import BaseModel, SecretStr
from quiz_api.authz import (
    Action,
    LockMode,
    ResourceAccess,
    ResourceType,
    SqlAccessRepository,
    WorkspaceAccess,
    authorize_workspace,
    require_resource_access,
    require_workspace_access,
)
from quiz_api.db import create_database
from quiz_api.errors import ProblemType
from quiz_api.main import create_app
from quiz_api.repositories.me import MeRepository, UnknownUserError
from quiz_api.settings import Settings
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
)
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
BASE = "/api/v1/authz-probe"
PROBLEM = "application/problem+json"


def _require_infra(reason: str) -> None:
    if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
        pytest.fail(reason)
    pytest.skip(reason)


# --------------------------------------------------------------------------------------------
# Test-only probe routes
# --------------------------------------------------------------------------------------------
class Probe(BaseModel):
    workspace_id: uuid.UUID
    role: str
    status: str


class ClaimedWorkspace(BaseModel):
    workspace_id: uuid.UUID | None = None


def _probe(access: WorkspaceAccess) -> Probe:
    return Probe(workspace_id=access.workspace_id, role=access.role, status=access.status)


def probe_router() -> APIRouter:
    router = APIRouter(prefix="/authz-probe")
    read = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.READ))]
    practice = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.PRACTICE))]
    edit = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.DOCUMENT_EDIT))]
    restore = Annotated[
        WorkspaceAccess, Depends(require_workspace_access(Action.WORKSPACE_RESTORE))
    ]
    job = Annotated[
        ResourceAccess,
        Depends(require_resource_access(ResourceType.JOB, Action.READ, param="job_id")),
    ]
    nested_job = Annotated[
        ResourceAccess,
        Depends(
            require_resource_access(
                ResourceType.JOB, Action.READ, param="job_id", workspace_param="workspace_id"
            )
        ),
    ]

    @router.get("/workspaces/{workspace_id}")
    def get_workspace(access: read) -> Probe:
        return _probe(access)

    @router.post("/workspaces/{workspace_id}/practice")
    def post_practice(access: practice) -> Probe:
        return _probe(access)

    @router.post("/workspaces/{workspace_id}/documents")
    def post_document(access: edit, body: ClaimedWorkspace) -> Probe:
        access.ensure_same_workspace(body.workspace_id)
        return _probe(access)

    @router.post("/workspaces/{workspace_id}/restore")
    def post_restore(access: restore) -> Probe:
        return _probe(access)

    @router.get("/jobs/{job_id}")
    def get_job(access: job) -> Probe:
        return _probe(access.workspace)

    @router.get("/workspaces/{workspace_id}/jobs/{job_id}")
    def get_nested_job(access: nested_job) -> Probe:
        return _probe(access.workspace)

    return router


# --------------------------------------------------------------------------------------------
# Stack, seed data, app
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Stack:
    auth: httpx.Client
    admin: httpx.Client


def _keys() -> tuple[str, str]:
    publishable = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    secret = os.environ.get("SUPABASE_SECRET_KEY", "")
    if publishable and secret:
        return publishable, secret
    out = subprocess.run(
        ["pnpm", "exec", "supabase", "status", "-o", "json"],  # noqa: S607 (pinned CLI via pnpm)
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    status: dict[str, Any] = json.loads(out[out.index("{") :])
    return publishable or str(status["PUBLISHABLE_KEY"]), secret or str(status["SECRET_KEY"])


@pytest.fixture(scope="module")
def stack() -> Iterator[Stack]:
    for url in (SUPABASE_URL, DB_ADMIN_URL, API_DATABASE_URL):
        assert urlsplit(url).hostname in LOOPBACK, f"refusing non-local {urlsplit(url).hostname}"
    try:
        httpx.get(f"{ISSUER}/health", timeout=3).raise_for_status()
        with psycopg.connect(API_DATABASE_URL, connect_timeout=3) as conn:
            conn.execute("select 1 from public.workspaces limit 1")
    except (httpx.HTTPError, psycopg.Error) as exc:
        _require_infra(
            f"local stack not reachable ({exc.__class__.__name__}); run `make infra-up` and the "
            "one-time quiz_api login step (AGENTS.md §7)"
        )
    publishable, secret = _keys()
    with (
        httpx.Client(base_url=ISSUER, timeout=15, headers={"apikey": publishable}) as auth,
        httpx.Client(base_url=f"{ISSUER}/admin", timeout=15, headers={"apikey": secret}) as admin,
    ):
        yield Stack(auth=auth, admin=admin)


@dataclass
class User:
    id: str
    email: str
    password: str = field(repr=False)
    token: str = field(default="", repr=False)

    @property
    def uuid(self) -> uuid.UUID:
        return uuid.UUID(self.id)

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


class Seed:
    def __init__(self, stack: Stack) -> None:
        self._stack = stack
        self._users: list[str] = []
        self._workspaces: list[str] = []

    def user(self, label: str) -> User:
        email = f"authz-{label}-{uuid.uuid4().hex}@example.test"
        password = f"pw-{uuid.uuid4().hex}"
        res = self._stack.admin.post(
            "/users", json={"email": email, "password": password, "email_confirm": True}
        )
        assert res.status_code == 200, f"create user failed: HTTP {res.status_code}"
        user = User(res.json()["id"], email, password)
        self._users.append(user.id)
        signed_in = self._stack.auth.post(
            "/token", params={"grant_type": "password"}, json={"email": email, "password": password}
        )
        assert signed_in.status_code == 200, f"sign in failed: HTTP {signed_in.status_code}"
        user.token = signed_in.json()["access_token"]
        return user

    def delete_user(self, user: User) -> None:
        res = self._stack.admin.delete(f"/users/{user.id}")
        assert res.status_code in {200, 204}, f"delete user: HTTP {res.status_code}"

    def workspace(self, owner: User, *, status: str = "active", **members: User) -> str:
        """`members` maps a role (editor/viewer) to a user, e.g. `viewer=bob`."""
        archived = "now()" if status in {"archived", "deleted"} else "null"
        deleted = "now()" if status == "deleted" else "null"
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            row = conn.execute(
                "insert into public.workspaces (name, owner_id, status, archived_at, deleted_at) "  # noqa: S608 (fixed SQL fragments)
                f"values (%s, %s, %s, {archived}, {deleted}) returning id",
                (f"authz {owner.email}", owner.id, status),
            ).fetchone()
            assert row is not None
            workspace_id = str(row[0])
            self._workspaces.append(workspace_id)
            roles = [("owner", owner), *((role, user) for role, user in members.items())]
            for role, user in roles:
                conn.execute(
                    "insert into public.workspace_memberships (workspace_id, user_id, role) "
                    "values (%s, %s, %s)",
                    (workspace_id, user.id, role),
                )
        return workspace_id

    def job(self, workspace_id: str, creator: User) -> str:
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            row = conn.execute(
                "insert into public.async_jobs (workspace_id, created_by, job_type) "
                "values (%s, %s, 'test.authz') returning id",
                (workspace_id, creator.id),
            ).fetchone()
            assert row is not None
            return str(row[0])

    def cleanup(self) -> None:
        if self._workspaces:
            with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
                conn.execute(
                    "delete from public.workspaces where id = any(%s::uuid[])", (self._workspaces,)
                )
        for user_id in self._users:
            res = self._stack.admin.delete(f"/users/{user_id}")
            assert res.status_code in {200, 204, 404}, f"delete user: HTTP {res.status_code}"


@pytest.fixture
def seed(stack: Stack) -> Iterator[Seed]:
    s = Seed(stack)
    try:
        yield s
    finally:
        s.cleanup()


def _settings() -> Settings:
    return Settings.model_construct(
        database_url=SecretStr(API_DATABASE_URL),
        supabase_jwt_issuer=ISSUER,
        supabase_jwks_url=JWKS_URL,
    )


@pytest.fixture(scope="module")
def api(stack: Stack) -> Iterator[TestClient]:
    app = create_app(_settings(), readiness_checkers=[])
    app.include_router(probe_router(), prefix="/api/v1")
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture(scope="module")
def database(stack: Stack) -> Iterator[Any]:
    database = create_database(_settings())
    assert database is not None
    try:
        yield database
    finally:
        database.dispose()


def _problem(res: httpx.Response, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    assert res.status_code == status, f"expected {status}, got {res.status_code}: {res.text[:300]}"
    assert res.headers["content-type"] == PROBLEM
    body: dict[str, Any] = res.json()
    assert body["type"] == problem_type
    return {k: v for k, v in body.items() if k not in {"instance", "request_id"}}


# --------------------------------------------------------------------------------------------
# Workspace routes
# --------------------------------------------------------------------------------------------
def test_members_read_and_non_members_get_404(api: TestClient, seed: Seed) -> None:
    owner, editor, viewer, stranger = (seed.user(r) for r in ("own", "edit", "view", "stranger"))
    ws = seed.workspace(owner, editor=editor, viewer=viewer)

    for user, role in ((owner, "owner"), (editor, "editor"), (viewer, "viewer")):
        res = api.get(f"{BASE}/workspaces/{ws}", headers=user.headers())
        assert res.status_code == 200, res.text
        assert res.json() == {"workspace_id": ws, "role": role, "status": "active"}

    # Not a member vs. no such workspace: indistinguishable.
    foreign = _problem(api.get(f"{BASE}/workspaces/{ws}", headers=stranger.headers()), 404)
    missing = _problem(
        api.get(f"{BASE}/workspaces/{uuid.uuid4()}", headers=stranger.headers()), 404
    )
    assert foreign == missing
    assert ws not in json.dumps(foreign)
    write = api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=stranger.headers())
    assert _problem(write, 404) == foreign


def test_roles_limit_writes_with_403(api: TestClient, seed: Seed) -> None:
    owner, editor, viewer = (seed.user(r) for r in ("own", "edit", "view"))
    ws = seed.workspace(owner, editor=editor, viewer=viewer)
    docs = f"{BASE}/workspaces/{ws}/documents"

    assert api.post(docs, json={}, headers=owner.headers()).status_code == 200
    assert api.post(docs, json={}, headers=editor.headers()).status_code == 200
    _problem(api.post(docs, json={}, headers=viewer.headers()), 403, ProblemType.INSUFFICIENT_ROLE)
    # Viewers still practise; only the owner restores.
    practice = f"{BASE}/workspaces/{ws}/practice"
    assert api.post(practice, headers=viewer.headers()).status_code == 200
    restore = f"{BASE}/workspaces/{ws}/restore"
    _problem(api.post(restore, headers=editor.headers()), 403, ProblemType.INSUFFICIENT_ROLE)


def test_archived_workspace_is_read_only(api: TestClient, seed: Seed) -> None:
    owner, viewer = seed.user("own"), seed.user("view")
    ws = seed.workspace(owner, status="archived", viewer=viewer)

    for user in (owner, viewer):
        res = api.get(f"{BASE}/workspaces/{ws}", headers=user.headers())
        assert res.status_code == 200, res.text
        assert res.json()["status"] == "archived"
    for user in (owner, viewer):
        _problem(
            api.post(f"{BASE}/workspaces/{ws}/practice", headers=user.headers()),
            403,
            ProblemType.WORKSPACE_ARCHIVED,
        )
    _problem(
        api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=owner.headers()),
        403,
        ProblemType.WORKSPACE_ARCHIVED,
    )
    assert api.post(f"{BASE}/workspaces/{ws}/restore", headers=owner.headers()).status_code == 200


@pytest.mark.parametrize("previous", ["active", "archived"])
def test_soft_deleted_workspace_is_404_even_for_the_owner(
    api: TestClient, seed: Seed, previous: str
) -> None:
    owner = seed.user("own")
    ws = seed.workspace(owner, status="deleted")
    if previous == "active":
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            conn.execute("update public.workspaces set archived_at = null where id = %s", (ws,))

    missing = _problem(api.get(f"{BASE}/workspaces/{uuid.uuid4()}", headers=owner.headers()), 404)
    for res in (
        api.get(f"{BASE}/workspaces/{ws}", headers=owner.headers()),
        api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=owner.headers()),
        api.post(f"{BASE}/workspaces/{ws}/restore", headers=owner.headers()),
    ):
        assert _problem(res, 404) == missing


def test_client_supplied_workspace_id_must_match(api: TestClient, seed: Seed) -> None:
    alice, bob = seed.user("alice"), seed.user("bob")
    alice_ws, bob_ws = seed.workspace(alice), seed.workspace(bob)
    docs = f"{BASE}/workspaces/{alice_ws}/documents"

    ok = api.post(docs, json={"workspace_id": alice_ws}, headers=alice.headers())
    assert ok.status_code == 200, ok.text
    # Another workspace id in the body (even one the caller cannot see) never redirects the
    # request, and query/header ids are ignored.
    _problem(api.post(docs, json={"workspace_id": bob_ws}, headers=alice.headers()), 404)
    res = api.get(
        f"{BASE}/workspaces/{alice_ws}",
        params={"workspace_id": bob_ws},
        headers={**alice.headers(), "X-Workspace-Id": bob_ws},
    )
    assert res.json()["workspace_id"] == alice_ws


# --------------------------------------------------------------------------------------------
# Resource routes: resource → workspace → membership
# --------------------------------------------------------------------------------------------
def test_job_access_follows_the_jobs_real_workspace(api: TestClient, seed: Seed) -> None:
    alice, bob = seed.user("alice"), seed.user("bob")
    alice_ws = seed.workspace(alice)
    bob_ws = seed.workspace(bob, viewer=alice)
    alice_job, bob_job = seed.job(alice_ws, alice), seed.job(bob_ws, bob)

    res = api.get(f"{BASE}/jobs/{alice_job}", headers=alice.headers())
    assert res.status_code == 200, res.text
    assert res.json()["workspace_id"] == alice_ws
    assert api.get(f"{BASE}/jobs/{bob_job}", headers=alice.headers()).json()["role"] == "viewer"

    # Bob cannot see Alice's job; it looks exactly like a job that does not exist.
    foreign = _problem(api.get(f"{BASE}/jobs/{alice_job}", headers=bob.headers()), 404)
    unknown = _problem(api.get(f"{BASE}/jobs/{uuid.uuid4()}", headers=bob.headers()), 404)
    assert foreign == unknown

    # Nested route: the path workspace must be the job's real workspace, even when the caller
    # is a member of both.
    nested = f"{BASE}/workspaces/{{ws}}/jobs/{{job}}"
    assert api.get(nested.format(ws=alice_ws, job=alice_job), headers=alice.headers()).is_success
    assert (
        _problem(api.get(nested.format(ws=bob_ws, job=alice_job), headers=alice.headers()), 404)
        == unknown
    )
    _problem(api.get(nested.format(ws=bob_ws, job=alice_job), headers=bob.headers()), 404)


def test_job_in_a_deleted_workspace_is_404(api: TestClient, seed: Seed) -> None:
    owner = seed.user("own")
    ws = seed.workspace(owner)
    job = seed.job(ws, owner)
    assert api.get(f"{BASE}/jobs/{job}", headers=owner.headers()).status_code == 200
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "update public.workspaces set status = 'deleted', deleted_at = now() where id = %s",
            (ws,),
        )
    _problem(api.get(f"{BASE}/jobs/{job}", headers=owner.headers()), 404)


# --------------------------------------------------------------------------------------------
# Check-and-act atomicity: the authorization query locks the rows it checked
# --------------------------------------------------------------------------------------------
def _archive_with_timeout(workspace_id: str) -> None:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute("set lock_timeout = '300ms'")
        conn.execute(
            "update public.workspaces set status = 'archived', archived_at = now() where id = %s",
            (workspace_id,),
        )


def test_write_authorization_blocks_a_concurrent_archive_until_commit(
    database: Any, seed: Seed
) -> None:
    owner = seed.user("own")
    ws = seed.workspace(owner)

    with database.sessionmaker() as session:
        repo = SqlAccessRepository(session)
        access = authorize_workspace(repo, owner.uuid, uuid.UUID(ws), Action.DOCUMENT_EDIT)
        assert access.status == "active"
        with pytest.raises(psycopg.errors.LockNotAvailable):
            _archive_with_timeout(ws)
        session.commit()  # the write would happen here, then the lock is released

    _archive_with_timeout(ws)
    with database.sessionmaker() as session:
        with pytest.raises(HTTPException) as exc:
            authorize_workspace(
                SqlAccessRepository(session), owner.uuid, uuid.UUID(ws), Action.DOCUMENT_EDIT
            )
        assert exc.value.status_code == 403
        assert getattr(exc.value, "problem_type", None) == ProblemType.WORKSPACE_ARCHIVED


def test_lifecycle_lock_serialises_with_content_writes(database: Any, seed: Seed) -> None:
    owner = seed.user("own")
    ws = uuid.UUID(seed.workspace(owner))

    with database.sessionmaker() as admin_tx, database.sessionmaker() as writer_tx:
        access = authorize_workspace(
            SqlAccessRepository(admin_tx), owner.uuid, ws, Action.WORKSPACE_ARCHIVE
        )
        assert access.role == "owner"
        writer_tx.connection().exec_driver_sql("set local lock_timeout = '300ms'")
        with pytest.raises(OperationalError):
            authorize_workspace(SqlAccessRepository(writer_tx), owner.uuid, ws, Action.PRACTICE)
        writer_tx.rollback()
        # Reads take no lock and are never blocked.
        reader = authorize_workspace(SqlAccessRepository(writer_tx), owner.uuid, ws, Action.READ)
        assert reader.status == "active"
        admin_tx.rollback()


def test_explicit_lock_override(database: Any, seed: Seed) -> None:
    owner = seed.user("own")
    ws = seed.workspace(owner)
    with database.sessionmaker() as session:
        authorize_workspace(
            SqlAccessRepository(session), owner.uuid, uuid.UUID(ws), Action.READ, LockMode.SHARE
        )
        with pytest.raises(psycopg.errors.LockNotAvailable):
            _archive_with_timeout(ws)
        session.rollback()


# --------------------------------------------------------------------------------------------
# Profile upsert
# --------------------------------------------------------------------------------------------
def _profile_rows(user_id: str) -> int:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select count(*) from public.profiles where user_id = %s", (user_id,)
        ).fetchone()
        assert row is not None
        return int(row[0])


def test_me_creates_the_profile_once(api: TestClient, seed: Seed) -> None:
    user = seed.user("profile")
    assert _profile_rows(user.id) == 0

    first = api.get("/api/v1/me", headers=user.headers())
    second = api.get("/api/v1/me", headers=user.headers())

    assert first.status_code == second.status_code == 200, first.text
    assert first.json() == second.json()
    assert first.json()["id"] == user.id
    assert first.json()["profile"]["display_name"] is None
    assert _profile_rows(user.id) == 1


def test_profile_upsert_is_race_safe_and_never_overwrites(database: Any, seed: Seed) -> None:
    user = seed.user("race")
    workers = 8
    barrier = threading.Barrier(workers)
    results: list[Any] = []
    errors: list[BaseException] = []

    def ensure() -> None:
        try:
            with database.sessionmaker() as session:
                barrier.wait(timeout=10)
                results.append(MeRepository(session).ensure_profile(user.uuid))
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=ensure) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert errors == []
    assert len(results) == workers
    assert len({(r.created_at, r.updated_at) for r in results}) == 1
    assert _profile_rows(user.id) == 1

    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "update public.profiles set display_name = 'Kept' where user_id = %s", (user.id,)
        )
    with database.sessionmaker() as session:
        assert MeRepository(session).ensure_profile(user.uuid).display_name == "Kept"


def test_me_for_a_deleted_user_is_401(api: TestClient, seed: Seed, database: Any) -> None:
    user = seed.user("gone")
    seed.delete_user(user)

    res = api.get("/api/v1/me", headers=user.headers())

    assert res.status_code == 401, res.text
    assert res.headers["content-type"] == PROBLEM
    assert user.token not in res.text
    assert _profile_rows(user.id) == 0
    with database.sessionmaker() as session, pytest.raises(UnknownUserError):
        MeRepository(session).ensure_profile(user.uuid)
