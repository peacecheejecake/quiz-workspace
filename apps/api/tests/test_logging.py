from __future__ import annotations

import io
import logging
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.health import ReadinessChecker
from quiz_api.logging_config import (
    REDACTED,
    RedactionFilter,
    RequestIdFilter,
    build_handler,
    redact,
)

TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"  # noqa: S105 - fake JWT


def test_authorization_header_never_reaches_logs(
    make_app: Callable[..., FastAPI],
    failing: Callable[..., ReadinessChecker],
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = make_app([failing("database", RuntimeError(f"Bearer {TOKEN}"))])
    caplog.set_level(logging.DEBUG)
    auth = {"Authorization": f"Bearer {TOKEN}"}

    with TestClient(app, raise_server_exceptions=False) as client:
        client.get("/health/live", headers=auth)
        client.get("/health/ready", headers=auth)
        client.get(f"/api/v1/nope?access_token={TOKEN}", headers=auth)

    access_lines = [r.getMessage() for r in caplog.records if r.name == "quiz_api.access"]
    assert len(access_lines) == 3
    assert access_lines[2].startswith("GET /api/v1/nope 404 ")
    # httpx/httpcore records are TestClient's own client-side request lines, not the server's.
    # Everything else (app, uvicorn, starlette) is checked raw, with exception text, so the
    # result does not depend on whether the redacting handler ran before caplog's.
    plain = logging.Formatter()
    server_records = [r for r in caplog.records if not r.name.startswith(("httpx", "httpcore"))]
    server_text = "\n".join(plain.format(r) for r in server_records)
    assert server_records
    assert TOKEN not in server_text
    assert "Authorization" not in server_text
    assert "access_token" not in server_text


def test_request_id_is_generated_and_attached_to_records(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="quiz_api.access")

    response = client.get("/health/live", headers={"X-Request-ID": "bad id with spaces"})

    request_id = response.headers["x-request-id"]
    assert request_id != "bad id with spaces"
    assert len(request_id) == 32
    record = next(r for r in caplog.records if r.name == "quiz_api.access")
    RequestIdFilter().filter(record)
    # The access line is emitted inside the request context.
    assert record.__dict__["request_id"] in {request_id, "-"}


@pytest.mark.parametrize(
    ("message", "leaked"),
    [
        (f"Authorization: Bearer {TOKEN}", TOKEN),
        (f"token={TOKEN}", TOKEN),
        ("connect postgresql://postgres:s3cret@db:5432/app", "s3cret"),
        # Password-only URL, the usual REDIS_URL form.
        ("connect redis://:s3cret@redis:6379/0", "s3cret"),
    ],
)
def test_redaction_filter_scrubs_tokens_and_url_credentials(message: str, leaked: str) -> None:
    assert leaked not in redact(message)
    assert REDACTED in redact(message)

    record = logging.LogRecord("x", logging.INFO, __file__, 1, "%s", (message,), None)
    RedactionFilter().filter(record)
    assert leaked not in record.getMessage()


def _secret_error() -> RuntimeError:
    return RuntimeError(
        f"upstream rejected GET /x?access_token={TOKEN} via postgresql://app:s3cret@db:5432/app"
    )


def test_formatted_output_redacts_exception_text_and_stack_info() -> None:
    stream = io.StringIO()
    logger = logging.getLogger("quiz_api.tests.formatter")
    logger.propagate = False
    logger.addHandler(build_handler(stream))
    try:
        try:
            raise _secret_error()
        except RuntimeError:
            logger.exception("request failed", stack_info=True)
    finally:
        logger.handlers.clear()

    output = stream.getvalue()
    assert "Traceback (most recent call last)" in output
    assert "Stack (most recent call last)" in output
    assert "RuntimeError: upstream rejected" in output
    assert TOKEN not in output
    assert "s3cret" not in output
    assert f"access_token={REDACTED}" in output


def test_unhandled_exception_traceback_is_redacted_in_handler_output(
    make_app: Callable[..., FastAPI],
) -> None:
    app = make_app()

    @app.get("/_probe/boom")
    async def boom() -> None:
        raise _secret_error()

    stream = io.StringIO()
    handler = build_handler(stream)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            assert client.get("/_probe/boom").status_code == 500
    finally:
        root.removeHandler(handler)

    output = stream.getvalue()
    assert "Unhandled RuntimeError on GET /_probe/boom" in output
    assert "Traceback (most recent call last)" in output
    assert TOKEN not in output
    assert "s3cret" not in output
