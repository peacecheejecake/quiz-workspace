"""Worker logging: job-id correlation plus defence-in-depth token redaction.

The redaction patterns mirror `quiz_api.logging_config` (tests/test_logging.py checks that the
worker redacts everything the API does) until both move into a shared module; the worker also
covers password-only connection URLs (`redis://:password@host`). Job code never logs envelopes or
payloads (they may carry book text); redaction is only the second line of defence for
tokens, JWTs and connection-string credentials that end up in a message or traceback anyway.
"""

from __future__ import annotations

import logging
import re
from contextvars import ContextVar
from typing import Any

job_id_var: ContextVar[str | None] = ContextVar("job_id", default=None)

REDACTED = "[REDACTED]"

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # `Authorization: Bearer <token>` / `Bearer <token>` in any message.
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"), REDACTED),
    # Bare JWTs (header.payload.signature, base64url, header starts with `eyJ`).
    (re.compile(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"), REDACTED),
    # Credentials embedded in connection URLs: scheme://user:password@host, including the
    # password-only form Redis uses (redis://:password@host).
    (re.compile(r"(?<=://)[^/\s:@]*:[^/\s@]+(?=@)"), REDACTED),
    # Secret-looking query/form parameters: `access_token=...`, `api_key=...`, ...
    (
        re.compile(
            r"(?i)\b((?:access|refresh|id)_token|token|api[_-]?key|password|secret|code)"
            r"=[^&\s\"']+"
        ),
        rf"\1={REDACTED}",
    ),
)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [job_id=%(job_id)s] %(message)s"


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class JobIdFilter(logging.Filter):
    """Attach the current job id (or `-`) to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.job_id = job_id_var.get() or "-"
        return True


class RedactionFilter(logging.Filter):
    """Scrub the rendered message in place, so later handlers also see the clean text."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = redact(message)
        if cleaned != message:
            record.msg = cleaned
            record.args = None
        return True


class RedactingFormatter(logging.Formatter):
    """Redact the fully formatted line: message, exception traceback and stack info."""

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def build_handler(stream: Any = None) -> logging.Handler:
    """The worker's log handler (stderr by default) with job-id and redaction applied."""
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter(_LOG_FORMAT))
    handler.addFilter(JobIdFilter())
    handler.addFilter(RedactionFilter())
    return handler


def configure_logging(level: str = "INFO") -> None:
    """Install one redacting stream handler on the root logger (idempotent)."""
    root = logging.getLogger()
    root.setLevel(level.upper())
    for handler in root.handlers:
        if getattr(handler, "_quiz_worker", False):
            return
    handler = build_handler()
    handler._quiz_worker = True  # type: ignore[attr-defined]
    root.addHandler(handler)
