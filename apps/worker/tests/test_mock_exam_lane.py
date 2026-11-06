"""MOCK-01-C11: a mock exam generation is not held back by a long extraction.

A real Celery worker over kombu's Redis transport (fakeredis), reading the queues of one worker
process of a deployment, with the job types' real routing and fake handlers: `question.import`
holds the default process's only slot until the test releases it.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID

import pytest
from celery.contrib.testing.worker import start_worker
from fakeredis import TcpFakeServer
from pydantic import SecretStr
from quiz_worker.celery_app import (
    ONDEMAND_QUEUE,
    QuizCelery,
    build_celery_config,
    create_celery_app,
    queue_for,
    submit_job,
    task_name,
    worker_queues,
)
from quiz_worker.jobs import EchoPayloadV1
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import JobRecord, JobStatus, TransactionalJobStore

from .conftest import EnvelopeFactory, read_between_forks

EXTRACTION = "question.import"
MOCK = "mock_exam.generate"


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


class Scene:
    """A store and broker for a worker that runs the fake jobs."""

    def __init__(self, server: TcpFakeServer, store: TransactionalJobStore) -> None:
        self.server = server
        self.store = store
        self.extraction_started = threading.Event()
        self.release_extraction = threading.Event()

    def _definitions(self) -> list[JobDefinition[Any]]:
        def extraction(ctx: JobContext, payload: EchoPayloadV1) -> JobResult:
            self.extraction_started.set()
            assert self.release_extraction.wait(30)
            return {}

        def generation(ctx: JobContext, payload: EchoPayloadV1) -> JobResult:
            return {}

        policy = RetryPolicy(max_attempts=1, base_delay_seconds=0, max_delay_seconds=0)
        return [
            JobDefinition(EXTRACTION, {1: EchoPayloadV1}, extraction, policy),
            JobDefinition(MOCK, {1: EchoPayloadV1}, generation, policy),
        ]

    def app(self) -> QuizCelery:
        port = self.server.server_address[1]
        settings = WorkerSettings.model_construct(
            redis_url=SecretStr(f"redis://127.0.0.1:{port}/0")
        )
        return create_celery_app(settings, job_store=self.store, definitions=self._definitions())

    def wait_for(self, job_id: UUID, predicate: Callable[[JobRecord], bool]) -> JobRecord:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            record = read_between_forks(lambda: self.store.get(job_id))
            if record is not None and predicate(record):
                return record
            time.sleep(0.02)
        raise AssertionError(f"job did not reach the state: {self.store.get(job_id)}")


@pytest.fixture
def scene(redis_server: TcpFakeServer, store: TransactionalJobStore) -> Iterator[Scene]:
    made = Scene(redis_server, store)
    yield made
    made.release_extraction.set()


def _worker(app: QuizCelery, *, interactive: bool) -> Any:
    return start_worker(
        app,
        pool="solo",
        queues=worker_queues(interactive=interactive),
        perform_ping_check=False,
        shutdown_timeout=10,
    )


def test_mock_exam_c11_generation_is_routed_past_the_default_queue() -> None:
    assert queue_for(MOCK) == ONDEMAND_QUEUE
    assert queue_for(EXTRACTION) != ONDEMAND_QUEUE
    config = build_celery_config(WorkerSettings.model_construct(task_always_eager=True))
    assert config["task_routes"][task_name(MOCK)] == {"queue": ONDEMAND_QUEUE}
    assert ONDEMAND_QUEUE in worker_queues(interactive=False)
    assert ONDEMAND_QUEUE in worker_queues(interactive=True)


def test_mock_exam_c11_interactive_process_runs_generation_and_leaves_the_extraction(
    scene: Scene, make_envelope: EnvelopeFactory
) -> None:
    # One worker per test process (workers in one process share kombu's event loop): the default
    # process stays out of this test, as busy with its one slot as the next test shows it.
    interactive = scene.app()
    extraction = make_envelope(EXTRACTION, {"message": "book"})
    generation = make_envelope(MOCK, {"message": "exam"})

    with _worker(interactive, interactive=True):
        submit_job(interactive, extraction)
        submit_job(interactive, generation)

        scene.wait_for(generation.job_id, lambda r: r.status is JobStatus.SUCCEEDED)

    waiting = read_between_forks(lambda: scene.store.get(extraction.job_id))
    assert waiting is not None
    assert waiting.status is JobStatus.QUEUED
    assert not scene.extraction_started.is_set()


def test_mock_exam_c11_alone_on_a_busy_process_generation_waits_queued_then_runs(
    scene: Scene, make_envelope: EnvelopeFactory
) -> None:
    default = scene.app()
    extraction = make_envelope(EXTRACTION, {"message": "book"})
    generation = make_envelope(MOCK, {"message": "exam"})

    with _worker(default, interactive=False):
        submit_job(default, extraction)
        assert scene.extraction_started.wait(20)
        submit_job(default, generation)
        time.sleep(1)

        # The state the screen shows as waiting: nothing failed and nothing was lost.
        waiting = read_between_forks(lambda: scene.store.get(generation.job_id))
        assert waiting is not None
        assert (waiting.status, waiting.attempts) == (JobStatus.QUEUED, 0)

        scene.release_extraction.set()
        done = scene.wait_for(generation.job_id, lambda r: r.status is JobStatus.SUCCEEDED)

    assert done.attempts == 1
