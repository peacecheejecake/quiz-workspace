"""M3.2a fix (20261017210000): content writes and publication serialise on the revision row.

Two real sessions against the local DB (pgTAP has only one). Whichever side comes first holds the
revision row (content write: FOR SHARE in `revision_content_guard`; publish: the row UPDATE), so
the other side waits; with a short `lock_timeout` the wait shows up as LockNotAvailable instead of
both committing. After the first side commits, a late content write into the now-published
revision is refused.

Fixture rows are committed through the local `postgres` admin connection and removed afterwards.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import psycopg
import pytest
from psycopg import errors

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LOCK_TIMEOUT = "300ms"


@dataclass(frozen=True)
class Doc:
    workspace_id: str
    document_id: str
    source_key: str


def _connect() -> psycopg.Connection:
    try:
        return psycopg.connect(DB_ADMIN_URL, connect_timeout=3)
    except psycopg.OperationalError as exc:
        reason = f"local DB not reachable ({exc.__class__.__name__}); run `make infra-up`"
        if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
            pytest.fail(reason)
        pytest.skip(reason)


@pytest.fixture
def doc() -> Iterator[Doc]:
    user_id, ws, doc_id, rev0 = (str(uuid.uuid4()) for _ in range(4))
    key = f"workspaces/{ws}/documents/{doc_id}/revisions/{rev0}/source.pdf"
    with _connect() as conn:
        conn.autocommit = True
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)",
            (user_id, f"m32a-lock-{user_id}@example.test"),
        )
        try:
            conn.execute(
                "insert into public.workspaces (id, name, owner_id) values (%s, 'lock', %s)",
                (ws, user_id),
            )
            conn.execute(
                "insert into public.documents (id, workspace_id, title, filename, size_bytes, "
                "sha256, source_object_key) values (%s, %s, 'Lock', 'lock.pdf', 10, %s, %s)",
                (doc_id, ws, "a" * 64, key),
            )
            yield Doc(ws, doc_id, key)
        finally:
            conn.execute("delete from public.workspaces where id = %s", (ws,))
            conn.execute("delete from auth.users where id = %s", (user_id,))


def _revision(conn: psycopg.Connection, doc: Doc, number: int) -> str:
    rev = str(uuid.uuid4())
    conn.execute(
        "insert into public.document_revisions (id, workspace_id, document_id, revision_number, "
        "source_object_key) values (%s, %s, %s, %s, %s)",
        (rev, doc.workspace_id, doc.document_id, number, doc.source_key),
    )
    return rev


def _insert_block(conn: psycopg.Connection, doc: Doc, rev: str) -> None:
    conn.execute(
        "insert into public.content_blocks (workspace_id, document_id, document_revision_id, "
        "block_id, ordinal, block_type, page, provenance) values (%s, %s, %s, %s, "
        "(select count(*) from public.content_blocks where document_revision_id = %s), 'text', "
        '1, \'{"locations": [{"page": 1}]}\')',
        (doc.workspace_id, doc.document_id, rev, f"b-{uuid.uuid4().hex[:8]}", rev),
    )


def _publish(conn: psycopg.Connection, rev: str) -> None:
    conn.execute(
        "update public.document_revisions set status = 'published', published_at = now() "
        "where id = %s",
        (rev,),
    )


def _publish_waiting(conn: psycopg.Connection, rev: str) -> None:
    with conn.transaction():
        conn.execute(f"set local lock_timeout = '{LOCK_TIMEOUT}'")
        _publish(conn, rev)


def _insert_waiting(conn: psycopg.Connection, doc: Doc, rev: str) -> None:
    with conn.transaction():
        conn.execute(f"set local lock_timeout = '{LOCK_TIMEOUT}'")
        _insert_block(conn, doc, rev)


def _move_waiting(conn: psycopg.Connection, doc: Doc, rev: str) -> None:
    """Move a block of a fresh draft revision into `rev` (rolled back with the transaction)."""
    with conn.transaction():
        other = _revision(conn, doc, 2)
        _insert_block(conn, doc, other)
        conn.execute(f"set local lock_timeout = '{LOCK_TIMEOUT}'")
        conn.execute(
            "update public.content_blocks set document_revision_id = %s "
            "where document_revision_id = %s",
            (rev, other),
        )


def _count(conn: psycopg.Connection, rev: str) -> int:
    [(count,)] = conn.execute(
        "select count(*) from public.content_blocks where document_revision_id = %s", (rev,)
    ).fetchall()
    return int(count)


def test_m32a_publish_waits_for_an_in_flight_content_write(doc: Doc) -> None:
    with _connect() as writer, _connect() as publisher:
        writer.autocommit = publisher.autocommit = True
        rev = _revision(writer, doc, 1)

        with writer.transaction():
            _insert_block(writer, doc, rev)  # holds FOR SHARE on the revision row
            with pytest.raises(errors.LockNotAvailable):
                _publish_waiting(publisher, rev)

        # The write committed first; publishing now snapshots content that includes it.
        _publish(publisher, rev)
        with pytest.raises(errors.CheckViolation):
            _insert_block(writer, doc, rev)
        assert _count(writer, rev) == 1


def test_m32a_content_write_waits_for_an_in_flight_publish(doc: Doc) -> None:
    with _connect() as writer, _connect() as publisher:
        writer.autocommit = publisher.autocommit = True
        rev = _revision(writer, doc, 1)

        with publisher.transaction():
            _publish(publisher, rev)  # row UPDATE, not committed yet
            with pytest.raises(errors.LockNotAvailable):
                _insert_waiting(writer, doc, rev)
            with pytest.raises(errors.LockNotAvailable):
                _move_waiting(writer, doc, rev)

        # The publish committed first; the late write sees it and is refused.
        with pytest.raises(errors.CheckViolation):
            _insert_block(writer, doc, rev)
        assert _count(writer, rev) == 0
