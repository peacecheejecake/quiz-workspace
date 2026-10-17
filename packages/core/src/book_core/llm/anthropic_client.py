"""Anthropic Messages API implementation of :class:`LLMClient` (structured outputs over HTTP).

Needs the ``llm`` extra (``httpx``); build it through ``create_llm_client`` only when an LLM is
configured. It talks to ``POST /v1/messages`` directly instead of using the official SDK: the
SDK pulls in ``httpx2`` (which switches Starlette's TestClient in apps/api) and logs complete
request bodies, i.e. question/book text, at DEBUG.

- Structured output: ``output_config.format`` with the JSON schema of the requested Pydantic
  model, reduced to the subset the API accepts (``strict_json_schema``). Every response is
  validated again client-side with :func:`parse_structured_output`.
- Thinking is left at the model default (never sent as disabled); ``effort`` is optional.
- Retries: connection errors, timeouts, 408/409/429/5xx and ``x-should-retry: true``, with
  exponential backoff (0.5 s doubling, max 8 s, jitter) or the server's ``retry-after(-ms)``.
- Logs carry metadata only (task, prompt version, model, fingerprint, tokens, latency, status);
  errors carry status, error type and request id, never prompt, output or error-body text.
"""

from __future__ import annotations

import json
import logging
import random
import time
from collections.abc import Callable
from typing import Any

import httpx
from pydantic import BaseModel

from book_core.llm.base import (
    LLMCallInfo,
    LLMOutputError,
    LLMProviderError,
    LLMRequest,
    LLMResult,
    LLMUsage,
    parse_structured_output,
)
from book_core.llm.config import LLMConfig

logger = logging.getLogger("book_core.llm")

DEFAULT_BASE_URL = "https://api.anthropic.com"
API_VERSION = "2023-06-01"
INITIAL_RETRY_DELAY = 0.5
MAX_RETRY_DELAY = 8.0
MAX_RETRY_AFTER = 60.0
_RETRY_STATUS = frozenset({408, 409, 429})

# JSON Schema keywords the structured-output API rejects; pydantic emits them for constrained
# fields. They are still enforced by the client-side validation.
_UNSUPPORTED_KEYWORDS = frozenset(
    {
        "minLength",
        "maxLength",
        "pattern",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "maxItems",
        "uniqueItems",
        "minProperties",
        "maxProperties",
        "default",
    }
)


def strict_json_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """The model's JSON schema with ``additionalProperties: false`` on every object and the
    keywords the API does not support removed (``minItems`` > 1 is dropped too)."""

    def clean(node: Any) -> Any:
        if isinstance(node, list):
            return [clean(item) for item in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in _UNSUPPORTED_KEYWORDS:
                continue
            if key == "minItems" and isinstance(value, int) and value > 1:
                continue
            if key in ("properties", "$defs"):
                out[key] = {name: clean(sub) for name, sub in value.items()}
            else:
                out[key] = clean(value)
        if out.get("type") == "object" or "properties" in out:
            out["additionalProperties"] = False
        return out

    result: dict[str, Any] = clean(schema.model_json_schema())
    return result


class AnthropicLLMClient:
    """``LLMClient`` over the Anthropic Messages API with a JSON-schema output format.

    ``transport`` injects an ``httpx`` transport (tests use ``httpx.MockTransport``); ``sleep``
    and ``rng`` make retry backoff testable.
    """

    def __init__(
        self,
        config: LLMConfig,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rng: random.Random | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._sleep = sleep
        self._rng = rng or random.Random()  # noqa: S311 (backoff jitter, not security)
        self._clock = clock
        self._http = httpx.Client(
            base_url=config.base_url or DEFAULT_BASE_URL,
            timeout=config.timeout_seconds,
            transport=transport,
            headers={
                "x-api-key": config.api_key.get_secret_value(),
                "anthropic-version": API_VERSION,
                "content-type": "application/json",
            },
        )

    @property
    def model_name(self) -> str:
        return self._config.model

    def close(self) -> None:
        self._http.close()

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        fingerprint = request.fingerprint()
        started = self._clock()
        body = self._post(request, schema)
        latency_ms = max(0, round((self._clock() - started) * 1000))

        raw_usage = body.get("usage") or {}
        usage = LLMUsage(
            input_tokens=int(raw_usage.get("input_tokens") or 0),
            output_tokens=int(raw_usage.get("output_tokens") or 0),
            cache_read_input_tokens=int(raw_usage.get("cache_read_input_tokens") or 0),
            cache_creation_input_tokens=int(raw_usage.get("cache_creation_input_tokens") or 0),
        )
        if self._config.pricing is not None:
            usage = usage.model_copy(update={"cost_usd": self._config.pricing.cost_usd(usage)})
        stop_reason = body.get("stop_reason")
        message_id = body.get("id")
        info = LLMCallInfo(
            task=request.task,
            prompt_version=request.prompt_version,
            model=str(body.get("model") or self._config.model),
            request_fingerprint=fingerprint,
            usage=usage,
            stop_reason=stop_reason if isinstance(stop_reason, str) else None,
            provider_request_id=message_id if isinstance(message_id, str) else None,
            latency_ms=latency_ms,
        )
        logger.info(
            "llm call task=%s prompt_version=%s model=%s fingerprint=%s stop=%s "
            "input_tokens=%d output_tokens=%d latency_ms=%d",
            info.task,
            info.prompt_version,
            info.model,
            fingerprint[:12],
            info.stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            latency_ms,
        )

        if info.stop_reason == "refusal":
            raise LLMProviderError(
                "provider declined the request (stop_reason=refusal)",
                kind="refusal",
                provider_request_id=info.provider_request_id,
            )
        if info.stop_reason == "max_tokens":
            raise LLMProviderError(
                "output truncated (stop_reason=max_tokens)",
                kind="max_tokens",
                provider_request_id=info.provider_request_id,
            )
        content = body.get("content")
        blocks = content if isinstance(content, list) else []
        raw = "".join(
            str(b.get("text", ""))
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "text"
        )
        try:
            output = parse_structured_output(raw, schema)
        except LLMOutputError as exc:
            exc.call_info = info
            raise
        return LLMResult(output=output, info=info)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output

    # --------------------------------------------------------------------------------------

    def _payload(self, request: LLMRequest, schema: type[BaseModel]) -> dict[str, Any]:
        output_config: dict[str, Any] = {
            "format": {"type": "json_schema", "schema": strict_json_schema(schema)}
        }
        if self._config.effort is not None:
            output_config["effort"] = self._config.effort
        payload: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": self._config.max_tokens,
            "messages": [{"role": "user", "content": request.prompt}],
            "output_config": output_config,
        }
        if request.system is not None:
            payload["system"] = request.system
        return payload

    def _post(self, request: LLMRequest, schema: type[BaseModel]) -> dict[str, Any]:
        content = json.dumps(self._payload(request, schema), ensure_ascii=False).encode()
        attempt = 0
        while True:
            response: httpx.Response | None = None
            error: LLMProviderError
            try:
                response = self._http.post("/v1/messages", content=content)
            except httpx.TimeoutException:
                error = LLMProviderError("provider request timed out", kind="timeout")
            except httpx.TransportError:
                error = LLMProviderError("could not reach the provider", kind="connection")
            else:
                if response.is_success:
                    return self._json(response)
                error = self._status_error(response)

            retryable = response is None or self._should_retry(response)
            if not retryable or attempt >= self._config.max_retries:
                logger.warning(
                    "llm call failed task=%s prompt_version=%s model=%s kind=%s status=%s "
                    "attempts=%d",
                    request.task,
                    request.prompt_version,
                    self._config.model,
                    error.kind,
                    error.status_code,
                    attempt + 1,
                )
                raise error
            delay = self._retry_delay(attempt, response)
            logger.info(
                "llm call retry task=%s kind=%s status=%s attempt=%d delay=%.2fs",
                request.task,
                error.kind,
                error.status_code,
                attempt + 1,
                delay,
            )
            self._sleep(delay)
            attempt += 1

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise LLMProviderError(
                "provider returned a non-JSON response",
                kind="bad_response",
                status_code=response.status_code,
                provider_request_id=response.headers.get("request-id"),
            )
        return body

    @staticmethod
    def _status_error(response: httpx.Response) -> LLMProviderError:
        error_type = None
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            candidate = body["error"].get("type")
            # Only a short identifier-like type is kept; error messages may echo the input.
            if isinstance(candidate, str) and candidate.isidentifier() and len(candidate) <= 64:
                error_type = candidate
        suffix = f" ({error_type})" if error_type else ""
        return LLMProviderError(
            f"provider returned HTTP {response.status_code}{suffix}",
            kind="http_status",
            status_code=response.status_code,
            provider_request_id=response.headers.get("request-id"),
        )

    @staticmethod
    def _should_retry(response: httpx.Response) -> bool:
        should = response.headers.get("x-should-retry")
        if should == "true":
            return True
        if should == "false":
            return False
        return response.status_code in _RETRY_STATUS or response.status_code >= 500

    def _retry_delay(self, attempt: int, response: httpx.Response | None) -> float:
        if response is not None:
            for header, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
                value = response.headers.get(header)
                try:
                    seconds = float(value) * scale if value is not None else None
                except ValueError:
                    seconds = None
                if seconds is not None and 0 < seconds <= MAX_RETRY_AFTER:
                    return seconds
        base = min(INITIAL_RETRY_DELAY * 2.0**attempt, MAX_RETRY_DELAY)
        return base * (1 - 0.25 * self._rng.random())
