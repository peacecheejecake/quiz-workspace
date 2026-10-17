"""Fork API (S3a): the checks of `POST /shared/{id}/forks` and `GET /me/forks/{id}` with
in-memory links, forks and idempotency store (no infra).

The SQL (pinned snapshot, the job row, the worker's commit) is covered against the local stack in
tests/integration/sharing/test_fork_api_contract.py and test_fork_worker.py.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from http.cookies import SimpleCookie
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api import forks as forks_api
from quiz_api.api.documents import get_job_publisher
from quiz_api.api.forks import get_fork_repository, get_idempotency_store
from quiz_api.api.shared import get_shared_repository
from quiz_api.authz.repository import RESOURCES, ResourceType
from quiz_api.errors import ProblemType
from quiz_api.jobs import JobMessage
from quiz_api.main import create_app
from quiz_api.repositories.forks import (
    FORK_JOB_TYPE,
    ForkJob,
    ForkRecord,
    PinnedQuestion,
    Snapshot,
    fork_job_key,
)
from quiz_api.repositories.idempotency import StoredResponse
from quiz_api.repositories.shared import SharedLink
from quiz_api.settings import Settings
from quiz_api.share_secrets import issue_secret
from quiz_api.share_sessions import SHARE_COOKIE

WEB = "https://web.example"
T0 = datetime(2026, 10, 18, tzinfo=UTC)


@dataclass
class World:
    links: dict[uuid.UUID, SharedLink] = field(default_factory=dict)
    secrets: dict[uuid.UUID, str] = field(default_factory=dict)
    forks: dict[uuid.UUID, ForkRecord] = field(default_factory=dict)
    jobs: dict[uuid.UUID, ForkJob] = field(default_factory=dict)
    created: list[dict[str, Any]] = field(default_factory=list)
    snapshot_value: Snapshot = field(
        default_factory=lambda: Snapshot(
            documents=[(uuid.uuid4(), uuid.uuid4())],
            questions=[PinnedQuestion(uuid.uuid4(), uuid.uuid4(), [])],
        )
    )
    stored: dict[tuple[uuid.UUID, str, str], StoredResponse] = field(default_factory=dict)
    published: list[JobMessage] = field(default_factory=list)
    commits: int = 0

    def add_link(self, *, usable: bool = True, allow_fork: bool = True) -> SharedLink:
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

    # SharedRepository
    def link(self, link_id: uuid.UUID) -> SharedLink | None:
        return self.links.get(link_id)

    def end_read(self) -> None:
        pass

    # ForkRepository
    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        pass

    def snapshot(self, workspace_id: uuid.UUID) -> Snapshot:
        return self.snapshot_value

    def create(self, **kwargs: Any) -> tuple[ForkRecord, ForkJob]:
        self.created.append(kwargs)
        fork_id, job_id = uuid.uuid4(), uuid.uuid4()
        job = ForkJob(
            id=job_id,
            workspace_id=kwargs["source_workspace_id"],
            created_by=kwargs["user_id"],
            job_type=FORK_JOB_TYPE,
            schema_version=1,
            idempotency_key=fork_job_key(fork_id),
            payload={"fork_id": str(fork_id)},
            status="queued",
            published_at=None,
        )
        fork = ForkRecord(
            id=fork_id,
            forked_by=kwargs["user_id"],
            name=kwargs["name"],
            status="PENDING",
            progress=0,
            target_workspace_id=None,
            async_job_id=job_id,
            last_error=None,
            created_at=T0,
            updated_at=T0,
            completed_at=None,
        )
        self.forks[fork_id], self.jobs[job_id] = fork, job
        return fork, job

    def get_for_user(self, fork_id: uuid.UUID, user_id: uuid.UUID) -> ForkRecord | None:
        fork = self.forks.get(fork_id)
        return fork if fork is not None and fork.forked_by == user_id else None

    def job(self, job_id: uuid.UUID) -> ForkJob | None:
        return self.jobs.get(job_id)

    def mark_published(self, job_id: uuid.UUID) -> None:
        self.jobs[job_id] = replace(self.jobs[job_id], published_at=T0)

    # IdempotencyStore
    def lock(self, user_id: uuid.UUID, scope: str, key: str) -> None:
        pass

    def find(self, user_id: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        return self.stored.get((user_id, scope, key))

    def save(
        self, user_id: uuid.UUID, scope: str, key: str, req_hash: str, status: int, body: Any
    ) -> None:
        self.stored[(user_id, scope, key)] = StoredResponse(req_hash, status, body)

    # JobPublisher
    def publish(self, message: JobMessage) -> None:
        self.published.append(message)


@pytest.fixture
def world() -> World:
    return World()


def _app(
    world: World, make_verifier: Callable[..., Any], auth_kit: Any, **settings: Any
) -> FastAPI:
    app = create_app(
        Settings.model_construct(
            cors_allowed_origins=(WEB,),
            supabase_jwt_issuer=auth_kit.issuer,
            supabase_jwks_url=auth_kit.jwks_url,
            **settings,
        ),
        readiness_checkers=[],
    )
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_shared_repository] = lambda: world
    app.dependency_overrides[get_fork_repository] = lambda: world
    app.dependency_overrides[get_idempotency_store] = lambda: world
    app.dependency_overrides[get_job_publisher] = lambda: world
    return app


@pytest.fixture
def api(world: World, make_verifier: Callable[..., Any], auth_kit: Any) -> Iterator[TestClient]:
    with TestClient(_app(world, make_verifier, auth_kit), raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Callable[[uuid.UUID], dict[str, str]]:
    def make(user_id: uuid.UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}"}

    return make


def _session(api: TestClient, world: World, link: SharedLink) -> str:
    res = api.post(
        f"/api/v1/shared/{link.id}/sessions",
        json={"secret": world.secrets[link.id]},
        headers={"Origin": WEB},
    )
    api.cookies.clear()
    assert res.status_code == 204, res.text
    for raw in res.headers.get_list("set-cookie"):
        jar: SimpleCookie = SimpleCookie()
        jar.load(raw)
        if SHARE_COOKIE in jar:
            return f"{SHARE_COOKIE}={jar[SHARE_COOKIE].value}"
    raise AssertionError("no share cookie")


def _fork(
    api: TestClient,
    share_id: Any,
    *,
    auth: dict[str, str] | None,
    cookie: str | None,
    origin: str | None = WEB,
    name: str = "내 fork",
    key: str | None = None,
) -> Any:
    headers = dict(auth or {})
    if cookie:
        headers["Cookie"] = cookie
    if origin:
        headers["Origin"] = origin
    if key:
        headers["Idempotency-Key"] = key
    res = api.post(f"/api/v1/shared/{share_id}/forks", json={"name": name}, headers=headers)
    api.cookies.clear()
    return res


def _type(res: Any) -> str:
    return str(res.json()["type"])


# --- checks -------------------------------------------------------------------------------------


def test_fork_needs_a_user_an_origin_a_session_of_this_link_and_allow_fork(
    api: TestClient, world: World, bearer: Callable[[uuid.UUID], dict[str, str]]
) -> None:
    user = bearer(uuid.uuid4())
    link = world.add_link()
    other = world.add_link()
    no_fork = world.add_link(allow_fork=False)
    cookie, other_cookie = _session(api, world, link), _session(api, world, other)
    no_fork_cookie = _session(api, world, no_fork)

    assert _fork(api, link.id, auth=None, cookie=cookie).status_code == 401
    for origin in (None, "https://evil.example"):
        assert _fork(api, link.id, auth=user, cookie=cookie, origin=origin).status_code == 403
    missing = _fork(api, link.id, auth=user, cookie=None)
    assert (missing.status_code, _type(missing)) == (403, ProblemType.SHARE_SESSION_REQUIRED)
    forged = _fork(api, link.id, auth=user, cookie=cookie[:-2] + "xx")
    assert (forged.status_code, _type(forged)) == (403, ProblemType.SHARE_SESSION_REQUIRED)
    foreign = _fork(api, link.id, auth=user, cookie=other_cookie)
    assert (foreign.status_code, _type(foreign)) == (404, ProblemType.SHARE_UNAVAILABLE)
    off = _fork(api, no_fork.id, auth=user, cookie=no_fork_cookie)
    assert (off.status_code, _type(off)) == (403, ProblemType.FORK_NOT_ALLOWED)
    world.links[link.id] = replace(link, usable=False)  # revoked / expired / deleted
    gone = _fork(api, link.id, auth=user, cookie=cookie)
    assert (gone.status_code, _type(gone)) == (404, ProblemType.SHARE_UNAVAILABLE)
    assert world.created == []
    assert world.published == []
    assert gone.headers["cache-control"] == "private, no-store"


def test_fork_start_records_the_snapshot_publishes_the_job_and_replays_by_key(
    api: TestClient, world: World, bearer: Callable[[uuid.UUID], dict[str, str]]
) -> None:
    user_id = uuid.uuid4()
    link = world.add_link()
    cookie = _session(api, world, link)
    key = str(uuid.uuid4())

    res = _fork(api, link.id, auth=bearer(user_id), cookie=cookie, key=key, name="  새 WS  ")
    assert res.status_code == 202, res.text
    body = res.json()
    assert set(body) == {
        "id",
        "job_id",
        "status",
        "progress",
        "name",
        "target_workspace_id",
        "error_code",
        "created_at",
        "updated_at",
        "completed_at",
    }
    assert (body["status"], body["name"], body["target_workspace_id"]) == ("PENDING", "새 WS", None)
    (created,) = world.created
    assert created["source_workspace_id"] == link.workspace_id
    assert created["share_link_id"] == link.id
    assert created["user_id"] == user_id
    assert created["snapshot"] == world.snapshot_value
    (message,) = world.published
    assert (message.job_type, message.workspace_id, message.created_by) == (
        FORK_JOB_TYPE,
        link.workspace_id,
        user_id,
    )
    assert message.payload == {"fork_id": body["id"]}
    assert str(message.job_id) == body["job_id"]

    again = _fork(api, link.id, auth=bearer(user_id), cookie=cookie, key=key, name="새 WS")
    assert again.status_code == 202
    assert again.json()["id"] == body["id"]
    assert again.headers["idempotent-replayed"] == "true"
    assert len(world.created) == 1
    assert len(world.published) == 1
    conflict = _fork(api, link.id, auth=bearer(user_id), cookie=cookie, key=key, name="다른 이름")
    assert (conflict.status_code, _type(conflict)) == (409, ProblemType.IDEMPOTENCY_KEY_REUSED)


def test_fork_starts_are_rate_limited_per_user(
    world: World,
    make_verifier: Callable[..., Any],
    auth_kit: Any,
    bearer: Callable[[uuid.UUID], dict[str, str]],
) -> None:
    app = _app(world, make_verifier, auth_kit, share_fork_rate_per_minute=2)
    link = world.add_link()
    with TestClient(app, raise_server_exceptions=False) as api:
        cookie = _session(api, world, link)
        user, other = bearer(uuid.uuid4()), bearer(uuid.uuid4())
        statuses = [_fork(api, link.id, auth=user, cookie=cookie).status_code for _ in range(3)]
        assert statuses == [202, 202, 429]
        limited = _fork(api, link.id, auth=user, cookie=cookie)
        assert int(limited.headers["retry-after"]) >= 1
        assert _fork(api, link.id, auth=other, cookie=cookie).status_code == 202


@pytest.mark.parametrize("limit", ["MAX_FORK_QUESTIONS", "MAX_FORK_MANIFEST_CHARS"])
def test_a_too_large_snapshot_is_refused(
    api: TestClient,
    world: World,
    bearer: Callable[[uuid.UUID], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    limit: str,
) -> None:
    monkeypatch.setattr(forks_api, limit, 0)
    link = world.add_link()
    res = _fork(api, link.id, auth=bearer(uuid.uuid4()), cookie=_session(api, world, link))
    assert (res.status_code, _type(res)) == (409, ProblemType.FORK_TOO_LARGE)
    assert world.created == []


def test_my_fork_is_visible_to_its_user_only(
    api: TestClient, world: World, bearer: Callable[[uuid.UUID], dict[str, str]]
) -> None:
    owner = uuid.uuid4()
    link = world.add_link()
    started = _fork(api, link.id, auth=bearer(owner), cookie=_session(api, world, link)).json()
    fork_id = uuid.UUID(started["id"])

    mine = api.get(f"/api/v1/me/forks/{fork_id}", headers=bearer(owner))
    assert mine.status_code == 200
    assert mine.json()["status"] == "PENDING"
    for path, auth in (
        (f"/api/v1/me/forks/{fork_id}", bearer(uuid.uuid4())),
        (f"/api/v1/me/forks/{uuid.uuid4()}", bearer(owner)),
        ("/api/v1/me/forks/not-a-uuid", bearer(owner)),
    ):
        assert api.get(path, headers=auth).status_code == 404
    assert api.get(f"/api/v1/me/forks/{fork_id}").status_code == 401

    world.forks[fork_id] = replace(
        world.forks[fork_id], status="CANCELLED", last_error="share_unavailable"
    )
    cancelled = api.get(f"/api/v1/me/forks/{fork_id}", headers=bearer(owner)).json()
    assert (cancelled["status"], cancelled["error_code"]) == ("CANCELLED", "share_unavailable")
    world.forks[fork_id] = replace(
        world.forks[fork_id], status="FAILED", last_error="Traceback: <not a code>"
    )
    failed = api.get(f"/api/v1/me/forks/{fork_id}", headers=bearer(owner)).json()
    assert failed["error_code"] == "fork_failed", "raw error text never leaves the API"


def test_fork_jobs_are_not_workspace_job_resources() -> None:
    condition = RESOURCES[ResourceType.JOB].visible_when
    assert condition is not None
    assert "job_type" in str(condition)


def test_the_manifest_pins_each_question_with_its_sources() -> None:
    doc, rev, q, qrev, src = (uuid.uuid4() for _ in range(5))
    source = {"id": str(src), "document_id": str(doc), "page_start": 3, "block_ids": ["b1"]}
    snapshot = Snapshot(documents=[(doc, rev)], questions=[PinnedQuestion(q, qrev, [source])])
    documents, questions = snapshot.manifest_entries()
    assert documents == [{"document_id": str(doc), "revision_id": str(rev)}]
    assert questions == [{"question_id": str(q), "revision_id": str(qrev), "sources": [source]}]
    assert snapshot.encoded_size() > len(str(src))
