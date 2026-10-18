"""Provider-agnostic LLM adapter with structured outputs (M4.3).

``FakeLLMClient`` is the deterministic stand-in for tests and E2E. The real provider client
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
)
from book_core.llm.fake import FakeLLMClient, FakeLLMNotScriptedError, FakeLLMResponse

__all__ = [
    "FakeLLMClient",
    "FakeLLMNotScriptedError",
    "FakeLLMResponse",
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
    "create_llm_client",
    "parse_structured_output",
]
