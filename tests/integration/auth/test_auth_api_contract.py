"""AUTH-API-AC01~03 (docs/auth.md §3/§5/§7): FastAPI access-token contract against the local stack.

Black-box contract tests: the API runs as a real server process started the only supported way
(`python -m quiz_api.serve`, implementation-plan §7) with the env names from `.env.example`
(SUPABASE_JWT_ISSUER / SUPABASE_JWKS_URL / SUPABASE_JWT_AUDIENCE, DATABASE_URL), so they exercise
JWKS discovery over HTTP, settings loading and the redacting log setup exactly as deployed and do
not depend on `create_app`/`Settings` internals that A1.2 will change.

Tokens: valid ones come from the local Supabase Auth (password grant). Forged ones are minted
here: re-signed with the local ES256 key from `supabase/signing_keys.json` (expired, wrong
aud/iss, no sub), signed with an unknown key, `alg: none`, HS256 with the legacy JWT secret, or a
tampered payload. Signing uses a tiny stdlib P-256 ECDSA (test-only; no crypto package is in
uv.lock). `test_minted_token_is_accepted_by_the_auth_server` proves the minting is correct by
having GoTrue itself accept a re-signed token, so the 401 cases differ from a valid token only
in the claim under test.

Needs `make infra-up` (and the one-time `quiz_api` login step from AGENTS.md §7 once routes use
the DB). Without the stack these skip with a reason; `make test-infra` (QUIZ_REQUIRE_INFRA=1)
fails instead. Workspaces for AC02 are inserted with the local `postgres` superuser (fixture
data, no app endpoint) and deleted afterwards together with the users.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
ISSUER = f"{SUPABASE_URL}/auth/v1"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
AUDIENCE = "authenticated"
# Local stack defaults (supabase/config.toml, infra/compose.yaml, .env.example).
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_DATABASE_URL = "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
REDIS_URL = "redis://127.0.0.1:6379/0"
QDRANT_URL = "http://127.0.0.1:6333"
SIGNING_KEYS = REPO_ROOT / "supabase" / "signing_keys.json"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

ME = "/api/v1/me"
ME_WORKSPACES = "/api/v1/me/workspaces"


# --------------------------------------------------------------------------------------------
# Minimal ES256 (ECDSA P-256 + SHA-256) signing, test-only. Correctness is checked against the
# key's own public point on load and against GoTrue in test_minted_token_is_accepted_...
# --------------------------------------------------------------------------------------------
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)
Point = tuple[int, int] | None


def _add(p: Point, q: Point) -> Point:
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % _P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + _A) * pow(2 * p[1], -1, _P) % _P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, _P) % _P
    x = (lam * lam - p[0] - q[0]) % _P
    return x, (lam * (p[0] - x) - p[1]) % _P


def _mul(k: int, p: Point) -> Point:
    out: Point = None
    while k:
        if k & 1:
            out = _add(out, p)
        p = _add(p, p)
        k >>= 1
    return out


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64json(value: dict[str, Any]) -> str:
    return _b64url(json.dumps(value, separators=(",", ":")).encode())


@dataclass(frozen=True)
class SigningKey:
    kid: str
    d: int = field(repr=False)

    @classmethod
    def generate(cls) -> SigningKey:
        return cls(kid=str(uuid.uuid4()), d=secrets.randbelow(_N - 1) + 1)

    @classmethod
    def from_jwk(cls, jwk: dict[str, Any]) -> SigningKey:
        key = cls(kid=str(jwk["kid"]), d=int.from_bytes(_b64url_decode(jwk["d"]), "big"))
        public = _mul(key.d, _G)
        expected = (
            int.from_bytes(_b64url_decode(jwk["x"]), "big"),
            int.from_bytes(_b64url_decode(jwk["y"]), "big"),
        )
        assert public == expected, "ES256 helper derived the wrong public key"
        return key

    def sign(self, message: bytes) -> bytes:
        e = int.from_bytes(hashlib.sha256(message).digest(), "big")
        while True:
            k = secrets.randbelow(_N - 1) + 1
            point = _mul(k, _G)
            assert point is not None
            r = point[0] % _N
            s = pow(k, -1, _N) * (e + r * self.d) % _N
            if r and s:
                return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def mint_es256(key: SigningKey, claims: dict[str, Any], *, kid: str | None = None) -> str:
    header = {"alg": "ES256", "kid": kid or key.kid, "typ": "JWT"}
    signing_input = f"{_b64json(header)}.{_b64json(claims)}"
    return f"{signing_input}.{_b64url(key.sign(signing_input.encode()))}"


def mint_hs256(secret: str, claims: dict[str, Any]) -> str:
    signing_input = f"{_b64json({'alg': 'HS256', 'typ': 'JWT'})}.{_b64json(claims)}"
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"


def mint_none(claims: dict[str, Any]) -> str:
    return f"{_b64json({'alg': 'none', 'typ': 'JWT'})}.{_b64json(claims)}."


def jwt_claims(token: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_b64url_decode(token.split(".")[1]))
    return data


def jwt_header(token: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_b64url_decode(token.split(".")[0]))
    return data


# --------------------------------------------------------------------------------------------
# Local stack: Auth (GoTrue), signing key, DB fixture data, API server process
# --------------------------------------------------------------------------------------------
def _require_infra(reason: str) -> None:
    if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
        pytest.fail(reason)
    pytest.skip(reason)


def _assert_loopback(url: str) -> None:
    host = urlsplit(url).hostname
    assert host in LOOPBACK, f"refusing to run auth contract tests against non-local {host}"


def _supabase_status() -> dict[str, Any]:
    out = subprocess.run(
        ["pnpm", "exec", "supabase", "status", "-o", "json"],  # noqa: S607 (pinned CLI via pnpm)
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    status: dict[str, Any] = json.loads(out[out.index("{") :])
    return status


@dataclass(frozen=True)
class Session:
    user_id: str
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)


@dataclass(frozen=True)
class Stack:
    auth: httpx.Client
    admin: httpx.Client
    signing_key: SigningKey = field(repr=False)
    legacy_jwt_secret: str = field(repr=False)

    def sign_in(self, email: str, password: str) -> Session:
        res = self.auth.post(
            "/token", params={"grant_type": "password"}, json={"email": email, "password": password}
        )
        assert res.status_code == 200, f"sign in failed: HTTP {res.status_code}"
        body = res.json()
        return Session(body["user"]["id"], body["access_token"], body["refresh_token"])


@pytest.fixture(scope="module")
def stack() -> Iterator[Stack]:
    for url in (SUPABASE_URL, DB_ADMIN_URL):
        _assert_loopback(url)
    try:
        httpx.get(f"{ISSUER}/health", timeout=3).raise_for_status()
    except httpx.HTTPError as exc:
        _require_infra(
            f"local Supabase Auth not reachable at {SUPABASE_URL} ({exc.__class__.__name__}); "
            "start it with `make infra-up`"
        )
    if not SIGNING_KEYS.exists():
        _require_infra(f"{SIGNING_KEYS.relative_to(REPO_ROOT)} missing; run `make auth-keys`")
    jwks = [k for k in json.loads(SIGNING_KEYS.read_text()) if k.get("alg") == "ES256"]
    assert jwks, "no ES256 key in supabase/signing_keys.json"

    publishable = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    secret = os.environ.get("SUPABASE_SECRET_KEY", "")
    legacy = ""
    if not (publishable and secret):
        status = _supabase_status()
        publishable = publishable or str(status["PUBLISHABLE_KEY"])
        secret = secret or str(status["SECRET_KEY"])
        legacy = str(status.get("JWT_SECRET", ""))
    with (
        httpx.Client(base_url=ISSUER, timeout=15, headers={"apikey": publishable}) as auth,
        httpx.Client(base_url=f"{ISSUER}/admin", timeout=15, headers={"apikey": secret}) as admin,
    ):
        yield Stack(
            auth=auth,
            admin=admin,
            signing_key=SigningKey.from_jwk(jwks[0]),
            # Supabase's well-known local default when `supabase status` is not consulted.
            legacy_jwt_secret=legacy or "super-secret-jwt-token-with-at-least-32-characters-long",
        )


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str
    password: str = field(repr=False)


class Seed:
    """Per-test confirmed users and owned workspaces; everything is deleted on teardown."""

    def __init__(self, stack: Stack) -> None:
        self._stack = stack
        self._users: list[str] = []
        self._workspaces: list[str] = []

    def user(self, label: str) -> AuthUser:
        email = f"auth-api-{label}-{uuid.uuid4().hex}@example.test"
        password = f"pw-{uuid.uuid4().hex}"
        res = self._stack.admin.post(
            "/users", json={"email": email, "password": password, "email_confirm": True}
        )
        assert res.status_code == 200, f"create user failed: HTTP {res.status_code}"
        user = AuthUser(res.json()["id"], email, password)
        self._users.append(user.id)
        return user

    def workspace(self, owner: AuthUser) -> str:
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            row = conn.execute(
                "insert into public.workspaces (name, owner_id) values (%s, %s) returning id",
                (f"auth-api {owner.email}", owner.id),
            ).fetchone()
            assert row is not None
            workspace_id = str(row[0])
            conn.execute(
                "insert into public.workspace_memberships (workspace_id, user_id, role) "
                "values (%s, %s, 'owner')",
                (workspace_id, owner.id),
            )
        self._workspaces.append(workspace_id)
        return workspace_id

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


@dataclass(frozen=True)
class ApiServer:
    client: httpx.Client
    log_path: Path

    def log_text(self) -> str:
        return self.log_path.read_text(errors="replace")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def api(stack: Stack, tmp_path_factory: pytest.TempPathFactory) -> Iterator[ApiServer]:
    workdir = tmp_path_factory.mktemp("api")  # no stray `.env` is picked up from the repo
    log_path = workdir / "api.log"
    port = _free_port()
    env = {
        **os.environ,
        "APP_ENV": "test",
        "LOG_LEVEL": "INFO",
        "NEXT_PUBLIC_SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_JWT_ISSUER": ISSUER,
        "SUPABASE_JWKS_URL": JWKS_URL,
        "SUPABASE_JWT_AUDIENCE": AUDIENCE,
        "DATABASE_URL": os.environ.get("DATABASE_URL", API_DATABASE_URL),
        "REDIS_URL": os.environ.get("REDIS_URL", REDIS_URL),
        "QDRANT_URL": os.environ.get("QDRANT_URL", QDRANT_URL),
    }
    _assert_loopback(env["DATABASE_URL"])
    with log_path.open("wb") as log:
        proc = subprocess.Popen(  # noqa: S603 (fixed argv, local interpreter)
            [sys.executable, "-m", "quiz_api.serve", "--host", "127.0.0.1", "--port", str(port)],
            cwd=workdir,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    base_url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 30
        while True:
            if proc.poll() is not None:
                pytest.fail(f"API server exited with {proc.returncode}:\n{log_path.read_text()}")
            with contextlib.suppress(httpx.HTTPError):
                if httpx.get(f"{base_url}/health/live", timeout=1).status_code == 200:
                    break
            if time.monotonic() > deadline:
                pytest.fail(f"API server did not become live:\n{log_path.read_text()}")
            time.sleep(0.2)
        with httpx.Client(base_url=base_url, timeout=10) as client:
            yield ApiServer(client=client, log_path=log_path)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _assert_unauthorized(res: httpx.Response, *, secret: str, api: ApiServer) -> None:
    assert res.status_code == 401, f"expected 401, got {res.status_code}: {res.text[:300]}"
    assert "json" in res.headers.get("content-type", "")
    # Never echo or log the presented credential (AGENTS.md §5).
    if secret:
        assert secret not in res.text
        assert secret not in api.log_text()


# --------------------------------------------------------------------------------------------
# Harness self-check (no AC): passes today, proves the minted tokens are well-formed.
# --------------------------------------------------------------------------------------------
def test_minted_token_is_accepted_by_the_auth_server(stack: Stack, seed: Seed) -> None:
    user = seed.user("selfcheck")
    session = stack.sign_in(user.email, user.password)
    claims = jwt_claims(session.access_token)
    assert jwt_header(session.access_token)["kid"] == stack.signing_key.kid

    resigned = mint_es256(stack.signing_key, claims)
    assert resigned != session.access_token
    res = stack.auth.get("/user", headers=_bearer(resigned))
    assert res.status_code == 200, res.text
    assert res.json()["id"] == user.id

    expired = mint_es256(stack.signing_key, {**claims, "exp": int(time.time()) - 60})
    assert stack.auth.get("/user", headers=_bearer(expired)).status_code in {401, 403}


# --------------------------------------------------------------------------------------------
# AUTH-API-AC01: missing / forged / expired / wrong-alg / wrong-aud JWT → 401; valid → 200
# --------------------------------------------------------------------------------------------
TokenCase = Callable[[Stack, dict[str, Any], str], str]

FORGED: dict[str, TokenCase] = {
    "malformed": lambda _s, _c, _t: "not-a-jwt",
    "tampered-payload": lambda _s, c, t: (
        f"{t.split('.')[0]}.{_b64json({**c, 'sub': str(uuid.uuid4())})}.{t.split('.')[2]}"
    ),
    "unknown-key-same-kid": lambda s, c, _t: mint_es256(
        SigningKey.generate(), c, kid=s.signing_key.kid
    ),
    "unknown-kid": lambda _s, c, _t: mint_es256(SigningKey.generate(), c),
    "alg-none": lambda _s, c, _t: mint_none(c),
    "hs256-legacy-secret": lambda s, c, _t: mint_hs256(s.legacy_jwt_secret, c),
    "expired": lambda s, c, _t: mint_es256(
        s.signing_key, {**c, "iat": int(time.time()) - 7200, "exp": int(time.time()) - 60}
    ),
    "wrong-aud": lambda s, c, _t: mint_es256(s.signing_key, {**c, "aud": "not-authenticated"}),
    "wrong-iss": lambda s, c, _t: mint_es256(
        s.signing_key, {**c, "iss": "https://evil.example/auth/v1"}
    ),
    "no-sub": lambda s, c, _t: mint_es256(
        s.signing_key, {k: v for k, v in c.items() if k != "sub"}
    ),
    "anon-role-no-user": lambda s, c, _t: mint_es256(
        s.signing_key, {"iss": c["iss"], "role": "anon", "iat": c["iat"], "exp": c["exp"]}
    ),
}


def test_auth_api_ac01_missing_or_non_bearer_credentials_are_401(
    api: ApiServer, stack: Stack, seed: Seed
) -> None:
    user = seed.user("ac01-missing")
    token = stack.sign_in(user.email, user.password).access_token

    _assert_unauthorized(api.client.get(ME), secret="", api=api)
    # Bearer scheme without a token. (`"Bearer "` with the trailing space cannot be sent: h11
    # rejects header values with trailing whitespace client-side.)
    _assert_unauthorized(
        api.client.get(ME, headers={"Authorization": "Bearer"}), secret="", api=api
    )
    _assert_unauthorized(
        api.client.get(ME, headers={"Authorization": f"Basic {token}"}), secret=token, api=api
    )
    # Tokens are only accepted in the Authorization header, never from the URL.
    _assert_unauthorized(api.client.get(ME, params={"access_token": token}), secret=token, api=api)


@pytest.mark.parametrize("case", sorted(FORGED))
def test_auth_api_ac01_forged_expired_or_misaddressed_jwt_is_401(
    api: ApiServer, stack: Stack, seed: Seed, case: str
) -> None:
    user = seed.user("ac01-forged")
    real = stack.sign_in(user.email, user.password).access_token
    forged = FORGED[case](stack, jwt_claims(real), real)
    assert forged != real

    _assert_unauthorized(api.client.get(ME, headers=_bearer(forged)), secret=forged, api=api)
    _assert_unauthorized(
        api.client.get(ME_WORKSPACES, headers=_bearer(forged)), secret=forged, api=api
    )


def test_auth_api_ac01_valid_token_returns_own_profile(
    api: ApiServer, stack: Stack, seed: Seed
) -> None:
    alice, bob = seed.user("ac01-alice"), seed.user("ac01-bob")
    for me, other in ((alice, bob), (bob, alice)):
        session = stack.sign_in(me.email, me.password)
        res = api.client.get(ME, headers=_bearer(session.access_token))
        assert res.status_code == 200, f"{res.status_code}: {res.text[:300]}"
        assert "no-store" in res.headers.get("cache-control", ""), "auth responses are per-user"
        body = res.json()
        assert body["id"] == me.id
        # A1.3: the profile is initialised (idempotently) on the first authenticated call.
        assert isinstance(body["profile"], dict), body
        again = api.client.get(ME, headers=_bearer(session.access_token))
        assert again.status_code == 200
        assert again.json() == body
        assert other.id not in res.text
        assert other.email not in res.text
        # The token is never echoed back.
        assert session.access_token not in res.text

    # A token minted locally with the real key and valid claims is accepted too: the 401 cases
    # above differ from it only in the claim/signature under test.
    session = stack.sign_in(alice.email, alice.password)
    resigned = mint_es256(stack.signing_key, jwt_claims(session.access_token))
    res = api.client.get(ME, headers=_bearer(resigned))
    assert res.status_code == 200, f"{res.status_code}: {res.text[:300]}"
    assert res.json()["id"] == alice.id
    assert resigned not in api.log_text()


# --------------------------------------------------------------------------------------------
# AUTH-API-AC02: no access to another user's workspaces (scoping from the verified sub only)
# --------------------------------------------------------------------------------------------
def test_auth_api_ac02_me_workspaces_lists_only_own_memberships(
    api: ApiServer, stack: Stack, seed: Seed
) -> None:
    alice, bob = seed.user("ac02-alice"), seed.user("ac02-bob")
    alice_ws, bob_ws = seed.workspace(alice), seed.workspace(bob)

    for me, mine, theirs in ((alice, alice_ws, bob_ws), (bob, bob_ws, alice_ws)):
        token = stack.sign_in(me.email, me.password).access_token
        res = api.client.get(ME_WORKSPACES, headers=_bearer(token))
        assert res.status_code == 200, f"{res.status_code}: {res.text[:300]}"
        assert mine in res.text
        assert theirs not in res.text


def test_auth_api_ac02_client_supplied_ids_never_widen_scope(
    api: ApiServer, stack: Stack, seed: Seed
) -> None:
    alice, bob = seed.user("ac02-alice"), seed.user("ac02-bob")
    alice_ws, bob_ws = seed.workspace(alice), seed.workspace(bob)
    token = stack.sign_in(bob.email, bob.password).access_token

    res = api.client.get(
        ME_WORKSPACES,
        params={"user_id": alice.id, "owner_id": alice.id, "workspace_id": alice_ws},
        headers={**_bearer(token), "X-User-Id": alice.id, "X-Workspace-Id": alice_ws},
    )
    assert res.status_code in {200, 400, 422}, f"{res.status_code}: {res.text[:300]}"
    assert alice_ws not in res.text
    assert alice.id not in res.text
    if res.status_code == 200:
        assert bob_ws in res.text
    me = api.client.get(ME, params={"user_id": alice.id}, headers=_bearer(token))
    assert me.status_code == 200, f"{me.status_code}: {me.text[:300]}"
    assert me.json()["id"] == bob.id


# --------------------------------------------------------------------------------------------
# AUTH-API-AC03: after logout the refresh token cannot be reused; access tokens are short-lived
# --------------------------------------------------------------------------------------------
def test_auth_api_ac03_refresh_token_is_rejected_after_logout(
    api: ApiServer, stack: Stack, seed: Seed
) -> None:
    user = seed.user("ac03")
    session = stack.sign_in(user.email, user.password)
    claims = jwt_claims(session.access_token)
    # Documented trade-off: a signed-out access token stays valid until `exp`, so it must be
    # short-lived (1 h, supabase/config.toml jwt_expiry) and sensitive actions re-check the user.
    assert claims["exp"] - claims["iat"] <= 3600

    res = api.client.get(ME, headers=_bearer(session.access_token))
    assert res.status_code == 200, f"{res.status_code}: {res.text[:300]}"

    logout = stack.auth.post("/logout", headers=_bearer(session.access_token))
    assert logout.status_code == 204, logout.text
    reuse = stack.auth.post(
        "/token",
        params={"grant_type": "refresh_token"},
        json={"refresh_token": session.refresh_token},
    )
    assert reuse.status_code in {400, 401}, f"refresh after logout: HTTP {reuse.status_code}"
    assert "access_token" not in reuse.text
