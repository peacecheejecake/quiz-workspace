"""SQLAlchemy engine and request-scoped session dependency.

Schema is owned by `supabase/migrations` (no Alembic); this module only maps queries.

Round trips (PERF-1): the hosted database is a network hop away (Supabase pooler, ~140 ms from
the Mac staging stack, a few ms from Railway), so the per-request overhead is kept small:
  * No ping on every checkout (`pool_pre_ping` costs one round trip per request). A pooled
    connection is pinged only after it sat idle for `PING_AFTER_IDLE_SECONDS`, when a server or
    pooler timeout may have closed it; a failed ping replaces it (SQLAlchemy's documented
    "pessimistic" checkout handler).
  * Safe methods (GET/HEAD) run in autocommit: no `BEGIN` before the first statement and no
    `ROLLBACK` when the session ends. Their routes only read without row locks, and at READ
    COMMITTED every statement takes its own snapshot inside a transaction too, so they see the
    same data. The one GET that writes (`GET /me` creating the profile) is a single
    idempotent statement. Unsafe methods keep one transaction per request, as before.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy import exc as sa_exc
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from quiz_api.settings import Settings

# A pooled connection idle for longer than this is pinged before reuse.
PING_AFTER_IDLE_SECONDS = 30.0
READ_ONLY_METHODS = frozenset({"GET", "HEAD"})
_IDLE_SINCE = "quiz_idle_since"

SessionFactory = sessionmaker[Session]


@dataclass(frozen=True)
class Database:
    engine: Engine
    sessionmaker: SessionFactory
    # Same pool, autocommit connections: for requests that only read (READ_ONLY_METHODS).
    read_sessionmaker: SessionFactory

    def dispose(self) -> None:
        self.engine.dispose()


def create_database(settings: Settings) -> Database | None:
    """Build the engine lazily (no connection is opened here); `None` if unconfigured."""
    if settings.database_url is None:
        return None
    url = make_url(settings.database_url.get_secret_value())
    if url.drivername in {"postgres", "postgresql"}:
        # Plain `postgresql://` URLs (Supabase style) use psycopg 3.
        url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(
        url,
        pool_size=settings.db_pool_size,
        hide_parameters=True,
        connect_args={"connect_timeout": max(1, int(settings.db_connect_timeout_seconds))},
    )
    install_idle_ping(engine)
    return Database(
        engine=engine,
        sessionmaker=sessionmaker(engine, expire_on_commit=False),
        read_sessionmaker=sessionmaker(
            engine.execution_options(isolation_level="AUTOCOMMIT"), expire_on_commit=False
        ),
    )


def install_idle_ping(engine: Engine, idle_seconds: float = PING_AFTER_IDLE_SECONDS) -> None:
    """Ping a pooled connection on checkout only when it was idle for `idle_seconds`."""

    @event.listens_for(engine, "checkin")
    def _checkin(_dbapi_connection: Any, record: Any) -> None:
        record.info[_IDLE_SINCE] = time.monotonic()

    @event.listens_for(engine, "checkout")
    def _checkout(dbapi_connection: Any, record: Any, _proxy: Any) -> None:
        if getattr(dbapi_connection, "closed", False) or getattr(dbapi_connection, "broken", False):
            raise sa_exc.DisconnectionError("connection closed")
        since = record.info.get(_IDLE_SINCE)
        if since is None or time.monotonic() - since < idle_seconds:
            return  # fresh from connect, or in steady use
        try:
            engine.dialect.do_ping(dbapi_connection)
        except Exception as exc:  # any failure: let the pool replace this connection
            raise sa_exc.DisconnectionError("stale pooled connection") from exc


def get_db_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, rolled back on error, always closed.

    GET/HEAD get an autocommit session (module docstring); other methods one transaction."""
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")
    factory = (
        database.read_sessionmaker if request.method in READ_ONLY_METHODS else database.sessionmaker
    )
    with factory() as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise
