"""M7.4c: worker memory and time limits (Docling page queue, threads, per-job time limits)."""

from __future__ import annotations

from typing import Any

import pytest
import qdrant_client
from pydantic import ValidationError
from quiz_worker.adapters import build_index_store, parser_options
from quiz_worker.celery_app import (
    build_celery_config,
    cleanup_policy_for,
    create_celery_app,
    job_time_limits,
    submit_job,
    task_name,
)
from quiz_worker.document_job import JOB_TYPE as DOCUMENT_PARSE_JOB_TYPE
from quiz_worker.jobs import EchoPayloadV1
from quiz_worker.runner import JobContext, JobDefinition, JobResult
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore

from .conftest import EnvelopeFactory


def _settings(**env: str) -> WorkerSettings:
    return WorkerSettings.model_validate(env)


def test_docling_page_queue_is_bounded_by_default() -> None:
    options = parser_options(_settings())

    assert options.queue_max_size == 8
    assert options.page_batch_size == 4


def test_docling_page_queue_and_batch_are_configurable() -> None:
    options = parser_options(
        _settings(WORKER_PARSE_QUEUE_MAX_SIZE="4", WORKER_PARSE_PAGE_BATCH_SIZE="2")
    )

    assert (options.queue_max_size, options.page_batch_size) == (4, 2)


def test_page_batch_cannot_exceed_the_queue() -> None:
    with pytest.raises(ValidationError, match="WORKER_PARSE_PAGE_BATCH_SIZE"):
        _settings(WORKER_PARSE_QUEUE_MAX_SIZE="2", WORKER_PARSE_PAGE_BATCH_SIZE="4")


def test_worker_index_store_does_not_load_the_embedding_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # deps_from_settings builds the index store before parsing; with the local Qwen3 embedder
    # that used to load ~3 GB of weights just to learn the vector size.
    from book_core.embedding import qwen3

    def refuse(config: object) -> None:
        raise AssertionError("embedding weights loaded while building the index store")

    monkeypatch.setattr(qwen3, "_TransformersBackend", refuse)
    # No client-server version probe against the unreachable URL.
    monkeypatch.setattr(qdrant_client, "QdrantClient", lambda **kwargs: object())
    store = build_index_store(
        _settings(APP_ENV="local", WORKER_EMBEDDER="qwen3", QDRANT_URL="http://127.0.0.1:1")
    )

    assert store.collection_metadata()["dimension"] == 1024


# -- Time limits and leases per job type ---------------------------------------------------------


def test_document_parse_runs_under_its_own_longer_limits() -> None:
    settings = _settings()
    document = job_time_limits(settings, DOCUMENT_PARSE_JOB_TYPE)
    other = job_time_limits(settings, "echo")

    assert (document.soft_seconds, document.hard_seconds) == (6900, 7200)
    assert (other.soft_seconds, other.hard_seconds) == (1500, 1800)
    for limits in (document, other):
        assert limits.soft_seconds is not None
        assert limits.soft_seconds < limits.hard_seconds
        assert limits.lease_seconds == limits.hard_seconds + settings.lease_grace_seconds
    assert document.soft_seconds is not None
    assert settings.parse_timeout_seconds < document.soft_seconds


def test_registered_tasks_carry_their_job_type_limits(eager_settings: WorkerSettings) -> None:
    app = create_celery_app(eager_settings, job_store=InMemoryJobStore())
    parse = app.tasks[task_name(DOCUMENT_PARSE_JOB_TYPE)]
    echo = app.tasks[task_name("echo")]

    assert (parse.soft_time_limit, parse.time_limit) == (6900, 7200)
    assert (echo.soft_time_limit, echo.time_limit) == (1500, 1800)


def test_broker_reconciler_and_cleanup_outlast_the_longest_lease() -> None:
    settings = _settings(
        WORKER_DOCUMENT_TASK_TIME_LIMIT_SECONDS="9000",
        WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS="8000",
    )
    conf = build_celery_config(settings.model_copy(update={"task_always_eager": True}))

    assert settings.max_lease_seconds == 9000 + settings.lease_grace_seconds
    assert conf["broker_transport_options"]["visibility_timeout"] > settings.max_lease_seconds
    assert settings.reconcile_stale_after == settings.max_lease_seconds
    assert cleanup_policy_for(settings).lease_seconds == settings.max_lease_seconds


def test_a_document_attempt_is_leased_for_the_document_limit(
    eager_settings: WorkerSettings, make_envelope: EnvelopeFactory
) -> None:
    store = InMemoryJobStore()
    leases: list[float] = []

    def handler(ctx: JobContext, payload: EchoPayloadV1) -> JobResult:
        record = store.get(ctx.job_id)
        assert record is not None
        assert record.lease_expires_at is not None
        leases.append((record.lease_expires_at - record.updated_at).total_seconds())
        return None

    definitions: list[JobDefinition[Any]] = [
        JobDefinition(job_type=job_type, payload_models={1: EchoPayloadV1}, handler=handler)
        for job_type in (DOCUMENT_PARSE_JOB_TYPE, "echo")
    ]
    app = create_celery_app(eager_settings, job_store=store, definitions=definitions)
    for job_type in (DOCUMENT_PARSE_JOB_TYPE, "echo"):
        submit_job(app, make_envelope(job_type, {"message": "m"}))

    assert leases == [eager_settings.document_lease_seconds, eager_settings.lease_seconds]


@pytest.mark.parametrize(
    ("env", "message"),
    [
        (
            {
                "WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS": "600",
                "WORKER_DOCUMENT_TASK_TIME_LIMIT_SECONDS": "600",
            },
            "WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS",
        ),
        (
            {"WORKER_PARSE_TIMEOUT_SECONDS": "6900"},
            "WORKER_PARSE_TIMEOUT_SECONDS",
        ),
        (
            # A disabled soft limit would fall back to the (shorter) default one.
            {"WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS": "0"},
            "WORKER_DOCUMENT_TASK_SOFT_TIME_LIMIT_SECONDS",
        ),
    ],
)
def test_document_limits_are_validated(env: dict[str, str], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        _settings(**env)
