"""Job error classes and the sanitizer that turns any exception into a storable message.

`async_jobs.last_error`, logs and the Celery result backend only ever receive
`sanitize_error(exc)`: a stable code plus, for `JobError`s, an author-written message. The
text of arbitrary exceptions is never stored because it may quote payload or book text
(e.g. a parser echoing the offending line) or a credential.
"""

from __future__ import annotations

import traceback

from quiz_worker.logging_config import redact

MAX_ERROR_LENGTH = 500


class JobError(Exception):
    """Base for errors raised by job code on purpose.

    `safe_message` must be written by the developer (constants, ids, counts) and never
    interpolate payload values, book text, URLs or credentials.
    """

    code = "job_error"
    retryable = True

    def __init__(self, safe_message: str = "") -> None:
        super().__init__(safe_message)
        self.safe_message = safe_message


class NonRetryableJobError(JobError):
    """Fails the job immediately: retrying cannot help (bad input, missing resource...)."""

    code = "non_retryable"
    retryable = False


class InvalidEnvelopeError(NonRetryableJobError):
    code = "invalid_envelope"


class InvalidPayloadError(NonRetryableJobError):
    code = "invalid_payload"


class UnsupportedSchemaVersionError(NonRetryableJobError):
    code = "unsupported_schema_version"


class JobCancelledError(JobError):
    """Raised by `JobContext.check_cancelled()`; the runner records `cancelled`."""

    code = "cancelled"
    retryable = False


class JobOutcomeError(Exception):
    """Raised to Celery for a job that ends failed/rejected, so the task state is FAILURE.

    Carries only the job id and the already-sanitized error; raised `from None` so Celery's
    failure log and result backend never see the original exception text.
    """

    def __init__(self, job_id: str | None, error: str) -> None:
        # args == constructor arguments, so Celery can rebuild it from the result backend.
        super().__init__(job_id, error)
        self.job_id = job_id
        self.error = error

    def __str__(self) -> str:
        return f"job {self.job_id or '-'} {self.error}"


class JobRetryError(JobOutcomeError):
    """The `exc` handed to `Task.retry`, so Celery's retry log line is sanitized too."""


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, JobError):
        return exc.retryable
    return True


def sanitize_error(exc: BaseException) -> str:
    if isinstance(exc, JobError):
        text = f"{exc.code}: {exc.safe_message}" if exc.safe_message else exc.code
    else:
        text = f"unexpected_error: {type(exc).__name__}"
    return redact(text)[:MAX_ERROR_LENGTH]


def safe_traceback(exc: BaseException) -> str:
    """Stack frames plus the exception type, without the exception message.

    Frames show worker source lines only; the message (which may quote payload text) is
    replaced by the sanitized error. Chained exceptions are omitted for the same reason.
    """
    frames = "".join(traceback.format_list(traceback.extract_tb(exc.__traceback__)))
    return redact(f"Traceback (most recent call last):\n{frames}{sanitize_error(exc)}")
