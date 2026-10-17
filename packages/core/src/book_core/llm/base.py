from __future__ import annotations

import hashlib
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

    Callers keep ``raw_output`` to report a validation failure on the draft instead of crashing.
    """

    def __init__(self, schema: type[BaseModel], raw_output: str, detail: str) -> None:
        super().__init__(f"LLM output does not match {schema.__name__}: {detail}")
        self.schema = schema
        self.raw_output = raw_output
        self.detail = detail


def parse_structured_output[T: BaseModel](raw_output: str, schema: type[T]) -> T:
    """Validate raw JSON text against ``schema``; every client uses this so behaviour matches."""
    try:
        return schema.model_validate_json(raw_output)
    except ValidationError as exc:
        raise LLMOutputError(schema, raw_output, str(exc)) from exc


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
