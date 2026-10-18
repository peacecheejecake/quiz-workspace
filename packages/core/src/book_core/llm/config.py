"""LLM provider configuration (server-only, opt-in).

The LLM is optional (architecture.md §1): it is enabled only when ``LLM_API_KEY`` is set in the
worker's environment (deployment.md §6: server-only secret, never ``NEXT_PUBLIC_``). The model id
has no default; set ``LLM_MODEL`` explicitly, e.g. ``LLM_MODEL=claude-opus-5-5`` (placeholder,
pick the model the deployment is approved for).

Sending question/book text to an external provider has privacy and copyright implications
(deployment.md §6); deployments must enable it deliberately.

Environment variables:

- ``LLM_API_KEY``: provider API key. Unset or empty disables the LLM.
- ``LLM_MODEL``: provider model id (required when the key is set).
- ``LLM_PROVIDER``: ``anthropic`` (default, the only provider implemented).
- ``LLM_BASE_URL``: optional API base URL (proxy / gateway).
- ``LLM_TIMEOUT_SECONDS`` (default 120), ``LLM_MAX_RETRIES`` (default 2, exponential backoff on
  connection errors, 408/409/429 and 5xx), ``LLM_MAX_TOKENS`` (default 16000).
- ``LLM_EFFORT``: optional ``low|medium|high|xhigh|max``.
- ``LLM_PRICE_INPUT_USD_PER_MTOK`` / ``LLM_PRICE_OUTPUT_USD_PER_MTOK`` (optional, both or
  neither; plus optional ``LLM_PRICE_CACHE_READ_USD_PER_MTOK`` /
  ``LLM_PRICE_CACHE_WRITE_USD_PER_MTOK``): enables ``cost_usd`` in usage accounting.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Literal

from pydantic import Field, SecretStr, ValidationError

from book_core.contracts.common import CoreModel, NonEmptyText

if TYPE_CHECKING:
    from book_core.llm.base import LLMClient, LLMUsage

Effort = Literal["low", "medium", "high", "xhigh", "max"]
_PER_MTOK = 1_000_000


class LLMConfigError(ValueError):
    """The LLM configuration is incomplete or invalid. Messages name variables, never values."""


class LLMProvider(StrEnum):
    ANTHROPIC = "anthropic"


class LLMPricing(CoreModel):
    """USD per million tokens. Cache prices default to the input price when unknown."""

    input_usd_per_mtok: Annotated[float, Field(ge=0)]
    output_usd_per_mtok: Annotated[float, Field(ge=0)]
    cache_read_usd_per_mtok: Annotated[float, Field(ge=0)] | None = None
    cache_write_usd_per_mtok: Annotated[float, Field(ge=0)] | None = None

    def cost_usd(self, usage: LLMUsage) -> float:
        cache_read = self.cache_read_usd_per_mtok
        cache_write = self.cache_write_usd_per_mtok
        total = (
            usage.input_tokens * self.input_usd_per_mtok
            + usage.output_tokens * self.output_usd_per_mtok
            + usage.cache_read_input_tokens
            * (self.input_usd_per_mtok if cache_read is None else cache_read)
            + usage.cache_creation_input_tokens
            * (self.input_usd_per_mtok if cache_write is None else cache_write)
        )
        return total / _PER_MTOK


class LLMConfig(CoreModel):
    """Provider settings. ``api_key`` is a ``SecretStr`` so it never shows in repr or logs."""

    api_key: SecretStr
    model: NonEmptyText
    provider: LLMProvider = LLMProvider.ANTHROPIC
    base_url: str | None = None
    timeout_seconds: Annotated[float, Field(gt=0)] = 120.0
    max_retries: Annotated[int, Field(ge=0, le=10)] = 2
    max_tokens: Annotated[int, Field(ge=1)] = 16000
    effort: Effort | None = None
    pricing: LLMPricing | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> LLMConfig | None:
        """Read ``LLM_*`` variables; ``None`` when ``LLM_API_KEY`` is unset (LLM disabled)."""
        values = os.environ if env is None else env

        def get(name: str) -> str | None:
            value = values.get(name, "").strip()
            return value or None

        api_key = get("LLM_API_KEY")
        if api_key is None:
            return None
        model = get("LLM_MODEL")
        if model is None:
            raise LLMConfigError("LLM_MODEL is required when LLM_API_KEY is set")

        raw: dict[str, object] = {"api_key": api_key, "model": model}
        optional = {
            "provider": "LLM_PROVIDER",
            "base_url": "LLM_BASE_URL",
            "timeout_seconds": "LLM_TIMEOUT_SECONDS",
            "max_retries": "LLM_MAX_RETRIES",
            "max_tokens": "LLM_MAX_TOKENS",
            "effort": "LLM_EFFORT",
        }
        for field, name in optional.items():
            value = get(name)
            if value is not None:
                raw[field] = value

        prices = {
            "input_usd_per_mtok": get("LLM_PRICE_INPUT_USD_PER_MTOK"),
            "output_usd_per_mtok": get("LLM_PRICE_OUTPUT_USD_PER_MTOK"),
            "cache_read_usd_per_mtok": get("LLM_PRICE_CACHE_READ_USD_PER_MTOK"),
            "cache_write_usd_per_mtok": get("LLM_PRICE_CACHE_WRITE_USD_PER_MTOK"),
        }
        if any(v is not None for v in prices.values()):
            raw["pricing"] = {k: v for k, v in prices.items() if v is not None}

        try:
            return cls.model_validate(raw)
        except ValidationError as exc:
            # Field names only: values (including the key) never reach the message.
            fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
            raise LLMConfigError(f"invalid LLM configuration: {', '.join(fields)}") from None


def create_llm_client(config: LLMConfig) -> LLMClient:
    """Build the configured provider client. Needs the ``llm`` extra (imported lazily)."""
    if config.provider is LLMProvider.ANTHROPIC:
        from book_core.llm.anthropic_client import AnthropicLLMClient

        return AnthropicLLMClient(config)
    raise LLMConfigError(f"unsupported LLM provider: {config.provider}")  # pragma: no cover
