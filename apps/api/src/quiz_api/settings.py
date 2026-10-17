"""Typed settings read from the environment (and an optional local `.env`).

Variable names follow `.env.example` / docs/deployment.md §6. Values that can carry
credentials are `SecretStr`, so they never show up in `repr()`, logs or tracebacks.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from typing import Annotated, Any
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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


def _ascii_host(hostname: str) -> str:
    """Lowercase ASCII host as browsers serialize it: IDNA (punycode) labels, IPv6 in brackets."""
    host = hostname.lower()
    if ":" in host:  # IPv6 literal (urlsplit strips the brackets)
        return f"[{host}]"
    if host.isascii():
        return host
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        raise ValueError("each origin must have a valid host name") from None


def normalize_origin(value: str) -> str:
    """The browser's ASCII serialization of an origin (`Origin` header form): lowercase scheme and
    host, IDNA-encoded host, IPv6 in brackets, default port (80/443) omitted. Raises ValueError
    for anything that is not an origin.

    The message names the problem, never the value (configuration errors end up in logs).
    """
    raw = value.strip()
    if raw == "*":
        raise ValueError("wildcard origin '*' is not allowed (explicit allowlist only)")
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
    return f"{scheme}://{_ascii_host(parts.hostname)}{port}"


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
    def is_deployed(self) -> bool:
        return self.app_env in DEPLOYED_ENVIRONMENTS


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings().ensure_secure_deployment()
