"""Provider-agnostic LLM adapter with structured outputs (M4.3). Real providers use ``llm``."""

from book_core.llm.base import LLMClient, LLMOutputError, LLMRequest, parse_structured_output
from book_core.llm.fake import FakeLLMClient, FakeLLMNotScriptedError, FakeLLMResponse

__all__ = [
    "FakeLLMClient",
    "FakeLLMNotScriptedError",
    "FakeLLMResponse",
    "LLMClient",
    "LLMOutputError",
    "LLMRequest",
    "parse_structured_output",
]
