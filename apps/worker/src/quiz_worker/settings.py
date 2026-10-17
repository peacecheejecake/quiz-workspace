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
    # 0 disables the soft limit (tests that exercise the hard limit).
    task_soft_time_limit_seconds: int = Field(
        default=1500, ge=0, validation_alias="WORKER_TASK_SOFT_TIME_LIMIT_SECONDS"
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

    # Reconciler (quiz_worker.reconcile): recovers jobs whose broker message is gone.
    reconcile_interval_seconds: float = Field(
        default=60, gt=0, validation_alias="WORKER_RECONCILE_INTERVAL_SECONDS"
    )
    # A queued row with no publish recorded is re-published after this (covers the window
    # between the row insert and the publish).
    reconcile_unpublished_grace_seconds: float = Field(
        default=60, gt=0, validation_alias="WORKER_RECONCILE_UNPUBLISHED_GRACE_SECONDS"
    )
    # A published but unclaimed queued row is re-published after this; defaults to the lease
    # (it must exceed every retry countdown). Duplicates are harmless, only wasteful.
    reconcile_stale_after_seconds: float | None = Field(
        default=None, gt=0, validation_alias="WORKER_RECONCILE_STALE_AFTER_SECONDS"
    )
    # Run Celery beat inside the worker (`worker -B`) to schedule the reconciler. Reconciling
    # is safe to run concurrently, so several workers with embedded beat are tolerable.
    embedded_beat: bool = Field(default=True, validation_alias="WORKER_EMBEDDED_BEAT")
    # Local/test only: share job state between processes through a SQLite file (prefork
    # children, several local workers). Unset -> in-memory store (single process).
    job_store_path: str | None = Field(default=None, validation_alias="WORKER_JOB_STORE_PATH")

    @model_validator(mode="after")
    def _check_limits(self) -> WorkerSettings:
        if self.task_soft_time_limit_seconds >= self.task_time_limit_seconds:
            raise ValueError("WORKER_TASK_SOFT_TIME_LIMIT_SECONDS must be below the hard limit")
        return self

    @property
    def lease_seconds(self) -> int:
        return self.task_time_limit_seconds + self.lease_grace_seconds

    @property
    def reconcile_stale_after(self) -> float:
        return self.reconcile_stale_after_seconds or float(self.lease_seconds)

    @property
    def broker_visibility_timeout_seconds(self) -> int:
        # Redis re-delivers unacked messages after this; keep it past any live lease.
        return self.lease_seconds + 60


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()
