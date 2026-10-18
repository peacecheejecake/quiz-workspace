"""Workspace API (M3.1a) route wiring with in-memory fakes (no infra).

The DB behaviour (SQL, locks, activity rows, idempotency table) is covered against the local stack
in tests/integration/workspaces/test_workspace_lifecycle.py.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api.workspaces import get_idempotency_store, get_workspace_repository
from quiz_api.authz import LockMode, MembershipRecord, Role, get_access_repository
from quiz_api.errors import ProblemType
from quiz_api.idempotency import request_hash
from quiz_api.main import create_app
from quiz_api.repositories.idempotency import StoredResponse
from quiz_api.repositories.workspaces import MemberWorkspace, WorkspaceRecord
from quiz_api.settings import Settings
from sqlalchemy.exc import IntegrityError

BASE = "/api/v1/workspaces"
PROBLEM = "application/problem+json"
T0 = datetime(2026, 10, 1, tzinfo=UTC)


@dataclass
class FakeSession:
    rollbacks: int = 0

    def rollback(self) -> None:
        self.rollbacks += 1


@dataclass
class World:
    """Fake AccessRepository + WorkspaceRepository over shared in-memory state."""

    workspaces: dict[uuid.UUID, WorkspaceRecord] = field(default_factory=dict)
    deleted: set[uuid.UUID] = field(default_factory=set)
    members: dict[tuple[uuid.UUID, uuid.UUID], Role] = field(default_factory=dict)
    calls: list[tuple[str, Any]] = field(default_factory=list)
    commits: int = 0
    session: FakeSession = field(default_factory=FakeSession)
    fail_create: bool = False

    def add(self, owner: uuid.UUID, name: str = "WS", status: str = "active") -> uuid.UUID:
        ws = uuid.uuid4()
        archived_at = T0 if status == "archived" else None
        self.workspaces[ws] = WorkspaceRecord(ws, name, status, archived_at, T0, T0)  # type: ignore[arg-type]
        self.members[(ws, owner)] = Role.OWNER
        return ws

    # AccessRepository
    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        self.calls.append(("load_membership", lock))
        ws = self.workspaces.get(workspace_id)
        role = self.members.get((workspace_id, user_id))
        if ws is None or workspace_id in self.deleted or role is None:
            return None
        return MembershipRecord(workspace_id, user_id, role, ws.status, ws.archived_at)

    def resolve_workspace_id(self, *_: Any) -> uuid.UUID | None:  # pragma: no cover - unused
        raise AssertionError

    # WorkspaceRepository
    def commit(self) -> None:
        self.commits += 1

    def list_for_member(self, user_id: uuid.UUID, status: str) -> list[MemberWorkspace]:
        self.calls.append(("list_for_member", status))
        return [
            MemberWorkspace(ws, role.value)
            for (wid, uid), role in self.members.items()
            if uid == user_id
            and wid not in self.deleted
            and (ws := self.workspaces[wid]).status == status
        ]

    def get(self, workspace_id: uuid.UUID) -> WorkspaceRecord:
        return self.workspaces[workspace_id]

    def create(self, owner_id: uuid.UUID, name: str) -> WorkspaceRecord:
        self.calls.append(("create", name))
        if self.fail_create:
            raise IntegrityError("insert", {}, Exception("fk"))
        return self.workspaces[self.add(owner_id, name)]

    def _set(self, workspace_id: uuid.UUID, **changes: Any) -> WorkspaceRecord:
        self.workspaces[workspace_id] = replace(self.workspaces[workspace_id], **changes)
        return self.workspaces[workspace_id]

    def rename(self, workspace_id: uuid.UUID, actor_id: uuid.UUID, name: str) -> WorkspaceRecord:
        self.calls.append(("rename", name))
        return self._set(workspace_id, name=name)

    def archive(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> WorkspaceRecord:
        self.calls.append(("archive", workspace_id))
        return self._set(workspace_id, status="archived", archived_at=T0)

    def restore(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> WorkspaceRecord:
        self.calls.append(("restore", workspace_id))
        return self._set(workspace_id, status="active", archived_at=None)

    def soft_delete(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> None:
        self.calls.append(("soft_delete", workspace_id))
        self.deleted.add(workspace_id)


@dataclass
class FakeIdempotencyStore:
    stored: dict[tuple[uuid.UUID, str, str], StoredResponse] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    def lock(self, user_id: uuid.UUID, scope: str, key: str) -> None:
        self.calls.append("lock")

    def find(self, user_id: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        self.calls.append("find")
        return self.stored.get((user_id, scope, key))

    def save(
        self, user_id: uuid.UUID, scope: str, key: str, req_hash: str, status: int, body: Any
    ) -> None:
        self.calls.append("save")
        self.stored[(user_id, scope, key)] = StoredResponse(req_hash, status, body)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def store() -> FakeIdempotencyStore:
    return FakeIdempotencyStore()


@pytest.fixture
def api(
    make_verifier: Callable[..., Any], world: World, store: FakeIdempotencyStore, auth_kit: Any
) -> Iterator[TestClient]:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app: FastAPI = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_workspace_repository] = lambda: world
    app.dependency_overrides[get_idempotency_store] = lambda: store
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Callable[[uuid.UUID], dict[str, str]]:
    def make(user_id: uuid.UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}"}

    return make


def _problem(res: Any, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    assert res.status_code == status, res.text
    assert res.headers["content-type"] == PROBLEM
    body: dict[str, Any] = res.json()
    assert body["type"] == problem_type
    return body


# --- auth ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", ""),
        ("GET", ""),
        ("GET", "/{id}"),
        ("PATCH", "/{id}"),
        ("DELETE", "/{id}"),
        ("POST", "/{id}/archive"),
        ("POST", "/{id}/restore"),
    ],
)
def test_every_route_requires_a_token(
    api: TestClient, world: World, method: str, path: str
) -> None:
    res = api.request(method, BASE + path.format(id=uuid.uuid4()), json={"name": "x"})
    _problem(res, 401)
    assert world.calls == []


# --- create + idempotency -----------------------------------------------------------------------


def test_create_returns_201_owner_workspace_and_commits(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    user = uuid.uuid4()
    res = api.post(BASE, json={"name": "  Alpha "}, headers=bearer(user))
    assert res.status_code == 201
    body = res.json()
    assert (body["name"], body["role"], body["status"]) == ("Alpha", "owner", "active")
    assert world.commits == 1
    assert store.calls == []  # no key, no idempotency storage


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "  "}, {"name": "x" * 201}, {"name": "a\tb"}, {"name": 1}],
)
def test_create_rejects_invalid_names(
    api: TestClient, world: World, bearer: Any, body: dict[str, Any]
) -> None:
    _problem(api.post(BASE, json=body, headers=bearer(uuid.uuid4())), 422)
    assert world.commits == 0


def test_create_rejects_unknown_fields(api: TestClient, world: World, bearer: Any) -> None:
    owner = str(uuid.uuid4())
    res = api.post(BASE, json={"name": "x", "owner_id": owner}, headers=bearer(uuid.uuid4()))
    _problem(res, 422)
    assert owner not in res.text
    assert world.calls == []


def test_create_with_key_stores_then_replays(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    user = uuid.uuid4()
    headers = {**bearer(user), "Idempotency-Key": "abc-123"}
    first = api.post(BASE, json={"name": "Alpha"}, headers=headers)
    assert first.status_code == 201
    assert store.calls == ["lock", "find", "save"]
    stored = store.stored[(user, "POST /workspaces", "abc-123")]
    assert (stored.status, stored.body) == (201, first.json())
    assert stored.request_hash == request_hash({"name": "Alpha"})

    second = api.post(BASE, json={"name": "Alpha "}, headers=headers)
    assert second.status_code == 201
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json() == first.json()
    assert store.calls == ["lock", "find", "save", "lock", "find"]
    assert [c for c in world.calls if c[0] == "create"] == [("create", "Alpha")]
    assert world.commits == 1


def test_create_with_reused_key_and_other_body_is_409(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    user = uuid.uuid4()
    store.stored[(user, "POST /workspaces", "k")] = StoredResponse(
        request_hash({"name": "Alpha"}), 201, {"id": "x"}
    )
    res = api.post(BASE, json={"name": "Beta"}, headers={**bearer(user), "Idempotency-Key": "k"})
    body = _problem(res, 409, ProblemType.IDEMPOTENCY_KEY_REUSED)
    assert "Alpha" not in res.text
    assert "Beta" not in res.text
    assert body["detail"]
    assert world.calls == []


def test_idempotency_keys_are_per_user(
    api: TestClient, store: FakeIdempotencyStore, bearer: Any
) -> None:
    other = uuid.uuid4()
    store.stored[(other, "POST /workspaces", "k")] = StoredResponse(
        request_hash({"name": "Alpha"}), 201, {"id": "other"}
    )
    res = api.post(
        BASE, json={"name": "Alpha"}, headers={**bearer(uuid.uuid4()), "Idempotency-Key": "k"}
    )
    assert res.status_code == 201
    assert res.json()["id"] != "other"


@pytest.mark.parametrize("key", ["", "has space", "x" * 201])
def test_malformed_idempotency_key_is_422(
    api: TestClient, store: FakeIdempotencyStore, bearer: Any, key: str
) -> None:
    res = api.post(
        BASE, json={"name": "Alpha"}, headers={**bearer(uuid.uuid4()), "Idempotency-Key": key}
    )
    _problem(res, 422)
    assert store.calls == []


def test_create_for_a_deleted_user_is_401(api: TestClient, world: World, bearer: Any) -> None:
    world.fail_create = True
    res = api.post(BASE, json={"name": "Alpha"}, headers=bearer(uuid.uuid4()))
    _problem(res, 401)
    assert world.session.rollbacks == 1
    assert world.commits == 0


# --- list / get ---------------------------------------------------------------------------------


def test_list_filters_by_status_and_defaults_to_active(
    api: TestClient, world: World, bearer: Any
) -> None:
    user = uuid.uuid4()
    active, archived = world.add(user, "A"), world.add(user, "B", status="archived")
    world.add(uuid.uuid4(), "foreign")
    headers = bearer(user)
    assert [w["id"] for w in api.get(BASE, headers=headers).json()["items"]] == [str(active)]
    res = api.get(BASE, params={"status": "archived"}, headers=headers)
    assert [(w["id"], w["role"]) for w in res.json()["items"]] == [(str(archived), "owner")]
    _problem(api.get(BASE, params={"status": "deleted"}, headers=headers), 422)


def test_get_uses_read_access_without_locks(api: TestClient, world: World, bearer: Any) -> None:
    owner, viewer = uuid.uuid4(), uuid.uuid4()
    ws = world.add(owner)
    world.members[(ws, viewer)] = Role.VIEWER
    res = api.get(f"{BASE}/{ws}", headers=bearer(viewer))
    assert res.status_code == 200
    assert res.json()["role"] == "viewer"
    assert ("load_membership", LockMode.NONE) in world.calls
    assert world.commits == 0


# --- lifecycle authz ----------------------------------------------------------------------------

LIFECYCLE = [
    ("PATCH", "", {"name": "New"}),
    ("POST", "/archive", None),
    ("POST", "/restore", None),
    ("DELETE", "", None),
]


@pytest.mark.parametrize(("method", "suffix", "body"), LIFECYCLE)
def test_lifecycle_routes_lock_for_update_and_commit(
    api: TestClient, world: World, bearer: Any, method: str, suffix: str, body: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    res = api.request(method, f"{BASE}/{ws}{suffix}", json=body, headers=bearer(owner))
    assert res.status_code == (204 if method == "DELETE" else 200), res.text
    assert world.calls[0] == ("load_membership", LockMode.UPDATE)
    assert world.commits == 1


@pytest.mark.parametrize(("method", "suffix", "body"), LIFECYCLE)
@pytest.mark.parametrize("role", [Role.EDITOR, Role.VIEWER])
def test_lifecycle_routes_are_owner_only(
    api: TestClient, world: World, bearer: Any, method: str, suffix: str, body: Any, role: Role
) -> None:
    member = uuid.uuid4()
    ws = world.add(uuid.uuid4())
    world.members[(ws, member)] = role
    res = api.request(method, f"{BASE}/{ws}{suffix}", json=body, headers=bearer(member))
    _problem(res, 403, ProblemType.INSUFFICIENT_ROLE)
    assert world.commits == 0


@pytest.mark.parametrize(("method", "suffix", "body"), [*LIFECYCLE, ("GET", "", None)])
def test_unknown_foreign_and_deleted_workspaces_are_the_same_404(
    api: TestClient, world: World, bearer: Any, method: str, suffix: str, body: Any
) -> None:
    user = uuid.uuid4()
    foreign = world.add(uuid.uuid4(), "Secret")
    deleted = world.add(user)
    world.deleted.add(deleted)

    def call(ws: uuid.UUID) -> dict[str, Any]:
        res = api.request(method, f"{BASE}/{ws}{suffix}", json=body, headers=bearer(user))
        assert "Secret" not in res.text
        problem = _problem(res, 404)
        return {k: v for k, v in problem.items() if k not in {"instance", "request_id"}}

    assert call(uuid.uuid4()) == call(foreign) == call(deleted)
    assert world.commits == 0


def test_archived_workspace_rejects_rename_but_allows_lifecycle(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner, status="archived")
    headers = bearer(owner)
    _problem(
        api.patch(f"{BASE}/{ws}", json={"name": "x"}, headers=headers),
        403,
        ProblemType.WORKSPACE_ARCHIVED,
    )
    assert api.post(f"{BASE}/{ws}/archive", headers=headers).json()["status"] == "archived"
    assert api.post(f"{BASE}/{ws}/restore", headers=headers).json()["status"] == "active"
    world.archive(ws, owner)
    assert api.delete(f"{BASE}/{ws}", headers=headers).status_code == 204


def test_rename_validates_before_writing(api: TestClient, world: World, bearer: Any) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    for body in ({"name": " "}, {}, {"name": "ok", "status": "deleted"}):
        _problem(api.patch(f"{BASE}/{ws}", json=body, headers=bearer(owner)), 422)
    assert world.commits == 0


def test_delete_returns_empty_204(api: TestClient, world: World, bearer: Any) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    res = api.delete(f"{BASE}/{ws}", headers=bearer(owner))
    assert (res.status_code, res.content) == (204, b"")
    _problem(api.delete(f"{BASE}/{ws}", headers=bearer(owner)), 404)


# --- OpenAPI ------------------------------------------------------------------------------------


def test_openapi_documents_the_workspace_routes(api: TestClient) -> None:
    spec = api.get("/api/v1/openapi.json").json()
    paths = spec["paths"]
    ops = {
        (method, path): op["operationId"]
        for path, item in paths.items()
        for method, op in item.items()
        if "workspaces" in op.get("tags", [])
    }
    assert ops == {
        ("post", "/api/v1/workspaces"): "createWorkspace",
        ("get", "/api/v1/workspaces"): "listWorkspaces",
        ("get", "/api/v1/workspaces/{workspace_id}"): "getWorkspace",
        ("patch", "/api/v1/workspaces/{workspace_id}"): "updateWorkspace",
        ("delete", "/api/v1/workspaces/{workspace_id}"): "deleteWorkspace",
        ("post", "/api/v1/workspaces/{workspace_id}/archive"): "archiveWorkspace",
        ("post", "/api/v1/workspaces/{workspace_id}/restore"): "restoreWorkspace",
    }
    for path, code in (
        ("/api/v1/workspaces", "201"),
        ("/api/v1/workspaces/{workspace_id}/archive", "200"),
        ("/api/v1/workspaces/{workspace_id}/restore", "200"),
    ):
        op = paths[path]["post"]
        assert {code, "409", "422", "401"} <= set(op["responses"]), path
        assert any(p["name"] == "Idempotency-Key" and p["in"] == "header" for p in op["parameters"])
    assert "204" in paths["/api/v1/workspaces/{workspace_id}"]["delete"]["responses"]
    schema = spec["components"]["schemas"]["Workspace"]
    assert set(schema["required"]) == {
        "id",
        "name",
        "role",
        "status",
        "archived_at",
        "created_at",
        "updated_at",
    }


# --- archive/restore idempotency ----------------------------------------------------------------


def _lifecycle_call(api: TestClient, ws: uuid.UUID, action: str, headers: dict[str, str]) -> Any:
    return api.post(f"{BASE}/{ws}/{action}", headers=headers)


def test_lost_archive_response_is_replayed_after_an_intervening_restore(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    keyed = {**bearer(owner), "Idempotency-Key": "arch-1"}

    first = _lifecycle_call(api, ws, "archive", keyed)
    assert first.status_code == 200
    assert first.json()["status"] == "archived"
    # The client lost that response; meanwhile the workspace is restored (no key).
    assert _lifecycle_call(api, ws, "restore", bearer(owner)).json()["status"] == "active"
    seen = len(world.calls)

    retry = _lifecycle_call(api, ws, "archive", keyed)
    assert retry.status_code == 200
    assert retry.headers["idempotent-replayed"] == "true"
    assert retry.json() == first.json()
    assert world.workspaces[ws].status == "active", "the replay changes nothing"
    assert [c for c in world.calls[seen:] if c[0] != "load_membership"] == []
    stored = store.stored[(owner, f"POST /workspaces/{ws}/lifecycle", "arch-1")]
    assert stored.request_hash == request_hash({"action": "archive"})


def test_lifecycle_key_reused_for_the_other_action_is_409(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    keyed = {**bearer(owner), "Idempotency-Key": "k"}
    assert _lifecycle_call(api, ws, "archive", keyed).status_code == 200
    _problem(_lifecycle_call(api, ws, "restore", keyed), 409, ProblemType.IDEMPOTENCY_KEY_REUSED)
    assert world.workspaces[ws].status == "archived"


def test_lifecycle_key_is_independent_per_workspace(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    one, two = world.add(owner), world.add(owner)
    keyed = {**bearer(owner), "Idempotency-Key": "same"}
    a = _lifecycle_call(api, one, "archive", keyed)
    b = _lifecycle_call(api, two, "archive", keyed)
    assert "idempotent-replayed" not in b.headers
    assert (a.json()["id"], b.json()["id"]) == (str(one), str(two))
    assert world.workspaces[two].status == "archived"


def test_lifecycle_replay_requires_current_access(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.add(owner)
    keyed = {**bearer(owner), "Idempotency-Key": "gone"}
    assert _lifecycle_call(api, ws, "archive", keyed).status_code == 200
    world.deleted.add(ws)
    store.calls.clear()
    _problem(_lifecycle_call(api, ws, "archive", keyed), 404)
    assert store.calls == [], "no replay lookup without access"
