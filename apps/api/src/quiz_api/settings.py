"""Typed settings read from the environment (and an optional local `.env`).

Variable names follow `.env.example` / docs/deployment.md §6. Values that can carry
credentials are `SecretStr`, so they never show up in `repr()`, logs or tracebacks.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    PREVIEW = "preview"
    PRODUCTION = "production"


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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
