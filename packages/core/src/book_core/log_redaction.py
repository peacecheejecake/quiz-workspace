"""Defence-in-depth redaction for service logs, shared by the API and the worker.

Services never log request headers, query strings, job payloads or book text on purpose.
This is the second line of defence for a bearer token, JWT or credential that ends up in a
log line anyway (an exception message, a library's debug output). `RedactingFormatter`
scrubs the *final* formatted line, so exception text and stack info are covered too.

Stdlib only, so importing it never pulls the core's parsing or model stacks.
"""

from __future__ import annotations

import logging
import re

__all__ = ["REDACTED", "RedactingFormatter", "RedactionFilter", "redact"]

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


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


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
