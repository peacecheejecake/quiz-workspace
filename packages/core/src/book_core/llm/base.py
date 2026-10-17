from __future__ import annotations

import hashlib
import re
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ValidationError

from book_core.contracts.common import CoreModel, Identifier, NonEmptyText


class LLMRequest(CoreModel):
    """A structured-output request. ``task`` names the caller (e.g. ``questions.extract``)."""

    task: Identifier
    prompt_version: NonEmptyText
    prompt: NonEmptyText
    system: str | None = None

    def fingerprint(self) -> str:
        """Stable SHA-256 of the request, independent of process and hash seed."""
        return hashlib.sha256(self.model_dump_json().encode("utf-8")).hexdigest()


class LLMOutputError(Exception):
    """The model's output did not conform to the requested schema.

    The message, ``args`` and ``repr`` carry only a sanitised ``detail`` (error locations and
    types, never input values), so the error is safe to log. The unvalidated output, which may
    quote book text, is kept in ``raw_output`` for controlled handling only (e.g. storing it on
    the draft's validation record); never log it.
    """

    def __init__(self, schema: type[BaseModel], raw_output: str, detail: str) -> None:
        super().__init__(f"LLM output does not match {schema.__name__}: {detail}")
        self.schema = schema
        self.raw_output = raw_output
        self.detail = detail

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.args[0]!r})"


_SAFE_LOC_PART = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _safe_loc_part(part: int | str) -> str:
    # Locations can contain keys taken from the model's output (e.g. a forbidden extra key);
    # only identifier-like keys are kept so arbitrary text never reaches the message.
    if isinstance(part, int) or _SAFE_LOC_PART.match(part):
        return str(part)
    return "<key>"


def sanitize_validation_error(exc: ValidationError) -> str:
    """Summarise a ValidationError as ``loc: type`` pairs, without input values or context."""
    parts = []
    for error in exc.errors(include_url=False, include_context=False, include_input=False):
        loc = ".".join(_safe_loc_part(p) for p in error["loc"]) or "<root>"
        parts.append(f"{loc}: {error['type']}")
    return f"{exc.error_count()} validation error(s): " + "; ".join(parts)


def parse_structured_output[T: BaseModel](raw_output: str, schema: type[T]) -> T:
    """Validate raw JSON text against ``schema``; every client uses this so behaviour matches.

    Raises :class:`LLMOutputError` ``from None`` so pydantic's unsanitised error, which quotes
    the rejected input, is not chained into tracebacks.
    """
    try:
        return schema.model_validate_json(raw_output)
    except ValidationError as exc:
        detail = sanitize_validation_error(exc)
    raise LLMOutputError(schema, raw_output, detail) from None


@runtime_checkable
class LLMClient(Protocol):
    """Provider-agnostic LLM client returning schema-validated structured output.

    ``generate`` raises :class:`LLMOutputError` when the output does not match ``schema``. The
    returned model is only schema-valid; semantic checks (answer count, sources) are done by the
    caller (questions.md §5: the LLM's declared answer is never trusted).
    """

    @property
    def model_name(self) -> str: ...

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T: ...
