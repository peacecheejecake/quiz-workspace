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
  ``LLM_PRICE_CACHE_WRITE_USD_PER_MTOK``): the prices of ``LLM_MODEL``; enables ``cost_usd``.
  The Anthropic client caches the system prompt, and ``input_tokens`` then excludes cached
  tokens: set both cache prices too, since unset ones fall back to the input price.
- ``LLM_MODEL_PRICES``: optional JSON ``{"<model id>": {"input": n, "output": n, "cache_read": n?,
  "cache_write": n?}}`` (USD per MTok) for models other than ``LLM_MODEL``.

Per-route overrides (``route`` is one of ``ROUTES``, named after the ``WORKER_*`` switches):

- ``LLM_MODEL_<ROUTE>``: model for that route; falls back to ``LLM_MODEL``.
- ``LLM_EFFORT_<ROUTE>``: effort for that route; falls back to ``LLM_EFFORT``. ASK and
  AI_EXPLANATIONS send their own request effort (``ASK_LLM_EFFORT``, default ``low``, and a fixed
  ``low``), which beats ``LLM_EFFORT``; ``LLM_EFFORT_<ROUTE>`` beats both (``route_effort``).
- Pricing of the resolved model: its ``LLM_MODEL_PRICES`` entry; else ``LLM_PRICE_*`` when the
  model is ``LLM_MODEL``; else none (tokens are still recorded, ``cost_usd`` is ``None``).
  Another model's price is never used.

``LLM_API_KEY`` and ``LLM_MODEL`` stay required for every route (the API reads ``LLM_MODEL``).
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Literal, cast

from pydantic import Field, SecretStr, ValidationError

from book_core.contracts.common import CoreModel, NonEmptyText

if TYPE_CHECKING:
    from book_core.llm.base import LLMClient, LLMUsage

Effort = Literal["low", "medium", "high", "xhigh", "max"]
_PER_MTOK = 1_000_000
ROUTES = (
    "QUESTION_IMPORT",
    "DOCUMENT_SUMMARY",
    "CHAPTER_NOTES",
    "MOCK_EXAMS",
    "ASK",
    "AI_EXPLANATIONS",
)
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_PRICE_KEYS = {
    "input": "input_usd_per_mtok",
    "output": "output_usd_per_mtok",
    "cache_read": "cache_read_usd_per_mtok",
    "cache_write": "cache_write_usd_per_mtok",
}


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
    def from_env(
        cls, env: Mapping[str, str] | None = None, *, route: str | None = None
    ) -> LLMConfig | None:
        """Read ``LLM_*`` variables; ``None`` when ``LLM_API_KEY`` is unset (LLM disabled).

        ``route`` applies that route's ``LLM_MODEL_<ROUTE>`` / ``LLM_EFFORT_<ROUTE>`` overrides.
        """
        values = os.environ if env is None else env
        if route is not None and route not in ROUTES:
            raise LLMConfigError("unknown LLM route")

        def get(name: str) -> str | None:
            value = values.get(name, "").strip()
            return value or None

        api_key = get("LLM_API_KEY")
        if api_key is None:
            return None
        model = get("LLM_MODEL")
        if model is None:
            raise LLMConfigError("LLM_MODEL is required when LLM_API_KEY is set")

        base_model = model
        if route is not None:
            model = get(f"LLM_MODEL_{route}") or model

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

        if route is not None:
            effort = get(f"LLM_EFFORT_{route}")
            if effort is not None:
                raw["effort"] = effort

        prices = {
            "input_usd_per_mtok": get("LLM_PRICE_INPUT_USD_PER_MTOK"),
            "output_usd_per_mtok": get("LLM_PRICE_OUTPUT_USD_PER_MTOK"),
            "cache_read_usd_per_mtok": get("LLM_PRICE_CACHE_READ_USD_PER_MTOK"),
            "cache_write_usd_per_mtok": get("LLM_PRICE_CACHE_WRITE_USD_PER_MTOK"),
        }
        table = _model_prices(get("LLM_MODEL_PRICES"))
        if model in table:
            raw["pricing"] = table[model]
        elif model == base_model and any(v is not None for v in prices.values()):
            raw["pricing"] = {k: v for k, v in prices.items() if v is not None}

        try:
            return cls.model_validate(raw)
        except ValidationError as exc:
            # Field names only: values (including the key) never reach the message.
            fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
            raise LLMConfigError(f"invalid LLM configuration: {', '.join(fields)}") from None


def route_effort(route: str, env: Mapping[str, str] | None = None) -> Effort | None:
    """``LLM_EFFORT_<ROUTE>`` alone, for routes whose requests carry their own effort."""
    values = os.environ if env is None else env
    if route not in ROUTES:
        raise LLMConfigError("unknown LLM route")
    name = f"LLM_EFFORT_{route}"
    value = values.get(name, "").strip()
    if not value:
        return None
    if value not in _EFFORTS:
        raise LLMConfigError(f"invalid LLM configuration: {name}")
    return cast(Effort, value)


def _model_prices(raw: str | None) -> dict[str, dict[str, object]]:
    """Parse ``LLM_MODEL_PRICES``; errors name the variable, never its content."""
    if raw is None:
        return {}
    error = LLMConfigError("invalid LLM configuration: LLM_MODEL_PRICES")
    try:
        data = json.loads(raw)
    except ValueError:
        raise error from None
    if not isinstance(data, dict):
        raise error
    table: dict[str, dict[str, object]] = {}
    for model, entry in data.items():
        if not isinstance(entry, dict) or not model or set(entry) - set(_PRICE_KEYS):
            raise error
        if "input" not in entry or "output" not in entry:
            raise error
        if any(isinstance(v, bool) or not isinstance(v, int | float) for v in entry.values()):
            raise error
        table[model] = {_PRICE_KEYS[k]: v for k, v in entry.items()}
    try:
        for entry in table.values():
            LLMPricing.model_validate(entry)
    except ValidationError:
        raise error from None
    return table


def create_llm_client(config: LLMConfig) -> LLMClient:
    """Build the configured provider client. Needs the ``llm`` extra (imported lazily)."""
    if config.provider is LLMProvider.ANTHROPIC:
        from book_core.llm.anthropic_client import AnthropicLLMClient

        return AnthropicLLMClient(config)
    raise LLMConfigError(f"unsupported LLM provider: {config.provider}")  # pragma: no cover
