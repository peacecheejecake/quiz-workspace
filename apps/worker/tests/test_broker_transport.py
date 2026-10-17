"""Real Celery worker over kombu's Redis transport (redis-py 8), against fakeredis' TCP server.

Covers what eager mode cannot: the JSON wire format, `argsrepr` hiding the envelope from
Celery's logs/events, late ack, broker-published retries, and a worker consuming and
completing a job end to end.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from celery.contrib.testing.worker import start_worker
from fakeredis import TcpFakeServer
from pydantic import SecretStr
from quiz_worker.celery_app import (
    DEFAULT_QUEUE,
    QuizCelery,
    create_celery_app,
    submit_job,
    task_name,
)
from quiz_worker.jobs import EchoPayloadV1
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult
from quiz_worker.settings import WorkerSettings, get_settings
from quiz_worker.store import (
    TERMINAL_STATUSES,
    WORKER_LOST_ERROR,
    JobRecord,
    JobStatus,
    SqliteJobStore,
    TransactionalJobStore,
)

from .conftest import BOOK_TEXT, EnvelopeFactory


@pytest.fixture
def redis_server() -> Iterator[TcpFakeServer]:
    server = TcpFakeServer(("127.0.0.1", 0))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def _settings(server: TcpFakeServer) -> WorkerSettings:
    port = server.server_address[1]
    return WorkerSettings.model_construct(redis_url=SecretStr(f"redis://127.0.0.1:{port}/0"))


@pytest.fixture
def broker_app(redis_server: TcpFakeServer, store: TransactionalJobStore) -> QuizCelery:
    return create_celery_app(_settings(redis_server), job_store=store)


def _queued_messages(app: QuizCelery) -> list[dict[str, Any]]:
    with app.connection_for_write() as conn:
        channel: Any = conn.default_channel
        return [json.loads(raw) for raw in channel.client.lrange(DEFAULT_QUEUE, 0, -1)]


def _wait_for_terminal(
    store: TransactionalJobStore, job_id: UUID, timeout: float = 15
) -> JobRecord:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = store.get(job_id)
        if record is not None and record.status in TERMINAL_STATUSES:
            return record
        time.sleep(0.05)
    raise AssertionError(f"job did not finish within {timeout}s: {store.get(job_id)}")


def test_messages_are_json_and_hide_the_envelope_from_celery_logs(
    broker_app: QuizCelery, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope()

    submit_job(broker_app, envelope)

    [message] = _queued_messages(broker_app)
    assert message["content-type"] == "application/json"
    headers = message["headers"]
    assert headers["id"] == str(envelope.job_id)
    assert headers["argsrepr"] == f"(<job {envelope.job_id}>,)"
    assert BOOK_TEXT not in json.dumps(headers)
    args, kwargs, _ = json.loads(base64.b64decode(message["body"]))
    assert args == [envelope.to_message()]
    assert kwargs == {}


def test_every_publish_hides_the_envelope_even_without_argsrepr(
    broker_app: QuizCelery, make_envelope: EnvelopeFactory
) -> None:
    # Celery's own retry re-publishes without carrying argsrepr over; the task base must
    # still replace it.
    envelope = make_envelope()
    task = broker_app.tasks[task_name("echo")]

    task.apply_async(args=(envelope.to_message(),))
    task.apply_async(args=({"job_id": BOOK_TEXT},))

    messages = _queued_messages(broker_app)
    assert all(BOOK_TEXT not in json.dumps(m["headers"]) for m in messages)
    assert {m["headers"]["argsrepr"] for m in messages} == {
        f"(<job {envelope.job_id}>,)",
        "(<job ?>,)",
    }


def test_worker_consumes_and_completes_a_job(
    broker_app: QuizCelery, store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    envelope = make_envelope(payload={"message": "over the wire"})

    with start_worker(broker_app, pool="solo", perform_ping_check=False, shutdown_timeout=10):
        submit_job(broker_app, envelope)
        record = _wait_for_terminal(store, envelope.job_id)

    assert record.status is JobStatus.SUCCEEDED
    assert record.result == {"length": len("over the wire")}
    assert _queued_messages(broker_app) == []


def test_worker_retries_a_transient_failure_over_the_broker(
    redis_server: TcpFakeServer, store: TransactionalJobStore, make_envelope: EnvelopeFactory
) -> None:
    attempts: list[int] = []

    def handler(ctx: JobContext, payload: EchoPayloadV1) -> JobResult:
        attempts.append(ctx.attempt)
        if ctx.attempt == 1:
            raise RuntimeError(f"transient failure near {payload.message}")
        return {"attempt": ctx.attempt}

    flaky: JobDefinition[EchoPayloadV1] = JobDefinition(
        job_type="test.flaky",
        payload_models={1: EchoPayloadV1},
        handler=handler,
        retry_policy=RetryPolicy(max_attempts=2, base_delay_seconds=0, max_delay_seconds=0),
    )
    app = create_celery_app(_settings(redis_server), job_store=store, definitions=[flaky])
    envelope = make_envelope("test.flaky")

    with start_worker(app, pool="solo", perform_ping_check=False, shutdown_timeout=10):
        submit_job(app, envelope)
        record = _wait_for_terminal(store, envelope.job_id)

    assert attempts == [1, 2]
    assert (record.status, record.attempts) == (JobStatus.SUCCEEDED, 2)
    assert record.last_error == "unexpected_error: RuntimeError"


def test_hard_time_limit_never_leaves_a_job_running(
    redis_server: TcpFakeServer,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    make_envelope: EnvelopeFactory,
) -> None:
    # A real prefork child is killed by the hard time limit on every attempt. Its message is
    # re-queued (acks_on_failure_or_timeout=False), deferred until the lease expires and
    # re-claimed until max_attempts, so the job ends failed instead of staying `running`.
    # Prefork children rebuild the app from the environment, so state goes through SQLite.
    port = redis_server.server_address[1]
    for name, value in {
        "APP_ENV": "test",
        "REDIS_URL": f"redis://127.0.0.1:{port}/0",
        "WORKER_JOB_STORE_PATH": str(tmp_path / "jobs.sqlite3"),
        "WORKER_TASK_TIME_LIMIT_SECONDS": "2",
        "WORKER_TASK_SOFT_TIME_LIMIT_SECONDS": "0",
        "WORKER_LEASE_GRACE_SECONDS": "1",
        "WORKER_TASK_ALWAYS_EAGER": "false",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    try:
        app = create_celery_app(get_settings())
    finally:
        get_settings.cache_clear()
    store = app.job_store
    assert isinstance(store, SqliteJobStore)
    envelope = make_envelope(payload={"message": "slow", "delay_seconds": 30})

    with start_worker(
        app, pool="prefork", concurrency=1, perform_ping_check=False, shutdown_timeout=10
    ):
        submit_job(app, envelope)
        record = _wait_for_terminal(store, envelope.job_id, timeout=60)

    assert record.status is JobStatus.FAILED
    assert record.attempts == record.max_attempts == 3
    assert record.last_error == WORKER_LOST_ERROR
