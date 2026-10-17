"""Logging setup: request-id correlation plus defence-in-depth token redaction.

The application never logs request headers or query strings. The redaction filter is a
second line of defence in case a bearer token or JWT ends up in a log message anyway.
"""

from __future__ import annotations

import logging
import re
from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

REDACTED = "[REDACTED]"

_REDACTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    # `Authorization: Bearer <token>` / `Bearer <token>` in any message.
    re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"),
    # Bare JWTs (header.payload.signature, base64url, header starts with `eyJ`).
    re.compile(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"),
    # Credentials embedded in connection URLs: scheme://user:password@host
    re.compile(r"(?<=://)[^/\s:@]+:[^/\s@]+(?=@)"),
)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [request_id=%(request_id)s] %(message)s"


def redact(text: str) -> str:
    for pattern in _REDACTION_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


class RequestIdFilter(logging.Filter):
    """Attach the current request id (or `-`) to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or "-"
        return True


class RedactionFilter(logging.Filter):
    """Scrub tokens and URL credentials from the rendered message."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = redact(message)
        if cleaned != message:
            record.msg = cleaned
            record.args = None
        return True


def configure_logging(level: str = "INFO") -> None:
    """Install one stream handler on the root logger with both filters.

    Idempotent: calling it again (e.g. one app per test) does not stack handlers.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())
    for handler in root.handlers:
        if getattr(handler, "_quiz_api", False):
            return
    handler = logging.StreamHandler()
    handler._quiz_api = True  # type: ignore[attr-defined]
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    handler.addFilter(RequestIdFilter())
    handler.addFilter(RedactionFilter())
    root.addHandler(handler)
