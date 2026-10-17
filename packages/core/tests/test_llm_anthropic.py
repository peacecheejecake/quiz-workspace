"""AnthropicLLMClient against a mock HTTP transport (no network) and LLMConfig (M4.3)."""

from __future__ import annotations

import json
import logging
import random
import traceback
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from book_core.extractor import LLMQuestion
from book_core.llm import (
    LLMClient,
    LLMConfig,
    LLMConfigError,
    LLMOutputError,
    LLMPricing,
    LLMProviderError,
    LLMRequest,
    LLMUsage,
    create_llm_client,
)
from book_core.llm.anthropic_client import AnthropicLLMClient, strict_json_schema
from pydantic import BaseModel, ConfigDict, Field, SecretStr

SECRET_KEY = "sk-test-SECRET-KEY-0000"  # noqa: S105 (fake key for a mock transport)
BOOK_TEXT = "PRIVATE BOOK PASSAGE 비공개 본문"
REQUEST = LLMRequest(
    task="questions.extract",
    prompt_version="questions.extract/v1",
    system="system rules",
    prompt=f"QUESTION: {BOOK_TEXT}",
)


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stem: str
    option_count: int


Handler = Callable[[httpx.Request], httpx.Response]


def _message(text: str, *, stop_reason: str = "end_turn", **usage: int) -> dict[str, Any]:
    return {
        "id": "msg_test_1",
        "type": "message",
        "role": "assistant",
        "model": "test-model",
        "content": [
            {"type": "thinking", "thinking": "", "signature": "sig"},
            {"type": "text", "text": text},
        ],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 1200, "output_tokens": 300, **usage},
    }


def _client(
    handler: Handler, *, max_retries: int = 0, **config: Any
) -> tuple[AnthropicLLMClient, list[httpx.Request], list[float]]:
    seen: list[httpx.Request] = []
    sleeps: list[float] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    cfg = LLMConfig(
        api_key=SecretStr(SECRET_KEY), model="test-model", max_retries=max_retries, **config
    )
    client = AnthropicLLMClient(
        cfg,
        transport=httpx.MockTransport(record),
        sleep=sleeps.append,
        rng=random.Random(0),  # noqa: S311
    )
    return client, seen, sleeps


def _ok(text: str = '{"stem": "Q?", "option_count": 4}', **kw: Any) -> Handler:
    return lambda _req: httpx.Response(200, json=_message(text, **kw))


def test_sends_structured_output_request_and_returns_validated_model() -> None:
    client, seen, _ = _client(_ok(), effort="low")
    assert isinstance(client, LLMClient)

    result = client.complete(REQUEST, _Out)

    assert result.output == _Out(stem="Q?", option_count=4)
    (sent,) = seen
    assert sent.method == "POST"
    assert sent.url == "https://api.anthropic.com/v1/messages"
    assert sent.headers["x-api-key"] == SECRET_KEY
    assert sent.headers["anthropic-version"] == "2023-06-01"
    body = json.loads(sent.content)
    assert body["model"] == "test-model"
    assert body["max_tokens"] == 16000
    assert body["system"] == "system rules"
    assert body["messages"] == [{"role": "user", "content": REQUEST.prompt}]
    assert body["output_config"]["effort"] == "low"
    fmt = body["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    assert fmt["schema"]["additionalProperties"] is False
    assert set(fmt["schema"]["required"]) == {"stem", "option_count"}
    assert "thinking" not in body  # model default; never sent as disabled


def test_base_url_override() -> None:
    client, seen, _ = _client(_ok(), base_url="https://gateway.example.test/anthropic")
    client.complete(REQUEST, _Out)
    assert seen[0].url == "https://gateway.example.test/anthropic/v1/messages"


def test_records_provenance_usage_and_cost() -> None:
    pricing = LLMPricing(input_usd_per_mtok=4.0, output_usd_per_mtok=20.0)
    client, _, _ = _client(_ok(cache_read_input_tokens=1000), pricing=pricing)

    info = client.complete(REQUEST, _Out).info

    assert info.model == "test-model"
    assert info.prompt_version == "questions.extract/v1"
    assert info.task == "questions.extract"
    assert info.request_fingerprint == REQUEST.fingerprint()
    assert info.provider_request_id == "msg_test_1"
    assert info.stop_reason == "end_turn"
    assert info.usage.input_tokens == 1200
    assert info.usage.output_tokens == 300
    assert info.usage.cache_read_input_tokens == 1000
    # 1200*4 + 300*20 + 1000*4 (cache read defaults to the input price) per million tokens
    assert info.usage.cost_usd == pytest.approx((4800 + 6000 + 4000) / 1_000_000)
    assert info.latency_ms is not None


def test_generate_returns_output_only() -> None:
    client, _, _ = _client(_ok())
    assert client.generate(REQUEST, _Out).option_count == 4


def test_schema_invalid_output_is_sanitized_output_error_with_usage() -> None:
    client, _, _ = _client(_ok(json.dumps({"stem": BOOK_TEXT, "option_count": BOOK_TEXT})))
    with pytest.raises(LLMOutputError) as info:
        client.complete(REQUEST, _Out)
    err = info.value
    assert "PRIVATE" not in str(err)
    assert "option_count: int_parsing" in err.detail
    assert err.call_info is not None
    assert err.call_info.usage.output_tokens == 300


@pytest.mark.parametrize(("stop", "kind"), [("refusal", "refusal"), ("max_tokens", "max_tokens")])
def test_refusal_and_truncation_raise_provider_errors(stop: str, kind: str) -> None:
    client, _, _ = _client(_ok(stop_reason=stop))
    with pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    assert info.value.kind == kind


def test_non_json_success_body_is_provider_error() -> None:
    client, _, _ = _client(lambda _req: httpx.Response(200, text=f"<html>{BOOK_TEXT}</html>"))
    with pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    assert info.value.kind == "bad_response"
    assert "PRIVATE" not in str(info.value)


def test_http_error_is_sanitized(caplog: pytest.LogCaptureFixture) -> None:
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": BOOK_TEXT}}

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=body, headers={"request-id": "req_abc"})

    client, _, _ = _client(handler)
    with caplog.at_level(logging.DEBUG), pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    err = info.value
    assert err.kind == "http_status"
    assert err.status_code == 400
    assert err.provider_request_id == "req_abc"
    assert "invalid_request_error" in str(err)
    assert err.__cause__ is None
    rendered = "".join(traceback.format_exception(err))
    for text in (str(err), repr(err), rendered, caplog.text):
        assert "PRIVATE" not in text
        assert "비공개" not in text
        assert SECRET_KEY not in text


def test_error_type_that_is_not_an_identifier_is_dropped() -> None:
    body = {"type": "error", "error": {"type": BOOK_TEXT}}
    client, _, _ = _client(lambda _req: httpx.Response(400, json=body))
    with pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    assert str(info.value) == "provider returned HTTP 400"


def test_retries_rate_limits_honouring_retry_after_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(429, json={"type": "error"}, headers={"retry-after-ms": "1500"})
        return httpx.Response(200, json=_message('{"stem": "Q?", "option_count": 2}'))

    client, seen, sleeps = _client(handler, max_retries=2)
    assert client.generate(REQUEST, _Out).option_count == 2
    assert len(seen) == 3
    assert sleeps == [1.5, 1.5]


def test_server_errors_back_off_exponentially_and_give_up() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(529, json={"type": "error", "error": {"type": "overloaded_error"}})

    client, seen, sleeps = _client(handler, max_retries=3)
    with pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    assert info.value.status_code == 529
    assert "overloaded_error" in str(info.value)
    assert len(seen) == 4
    assert len(sleeps) == 3
    for attempt, delay in enumerate(sleeps):
        base = 0.5 * 2**attempt
        assert 0.75 * base <= delay <= base


def test_client_errors_are_not_retried() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        error = {"type": "error", "error": {"type": "authentication_error"}}
        return httpx.Response(401, json=error)

    client, seen, sleeps = _client(handler, max_retries=3)
    with pytest.raises(LLMProviderError):
        client.complete(REQUEST, _Out)
    assert len(seen) == 1
    assert sleeps == []


def test_timeouts_are_retried_and_connection_errors_surface() -> None:
    calls = {"n": 0}

    def flaky(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("slow", request=req)
        return httpx.Response(200, json=_message('{"stem": "Q?", "option_count": 2}'))

    client, seen, _ = _client(flaky, max_retries=1)
    assert client.generate(REQUEST, _Out).option_count == 2
    assert len(seen) == 2

    def down(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=req)

    client, seen, _ = _client(down, max_retries=1)
    with pytest.raises(LLMProviderError) as info:
        client.complete(REQUEST, _Out)
    assert info.value.kind == "connection"
    assert len(seen) == 2


def test_logs_metadata_never_prompt_or_output(caplog: pytest.LogCaptureFixture) -> None:
    client, _, _ = _client(_ok(json.dumps({"stem": BOOK_TEXT, "option_count": 1})))
    with caplog.at_level(logging.DEBUG):
        client.complete(REQUEST, _Out)
    assert "questions.extract/v1" in caplog.text
    assert "PRIVATE" not in caplog.text
    assert "비공개" not in caplog.text
    assert SECRET_KEY not in caplog.text


def test_strict_json_schema_closes_every_object_and_drops_unsupported_keywords() -> None:
    class _Constrained(BaseModel):
        name: str = Field(min_length=1, max_length=5)
        count: int = Field(ge=0, le=9)
        tags: list[str] = Field(min_length=2)

    schema = strict_json_schema(_Constrained)
    text = json.dumps(schema)
    for keyword in ("minLength", "maxLength", "minimum", "maximum", "minItems", "default"):
        assert keyword not in text
    assert schema["additionalProperties"] is False

    question = strict_json_schema(LLMQuestion)
    objects = [question, *question["$defs"].values()]
    assert all(o["additionalProperties"] is False for o in objects)
    assert set(question["required"]) == set(LLMQuestion.model_fields)


# ------------------------------------------------------------------------------------------
# LLMConfig


def test_config_disabled_without_api_key() -> None:
    assert LLMConfig.from_env({}) is None
    assert LLMConfig.from_env({"LLM_API_KEY": "  ", "LLM_MODEL": "m"}) is None


def test_config_requires_explicit_model() -> None:
    with pytest.raises(LLMConfigError, match="LLM_MODEL"):
        LLMConfig.from_env({"LLM_API_KEY": SECRET_KEY})


def test_config_reads_all_settings_and_hides_key() -> None:
    config = LLMConfig.from_env(
        {
            "LLM_API_KEY": SECRET_KEY,
            "LLM_MODEL": "claude-opus-5-5",
            "LLM_TIMEOUT_SECONDS": "30",
            "LLM_MAX_RETRIES": "4",
            "LLM_MAX_TOKENS": "8000",
            "LLM_EFFORT": "medium",
            "LLM_BASE_URL": "https://gateway.example.test",
            "LLM_PRICE_INPUT_USD_PER_MTOK": "4",
            "LLM_PRICE_OUTPUT_USD_PER_MTOK": "20",
        }
    )
    assert config is not None
    assert config.model == "claude-opus-5-5"
    assert config.timeout_seconds == 30
    assert config.max_retries == 4
    assert config.max_tokens == 8000
    assert config.effort == "medium"
    assert config.base_url == "https://gateway.example.test"
    assert config.pricing == LLMPricing(input_usd_per_mtok=4, output_usd_per_mtok=20)
    assert SECRET_KEY not in repr(config)
    assert SECRET_KEY not in str(config.model_dump())


def test_config_errors_name_fields_not_values() -> None:
    with pytest.raises(LLMConfigError) as info:
        LLMConfig.from_env(
            {"LLM_API_KEY": SECRET_KEY, "LLM_MODEL": "m", "LLM_MAX_RETRIES": "SECRET-ish"}
        )
    assert "max_retries" in str(info.value)
    assert "SECRET" not in str(info.value)


def test_create_llm_client_builds_anthropic_client() -> None:
    client = create_llm_client(LLMConfig(api_key=SecretStr(SECRET_KEY), model="claude-opus-5-5"))
    assert isinstance(client, AnthropicLLMClient)
    assert client.model_name == "claude-opus-5-5"
    client.close()


def test_usage_adds_up() -> None:
    total = LLMUsage(input_tokens=1, output_tokens=2) + LLMUsage(
        input_tokens=3, output_tokens=4, cost_usd=0.5
    )
    assert total == LLMUsage(input_tokens=4, output_tokens=6, cost_usd=0.5)
