"""Cloudflare Workers AI embedding adapter (M7.4b): ``@cf/qwen/qwen3-embedding-0.6b`` over REST.

Staging/production embed with the hosted model so the API image needs no torch/transformers
(implementation-plan §7, Railway trial memory). Request contract (Workers AI model schema):

- ``POST {base_url}/accounts/{account_id}/ai/run/@cf/qwen/qwen3-embedding-0.6b`` with
  ``Authorization: Bearer <token>`` (an account API token with Workers AI permission only);
- documents: ``{"documents": [...]}`` (no instruction), batched by ``batch_size``;
- queries: ``{"queries": [q], "instruction": DEFAULT_QUERY_INSTRUCTION}``, the same retrieval
  instruction the local ``Qwen3Embedder`` prefixes;
- response: ``{"success": true, "result": {"data": [[...], ...], "shape": [n, 1024]}}``.

Vectors are L2-normalised (like the local embedder) and validated: one per input, exactly
``dimension`` finite components. ``model_name`` names the hosted model, so its vectors land in
their own Qdrant collection and never mix with locally computed ones (indexing/naming.py).

Failures (all ``EmbeddingUnavailableError``): 429 / 5xx / timeouts / transport errors are retried
``max_attempts`` times in total with exponential backoff and full jitter (``Retry-After`` honoured,
capped at ``max_delay_seconds``), then raised as ``EmbeddingQuotaExceededError`` (429) or
``EmbeddingUnavailableError``; the Workers Free daily allocation (Cloudflare error code 4006) fails
fast as ``EmbeddingQuotaExceededError``; 401/403 raise ``EmbeddingAuthError`` and other 4xx or
malformed answers ``EmbeddingResponseError`` without retry. Exception messages and log lines carry
status codes and counts only — never input text, the token, the account id or the URL — and are
raised ``from None`` so no httpx exception (whose text includes the URL) is chained.
"""

from __future__ import annotations

import logging
import math
import random
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from book_core.embedding.base import (
    EmbeddingAuthError,
    EmbeddingQuotaExceededError,
    EmbeddingResponseError,
    EmbeddingUnavailableError,
)
from book_core.embedding.qwen3 import DEFAULT_QUERY_INSTRUCTION

logger = logging.getLogger(__name__)

WORKERS_AI_MODEL = "@cf/qwen/qwen3-embedding-0.6b"
WORKERS_AI_DIMENSION = 1024
DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4"
# Cloudflare error code for "daily free allocation of neurons used up" (Workers Free plan).
DAILY_ALLOCATION_EXHAUSTED = 4006
_RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")


@dataclass(frozen=True)
class WorkersAIConfig:
    """Settings of ``WorkersAIEmbedder`` (env: ``CLOUDFLARE_ACCOUNT_ID``, ``CLOUDFLARE_API_TOKEN``,
    ``CLOUDFLARE_AI_BATCH_SIZE``, ``CLOUDFLARE_AI_TIMEOUT_SECONDS``).

    - ``batch_size``: documents per request; small by default so one request stays well inside
      the model's limits and a failed request wastes little of the daily quota.
    - ``timeout_seconds``: per request (connect, read, write, pool).
    - ``max_attempts``: requests per batch including the first (1 = never retry in-process; the
      job's own retry policy still applies on top).
    """

    account_id: str
    api_token: str = field(repr=False)
    model: str = WORKERS_AI_MODEL
    dimension: int = WORKERS_AI_DIMENSION
    batch_size: int = 16
    timeout_seconds: float = 30.0
    max_attempts: int = 3
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 8.0
    query_instruction: str = DEFAULT_QUERY_INSTRUCTION
    base_url: str = DEFAULT_BASE_URL

    def __post_init__(self) -> None:
        # Messages name the field only, never its value.
        if not _ACCOUNT_ID.match(self.account_id or ""):
            raise ValueError("account_id must be the Cloudflare account id (letters and digits)")
        if not (self.api_token or "").strip():
            raise ValueError("api_token must not be empty")
        if not self.model.startswith("@cf/"):
            raise ValueError("model must be a Workers AI model id (@cf/...)")
        if self.dimension < 1:
            raise ValueError("dimension must be >= 1")
        if self.batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("need 0 <= base_delay_seconds <= max_delay_seconds")
        if not self.base_url.startswith("https://"):
            raise ValueError("base_url must be an https:// URL")

    @property
    def url(self) -> str:
        return f"{self.base_url.rstrip('/')}/accounts/{self.account_id}/ai/run/{self.model}"


def workers_ai_config(
    account_id: str | None,
    api_token: str | None,
    *,
    batch_size: int = 16,
    timeout_seconds: float = 30.0,
    max_attempts: int = 3,
) -> WorkersAIConfig | None:
    """The config for the API/worker settings values, or None when a credential is missing (the
    caller reports which variables to set). Invalid values raise ``ValueError`` (field names
    only)."""
    if not (account_id or "").strip() or not (api_token or "").strip():
        return None
    return WorkersAIConfig(
        account_id=(account_id or "").strip(),
        api_token=(api_token or "").strip(),
        batch_size=batch_size,
        timeout_seconds=timeout_seconds,
        max_attempts=max_attempts,
    )


class _HideWorkersAIRequests(logging.Filter):
    """Drops httpx's INFO "HTTP Request: POST <url>" lines for Workers AI: the URL names the
    account. Status codes are logged by this module instead."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/ai/run/" not in record.getMessage()


_HTTPX_FILTER = _HideWorkersAIRequests()


def _install_httpx_filter() -> None:
    httpx_logger = logging.getLogger("httpx")
    if _HTTPX_FILTER not in httpx_logger.filters:
        httpx_logger.addFilter(_HTTPX_FILTER)


class _RetryableError(Exception):
    """Internal: a retryable failure of one request (status or transport), with its final error."""

    def __init__(self, error: EmbeddingUnavailableError, wait: float | None = None) -> None:
        super().__init__(type(error).__name__)
        self.error = error
        self.wait = wait


class WorkersAIEmbedder:
    """``Embedder`` on Cloudflare Workers AI. ``model_name`` and ``dimension`` are static, so the
    index store's model key never needs a network call."""

    def __init__(
        self,
        config: WorkersAIConfig,
        *,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rng: random.Random | None = None,
    ) -> None:
        self._config = config
        _install_httpx_filter()
        self._client = client or httpx.Client()
        self._sleep = sleep
        self._rng = rng or random.Random()  # noqa: S311 - jitter, not cryptography

    @property
    def config(self) -> WorkersAIConfig:
        return self._config

    @property
    def model_name(self) -> str:
        return f"cloudflare-workers-ai:{self._config.model}"

    @property
    def dimension(self) -> int:
        return self._config.dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        items = list(texts)
        out: list[list[float]] = []
        size = self._config.batch_size
        for start in range(0, len(items), size):
            batch = items[start : start + size]
            out.extend(self._run({"documents": batch}, len(batch)))
        return out

    def embed_query(self, text: str) -> list[float]:
        body: dict[str, Any] = {"queries": [text]}
        if self._config.query_instruction:
            body["instruction"] = self._config.query_instruction
        return self._run(body, 1)[0]

    # --- internals ------------------------------------------------------------------------------

    def _run(self, body: dict[str, Any], expected: int) -> list[list[float]]:
        attempts = self._config.max_attempts
        for attempt in range(1, attempts + 1):
            try:
                return self._request(body, expected)
            except _RetryableError as retry:
                if attempt >= attempts:
                    raise retry.error from None
                wait = self._delay(attempt, retry.wait)
                logger.warning(
                    "workers ai: %s, retry %d/%d in %.1fs",
                    retry.error.code,
                    attempt,
                    attempts - 1,
                    wait,
                )
                self._sleep(wait)
        raise AssertionError("unreachable")  # pragma: no cover

    def _delay(self, attempt: int, retry_after: float | None) -> float:
        cap = self._config.max_delay_seconds
        if retry_after is not None:
            return min(cap, max(0.0, retry_after))
        ceiling = min(cap, self._config.base_delay_seconds * 2.0 ** (attempt - 1))
        # "Equal jitter": half fixed, half random, so the delay never collapses to zero.
        return float(ceiling / 2 + self._rng.uniform(0, ceiling / 2))

    def _request(self, body: dict[str, Any], expected: int) -> list[list[float]]:
        config = self._config
        try:
            response = self._client.post(
                config.url,
                json=body,
                headers={
                    "Authorization": f"Bearer {config.api_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=httpx.Timeout(config.timeout_seconds),
            )
        except httpx.TimeoutException:
            raise _RetryableError(
                EmbeddingUnavailableError("Workers AI request timed out")
            ) from None
        except httpx.TransportError:
            raise _RetryableError(
                EmbeddingUnavailableError("Workers AI could not be reached")
            ) from None

        status = response.status_code
        payload = _json(response)
        if status >= 400 or not (isinstance(payload, dict) and payload.get("success") is True):
            self._raise_for(status, payload, response)
        return self._vectors(payload, expected)

    def _raise_for(self, status: int, payload: Any, response: httpx.Response) -> None:
        codes = _error_codes(payload)
        if DAILY_ALLOCATION_EXHAUSTED in codes:
            raise EmbeddingQuotaExceededError(
                f"Workers AI daily allocation exhausted (HTTP {status})"
            ) from None
        if status in (401, 403):
            raise EmbeddingAuthError(
                f"Workers AI rejected the credentials (HTTP {status})"
            ) from None
        if status == 429:
            raise _RetryableError(
                EmbeddingQuotaExceededError("Workers AI rate limit or quota exceeded (HTTP 429)"),
                _retry_after(response),
            )
        if status in _RETRY_STATUS:
            raise _RetryableError(
                EmbeddingUnavailableError(f"Workers AI unavailable (HTTP {status})"),
                _retry_after(response),
            )
        if status >= 400:
            raise EmbeddingResponseError(
                f"Workers AI refused the request (HTTP {status})"
            ) from None
        raise EmbeddingResponseError(
            "Workers AI reported failure without an error status"
        ) from None

    def _vectors(self, payload: Any, expected: int) -> list[list[float]]:
        result = payload.get("result") if isinstance(payload, dict) else None
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, list):
            raise EmbeddingResponseError("Workers AI response has no embedding data") from None
        if len(data) != expected:
            raise EmbeddingResponseError(
                f"Workers AI returned {len(data)} vectors for {expected} inputs"
            ) from None
        dim = self._config.dimension
        vectors: list[list[float]] = []
        for row in data:
            if not isinstance(row, list) or len(row) != dim:
                size = len(row) if isinstance(row, list) else 0
                raise EmbeddingResponseError(
                    f"Workers AI returned {size}-dimensional vectors, expected {dim}"
                ) from None
            try:
                values = [float(v) for v in row]
            except (TypeError, ValueError):
                raise EmbeddingResponseError("Workers AI returned non-numeric vectors") from None
            norm = math.sqrt(math.fsum(v * v for v in values))
            if not math.isfinite(norm) or norm == 0:
                raise EmbeddingResponseError(
                    "Workers AI returned a zero or non-finite vector"
                ) from None
            vectors.append([v / norm for v in values])
        return vectors


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _error_codes(payload: Any) -> set[int]:
    errors = payload.get("errors") if isinstance(payload, dict) else None
    codes: set[int] = set()
    for item in errors if isinstance(errors, list) else ():
        code = item.get("code") if isinstance(item, dict) else None
        if isinstance(code, int):
            codes.add(code)
    return codes


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after", "").strip()
    if value.isdigit():
        return float(value)
    return None


__all__ = [
    "DAILY_ALLOCATION_EXHAUSTED",
    "DEFAULT_BASE_URL",
    "WORKERS_AI_DIMENSION",
    "WORKERS_AI_MODEL",
    "WorkersAIConfig",
    "WorkersAIEmbedder",
    "workers_ai_config",
]
