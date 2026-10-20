"""WRK-RECYCLE: only job tasks count toward WORKER_MAX_TASKS_PER_CHILD.

Production ran `WORKER_MAX_TASKS_PER_CHILD=1`, and the beat-scheduled reconcile task (every
minute) replaced the pool child every minute, each new child warming the PDF parser up again
(`worker_process_init`, once per child). The prefork tests run a real worker against fakeredis'
TCP server and, marked `infra`, against the local Redis (separate DB and queue).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
import redis
from celery.contrib.testing.worker import start_worker
from celery.worker import state as worker_state
from fakeredis import TcpFakeServer
from quiz_worker import recycle
from quiz_worker.celery_app import (
    RECONCILE_TASK_NAME,
    QuizCelery,
    build_celery_config,
    create_celery_app,
    submit_job,
    task_name,
)
from quiz_worker.recycle import (
    EX_RECYCLE,
    POOL_CLS,
    JobTaskBudget,
    RecyclingAsynPool,
    RecyclingAsynPoolWorker,
    RecyclingBlockingPool,
    RecyclingBlockingPoolWorker,
    TaskPool,
    _RecyclingWorkerMixin,
)
from quiz_worker.settings import WorkerSettings, get_settings
from quiz_worker.store import InMemoryJobStore, JobRecord, JobStatus

from .conftest import EnvelopeFactory

# -- Unit: the per-child job task budget -----------------------------------------------------


@pytest.fixture(autouse=True)
def _fresh_budget() -> Iterator[None]:
    recycle.budget.reset()
    yield
    recycle.budget.reset()


def test_budget_never_asks_for_recycling_when_unlimited() -> None:
    budget = JobTaskBudget()
    for _ in range(100):
        budget.task_finished(0)

    assert (budget.finished, budget.recycle_requested) == (100, False)


def test_budget_asks_for_recycling_after_n_job_tasks() -> None:
    budget = JobTaskBudget()

    budget.task_finished(2)
    assert not budget.recycle_requested
    budget.task_finished(2)
    assert budget.recycle_requested


class _FakeBillardWorker:
    def _make_child_methods(self) -> None:
        self.wait_for_job = lambda: ("TASK", "job")


class _Worker(_RecyclingWorkerMixin, _FakeBillardWorker):
    pass


def test_child_keeps_taking_work_until_the_budget_is_spent() -> None:
    worker = _Worker()
    worker._make_child_methods()

    assert worker.wait_for_job() == ("TASK", "job")
    recycle.job_task_finished(1)
    with pytest.raises(SystemExit) as exited:
        worker.wait_for_job()
    assert exited.value.code == EX_RECYCLE


def test_worker_runs_the_recycling_prefork_pool() -> None:
    conf = build_celery_config(WorkerSettings.model_construct(task_always_eager=True))

    assert conf["worker_pool"] == POOL_CLS == "quiz_worker.recycle:TaskPool"
    assert conf["worker_max_tasks_per_child"] is None
    assert TaskPool.Pool is RecyclingAsynPool
    assert RecyclingAsynPool.Worker is RecyclingAsynPoolWorker
    assert TaskPool.BlockingPool is RecyclingBlockingPool
    assert RecyclingBlockingPool.Worker is RecyclingBlockingPoolWorker


def _app(max_tasks_per_child: int) -> QuizCelery:
    settings = WorkerSettings.model_construct(
        task_always_eager=True, max_tasks_per_child=max_tasks_per_child
    )
    return create_celery_app(settings, job_store=InMemoryJobStore())


def test_maintenance_tasks_never_count_toward_recycling() -> None:
    app = _app(max_tasks_per_child=1)
    reconcile = app.tasks[RECONCILE_TASK_NAME]

    for _ in range(5):
        # Direct call: runs the task body as a worker child does (not eager).
        reconcile()

    assert (recycle.budget.finished, recycle.budget.recycle_requested) == (0, False)


def test_job_tasks_count_toward_recycling_even_when_they_fail(
    make_envelope: EnvelopeFactory,
) -> None:
    app = _app(max_tasks_per_child=2)
    echo = app.tasks[task_name("echo")]

    envelope = make_envelope(payload={"message": "ok"})
    app.job_store.create(envelope, max_attempts=3)

    assert echo(envelope.to_message()) == {"job_id": str(envelope.job_id), "outcome": "succeeded"}
    assert not recycle.budget.recycle_requested
    with pytest.raises(Exception):  # noqa: B017, PT011 - any failure still counts
        echo({"job_id": str(uuid4()), "job_type": "echo"})

    assert (recycle.budget.finished, recycle.budget.recycle_requested) == (2, True)


def test_eager_job_tasks_do_not_count(make_envelope: EnvelopeFactory) -> None:
    app = _app(max_tasks_per_child=1)

    app.tasks[task_name("echo")].apply_async(args=(make_envelope().to_message(),))

    assert recycle.budget.finished == 0


# -- Real prefork worker -----------------------------------------------------------------------


def _infra_unavailable(reason: str) -> None:
    if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
        pytest.fail(f"{reason} (QUIZ_REQUIRE_INFRA=1: run `make infra-up`)")
    pytest.skip(f"{reason}; run `make infra-up`")


@pytest.fixture
def fake_redis_url() -> Iterator[str]:
    server = TcpFakeServer(("127.0.0.1", 0))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"redis://127.0.0.1:{server.server_address[1]}/0"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def local_redis_url() -> str:
    # A DB of its own on the shared local Redis; the queue name is per test as well.
    url = os.environ.get("QUIZ_TEST_REDIS_URL", "redis://127.0.0.1:6379/13")
    try:
        redis.Redis.from_url(url, socket_connect_timeout=2).ping()
    except redis.RedisError:
        _infra_unavailable("local Redis is not reachable")
    return url


@pytest.fixture(params=["fakeredis", pytest.param("redis", marks=pytest.mark.infra)])
def redis_url(request: pytest.FixtureRequest) -> str:
    name = "fake_redis_url" if request.param == "fakeredis" else "local_redis_url"
    url: str = request.getfixturevalue(name)
    return url


def _prefork_app(redis_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> QuizCelery:
    # Prefork children rebuild the app from the environment, so state goes through SQLite.
    for name, value in {
        "APP_ENV": "test",
        "REDIS_URL": redis_url,
        "WORKER_JOB_STORE_PATH": str(tmp_path / "jobs.sqlite3"),
        "WORKER_TASK_ALWAYS_EAGER": "false",
        "WORKER_MAX_TASKS_PER_CHILD": "1",
        "WORKER_MAX_MEMORY_PER_CHILD_MB": "0",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    try:
        app = create_celery_app(get_settings())
    finally:
        get_settings.cache_clear()
    # The parent publishes and consumes; children only run tasks.
    app.conf.task_default_queue = f"wrk-recycle-test-{uuid4().hex}"
    return app


class _PoolWatch:
    """Every pool child PID the worker has had (each child warms the parser up once), and the
    child each task ran in. Reads only the worker's in-memory state, never the job store: a
    pool child forked while another thread of this process is inside a SQLite call inherits
    SQLite's lock bookkeeping and can wait on that lock forever (Linux forks)."""

    def __init__(self, worker: Any) -> None:
        self._worker = worker
        self.pids: set[int] = set()
        self.task_pids: dict[str, int] = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def current(self) -> set[int]:
        info: Any = self._worker.pool.info  # a property at runtime
        # A child that is still starting has no PID yet.
        current = {int(pid) for pid in info["processes"] if pid is not None}
        self.pids |= current
        return current

    def _sample_tasks(self) -> None:
        try:
            active = list(worker_state.active_requests)
        except RuntimeError:  # changed size while the worker thread updates it
            return
        for request in active:
            if request.worker_pid is not None:
                self.task_pids.setdefault(request.id, int(request.worker_pid))

    def _run(self) -> None:
        while not self._stop.is_set():
            self.current()
            self._sample_tasks()
            time.sleep(0.01)

    def __enter__(self) -> _PoolWatch:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()
        self.current()


def _wait(predicate: Callable[[], bool], what: str, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.02)


def _idle() -> bool:
    return not worker_state.active_requests and not worker_state.reserved_requests


def _records(app: QuizCelery, job_ids: list[UUID]) -> list[JobRecord | None]:
    return [app.job_store.get(job_id) for job_id in job_ids]


def _cleanup_redis(app: QuizCelery, job_ids: list[UUID]) -> None:
    with app.connection_for_write() as conn:
        channel: Any = conn.default_channel
        queue = app.conf.task_default_queue
        meta = (f"celery-task-meta-{job_id}" for job_id in job_ids)
        channel.client.delete(queue, f"_kombu.binding.{queue}", *meta)


def test_maintenance_tasks_keep_the_child_and_job_tasks_replace_it(
    redis_url: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    make_envelope: EnvelopeFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING)
    app = _prefork_app(redis_url, tmp_path, monkeypatch)
    pool_cls = app.conf.worker_pool
    reconciles = 12
    # Each job runs long enough for the watch to see which child runs it.
    payloads = [{"message": f"job {i}", "delay_seconds": 0.5} for i in range(3)]
    envelopes = [make_envelope(payload=payload) for payload in payloads]
    job_ids = [e.job_id for e in envelopes]
    reconcile_before = worker_state.total_count.get(RECONCILE_TASK_NAME, 0)
    echo_before = worker_state.total_count.get(task_name("echo"), 0)

    try:
        with (
            start_worker(
                app, pool=pool_cls, concurrency=1, perform_ping_check=False, shutdown_timeout=10
            ) as worker,
            _PoolWatch(worker) as watch,
        ):
            first_child = watch.current()
            assert len(first_child) == 1

            # Many maintenance tasks (beat's reconcile): the same child runs all of them.
            for _ in range(reconciles):
                app.tasks[RECONCILE_TASK_NAME].delay()
            _wait(
                lambda: (
                    worker_state.total_count.get(RECONCILE_TASK_NAME, 0) - reconcile_before
                    == reconciles
                    and _idle()
                ),
                "the reconcile tasks",
            )
            assert watch.current() == first_child
            assert watch.pids == first_child

            # Job tasks with WORKER_MAX_TASKS_PER_CHILD=1: a new child after each one. All are
            # queued at once, so a job written to a child that is about to exit is exercised too.
            # The submits' store writes end long before the first job (0.5 s) ends and a child is
            # forked; until the worker stops, this process reads no store (see _PoolWatch).
            for envelope in envelopes:
                submit_job(app, envelope)
            _wait(
                lambda: (
                    worker_state.total_count.get(task_name("echo"), 0) - echo_before == len(job_ids)
                    and _idle()
                ),
                "the jobs",
            )
            job_pids = [watch.task_pids[str(job_id)] for job_id in job_ids]
            # The last child exits once its job is stored; wait for its replacement.
            _wait(
                lambda: len(watch.current()) == 1 and watch.current().isdisjoint(job_pids),
                "the replacement of the last job's child",
            )
            final_child = watch.current()
    finally:
        _cleanup_redis(app, job_ids)

    records = _records(app, job_ids)
    # Each job ran once, in its own child, and succeeded: no WorkerLostError, no re-delivery.
    assert [(r.status, r.attempts, r.last_error) if r else None for r in records] == [
        (JobStatus.SUCCEEDED, 1, None)
    ] * len(job_ids)
    assert len(set(job_pids)) == len(job_ids)
    assert job_pids[0] in first_child
    assert final_child.isdisjoint(job_pids)
    # One child per job plus the one that is waiting for the next: nothing else was started.
    assert watch.pids == first_child | set(job_pids) | final_child
    assert worker_state.total_count.get(task_name("echo"), 0) - echo_before == len(job_ids)
    problems = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert not [m for m in problems if "WorkerLost" in m or "exited with" in m], problems
