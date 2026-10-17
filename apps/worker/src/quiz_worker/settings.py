"""Typed worker settings read from the environment (and an optional local `.env`).

Variable names follow `.env.example` / docs/deployment.md §6. Values that can carry
credentials are `SecretStr`, so they never show up in `repr()`, logs or tracebacks.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    PREVIEW = "preview"
    PRODUCTION = "production"


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: Environment = Field(default=Environment.LOCAL, validation_alias="APP_ENV")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")

    # Server-only secrets: never log, never put in URLs or responses.
    redis_url: SecretStr | None = Field(default=None, validation_alias="REDIS_URL")
    database_url: SecretStr | None = Field(default=None, validation_alias="DATABASE_URL")

    # docs/deployment.md §7: start at concurrency 1 and scale after measuring memory/latency.
    concurrency: int = Field(default=1, ge=1, validation_alias="WORKER_CONCURRENCY")
    # Soft limit raises inside the task (retryable); the hard limit kills the child process.
    task_soft_time_limit_seconds: int = Field(
        default=1500, ge=1, validation_alias="WORKER_TASK_SOFT_TIME_LIMIT_SECONDS"
    )
    task_time_limit_seconds: int = Field(
        default=1800, ge=1, validation_alias="WORKER_TASK_TIME_LIMIT_SECONDS"
    )
    # A claim's lease outlives the hard time limit by this margin, so a live attempt is never
    # treated as abandoned while the worker could still be running it.
    lease_grace_seconds: int = Field(
        default=120, ge=1, validation_alias="WORKER_LEASE_GRACE_SECONDS"
    )
    # Run tasks in-process (tests / wiring only); never enable in a deployed worker.
    task_always_eager: bool = Field(default=False, validation_alias="WORKER_TASK_ALWAYS_EAGER")

    @model_validator(mode="after")
    def _check_limits(self) -> WorkerSettings:
        if self.task_soft_time_limit_seconds >= self.task_time_limit_seconds:
            raise ValueError("WORKER_TASK_SOFT_TIME_LIMIT_SECONDS must be below the hard limit")
        return self

    @property
    def lease_seconds(self) -> int:
        return self.task_time_limit_seconds + self.lease_grace_seconds

    @property
    def broker_visibility_timeout_seconds(self) -> int:
        # Redis re-delivers unacked messages after this; keep it past any live lease.
        return self.lease_seconds + 60


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()
