"""CHMAN-01-C02: a chapter edit racing a correction publish or a fork commit.

Interleaving as test_chapter_redistribution_lock_order.py: one connection takes the document lock
the rival holds, the edit starts in a thread, the test waits until the API's backend is blocked,
then the rival commits. The edit then answers on the new state: no deadlock, no 500.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
import uuid
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
WORKER_DATABASE_URL = os.environ.get(
    "WORKER_DATABASE_URL", "postgresql://quiz_worker:change-me-local@127.0.0.1:54322/postgres"
)
TREE_CHANGED = "urn:quiz-workspace:problem:chapter-tree-changed"


def _seed_book(workspace_id: str) -> dict[str, Any]:
    """A ready book: revision 1 published and active, revision 2 the correction about to be
    published; both with sections `a` and `b`. The hash stays null: a content hash needs real
    blocks and these rows only serve the locks."""
    doc = str(uuid.uuid4())
    key = f"workspaces/{workspace_id}/documents/{doc}/revisions/{uuid.uuid4()}/source.pdf"
    revs = [str(uuid.uuid4()), str(uuid.uuid4())]
    found: list[dict[str, str]] = []
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256, "
            "source_object_key, document_type) values (%s, %s, 'Book', 'book.pdf', 10, %s, %s, "
            "'book')",
            (doc, workspace_id, hashlib.sha256(doc.encode()).hexdigest(), key),
        )
        for n, rev in enumerate(revs, start=1):
            conn.execute(
                "insert into public.document_revisions (id, workspace_id, document_id, "
                "revision_number, parent_revision_id, source_object_key) "
                "values (%s, %s, %s, %s, %s, %s)",
                (rev, workspace_id, doc, n, revs[0] if n == 2 else None, key),
            )
            sections: dict[str, str] = {}
            for i, section in enumerate(("a", "b")):
                row = conn.execute(
                    "insert into public.chapters (workspace_id, document_id, document_revision_id, "
                    "section_key, level, sort_order, title) values (%s, %s, %s, %s, 1, %s, %s) "
                    "returning id",
                    (workspace_id, doc, rev, section, i, f"{i + 1}장"),
                ).fetchone()
                assert row is not None
                sections[section] = str(row[0])
            found.append(sections)
        conn.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (revs[0],),
        )
        conn.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (revs[0], doc),
        )
    return {"id": doc, "revisions": revs, "chapters": found}


def _wait_until_blocked_by(pid: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        while time.monotonic() < deadline:
            row = conn.execute(
                "select count(*) from pg_stat_activity where %s = any(pg_blocking_pids(pid))",
                (pid,),
            ).fetchone()
            if row is not None and row[0] > 0:
                return
            time.sleep(0.05)
    pytest.fail("the chapter edit never waited for the document lock")


def _version(document_id: str) -> int:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select chapter_tree_version from public.documents where id = %s", (document_id,)
        ).fetchone()
    assert row is not None
    return int(row[0])


def test_chman_01_c02_a_move_racing_a_publish_answers_chapter_tree_changed(seed: Any) -> None:
    owner = seed.client("chman-race-publish")
    ws = str(owner.create_workspace()["id"])
    doc = _seed_book(ws)
    rev1, rev2 = doc["chapters"]
    version = _version(doc["id"])
    result: dict[str, httpx.Response] = {}

    def attempt() -> None:
        result["res"] = owner.send(
            "POST",
            f"/documents/{doc['id']}/chapters/tree",
            {
                "expected_version": version,
                "moves": [{"chapter_id": rev1["b"], "parent_id": rev1["a"], "position": 0}],
            },
            headers={},
        )

    with psycopg.connect(WORKER_DATABASE_URL) as publish:
        publish.execute("set lock_timeout = '20s'")
        pid = publish.info.backend_pid
        publish.execute(
            "select active_revision_id from public.documents where id = %s for update",
            (doc["id"],),
        )
        thread = threading.Thread(target=attempt)
        thread.start()
        _wait_until_blocked_by(pid)
        publish.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (doc["revisions"][1],),
        )
        publish.execute(
            "update public.documents set active_revision_id = %s where id = %s",
            (doc["revisions"][1], doc["id"]),
        )
        publish.commit()
        thread.join(timeout=30)
        assert not thread.is_alive(), "the move never finished"

    res = result["res"]
    assert res.status_code == 409, res.text
    assert res.json()["type"] == TREE_CHANGED
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select parent_id from public.chapters where id = %s", (rev2["b"],)
        ).fetchone()
    assert row is not None
    assert row[0] is None, "the new revision's tree is untouched"


def test_chman_01_c02_an_edit_waits_for_a_fork_commit_holding_the_document(seed: Any) -> None:
    owner = seed.client("chman-race-fork")
    ws = str(owner.create_workspace()["id"])
    doc = _seed_book(ws)
    rev1 = doc["chapters"][0]
    result: dict[str, httpx.Response] = {}

    def attempt() -> None:
        result["res"] = owner.send(
            "POST",
            f"/workspaces/{ws}/chapters",
            {"document_id": doc["id"], "parent_id": rev1["a"], "title": "경합"},
            headers={},
        )

    # What worker_fork_commit holds while it copies: the workspace and the document FOR SHARE.
    with psycopg.connect(DB_ADMIN_URL) as fork:
        pid = fork.info.backend_pid
        fork.execute("select 1 from public.workspaces where id = %s for share", (ws,))
        fork.execute("select 1 from public.documents where id = %s for share", (doc["id"],))
        thread = threading.Thread(target=attempt)
        thread.start()
        _wait_until_blocked_by(pid)
        assert "res" not in result, "the edit must wait for the copy"
        [(chapters,)] = fork.execute(
            "select count(*) from public.chapters where document_revision_id = %s",
            (doc["revisions"][0],),
        ).fetchall()
        assert chapters == 2, "the copy sees one whole tree"
        fork.commit()
        thread.join(timeout=30)
        assert not thread.is_alive(), "the edit never finished"
    assert result["res"].status_code == 201, result["res"].text
