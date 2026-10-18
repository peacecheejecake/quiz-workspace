from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Annotated, Protocol, get_args, runtime_checkable

from pydantic import BaseModel, Field, ValidationError

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


class LLMUsage(CoreModel):
    """Token accounting of one call. ``cost_usd`` is set only when the client has pricing."""

    input_tokens: Annotated[int, Field(ge=0)] = 0
    output_tokens: Annotated[int, Field(ge=0)] = 0
    cache_read_input_tokens: Annotated[int, Field(ge=0)] = 0
    cache_creation_input_tokens: Annotated[int, Field(ge=0)] = 0
    cost_usd: Annotated[float, Field(ge=0)] | None = None

    def __add__(self, other: LLMUsage) -> LLMUsage:
        cost = (
            None
            if self.cost_usd is None and other.cost_usd is None
            else (self.cost_usd or 0.0) + (other.cost_usd or 0.0)
        )
        return LLMUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_input_tokens=self.cache_read_input_tokens + other.cache_read_input_tokens,
            cache_creation_input_tokens=(
                self.cache_creation_input_tokens + other.cache_creation_input_tokens
            ),
            cost_usd=cost,
        )


class LLMCallInfo(CoreModel):
    """Provenance of one call: what produced an output (questions.md §5: model + prompt version).

    Carries no prompt or output text, so it is safe to log and to store on drafts and runs.
    """

    task: Identifier
    prompt_version: NonEmptyText
    model: NonEmptyText
    request_fingerprint: NonEmptyText
    usage: LLMUsage = LLMUsage()
    stop_reason: str | None = None
    provider_request_id: str | None = None
    latency_ms: Annotated[int, Field(ge=0)] | None = None


@dataclass(frozen=True, slots=True)
class LLMResult[T: BaseModel]:
    """A schema-validated output plus its call provenance."""

    output: T
    info: LLMCallInfo


class LLMProviderError(Exception):
    """The provider call failed (transport, HTTP status, refusal, truncation) after retries.

    Like :class:`LLMOutputError`, the message is built only from metadata (status code, error
    type, provider request id, stop reason), never from prompt, output or provider error bodies,
    so it is safe to log.
    """

    def __init__(
        self,
        message: str,
        *,
        kind: str,
        status_code: int | None = None,
        provider_request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code
        self.provider_request_id = provider_request_id

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.args[0]!r})"


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
        self.call_info: LLMCallInfo | None = None
        """Provenance and usage of the call that produced the output, when a client knows it."""

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

    ``complete`` returns the output with its call provenance (model, prompt version, tokens);
    ``generate`` returns the output only. Both raise :class:`LLMOutputError` when the output does
    not match ``schema`` and :class:`LLMProviderError` when the call itself fails. The returned
    model is only schema-valid; semantic checks (answer count, sources) are done by the caller
    (questions.md §5: the LLM's declared answer is never trusted).
    """

    @property
    def model_name(self) -> str: ...

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]: ...

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T: ...
