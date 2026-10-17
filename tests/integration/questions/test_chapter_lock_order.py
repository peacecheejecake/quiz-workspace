"""M3.4 fix: a question chapter edit and a document publish never deadlock.

A publish (worker, `quiz_worker`) locks the document row FOR UPDATE, then switches the active
revision; the remap trigger (20261018003400) then updates the questions linked to the document's
chapters. A question edit that sets a chapter must therefore take the document lock *before* the
question row lock (QuestionRepository.lock_chapter_documents). With the opposite order the edit
held the question and waited for the document while the publish held the document and waited
for the question: a deadlock (one side aborted, the API answered 500).

The interleaving is deterministic: the publish connection takes the document lock and holds it;
the PATCH starts in a thread; the test waits until the API's backend is blocked by the publish
connection (pg_blocking_pids), then lets the publish switch the revision and commit. The PATCH
must then complete with the chapter of the newly active revision, and the publish must commit.

Documents and chapters are seeded with the `postgres` superuser (as in test_question_bank_api);
the publish statements are the worker's (PostgresDocumentStore.publish) on the `quiz_worker` role.
Needs migration 20261018003400. Fixtures: conftest.py.
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


def _seed(workspace_id: str) -> dict[str, Any]:
    """A ready document: revision 1 published and active, revision 2 a draft (the correction
    about to be published); both with sections `a` and `b`."""
    doc = str(uuid.uuid4())
    key = f"workspaces/{workspace_id}/documents/{doc}/revisions/{uuid.uuid4()}/source.pdf"
    revs = [str(uuid.uuid4()), str(uuid.uuid4())]
    chapters: list[dict[str, str]] = []
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256, "
            "source_object_key) values (%s, %s, 'Book', 'book.pdf', 10, %s, %s)",
            (doc, workspace_id, hashlib.sha256(doc.encode()).hexdigest(), key),
        )
        for n, rev in enumerate(revs, start=1):
            conn.execute(
                "insert into public.document_revisions (id, workspace_id, document_id, "
                "revision_number, parent_revision_id, source_object_key) "
                "values (%s, %s, %s, %s, %s, %s)",
                (rev, workspace_id, doc, n, revs[0] if n == 2 else None, key),
            )
            found = {}
            for i, section in enumerate(("a", "b")):
                row = conn.execute(
                    "insert into public.chapters (workspace_id, document_id, document_revision_id, "
                    "section_key, level, sort_order, title) values (%s, %s, %s, %s, 1, %s, %s) "
                    "returning id",
                    (workspace_id, doc, rev, section, i, f"{i + 1}장"),
                ).fetchone()
                assert row is not None
                found[section] = str(row[0])
            chapters.append(found)
        conn.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (revs[0],),
        )
        conn.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (revs[0], doc),
        )
    return {"id": doc, "revisions": revs, "chapters": chapters}


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
    pytest.fail("the question edit never waited for the publish's document lock")


@pytest.mark.parametrize("target", ["active-b", "draft-b"])
def test_m34_chapter_edit_racing_a_publish_does_not_deadlock(seed: Any, target: str) -> None:
    """`active-b`: the edit names a chapter of the revision being replaced. With the old lock
    order it held the question, then waited for the document, while the publish held the
    document and its remap trigger waited for the question: deadlock (500 or a failed publish).
    Now it waits for the publish first and is then refused (stale chapter), the question remapped.
    `draft-b`: the edit names a chapter of the revision being published; it waits and succeeds."""
    alice = seed.client(f"m34-lock-{target}")
    ws = alice.create_workspace()
    doc = _seed(ws["id"])
    rev1, rev2 = doc["chapters"]
    question = alice.create_question(
        ws["id"], seed.mcq("잠금 순서 문제", ["가", "나"], 0, chapter_id=rev1["a"])
    )
    requested = rev1["b"] if target == "active-b" else rev2["b"]

    result: dict[str, httpx.Response] = {}
    with psycopg.connect(WORKER_DATABASE_URL) as publish:
        publish.execute("set lock_timeout = '20s'")
        pid = publish.info.backend_pid
        # 1. The publish transaction takes the document first (as PostgresDocumentStore.publish).
        publish.execute(
            "select active_revision_id from public.documents where id = %s for update",
            (doc["id"],),
        )

        # 2. The edit moves the question to section b.
        def edit() -> None:
            result["patch"] = alice.call(
                "PATCH",
                f"/questions/{question['id']}",
                {"base_revision_id": question["revision"]["id"], "chapter_id": requested},
            )

        thread = threading.Thread(target=edit)
        thread.start()
        _wait_until_blocked_by(pid)

        # 3. The switch: the remap trigger updates the question rows of this document.
        publish.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (doc["revisions"][1],),
        )
        publish.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (doc["revisions"][1], doc["id"]),
        )
        publish.commit()
        thread.join(timeout=30)
        assert not thread.is_alive(), "the edit never finished"

    res = result["patch"]
    if target == "active-b":
        problem = seed.problem(res, 422)
        assert problem["errors"][0]["loc"] == ["body", "chapter_id"]
        assert alice.get_question(question["id"])["chapter_id"] == rev2["a"], "remapped"
    else:
        assert res.status_code == 200, res.text
        assert res.json()["chapter_id"] == rev2["b"]
