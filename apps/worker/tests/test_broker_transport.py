"""Real Celery worker over kombu's Redis transport (redis-py 8), against fakeredis' TCP server.

Covers what eager mode cannot: the JSON wire format, `argsrepr` hiding the envelope from
Celery's logs/events, late ack, broker-published retries, and a worker consuming and
completing a job end to end.
"""

from __future__ import annotations

import base64
import json
import os
import signal
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from celery.contrib.testing.worker import start_worker
from celery.worker import state as worker_state
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
    LEASE_EXPIRED_ERROR,
    TERMINAL_STATUSES,
    WORKER_KILLED_ERROR,
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


def _wait_for_idle_worker(timeout: float = 15) -> None:
    # The store turns terminal inside the attempt that claims the job, before that request has
    # reported back to the worker. Leaving `start_worker` then cold-terminates the pool with a
    # child still mid-request, and on a loaded runner that child can outlive `shutdown_timeout`
    # (billiard joins it without a timeout). Shut down only once the worker holds no requests.
    deadline = time.monotonic() + timeout
    while worker_state.active_requests or worker_state.reserved_requests:
        if time.monotonic() >= deadline:
            raise AssertionError(f"worker still busy after {timeout}s")
        time.sleep(0.05)


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
        # Every last_error the row shows on its way (each stays until the next transition).
        seen: set[str | None] = set()

        def finished(record: JobRecord) -> bool:
            seen.add(record.last_error)
            return record.status in TERMINAL_STATUSES

        record = _wait_for(store, envelope.job_id, finished, timeout=60)
        _wait_for_idle_worker()

    assert record.status is JobStatus.FAILED
    assert record.attempts == record.max_attempts == 3
    assert record.last_error == WORKER_LOST_ERROR
    # M7.4c: the hard-limit callback fires before billiard kills the child, so the worker must not
    # settle the attempt then (a re-delivery could run beside the still-living child); the next
    # attempts come through the expired lease instead.
    assert LEASE_EXPIRED_ERROR in seen
    assert WORKER_KILLED_ERROR not in seen


def test_killed_worker_process_is_retried_without_waiting_for_the_lease(
    redis_server: TcpFakeServer,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    make_envelope: EnvelopeFactory,
) -> None:
    # M7.4c: an OOM kill (SIGKILL) of the prefork child used to leave the job `running` until the
    # lease (here 20 min) expired. The worker now settles the attempt when it sees the child die,
    # and the re-queued message starts attempt 2 at once.
    port = redis_server.server_address[1]
    for name, value in {
        "APP_ENV": "test",
        "REDIS_URL": f"redis://127.0.0.1:{port}/0",
        "WORKER_JOB_STORE_PATH": str(tmp_path / "jobs.sqlite3"),
        "WORKER_TASK_TIME_LIMIT_SECONDS": "600",
        "WORKER_TASK_SOFT_TIME_LIMIT_SECONDS": "0",
        "WORKER_LEASE_GRACE_SECONDS": "600",
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
    envelope = make_envelope(payload={"message": "oom", "delay_seconds": 3})

    with start_worker(
        app, pool="prefork", concurrency=1, perform_ping_check=False, shutdown_timeout=10
    ) as worker:
        submit_job(app, envelope)
        running = _wait_for(store, envelope.job_id, lambda r: r.status is JobStatus.RUNNING)
        assert running.locked_by is not None
        pid = int(running.locked_by.rsplit(":", 1)[1])
        # Only ever signal this worker's own pool child.
        assert worker.pool is not None
        pool_info: Any = worker.pool.info  # a property at runtime
        assert pid in pool_info["processes"]
        os.kill(pid, signal.SIGKILL)
        record = _wait_for_terminal(store, envelope.job_id, timeout=60)
        _wait_for_idle_worker()

    assert (record.status, record.attempts) == (JobStatus.SUCCEEDED, 2)
    assert record.last_error == WORKER_KILLED_ERROR


def _wait_for(
    store: TransactionalJobStore,
    job_id: UUID,
    predicate: Callable[[JobRecord], bool],
    timeout: float = 30,
) -> JobRecord:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = store.get(job_id)
        if record is not None and predicate(record):
            return record
        time.sleep(0.02)
    raise AssertionError(f"job did not reach the state within {timeout}s: {store.get(job_id)}")
