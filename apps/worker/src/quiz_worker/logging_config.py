"""Worker logging: job-id correlation plus defence-in-depth token redaction.

Redaction comes from `book_core.log_redaction`, shared with the API. Job code never logs
envelopes or payloads (they may carry book text); redaction is only the second line of
defence for tokens, JWTs and connection-string credentials that end up in a message or
traceback anyway.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

from book_core.log_redaction import REDACTED, RedactingFormatter, RedactionFilter, redact

__all__ = [
    "REDACTED",
    "JobIdFilter",
    "RedactingFormatter",
    "RedactionFilter",
    "build_handler",
    "configure_logging",
    "job_id_var",
    "redact",
]

job_id_var: ContextVar[str | None] = ContextVar("job_id", default=None)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [job_id=%(job_id)s] %(message)s"


class JobIdFilter(logging.Filter):
    """Attach the current job id (or `-`) to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.job_id = job_id_var.get() or "-"
        return True


def build_handler(stream: Any = None) -> logging.Handler:
    """The worker's log handler (stderr by default) with job-id and redaction applied."""
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter(_LOG_FORMAT))
    handler.addFilter(JobIdFilter())
    handler.addFilter(RedactionFilter())
    return handler


# These log raw message bodies (the job envelope, i.e. payload) at DEBUG; never below INFO.
PAYLOAD_LOGGING_LOGGERS = ("celery.pool", "kombu", "amqp", "fakeredis")


def configure_logging(level: str = "INFO") -> None:
    """Install one redacting stream handler on the root logger (idempotent)."""
    root = logging.getLogger()
    root.setLevel(level.upper())
    for name in PAYLOAD_LOGGING_LOGGERS:
        logging.getLogger(name).setLevel(max(logging.INFO, root.level))
    for handler in root.handlers:
        if getattr(handler, "_quiz_worker", False):
            return
    handler = build_handler()
    handler._quiz_worker = True  # type: ignore[attr-defined]
    root.addHandler(handler)
