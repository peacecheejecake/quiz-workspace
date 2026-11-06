"""UX12-OPEN: `Server-Timing` on the opening routes; durations and a count, nothing else."""

from __future__ import annotations

import re

import pytest
from sqlalchemy import create_engine, text
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from quiz_api.server_timing import (
    SERVER_TIMING_HEADER,
    ServerTimingMiddleware,
    install_statement_timing,
)

HEADER = re.compile(r'^db;dur=\d+\.\d;desc="(\d+)", app;dur=\d+\.\d$')
QUESTION = "00000000-0000-4000-8000-000000000001"


def _client() -> TestClient:
    engine = create_engine("sqlite://")
    install_statement_timing(engine)

    def handler(_request: Request) -> PlainTextResponse:
        with engine.connect() as connection:
            connection.execute(text("select 1"))
            connection.execute(text("select 2"))
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/{path:path}", handler, methods=["GET", "POST"])])
    app.add_middleware(ServerTimingMiddleware)
    return TestClient(app)


@pytest.mark.parametrize(
    "path",
    [
        f"/api/v1/questions/{QUESTION}/practice-open",
        f"/api/v1/questions/{QUESTION}/practice-recent",
        f"/api/v1/questions/{QUESTION}/practice-sessions",
    ],
)
def test_opening_routes_report_statements_and_durations(path: str) -> None:
    header = _client().post(path).headers[SERVER_TIMING_HEADER]
    match = HEADER.fullmatch(header)
    assert match is not None, header
    assert match[1] == "2"


@pytest.mark.parametrize(
    "path", ["/api/v1/workspaces", f"/api/v1/questions/{QUESTION}/practice-reset", "/health"]
)
def test_other_routes_carry_no_timing(path: str) -> None:
    assert SERVER_TIMING_HEADER not in _client().post(path).headers
