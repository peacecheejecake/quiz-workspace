"""Logging setup: request-id correlation plus defence-in-depth token redaction.

The application never logs request headers or query strings. Redaction is a second line of
defence in case a bearer token, JWT or credential ends up in a log line anyway: the handler's
formatter scrubs the *final* output, so exception text and stack info are covered too.

Every log line, uvicorn's included, goes through the one root handler installed here:
`UVICORN_LOG_CONFIG` removes uvicorn's own handlers and its access log (which would print
query strings). Launch the server with `quiz_api.serve`, never bare `uvicorn`.
"""

from __future__ import annotations

import logging
import re
from contextvars import ContextVar
from typing import Any

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

REDACTED = "[REDACTED]"

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # `Authorization: Bearer <token>` / `Bearer <token>` in any message.
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"), REDACTED),
    # Bare JWTs (header.payload.signature, base64url, header starts with `eyJ`).
    (re.compile(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"), REDACTED),
    # Credentials embedded in connection URLs: scheme://user:password@host
    (re.compile(r"(?<=://)[^/\s:@]+:[^/\s@]+(?=@)"), REDACTED),
    # Secret-looking query/form parameters: `access_token=...`, `api_key=...`, ...
    (
        re.compile(
            r"(?i)\b((?:access|refresh|id)_token|token|api[_-]?key|password|secret|code)"
            r"=[^&\s\"']+"
        ),
        rf"\1={REDACTED}",
    ),
)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [request_id=%(request_id)s] %(message)s"


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class RequestIdFilter(logging.Filter):
    """Attach the current request id (or `-`) to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or "-"
        return True


class RedactionFilter(logging.Filter):
    """Scrub the rendered message in place, so later handlers also see the clean text.

    Exception text and stack info are not covered here; `RedactingFormatter` handles them.
    """

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
    """The app's log handler (stderr by default) with request-id and redaction applied."""
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter(_LOG_FORMAT))
    handler.addFilter(RequestIdFilter())
    handler.addFilter(RedactionFilter())
    return handler


def configure_logging(level: str = "INFO") -> None:
    """Install one redacting stream handler on the root logger.

    Idempotent: calling it again (e.g. one app per test) does not stack handlers.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())
    for handler in root.handlers:
        if getattr(handler, "_quiz_api", False):
            return
    handler = build_handler()
    handler._quiz_api = True  # type: ignore[attr-defined]
    root.addHandler(handler)


# dictConfig for uvicorn: no uvicorn handlers (records propagate to the redacting root
# handler) and no uvicorn access log (it records query strings; RequestIdMiddleware already
# writes a query-free access line).
UVICORN_LOG_CONFIG: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "loggers": {
        "uvicorn": {"handlers": [], "level": "INFO", "propagate": True},
        "uvicorn.error": {"handlers": [], "level": "INFO", "propagate": True},
        "uvicorn.access": {"handlers": [], "level": "CRITICAL", "propagate": False},
    },
}
