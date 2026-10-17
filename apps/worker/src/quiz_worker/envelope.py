"""Versioned task envelope: the only message format a job task accepts.

Every Celery job message carries exactly one positional argument, the JSON form of
`JobEnvelope`. The envelope identifies the `async_jobs` row (`job_id`) and repeats the row's
identity (`job_type`, `workspace_id`, `idempotency_key`, `schema_version`) so the worker can
refuse a message that does not match the stored job. `payload` is versioned per job type by
`schema_version` and validated by the job's own payload model.

Validation errors are reported as `loc: error_type` only; Pydantic's default message would
echo the offending input (possibly book text or a token).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from quiz_worker.errors import InvalidEnvelopeError

# job types are dotted lowercase identifiers, e.g. `document.parse`, `workspace.fork`.
JOB_TYPE_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"
# Client-chosen (POST Idempotency-Key) or server-derived; opaque, never secret.
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9._:-]{1,200}$"

_SAFE_LOC = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


class JobEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=False)

    job_id: UUID
    job_type: str = Field(pattern=JOB_TYPE_PATTERN, max_length=100)
    schema_version: int = Field(ge=1)
    idempotency_key: str = Field(pattern=IDEMPOTENCY_KEY_PATTERN)
    workspace_id: UUID
    # repr=False: an envelope that lands in a log or traceback never prints the payload.
    payload: dict[str, JsonValue] = Field(default_factory=dict, repr=False)

    def to_message(self) -> dict[str, Any]:
        """JSON-safe dict for the Celery message body."""
        return self.model_dump(mode="json")


def describe_validation_error(exc: ValidationError) -> str:
    """`loc: type` pairs without input values; unsafe location parts become `<key>`."""
    parts: list[str] = []
    for error in exc.errors(include_input=False, include_url=False, include_context=False):
        loc = ".".join(
            str(p) if isinstance(p, int) or _SAFE_LOC.match(str(p)) else "<key>"
            for p in error["loc"]
        )
        parts.append(f"{loc or '<root>'}: {error['type']}")
    return "; ".join(parts[:10])


def parse_envelope(raw: object) -> JobEnvelope:
    if isinstance(raw, JobEnvelope):
        return raw
    if not isinstance(raw, Mapping):
        raise InvalidEnvelopeError(f"expected an object, got {type(raw).__name__}")
    try:
        return JobEnvelope.model_validate(dict(raw))
    except ValidationError as exc:
        raise InvalidEnvelopeError(describe_validation_error(exc)) from None
