"""Runs the real launcher (`python -m quiz_api.serve`) in a subprocess, not TestClient."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"  # noqa: S105 - fake JWT


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def _wait_until_up(server: subprocess.Popen[bytes], base: str, log_path: Path) -> None:
    deadline = time.monotonic() + 20
    while True:
        try:
            httpx.get(f"{base}/health/live", timeout=1)
            return
        except httpx.TransportError:
            assert server.poll() is None, log_path.read_text()
            assert time.monotonic() < deadline, "server did not start"
            time.sleep(0.1)


def test_real_server_never_logs_query_string_tokens(tmp_path: Path) -> None:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {k: v for k, v in os.environ.items() if k not in {"DATABASE_URL", "REDIS_URL"}}
    env["PYTHONUNBUFFERED"] = "1"
    log_path = tmp_path / "server.log"
    with log_path.open("w") as log:
        # cwd=tmp_path so no developer `.env` is read.
        server = subprocess.Popen(  # noqa: S603 - fixed argv
            [sys.executable, "-m", "quiz_api.serve", "--port", str(port)],
            cwd=tmp_path,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            _wait_until_up(server, base, log_path)
            response = httpx.get(
                f"{base}/api/v1/nope?access_token={TOKEN}",
                headers={"Authorization": f"Bearer {TOKEN}"},
            )
            assert response.status_code == 404
        finally:
            server.terminate()
            server.wait(timeout=10)

    output = log_path.read_text()
    # Non-vacuous: uvicorn's own lines and the app's access line went through our handler.
    assert "uvicorn.error [request_id=-] Uvicorn running on" in output
    assert "GET /api/v1/nope 404" in output
    assert TOKEN not in output
    assert "access_token" not in output
    assert "Authorization" not in output
