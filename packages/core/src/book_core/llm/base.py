from __future__ import annotations

import hashlib
from typing import Protocol, get_args, runtime_checkable

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


def _schema_field_names(schema: type[BaseModel]) -> frozenset[str]:
    """Every field name and alias declared by ``schema`` and the models nested in it.

    Error locations keep a string part only when it is schema-owned; any other string (an extra
    key, a dict key, a union tag) may have come from the model's output.
    """
    names: set[str] = set()
    seen: set[type[BaseModel]] = set()
    pending: list[object] = [schema]
    while pending:
        annotation = pending.pop()
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            if annotation in seen:
                continue
            seen.add(annotation)
            for name, field in annotation.model_fields.items():
                names.add(name)
                names.update(a for a in (field.alias, field.validation_alias) if isinstance(a, str))
                pending.append(field.annotation)
        else:
            pending.extend(get_args(annotation))
    return frozenset(names)


def sanitize_validation_error(exc: ValidationError, schema: type[BaseModel]) -> str:
    """Summarise a ValidationError as ``loc: type`` pairs, without input values or context.

    Location parts that are neither list indices nor field names of ``schema`` become ``<key>``.
    """
    allowed = _schema_field_names(schema)
    parts = []
    for error in exc.errors(include_url=False, include_context=False, include_input=False):
        loc = ".".join(
            str(p) if isinstance(p, int) or p in allowed else "<key>" for p in error["loc"]
        )
        parts.append(f"{loc or '<root>'}: {error['type']}")
    return f"{exc.error_count()} validation error(s): " + "; ".join(parts)


def parse_structured_output[T: BaseModel](raw_output: str, schema: type[T]) -> T:
    """Validate raw JSON text against ``schema``; every client uses this so behaviour matches.

    Raises :class:`LLMOutputError` ``from None`` so pydantic's unsanitised error, which quotes
    the rejected input, is not chained into tracebacks.
    """
    try:
        return schema.model_validate_json(raw_output)
    except ValidationError as exc:
        detail = sanitize_validation_error(exc, schema)
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
