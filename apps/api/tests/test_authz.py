"""Workspace authorization layer (A1.3) without infra: the permission matrix, the pure decision
function, and the FastAPI dependencies on a minimal app with a fake access repository."""

import uuid
from collections.abc import Callable, Iterator
from typing import Annotated, Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from quiz_api.authz import (
    PERMISSIONS,
    Action,
    LockMode,
    MembershipRecord,
    ResourceAccess,
    ResourceType,
    Role,
    WorkspaceAccess,
    decide,
    get_access_repository,
    require_resource_access,
    require_workspace_access,
)
from quiz_api.authz.permissions import ActionPolicy
from quiz_api.authz.repository import RESOURCES
from quiz_api.errors import ProblemType
from quiz_api.main import create_app
from quiz_api.repositories.me import MembershipRole
from quiz_api.settings import Settings
from starlette.exceptions import HTTPException

PROBLEM = "application/problem+json"
OWN, EDT, VWR = Role.OWNER, Role.EDITOR, Role.VIEWER

# --- The matrix, spelled out independently of the implementation ----------------------------
# action: (roles allowed, writes, allowed when archived, lock)
EXPECTED_MATRIX: dict[Action, tuple[set[Role], bool, bool, LockMode]] = {
    Action.READ: ({OWN, EDT, VWR}, False, True, LockMode.NONE),
    Action.PRACTICE: ({OWN, EDT, VWR}, True, False, LockMode.SHARE),
    Action.DOCUMENT_EDIT: ({OWN, EDT}, True, False, LockMode.SHARE),
    Action.QUESTION_EDIT: ({OWN, EDT}, True, False, LockMode.SHARE),
    Action.WORKSPACE_UPDATE: ({OWN}, True, False, LockMode.UPDATE),
    Action.WORKSPACE_ARCHIVE: ({OWN}, True, True, LockMode.UPDATE),
    Action.WORKSPACE_RESTORE: ({OWN}, True, True, LockMode.UPDATE),
    Action.WORKSPACE_DELETE: ({OWN}, True, True, LockMode.UPDATE),
    Action.MEMBERS_MANAGE: ({OWN}, True, False, LockMode.UPDATE),
    Action.SHARE_CREATE: ({OWN}, True, False, LockMode.SHARE),
    Action.SHARE_MANAGE: ({OWN}, True, True, LockMode.SHARE),
}


def test_permission_matrix_is_exactly_the_documented_one() -> None:
    assert set(PERMISSIONS) == set(Action) == set(EXPECTED_MATRIX)
    for action, (roles, writes, archived_ok, lock) in EXPECTED_MATRIX.items():
        assert PERMISSIONS[action] == ActionPolicy(frozenset(roles), writes, archived_ok, lock)


def test_matrix_invariants() -> None:
    for action, policy in PERMISSIONS.items():
        assert Role.OWNER in policy.roles, f"owner can do everything ({action})"
        assert policy.writes or policy.allowed_when_archived, f"reads work when archived ({action})"
        if not policy.writes:
            assert policy.lock is LockMode.NONE
        else:
            assert policy.lock is not LockMode.NONE, f"writes lock the rows they check ({action})"
    viewer = {a for a, p in PERMISSIONS.items() if p.allows(Role.VIEWER)}
    editor = {a for a, p in PERMISSIONS.items() if p.allows(Role.EDITOR)}
    assert viewer == {Action.READ, Action.PRACTICE}
    assert editor == viewer | {Action.DOCUMENT_EDIT, Action.QUESTION_EDIT}
    with pytest.raises(TypeError):
        PERMISSIONS[Action.READ] = PERMISSIONS[Action.PRACTICE]  # type: ignore[index]


def test_role_values_match_the_db_and_api_literal() -> None:
    assert {r.value for r in Role} == set(MembershipRole.__args__)  # type: ignore[attr-defined]


def test_every_resource_type_has_a_binding_with_a_workspace_column() -> None:
    assert set(RESOURCES) == set(ResourceType)
    for binding in RESOURCES.values():
        assert binding.workspace_id.name == "workspace_id"
        assert binding.id.name == "id"


# --- decide(): pure outcome table -------------------------------------------------------------
def _record(role: Role, status: str = "active") -> MembershipRecord:
    return MembershipRecord(
        workspace_id=uuid.uuid4(), user_id=uuid.uuid4(), role=role, status=status, archived_at=None
    )


def _outcome(record: MembershipRecord | None, action: Action) -> tuple[int, str | None]:
    try:
        decide(record, action)
    except HTTPException as exc:
        return exc.status_code, getattr(exc, "problem_type", None)
    return 200, None


@pytest.mark.parametrize("action", list(Action))
@pytest.mark.parametrize("role", list(Role))
@pytest.mark.parametrize("status", ["active", "archived"])
def test_decide_follows_the_matrix(action: Action, role: Role, status: str) -> None:
    roles, writes, archived_ok, _ = EXPECTED_MATRIX[action]
    if role not in roles:
        expected: tuple[int, str | None] = (403, ProblemType.INSUFFICIENT_ROLE)
    elif status == "archived" and not archived_ok:
        expected = (403, ProblemType.WORKSPACE_ARCHIVED)
    else:
        expected = (200, None)
    assert _outcome(_record(role, status), action) == expected
    if expected[0] == 200:
        access = decide(_record(role, status), action)
        assert (access.role, access.status, access.action) == (role, status, action)
    if status == "archived" and writes and not archived_ok:
        assert expected[0] == 403


def test_decide_without_membership_is_404() -> None:
    for action in Action:
        assert _outcome(None, action) == (404, None)


# --- Dependencies on a minimal app ------------------------------------------------------------
class FakeAccessRepository:
    """In-memory workspaces/memberships/jobs; soft-deleted workspaces behave like the SQL query."""

    def __init__(self) -> None:
        self.workspaces: dict[uuid.UUID, str] = {}
        self.members: dict[tuple[uuid.UUID, uuid.UUID], Role] = {}
        self.jobs: dict[uuid.UUID, uuid.UUID] = {}
        self.calls: list[tuple[str, Any]] = []

    def workspace(self, status: str = "active") -> uuid.UUID:
        ws = uuid.uuid4()
        self.workspaces[ws] = status
        return ws

    def add_member(self, ws: uuid.UUID, user: uuid.UUID, role: Role) -> None:
        self.members[(ws, user)] = role

    def job(self, ws: uuid.UUID) -> uuid.UUID:
        job = uuid.uuid4()
        self.jobs[job] = ws
        return job

    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        self.calls.append(("load_membership", (workspace_id, user_id, lock)))
        status = self.workspaces.get(workspace_id)
        role = self.members.get((workspace_id, user_id))
        if status is None or status == "deleted" or role is None:
            return None
        return MembershipRecord(workspace_id, user_id, role, status, None)

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        self.calls.append(("resolve_workspace_id", (resource_type, resource_id)))
        assert resource_type is ResourceType.JOB
        return self.jobs.get(resource_id)


class Probe(BaseModel):
    workspace_id: uuid.UUID
    role: Role
    action: Action


class ClaimedWorkspace(BaseModel):
    workspace_id: uuid.UUID | None = None


def _probe(access: WorkspaceAccess) -> Probe:
    return Probe(workspace_id=access.workspace_id, role=access.role, action=access.action)


def probe_router() -> APIRouter:
    """Test-only routes: never part of `create_app`'s production router."""
    router = APIRouter(prefix="/authz-probe")
    ws_read = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.READ))]
    ws_doc = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.DOCUMENT_EDIT))]
    ws_restore = Annotated[
        WorkspaceAccess, Depends(require_workspace_access(Action.WORKSPACE_RESTORE, param="id"))
    ]
    job_read = Annotated[
        ResourceAccess,
        Depends(require_resource_access(ResourceType.JOB, Action.READ, param="job_id")),
    ]
    nested_job = Annotated[
        ResourceAccess,
        Depends(
            require_resource_access(
                ResourceType.JOB,
                Action.DOCUMENT_EDIT,
                param="job_id",
                workspace_param="workspace_id",
            )
        ),
    ]

    @router.get("/workspaces/{workspace_id}")
    def read(access: ws_read) -> Probe:
        return _probe(access)

    @router.post("/workspaces/{workspace_id}/documents")
    def edit(access: ws_doc, body: ClaimedWorkspace) -> Probe:
        access.ensure_same_workspace(body.workspace_id)
        return _probe(access)

    @router.post("/workspaces/{id}/restore")
    def restore(access: ws_restore) -> Probe:
        return _probe(access)

    @router.get("/jobs/{job_id}")
    def job(access: job_read) -> Probe:
        return _probe(access.workspace)

    @router.post("/workspaces/{workspace_id}/jobs/{job_id}/cancel")
    def cancel(access: nested_job) -> Probe:
        return _probe(access.workspace)

    @router.get("/missing-placeholder")
    def missing(access: ws_read) -> Probe:  # pragma: no cover - never reached
        return _probe(access)

    return router


@pytest.fixture
def access_repo() -> FakeAccessRepository:
    return FakeAccessRepository()


@pytest.fixture
def authz_app(
    make_verifier: Callable[..., Any], access_repo: FakeAccessRepository, auth_kit: Any
) -> FastAPI:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.include_router(probe_router(), prefix="/api/v1")
    app.dependency_overrides[get_access_repository] = lambda: access_repo
    return app


@pytest.fixture
def api(authz_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(authz_app, raise_server_exceptions=False) as client:
        yield client


Bearer = Callable[[uuid.UUID], dict[str, str]]


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Bearer:
    def make(user_id: uuid.UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}"}

    return make


BASE = "/api/v1/authz-probe"


def _assert_problem(res: Any, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    assert res.status_code == status, res.text
    assert res.headers["content-type"] == PROBLEM
    assert res.headers["cache-control"] == "no-store"
    body: dict[str, Any] = res.json()
    assert body["status"] == status
    assert body["type"] == problem_type
    return body


def test_production_app_has_no_probe_routes() -> None:
    app = create_app(Settings.model_construct(), readiness_checkers=[])
    assert not [r for r in app.routes if "authz-probe" in getattr(r, "path", "")]


def test_member_reads_and_lock_follows_the_action(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = access_repo.workspace()
    access_repo.add_member(ws, user, Role.EDITOR)

    read = api.get(f"{BASE}/workspaces/{ws}", headers=bearer(user))
    edit = api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=bearer(user))

    assert read.status_code == edit.status_code == 200
    assert read.json() == {"workspace_id": str(ws), "role": "editor", "action": "workspace.read"}
    assert [c[1][2] for c in access_repo.calls] == [LockMode.NONE, LockMode.SHARE]


def test_non_member_nonexistent_and_deleted_are_the_same_404(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    foreign = access_repo.workspace()
    access_repo.add_member(foreign, other, Role.OWNER)
    deleted = access_repo.workspace(status="deleted")
    access_repo.add_member(deleted, user, Role.OWNER)

    bodies = []
    for ws in (foreign, deleted, uuid.uuid4()):
        for res in (
            api.get(f"{BASE}/workspaces/{ws}", headers=bearer(user)),
            api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=bearer(user)),
        ):
            body = _assert_problem(res, 404)
            bodies.append({k: v for k, v in body.items() if k not in {"instance", "request_id"}})
    assert all(b == bodies[0] for b in bodies)
    assert bodies[0]["detail"] == "Workspace not found."


def test_viewer_write_is_403_insufficient_role(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    viewer = uuid.uuid4()
    ws = access_repo.workspace()
    access_repo.add_member(ws, viewer, Role.VIEWER)

    assert api.get(f"{BASE}/workspaces/{ws}", headers=bearer(viewer)).status_code == 200
    res = api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=bearer(viewer))
    _assert_problem(res, 403, ProblemType.INSUFFICIENT_ROLE)
    res = api.post(f"{BASE}/workspaces/{ws}/restore", headers=bearer(viewer))
    _assert_problem(res, 403, ProblemType.INSUFFICIENT_ROLE)


def test_archived_workspace_is_read_only_but_restorable(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    owner = uuid.uuid4()
    ws = access_repo.workspace(status="archived")
    access_repo.add_member(ws, owner, Role.OWNER)

    assert api.get(f"{BASE}/workspaces/{ws}", headers=bearer(owner)).status_code == 200
    res = api.post(f"{BASE}/workspaces/{ws}/documents", json={}, headers=bearer(owner))
    body = _assert_problem(res, 403, ProblemType.WORKSPACE_ARCHIVED)
    assert "archived" in body["detail"]
    restore = api.post(f"{BASE}/workspaces/{ws}/restore", headers=bearer(owner))
    assert restore.status_code == 200
    assert access_repo.calls[-1][1][2] is LockMode.UPDATE


def test_body_workspace_id_must_match_the_path_workspace(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    mine, also_mine = access_repo.workspace(), access_repo.workspace()
    access_repo.add_member(mine, user, Role.OWNER)
    access_repo.add_member(also_mine, user, Role.OWNER)

    url = f"{BASE}/workspaces/{mine}/documents"
    ok = api.post(url, json={"workspace_id": str(mine)}, headers=bearer(user))
    assert ok.status_code == 200
    res = api.post(url, json={"workspace_id": str(also_mine)}, headers=bearer(user))
    _assert_problem(res, 404)


def test_resource_routes_resolve_the_workspace_from_the_db(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    alice_ws, bob_ws = access_repo.workspace(), access_repo.workspace()
    access_repo.add_member(alice_ws, alice, Role.OWNER)
    access_repo.add_member(bob_ws, bob, Role.OWNER)
    access_repo.add_member(bob_ws, alice, Role.VIEWER)
    alice_job, bob_job = access_repo.job(alice_ws), access_repo.job(bob_ws)

    res = api.get(f"{BASE}/jobs/{alice_job}", headers=bearer(alice))
    assert res.status_code == 200
    assert res.json()["workspace_id"] == str(alice_ws)

    # Bob is not a member of Alice's workspace; an unknown job looks the same.
    bodies = [
        _assert_problem(api.get(f"{BASE}/jobs/{job}", headers=bearer(bob)), 404)["detail"]
        for job in (alice_job, uuid.uuid4())
    ]
    assert bodies == ["Job not found.", "Job not found."]

    # Nested route: the path workspace must be the job's real workspace (Alice is a member of
    # both), and the role check applies to the job's workspace.
    cancel = f"{BASE}/workspaces/{{ws}}/jobs/{{job}}/cancel"
    assert (
        api.post(cancel.format(ws=alice_ws, job=alice_job), headers=bearer(alice)).status_code
        == 200
    )
    _assert_problem(api.post(cancel.format(ws=bob_ws, job=alice_job), headers=bearer(alice)), 404)
    _assert_problem(api.post(cancel.format(ws=alice_ws, job=bob_job), headers=bearer(alice)), 404)
    _assert_problem(
        api.post(cancel.format(ws=bob_ws, job=bob_job), headers=bearer(alice)),
        403,
        ProblemType.INSUFFICIENT_ROLE,
    )


def test_ids_are_never_read_from_the_query_string(
    api: TestClient, access_repo: FakeAccessRepository, bearer: Bearer
) -> None:
    user = uuid.uuid4()
    ws = access_repo.workspace()
    access_repo.add_member(ws, user, Role.OWNER)

    res = api.get(
        f"{BASE}/missing-placeholder", params={"workspace_id": str(ws)}, headers=bearer(user)
    )
    assert res.status_code == 422
    assert access_repo.calls == []


def test_unauthenticated_requests_never_reach_the_db(
    api: TestClient, access_repo: FakeAccessRepository
) -> None:
    ws = access_repo.workspace()
    res = api.get(f"{BASE}/workspaces/{ws}")
    _assert_problem(res, 401)
    assert api.get(f"{BASE}/jobs/{uuid.uuid4()}").status_code == 401
    assert access_repo.calls == []


def test_non_uuid_ids_are_422(api: TestClient, bearer: Bearer) -> None:
    res = api.get(f"{BASE}/workspaces/not-a-uuid", headers=bearer(uuid.uuid4()))
    assert res.status_code == 422


def test_probe_routes_document_path_params(authz_app: FastAPI) -> None:
    schema = authz_app.openapi()
    params = schema["paths"][f"{BASE}/workspaces/{{workspace_id}}/jobs/{{job_id}}/cancel"]["post"][
        "parameters"
    ]
    assert {(p["name"], p["in"], p["required"]) for p in params} == {
        ("job_id", "path", True),
        ("workspace_id", "path", True),
    }


def test_resource_dependency_rejects_ambiguous_params() -> None:
    with pytest.raises(ValueError, match="differ"):
        require_resource_access(ResourceType.JOB, Action.READ, param="id", workspace_param="id")
