"""Typed worker settings read from the environment (and an optional local `.env`).

Variable names follow `.env.example` / docs/deployment.md §6. Values that can carry
credentials are `SecretStr`, so they never show up in `repr()`, logs or tracebacks.
"""

from __future__ import annotations

import os
from enum import StrEnum
from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    PREVIEW = "preview"
    PRODUCTION = "production"


class ParserMode(StrEnum):
    AUTO = "auto"
    DOCLING = "docling"
    FAKE = "fake"


class EmbedderMode(StrEnum):
    # Same values as book_core.embedding.EmbedderMode (shared with the API's query embedder).
    AUTO = "auto"
    QWEN3 = "qwen3"
    WORKERS_AI = "workers_ai"
    FAKE = "fake"


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
    # The worker's own least-privilege role (`quiz_worker`), never the API's DATABASE_URL.
    # Required in preview/production; locally it selects the Postgres JobStore unless
    # WORKER_JOB_STORE_PATH asks for the SQLite one.
    worker_database_url: SecretStr | None = Field(
        default=None, validation_alias="WORKER_DATABASE_URL"
    )
    db_pool_size: int = Field(default=5, ge=1, validation_alias="WORKER_DB_POOL_SIZE")
    db_connect_timeout_seconds: float = Field(
        default=5, gt=0, validation_alias="WORKER_DB_CONNECT_TIMEOUT_SECONDS"
    )

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
    # document.parse (Docling + embedding of a whole book) gets its own, longer limits (M7.4c):
    # a 300-page book took ~45 min on 8 slow vCPUs, far past the limits above, so it retried
    # until attempts ran out. Its lease and the broker visibility timeout follow these. The soft
    # limit cannot be disabled here (0 would fall back to the default soft limit).
    document_task_soft_time_limit_seconds: int = Field(
        default=6900, ge=1, validation_alias="WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS"
    )
    document_task_time_limit_seconds: int = Field(
        default=7200, ge=1, validation_alias="WORKER_DOCUMENT_TASK_TIME_LIMIT_SECONDS"
    )
    # A claim's lease outlives the hard time limit by this margin, so a live attempt is never
    # treated as abandoned while the worker could still be running it.
    lease_grace_seconds: int = Field(
        default=120, ge=1, validation_alias="WORKER_LEASE_GRACE_SECONDS"
    )
    # Replace a pool process after this many job tasks (0 = never) or once its resident memory
    # passes this many MB after a task (0 = off). Models (Docling, a local embedder) live in the
    # pool process, so recycling returns their memory between jobs (M7.4c). Maintenance tasks
    # (reconcile runs) do not count (WRK-RECYCLE, quiz_worker.recycle).
    max_tasks_per_child: int = Field(default=0, ge=0, validation_alias="WORKER_MAX_TASKS_PER_CHILD")
    max_memory_per_child_mb: int = Field(
        default=0, ge=0, validation_alias="WORKER_MAX_MEMORY_PER_CHILD_MB"
    )
    # CPU threads per pool process for Docling / torch / BLAS (quiz_worker.resources). Unset:
    # the container's CPU limit (cgroup quota), not the host's CPU count.
    num_threads: int | None = Field(default=None, ge=1, validation_alias="WORKER_NUM_THREADS")
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
    # Pending cleanups of failed/cancelled jobs: tries (with exponential backoff between
    # base and max delay) before the job is left flagged for an operator.
    cleanup_max_attempts: int = Field(
        default=8, ge=1, validation_alias="WORKER_CLEANUP_MAX_ATTEMPTS"
    )
    cleanup_base_delay_seconds: float = Field(
        default=60, ge=0, validation_alias="WORKER_CLEANUP_BASE_DELAY_SECONDS"
    )
    cleanup_max_delay_seconds: float = Field(
        default=3600, ge=0, validation_alias="WORKER_CLEANUP_MAX_DELAY_SECONDS"
    )
    # Run Celery beat inside the worker (`worker -B`) to schedule the reconciler. Reconciling
    # is safe to run concurrently, so several workers with embedded beat are tolerable.
    embedded_beat: bool = Field(default=True, validation_alias="WORKER_EMBEDDED_BEAT")
    # Local/test only: share job state between processes through a SQLite file (prefork
    # children, several local workers). Unset -> in-memory store (single process).
    job_store_path: str | None = Field(default=None, validation_alias="WORKER_JOB_STORE_PATH")

    # -- document.parse (M3.2b) ---------------------------------------------------------------
    # Private Storage (source PDFs, parsed artifacts) with the server-only secret key.
    supabase_url: str | None = Field(
        default=None, validation_alias=AliasChoices("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    )
    supabase_secret_key: SecretStr | None = Field(
        default=None, validation_alias="SUPABASE_SECRET_KEY"
    )
    storage_timeout_seconds: float = Field(
        default=60, gt=0, validation_alias="STORAGE_TIMEOUT_SECONDS"
    )
    qdrant_url: str | None = Field(default=None, validation_alias="QDRANT_URL")
    qdrant_api_key: SecretStr | None = Field(default=None, validation_alias="QDRANT_API_KEY")
    # Namespaces the document collections/alias (previews, test sessions); search must use the
    # same prefix.
    qdrant_collection_prefix: str = Field(
        default="", pattern=r"^[A-Za-z0-9_-]*$", validation_alias="QDRANT_COLLECTION_PREFIX"
    )
    # `auto`: fixture-truth FakeParser (Docling for unknown files) in APP_ENV=test, Docling
    # elsewhere. `fake` never loads models (unknown files fail); never use it in production.
    parser: ParserMode = Field(default=ParserMode.AUTO, validation_alias="WORKER_PARSER")
    # `auto`: FakeEmbedder in APP_ENV=test, Qwen3-Embedding elsewhere. `workers_ai`: the same
    # model on Cloudflare Workers AI (staging/production, M7.4b; sends chunk text to Cloudflare).
    embedder: EmbedderMode = Field(default=EmbedderMode.AUTO, validation_alias="WORKER_EMBEDDER")
    # Cloudflare Workers AI (WORKER_EMBEDDER=workers_ai). The token is server-only (api + worker,
    # never web): an account API token with Workers AI permission only.
    cloudflare_account_id: str | None = Field(
        default=None, validation_alias="CLOUDFLARE_ACCOUNT_ID"
    )
    cloudflare_api_token: SecretStr | None = Field(
        default=None, validation_alias="CLOUDFLARE_API_TOKEN"
    )
    cloudflare_ai_batch_size: int = Field(
        default=16, ge=1, le=100, validation_alias="CLOUDFLARE_AI_BATCH_SIZE"
    )
    cloudflare_ai_timeout_seconds: float = Field(
        default=30, gt=0, le=300, validation_alias="CLOUDFLARE_AI_TIMEOUT_SECONDS"
    )
    # Synthetic fixtures whose `*.truth.json` the test FakeParser serves by sha256.
    fixture_pdf_dir: str | None = Field(default=None, validation_alias="WORKER_FIXTURE_PDF_DIR")
    # Pre-downloaded model weights (Docling `artifacts_path`); with `models_offline` the worker
    # never contacts the Hugging Face Hub (HF_HUB_OFFLINE=1).
    models_artifacts_path: str | None = Field(
        default=None, validation_alias="WORKER_MODELS_ARTIFACTS_PATH"
    )
    models_offline: bool = Field(default=False, validation_alias="WORKER_MODELS_OFFLINE")
    # Load the Docling models in each prefork child right after it starts (background thread),
    # so the first document does not wait for them (UX3-JOB). Unset: on in preview/production
    # with the Docling parser, off elsewhere (tests and fake adapters never load models).
    warm_parser: bool | None = Field(default=None, validation_alias="WORKER_WARM_PARSER")
    # Input limits checked before parsing (docs/deployment.md §2 step 4).
    pdf_max_bytes: int = Field(
        default=50 * 1024 * 1024, ge=1, validation_alias="WORKER_PDF_MAX_BYTES"
    )
    pdf_max_pages: int = Field(default=1500, ge=1, validation_alias="WORKER_PDF_MAX_PAGES")
    # Docling stops converting after this many seconds (the document then fails as too slow);
    # must stay below the document task's soft time limit, leaving time for indexing.
    parse_timeout_seconds: float = Field(
        default=3600, gt=0, validation_alias="WORKER_PARSE_TIMEOUT_SECONDS"
    )
    # Docling memory bound (M7.4c): pages buffered between pipeline stages, and pages per
    # layout/table model batch. Docling's own default queue (100) grows with book length (about
    # 4.5 GB on a 300-page book); 8 keeps the parse near 2.6 GB at about the same speed.
    parse_queue_max_size: int = Field(
        default=8, ge=1, validation_alias="WORKER_PARSE_QUEUE_MAX_SIZE"
    )
    parse_page_batch_size: int = Field(
        default=4, ge=1, validation_alias="WORKER_PARSE_PAGE_BATCH_SIZE"
    )
    # How long a job waits for another job on the same document before retrying later.
    document_lock_wait_seconds: float = Field(
        default=60, ge=0, validation_alias="WORKER_DOCUMENT_LOCK_WAIT_SECONDS"
    )

    # -- question.import (M4.4a) --------------------------------------------------------------
    # Opt-in LLM refinement of extracted questions (needs LLM_API_KEY / LLM_MODEL; sends
    # question text to the provider, docs/deployment.md §6). Never used in APP_ENV=test.
    question_import_llm: bool = Field(default=False, validation_alias="WORKER_QUESTION_IMPORT_LLM")

    # -- question.generate (M6.2) ---------------------------------------------------------------
    # APP_ENV=test only: scripted LLM outputs (book_core ScenarioLLMClient); defaults to the
    # repository's tests/fixtures/llm/generation-scenarios.json. Ignored elsewhere (the provider
    # comes from LLM_API_KEY / LLM_MODEL).
    llm_scenario_file: str | None = Field(default=None, validation_alias="WORKER_LLM_SCENARIO_FILE")

    # -- document.summarize (DOCSUM-B) ----------------------------------------------------------
    # Off by default: on, opted-in books are summarized on every publish (their text goes to the
    # LLM provider; needs LLM_API_KEY / LLM_MODEL, or the APP_ENV=test fake). Set it on the API
    # too, which then offers `요약 만들기`.
    document_summary: bool = Field(default=False, validation_alias="WORKER_DOCUMENT_SUMMARY")
    # A chapter longer than this is summarized in parts that are then merged.
    summary_chapter_chars: int = Field(
        default=24_000, ge=200, validation_alias="WORKER_SUMMARY_CHAPTER_CHARS"
    )
    # A document over this fails `summary_too_large` without any LLM call.
    summary_max_input_chars: int = Field(
        default=1_500_000, ge=1, validation_alias="WORKER_SUMMARY_MAX_INPUT_CHARS"
    )

    # -- chapter_note.generate (CHNOTE-B) -------------------------------------------------------
    # Chapter notes send a chapter's questions, answers and explanations to the LLM provider
    # (needs LLM_API_KEY / LLM_MODEL outside APP_ENV=test). Off by default; the API reads the same
    # variable to refuse requests (409 note-generation-disabled).
    chapter_notes: bool = Field(default=False, validation_alias="WORKER_CHAPTER_NOTES")
    # APP_ENV=test only: scripted chapter note outputs (default: the repository's
    # tests/fixtures/llm/chapter-note-scenarios.json) and the E2E hold barrier directory
    # (default: <system temp dir>/quiz-e2e-chapter-note-hold). Ignored elsewhere.
    chapter_note_scenario_file: str | None = Field(
        default=None, validation_alias="WORKER_CHAPTER_NOTE_SCENARIO_FILE"
    )
    chapter_note_hold_dir: str | None = Field(
        default=None, validation_alias="WORKER_CHAPTER_NOTE_HOLD_DIR"
    )

    @model_validator(mode="after")
    def _check_limits(self) -> WorkerSettings:
        if self.task_soft_time_limit_seconds >= self.task_time_limit_seconds:
            raise ValueError("WORKER_TASK_SOFT_TIME_LIMIT_SECONDS must be below the hard limit")
        doc_soft = self.document_task_soft_time_limit_seconds
        doc_hard = self.document_task_time_limit_seconds
        if doc_soft >= doc_hard:
            raise ValueError(
                "WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS must be below the hard limit"
            )
        if self.parse_timeout_seconds >= doc_soft:
            raise ValueError(
                "WORKER_PARSE_TIMEOUT_SECONDS must be below the document task time limits"
            )
        if self.parse_page_batch_size > self.parse_queue_max_size:
            raise ValueError(
                "WORKER_PARSE_PAGE_BATCH_SIZE must not exceed WORKER_PARSE_QUEUE_MAX_SIZE"
            )
        deployed = self.app_env in {Environment.PREVIEW, Environment.PRODUCTION}
        if deployed and (self.parser is ParserMode.FAKE or self.embedder is EmbedderMode.FAKE):
            raise ValueError("fake parser/embedder adapters are for local and test runs only")
        return self

    @property
    def is_test(self) -> bool:
        return self.app_env is Environment.TEST

    @property
    def summary_available(self) -> bool:
        """Publishes start summaries: the switch is on and an LLM exists (the fake under
        APP_ENV=test, else LLM_API_KEY, read like book_core `LLMConfig.from_env`)."""
        if not self.document_summary:
            return False
        return self.is_test or bool(os.environ.get("LLM_API_KEY", "").strip())

    @property
    def warms_parser(self) -> bool:
        if self.warm_parser is not None:
            return self.warm_parser
        deployed = self.app_env in {Environment.PREVIEW, Environment.PRODUCTION}
        return deployed and self.parser is not ParserMode.FAKE

    @property
    def lease_seconds(self) -> int:
        """Lease of a job running under the default task time limits."""
        return self.task_time_limit_seconds + self.lease_grace_seconds

    @property
    def document_lease_seconds(self) -> int:
        """Lease of a document.parse attempt (its own, longer hard limit)."""
        return self.document_task_time_limit_seconds + self.lease_grace_seconds

    @property
    def max_lease_seconds(self) -> int:
        return max(self.lease_seconds, self.document_lease_seconds)

    @property
    def reconcile_stale_after(self) -> float:
        # Past every lease, so a deferred duplicate (countdown = lease left) is never raced.
        return self.reconcile_stale_after_seconds or float(self.max_lease_seconds)

    @property
    def broker_visibility_timeout_seconds(self) -> int:
        # Redis re-delivers unacked messages after this; keep it past any live lease.
        return self.max_lease_seconds + 60


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()
