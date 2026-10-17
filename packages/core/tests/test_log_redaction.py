from __future__ import annotations

import io
import logging

import pytest
from book_core.log_redaction import REDACTED, RedactingFormatter, RedactionFilter, redact

TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"  # noqa: S105 - fake JWT


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (f"Authorization: Bearer {TOKEN}", f"Authorization: {REDACTED}"),
        (f"jwt {TOKEN} seen", f"jwt {REDACTED} seen"),
        ("postgresql://app:s3cret@db:5432/x", f"postgresql://{REDACTED}@db:5432/x"),
        ("redis://:s3cret@redis:6379/0", f"redis://{REDACTED}@redis:6379/0"),
        (
            "GET /x?access_token=abc&api_key=def",
            f"GET /x?access_token={REDACTED}&api_key={REDACTED}",
        ),
        (
            "redis://redis:6379/0 and https://example.com/a@b",
            "redis://redis:6379/0 and https://example.com/a@b",
        ),
        ("nothing secret here", "nothing secret here"),
    ],
)
def test_redact(message: str, expected: str) -> None:
    assert redact(message) == expected


def test_filter_and_formatter_scrub_message_and_traceback() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter("%(message)s"))
    handler.addFilter(RedactionFilter())
    logger = logging.getLogger("book_core.tests.log_redaction")
    logger.propagate = False
    logger.addHandler(handler)
    try:
        try:
            raise RuntimeError(f"failed with token={TOKEN}")
        except RuntimeError:
            logger.exception("calling %s", "redis://:s3cret@redis:6379/0")
    finally:
        logger.removeHandler(handler)

    output = stream.getvalue()
    assert "Traceback (most recent call last)" in output
    assert TOKEN not in output
    assert "s3cret" not in output
