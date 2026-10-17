"""`/api/v1/me` and `/api/v1/me/workspaces` with a local JWKS and a fake repository (no infra)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api.me import get_me_repository
from quiz_api.auth.verifier import TokenVerifier
from quiz_api.main import create_app
from quiz_api.repositories.me import MemberWorkspaceRecord, ProfileRecord, UnknownUserError
from quiz_api.settings import Settings

ME = "/api/v1/me"
ME_WORKSPACES = "/api/v1/me/workspaces"
PROBLEM = "application/problem+json"
T0 = datetime(2026, 10, 1, tzinfo=UTC)


class FakeMeRepository:
    def __init__(self) -> None:
        self.profiles: dict[uuid.UUID, ProfileRecord] = {}
        self.workspaces: dict[uuid.UUID, list[MemberWorkspaceRecord]] = {}
        self.calls: list[tuple[str, uuid.UUID]] = []
        self.deleted_users: set[uuid.UUID] = set()

    def get_profile(self, user_id: uuid.UUID) -> ProfileRecord | None:
        self.calls.append(("get_profile", user_id))
        return self.profiles.get(user_id)

    def ensure_profile(self, user_id: uuid.UUID) -> ProfileRecord:
        self.calls.append(("ensure_profile", user_id))
        if user_id in self.deleted_users:
            raise UnknownUserError
        return self.profiles.setdefault(user_id, ProfileRecord(user_id, None, T0, T0))

    def list_member_workspaces(self, user_id: uuid.UUID) -> list[MemberWorkspaceRecord]:
        self.calls.append(("list_member_workspaces", user_id))
        return self.workspaces.get(user_id, [])


def _workspace(name: str, role: Any = "owner") -> MemberWorkspaceRecord:
    return MemberWorkspaceRecord(
        id=uuid.uuid4(),
        name=name,
        status="active",
        archived_at=None,
        created_at=T0,
        updated_at=T0,
        role=role,
    )


@pytest.fixture
def repo() -> FakeMeRepository:
    return FakeMeRepository()


@pytest.fixture
def auth_app(
    make_verifier: Callable[..., TokenVerifier], repo: FakeMeRepository, auth_kit: Any
) -> FastAPI:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_me_repository] = lambda: repo
    return app


@pytest.fixture
def api(auth_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(auth_app, raise_server_exceptions=False) as client:
        yield client


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _assert_401(response: httpx.Response, token: str | None = None) -> None:
    assert response.status_code == 401
    assert response.headers["content-type"] == PROBLEM
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["status"] == 401
    assert body["title"] == "Unauthorized"
    if token:
        assert token not in response.text


def test_build_verifier_from_settings(auth_kit: Any) -> None:
    configured = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    assert create_app(configured, readiness_checkers=[]).state.token_verifier is not None
    unconfigured = Settings.model_construct()
    assert create_app(unconfigured, readiness_checkers=[]).state.token_verifier is None


def test_me_returns_verified_user_and_profile(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    user_id = uuid.uuid4()
    repo.profiles[user_id] = ProfileRecord(user_id, "Alice", T0, T0)
    token = signing_key.sign(auth_kit.claims(user_id))

    response = api.get(ME, headers=_bearer(token))

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "id": str(user_id),
        "profile": {
            "display_name": "Alice",
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z",
        },
    }
    assert token not in response.text


def test_me_initialises_a_missing_profile_once(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    user_id = uuid.uuid4()
    headers = _bearer(signing_key.sign(auth_kit.claims(user_id)))

    first = api.get(ME, headers=headers)
    second = api.get(ME, headers=headers)

    expected = {
        "id": str(user_id),
        "profile": {
            "display_name": None,
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z",
        },
    }
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == expected
    assert repo.calls == [("ensure_profile", user_id)] * 2
    assert list(repo.profiles) == [user_id]


def test_me_for_a_deleted_user_is_401(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    user_id = uuid.uuid4()
    repo.deleted_users.add(user_id)
    token = signing_key.sign(auth_kit.claims(user_id))

    response = api.get(ME, headers=_bearer(token))

    _assert_401(response, token)
    assert response.headers["www-authenticate"] == 'Bearer realm="api", error="invalid_token"'
    assert repo.profiles == {}


def test_me_workspaces_lists_only_callers_memberships(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    mine = _workspace("Mine", "editor")
    repo.workspaces = {alice: [mine], bob: [_workspace("Bob's")]}

    response = api.get(ME_WORKSPACES, headers=_bearer(signing_key.sign(auth_kit.claims(alice))))

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "items": [
            {
                "id": str(mine.id),
                "name": "Mine",
                "role": "editor",
                "status": "active",
                "archived_at": None,
                "created_at": "2026-10-01T00:00:00Z",
                "updated_at": "2026-10-01T00:00:00Z",
            }
        ]
    }


def test_client_supplied_identity_is_ignored(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    caller, victim = uuid.uuid4(), uuid.uuid4()
    victim_ws = _workspace("Victim")
    repo.workspaces = {victim: [victim_ws]}
    token = signing_key.sign(auth_kit.claims(caller))
    spoof = {"user_id": str(victim), "owner_id": str(victim), "workspace_id": str(victim_ws.id)}
    headers = {**_bearer(token), "X-User-Id": str(victim), "X-Workspace-Id": str(victim_ws.id)}

    workspaces = api.get(ME_WORKSPACES, params=spoof, headers=headers)
    me = api.get(ME, params=spoof, headers=headers)

    assert workspaces.status_code == 200
    assert workspaces.json() == {"items": []}
    assert me.json()["id"] == str(caller)
    assert {user_id for _, user_id in repo.calls} == {caller}


@pytest.mark.parametrize("path", [ME, ME_WORKSPACES])
def test_missing_or_non_bearer_credentials_are_401(
    api: TestClient, repo: FakeMeRepository, signing_key: Any, auth_kit: Any, path: str
) -> None:
    token = signing_key.sign(auth_kit.claims())
    _assert_401(api.get(path))
    _assert_401(api.get(path, headers={"Authorization": "Bearer"}))
    _assert_401(api.get(path, headers={"Authorization": f"Basic {token}"}), token)
    _assert_401(api.get(path, headers={"Authorization": token}), token)
    _assert_401(api.get(path, params={"access_token": token}), token)
    _assert_401(api.get(path, headers={"Cookie": f"sb-access-token={token}"}), token)
    assert repo.calls == []  # the DB is never touched for unauthenticated requests


def test_missing_credentials_get_plain_bearer_challenge(api: TestClient) -> None:
    assert api.get(ME).headers["www-authenticate"] == 'Bearer realm="api"'


def test_invalid_token_is_401_without_leaking_it(
    api: TestClient,
    repo: FakeMeRepository,
    signing_key: Any,
    auth_kit: Any,
    caplog: pytest.LogCaptureFixture,
) -> None:
    token = signing_key.sign(auth_kit.claims(aud="someone-else"))
    with caplog.at_level(logging.DEBUG):
        response = api.get(ME, headers=_bearer(token))
    _assert_401(response, token)
    assert response.headers["www-authenticate"] == 'Bearer realm="api", error="invalid_token"'
    assert "invalid_audience" in caplog.text
    for part in token.split("."):
        assert part not in caplog.text
    assert repo.calls == []


def test_jwks_outage_is_503_not_401(
    api: TestClient,
    jwks_endpoint: Any,
    signing_key: Any,
    auth_kit: Any,
    auth_app: FastAPI,
) -> None:
    jwks_endpoint.error = httpx.ConnectError("down")
    token = signing_key.sign(auth_kit.claims())

    response = api.get(ME, headers=_bearer(token))

    assert response.status_code == 503
    assert response.headers["content-type"] == PROBLEM
    assert response.headers["retry-after"] == "5"
    assert response.headers["cache-control"] == "no-store"
    assert "www-authenticate" not in response.headers
    assert token not in response.text
    assert auth_app.state.token_verifier.jwks.metrics.counts["auth_unavailable"] == 1


def test_unconfigured_verification_is_503(
    repo: FakeMeRepository, signing_key: Any, auth_kit: Any
) -> None:
    app = create_app(Settings.model_construct(), readiness_checkers=[])
    app.dependency_overrides[get_me_repository] = lambda: repo
    with TestClient(app) as client:
        response = client.get(ME, headers=_bearer(signing_key.sign(auth_kit.claims())))
    assert response.status_code == 503
    assert repo.calls == []


def test_no_store_applies_to_every_api_v1_response(api: TestClient) -> None:
    assert api.get("/api/v1/does-not-exist").headers["cache-control"] == "no-store"
    assert api.get("/health/live").headers.get("cache-control") is None
    authed = api.get("/health/live", headers={"Authorization": "Bearer x"})
    assert authed.headers["cache-control"] == "no-store"


def test_openapi_declares_bearer_security_and_problem_responses(auth_app: FastAPI) -> None:
    schema = auth_app.openapi()
    scheme = schema["components"]["securitySchemes"]["SupabaseAccessToken"]
    assert scheme == {
        "type": "http",
        "scheme": "bearer",
        "description": "Supabase Auth access token (asymmetrically signed JWT).",
    }
    for path, operation_id in ((ME, "getMe"), (ME_WORKSPACES, "listMyWorkspaces")):
        operation = schema["paths"][path]["get"]
        assert operation["operationId"] == operation_id
        assert operation["security"] == [{"SupabaseAccessToken": []}]
        assert {"200", "401", "403", "503"} <= set(operation["responses"])
        assert not operation.get("parameters")  # no client-supplied identity inputs
