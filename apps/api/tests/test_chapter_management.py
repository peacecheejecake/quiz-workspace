"""CHMAN-01-C06: a retried DELETE finds the chapter gone and still gets its saved response, but
only for the caller and only while the caller may edit that workspace."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api import chapter_management as chapters
from quiz_api.api.document_revisions import get_content_repository
from quiz_api.api.questions import get_idempotency_store
from quiz_api.auth.dependencies import get_current_user
from quiz_api.auth.verifier import AuthenticatedUser
from quiz_api.authz import Role, get_access_repository
from quiz_api.authz.repository import MembershipRecord
from quiz_api.errors import ProblemType
from quiz_api.idempotency import REPLAYED_HEADER, request_hash
from quiz_api.main import create_app
from quiz_api.repositories.idempotency import StoredResponse
from quiz_api.settings import Settings

WS = uuid.uuid4()
USER = uuid.uuid4()
CHAPTER = uuid.uuid4()
KEY = {"Idempotency-Key": "retry-1"}
PATH = f"/api/v1/chapters/{CHAPTER}?move_questions_to=none"
SAVED = {"workspace_id": str(WS), "moved_questions": 2, "version": 9}


class World:
    """The chapter is gone; `saved` is what the first delete stored for USER."""

    def __init__(self) -> None:
        self.saved: dict[tuple[uuid.UUID, str, str], StoredResponse] = {
            (USER, f"DELETE /chapters/{CHAPTER}", "retry-1"): StoredResponse(
                request_hash({"move_questions_to": "none"}), 200, SAVED
            )
        }
        self.member: MembershipRecord | None = MembershipRecord(
            WS, USER, Role.EDITOR, "active", None
        )
        self.calls: list[str] = []

    def lock(self, user_id: uuid.UUID, scope: str, key: str) -> None:
        self.calls.append("lock")

    def find(self, user_id: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        self.calls.append("find")
        return self.saved.get((user_id, scope, key))

    def load_membership(self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: Any) -> Any:
        self.calls.append("membership")
        assert workspace_id == WS, "authorized in the saved response's workspace"
        return self.member

    def load_resource_membership(self, *args: Any, **kwargs: Any) -> None:
        return None  # the row is gone


@pytest.fixture
def world() -> World:
    return World()


def client(world: World, user_id: uuid.UUID = USER) -> Iterator[TestClient]:
    app: FastAPI = create_app(Settings.model_construct(), readiness_checkers=[])
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=user_id)
    app.dependency_overrides[get_access_repository] = lambda: world
    app.dependency_overrides[get_idempotency_store] = lambda: world
    for dependency in (
        chapters._edit_repo,
        chapters._redist_repo,
        chapters._questions,
        get_content_repository,
    ):
        app.dependency_overrides[dependency] = lambda: world
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def api(world: World) -> Iterator[TestClient]:
    yield from client(world)


def test_a_retry_replays_after_authorizing_the_saved_workspace(
    world: World, api: TestClient
) -> None:
    res = api.delete(PATH, headers=KEY)
    assert res.status_code == 200, res.text
    assert res.json() == SAVED
    assert res.headers[REPLAYED_HEADER] == "true"
    assert world.calls == ["lock", "find", "membership"]


def test_another_body_with_the_key_is_refused(world: World, api: TestClient) -> None:
    res = api.delete(f"/api/v1/chapters/{CHAPTER}", headers=KEY)
    assert res.status_code == 409
    assert res.json()["type"] == ProblemType.IDEMPOTENCY_KEY_REUSED


def test_without_a_key_a_deleted_chapter_is_404(api: TestClient) -> None:
    assert api.delete(PATH).status_code == 404


def test_someone_else_with_the_same_key_finds_nothing(world: World) -> None:
    other = next(client(world, uuid.uuid4()))
    res = other.delete(PATH, headers=KEY)
    assert res.status_code == 404
    assert "moved_questions" not in res.text


def test_a_member_removed_since_gets_the_plain_404(world: World, api: TestClient) -> None:
    gone = api.delete(PATH)
    world.member = None
    res = api.delete(PATH, headers=KEY)
    assert res.status_code == 404
    assert res.json()["detail"] == gone.json()["detail"], "no probing the saved response"
    assert "moved_questions" not in res.text


@pytest.mark.parametrize(
    ("role", "state", "problem"),
    [
        (Role.VIEWER, "active", ProblemType.INSUFFICIENT_ROLE),
        (Role.EDITOR, "archived", ProblemType.WORKSPACE_ARCHIVED),
    ],
)
def test_a_saved_response_follows_the_workspace_today(
    world: World, api: TestClient, role: Role, state: str, problem: ProblemType
) -> None:
    world.member = MembershipRecord(WS, USER, role, state, None)
    res = api.delete(PATH, headers=KEY)
    assert res.status_code == 403
    assert res.json()["type"] == problem
    assert "moved_questions" not in res.text
