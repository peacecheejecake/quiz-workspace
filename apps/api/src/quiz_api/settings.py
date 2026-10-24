"""Typed settings read from the environment (and an optional local `.env`).

Variable names follow `.env.example` / docs/deployment.md §6. Values that can carry
credentials are `SecretStr`, so they never show up in `repr()`, logs or tracebacks.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from typing import Annotated, Any
from urllib.parse import urlsplit

from book_core.embedding.factory import EmbedderMode, uses_local_model
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _has_model_runtime() -> bool:
    """Whether torch + transformers are installed (the `models` extra; slim images drop it)."""
    import importlib.util

    return all(importlib.util.find_spec(name) is not None for name in ("torch", "transformers"))


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    PREVIEW = "preview"
    PRODUCTION = "production"


# Deployed environments: served over HTTPS behind real domains (docs/deployment.md §1, §6).
DEPLOYED_ENVIRONMENTS = frozenset({Environment.PREVIEW, Environment.PRODUCTION})

# Web origins allowed by default where nothing is configured (local/test only): the Next.js dev
# server on both loopback spellings (`make web-dev`).
LOCAL_CORS_ORIGINS: tuple[str, ...] = ("http://127.0.0.1:3000", "http://localhost:3000")

# Browsers cap preflight caching (Chromium at 2h); a bounded value keeps allowlist changes timely.
MAX_CORS_MAX_AGE_SECONDS = 7200


_DEFAULT_PORTS = {"http": 80, "https": 443}


ASCII_ORIGIN_HINT = (
    "use the ASCII (punycode) serialization, e.g. https://xn--fa-hia.example; "
    "a browser prints it for `new URL(origin).origin`"
)


def normalize_origin(value: str) -> str:
    """Canonical form of an origin that is already in the browser's ASCII serialization (the
    `Origin` header form): lowercase scheme and host, IPv6 in brackets, default port (80/443)
    omitted. No IDNA conversion happens here: internationalized hosts must be configured as
    punycode, and non-ASCII values are refused. Raises ValueError for anything that is not an
    origin.

    The message names the problem, never the value (configuration errors end up in logs).
    """
    raw = value.strip()
    if raw == "*":
        raise ValueError("wildcard origin '*' is not allowed (explicit allowlist only)")
    if not raw.isascii():
        raise ValueError(f"CORS_ALLOWED_ORIGINS entries must be ASCII: {ASCII_ORIGIN_HINT}")
    parts = urlsplit(raw.rstrip("/"))
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname:
        raise ValueError("each origin must be an http(s)://host[:port] URL")
    extras = (parts.username, parts.password, parts.path, parts.query, parts.fragment)
    if "*" in raw or any(extras):
        raise ValueError("each origin must be exactly scheme://host[:port] (no wildcard or path)")
    try:
        port_number = parts.port
    except ValueError:
        raise ValueError("each origin must have a numeric port") from None
    port = "" if port_number in (None, _DEFAULT_PORTS[scheme]) else f":{port_number}"
    host = parts.hostname  # lowercased, IPv6 brackets stripped by urlsplit
    if ":" in host:
        host = f"[{host}]"
    return f"{scheme}://{host}{port}"


def origin_authority(scheme: str, host: str) -> str | None:
    """`host[:port]` of `scheme://<host header>` in the same serialization, or None if invalid."""
    try:
        return normalize_origin(f"{scheme}://{host}").split("://", 1)[1]
    except ValueError:
        return None


def _is_https_url(value: str) -> bool:
    parts = urlsplit(value.strip())
    return parts.scheme == "https" and bool(parts.hostname)


class InsecureConfigurationError(RuntimeError):
    """Settings that must never run in a deployed environment (raised at startup)."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        # Validation errors never print input values (URLs with credentials, secrets).
        hide_input_in_errors=True,
    )

    app_env: Environment = Field(default=Environment.LOCAL, validation_alias="APP_ENV")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")

    # Server-only secrets: never log, never put in URLs or responses.
    database_url: SecretStr | None = Field(default=None, validation_alias="DATABASE_URL")
    redis_url: SecretStr | None = Field(default=None, validation_alias="REDIS_URL")
    qdrant_url: str | None = Field(default=None, validation_alias="QDRANT_URL")
    qdrant_api_key: SecretStr | None = Field(default=None, validation_alias="QDRANT_API_KEY")

    # Supabase Auth access-token verification (docs/auth.md §3). Unset → authenticated routes
    # answer 503 (never accept unverified tokens).
    supabase_jwt_issuer: str | None = Field(default=None, validation_alias="SUPABASE_JWT_ISSUER")
    supabase_jwks_url: str | None = Field(default=None, validation_alias="SUPABASE_JWKS_URL")
    supabase_jwt_audience: str = Field(
        default="authenticated", validation_alias="SUPABASE_JWT_AUDIENCE"
    )
    jwt_leeway_seconds: float = Field(
        default=30.0, ge=0, le=120, validation_alias="JWT_LEEWAY_SECONDS"
    )
    jwks_cache_ttl_seconds: float = Field(
        default=600.0, gt=0, validation_alias="JWKS_CACHE_TTL_SECONDS"
    )
    jwks_min_refresh_interval_seconds: float = Field(
        default=30.0, ge=0, validation_alias="JWKS_MIN_REFRESH_INTERVAL_SECONDS"
    )
    jwks_max_stale_seconds: float = Field(
        default=3600.0, ge=0, validation_alias="JWKS_MAX_STALE_SECONDS"
    )
    jwks_fetch_timeout_seconds: float = Field(
        default=3.0, gt=0, validation_alias="JWKS_FETCH_TIMEOUT_SECONDS"
    )

    # Browser origins allowed to call the API (CORS), comma-separated `scheme://host[:port]`.
    # Unset → LOCAL_CORS_ORIGINS in local/test; required (HTTPS) in preview/production.
    cors_allowed_origins: Annotated[tuple[str, ...] | None, NoDecode] = Field(
        default=None, validation_alias="CORS_ALLOWED_ORIGINS"
    )
    cors_max_age_seconds: int = Field(
        default=600, ge=0, le=MAX_CORS_MAX_AGE_SECONDS, validation_alias="CORS_MAX_AGE_SECONDS"
    )
    # Public origin of the web app, used to build share URLs (`<origin>/share/{id}#k=…`, S1a).
    # Unset → the first CORS origin (https in preview/production).
    web_origin: str | None = Field(default=None, validation_alias="WEB_ORIGIN")
    # Guest share sessions (S1b; quiz_api.share_sessions). HMAC key of the session cookie, at
    # least 32 characters (`openssl rand -base64 32`), the same on every API replica. Unset: a
    # random per-process key locally/in tests; preview/production answer 503 on /shared routes.
    share_session_secret: SecretStr | None = Field(
        default=None, validation_alias="SHARE_SESSION_SECRET"
    )
    # Lifetime of a share session cookie (short-lived; the link is re-checked on every request).
    share_session_ttl_seconds: int = Field(
        default=4 * 3600, ge=60, le=8 * 3600, validation_alias="SHARE_SESSION_TTL_SECONDS"
    )
    # Secret exchanges per minute per client and share link (in-process token bucket, like
    # search); above it 429 + Retry-After. 0 disables it.
    share_exchange_rate_per_minute: int = Field(
        default=20, ge=0, le=600, validation_alias="SHARE_EXCHANGE_RATE_LIMIT_PER_MINUTE"
    )
    # Ceiling on exchanges per minute for one link across all clients (0 disables it).
    share_exchange_link_rate_per_minute: int = Field(
        default=300, ge=0, le=60000, validation_alias="SHARE_EXCHANGE_LINK_RATE_LIMIT_PER_MINUTE"
    )
    # Server-only HMAC key shared with the web relay (quiz_api.relay_client): lets the relay state
    # which client it acts for, so per-client limits work behind it. >= 32 characters. Unset:
    # the socket peer is the client (local); preview/production answer 503 on /shared routes.
    relay_client_secret: SecretStr | None = Field(
        default=None, validation_alias="RELAY_CLIENT_SECRET"
    )
    # Fork starts per minute per user (S3a; in-process token bucket, burst = rate); above it 429 +
    # Retry-After. 0 disables it.
    share_fork_rate_per_minute: int = Field(
        default=5, ge=0, le=600, validation_alias="SHARE_FORK_RATE_LIMIT_PER_MINUTE"
    )
    # Batch variant generation starts per minute per user (QGEN-MULTI; in-process token bucket,
    # burst = rate); above it 429 + Retry-After. 0 disables it.
    question_generation_batch_rate_per_minute: int = Field(
        default=6, ge=0, le=600, validation_alias="QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE"
    )
    # Supabase Storage (M3.2a; docs/deployment.md §2, auth.md §4). The API talks to Storage with
    # the server-only secret key; browsers only ever get short-lived signed URLs. Unset key ->
    # document upload/read routes answer 503.
    supabase_url: str | None = Field(
        default=None, validation_alias=AliasChoices("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    )
    # Origin the browser uses for signed Storage URLs, when it differs from `supabase_url`
    # (e.g. the API reaches Storage on an internal hostname).
    storage_public_url: str | None = Field(default=None, validation_alias="STORAGE_PUBLIC_URL")
    supabase_secret_key: SecretStr | None = Field(
        default=None, validation_alias="SUPABASE_SECRET_KEY"
    )
    storage_timeout_seconds: float = Field(
        default=30.0, gt=0, validation_alias="STORAGE_TIMEOUT_SECONDS"
    )
    # How long an upload intent can be completed (the direct/TUS upload must finish within it).
    upload_intent_ttl_seconds: int = Field(
        default=3600, ge=60, le=7200, validation_alias="UPLOAD_INTENT_TTL_SECONDS"
    )
    # Lifetime of a signed PDF read URL (the viewer asks for a new one when it expires).
    signed_read_url_ttl_seconds: int = Field(
        default=300, ge=10, le=3600, validation_alias="SIGNED_READ_URL_TTL_SECONDS"
    )

    # Workspace search (M3.6a). The query embedder and the collection namespace must be the
    # worker's (same model key, same collections), so these read the worker's variables and
    # pick the embedder through the same `book_core.embedding.select_embedder`.
    qdrant_collection_prefix: str = Field(
        default="", pattern=r"^[A-Za-z0-9_-]*$", validation_alias="QDRANT_COLLECTION_PREFIX"
    )
    search_embedder: EmbedderMode = Field(
        default=EmbedderMode.AUTO, validation_alias="WORKER_EMBEDDER"
    )
    search_models_offline: bool = Field(default=False, validation_alias="WORKER_MODELS_OFFLINE")
    # WORKER_EMBEDDER=workers_ai (M7.4b): the query embedder runs on Cloudflare Workers AI with the
    # worker's credentials (same model key). The token is server-only; never on the web service.
    cloudflare_account_id: str | None = Field(
        default=None, validation_alias="CLOUDFLARE_ACCOUNT_ID"
    )
    cloudflare_api_token: SecretStr | None = Field(
        default=None, validation_alias="CLOUDFLARE_API_TOKEN"
    )
    cloudflare_ai_batch_size: int = Field(
        default=16, ge=1, le=100, validation_alias="CLOUDFLARE_AI_BATCH_SIZE"
    )
    # Interactive search waits at most this long per attempt (two attempts) for the query vector
    # before it degrades to BM25 (SEARCH-01-AC06).
    cloudflare_ai_timeout_seconds: float = Field(
        default=5, gt=0, le=300, validation_alias="CLOUDFLARE_AI_TIMEOUT_SECONDS"
    )
    # Per-user search rate limit (in-process token bucket, a stopgap until a shared limiter):
    # sustained requests per minute and the burst allowed on top. 0 disables it.
    search_rate_per_minute: int = Field(
        default=60, ge=0, le=6000, validation_alias="SEARCH_RATE_LIMIT_PER_MINUTE"
    )
    search_rate_burst: int = Field(default=20, ge=1, le=1000, validation_alias="SEARCH_RATE_BURST")

    db_pool_size: int = Field(default=5, ge=1, validation_alias="DB_POOL_SIZE")
    db_connect_timeout_seconds: float = Field(
        default=3.0, gt=0, validation_alias="DB_CONNECT_TIMEOUT_SECONDS"
    )
    readiness_timeout_seconds: float = Field(
        default=2.0, gt=0, validation_alias="READINESS_TIMEOUT_SECONDS"
    )

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def _parse_origins(cls, value: Any) -> tuple[str, ...] | None:
        if value is None:
            return None
        items = value.split(",") if isinstance(value, str) else list(value)
        origins = [normalize_origin(str(item)) for item in items if str(item).strip()]
        return tuple(dict.fromkeys(origins)) or None

    @field_validator("web_origin", mode="before")
    @classmethod
    def _parse_web_origin(cls, value: Any) -> str | None:
        if value is None or not str(value).strip():
            return None
        return normalize_origin(str(value))

    def ensure_secure_deployment(self) -> Settings:
        """Raise `InsecureConfigurationError` for configs that must not run in preview/production.

        Deliberately not a pydantic validator: a `ValidationError` would echo every input value
        (DATABASE_URL included) into the startup log. The message names variables only.
        """
        if self.app_env not in DEPLOYED_ENVIRONMENTS:
            return self
        problems: list[str] = []
        for name, url in (
            ("SUPABASE_JWT_ISSUER", self.supabase_jwt_issuer),
            ("SUPABASE_JWKS_URL", self.supabase_jwks_url),
        ):
            if not url:
                problems.append(f"{name} is required")
            elif not _is_https_url(url):
                problems.append(f"{name} must be an https:// URL")
        if not self.cors_allowed_origins:
            problems.append("CORS_ALLOWED_ORIGINS must list the web origin(s)")
        elif any(not origin.startswith("https://") for origin in self.cors_allowed_origins):
            problems.append("CORS_ALLOWED_ORIGINS must contain only https:// origins")
        if self.web_origin and not self.web_origin.startswith("https://"):
            problems.append("WEB_ORIGIN must be an https:// origin")
        share_key = self.share_session_secret
        if share_key is not None and 0 < len(share_key.get_secret_value()) < 32:
            problems.append("SHARE_SESSION_SECRET must have at least 32 characters")
        relay_key = self.relay_client_secret
        if relay_key is not None and 0 < len(relay_key.get_secret_value()) < 32:
            problems.append("RELAY_CLIENT_SECRET must have at least 32 characters")
        if self.search_embedder is EmbedderMode.FAKE:
            problems.append("WORKER_EMBEDDER=fake is for local and test runs only")
        if self.search_embedder is EmbedderMode.WORKERS_AI:
            token = self.cloudflare_api_token
            if not (self.cloudflare_account_id or "").strip():
                problems.append("CLOUDFLARE_ACCOUNT_ID is required for WORKER_EMBEDDER=workers_ai")
            if token is None or not token.get_secret_value().strip():
                problems.append("CLOUDFLARE_API_TOKEN is required for WORKER_EMBEDDER=workers_ai")
        elif uses_local_model(self.search_embedder, test_env=False) and not _has_model_runtime():
            problems.append(
                f"WORKER_EMBEDDER={self.search_embedder.value} embeds queries in-process but this "
                "image has no torch/transformers: set WORKER_EMBEDDER=workers_ai or build the API "
                "image with --build-arg API_EXTRAS=models"
            )
        if problems:
            raise InsecureConfigurationError(
                f"Refusing to start with APP_ENV={self.app_env.value}: " + "; ".join(problems)
            )
        return self

    @property
    def effective_cors_origins(self) -> tuple[str, ...]:
        """The CORS allowlist in force: configured origins, else the local defaults (never in a
        deployed environment, where validation already demanded an explicit list)."""
        if self.cors_allowed_origins:
            return self.cors_allowed_origins
        return () if self.app_env in DEPLOYED_ENVIRONMENTS else LOCAL_CORS_ORIGINS

    @property
    def share_web_origin(self) -> str:
        """Origin of the share URLs handed to owners: WEB_ORIGIN, else the first CORS origin."""
        if self.web_origin:
            return self.web_origin
        origins = self.effective_cors_origins or LOCAL_CORS_ORIGINS
        return origins[0]

    @property
    def is_deployed(self) -> bool:
        return self.app_env in DEPLOYED_ENVIRONMENTS


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings().ensure_secure_deployment()
