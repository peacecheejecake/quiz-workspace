"""PERF-1: database round trips per request on the study paths stay pinned.

Every round trip to the hosted database costs its network latency (~140 ms from the Mac staging
stack to Supabase Singapore, a few ms from Railway), so the practice panel, the heatmap and the
workspace frame must not grow extra sequential statements. The API runs in-process against the
local stack through a counting TCP proxy: a round trip is a burst of client bytes sent after
the server last answered (BEGIN, each statement, COMMIT/ROLLBACK and pings all count; libpq
tracing would be exact but is Linux-only). Budgets are upper bounds: lower is fine, higher fails.

Fixtures come from conftest.py (`seed`, `stack`); users and workspaces are per test.
"""

from __future__ import annotations

import contextlib
import os
import selectors
import socket
import threading
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import pytest
from fastapi.testclient import TestClient
from quiz_api.main import create_app
from quiz_api.settings import Settings

pytestmark = pytest.mark.infra


class CountingProxy:
    """127.0.0.1:<port> -> the local Postgres; counts client->server round trips."""

    def __init__(self, target: tuple[str, int]) -> None:
        self._target = target
        self._listener = socket.create_server(("127.0.0.1", 0))
        self.port: int = self._listener.getsockname()[1]
        self._lock = threading.Lock()
        self._trips = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    @property
    def trips(self) -> int:
        with self._lock:
            return self._trips

    def _serve(self) -> None:
        sel = selectors.DefaultSelector()
        self._listener.setblocking(False)
        sel.register(self._listener, selectors.EVENT_READ, None)
        # socket -> (peer socket, is_client_side, shared state)
        while not self._stop.is_set():
            for key, _ in sel.select(timeout=0.2):
                if key.data is None:
                    client, _ = self._listener.accept()
                    server = socket.create_connection(self._target)
                    state = {"last": "server"}
                    client.setblocking(False)
                    server.setblocking(False)
                    sel.register(client, selectors.EVENT_READ, (server, True, state))
                    sel.register(server, selectors.EVENT_READ, (client, False, state))
                    continue
                sock: socket.socket = key.fileobj  # type: ignore[assignment]
                peer, from_client, state = key.data
                try:
                    data = sock.recv(65536)
                except OSError:
                    data = b""
                if not data:
                    for s in (sock, peer):
                        with contextlib.suppress(KeyError, ValueError):
                            sel.unregister(s)
                        s.close()
                    continue
                if from_client and state["last"] == "server":
                    with self._lock:
                        self._trips += 1
                state["last"] = "client" if from_client else "server"
                peer.setblocking(True)
                peer.sendall(data)
                peer.setblocking(False)
        sel.close()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        self._listener.close()


@pytest.fixture(scope="module")
def measured(stack: Any) -> Iterator[tuple[TestClient, CountingProxy]]:
    db_url = os.environ.get(
        "DATABASE_URL", "postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres"
    )
    parts = urlsplit(db_url)
    assert parts.hostname in {"127.0.0.1", "localhost"}, "refusing a non-local database"
    proxy = CountingProxy((parts.hostname or "127.0.0.1", parts.port or 5432))
    netloc = parts.netloc.rsplit(":", 1)[0] if parts.port else parts.netloc
    proxied = urlunsplit(parts._replace(netloc=f"{netloc}:{proxy.port}"))
    issuer = str(stack.auth.base_url).rstrip("/")
    settings = Settings(
        DATABASE_URL=proxied,
        SUPABASE_JWT_ISSUER=issuer,
        SUPABASE_JWKS_URL=f"{issuer}/.well-known/jwks.json",
    )
    try:
        with TestClient(create_app(settings, readiness_checkers=[])) as client:
            yield client, proxy
    finally:
        proxy.close()


class Meter:
    def __init__(self, http: TestClient, proxy: CountingProxy, token: str) -> None:
        self._http = http
        self._proxy = proxy
        self._headers = {"Authorization": f"Bearer {token}"}

    def trips(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        headers: dict[str, str] | None = None,
        expected: int = 200,
    ) -> tuple[int, Any]:
        before = self._proxy.trips
        res = self._http.request(
            method, f"/api/v1{path}", json=body, headers={**self._headers, **(headers or {})}
        )
        used = self._proxy.trips - before
        assert res.status_code == expected, f"{method} {path}: HTTP {res.status_code} {res.text}"
        return used, res.json() if res.content else None


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


# Budgets after PERF-1 (before: in parentheses), local stack, warm pool.
BUDGETS = {
    "GET /workspaces": 1,  # (4)
    "GET /workspaces/{id}": 2,  # (5)
    "GET overview": 2,  # (5)
    "GET documents": 2,  # (5)
    "POST practice-sessions (Idempotency-Key)": 8,  # (13)
    "POST submit": 5,  # (10)
    "GET practice-session": 3,  # (7)
    "PATCH my-state": 7,  # (10)
}


def test_study_paths_stay_within_their_round_trip_budget(
    seed: Any, measured: tuple[TestClient, CountingProxy]
) -> None:
    http, proxy = measured
    alice = seed.client("perf1-trips")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("왕복"), ["a", "b", "c"], 0))
    meter = Meter(http, proxy, alice.user.token)
    wid, qid = ws["id"], q["id"]

    # Warm the pool so connection setup (startup, auth, type lookups) is not counted.
    for _ in range(2):
        meter.trips("GET", f"/workspaces/{wid}")

    used: dict[str, int] = {}
    used["GET /workspaces"], _ = meter.trips("GET", "/workspaces?status=active")
    used["GET /workspaces/{id}"], _ = meter.trips("GET", f"/workspaces/{wid}")
    used["GET overview"], _ = meter.trips("GET", f"/workspaces/{wid}/questions/overview")
    used["GET documents"], _ = meter.trips("GET", f"/workspaces/{wid}/documents")
    used["POST practice-sessions (Idempotency-Key)"], session = meter.trips(
        "POST",
        f"/questions/{qid}/practice-sessions",
        {},
        headers={"Idempotency-Key": uuid.uuid4().hex},
        expected=201,
    )
    used["POST submit"], outcome = meter.trips(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-2"]}
    )
    used["GET practice-session"], resumed = meter.trips(
        "GET", f"/practice-sessions/{session['id']}"
    )
    used["PATCH my-state"], state = meter.trips(
        "PATCH", f"/questions/{qid}/my-state", {"is_favorite": True}
    )

    # The cheaper paths still do the work: graded once, state recorded, flags written.
    assert outcome["result"] == "incorrect"
    assert resumed["state"] == "graded"
    assert resumed["outcome"]["attempt_id"] == outcome["attempt_id"]
    assert state["is_favorite"] is True
    assert state["needs_retry"] is False
    assert state["last_graded_result"] == "incorrect"
    over = {k: (v, BUDGETS[k]) for k, v in used.items() if v > BUDGETS[k]}
    assert not over, f"round trips over budget (used, budget): {over}; all: {used}"
