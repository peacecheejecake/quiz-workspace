"""PERF-1: pool checkout pings only idle connections; safe methods get autocommit sessions."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from quiz_api.db import Database, create_database, get_db_session, install_idle_ping
from quiz_api.settings import Settings
from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr("quiz_api.db.time.monotonic", c)
    return c


def _engine(monkeypatch: pytest.MonkeyPatch, pings: list[Any], *, fail: bool = False) -> Any:
    engine = create_engine("sqlite://", poolclass=QueuePool, pool_size=1, max_overflow=0)

    def do_ping(dbapi_connection: Any) -> bool:
        pings.append(dbapi_connection)
        if fail:
            raise RuntimeError("server closed the connection")
        return True

    monkeypatch.setattr(engine.dialect, "do_ping", do_ping)
    install_idle_ping(engine, idle_seconds=30)
    return engine


def test_connections_in_steady_use_are_not_pinged(
    monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    pings: list[Any] = []
    engine = _engine(monkeypatch, pings)
    for _ in range(5):
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        clock.now += 29
    assert pings == []


def test_a_connection_idle_past_the_threshold_is_pinged_once(
    monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    pings: list[Any] = []
    engine = _engine(monkeypatch, pings)
    with engine.connect():
        pass
    clock.now += 31
    with engine.connect() as conn:
        conn.execute(text("select 1"))
    with engine.connect():
        pass
    assert len(pings) == 1


def test_a_failed_ping_replaces_the_connection(
    monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    pings: list[Any] = []
    engine = _engine(monkeypatch, pings, fail=True)
    with engine.connect() as conn:
        first = conn.connection.dbapi_connection
    clock.now += 31
    with engine.connect() as conn:
        assert conn.execute(text("select 1")).scalar() == 1
        assert conn.connection.dbapi_connection is not first
    assert pings == [first]  # the fresh replacement is not pinged


def test_read_sessions_share_the_pool_in_autocommit() -> None:
    database = create_database(
        Settings(DATABASE_URL="postgresql://quiz_api:pw@127.0.0.1:1/postgres")  # type: ignore[call-arg]
    )
    assert database is not None
    read_bind = database.read_sessionmaker.kw["bind"]
    assert read_bind.get_execution_options()["isolation_level"] == "AUTOCOMMIT"
    assert read_bind.pool is database.engine.pool
    assert "isolation_level" not in database.engine.get_execution_options()
    assert database.engine.pool._pre_ping is False  # replaced by the idle ping
    database.dispose()


class FakeFactory:
    def __init__(self, name: str) -> None:
        self.name = name

    def __call__(self) -> Any:
        name = self.name

        class _Session:
            def __enter__(self) -> str:
                return name

            def __exit__(self, *_: Any) -> None:
                return None

        return _Session()


@pytest.mark.parametrize(
    ("method", "expected"),
    [("GET", "read"), ("HEAD", "read"), ("POST", "write"), ("PATCH", "write"), ("DELETE", "write")],
)
def test_safe_methods_get_the_autocommit_session(method: str, expected: str) -> None:
    database = Database(
        engine=None,  # type: ignore[arg-type]
        sessionmaker=FakeFactory("write"),  # type: ignore[arg-type]
        read_sessionmaker=FakeFactory("read"),  # type: ignore[arg-type]
    )
    request = SimpleNamespace(
        method=method, app=SimpleNamespace(state=SimpleNamespace(database=database))
    )
    gen: Any = get_db_session(request)  # type: ignore[arg-type]
    assert next(gen) == expected


def test_no_database_is_a_503() -> None:
    request = SimpleNamespace(
        method="GET", app=SimpleNamespace(state=SimpleNamespace(database=None))
    )
    with pytest.raises(HTTPException) as exc:
        next(get_db_session(request))  # type: ignore[arg-type]
    assert exc.value.status_code == 503
