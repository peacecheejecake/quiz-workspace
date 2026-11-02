"""Anthropic Messages API streaming (``"stream": true``) as a :class:`TextStreamClient`.

Needs the ``llm`` extra (``httpx``). Like ``AnthropicLLMClient`` it talks to ``POST /v1/messages``
directly (no SDK, which logs request bodies at DEBUG). Text arrives as ``content_block_delta``
events with a ``text_delta``; thinking blocks are never forwarded. ``message_start`` carries the
input/cache token counts and ``message_delta`` the stop reason and output tokens.

No retries here (see ``book_core.llm.streaming``): a failure before or during the stream raises
:class:`LLMProviderError` (kinds ``timeout``, ``connection``, ``http_status``, ``stream_error``,
``bad_response``, ``refusal``) whose message holds status codes, error types and the request id
only. Logs carry metadata (task, prompt version, model, tokens, latency, stop reason).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx

from book_core.llm.anthropic_client import API_VERSION, DEFAULT_BASE_URL, AnthropicLLMClient
from book_core.llm.base import LLMProviderError, LLMUsage
from book_core.llm.config import LLMConfig
from book_core.llm.streaming import (
    TextDelta,
    TextStreamEnd,
    TextStreamEvent,
    TextStreamRequest,
)

logger = logging.getLogger("book_core.llm")


class AnthropicTextStreamClient:
    """Streams one Messages API call. ``transport`` injects an ``httpx`` transport in tests."""

    def __init__(
        self,
        config: LLMConfig,
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._clock = clock
        self._http = httpx.Client(
            base_url=config.base_url or DEFAULT_BASE_URL,
            timeout=config.timeout_seconds,
            transport=transport,
            headers={
                "x-api-key": config.api_key.get_secret_value(),
                "anthropic-version": API_VERSION,
                "content-type": "application/json",
                "accept": "text/event-stream",
            },
        )

    @property
    def model_name(self) -> str:
        return self._config.model

    def close(self) -> None:
        self._http.close()

    def payload(self, request: TextStreamRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": request.max_tokens,
            "stream": True,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
        }
        if request.system:
            body["system"] = request.system
        effort = request.effort or self._config.effort
        if effort is not None:
            body["output_config"] = {"effort": effort}
        return body

    def stream_text(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]:
        return self._stream(request)

    def _stream(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]:
        content = json.dumps(self.payload(request), ensure_ascii=False).encode()
        started = self._clock()
        try:
            with self._http.stream("POST", "/v1/messages", content=content) as response:
                if not response.is_success:
                    response.read()
                    raise AnthropicLLMClient._status_error(response)
                yield from self._events(request, response, started)
        except httpx.TimeoutException:
            self._log_failure(request, "timeout")
            raise LLMProviderError("provider request timed out", kind="timeout") from None
        except httpx.TransportError:
            self._log_failure(request, "connection")
            raise LLMProviderError("could not reach the provider", kind="connection") from None
        except LLMProviderError as exc:
            self._log_failure(request, exc.kind, exc.status_code)
            raise

    def _events(
        self, request: TextStreamRequest, response: httpx.Response, started: float
    ) -> Iterator[TextStreamEvent]:
        request_id = response.headers.get("request-id")
        model = self._config.model
        usage = LLMUsage()
        stop_reason: str | None = None
        for data in _sse_data(response.iter_lines()):
            try:
                event = json.loads(data)
            except ValueError:
                raise LLMProviderError(
                    "provider sent an unreadable stream event",
                    kind="bad_response",
                    provider_request_id=request_id,
                ) from None
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if kind == "message_start":
                raw_message = event.get("message")
                message: dict[str, Any] = raw_message if isinstance(raw_message, dict) else {}
                model = str(message.get("model") or model)
                if isinstance(message.get("id"), str):
                    request_id = message["id"]
                usage = _merge_usage(usage, message.get("usage"))
            elif kind == "content_block_delta":
                delta = event.get("delta")
                if isinstance(delta, dict) and delta.get("type") == "text_delta":
                    text = delta.get("text")
                    if isinstance(text, str) and text:
                        yield TextDelta(text)
            elif kind == "message_delta":
                delta = event.get("delta")
                if isinstance(delta, dict) and isinstance(delta.get("stop_reason"), str):
                    stop_reason = delta["stop_reason"]
                usage = _merge_usage(usage, event.get("usage"))
            elif kind == "error":
                raw_error = event.get("error")
                error: dict[str, Any] = raw_error if isinstance(raw_error, dict) else {}
                error_type = error.get("type")
                suffix = (
                    f" ({error_type})"
                    if isinstance(error_type, str) and error_type.isidentifier()
                    else ""
                )
                raise LLMProviderError(
                    f"provider stream failed{suffix}",
                    kind="stream_error",
                    provider_request_id=request_id,
                )
            elif kind == "message_stop":
                break
        if self._config.pricing is not None:
            usage = usage.model_copy(update={"cost_usd": self._config.pricing.cost_usd(usage)})
        latency_ms = max(0, round((self._clock() - started) * 1000))
        logger.info(
            "llm stream task=%s prompt_version=%s model=%s stop=%s input_tokens=%d "
            "output_tokens=%d latency_ms=%d",
            request.task,
            request.prompt_version,
            model,
            stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            latency_ms,
        )
        if stop_reason == "refusal":
            raise LLMProviderError(
                "provider declined the request (stop_reason=refusal)",
                kind="refusal",
                provider_request_id=request_id,
            )
        yield TextStreamEnd(
            model=model, stop_reason=stop_reason, usage=usage, provider_request_id=request_id
        )

    def _log_failure(
        self, request: TextStreamRequest, kind: str, status: int | None = None
    ) -> None:
        logger.warning(
            "llm stream failed task=%s prompt_version=%s model=%s kind=%s status=%s",
            request.task,
            request.prompt_version,
            self._config.model,
            kind,
            status,
        )


def _sse_data(lines: Iterator[str]) -> Iterator[str]:
    """The `data:` payload of every server-sent event (multi-line data joined by newlines)."""
    data: list[str] = []
    for line in lines:
        if not line:
            if data:
                yield "\n".join(data)
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield "\n".join(data)


def _merge_usage(usage: LLMUsage, raw: Any) -> LLMUsage:
    if not isinstance(raw, dict):
        return usage

    def count(name: str, current: int) -> int:
        value = raw.get(name)
        return int(value) if isinstance(value, int) and value >= 0 else current

    return LLMUsage(
        input_tokens=count("input_tokens", usage.input_tokens),
        output_tokens=count("output_tokens", usage.output_tokens),
        cache_read_input_tokens=count("cache_read_input_tokens", usage.cache_read_input_tokens),
        cache_creation_input_tokens=count(
            "cache_creation_input_tokens", usage.cache_creation_input_tokens
        ),
    )
