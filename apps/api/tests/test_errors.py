from __future__ import annotations

from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from quiz_api.api import API_V1_PREFIX

PROBLEM = "application/problem+json"


def _probe_client(make_app: Callable[..., FastAPI]) -> TestClient:
    """App with throwaway routes that raise each error kind (not part of the contract)."""
    app = make_app()

    @app.get("/_probe/unauthorized")
    async def unauthorized() -> None:
        raise HTTPException(status_code=401, detail="Missing bearer token.")

    @app.get("/_probe/forbidden")
    async def forbidden() -> None:
        raise HTTPException(status_code=403)

    @app.get("/_probe/items/{item_id}")
    async def item(item_id: int) -> dict[str, int]:
        return {"item_id": item_id}

    @app.get("/_probe/boom")
    async def boom() -> None:
        raise RuntimeError("database password is hunter2")

    return TestClient(app, raise_server_exceptions=False)


def test_unknown_route_returns_problem_shape(client: TestClient) -> None:
    response = client.get(f"{API_V1_PREFIX}/does-not-exist", headers={"X-Request-ID": "req-123"})

    assert response.status_code == 404
    assert response.headers["content-type"] == PROBLEM
    assert response.headers["x-request-id"] == "req-123"
    assert response.json() == {
        "type": "about:blank",
        "title": "Not Found",
        "status": 404,
        "instance": f"{API_V1_PREFIX}/does-not-exist",
        "request_id": "req-123",
    }


def test_method_not_allowed_returns_problem_shape(client: TestClient) -> None:
    response = client.post("/health/live")

    assert response.status_code == 405
    assert response.headers["content-type"] == PROBLEM
    assert response.json()["title"] == "Method Not Allowed"


def test_401_and_403_are_distinct_problems(make_app: Callable[..., FastAPI]) -> None:
    client = _probe_client(make_app)

    unauthorized = client.get("/_probe/unauthorized")
    forbidden = client.get("/_probe/forbidden")

    assert unauthorized.status_code == 401
    assert unauthorized.headers["content-type"] == PROBLEM
    assert unauthorized.headers["www-authenticate"] == "Bearer"
    assert unauthorized.json()["title"] == "Unauthorized"
    assert unauthorized.json()["detail"] == "Missing bearer token."

    assert forbidden.status_code == 403
    assert forbidden.headers["content-type"] == PROBLEM
    assert forbidden.json()["title"] == "Forbidden"
    assert "detail" not in forbidden.json()
    assert "www-authenticate" not in forbidden.headers


def test_validation_error_returns_422_problem_without_echoing_input(
    make_app: Callable[..., FastAPI],
) -> None:
    client = _probe_client(make_app)

    response = client.get("/_probe/items/secret-value")

    assert response.status_code == 422
    assert response.headers["content-type"] == PROBLEM
    body = response.json()
    assert body["title"] == "Unprocessable Content"
    assert body["errors"] == [
        {
            "loc": ["path", "item_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "type": "int_parsing",
        }
    ]
    assert "secret-value" not in response.text.replace(body["instance"], "")


def test_unhandled_error_returns_generic_500_problem(make_app: Callable[..., FastAPI]) -> None:
    client = _probe_client(make_app)

    response = client.get("/_probe/boom", headers={"X-Request-ID": "req-500"})

    assert response.status_code == 500
    assert response.headers["content-type"] == PROBLEM
    assert response.headers["x-request-id"] == "req-500"
    assert response.json() == {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "instance": "/_probe/boom",
        "request_id": "req-500",
    }
    assert "hunter2" not in response.text
