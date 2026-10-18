"""scripts/restore into a freshly migrated target (M7.3, DEP-06): the migrations already inserted
the Storage bucket rows that the backup's data.sql also carries, while every other table is empty.

Runs against a scratch database on the local cluster with a minimal stand-in for the Supabase
schemas (no shared data is touched); `scripts/restore --skip-storage` does the rest exactly as in
the CI rehearsal.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

pytestmark = pytest.mark.infra

RESTORE = Path(__file__).with_name("restore")
ADMIN_DATABASE_URL = os.environ.get(
    "QUIZ_TEST_ADMIN_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
MIGRATIONS = ["20261017120000", "20261017200000"]
USER = "6d0f3c1e-0000-4000-8000-000000000001"
WORKSPACE = "6d0f3c1e-0000-4000-8000-000000000002"

# The schema a `db reset` leaves: platform tables, migration-seeded buckets (with Supabase's
# statement-level delete guard), nothing else.
SCHEMA = """
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key);
create schema auth;
create table auth.users (id uuid primary key, email text);
create table public.workspaces (id uuid primary key, owner_id uuid not null references auth.users);
create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table storage.objects (
  id uuid primary key, bucket_id text not null references storage.buckets, name text not null);
create function storage.protect_delete() returns trigger language plpgsql as $$
begin raise exception 'Direct deletion from storage tables is not allowed'; end $$;
create trigger protect_buckets_delete before delete on storage.buckets
  for each statement execute function storage.protect_delete();
"""
SEED_BUCKETS = """
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('source-pdfs', 'source-pdfs', false, 52428800, array['application/pdf']),
  ('parsed-artifacts', 'parsed-artifacts', false, 52428800, array['application/json']);
"""


def _copy(table: str, columns: str, rows: list[str]) -> str:
    return "\n".join([f"COPY {table} ({columns}) FROM stdin;", *rows, "\\."]) + "\n\n"


def _data_sql(source_pdf_limit: int = 52428800) -> str:
    """A `supabase db dump --data-only --use-copy` shaped file. Workspaces come before their
    owners on purpose: the load must not depend on FK order."""
    return (
        "SET session_replication_role = replica;\n"
        "SELECT pg_catalog.set_config('search_path', '', false);\n\n"
        + _copy('"public"."workspaces"', '"id", "owner_id"', [f"{WORKSPACE}\t{USER}"])
        + _copy('"auth"."users"', '"id", "email"', [f"{USER}\trestore@example.test"])
        + _copy(
            '"storage"."buckets"',
            '"id", "name", "public", "file_size_limit", "allowed_mime_types", '
            '"created_at", "updated_at"',
            [
                f"source-pdfs\tsource-pdfs\tf\t{source_pdf_limit}\t{{application/pdf}}\t"
                "2026-01-02 03:04:05+00\t2026-01-02 03:04:05+00",
                "parsed-artifacts\tparsed-artifacts\tf\t52428800\t{application/json}\t"
                "2026-01-02 03:04:05+00\t2026-01-02 03:04:05+00",
            ],
        )
        + _copy('"storage"."objects"', '"id", "bucket_id", "name"', [])
        + "RESET ALL;\n"
    )


def _backup(root: Path, data_sql: str) -> Path:
    (root / "db").mkdir(parents=True)
    (root / "storage").mkdir()
    (root / "db" / "data.sql").write_text(data_sql, encoding="utf-8")
    (root / "db" / "migrations.txt").write_text("\n".join(MIGRATIONS) + "\n", encoding="utf-8")
    (root / "storage" / "manifest.jsonl").write_text("", encoding="utf-8")
    sums = [
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  ./{p.relative_to(root).as_posix()}"
        for p in sorted(root.rglob("*"))
        if p.is_file()
    ]
    (root / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    return root


@pytest.fixture
def target() -> Iterator[str]:
    """A scratch database shaped like a freshly reset target; dropped afterwards."""
    name = f"restore_test_{uuid.uuid4().hex[:12]}"
    try:
        admin = psycopg.connect(ADMIN_DATABASE_URL, autocommit=True, connect_timeout=5)
    except psycopg.OperationalError as exc:
        if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
            pytest.fail(f"local Postgres unavailable: {exc} (run `make infra-up`)")
        pytest.skip("local Postgres unavailable; run `make infra-up`")
    with admin:
        admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
        url = psycopg.conninfo.make_conninfo(ADMIN_DATABASE_URL, dbname=name)
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                conn.execute(SCHEMA)
                conn.execute(SEED_BUCKETS)
                for version in MIGRATIONS:
                    conn.execute(
                        "insert into supabase_migrations.schema_migrations values (%s)", (version,)
                    )
            yield url
        finally:
            admin.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))


def _restore(backup: Path, url: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "RESTORE_DB_URL": url}
    return subprocess.run(  # noqa: S603 - fixed script, test-controlled arguments
        [str(RESTORE), str(backup), "--yes", "--skip-storage"],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _rows(url: str, query: str) -> list[tuple[object, ...]]:
    with psycopg.connect(url) as conn:
        return conn.execute(query).fetchall()


BUCKETS = "select id, file_size_limit, created_at::text from storage.buckets order by id"


def test_restore_into_a_reset_target_with_migration_seeded_buckets(
    tmp_path: Path, target: str
) -> None:
    result = _restore(_backup(tmp_path / "b", _data_sql()), target)

    assert result.returncode == 0, result.stderr
    assert "row counts match (4 tables)" in result.stdout
    assert _rows(target, "select id::text, owner_id::text from public.workspaces") == [
        (WORKSPACE, USER)
    ]
    # The backup's bucket rows (timestamps included) replace the migration's identical ones.
    assert _rows(target, BUCKETS) == [
        ("parsed-artifacts", 52428800, "2026-01-02 03:04:05+00"),
        ("source-pdfs", 52428800, "2026-01-02 03:04:05+00"),
    ]


def test_restore_rolls_back_when_a_seeded_bucket_differs(tmp_path: Path, target: str) -> None:
    before = _rows(target, BUCKETS)

    result = _restore(_backup(tmp_path / "b", _data_sql(source_pdf_limit=1024)), target)

    assert result.returncode != 0
    assert "storage.buckets rows seeded by the migrations differ from the backup" in result.stderr
    assert _rows(target, BUCKETS) == before
    assert _rows(target, "select count(*) from auth.users") == [(0,)]


@pytest.mark.parametrize(
    ("statement", "reason"),
    [
        ("insert into auth.users values (gen_random_uuid(), 'x@example.test')", "auth.users"),
        (
            "insert into storage.objects values "
            "('6d0f3c1e-0000-4000-8000-0000000000aa', 'source-pdfs', 'stale.pdf')",
            "rows in: storage.objects",
        ),
    ],
)
def test_restore_refuses_a_target_with_data(
    tmp_path: Path, target: str, statement: str, reason: str
) -> None:
    with psycopg.connect(target, autocommit=True) as conn:
        conn.execute(statement)

    result = _restore(_backup(tmp_path / "b", _data_sql()), target)

    assert result.returncode != 0
    assert "target is not empty" in result.stderr
    assert reason in result.stderr
    assert _rows(target, "select count(*) from public.workspaces") == [(0,)]
