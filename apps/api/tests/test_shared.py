"""Guest share session (S1b): session tokens and the share check of the /shared routes with an
in-memory link store (no infra).

The SQL (usability from the DB clock, published-only content, personal data never returned) is
covered against the local stack in tests/integration/sharing/test_share_api_contract.py.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from http.cookies import SimpleCookie
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from quiz_api.api.shared import get_search_repository, get_shared_repository
from quiz_api.errors import ProblemType
from quiz_api.main import create_app
from quiz_api.repositories.search import SearchableDocument
from quiz_api.repositories.shared import SharedLink
from quiz_api.settings import Environment, InsecureConfigurationError, Settings
from quiz_api.share_secrets import issue_secret
from quiz_api.share_sessions import (
    SHARE_COOKIE,
    ShareSessionKey,
    issue_token,
    parse_token,
    verify_token,
)

WEB = "https://web.example"
NOW = 1_800_000_000.0

# --- tokens -------------------------------------------------------------------------------------


def test_session_token_binds_link_expiry_and_digest() -> None:
    key = ShareSessionKey.random()
    link = uuid.uuid4()
    digest = issue_secret().digest
    value, expires = issue_token(key, link, digest, 600, now=NOW)
    assert expires == int(NOW) + 600
    claims = parse_token(value, now=NOW)
    assert claims is not None
    assert (claims.link_id, claims.expires_at) == (link, expires)
    assert verify_token(key, value, claims, digest)
    # Another digest (rotate), another key, a tampered expiry: never valid.
    assert not verify_token(key, value, claims, issue_secret().digest)
    assert not verify_token(ShareSessionKey.random(), value, claims, digest)
    forged = value.replace(f".{expires}.", f".{expires + 3600}.")
    forged_claims = parse_token(forged, now=NOW)
    assert forged_claims is not None
    assert not verify_token(key, forged, forged_claims, digest)
    # Expired or malformed: no claims at all.
    assert parse_token(value, now=NOW + 600) is None
    for bad in (None, "", "v1", value + "x", value.replace("v1.", "v2."), value.upper()):
        assert parse_token(bad, now=NOW) is None


def test_session_token_never_carries_the_secret_and_key_needs_32_chars() -> None:
    secret = issue_secret()
    value, _ = issue_token(ShareSessionKey.random(), uuid.uuid4(), secret.digest, 60)
    assert secret.value not in value
    assert secret.digest.hex() not in value
    with pytest.raises(ValueError, match="32"):
        ShareSessionKey.from_secret("short")
    a = ShareSessionKey.from_secret("x" * 32)
    assert a == ShareSessionKey.from_secret("x" * 32)
    assert "x" * 32 not in repr(a)


def test_deployed_settings_refuse_a_short_share_session_secret() -> None:
    base = {
        "APP_ENV": "production",
        "SUPABASE_JWT_ISSUER": "https://auth.example.com/auth/v1",
        "SUPABASE_JWKS_URL": "https://auth.example.com/auth/v1/.well-known/jwks.json",
        "CORS_ALLOWED_ORIGINS": WEB,
    }
    Settings.model_validate({**base, "SHARE_SESSION_SECRET": "k" * 32}).ensure_secure_deployment()
    with pytest.raises(InsecureConfigurationError, match="SHARE_SESSION_SECRET"):
        Settings.model_validate(
            {**base, "SHARE_SESSION_SECRET": "short"}
        ).ensure_secure_deployment()
    with pytest.raises(ValueError, match="less than or equal"):
        Settings.model_validate({"SHARE_SESSION_TTL_SECONDS": 9 * 3600})


# --- routes with fakes --------------------------------------------------------------------------


@dataclass
class FakeLinks:
    links: dict[uuid.UUID, SharedLink] = field(default_factory=dict)
    secrets: dict[uuid.UUID, str] = field(default_factory=dict)

    def add(self, *, usable: bool = True, allow_fork: bool = False) -> SharedLink:
        secret = issue_secret()
        link = SharedLink(
            id=uuid.uuid4(),
            workspace_id=uuid.uuid4(),
            workspace_name="공유 WS",
            archived=False,
            allow_fork=allow_fork,
            expires_at=None,
            usable=usable,
            token_digest=secret.digest,
        )
        self.links[link.id] = link
        self.secrets[link.id] = secret.value
        return link

    def disable(self, link_id: uuid.UUID) -> None:
        self.links[link_id] = replace(self.links[link_id], usable=False)

    # SharedRepository
    def link(self, link_id: uuid.UUID) -> SharedLink | None:
        return self.links.get(link_id)

    def end_read(self) -> None:
        pass

    # SearchRepository (GET /shared/{id})
    def searchable_documents(self, workspace_id: uuid.UUID) -> list[SearchableDocument]:
        return []


@pytest.fixture
def links() -> FakeLinks:
    return FakeLinks()


def _app(links: FakeLinks, **settings: Any) -> FastAPI:
    app = create_app(
        Settings.model_construct(cors_allowed_origins=(WEB,), **settings), readiness_checkers=[]
    )
    app.dependency_overrides[get_shared_repository] = lambda: links
    app.dependency_overrides[get_search_repository] = lambda: links
    return app


@pytest.fixture
def api(links: FakeLinks) -> Iterator[TestClient]:
    with TestClient(_app(links), raise_server_exceptions=False) as client:
        yield client


def _exchange(api: TestClient, share_id: Any, secret: str, origin: str | None = WEB) -> Any:
    headers = {"Origin": origin} if origin else {}
    res = api.post(f"/api/v1/shared/{share_id}/sessions", json={"secret": secret}, headers=headers)
    api.cookies.clear()
    return res


def _cookie(res: Any) -> tuple[str, Any] | None:
    for raw in res.headers.get_list("set-cookie"):
        jar: SimpleCookie = SimpleCookie()
        jar.load(raw)
        if SHARE_COOKIE in jar:
            return raw, jar[SHARE_COOKIE]
    return None


def _read(api: TestClient, share_id: Any, cookie: str | None, path: str = "") -> Any:
    headers = {"Cookie": f"{SHARE_COOKIE}={cookie}"} if cookie else {}
    return api.get(f"/api/v1/shared/{share_id}{path}", headers=headers)


def _type(res: Any) -> str:
    return str(res.json()["type"])


def test_exchange_sets_a_scoped_httponly_cookie_and_privacy_headers(
    api: TestClient, links: FakeLinks
) -> None:
    link = links.add(allow_fork=True)
    res = _exchange(api, link.id, links.secrets[link.id])
    assert res.status_code == 204
    found = _cookie(res)
    assert found is not None
    raw, morsel = found
    assert links.secrets[link.id] not in raw
    lowered = raw.lower()
    assert "httponly" in lowered
    assert "secure" in lowered
    assert morsel["samesite"].lower() == "lax"
    assert morsel["path"] == f"/api/v1/shared/{link.id}"
    assert 0 < int(morsel["max-age"]) <= 8 * 3600
    for r in (res, _read(api, link.id, morsel.value)):
        assert r.headers["cache-control"] == "private, no-store"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["x-robots-tag"] == "noindex, nofollow"
    shared = _read(api, link.id, morsel.value)
    assert shared.status_code == 200
    assert shared.json() == {
        "workspace": {"name": "공유 WS", "archived": False},
        "allow_fork": True,
        "expires_at": None,
        "documents": [],
    }


def test_unknown_wrong_and_unusable_links_answer_one_404(api: TestClient, links: FakeLinks) -> None:
    link = links.add()
    dead = links.add(usable=False)
    secret = links.secrets[link.id]
    answers = [
        _exchange(api, uuid.uuid4(), secret),
        _exchange(api, "not-a-uuid", secret),
        _exchange(api, link.id, links.secrets[dead.id]),
        _exchange(api, link.id, "A" * 43),
        _exchange(api, link.id, "malformed"),
        _exchange(api, dead.id, links.secrets[dead.id]),
    ]
    bodies = {
        (r.status_code, r.json()["type"], r.json()["title"], r.json()["detail"]) for r in answers
    }
    assert bodies == {
        (404, ProblemType.SHARE_UNAVAILABLE, "Not Found", "This share link is not available.")
    }
    assert all(_cookie(r) is None for r in answers)


def test_exchange_needs_an_allowlisted_origin(api: TestClient, links: FakeLinks) -> None:
    link = links.add()
    for origin in (None, "https://evil.example", "null"):
        res = _exchange(api, link.id, links.secrets[link.id], origin=origin)
        assert res.status_code == 403
        assert _cookie(res) is None


def test_exchange_is_rate_limited_per_client_and_link(links: FakeLinks) -> None:
    app = _app(links, share_exchange_rate_per_minute=3)
    link = links.add()
    other = links.add()
    with TestClient(app, raise_server_exceptions=False) as api:
        statuses = [_exchange(api, link.id, "A" * 43).status_code for _ in range(4)]
        assert statuses == [404, 404, 404, 429]
        limited = _exchange(api, link.id, links.secrets[link.id])
        assert limited.status_code == 429
        assert int(limited.headers["retry-after"]) >= 1
        assert _exchange(api, other.id, links.secrets[other.id]).status_code == 204


def test_reads_recheck_the_link_on_every_request(api: TestClient, links: FakeLinks) -> None:
    link = links.add()
    other = links.add()
    found = _cookie(_exchange(api, link.id, links.secrets[link.id]))
    assert found is not None
    session = found[1].value

    assert _read(api, link.id, session).status_code == 200
    # No cookie, a malformed one or a forged MAC: 401 (start a session first).
    for cookie in (None, "garbage", session[:-2] + ("AA" if session[-2:] != "AA" else "BB")):
        res = _read(api, link.id, cookie)
        assert res.status_code == 401
        assert _type(res) == ProblemType.SHARE_SESSION_REQUIRED
    # The session of one link never opens another (even when that one is usable).
    res = _read(api, other.id, session)
    assert (res.status_code, _type(res)) == (404, ProblemType.SHARE_UNAVAILABLE)
    # Revoked / expired / deleted (usable = false in the DB): the live session dies at once.
    links.disable(link.id)
    for path in ("", "/questions", f"/questions/{uuid.uuid4()}", f"/documents/{uuid.uuid4()}"):
        res = _read(api, link.id, session, path)
        assert (res.status_code, _type(res)) == (404, ProblemType.SHARE_UNAVAILABLE), path
    res = api.post(
        f"/api/v1/shared/{link.id}/search",
        json={"query": "x"},
        headers={"Cookie": f"{SHARE_COOKIE}={session}"},
    )
    assert (res.status_code, _type(res)) == (404, ProblemType.SHARE_UNAVAILABLE)


def test_share_check_runs_before_request_validation(api: TestClient, links: FakeLinks) -> None:
    link = links.add(usable=False)
    res = api.post(f"/api/v1/shared/{link.id}/search", json={"nonsense": True})
    assert res.status_code == 401
    res = _read(api, link.id, None, "/questions?limit=0")
    assert res.status_code == 401


def test_deployed_without_a_session_key_refuses_shared_routes(links: FakeLinks) -> None:
    link = links.add()
    app = _app(links)
    app.state.settings = Settings.model_construct(
        app_env=Environment.PRODUCTION, cors_allowed_origins=(WEB,)
    )
    with TestClient(app, raise_server_exceptions=False) as api:
        assert _exchange(api, link.id, links.secrets[link.id]).status_code == 503
        assert _read(api, link.id, "v1.x").status_code == 503


def test_a_configured_key_survives_restarts(links: FakeLinks) -> None:
    link = links.add()
    settings = {"share_session_secret": SecretStr("s" * 40)}
    with TestClient(_app(links, **settings), raise_server_exceptions=False) as first:
        found = _cookie(_exchange(first, link.id, links.secrets[link.id]))
    assert found is not None
    with TestClient(_app(links, **settings), raise_server_exceptions=False) as second:
        assert _read(second, link.id, found[1].value).status_code == 200
    # Without a configured key each process has its own random key.
    with TestClient(_app(links), raise_server_exceptions=False) as third:
        assert _read(third, link.id, found[1].value).status_code == 401
