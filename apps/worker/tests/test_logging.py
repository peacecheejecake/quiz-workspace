from __future__ import annotations

import io
import logging

import pytest
from book_core import log_redaction
from quiz_api import logging_config as api_logging
from quiz_worker import logging_config as worker_logging
from quiz_worker.errors import JobError, safe_traceback, sanitize_error
from quiz_worker.logging_config import (
    REDACTED,
    JobIdFilter,
    build_handler,
    job_id_var,
    redact,
)

from .conftest import BOOK_TEXT, TOKEN

SAMPLES = [
    f"Authorization: Bearer {TOKEN}",
    f"token={TOKEN}",
    "connect postgresql://postgres:s3cret@db:5432/app",
    "connect redis://:s3cret@redis:6379/0",
    f"GET /x?access_token={TOKEN}&api_key=abc",
]


def test_api_and_worker_share_one_redaction_implementation() -> None:
    assert worker_logging.redact is api_logging.redact is log_redaction.redact
    assert worker_logging.RedactingFormatter is api_logging.RedactingFormatter


@pytest.mark.parametrize("message", SAMPLES)
def test_redact_scrubs_tokens_and_url_credentials(message: str) -> None:
    cleaned = redact(message)

    assert TOKEN not in cleaned
    assert "s3cret" not in cleaned
    assert REDACTED in cleaned


def test_handler_attaches_job_id_and_redacts_the_formatted_line() -> None:
    stream = io.StringIO()
    logger = logging.getLogger("quiz_worker.tests.handler")
    logger.propagate = False
    logger.addHandler(build_handler(stream))
    token = job_id_var.set("job-123")
    try:
        try:
            raise RuntimeError(f"upstream rejected token={TOKEN}")
        except RuntimeError:
            logger.exception("call failed for %s", f"Bearer {TOKEN}")
    finally:
        job_id_var.reset(token)
        logger.handlers.clear()

    output = stream.getvalue()
    assert "[job_id=job-123]" in output
    assert "Traceback (most recent call last)" in output
    assert TOKEN not in output


def test_job_id_filter_defaults_to_dash() -> None:
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "m", None, None)

    JobIdFilter().filter(record)

    assert record.__dict__["job_id"] == "-"


def test_sanitize_error_never_includes_arbitrary_exception_text() -> None:
    class QuotaError(JobError):
        code = "quota"

    assert sanitize_error(ValueError(BOOK_TEXT)) == "unexpected_error: ValueError"
    assert sanitize_error(QuotaError()) == "quota"
    assert sanitize_error(QuotaError(f"limit 5, Bearer {TOKEN}")) == f"quota: limit 5, {REDACTED}"
    assert len(sanitize_error(QuotaError("x" * 2000))) == 500


def test_safe_traceback_keeps_frames_but_drops_the_message() -> None:
    try:
        raise KeyError(BOOK_TEXT)
    except KeyError as exc:
        text = safe_traceback(exc)

    assert "test_safe_traceback_keeps_frames_but_drops_the_message" in text
    assert text.endswith("unexpected_error: KeyError")
    assert "fox jumps" not in text
