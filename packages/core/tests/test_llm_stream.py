"""book_core.llm streaming: the Anthropic SSE client (MockTransport) and the scripted fake."""

from __future__ import annotations

import json

import httpx
import pytest
from book_core.llm import (
    FakeTextStreamClient,
    LLMConfig,
    LLMProviderError,
    TextDelta,
    TextMessage,
    TextStreamEnd,
    TextStreamRequest,
    TextStreamUsage,
)
from book_core.llm.anthropic_stream import AnthropicTextStreamClient

SECRET_PROMPT = "PROMPT-SECRET-TEXT"  # noqa: S105 - a marker string
REQUEST = TextStreamRequest(
    task="ask.answer",
    prompt_version="v1",
    system="sys",
    messages=(TextMessage("user", SECRET_PROMPT),),
    max_tokens=300,
    effort="low",
)


def _sse(*events: dict[str, object]) -> bytes:
    return "".join(
        f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events
    ).encode()


def _client(handler: httpx.MockTransport) -> AnthropicTextStreamClient:
    config = LLMConfig(api_key="k", model="claude-test")  # type: ignore[arg-type]
    return AnthropicTextStreamClient(config, transport=handler)


def test_streams_text_deltas_then_usage_and_stop_reason() -> None:
    seen: list[dict[str, object]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        body = _sse(
            {
                "type": "message_start",
                "message": {"id": "msg_1", "model": "claude-test", "usage": {"input_tokens": 12}},
            },
            {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "x"}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "가나"}},
            {"type": "ping"},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "다"}},
            {
                "type": "message_delta",
                "delta": {"stop_reason": "max_tokens"},
                "usage": {"output_tokens": 7},
            },
            {"type": "message_stop"},
        )
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    events = list(_client(httpx.MockTransport(handle)).stream_text(REQUEST))
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["가나", "다"]
    first = events[0]
    assert isinstance(first, TextStreamUsage)  # known before the text: a stream closed early has it
    assert first.usage.input_tokens == 12
    end = events[-1]
    assert isinstance(end, TextStreamEnd)
    assert end.truncated
    assert (end.usage.input_tokens, end.usage.output_tokens) == (12, 7)
    assert seen[0]["stream"] is True
    assert seen[0]["max_tokens"] == 300
    assert seen[0]["output_config"] == {"effort": "low"}


@pytest.mark.parametrize(
    ("response", "kind"),
    [
        (
            httpx.Response(529, json={"error": {"type": "overloaded_error", "message": "x"}}),
            "http_status",
        ),
        (
            httpx.Response(
                200,
                content=_sse({"type": "error", "error": {"type": "api_error", "message": "boom"}}),
            ),
            "stream_error",
        ),
        (
            httpx.Response(
                200,
                content=_sse(
                    {"type": "message_delta", "delta": {"stop_reason": "refusal"}},
                    {"type": "message_stop"},
                ),
            ),
            "refusal",
        ),
    ],
)
def test_failures_carry_metadata_only(response: httpx.Response, kind: str) -> None:
    client = _client(httpx.MockTransport(lambda _r: response))
    with pytest.raises(LLMProviderError) as caught:
        list(client.stream_text(REQUEST))
    assert caught.value.kind == kind
    assert "boom" not in str(caught.value)
    assert SECRET_PROMPT not in str(caught.value)


def test_connection_errors_are_not_retried() -> None:
    calls = 0

    def handle(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("down")

    with pytest.raises(LLMProviderError) as caught:
        list(_client(httpx.MockTransport(handle)).stream_text(REQUEST))
    assert caught.value.kind == "connection"
    assert calls == 1


def test_fake_text_stream_client() -> None:
    fake = FakeTextStreamClient(["a", "b"])
    events = list(fake.stream_text(REQUEST))
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["a", "b"]
    assert fake.calls == [REQUEST]
    with pytest.raises(ValueError, match="ends with a user message"):
        TextStreamRequest("t", "v", "s", (TextMessage("assistant", "x"),), 1)


def test_a_stream_cut_before_message_stop_is_an_error_without_its_text() -> None:
    body = _sse(
        {"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 3}}},
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "PARTIAL-TEXT"}},
    )
    client = _client(httpx.MockTransport(lambda _r: httpx.Response(200, content=body)))
    events = client.stream_text(REQUEST)
    assert isinstance(next(events), TextStreamUsage)
    assert isinstance(next(events), TextDelta)
    with pytest.raises(LLMProviderError) as caught:
        list(events)
    assert caught.value.kind == "incomplete_stream"
    assert "PARTIAL-TEXT" not in str(caught.value)
