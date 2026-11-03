"""UX9-REDIST-B: a chapter assignment racing a correction publish never deadlocks
(CHREDIST-01-C02 lock order, docs/questions.md §14.3).

A publish (worker, PostgresDocumentStore.publish) locks the document FOR UPDATE and then switches
the active revision; the remap trigger (20261018003400) updates the questions of the document's
chapters. The assignment takes the documents of the target and expected chapters FOR SHARE before
it locks the questions, so it waits for the publish instead of holding a question the publish
needs. Interleaving as tests/integration/questions/test_chapter_lock_order.py: the publish
connection takes the document lock, the assignment starts in a thread, the test waits until the
API's backend is blocked by the publish (pg_blocking_pids), then the publish switches the revision
and commits. The assignment then sees the remapped chapter: 409 `chapter-changed`, nothing moved,
the publish committed (no deadlock, no 500). A second assignment against the new revision moves.

Documents and chapters are seeded with the `postgres` superuser; the publish statements run on the
`quiz_worker` role. Fixtures: conftest.py (the CHNOTE-01 contract stack).
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
CHAPTER_CHANGED = "urn:quiz-workspace:problem:chapter-changed"


def _seed_book(workspace_id: str) -> dict[str, Any]:
    """A ready book: revision 1 published and active, revision 2 the correction about to be
    published; both with sections `a` and `b`."""
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
    pytest.fail("the chapter assignment never waited for the publish's document lock")


def _mcq(stem: str, chapter_id: str) -> dict[str, Any]:
    return {
        "question_type": "MCQ",
        "stem": stem,
        "options": [{"id": "opt-1", "text": "가"}, {"id": "opt-2", "text": "나"}],
        "correct_option_ids": ["opt-1"],
        "is_multi_answer": False,
        "chapter_id": chapter_id,
    }


def _assign(client: Any, ws: str, items: list[dict[str, Any]]) -> httpx.Response:
    res: httpx.Response = client.send(
        "POST",
        f"/workspaces/{ws}/questions/chapter-assignments",
        {"source": "manual", "items": items},
        headers={},
    )
    return res


def _history(question_ids: list[str]) -> int:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select count(*) from public.question_chapter_changes "
            "where question_id = any(%s::uuid[]) and source = 'manual'",
            (question_ids,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def test_chredist_01_c02_assignment_racing_a_publish_does_not_deadlock(seed: Any) -> None:
    owner = seed.client("chredist-lock-owner")
    ws = str(owner.create_workspace()["id"])
    doc = _seed_book(ws)
    rev1, rev2 = doc["chapters"]
    qs = [
        owner.ok("POST", f"/workspaces/{ws}/questions", _mcq(f"잠금 {n}", rev1["a"]), (201,))
        for n in range(3)
    ]
    items = [
        {"question_id": q["id"], "chapter_id": rev1["b"], "expected_chapter_id": rev1["a"]}
        for q in qs
    ]

    result: dict[str, httpx.Response] = {}
    with psycopg.connect(WORKER_DATABASE_URL) as publish:
        publish.execute("set lock_timeout = '20s'")
        pid = publish.info.backend_pid
        # 1. The publish transaction takes the document first (as PostgresDocumentStore.publish).
        publish.execute(
            "select active_revision_id from public.documents where id = %s for update",
            (doc["id"],),
        )
        # 2. The assignment starts and must wait for the document before any question lock.
        thread = threading.Thread(target=lambda: result.update(res=_assign(owner, ws, items)))
        thread.start()
        _wait_until_blocked_by(pid)
        # 3. The switch: the remap trigger updates the questions of this document.
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
        assert not thread.is_alive(), "the assignment never finished"

    res = result["res"]
    assert res.status_code == 409, res.text
    assert res.json()["type"] == CHAPTER_CHANGED
    assert sorted(res.json()["question_ids"]) == sorted(q["id"] for q in qs)
    ids = [str(q["id"]) for q in qs]
    for q in qs:
        assert owner.ok("GET", f"/questions/{q['id']}")["chapter_id"] == rev2["a"], "remapped"
    assert _history(ids) == 0, "nothing moved"

    # Against the published revision the same move succeeds.
    fresh = [
        {"question_id": q["id"], "chapter_id": rev2["b"], "expected_chapter_id": rev2["a"]}
        for q in qs
    ]
    moved = _assign(owner, ws, fresh)
    assert moved.status_code == 200, moved.text
    assert moved.json() == {"moved": 3, "unchanged": 0}
    assert _history(ids) == 3
    # An old revision's chapter is not a target any more.
    stale = _assign(
        owner,
        ws,
        [{"question_id": qs[0]["id"], "chapter_id": rev1["a"], "expected_chapter_id": rev2["b"]}],
    )
    assert stale.status_code == 422, stale.text
