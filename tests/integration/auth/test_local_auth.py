"""A1.1: local Supabase Auth configuration (supabase/config.toml) against the running stack.

Covers: email confirmation required, Mailpit delivery, token-hash links to /auth/callback,
redirect allowlist, and asymmetric (JWKS-published) access-token signing.

Needs `make infra-up`. Without the stack these tests skip with an explicit reason;
`make test-infra` sets QUIZ_REQUIRE_INFRA=1 so a missing stack fails instead of skipping.
"""

from __future__ import annotations

import base64
import html
import json
import os
import re
import subprocess
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
MAILPIT_URL = os.environ.get("E2E_MAILPIT_URL", "http://127.0.0.1:54324").rstrip("/")
# Must match [auth] site_url / additional_redirect_urls in supabase/config.toml.
SITE_URL = "http://127.0.0.1:3000"
CALLBACK_URL = f"{SITE_URL}/auth/callback"
FOREIGN_URL = "https://evil.example/steal"
ASYMMETRIC_ALGS = {"ES256", "RS256"}
# Synthetic per-run password, longer than minimum_password_length (10).
PASSWORD = f"pw-{uuid.uuid4().hex}"


@dataclass(frozen=True)
class Stack:
    auth: httpx.Client
    mailpit: httpx.Client


def _publishable_key() -> str:
    key = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    if key:
        return key
    out = subprocess.run(
        ["pnpm", "exec", "supabase", "status", "-o", "json"],  # noqa: S607 (pinned CLI via pnpm)
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    status = json.loads(out[out.index("{") :])
    return str(status["PUBLISHABLE_KEY"])


@pytest.fixture(scope="module")
def stack() -> Iterator[Stack]:
    try:
        httpx.get(f"{SUPABASE_URL}/auth/v1/health", timeout=3).raise_for_status()
        httpx.get(f"{MAILPIT_URL}/api/v1/info", timeout=3).raise_for_status()
    except httpx.HTTPError as exc:
        reason = (
            f"local Supabase stack not reachable at {SUPABASE_URL} / Mailpit {MAILPIT_URL} "
            f"({exc.__class__.__name__}); start it with `make infra-up`"
        )
        if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    key = _publishable_key()
    with (
        httpx.Client(base_url=f"{SUPABASE_URL}/auth/v1", headers={"apikey": key}) as auth,
        httpx.Client(base_url=f"{MAILPIT_URL}/api/v1") as mailpit,
    ):
        yield Stack(auth=auth, mailpit=mailpit)


def _new_email() -> str:
    return f"a11-{uuid.uuid4().hex}@example.test"


def _jwt_part(token: str, index: int) -> dict[str, Any]:
    part = token.split(".")[index]
    data: dict[str, Any] = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    return data


def _sign_up(stack: Stack, email: str, redirect_to: str | None = None) -> dict[str, Any]:
    params = {"redirect_to": redirect_to} if redirect_to else None
    res = stack.auth.post("/signup", params=params, json={"email": email, "password": PASSWORD})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _sign_in(stack: Stack, email: str) -> httpx.Response:
    return stack.auth.post(
        "/token", params={"grant_type": "password"}, json={"email": email, "password": PASSWORD}
    )


def _mail_link(stack: Stack, email: str, timeout: float = 15.0) -> str:
    """Return the single action link of the newest mail sent to `email`."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = stack.mailpit.get("/search", params={"query": f'to:"{email}"'}).json()
        if found["messages"]:
            msg = stack.mailpit.get(f"/message/{found['messages'][0]['ID']}").json()
            links = re.findall(r'href="([^"]+)"', msg["HTML"])
            assert len(links) == 1, links
            return html.unescape(links[0])
        time.sleep(0.25)
    pytest.fail(f"no email for {email} arrived in Mailpit within {timeout}s")


def _token_hash(link: str) -> str:
    parts = urlsplit(link)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == CALLBACK_URL, link
    query = parse_qs(parts.query)
    assert query["type"] == ["email"], link
    return query["token_hash"][0]


def test_jwks_publishes_only_asymmetric_public_keys(stack: Stack) -> None:
    res = stack.auth.get("/.well-known/jwks.json")
    assert res.status_code == 200
    keys = res.json()["keys"]
    assert keys, "JWKS is empty: signing_keys_path not configured (run `make auth-keys`)"
    for key in keys:
        assert key["alg"] in ASYMMETRIC_ALGS
        assert key["kty"] in {"EC", "RSA"}
        assert key["kid"]
        assert not {"d", "p", "q", "k"} & key.keys(), "private/symmetric material in JWKS"
    local_keys = REPO_ROOT / "supabase" / "signing_keys.json"
    if local_keys.exists():
        local_kids = {k["kid"] for k in json.loads(local_keys.read_text())}
        assert local_kids <= {k["kid"] for k in keys}, "running stack uses a stale signing key"


def test_signup_requires_email_confirmation_then_issues_asymmetric_token(stack: Stack) -> None:
    email = _new_email()
    signup = _sign_up(stack, email, redirect_to=CALLBACK_URL)
    assert "access_token" not in signup, "signup must not create a session before confirmation"

    unconfirmed = _sign_in(stack, email)
    assert unconfirmed.status_code == 400
    assert unconfirmed.json().get("error_code") == "email_not_confirmed"

    # The mail links to the app's /auth/callback with a token hash; redeem it the way the
    # callback route does (supabase.auth.verifyOtp({ type, token_hash })).
    token_hash = _token_hash(_mail_link(stack, email))
    verified = stack.auth.post("/verify", json={"type": "email", "token_hash": token_hash})
    assert verified.status_code == 200, verified.text
    assert verified.json()["user"]["email_confirmed_at"]

    # A token hash is single-use.
    replay = stack.auth.post("/verify", json={"type": "email", "token_hash": token_hash})
    assert replay.status_code in {400, 403}, replay.text

    signed_in = _sign_in(stack, email)
    assert signed_in.status_code == 200, signed_in.text
    access_token = signed_in.json()["access_token"]
    header = _jwt_part(access_token, 0)
    claims = _jwt_part(access_token, 1)
    jwks_kids = {k["kid"] for k in stack.auth.get("/.well-known/jwks.json").json()["keys"]}
    assert header["alg"] in ASYMMETRIC_ALGS
    assert header["kid"] in jwks_kids
    assert claims["iss"] == f"{SUPABASE_URL}/auth/v1"
    assert claims["aud"] == "authenticated"
    assert claims["sub"] == signed_in.json()["user"]["id"]
    assert claims["exp"] - claims["iat"] == 3600


def test_password_shorter_than_policy_is_rejected(stack: Stack) -> None:
    res = stack.auth.post("/signup", json={"email": _new_email(), "password": "short-9ch"})
    assert res.status_code == 422, res.text
    assert res.json().get("error_code") == "weak_password"


@pytest.mark.parametrize(
    ("requested", "expected_prefix"),
    [
        (CALLBACK_URL, CALLBACK_URL),
        # Not on the allowlist: Auth must fall back to site_url, never the foreign host.
        (FOREIGN_URL, SITE_URL),
        ("//evil.example/steal", SITE_URL),
    ],
)
def test_verify_redirect_honours_only_allowlisted_urls(
    stack: Stack, requested: str, expected_prefix: str
) -> None:
    email = _new_email()
    _sign_up(stack, email, redirect_to=requested)
    link = _mail_link(stack, email)
    # The emailed link itself never carries the requested redirect target.
    assert link.startswith(f"{CALLBACK_URL}?"), link
    assert "evil" not in link

    # GoTrue's own /verify endpoint (used by default templates) applies the allowlist too.
    res = stack.auth.get(
        "/verify",
        params={"token": _token_hash(link), "type": "signup", "redirect_to": requested},
        follow_redirects=False,
    )
    assert res.status_code in {302, 303}, res.text
    location = res.headers["location"]
    assert location.startswith(expected_prefix), location
    assert urlsplit(location).hostname == "127.0.0.1", location
