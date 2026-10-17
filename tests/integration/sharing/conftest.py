"""Fixtures for the S0 sharing/fork security contract tests (WS-SHARE-01, WS-VIEW-01, WS-FORK-01).

Reuses the M3 contract stack (in-process production app, local Auth users, `quiz_api` DB role)
from tests/integration/workspaces/conftest.py, loaded by path because conftest modules are not
importable under `--import-mode=importlib`. Request/response shapes, the share cookie, markers and
rate limits mirror tests/e2e/fixtures/sharing.ts, whose header lists every S0 assumption (S1-S9);
keep both in sync.

Share sessions are carried by hand: the exchange's `Set-Cookie` is parsed and sent back as a
`Cookie` header, and the TestClient cookie jar is cleared after every exchange so no share
session leaks between tests (the module-scoped client is shared). Secrets are compared with
booleans and never interpolated into assertion messages.

The `postgres` superuser is used for teardown (share links and fork records reference users and
workspaces), for moving a link's expiry into the past (S8, equivalent to waiting), for seeding an
owner's favourite/retry state and a graded attempt (practice API arrives in M5), and for reading
rows the API must never expose (token digest, per-user tables of a fork target).
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from quiz_api.settings import LOCAL_CORS_ORIGINS, Settings

_M3_CONFTEST = Path(__file__).resolve().parents[1] / "workspaces" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_m3_contract_conftest_sharing", _M3_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_m3 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _m3  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_m3)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _m3.stack
app_client = _m3.app_client

API: str = _m3.API
DB_ADMIN_URL: str = _m3.DB_ADMIN_URL
SHARE_COOKIE = "quiz_share_session"
MAX_SHARE_SESSION_SECONDS = 8 * 60 * 60
MIN_SECRET_BYTES = 32
FORK_PAUSE_MARKER = "E2E-FORK-PAUSE"
FORK_FAILURE_MARKER = "E2E-FAIL-FORK"
EXCHANGE_BURST = 30
FORK_BURST = 10
FORK_TIMEOUT_S = 120.0
JOB_TIMEOUT_S = 120.0
FORK_TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}
FOREIGN_ORIGIN = "https://evil.example"
PERSONAL_KEYS = (
    "status",
    "is_favorite",
    "needs_retry",
    "attempts",
    "user_state",
    "last_graded_result",
    "owner_id",
    "created_by",
    "email",
)


def web_origin() -> str:
    """The first allowlisted web origin of the app under test (S3 Origin check)."""
    settings = Settings(DATABASE_URL=_m3.API_DATABASE_URL)
    return (settings.cors_allowed_origins or LOCAL_CORS_ORIGINS)[0]


def secret_bytes(secret: str) -> int:
    try:
        return len(base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4)))
    except ValueError:
        return 0


def stable(res: httpx.Response) -> dict[str, Any]:
    """Problem body without per-request fields."""
    try:
        body: dict[str, Any] = res.json()
    except ValueError:
        return {"raw": res.text}
    return {k: body.get(k) for k in ("type", "title", "status", "detail")}


def assert_status(res: httpx.Response, expected: set[int] | int, what: str) -> None:
    allowed = {expected} if isinstance(expected, int) else expected
    if res.status_code in allowed:
        return
    route = f"{res.request.method} {_m3.route_of(res.request.url.path)}"
    if _m3.is_missing_route(res):
        pytest.fail(f"{route} not implemented ({res.status_code}) [{what}]")
    pytest.fail(f"{route}: expected {sorted(allowed)}, got {res.status_code} [{what}]")


def assert_privacy_headers(res: httpx.Response, what: str) -> None:
    cache = res.headers.get("cache-control", "")
    assert "no-store" in cache, f"{what}: Cache-Control {cache!r}"
    assert "private" in cache, f"{what}: Cache-Control {cache!r}"
    assert res.headers.get("referrer-policy") == "no-referrer", f"{what}: Referrer-Policy"
    robots = res.headers.get("x-robots-tag", "")
    assert "noindex" in robots, f"{what}: X-Robots-Tag {robots!r}"
    assert "nofollow" in robots, f"{what}: X-Robots-Tag {robots!r}"


@dataclass(frozen=True)
class ShareCookie:
    value: str
    attributes: dict[str, str]

    @property
    def header(self) -> str:
        return f"{SHARE_COOKIE}={self.value}"


def share_cookie_of(res: httpx.Response) -> ShareCookie | None:
    for raw in res.headers.get_list("set-cookie"):
        jar: SimpleCookie = SimpleCookie()
        jar.load(raw)
        morsel = jar.get(SHARE_COOKIE)
        if morsel is None:
            continue
        lowered = raw.lower()
        attrs = {
            "httponly": "true" if "httponly" in lowered else "",
            "secure": "true" if "secure" in lowered else "",
            "samesite": str(morsel["samesite"]).lower(),
            "max-age": str(morsel["max-age"]),
            "expires": str(morsel["expires"]),
            "path": str(morsel["path"]),
        }
        return ShareCookie(morsel.value, attrs)
    return None


class ShareClient(_m3.Client):
    """`Client` (one user, Bearer JWT) plus share-link, shared-read and fork calls."""

    def send(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        jwt: bool = True,
        cookie: str | None = None,
        origin: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        h: dict[str, str] = dict(headers or {})
        if jwt:
            h["Authorization"] = f"Bearer {self.user.token}"
        if cookie:
            h["Cookie"] = cookie
        if origin:
            h["Origin"] = origin
        res = self._http.request(method, f"{API}{path}", json=body, headers=h)
        self._http.cookies.clear()
        return res

    # Owner API (S2)
    def create_link(self, workspace_id: str, **body: Any) -> dict[str, Any]:
        out: dict[str, Any] = self.ok(
            "POST", f"/workspaces/{workspace_id}/share-links", body, (201,)
        )
        return out

    def links(self, workspace_id: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok("GET", f"/workspaces/{workspace_id}/share-links")[
            "items"
        ]
        return items

    def patch_link(self, workspace_id: str, link_id: str, **body: Any) -> httpx.Response:
        return self.call("PATCH", f"/workspaces/{workspace_id}/share-links/{link_id}", body)

    def revoke(self, workspace_id: str, link_id: str) -> httpx.Response:
        return self.call("POST", f"/workspaces/{workspace_id}/share-links/{link_id}/revoke", {})

    def rotate(self, workspace_id: str, link_id: str) -> httpx.Response:
        return self.call("POST", f"/workspaces/{workspace_id}/share-links/{link_id}/rotate", {})

    # Fork (S5)
    def fork(
        self,
        share_id: str,
        cookie: str | None,
        name: str,
        key: str | None = None,
        *,
        jwt: bool = True,
        origin: str | None = "web",
    ) -> httpx.Response:
        return self.send(
            "POST",
            f"/shared/{share_id}/forks",
            {"name": name},
            jwt=jwt,
            cookie=cookie,
            origin=web_origin() if origin == "web" else origin,
            headers={"Idempotency-Key": key or str(uuid.uuid4())},
        )

    def get_fork(self, fork_id: str) -> httpx.Response:
        return self.call("GET", f"/me/forks/{fork_id}")

    def wait_fork(self, fork_id: str, expected: str) -> dict[str, Any]:
        deadline = time.monotonic() + FORK_TIMEOUT_S
        fork: dict[str, Any] = {}
        while time.monotonic() < deadline:
            res = self.get_fork(fork_id)
            assert_status(res, 200, "GET /me/forks/{id}")
            fork = res.json()
            if fork["status"] == expected or fork["status"] in FORK_TERMINAL:
                break
            time.sleep(0.25)
        assert fork.get("status") == expected, f"fork ended as {fork.get('status')}, not {expected}"
        return fork

    # Content (M3/M4 public API)
    def create_question(self, workspace_id: str, stem: str, answer: int = 0) -> dict[str, Any]:
        options = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(["A", "B", "C", "D"])]
        body = {
            "question_type": "MCQ",
            "stem": stem,
            "options": options,
            "correct_option_ids": [options[answer]["id"]],
            "is_multi_answer": False,
            "explanation": f"해설: {stem}",
        }
        out: dict[str, Any] = self.ok("POST", f"/workspaces/{workspace_id}/questions", body, (201,))
        return out

    def list_questions(self, workspace_id: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok("GET", f"/workspaces/{workspace_id}/questions")[
            "items"
        ]
        return items

    def wait_for_job(self, job_id: str) -> None:
        deadline = time.monotonic() + JOB_TIMEOUT_S
        status = ""
        while time.monotonic() < deadline:
            status = str(self.ok("GET", f"/jobs/{job_id}")["status"])
            if status in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.5)
        assert status == "succeeded", f"job ended as {status or 'timeout'}"


class Guest:
    """An anonymous browser: no JWT, only (optionally) a share cookie."""

    def __init__(self, http: TestClient) -> None:
        self._http = http

    def send(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        cookie: str | None = None,
        origin: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        h: dict[str, str] = dict(headers or {})
        if cookie:
            h["Cookie"] = cookie
        if origin:
            h["Origin"] = origin
        res = self._http.request(method, f"{API}{path}", json=body, headers=h)
        self._http.cookies.clear()
        return res

    def exchange(self, share_id: str, secret: str, origin: str | None = "web") -> httpx.Response:
        return self.send(
            "POST",
            f"/shared/{share_id}/sessions",
            {"secret": secret},
            origin=web_origin() if origin == "web" else origin,
        )

    def session(self, share_id: str, secret: str) -> str:
        """Exchanges the secret; returns the `Cookie` header value of the share session."""
        res = self.exchange(share_id, secret)
        assert_status(res, {200, 201, 204}, "session exchange")
        cookie = share_cookie_of(res)
        assert cookie is not None, f"exchange set no {SHARE_COOKIE} cookie"
        return cookie.header

    def read(self, share_id: str, cookie: str, path: str = "") -> httpx.Response:
        return self.send("GET", f"/shared/{share_id}{path}", cookie=cookie)


class ShareSeed(_m3.Seed):
    """`Seed` whose clients speak the sharing API, plus the S8 superuser helpers."""

    SHARE_COOKIE = SHARE_COOKIE
    MAX_SHARE_SESSION_SECONDS = MAX_SHARE_SESSION_SECONDS
    MIN_SECRET_BYTES = MIN_SECRET_BYTES
    FORK_PAUSE_MARKER = FORK_PAUSE_MARKER
    FORK_FAILURE_MARKER = FORK_FAILURE_MARKER
    EXCHANGE_BURST = EXCHANGE_BURST
    FORK_BURST = FORK_BURST
    FOREIGN_ORIGIN = FOREIGN_ORIGIN
    PERSONAL_KEYS = PERSONAL_KEYS
    stable = staticmethod(stable)
    assert_status = staticmethod(assert_status)
    assert_privacy_headers = staticmethod(assert_privacy_headers)
    share_cookie_of = staticmethod(share_cookie_of)
    secret_bytes = staticmethod(secret_bytes)
    web_origin = staticmethod(web_origin)

    def client(self, label: str) -> ShareClient:
        base = super().client(f"s0-{label}")
        return ShareClient(self._http, base.user)

    def guest(self) -> Guest:
        return Guest(self._http)

    @staticmethod
    def _admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            cur = conn.execute(sql, params)
            return cur.fetchall() if cur.description else []

    def expire_now(self, link_id: str) -> None:
        rows = self._admin(
            "update public.workspace_share_links set expires_at = now() - interval '1 minute' "
            "where id = %s returning id",
            (link_id,),
        )
        assert len(rows) == 1, "share link row not found"

    def link_row(self, link_id: str) -> tuple[str, bytes]:
        """(row as JSON text, token_digest bytes) straight from the table."""
        rows = self._admin(
            "select row_to_json(l)::text, l.token_digest from public.workspace_share_links l "
            "where id = %s",
            (link_id,),
        )
        assert len(rows) == 1, "share link row not found"
        return str(rows[0][0]), bytes(rows[0][1])

    def study_state(self, user_id: str, workspace_id: str, question_id: str) -> None:
        self._admin(
            "insert into public.question_user_states (user_id, workspace_id, question_id, "
            "is_favorite, needs_retry, first_viewed_at, last_viewed_at) "
            "values (%s, %s, %s, true, true, now(), now())",
            (user_id, workspace_id, question_id),
        )

    def graded_attempt(
        self, workspace_id: str, question_id: str, revision_id: str, user_id: str
    ) -> None:
        self._admin(
            "with s as (insert into public.practice_sessions (workspace_id, question_id, "
            "question_revision_id, user_id, state, submitted_at, graded_at) "
            "values (%s, %s, %s, %s, 'graded', now(), now()) "
            "returning id, workspace_id, question_id, question_revision_id, user_id) "
            "insert into public.question_attempts (workspace_id, question_id, "
            "question_revision_id, practice_session_id, user_id, submitted_answer, result, "
            "grading_method, graded_at) select workspace_id, question_id, "
            "question_revision_id, id, user_id, '{}'::jsonb, 'correct', 'auto', now() from s",
            (workspace_id, question_id, revision_id, user_id),
        )

    def private_counts(self, workspace_id: str) -> dict[str, int]:
        out: dict[str, int] = {}
        for table in (
            "question_user_states",
            "question_attempts",
            "practice_sessions",
            "question_drafts",
            "workspace_share_links",
        ):
            rows = self._admin(
                f"select count(*) from public.{table} where workspace_id = %s",  # noqa: S608
                (workspace_id,),
            )
            out[table] = int(rows[0][0])
        return out

    def activity_by(self, workspace_id: str, user_id: str) -> int:
        rows = self._admin(
            "select count(*) from public.activity_events where workspace_id = %s and actor_id = %s",
            (workspace_id, user_id),
        )
        return int(rows[0][0])

    def workspaces_owned_by(self, user_id: str) -> int:
        rows = self._admin("select count(*) from public.workspaces where owner_id = %s", (user_id,))
        return int(rows[0][0])

    def memberships(self, workspace_id: str) -> list[tuple[str, str]]:
        rows = self._admin(
            "select user_id::text, role from public.workspace_memberships where workspace_id = %s",
            (workspace_id,),
        )
        return sorted((str(r[0]), str(r[1])) for r in rows)

    def cleanup(self) -> None:
        if self._users:
            self._admin(
                "do $$ begin "
                "if to_regclass('public.workspace_forks') is not null then "
                "delete from public.workspace_forks where forked_by = any(%(u)s::uuid[]) "
                "or target_workspace_id in (select id from public.workspaces "
                "where owner_id = any(%(u)s::uuid[])) "
                "or source_workspace_id in (select id from public.workspaces "
                "where owner_id = any(%(u)s::uuid[])); end if; "
                "if to_regclass('public.workspace_share_links') is not null then "
                "delete from public.workspace_share_links where created_by = any(%(u)s::uuid[]) "
                "or workspace_id in (select id from public.workspaces "
                "where owner_id = any(%(u)s::uuid[])); end if; end $$".replace(
                    "%(u)s", "'{" + ",".join(self._users) + "}'"
                )
            )
        super().cleanup()

    @staticmethod
    def dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False)


@pytest.fixture
def seed(stack: Any, app_client: TestClient) -> Iterator[ShareSeed]:
    s = ShareSeed(stack, app_client)
    try:
        yield s
    finally:
        s.cleanup()
