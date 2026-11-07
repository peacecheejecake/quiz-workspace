"""Provider-agnostic LLM adapter with structured outputs (M4.3).

``FakeLLMClient`` is the deterministic stand-in for tests and E2E. Plain-text streaming (ASK-B)
is ``TextStreamClient.stream_text`` (``book_core.llm.streaming``). The real provider client
(``AnthropicLLMClient`` in ``book_core.llm.anthropic_client``) needs the ``llm`` extra and is
built only through ``create_llm_client(LLMConfig.from_env())`` when ``LLM_API_KEY`` is set; it is
not imported here so installs without the extra never import the SDK.
"""

from book_core.llm.base import (
    LLMCallInfo,
    LLMClient,
    LLMOutputError,
    LLMProviderError,
    LLMRequest,
    LLMResult,
    LLMUsage,
    parse_structured_output,
)
from book_core.llm.config import (
    LLMConfig,
    LLMConfigError,
    LLMPricing,
    LLMProvider,
    create_llm_client,
    route_effort,
)
from book_core.llm.fake import FakeLLMClient, FakeLLMNotScriptedError, FakeLLMResponse
from book_core.llm.streaming import (
    FakeTextStreamClient,
    TextDelta,
    TextMessage,
    TextStreamClient,
    TextStreamEnd,
    TextStreamEvent,
    TextStreamRequest,
    TextStreamUsage,
    create_text_stream_client,
)

__all__ = [
    "FakeLLMClient",
    "FakeLLMNotScriptedError",
    "FakeLLMResponse",
    "FakeTextStreamClient",
    "LLMCallInfo",
    "LLMClient",
    "LLMConfig",
    "LLMConfigError",
    "LLMOutputError",
    "LLMPricing",
    "LLMProvider",
    "LLMProviderError",
    "LLMRequest",
    "LLMResult",
    "LLMUsage",
    "TextDelta",
    "TextMessage",
    "TextStreamClient",
    "TextStreamEnd",
    "TextStreamEvent",
    "TextStreamRequest",
    "TextStreamUsage",
    "create_llm_client",
    "create_text_stream_client",
    "parse_structured_output",
    "route_effort",
]
