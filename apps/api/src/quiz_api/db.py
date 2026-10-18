"""SQLAlchemy engine and request-scoped session dependency.

Schema is owned by `supabase/migrations` (no Alembic); this module only maps queries.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from fastapi import HTTPException, Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from quiz_api.settings import Settings


@dataclass(frozen=True)
class Database:
    engine: Engine
    sessionmaker: sessionmaker[Session]

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
        pool_pre_ping=True,
        hide_parameters=True,
        connect_args={"connect_timeout": max(1, int(settings.db_connect_timeout_seconds))},
    )
    return Database(engine=engine, sessionmaker=sessionmaker(engine, expire_on_commit=False))


def get_db_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, rolled back on error, always closed."""
    database: Database | None = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")
    with database.sessionmaker() as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise
