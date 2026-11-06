"""Owner share-link API (S1a) route wiring and secret handling with in-memory fakes (no infra).

The SQL (digest-only rows, locks, activity events, rotation chain) is covered against the local
stack in tests/integration/sharing/test_share_links_owner.py.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api.share_links import (
    get_idempotency_store,
    get_share_link_repository,
)
from quiz_api.authz import LockMode, MembershipRecord, ResourceType, Role, get_access_repository
from quiz_api.authz.repository import TwoStepResourceMembership
from quiz_api.errors import ProblemType
from quiz_api.main import create_app
from quiz_api.repositories.idempotency import StoredResponse
from quiz_api.repositories.share_links import ShareLinkRecord, ShareScope
from quiz_api.settings import Environment, InsecureConfigurationError, Settings
from quiz_api.share_secrets import (
    derive_secret,
    digest_of,
    issue_secret,
    reconstruct_secret,
    secret_matches,
)
from quiz_api.share_sessions import ShareSessionKey, issue_token

PROBLEM = "application/problem+json"
T0 = datetime(2026, 10, 1, tzinfo=UTC)
FUTURE = "2099-01-31T00:00:00Z"


# --- secrets ------------------------------------------------------------------------------------


def test_issued_secrets_are_32_random_bytes_and_only_their_sha256_is_kept() -> None:
    a, b = issue_secret(), issue_secret()
    assert a.value != b.value
    raw = base64.urlsafe_b64decode(a.value + "=")
    assert len(a.value) == 43
    assert len(raw) == 32
    assert a.digest == hashlib.sha256(raw).digest()
    assert a.value not in repr(a)
    assert repr(a.digest) not in repr(a)


def test_digest_accepts_only_the_canonical_encoding() -> None:
    secret = issue_secret()
    assert digest_of(secret.value) == secret.digest
    assert secret_matches(secret.value, secret.digest)
    assert not secret_matches(issue_secret().value, secret.digest)
    for bad in ("", secret.value[:-1], secret.value + "A", secret.value + "=", "+" * 43, "A" * 44):
        assert digest_of(bad) is None
        assert not secret_matches(bad, secret.digest)
    # Same 32 bytes, non-zero padding bits in the last character: a second spelling.
    last = secret.value[-1]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    sibling = secret.value[:-1] + alphabet[alphabet.index(last) ^ 1]
    assert digest_of(sibling) is None


def test_derived_secrets_are_deterministic_domain_separated_and_verified_by_digest() -> None:
    key = ShareSessionKey.from_secret("k" * 40)
    other_key = ShareSessionKey.from_secret("m" * 40)
    link_a, link_b = uuid.uuid4(), uuid.uuid4()

    derived = derive_secret(key.value, link_a)
    assert derived == derive_secret(key.value, link_a)
    raw = base64.urlsafe_b64decode(derived.value + "=")
    assert len(derived.value) == 43
    assert len(raw) == 32
    assert derived.digest == hashlib.sha256(raw).digest()
    assert secret_matches(derived.value, derived.digest)
    assert derive_secret(key.value, link_b).value != derived.value
    assert derive_secret(other_key.value, link_a).value != derived.value

    cookie, _ = issue_token(key, link_a, derived.digest, 600, now=1_800_000_000.0)
    assert derived.value not in cookie

    assert reconstruct_secret(key.value, link_a, derived.digest) == derived.value
    assert reconstruct_secret(other_key.value, link_a, derived.digest) is None
    assert reconstruct_secret(key.value, link_b, derived.digest) is None
    assert reconstruct_secret(key.value, link_a, issue_secret().digest) is None


# --- settings -----------------------------------------------------------------------------------


def test_share_origin_defaults_to_the_first_cors_origin() -> None:
    assert Settings.model_construct().share_web_origin == "http://127.0.0.1:3000"
    s = Settings.model_validate(
        {"CORS_ALLOWED_ORIGINS": "https://app.example.com, https://b.example.com"}
    )
    assert s.share_web_origin == "https://app.example.com"
    assert Settings.model_validate(
        {"WEB_ORIGIN": "HTTPS://Web.Example.com:443/"}
    ).share_web_origin == ("https://web.example.com")
    with pytest.raises(ValueError, match="origin"):
        Settings.model_validate({"WEB_ORIGIN": "https://web.example.com/share"})


def test_deployed_share_origin_must_be_https() -> None:
    base = {
        "APP_ENV": "production",
        "SUPABASE_JWT_ISSUER": "https://auth.example.com/auth/v1",
        "SUPABASE_JWKS_URL": "https://auth.example.com/auth/v1/.well-known/jwks.json",
        "CORS_ALLOWED_ORIGINS": "https://app.example.com",
    }
    Settings.model_validate(base).ensure_secure_deployment()
    with pytest.raises(InsecureConfigurationError, match="WEB_ORIGIN"):
        Settings.model_validate(
            {**base, "WEB_ORIGIN": "http://app.example.com"}
        ).ensure_secure_deployment()


# --- fakes --------------------------------------------------------------------------------------


@dataclass
class World(TwoStepResourceMembership):
    """Fake AccessRepository + ShareLinkRepository."""

    status: dict[uuid.UUID, str] = field(default_factory=dict)
    members: dict[tuple[uuid.UUID, uuid.UUID], Role] = field(default_factory=dict)
    links: dict[uuid.UUID, ShareLinkRecord] = field(default_factory=dict)
    digests: dict[uuid.UUID, bytes] = field(default_factory=dict)
    events: list[tuple[str, uuid.UUID]] = field(default_factory=list)
    locks: list[Any] = field(default_factory=list)
    commits: int = 0

    def workspace(self, owner: uuid.UUID, status: str = "active") -> uuid.UUID:
        ws = uuid.uuid4()
        self.status[ws] = status
        self.members[(ws, owner)] = Role.OWNER
        return ws

    # AccessRepository
    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        self.locks.append(lock)
        role = self.members.get((workspace_id, user_id))
        status = self.status.get(workspace_id)
        if role is None or status in (None, "deleted"):
            return None
        archived_at = T0 if status == "archived" else None
        return MembershipRecord(workspace_id, user_id, role, status, archived_at)

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        assert resource_type is ResourceType.SHARE_LINK
        link = self.links.get(resource_id)
        return link.workspace_id if link else None

    # ShareLinkRepository
    def commit(self) -> None:
        self.commits += 1

    def list(self, workspace_id: uuid.UUID) -> list[ShareLinkRecord]:
        return [x for x in reversed(self.links.values()) if x.workspace_id == workspace_id]

    def lock(self, workspace_id: uuid.UUID, link_id: uuid.UUID) -> ShareLinkRecord:
        link = self.links[link_id]
        assert link.workspace_id == workspace_id
        return link

    def _new(
        self,
        ws: uuid.UUID,
        digest: bytes,
        fork: bool,
        expires: Any,
        src: Any,
        link_id: uuid.UUID | None = None,
        scope: ShareScope | None = None,
    ) -> ShareLinkRecord:
        scope = scope or ShareScope()
        rec = ShareLinkRecord(
            link_id or uuid.uuid4(),
            ws,
            fork,
            scope.include_notes,
            scope.include_ai_explanations,
            scope.include_summary,
            scope.include_owner_records,
            expires,
            None,
            src,
            T0,
            T0,
            "active",
            token_digest=digest,
        )
        self.links[rec.id] = rec
        self.digests[rec.id] = digest
        return rec

    def create(
        self,
        ws: uuid.UUID,
        actor: uuid.UUID,
        *,
        token_digest: bytes,
        allow_fork: bool,
        expires_at: Any,
        scope: ShareScope | None = None,
        link_id: uuid.UUID | None = None,
    ) -> ShareLinkRecord:
        rec = self._new(
            ws, token_digest, allow_fork, expires_at, None, link_id=link_id, scope=scope
        )
        self.events.append(("share_link.created", rec.id))
        return rec

    def update_policy(
        self, link: ShareLinkRecord, actor: uuid.UUID, changes: dict[str, Any]
    ) -> ShareLinkRecord:
        self.links[link.id] = replace(link, **changes)
        self.events.append(("share_link.updated", link.id))
        return self.links[link.id]

    def revoke(self, link: ShareLinkRecord, actor: uuid.UUID) -> ShareLinkRecord:
        if link.revoked_at is None:
            self.links[link.id] = replace(link, revoked_at=T0, status="revoked")
            self.events.append(("share_link.revoked", link.id))
        return self.links[link.id]

    def rotate(
        self,
        link: ShareLinkRecord,
        actor: uuid.UUID,
        *,
        token_digest: bytes,
        link_id: uuid.UUID | None = None,
    ) -> ShareLinkRecord:
        self.links[link.id] = replace(link, revoked_at=T0, status="revoked")
        rec = self._new(
            link.workspace_id,
            token_digest,
            link.allow_fork,
            link.expires_at,
            link.id,
            link_id=link_id,
            scope=link.scope,
        )
        self.events.append(("share_link.rotated", link.id))
        return rec


@dataclass
class FakeIdempotencyStore:
    stored: dict[tuple[uuid.UUID, str, str], StoredResponse] = field(default_factory=dict)

    def lock(self, user_id: uuid.UUID, scope: str, key: str) -> None:
        pass

    def find(self, user_id: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        return self.stored.get((user_id, scope, key))

    def save(
        self, user_id: uuid.UUID, scope: str, key: str, req_hash: str, status: int, body: Any
    ) -> None:
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
        supabase_jwt_issuer=auth_kit.issuer,
        supabase_jwks_url=auth_kit.jwks_url,
        web_origin="https://web.example",
    )
    app: FastAPI = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_share_link_repository] = lambda: world
    app.dependency_overrides[get_idempotency_store] = lambda: store
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Callable[[uuid.UUID], dict[str, str]]:
    def make(user_id: uuid.UUID, **extra: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}", **extra}

    return make


def _problem(res: Any, status: int, problem_type: str = "about:blank") -> dict[str, Any]:
    assert res.status_code == status, res.text
    assert res.headers["content-type"] == PROBLEM
    body: dict[str, Any] = res.json()
    assert body["type"] == problem_type
    return body


def _base(ws: uuid.UUID) -> str:
    return f"/api/v1/workspaces/{ws}/share-links"


# --- routes -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", ""),
        ("GET", ""),
        ("PATCH", "/{l}"),
        ("POST", "/{l}/revoke"),
        ("POST", "/{l}/rotate"),
    ],
)
def test_every_route_requires_a_token(
    api: TestClient, world: World, method: str, path: str
) -> None:
    res = api.request(method, _base(uuid.uuid4()) + path.format(l=uuid.uuid4()), json={})
    _problem(res, 401)
    assert world.locks == []


def test_create_returns_secret_once_and_reconstructs_owner_share_url_until_revoked(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    res = api.post(_base(ws), json={}, headers=bearer(owner))
    assert res.status_code == 201, res.text
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["referrer-policy"] == "no-referrer"
    body = res.json()
    secret = body["secret"]
    expected_url = f"https://web.example/share/{body['id']}#k={secret}"
    assert body["share_url"] == expected_url
    assert body["allow_fork"] is False
    assert body["status"] == "active"
    assert body["secret_already_issued"] is False
    link_uuid = uuid.UUID(body["id"])
    assert world.digests[link_uuid] == digest_of(secret)
    assert secret not in repr(world.links[link_uuid])
    assert world.locks == [LockMode.SHARE]
    assert world.commits == 1

    listed = api.get(_base(ws), headers=bearer(owner))
    assert listed.status_code == 200
    (item,) = listed.json()["items"]
    assert item["share_url"] == expected_url
    assert not {"secret", "token_digest", "secret_already_issued"} & set(item)
    assert world.locks[-1] == LockMode.NONE

    # Expired (non-revoked) links still reconstruct share_url so extending expiry reopens
    # the same URL.
    world.links[link_uuid] = replace(world.links[link_uuid], status="expired")
    expired_item = api.get(_base(ws), headers=bearer(owner)).json()["items"][0]
    assert expired_item["share_url"] == expected_url

    # Legacy random-secret rows (digest mismatch) return share_url=None instead of a broken URL.
    legacy = world._new(ws, issue_secret().digest, False, None, None)
    by_id = {x["id"]: x for x in api.get(_base(ws), headers=bearer(owner)).json()["items"]}
    assert by_id[str(legacy.id)]["share_url"] is None


def test_deployed_without_share_session_secret_answers_503_except_revoke(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    app = cast(FastAPI, api.app)
    created = api.post(_base(ws), json={}, headers=bearer(owner)).json()
    app.state.share_session_key = None
    app.state.settings = Settings.model_construct(
        app_env=Environment.PRODUCTION,
        supabase_jwt_issuer=app.state.settings.supabase_jwt_issuer,
        supabase_jwks_url=app.state.settings.supabase_jwks_url,
        web_origin="https://web.example",
    )
    assert api.post(_base(ws), json={}, headers=bearer(owner)).status_code == 503
    assert api.get(_base(ws), headers=bearer(owner)).status_code == 503
    revoked = api.post(f"{_base(ws)}/{created['id']}/revoke", headers=bearer(owner))
    assert revoked.status_code == 200
    assert revoked.json()["share_url"] is None


def test_create_validates_the_body(api: TestClient, world: World, bearer: Any) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    for body in (
        {"expires_at": past},
        {"expires_at": "2099-01-31T00:00:00"},  # no offset
        {"allow_fork": "maybe"},
        {"secret": "chosen-by-client"},
    ):
        _problem(api.post(_base(ws), json=body, headers=bearer(owner)), 422)
    assert world.links == {}
    res = api.post(
        _base(ws), json={"allow_fork": True, "expires_at": FUTURE}, headers=bearer(owner)
    )
    assert res.status_code == 201
    assert res.json()["allow_fork"] is True
    assert res.json()["expires_at"].startswith("2099-01-31")


def test_replay_after_the_expiry_passed_returns_the_stored_response(
    api: TestClient,
    world: World,
    store: FakeIdempotencyStore,
    bearer: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import quiz_api.api.share_links as module

    owner = uuid.uuid4()
    ws = world.workspace(owner)
    expires = (datetime.now(UTC) + timedelta(seconds=2)).isoformat()
    body = {"expires_at": expires}
    first = api.post(_base(ws), json=body, headers=bearer(owner, **{"Idempotency-Key": "k-exp"}))
    assert first.status_code == 201, first.text

    class Later(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> Any:
            return datetime.now(tz) + timedelta(hours=1)

    monkeypatch.setattr(module, "datetime", Later)
    again = api.post(_base(ws), json=body, headers=bearer(owner, **{"Idempotency-Key": "k-exp"}))
    assert again.status_code == 201, again.text
    assert again.headers["idempotent-replayed"] == "true"
    replayed = again.json()
    assert replayed["id"] == first.json()["id"]
    assert (replayed["secret"], replayed["secret_already_issued"]) == (None, True)
    assert len(world.links) == 1

    # A new key (or no key) actually creates: now the past expiry is rejected.
    fresh = api.post(_base(ws), json=body, headers=bearer(owner, **{"Idempotency-Key": "k-new"}))
    _problem(fresh, 422)
    assert fresh.json()["errors"][0]["loc"] == ["body", "expires_at"]
    _problem(api.post(_base(ws), json=body, headers=bearer(owner)), 422)
    link = first.json()["id"]
    _problem(api.patch(f"{_base(ws)}/{link}", json=body, headers=bearer(owner)), 422)
    assert len(world.links) == 1
    assert not any(k[2] == "k-new" for k in store.stored)


def test_idempotent_replay_never_returns_the_secret(
    api: TestClient, world: World, store: FakeIdempotencyStore, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    headers = bearer(owner, **{"Idempotency-Key": "issue-1"})
    first = api.post(_base(ws), json={}, headers=headers)
    assert first.status_code == 201
    secret = first.json()["secret"]
    (saved,) = store.stored.values()
    assert secret not in str(saved.body)

    again = api.post(_base(ws), json={}, headers=headers)
    assert again.status_code == 201
    assert again.headers["idempotent-replayed"] == "true"
    replayed = again.json()
    assert replayed["id"] == first.json()["id"]
    assert replayed["secret"] is None
    assert replayed["share_url"] is None
    assert replayed["secret_already_issued"] is True
    assert len(world.links) == 1

    other = api.post(_base(ws), json={"allow_fork": True}, headers=headers)
    _problem(other, 409, ProblemType.IDEMPOTENCY_KEY_REUSED)
    assert len(world.links) == 1


def test_only_the_owner_manages_links(api: TestClient, world: World, bearer: Any) -> None:
    owner, editor, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, editor)] = Role.EDITOR
    link = api.post(_base(ws), json={}, headers=bearer(owner)).json()["id"]
    calls = [
        ("GET", ""),
        ("POST", ""),
        ("PATCH", f"/{link}"),
        ("POST", f"/{link}/revoke"),
        ("POST", f"/{link}/rotate"),
    ]
    for method, path in calls:
        res = api.request(method, _base(ws) + path, json={}, headers=bearer(editor))
        _problem(res, 403, ProblemType.INSUFFICIENT_ROLE)
        res = api.request(method, _base(ws) + path, json={}, headers=bearer(stranger))
        _problem(res, 404)
    # A link addressed through another workspace of the same owner is not found.
    other = world.workspace(owner)
    _problem(api.post(f"{_base(other)}/{link}/revoke", headers=bearer(owner)), 404)
    _problem(api.post(f"{_base(ws)}/{uuid.uuid4()}/revoke", headers=bearer(owner)), 404)
    assert world.links[uuid.UUID(link)].revoked_at is None


def test_patch_revoke_and_rotate(api: TestClient, world: World, bearer: Any) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    first = api.post(_base(ws), json={}, headers=bearer(owner)).json()
    url = f"{_base(ws)}/{first['id']}"

    res = api.patch(url, json={"allow_fork": True, "expires_at": FUTURE}, headers=bearer(owner))
    assert res.status_code == 200
    assert res.json()["allow_fork"] is True
    assert res.json()["share_url"] == first["share_url"]
    _problem(api.patch(url, json={"allow_fork": None}, headers=bearer(owner)), 422)
    cleared = api.patch(url, json={"expires_at": None}, headers=bearer(owner))
    assert cleared.json()["expires_at"] is None
    assert cleared.json()["allow_fork"] is True
    assert cleared.json()["share_url"] == first["share_url"]

    rotated = api.post(f"{url}/rotate", headers=bearer(owner))
    assert rotated.status_code == 201
    second = rotated.json()
    assert second["id"] != first["id"]
    assert second["secret"] != first["secret"]
    assert second["rotated_from_id"] == first["id"]
    assert second["allow_fork"] is True
    assert second["share_url"].endswith(f"/share/{second['id']}#k={second['secret']}")
    assert world.links[uuid.UUID(first["id"])].status == "revoked"

    # The rotated (revoked) link can neither be rotated again nor edited; revoke is a no-op.
    _problem(api.post(f"{url}/rotate", headers=bearer(owner)), 409, ProblemType.SHARE_LINK_INACTIVE)
    _problem(
        api.patch(url, json={"allow_fork": False}, headers=bearer(owner)),
        409,
        ProblemType.SHARE_LINK_INACTIVE,
    )
    revoked_body = api.post(f"{url}/revoke", headers=bearer(owner)).json()
    assert revoked_body["status"] == "revoked"
    assert revoked_body["share_url"] is None
    by_id = {x["id"]: x for x in api.get(_base(ws), headers=bearer(owner)).json()["items"]}
    assert by_id[first["id"]]["share_url"] is None
    assert by_id[second["id"]]["share_url"] == second["share_url"]
    assert [e for e, _ in world.events].count("share_link.revoked") == 0


SCOPE_FLAGS = (
    "include_notes",
    "include_ai_explanations",
    "include_summary",
    "include_owner_records",
)


def test_scope_defaults_keep_content_and_owner_records_stay_private(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    body = api.post(_base(ws), json={}, headers=bearer(owner)).json()
    assert [body[f] for f in SCOPE_FLAGS] == [True, True, True, False]
    chosen = api.post(
        _base(ws),
        json={"include_notes": False, "include_owner_records": True},
        headers=bearer(owner),
    ).json()
    assert [chosen[f] for f in SCOPE_FLAGS] == [False, True, True, True]


@pytest.mark.parametrize("flag", SCOPE_FLAGS)
def test_only_the_owner_changes_a_scope_flag_and_rotate_keeps_it(
    api: TestClient, world: World, bearer: Any, flag: str
) -> None:
    owner, editor = uuid.uuid4(), uuid.uuid4()
    ws = world.workspace(owner)
    world.members[(ws, editor)] = Role.EDITOR
    first = api.post(_base(ws), json={}, headers=bearer(owner)).json()
    url = f"{_base(ws)}/{first['id']}"
    wanted = not first[flag]

    _problem(
        api.patch(url, json={flag: wanted}, headers=bearer(editor)),
        403,
        ProblemType.INSUFFICIENT_ROLE,
    )
    assert api.get(_base(ws), headers=bearer(owner)).json()["items"][0][flag] is first[flag]
    _problem(api.patch(url, json={flag: None}, headers=bearer(owner)), 422)
    changed = api.patch(url, json={flag: wanted}, headers=bearer(owner))
    assert changed.status_code == 200
    assert changed.json()[flag] is wanted

    rotated = api.post(f"{url}/rotate", headers=bearer(owner)).json()
    assert rotated[flag] is wanted, "rotate copies the scope"
    others = [f for f in SCOPE_FLAGS if f != flag]
    assert [rotated[f] for f in others] == [first[f] for f in others]


def test_a_scope_flag_can_change_while_archived(api: TestClient, world: World, bearer: Any) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    link = api.post(_base(ws), json={}, headers=bearer(owner)).json()["id"]
    world.status[ws] = "archived"
    res = api.patch(f"{_base(ws)}/{link}", json={"include_notes": False}, headers=bearer(owner))
    assert res.status_code == 200
    assert res.json()["include_notes"] is False


def test_archived_allows_revoke_and_policy_but_not_issue_or_rotate(
    api: TestClient, world: World, bearer: Any
) -> None:
    owner = uuid.uuid4()
    ws = world.workspace(owner)
    link = api.post(_base(ws), json={}, headers=bearer(owner)).json()["id"]
    world.status[ws] = "archived"
    _problem(
        api.post(_base(ws), json={}, headers=bearer(owner)), 403, ProblemType.WORKSPACE_ARCHIVED
    )
    _problem(
        api.post(f"{_base(ws)}/{link}/rotate", headers=bearer(owner)),
        403,
        ProblemType.WORKSPACE_ARCHIVED,
    )
    assert api.get(_base(ws), headers=bearer(owner)).status_code == 200
    res = api.patch(f"{_base(ws)}/{link}", json={"allow_fork": True}, headers=bearer(owner))
    assert res.status_code == 200
    assert api.post(f"{_base(ws)}/{link}/revoke", headers=bearer(owner)).status_code == 200

    world.status[ws] = "deleted"
    for method, path in [("GET", ""), ("PATCH", f"/{link}"), ("POST", f"/{link}/revoke")]:
        _problem(api.request(method, _base(ws) + path, json={}, headers=bearer(owner)), 404)


def test_openapi_documents_the_share_link_routes(api: TestClient) -> None:
    spec = api.get("/api/v1/openapi.json").json()
    base = "/api/v1/workspaces/{workspace_id}/share-links"
    ops = {
        spec["paths"][base]["post"]["operationId"],
        spec["paths"][base]["get"]["operationId"],
        spec["paths"][f"{base}/{{link_id}}"]["patch"]["operationId"],
        spec["paths"][f"{base}/{{link_id}}/revoke"]["post"]["operationId"],
        spec["paths"][f"{base}/{{link_id}}/rotate"]["post"]["operationId"],
    }
    assert ops == {
        "createShareLink",
        "listShareLinks",
        "updateShareLink",
        "revokeShareLink",
        "rotateShareLink",
    }
    schemas = spec["components"]["schemas"]
    assert "secret" not in schemas["ShareLink"]["properties"]
    assert "token_digest" not in schemas["ShareLink"]["properties"]
    assert "share_url" in schemas["ShareLink"]["properties"]
    assert "token_digest" not in schemas["IssuedShareLink"]["properties"]
