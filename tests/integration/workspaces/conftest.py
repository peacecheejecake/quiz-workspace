"""Shared fixtures for the M3 API contract tests (WS-01, DOC-01, DOC-02, SEARCH-01).

The production app (`create_app`, no probe routes) runs in-process against the local stack:
real Supabase Auth tokens verified over the local JWKS, the DB reached as the least-privilege
`quiz_api` role, every other setting from the environment / `.env` (Storage, Qdrant, ...).
Users come from the local Auth admin API. Workspaces and documents are created through the
public API only; the local `postgres` superuser is used for teardown (`workspaces.owner_id` is
`on delete restrict` and the API only soft-deletes) and for the one documented seed with no
public API yet (a `viewer` membership, DOC-02-AC05).

Until an endpoint exists FastAPI answers 404 without `detail` (unknown route) or 405; `Client.ok`
reports that as "<METHOD> <route> not implemented (<status>)" so RED failures name the endpoint.

Needs `make infra-up` plus the one-time `quiz_api` login step (AGENTS.md §7). Without the stack
these skip with a reason; `make test-infra` (QUIZ_REQUIRE_INFRA=1) fails instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from quiz_api.main import create_app
from quiz_api.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
)
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
API = "/api/v1"
PROBLEM = "application/problem+json"
ARCHIVED = "urn:quiz-workspace:problem:workspace-archived"
INSUFFICIENT_ROLE = "urn:quiz-workspace:problem:insufficient-role"
# Assumed upload limit: Storage `file_size_limit = "50MiB"` (supabase/config.toml).
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def _require_infra(reason: str) -> None:
    if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
        pytest.fail(reason)
    pytest.skip(reason)


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


@dataclass(frozen=True)
class Stack:
    auth: httpx.Client
    admin: httpx.Client


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


@pytest.fixture(scope="module")
def app_client(stack: Stack) -> Iterator[TestClient]:
    settings = Settings(
        DATABASE_URL=API_DATABASE_URL,
        SUPABASE_JWT_ISSUER=ISSUER,
        SUPABASE_JWKS_URL=JWKS_URL,
    )
    with TestClient(
        create_app(settings, readiness_checkers=[]), raise_server_exceptions=False
    ) as c:
        yield c


def route_of(path: str) -> str:
    return _UUID.sub("{id}", path.split("?")[0])


def is_missing_route(res: httpx.Response) -> bool:
    if res.status_code == 405:
        return True
    if res.status_code != 404:
        return False
    try:
        return not res.json().get("detail")
    except ValueError:
        return True


def problem(res: httpx.Response, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    """Asserts an RFC 9457 problem; returns it without per-request fields."""
    assert not is_missing_route(res), (
        f"{res.request.method} {route_of(res.request.url.path)} not implemented ({res.status_code})"
    )
    assert res.status_code == status, f"expected {status}, got {res.status_code}: {res.text[:300]}"
    assert res.headers["content-type"] == PROBLEM
    body: dict[str, Any] = res.json()
    assert body["type"] == problem_type
    return {k: v for k, v in body.items() if k not in {"instance", "request_id"}}


@dataclass
class User:
    id: str
    email: str
    password: str = field(repr=False)
    token: str = field(default="", repr=False)


class Client:
    """Calls the in-process API as one user."""

    def __init__(self, http: TestClient, user: User) -> None:
        self._http = http
        self.user = user

    def call(self, method: str, path: str, body: Any = None) -> httpx.Response:
        return self._http.request(
            method,
            f"{API}{path}",
            json=body,
            headers={"Authorization": f"Bearer {self.user.token}"},
        )

    def ok(
        self, method: str, path: str, body: Any = None, expected: tuple[int, ...] = (200,)
    ) -> Any:
        res = self.call(method, path, body)
        route = f"{method} {API}{route_of(path)}"
        if res.status_code in expected:
            return res.json() if res.content else None
        if is_missing_route(res):
            pytest.fail(f"{route} not implemented ({res.status_code})")
        pytest.fail(f"{route} failed: HTTP {res.status_code}: {res.text[:300]}")

    # Workspaces (docs/architecture.md §6; bodies assumed by M3.0, see tests/e2e/fixtures).
    def create_workspace(self, name: str | None = None) -> dict[str, Any]:
        name = name or f"contract {uuid.uuid4().hex[:8]}"
        body: dict[str, Any] = self.ok("POST", "/workspaces", {"name": name}, (201,))
        return body

    def list_workspaces(self, status: str = "active") -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok("GET", f"/workspaces?status={status}")["items"]
        return items

    # Documents (docs/deployment.md §2 upload flow).
    def upload_intent(self, workspace_id: str, **overrides: Any) -> httpx.Response:
        pdf = PDF_DIR / "book-ko.pdf"
        body = {
            "filename": pdf.name,
            "size_bytes": pdf.stat().st_size,
            "content_type": "application/pdf",
            "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
            **overrides,
        }
        return self.call("POST", f"/workspaces/{workspace_id}/documents/upload-intent", body)

    def upload_book(self, workspace_id: str) -> tuple[str, str, dict[str, Any]]:
        """upload-intent → PUT to the signed URL → complete-upload.

        Returns (upload_id, sha256, 202 body {document_id, job_id}).
        """
        pdf = (PDF_DIR / "book-ko.pdf").read_bytes()
        res = self.upload_intent(workspace_id)
        intent: dict[str, Any] = self.ok_response(res, "POST", "/upload-intent", (200, 201))
        url = str(intent["upload_url"])
        assert urlsplit(url).hostname in LOOPBACK, "upload URL must stay on the local stack"
        put = httpx.put(
            url,
            content=pdf,
            headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
            timeout=30,
        )
        assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
        sha256 = hashlib.sha256(pdf).hexdigest()
        done: dict[str, Any] = self.ok(
            "POST",
            "/documents/complete-upload",
            {"upload_id": intent["upload_id"], "sha256": sha256},
            (202,),
        )
        return str(intent["upload_id"]), sha256, done

    def ok_response(
        self, res: httpx.Response, method: str, what: str, expected: tuple[int, ...]
    ) -> Any:
        if res.status_code in expected:
            return res.json()
        route = f"{method} {route_of(res.request.url.path)}"
        if is_missing_route(res):
            pytest.fail(f"{route} not implemented ({res.status_code})")
        pytest.fail(f"{route} ({what}) failed: HTTP {res.status_code}: {res.text[:300]}")


class Seed:
    """Per-test users (as API clients) plus the shared assertion helpers and constants.

    Test modules get everything through this fixture: conftest is not importable under
    `--import-mode=importlib`.
    """

    ARCHIVED = ARCHIVED
    INSUFFICIENT_ROLE = INSUFFICIENT_ROLE
    MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES
    problem = staticmethod(problem)
    route_of = staticmethod(route_of)

    def __init__(self, stack: Stack, http: TestClient) -> None:
        self._stack = stack
        self._http = http
        self._users: list[str] = []

    def client(self, label: str) -> Client:
        email = f"m3-{label}-{uuid.uuid4().hex}@example.test"
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
        return Client(self._http, user)

    def membership(self, workspace_id: str, user: User, role: str) -> None:
        """Direct seed: no public membership API exists in M3 (MVP is owner-only)."""
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            conn.execute(
                "insert into public.workspace_memberships (workspace_id, user_id, role) "
                "values (%s, %s, %s)",
                (workspace_id, user.id, role),
            )

    def cleanup(self) -> None:
        if self._users:
            with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
                conn.execute(
                    "delete from public.workspaces where owner_id = any(%s::uuid[])", (self._users,)
                )
        for user_id in self._users:
            res = self._stack.admin.delete(f"/users/{user_id}")
            assert res.status_code in {200, 204, 404}, f"delete user: HTTP {res.status_code}"


@pytest.fixture
def seed(stack: Stack, app_client: TestClient) -> Iterator[Seed]:
    s = Seed(stack, app_client)
    try:
        yield s
    finally:
        s.cleanup()
