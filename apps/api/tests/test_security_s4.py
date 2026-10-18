"""S4 security regressions that need no infrastructure.

* Rate-limit keys cannot be dodged: another spelling of the same share id, a forged or unsigned
  relay identity, or an `X-Forwarded-For` header never yields a fresh bucket — also through the
  real launcher (uvicorn would otherwise rewrite the client address from X-Forwarded-For).
* 500s are as uncacheable as every other API response.
* No test-only or debug route exists in any environment: the app serves exactly the committed
  contract, and production has no interactive docs.
"""

from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from pydantic import SecretStr
from quiz_api import serve
from quiz_api.api.shared import get_search_repository, get_shared_repository
from quiz_api.main import create_app
from quiz_api.relay_client import CLIENT_HEADER, SIGNATURE_HEADER, client_key, relay_signature
from quiz_api.repositories.shared import SharedLink
from quiz_api.settings import Environment, Settings
from quiz_api.share_secrets import issue_secret
from starlette.requests import Request

WEB = "https://web.example"
CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "openapi.json"


@dataclass
class Links:
    links: dict[uuid.UUID, SharedLink] = field(default_factory=dict)

    def add(self) -> SharedLink:
        link = SharedLink(
            id=uuid.uuid4(),
            workspace_id=uuid.uuid4(),
            workspace_name="S4",
            archived=False,
            allow_fork=False,
            expires_at=None,
            usable=True,
            token_digest=issue_secret().digest,
        )
        self.links[link.id] = link
        return link

    def link(self, link_id: uuid.UUID) -> SharedLink | None:
        return self.links.get(link_id)

    def end_read(self) -> None:
        pass

    def searchable_documents(self, workspace_id: uuid.UUID) -> list[Any]:
        return []


def _app(links: Links, **settings: Any) -> Any:
    app = create_app(
        Settings.model_construct(cors_allowed_origins=(WEB,), **settings), readiness_checkers=[]
    )
    app.dependency_overrides[get_shared_repository] = lambda: links
    app.dependency_overrides[get_search_repository] = lambda: links
    return app


def _spellings(link_id: uuid.UUID) -> list[str]:
    """Strings FastAPI passes through and `uuid.UUID` parses as the same link."""
    text = str(link_id)
    return [
        text,
        text.upper(),
        text.replace("-", ""),
        f"{{{text}}}",
        f"urn:uuid:{text}",
        text[:8].upper() + text[8:],
    ]


def _exchange(api: TestClient, share_id: str, headers: dict[str, str] | None = None) -> int:
    res = api.post(
        f"/api/v1/shared/{share_id}/sessions",
        json={"secret": "A" * 43},
        headers={"Origin": WEB, **(headers or {})},
    )
    api.cookies.clear()
    return int(res.status_code)


def test_respelling_a_share_id_never_opens_a_new_client_bucket() -> None:
    links = Links()
    link = links.add()
    app = _app(links, share_exchange_rate_per_minute=3, share_exchange_link_rate_per_minute=1000)
    with TestClient(app, raise_server_exceptions=False) as api:
        statuses = [_exchange(api, s) for s in _spellings(link.id)]
    assert statuses == [404, 404, 404, 429, 429, 429]


def test_respelling_a_share_id_never_escapes_the_per_link_ceiling() -> None:
    links = Links()
    link = links.add()
    secret = "r" * 32
    app = _app(
        links,
        share_exchange_rate_per_minute=100,
        share_exchange_link_rate_per_minute=3,
        relay_client_secret=SecretStr(secret),
    )
    with TestClient(app, raise_server_exceptions=False) as api:
        statuses = [
            _exchange(
                api,
                s,
                {CLIENT_HEADER: f"c{i}", SIGNATURE_HEADER: relay_signature(secret, f"c{i}")},
            )
            for i, s in enumerate(_spellings(link.id))
        ]
    assert statuses == [404, 404, 404, 429, 429, 429]


def _request(headers: dict[str, str], settings: Settings) -> Request:
    app = type("App", (), {"state": type("State", (), {"settings": settings})()})()
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("198.51.100.1", 5000),
        "app": app,
    }
    return Request(scope)


def test_client_key_ignores_forwarded_and_unsigned_identity_headers() -> None:
    secret = "s" * 32
    configured = Settings.model_construct(relay_client_secret=SecretStr(secret))
    unconfigured = Settings.model_construct()
    peer = "peer:198.51.100.1"
    spoofs: list[dict[str, str]] = [
        {"X-Forwarded-For": "203.0.113.9"},
        {"X-Real-IP": "203.0.113.9", "Forwarded": "for=203.0.113.9"},
        {CLIENT_HEADER: "victim"},
        {CLIENT_HEADER: "victim", SIGNATURE_HEADER: "0" * 64},
        {CLIENT_HEADER: "victim", SIGNATURE_HEADER: relay_signature("x" * 32, "victim")},
        # A valid signature for another id, or with the id changed after signing.
        {CLIENT_HEADER: "victim", SIGNATURE_HEADER: relay_signature(secret, "attacker")},
        {CLIENT_HEADER: "victim ", SIGNATURE_HEADER: relay_signature(secret, "victim ")},
        {CLIENT_HEADER: "a" * 65, SIGNATURE_HEADER: relay_signature(secret, "a" * 65)},
        {CLIENT_HEADER: "victim", SIGNATURE_HEADER: relay_signature(secret, "victim").upper()},
    ]
    for headers in spoofs:
        assert client_key(_request(headers, configured)) == peer, headers
    signed = {CLIENT_HEADER: "victim", SIGNATURE_HEADER: relay_signature(secret, "victim")}
    assert client_key(_request(signed, configured)) == "relay:victim"
    # Without the secret configured even a "valid" signature means nothing.
    assert client_key(_request(signed, unconfigured)) == peer


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def test_the_launcher_never_takes_the_client_from_forwarded_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run uvicorn with exactly the launcher's options and look at what the app receives."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: captured.update(kwargs))
    monkeypatch.setattr(serve, "configure_logging", lambda *a, **k: None)
    serve.main(["--port", "0"])
    options = {k: v for k, v in captured.items() if k not in {"factory", "reload", "host", "port"}}
    assert options["proxy_headers"] is False

    seen: dict[str, Any] = {}

    async def echo(scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        seen["client"] = scope.get("client")
        seen["scheme"] = scope.get("scheme")
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    port = _free_port()
    config = uvicorn.Config(echo, host="127.0.0.1", port=port, **options)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.05)
        res = httpx.get(
            f"http://127.0.0.1:{port}/",
            headers={
                "X-Forwarded-For": "203.0.113.9",
                "X-Forwarded-Proto": "https",
                "Forwarded": "for=203.0.113.9;proto=https",
            },
        )
        assert res.status_code == 204
    finally:
        server.should_exit = True
        thread.join(10)
    assert seen["client"][0] == "127.0.0.1", "X-Forwarded-For became the client address"
    assert seen["scheme"] == "http"


# --- 500s ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "authorization", "cache", "robots"),
    [
        ("/api/v1/s4-boom", False, "no-store", None),
        ("/api/v1/shared/s4/boom/now", False, "private, no-store", "noindex, nofollow"),
        ("/s4-boom", True, "no-store", None),
        ("/s4-boom", False, None, None),
    ],
)
def test_unhandled_errors_are_never_cacheable(
    path: str, authorization: bool, cache: str | None, robots: str | None
) -> None:
    app = create_app(Settings.model_construct(), readiness_checkers=[])

    async def boom() -> None:
        raise RuntimeError("s4")

    app.add_api_route(path, boom)
    headers = {"Authorization": "Bearer x"} if authorization else {}
    with TestClient(app, raise_server_exceptions=False) as client:
        res = client.get(path, headers=headers)
    assert res.status_code == 500
    assert res.headers.get("cache-control") == cache
    assert res.headers.get("x-robots-tag") == robots
    assert res.headers["x-content-type-options"] == "nosniff"


# --- no test-only routes -----------------------------------------------------------------------

_SUSPICIOUS = ("test", "seed", "reset", "debug", "e2e", "fixture", "fake", "admin", "internal")


_FRAMEWORK = {"/api/v1/openapi.json", "/api/v1/docs", "/docs/oauth2-redirect"}


def _routes(routes: Any) -> list[Any]:
    """Every endpoint route, also inside included routers (hidden ones included)."""
    out: list[Any] = []
    for route in routes:
        nested = getattr(route, "original_router", None)
        out += _routes(nested.routes) if nested is not None else [route]
    return out


@pytest.mark.parametrize("env", list(Environment))
def test_every_environment_serves_exactly_the_contract(env: Environment) -> None:
    settings = Settings.model_construct(
        app_env=env,
        cors_allowed_origins=(WEB,),
        supabase_jwt_issuer="https://auth.example.com/auth/v1",
        supabase_jwks_url="https://auth.example.com/auth/v1/.well-known/jwks.json",
    )
    app = create_app(settings, readiness_checkers=[])
    spec = json.loads(CONTRACT.read_text())
    contract = {(m.upper(), p) for p, ops in spec["paths"].items() for m in ops}
    assert {(m.upper(), p) for p, ops in app.openapi()["paths"].items() for m in ops} == contract
    routes = _routes(app.routes)
    endpoints = [r for r in routes if r.path not in _FRAMEWORK]
    # Hidden routes (include_in_schema=False) would not show in the schema: count them all.
    assert sum(len(r.methods - {"HEAD"}) for r in endpoints) == len(contract)
    for route in endpoints:
        assert route.include_in_schema, f"hidden route {route.path}"
        assert not any(word in route.path.lower() for word in _SUSPICIOUS), route.path
    if env is Environment.PRODUCTION:
        assert "/api/v1/docs" not in {r.path for r in routes}, "interactive docs in production"
        assert app.docs_url is None
