"""WRK-FORKDB: forked pool children never share the main process's pooled DB connections.

The worker's main process settles a lost attempt through the job store (`release_lost`) and
then forks the replacement child (Linux). Without `dispose_inherited_engines` in
`worker_process_init`, that child would inherit the pooled connection, i.e. the parent's server
socket. The infra test forks explicitly (also on macOS) against the local Postgres.
"""

from __future__ import annotations

import gc
import multiprocessing
import weakref
from multiprocessing.connection import Connection
from typing import Any

import pytest
from celery import signals
from quiz_worker import pg_store
from quiz_worker.celery_app import FORK_SAFETY_UID, create_celery_app
from quiz_worker.jobs import ECHO_JOB
from quiz_worker.pg_store import (
    PostgresJobStore,
    create_job_store_engine,
    dispose_inherited_engines,
)
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError

from .conftest import ADMIN_DATABASE_URL, _infra_unavailable

# Never connected to: the unit tests only build engines (no connection is opened on create).
UNREACHABLE_URL = "postgresql://quiz:unused@127.0.0.1:1/quiz"


@pytest.fixture(autouse=True)
def _own_engine_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only this test's engines: the hook must not drop other tests' pooled connections."""
    monkeypatch.setattr(pg_store, "_ENGINES", weakref.WeakSet())


def _record_dispose(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    calls: list[bool] = []
    monkeypatch.setattr(engine, "dispose", lambda close=True: calls.append(close))
    return calls


def test_dispose_inherited_engines_keeps_the_parents_connections_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = create_job_store_engine(UNREACHABLE_URL)
    second = create_job_store_engine(UNREACHABLE_URL, pool_size=1)
    first_calls = _record_dispose(first, monkeypatch)
    second_calls = _record_dispose(second, monkeypatch)

    assert dispose_inherited_engines() == 2

    assert first_calls == [False]
    assert second_calls == [False]


def test_dropped_engines_are_not_kept_alive() -> None:
    engine = create_job_store_engine(UNREACHABLE_URL)
    assert engine in pg_store._ENGINES
    ref = weakref.ref(engine)
    del engine
    gc.collect()
    assert ref() is None


def test_worker_process_init_disposes_the_job_store_engine(
    eager_settings: WorkerSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = create_job_store_engine(UNREACHABLE_URL)
    calls = _record_dispose(engine, monkeypatch)
    app = create_celery_app(
        eager_settings, job_store=PostgresJobStore(engine), definitions=[ECHO_JOB]
    )
    assert app.job_store is not None

    # What billiard's child does once it starts (Celery's process_initializer).
    signals.worker_process_init.send(sender=None)

    assert calls == [False]


def test_fork_safety_hook_is_connected_once(eager_settings: WorkerSettings) -> None:
    for _ in range(2):
        create_celery_app(eager_settings, job_store=InMemoryJobStore(), definitions=[ECHO_JOB])
    uids = [key[0] for key, _ in signals.worker_process_init.receivers]
    assert uids.count(FORK_SAFETY_UID) == 1


# -- Infra: a real fork against the local Postgres ---------------------------------------------

_BACKEND_PID = text("select pg_backend_pid()")


def _backend_pid(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(conn.execute(_BACKEND_PID).scalar_one())


def _child(engine: Engine, dispose: bool, out: Connection) -> None:
    try:
        if dispose:
            dispose_inherited_engines()
        # Two queries: the second checks the child's own pool keeps working.
        out.send(("ok", _backend_pid(engine), _backend_pid(engine)))
    except BaseException as exc:  # reported to the parent
        out.send(("error", type(exc).__name__, None))
    finally:
        out.close()


def _run_forked_child(engine: Engine, *, dispose: bool) -> tuple[Any, ...]:
    ctx = multiprocessing.get_context("fork")  # forced: macOS defaults to spawn, Linux forks
    receive, send = ctx.Pipe(duplex=False)
    child = ctx.Process(target=_child, args=(engine, dispose, send))
    child.start()
    send.close()
    try:
        if not receive.poll(30):
            raise AssertionError("forked child did not report")
        result: tuple[Any, ...] = receive.recv()
    finally:
        child.join(30)
        if child.is_alive():
            child.kill()
            child.join()
        receive.close()
    assert child.exitcode == 0
    return result


@pytest.fixture
def pooled_engine() -> Any:
    engine = create_job_store_engine(ADMIN_DATABASE_URL, pool_size=1)
    try:
        _backend_pid(engine)
    except OperationalError:
        engine.dispose()
        _infra_unavailable("local Postgres is not reachable")
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.mark.infra
def test_forked_child_opens_its_own_connection(pooled_engine: Engine) -> None:
    parent_pid = _backend_pid(pooled_engine)  # the connection now sits in the parent's pool

    status, first, second = _run_forked_child(pooled_engine, dispose=True)

    assert status == "ok", first
    assert first == second  # the child's own pool reuses its connection
    assert first != parent_pid
    # The child dropped the inherited connection without closing it: same session here.
    assert _backend_pid(pooled_engine) == parent_pid


@pytest.mark.infra
def test_forked_child_without_the_hook_shares_the_parents_session(pooled_engine: Engine) -> None:
    """Control for the test above: what the hook prevents."""
    parent_pid = _backend_pid(pooled_engine)

    status, first, _ = _run_forked_child(pooled_engine, dispose=False)

    assert status == "ok", first
    assert first == parent_pid
