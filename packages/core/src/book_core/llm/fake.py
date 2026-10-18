from __future__ import annotations

import json
from collections.abc import Mapping

from pydantic import BaseModel

from book_core.llm.base import (
    LLMCallInfo,
    LLMProviderError,
    LLMRequest,
    LLMResult,
    LLMUsage,
    parse_structured_output,
)

FakeLLMResponse = BaseModel | Mapping[str, object] | str | LLMProviderError
"""A scripted response: a model or mapping is serialised to JSON; a string is returned verbatim
as raw output, which is how tests inject malformed or schema-invalid output; an
``LLMProviderError`` is raised, which is how tests inject provider failures."""


class FakeLLMNotScriptedError(LookupError):
    pass


class FakeLLMClient:
    """Scripted, deterministic LLM client (no network).

    Responses are looked up by exact request (``LLMRequest.fingerprint()``) first, then by
    ``task``. Unscripted requests raise :class:`FakeLLMNotScriptedError` so tests never pass on an
    accidental default. Every request is recorded in ``calls``. Usage is a deterministic estimate
    (UTF-8 bytes / 4) so token accounting can be tested.
    """

    def __init__(self, model_name: str = "fake-llm") -> None:
        self._model_name = model_name
        self._by_fingerprint: dict[str, str | LLMProviderError] = {}
        self._by_task: dict[str, str | LLMProviderError] = {}
        self.calls: list[LLMRequest] = []

    @property
    def model_name(self) -> str:
        return self._model_name

    def script(self, match: LLMRequest | str, response: FakeLLMResponse) -> None:
        """Register ``response`` for an exact request or for every request of a task name."""
        raw = response if isinstance(response, LLMProviderError) else _to_raw(response)
        if isinstance(match, LLMRequest):
            self._by_fingerprint[match.fingerprint()] = raw
        else:
            self._by_task[match] = raw

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        self.calls.append(request)
        raw = self._by_fingerprint.get(request.fingerprint())
        if raw is None:
            raw = self._by_task.get(request.task)
        if raw is None:
            raise FakeLLMNotScriptedError(f"no scripted response for task {request.task!r}")
        if isinstance(raw, LLMProviderError):
            raise raw
        output = parse_structured_output(raw, schema)
        prompt_bytes = len(request.prompt.encode()) + len((request.system or "").encode())
        info = LLMCallInfo(
            task=request.task,
            prompt_version=request.prompt_version,
            model=self._model_name,
            request_fingerprint=request.fingerprint(),
            usage=LLMUsage(
                input_tokens=-(-prompt_bytes // 4), output_tokens=-(-len(raw.encode()) // 4)
            ),
            stop_reason="end_turn",
        )
        return LLMResult(output=output, info=info)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


def _to_raw(response: BaseModel | Mapping[str, object] | str) -> str:
    if isinstance(response, BaseModel):
        return response.model_dump_json()
    if isinstance(response, str):
        return response
    return json.dumps(dict(response), ensure_ascii=False, sort_keys=True)
