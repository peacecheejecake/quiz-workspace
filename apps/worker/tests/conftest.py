from __future__ import annotations

import os
import signal
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from billiard import process as billiard_process
from celery.worker import state as worker_state
from quiz_worker.envelope import JobEnvelope
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore, SqliteJobStore, TransactionalJobStore
from sqlalchemy import Engine, event, text
from sqlalchemy.exc import OperationalError

# Synthetic stand-ins for data that must never reach logs or `last_error`.
TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"  # noqa: S105 - fake JWT
BOOK_TEXT = "Chapter 7 synthetic passage: the quick brown fox jumps over the lazy dog"
WORKSPACE_ID = UUID("00000000-0000-4000-8000-000000000001")
USER_ID = UUID("00000000-0000-4000-8000-0000000000a1")

# Local Supabase stack (supabase/config.toml); non-secret local defaults.
ADMIN_DATABASE_URL = os.environ.get(
    "QUIZ_TEST_ADMIN_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)

EnvelopeFactory = Callable[..., JobEnvelope]
JobStoreUnderTest = TransactionalJobStore


# -- Real workers in this process: fork safety and leak-proof teardown ---------------------------

# `start_worker` runs the worker in a thread of the test process, and on Linux that thread forks
# the prefork pool's children (also replacements, after a child died). A child forked while
# another thread is inside SQLite inherits SQLite's process-wide mutexes in the state that thread
# left them: py-spy showed a replacement child blocked forever in `pthread_mutex_lock` under
# `sqlite3Malloc` (`sqlite3.connect`, claiming the job's next attempt) while the test thread
# polled the job store. Store reads that may overlap a fork therefore hold this lock, and every
# fork in this process waits for it. macOS spawns the children, so this never showed there.
_FORK_GUARD = threading.Lock()
os.register_at_fork(
    before=_FORK_GUARD.acquire,
    after_in_parent=_FORK_GUARD.release,
    after_in_child=_FORK_GUARD.release,
)


def read_between_forks[T](read: Callable[[], T]) -> T:
    """Run a SQLite read from the test thread while a worker thread may fork pool children."""
    with _FORK_GUARD:
        return read()


@pytest.fixture(autouse=True)
def _reap_stuck_test_worker() -> Iterator[None]:
    """A `start_worker` whose worker thread outlives `shutdown_timeout` raises, but leaves the
    pool children that blocked its shutdown running and Celery's global `should_terminate` set:
    every later worker then stops before it is ready and the next `start_worker` waits forever
    (CI hung ~20 min after one failed prefork test). Kill such leftovers so one failing test
    stays one failure."""
    yield
    if worker_state.should_terminate is None:
        return
    for child in billiard_process.active_children():
        if child.pid is not None:
            os.kill(child.pid, signal.SIGKILL)
        child.join(5)
    # The stuck worker threads finish their shutdown once their children are gone.
    for thread in threading.enumerate():
        if thread.name.endswith("(start)") and thread is not threading.current_thread():
            thread.join(15)
    worker_state.reset_state()
    worker_state.should_terminate = None


class FakeClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


# -- Tenancy: the workspace/user a test's jobs belong to ----------------------------------------


@dataclass
class Tenancy:
    """IDs a test's jobs use. With Postgres they are real rows (foreign keys); otherwise any
    UUID will do."""

    workspace_id: UUID = WORKSPACE_ID
    user_id: UUID = USER_ID
    new_workspace: Callable[[], UUID] = field(default=uuid4)
    new_user: Callable[[], UUID] = field(default=uuid4)


class PgTenancy(Tenancy):
    def __init__(self, admin: Engine) -> None:
        self._admin = admin
        self._workspaces: list[UUID] = []
        self._users: list[UUID] = []
        super().__init__(
            user_id=self._create_user(),
            new_workspace=self._create_workspace,
            new_user=self._create_user,
        )
        self.workspace_id = self._create_workspace()

    def _create_user(self) -> UUID:
        user_id = uuid4()
        with self._admin.begin() as conn:
            conn.execute(
                text("insert into auth.users (id, email) values (:id, :email)"),
                {"id": user_id, "email": f"p07b-worker-{user_id.hex}@example.test"},
            )
        self._users.append(user_id)
        return user_id

    def _create_workspace(self) -> UUID:
        workspace_id = uuid4()
        with self._admin.begin() as conn:
            conn.execute(
                text("insert into public.workspaces (id, name, owner_id) values (:id, :n, :o)"),
                {"id": workspace_id, "n": "p07b worker test", "o": self.user_id},
            )
        self._workspaces.append(workspace_id)
        return workspace_id

    def store(self, engine: Engine, clock: Callable[[], datetime] | None) -> PostgresJobStore:
        """A store whose reconciler/cleanup scans see only this test's workspaces (other
        sessions may be running the same suites against the shared local DB)."""
        return PostgresJobStore(engine, clock=clock, scan_workspaces=self._workspaces)

    def cleanup(self) -> None:
        with self._admin.begin() as conn:
            # async_jobs cascade with their workspace.
            for workspace_id in self._workspaces:
                conn.execute(
                    text("delete from public.workspaces where id = :id"), {"id": workspace_id}
                )
            for user_id in self._users:
                conn.execute(text("delete from auth.users where id = :id"), {"id": user_id})


@dataclass(frozen=True)
class PgEngines:
    admin: Engine
    worker: Engine


def _infra_unavailable(reason: str) -> None:
    if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
        pytest.fail(f"{reason} (QUIZ_REQUIRE_INFRA=1: run `make infra-up`)")
    pytest.skip(f"{reason}; run `make infra-up`")


@pytest.fixture(scope="session")
def pg_engines() -> Iterator[PgEngines]:
    """Admin engine (fixtures) and an engine acting as `quiz_worker` (the store under test).

    The worker engine logs in as the local admin and switches to `quiz_worker` on connect, so
    the suites exercise exactly the role's grants and RLS policies. That needs SET membership
    in the (NOLOGIN) role, granted once here for the local stack.
    """
    admin = create_job_store_engine(ADMIN_DATABASE_URL, pool_size=2)
    try:
        with admin.begin() as conn:
            has_role = conn.execute(
                text("select exists (select 1 from pg_roles where rolname = 'quiz_worker')")
            ).scalar_one()
            if not has_role:
                pytest.fail("role quiz_worker missing: apply supabase/migrations")
            can_set = conn.execute(
                text("select pg_has_role(current_user, 'quiz_worker', 'SET')")
            ).scalar_one()
            if not can_set:
                conn.execute(text("grant quiz_worker to current_user with inherit false, set true"))
    except OperationalError:
        admin.dispose()
        _infra_unavailable("local Postgres is not reachable")
    worker = create_job_store_engine(ADMIN_DATABASE_URL, pool_size=8)

    @event.listens_for(worker, "connect")
    def _act_as_worker(dbapi_conn: Any, _record: Any) -> None:
        with dbapi_conn.cursor() as cur:
            cur.execute("set role quiz_worker")
        dbapi_conn.commit()

    try:
        yield PgEngines(admin=admin, worker=worker)
    finally:
        worker.dispose()
        admin.dispose()


@pytest.fixture
def pg_tenancy(pg_engines: PgEngines) -> Iterator[PgTenancy]:
    tenancy = PgTenancy(pg_engines.admin)
    try:
        yield tenancy
    finally:
        tenancy.cleanup()


@pytest.fixture(params=["memory", "sqlite", pytest.param("postgres", marks=pytest.mark.infra)])
def store(request: pytest.FixtureRequest, clock: FakeClock, tmp_path: Path) -> JobStoreUnderTest:
    """Every store test runs against all implementations of the shared transitions."""
    if request.param == "postgres":
        engines: PgEngines = request.getfixturevalue("pg_engines")
        tenancy: PgTenancy = request.getfixturevalue("pg_tenancy")
        return tenancy.store(engines.worker, clock)
    if request.param == "sqlite":
        return SqliteJobStore(tmp_path / "jobs.sqlite3", clock=clock)
    return InMemoryJobStore(clock=clock)


@pytest.fixture
def tenancy(request: pytest.FixtureRequest) -> Tenancy:
    if "store" in request.fixturenames and isinstance(
        request.getfixturevalue("store"), PostgresJobStore
    ):
        pg: Tenancy = request.getfixturevalue("pg_tenancy")
        return pg
    return Tenancy()


_UNSET: Any = object()


@pytest.fixture
def make_envelope(tenancy: Tenancy) -> EnvelopeFactory:
    def factory(
        job_type: str = "echo",
        payload: dict[str, Any] | None = None,
        *,
        schema_version: int = 1,
        idempotency_key: str | None = None,
        workspace_id: UUID | None = None,
        created_by: UUID | None = _UNSET,
        job_id: UUID | None = None,
    ) -> JobEnvelope:
        return JobEnvelope(
            job_id=job_id or uuid4(),
            job_type=job_type,
            schema_version=schema_version,
            idempotency_key=idempotency_key or f"key-{uuid4().hex}",
            workspace_id=workspace_id or tenancy.workspace_id,
            created_by=tenancy.user_id if created_by is _UNSET else created_by,
            payload=payload if payload is not None else {"message": BOOK_TEXT},
        )

    return factory


@pytest.fixture
def eager_settings() -> WorkerSettings:
    # model_construct: defaults only, independent of the developer's env / .env.
    return WorkerSettings.model_construct(task_always_eager=True)
