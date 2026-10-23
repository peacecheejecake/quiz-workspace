"""Job status API (M3.2b) with in-memory fakes: GET /jobs/{id} and the SSE stream.

The same routes against the local stack (real jobs run by the worker) are covered in
tests/integration/workspaces/test_document_parse_job.py.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api.jobs import (
    JobEventsConfig,
    get_job_events_config,
    get_job_poller,
    get_job_repository,
    get_session_release,
)
from quiz_api.authz import LockMode, MembershipRecord, ResourceType, Role, get_access_repository
from quiz_api.authz.repository import TwoStepResourceMembership
from quiz_api.main import create_app
from quiz_api.repositories.jobs import JobView, error_code, progress_of
from quiz_api.settings import Settings

API = "/api/v1"
T0 = datetime(2026, 10, 17, tzinfo=UTC)


def _view(job_id: uuid.UUID, status: str = "queued", **kw: Any) -> JobView:
    values: dict[str, Any] = {
        "id": job_id,
        "job_type": "document.parse",
        "status": status,
        "progress": None,
        "stage": None,
        "error_code": None,
        "attempts": 0,
        "max_attempts": 3,
        "cancel_requested": False,
        "created_at": T0,
        "updated_at": T0,
        "started_at": None,
        "finished_at": None,
    }
    values.update(kw)
    return JobView(**values)


@dataclass
class World(TwoStepResourceMembership):
    members: dict[tuple[uuid.UUID, uuid.UUID], Role] = field(default_factory=dict)
    jobs: dict[uuid.UUID, tuple[uuid.UUID, JobView]] = field(default_factory=dict)
    # Successive views the poller returns for a job (the last one repeats).
    timeline: dict[uuid.UUID, list[JobView | None]] = field(default_factory=dict)
    polls: int = 0
    released: int = 0

    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        role = self.members.get((workspace_id, user_id))
        return MembershipRecord(workspace_id, user_id, role, "active", None) if role else None

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        assert resource_type is ResourceType.JOB
        entry = self.jobs.get(resource_id)
        return entry[0] if entry else None

    def get(self, job_id: uuid.UUID) -> JobView | None:
        entry = self.jobs.get(job_id)
        return entry[1] if entry else None

    def poll(self, user_id: uuid.UUID, job_id: uuid.UUID) -> JobView | None:
        self.polls += 1
        steps = self.timeline.get(job_id)
        if steps:
            return steps.pop(0) if len(steps) > 1 else steps[0]
        return self.get(job_id)

    def release(self) -> None:
        self.released += 1


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def app(make_verifier: Callable[..., Any], world: World, auth_kit: Any) -> FastAPI:
    settings = Settings.model_construct(
        supabase_jwt_issuer=auth_kit.issuer, supabase_jwks_url=auth_kit.jwks_url
    )
    app = create_app(settings, readiness_checkers=[])
    app.state.token_verifier = make_verifier()
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_job_repository] = lambda: world
    app.dependency_overrides[get_job_poller] = lambda: world.poll
    app.dependency_overrides[get_session_release] = lambda: world.release
    app.dependency_overrides[get_job_events_config] = lambda: JobEventsConfig(
        poll_seconds=0, heartbeat_seconds=0, max_seconds=5, retry_ms=1000
    )
    return app


@pytest.fixture
def api(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def bearer(signing_key: Any, auth_kit: Any) -> Callable[[uuid.UUID], dict[str, str]]:
    def make(user_id: uuid.UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {signing_key.sign(auth_kit.claims(user_id))}"}

    return make


def _member_job(world: World, status: str = "queued", **kw: Any) -> tuple[uuid.UUID, uuid.UUID]:
    user, ws, job = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    world.members[(ws, user)] = Role.VIEWER
    world.jobs[job] = (ws, _view(job, status, **kw))
    return user, job


def _events(text: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for frame in text.split("\n\n"):
        lines = dict(
            line.split(": ", 1) for line in frame.splitlines() if ": " in line and line[0] != ":"
        )
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_get_job_returns_presentable_status(world: World, api: TestClient, bearer: Any) -> None:
    user, job = _member_job(world, "running", progress=40, stage="parsing", attempts=1)

    res = api.get(f"{API}/jobs/{job}", headers=bearer(user))

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == str(job)
    assert (body["status"], body["progress"], body["stage"]) == ("running", 40, "parsing")
    assert body["error_code"] is None
    assert set(body) == {
        "id",
        "job_type",
        "status",
        "progress",
        "stage",
        "error_code",
        "attempts",
        "max_attempts",
        "cancel_requested",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
    }
    assert res.headers["cache-control"] == "no-store"


def test_foreign_and_missing_jobs_are_the_same_404(
    world: World, api: TestClient, bearer: Any
) -> None:
    _owner, job = _member_job(world)
    stranger = uuid.uuid4()

    for path in (f"/jobs/{job}", f"/jobs/{job}/events"):
        foreign = api.get(f"{API}{path}", headers=bearer(stranger))
        missing = api.get(
            f"{API}{path.replace(str(job), str(uuid.uuid4()))}", headers=bearer(stranger)
        )
        assert foreign.status_code == missing.status_code == 404
        strip = ("instance", "request_id")
        assert {k: v for k, v in foreign.json().items() if k not in strip} == {
            k: v for k, v in missing.json().items() if k not in strip
        }
    assert world.polls == 0


def test_jobs_require_a_bearer_token(world: World, api: TestClient) -> None:
    _user, job = _member_job(world)
    assert api.get(f"{API}/jobs/{job}").status_code == 401
    assert api.get(f"{API}/jobs/{job}/events").status_code == 401
    # A token in the query string is never accepted.
    assert api.get(f"{API}/jobs/{job}/events?access_token=x").status_code == 401


def test_event_stream_reports_changes_and_ends_on_terminal(
    world: World, api: TestClient, bearer: Any
) -> None:
    user, job = _member_job(world)
    queued = _view(job, "queued")
    running = _view(job, "running", progress=15, stage="parsing", attempts=1)
    indexing = replace(running, progress=60, stage="indexing")
    done = _view(job, "succeeded", progress=100, attempts=1, finished_at=T0)
    world.timeline[job] = [queued, running, running, indexing, done]

    res = api.get(f"{API}/jobs/{job}/events", headers=bearer(user))

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert res.headers["cache-control"] == "no-store"
    assert res.text.startswith("retry: 1000\n\n")
    events = _events(res.text)
    assert [(e, d["status"], d["stage"]) for e, d in events] == [
        ("job", "queued", None),
        ("job", "running", "parsing"),
        ("job", "running", "indexing"),
        ("job", "succeeded", None),
    ]
    assert ": keep-alive" in res.text  # the unchanged poll became a heartbeat
    assert world.released == 1


def test_event_stream_ends_when_access_is_lost(world: World, api: TestClient, bearer: Any) -> None:
    user, job = _member_job(world)
    world.timeline[job] = [_view(job), None]

    res = api.get(f"{API}/jobs/{job}/events", headers=bearer(user))

    assert [e for e, _ in _events(res.text)] == ["job", "gone"]


def test_event_stream_is_bounded_in_time(
    world: World, app: FastAPI, api: TestClient, bearer: Any
) -> None:
    user, job = _member_job(world, "running", attempts=1)
    app.dependency_overrides[get_job_events_config] = lambda: JobEventsConfig(
        poll_seconds=0.01, heartbeat_seconds=60, max_seconds=0.05
    )

    res = api.get(f"{API}/jobs/{job}/events", headers=bearer(user))

    assert [e for e, _ in _events(res.text)] == ["job"]
    assert world.polls >= 2


def test_error_codes_never_carry_details() -> None:
    assert error_code("failed", "indexing_failed: injected") == "indexing_failed"
    assert error_code("failed", "unexpected_error: KeyError") == "unexpected_error"
    assert error_code("failed", "Weird Text: with a path /tmp/x") == "job_failed"
    assert error_code("failed", None) == "job_failed"
    assert error_code("cancelled", None) == "cancelled"
    assert error_code("queued", "worker_lost: lease expired") is None
    assert error_code("running", "storage_unavailable: download") is None


def test_progress_is_read_only_while_running() -> None:
    progress = {"progress": {"stage": "indexing", "percent": 60}}
    assert progress_of("running", progress) == (60, "indexing")
    assert progress_of("running", {"progress": {"stage": "Bad Stage", "percent": 250}}) == (
        99,
        None,
    )
    assert progress_of("running", {"progress": {"percent": True}}) == (None, None)
    assert progress_of("running", {"document_id": "x"}) == (None, None)
    assert progress_of("queued", progress) == (None, None)
    assert progress_of("failed", progress) == (None, None)
    assert progress_of("succeeded", {"document_id": "x"}) == (100, None)
