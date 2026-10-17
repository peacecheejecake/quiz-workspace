"""S3a fork worker: copy, isolation and races beyond the WS-FORK-01 contract
(tests/integration/sharing/test_fork_api_contract.py).

Runs the real API (in process), the `workspace.fork` job (in-process `ForkJobWorker`, the
`quiz_worker` role), Supabase Storage and Qdrant. The race tests drive the commit function
(`public.worker_fork_commit`) from two connections to show that the commit-time re-check and a
concurrent revoke serialise on the link row, and that two commits of one fork copy once.
"""

from __future__ import annotations

import dataclasses
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from qdrant_client import models as qm
from quiz_worker.errors import JobError
from quiz_worker.fork_job import workspace_fork_definition
from quiz_worker.fork_store import ForkStore, PostgresForkStore
from quiz_worker.pg_store import create_job_store_engine
from quiz_worker.settings import WorkerSettings
from quiz_worker.storage import ObjectCopier
from quiz_worker.store import TERMINAL_STATUSES
from sqlalchemy import Engine

pytestmark = [pytest.mark.infra]

REPO_ROOT = Path(__file__).resolve().parents[3]
BOOK = REPO_ROOT / "tests" / "fixtures" / "pdfs" / "book-ko.pdf"


@pytest.fixture(scope="module")
def worker_engine(stack: Any) -> Iterator[Engine]:
    env = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    assert env.worker_database_url is not None, "WORKER_DATABASE_URL missing (.env)"
    engine = create_job_store_engine(env.worker_database_url, pool_size=4)
    try:
        yield engine
    finally:
        engine.dispose()


def _worker_conn_url(engine: Engine) -> str:
    return engine.url.set(drivername="postgresql").render_as_string(hide_password=False)


def _shared(seed: Any, label: str) -> tuple[Any, dict[str, Any], dict[str, Any], Any, str]:
    owner = seed.client(f"{label}-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"], allow_fork=True)
    recipient = seed.client(f"{label}-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    return owner, ws, link, recipient, cookie


def _request_fork(seed: Any, recipient: Any, link: dict[str, Any], cookie: str, name: str) -> Any:
    """POST /forks without starting the in-process worker (the test drives the job itself)."""
    res = recipient.send(
        "POST",
        f"/shared/{link['id']}/forks",
        {"name": name},
        cookie=cookie,
        origin=seed.web_origin(),
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    seed.assert_status(res, 202, "fork start")
    return res.json()


def _book(owner: Any, ws_id: str) -> str:
    _, _, done = owner.upload_book(ws_id)
    owner.wait_for_job(str(done["job_id"]))
    return str(done["document_id"])


def _target_objects(seed: Any, fork_id: str) -> list[tuple[str, str]]:
    rows = seed._admin(
        "select target_workspace_id::text, target_object_key from public.worker_fork_documents(%s)",
        (fork_id,),
    )
    return [(str(r[0]), str(r[1])) for r in rows]


def _object_exists(seed: Any, key: str) -> bool:
    secret = seed._stack.admin.headers["apikey"]  # the local stack's server-side secret key
    res = httpx.head(
        f"{seed.SUPABASE_URL}/storage/v1/object/source-pdfs/{key}",
        headers={"apikey": secret, "Authorization": f"Bearer {secret}"},
        timeout=10,
    )
    return res.status_code == 200


def _points(seed: Any, workspace_id: str) -> int:
    worker = seed.worker
    worker._build()
    result = worker._qdrant.count(
        collection_name=worker._names.alias,
        count_filter=qm.Filter(
            must=[qm.FieldCondition(key="workspace_id", match=qm.MatchValue(value=workspace_id))]
        ),
        exact=True,
    )
    return int(result.count)


# --- copy ---------------------------------------------------------------------------------------


def test_fork_copies_published_documents_storage_index_and_sources(seed: Any) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-copy")
    doc = _book(owner, ws["id"])
    outline = owner.ok("GET", f"/documents/{doc}/outline")
    chapter = outline["items"][0]["id"]
    owner.ok(
        "POST",
        f"/workspaces/{ws['id']}/questions",
        {
            "question_type": "ESSAY",
            "stem": "S3a 출처가 있는 문제",
            "chapter_id": chapter,
            "sources": [{"document_id": doc, "page_start": 1}],
        },
        (201,),
    )
    # An unpublished correction must not reach the fork.
    hits = owner.ok("POST", f"/workspaces/{ws['id']}/search", {"query": "강수", "mode": "keyword"})
    draft = "S3a 미발행 교정 문장"
    owner.ok(
        "PATCH",
        f"/documents/{doc}/blocks/{hits['items'][0]['block_id']}",
        {"text": draft},
        (200, 201),
    )

    res = recipient.fork(link["id"], cookie, "S3a 문서 fork")
    seed.assert_status(res, 202, "fork start")
    fork = recipient.wait_fork(res.json()["id"], "COMPLETED")
    seed.worker.join()  # the job also activates the copy in Qdrant after its commit
    target = str(fork["target_workspace_id"])

    (copy,) = recipient.ok("GET", f"/workspaces/{target}/documents")["items"]
    source = owner.ok("GET", f"/documents/{doc}")
    assert copy["id"] != doc
    assert copy["status"] == "ready"
    assert copy["active_revision_id"] != source["active_revision_id"]
    for field in ("title", "filename", "sha256", "size_bytes", "document_type"):
        assert copy[field] == source[field], field

    # Same outline (new ids), same original PDF under the new workspace's prefix.
    copied_outline = recipient.ok("GET", f"/documents/{copy['id']}/outline")
    assert [i["title"] for i in copied_outline["items"]] == [i["title"] for i in outline["items"]]
    assert {i["id"] for i in copied_outline["items"]}.isdisjoint(i["id"] for i in outline["items"])
    url = recipient.ok("GET", f"/documents/{copy['id']}/source-url")["url"]
    assert httpx.get(url, timeout=30).content == BOOK.read_bytes()
    ((target_ws, key),) = _target_objects(seed, fork["id"])
    assert target_ws == target
    assert key.startswith(f"workspaces/{target}/documents/{copy['id']}/")

    # Published text only, searchable in the copy (Qdrant points of the new revision).
    search = f"/workspaces/{target}/search"
    found = recipient.ok("POST", search, {"query": "강수", "mode": "keyword"})
    assert found["items"], "the copied revision is not searchable"
    assert {h["document_id"] for h in found["items"]} == {copy["id"]}
    leaked = recipient.ok("POST", search, {"query": draft, "mode": "keyword"})
    assert leaked["items"] == [], "an unpublished correction was forked"
    blocks = recipient.ok("GET", f"/documents/{copy['id']}/blocks?limit=500")["items"]
    assert all(draft not in b["text"] for b in blocks)

    # The question's chapter and source point into the copy.
    (question,) = recipient.list_questions(target)
    assert question["chapter_id"] == copied_outline["items"][0]["id"]
    (src,) = question["sources"]
    assert src["document_id"] == copy["id"]
    assert src["document_revision_id"] == copy["active_revision_id"]


# --- isolation ----------------------------------------------------------------------------------


def test_fork_job_and_copy_are_private_to_the_forker(seed: Any) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-iso")
    owner.create_question(ws["id"], "S3a 격리 문제")
    stranger = seed.client("s3a-iso-stranger")
    res = recipient.fork(link["id"], cookie, "S3a 격리 fork")
    seed.assert_status(res, 202, "fork start")
    started = res.json()
    fork = recipient.wait_fork(started["id"], "COMPLETED")
    target = str(fork["target_workspace_id"])

    assert set(fork) == {
        "id",
        "job_id",
        "status",
        "progress",
        "name",
        "target_workspace_id",
        "error_code",
        "created_at",
        "updated_at",
        "completed_at",
    }, "the fork exposes no manifest, link or owner data"
    # The job lives in the source workspace but is nobody's /jobs resource.
    for client in (owner, recipient, stranger):
        seed.assert_status(client.call("GET", f"/jobs/{started['job_id']}"), 404, "fork job")
    for client in (owner, stranger):
        seed.assert_status(client.call("GET", f"/workspaces/{target}"), 404, "copy")
        seed.assert_status(client.get_fork(started["id"]), 404, "fork record")
    events = seed._admin(
        "select event_type, actor_id::text from public.activity_events where workspace_id = %s",
        (target,),
    )
    assert events == [("workspace.forked", recipient.user.id)]


# --- races --------------------------------------------------------------------------------------


def test_commit_waits_for_an_in_flight_revoke_and_then_cancels(
    seed: Any, worker_engine: Engine
) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-race1")
    owner.create_question(ws["id"], "S3a 경쟁 문제")
    fork = _request_fork(seed, recipient, link, cookie, "S3a 경쟁 fork")
    store = PostgresForkStore(worker_engine)
    outcome: dict[str, str] = {}

    with psycopg.connect(seed.DB_ADMIN_URL) as revoker:
        revoker.execute(
            "update public.workspace_share_links set revoked_at = now() where id = %s",
            (link["id"],),
        )  # the revoke is in flight (row locked, not committed)
        committer = threading.Thread(target=lambda: outcome.update(r=store.commit(fork["id"])))
        committer.start()
        committer.join(1.0)
        assert committer.is_alive(), "the commit did not wait for the in-flight revoke"
        revoker.commit()
    committer.join(30)
    assert outcome == {"r": "unusable"}
    assert seed.workspaces_owned_by(recipient.user.id) == 0


def test_revoke_waits_for_an_in_flight_commit_and_the_copy_survives(
    seed: Any, worker_engine: Engine
) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-race2")
    owner.create_question(ws["id"], "S3a 살아남는 문제")
    fork = _request_fork(seed, recipient, link, cookie, "S3a 먼저 커밋")
    revoked = threading.Event()

    def revoke() -> None:
        with psycopg.connect(seed.DB_ADMIN_URL, autocommit=True) as conn:
            conn.execute(
                "update public.workspace_share_links set revoked_at = now() where id = %s",
                (link["id"],),
            )
        revoked.set()

    with psycopg.connect(_worker_conn_url(worker_engine)) as worker:
        (result,) = worker.execute("select public.worker_fork_commit(%s)", (fork["id"],)).fetchone()
        assert result == "completed"
        revoker = threading.Thread(target=revoke)
        revoker.start()
        assert not revoked.wait(1.0), "the revoke did not wait for the in-flight commit"
        worker.commit()
    revoker.join(30)
    assert revoked.is_set()
    done = recipient.ok("GET", f"/me/forks/{fork['id']}")
    assert done["status"] == "COMPLETED"
    stems = [q["revision"]["stem"] for q in recipient.list_questions(done["target_workspace_id"])]
    assert stems == ["S3a 살아남는 문제"]


def test_two_commits_of_one_fork_copy_once(seed: Any, worker_engine: Engine) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-race3")
    owner.create_question(ws["id"], "S3a 한 번만")
    fork = _request_fork(seed, recipient, link, cookie, "S3a 동시 커밋")
    store = PostgresForkStore(worker_engine)
    outcome: dict[str, str] = {}

    with psycopg.connect(_worker_conn_url(worker_engine)) as first:
        (result,) = first.execute("select public.worker_fork_commit(%s)", (fork["id"],)).fetchone()
        second = threading.Thread(target=lambda: outcome.update(r=store.commit(fork["id"])))
        second.start()
        second.join(1.0)
        assert second.is_alive(), "the second commit did not wait for the first"
        first.commit()
    second.join(30)
    assert (result, outcome) == ("completed", {"r": "completed"})
    assert seed.workspaces_owned_by(recipient.user.id) == 1
    (target,) = [w["id"] for w in recipient.list_workspaces()]
    assert seed.question_rows(target) == [("CONFIRMED", False, "S3a 한 번만")]


# --- retries ------------------------------------------------------------------------------------


class _DropAfterCommit:
    """ForkStore whose first commit commits but is reported lost (connection dropped)."""

    def __init__(self, inner: ForkStore) -> None:
        self._inner = inner
        self.commits = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def commit(self, fork_id: uuid.UUID) -> Any:
        self.commits += 1
        outcome = self._inner.commit(fork_id)
        if self.commits == 1:
            raise JobError("connection lost after commit")
        return outcome


class _FlakyCopy:
    """ObjectCopier whose first copy fails (retryable), after the object may have been written."""

    def __init__(self, inner: ObjectCopier) -> None:
        self._inner = inner
        self.copies = 0

    def copy(self, bucket: str, source_key: str, dest_key: str) -> None:
        self.copies += 1
        self._inner.copy(bucket, source_key, dest_key)
        if self.copies == 1:
            raise JobError("storage timeout")

    def delete(self, bucket: str, key: str) -> None:
        self._inner.delete(bucket, key)


@pytest.mark.parametrize("fault", ["storage", "commit"])
def test_a_retried_fork_job_copies_once(seed: Any, fault: str) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, f"s3a-retry-{fault}")
    doc = _book(owner, ws["id"])
    owner.create_question(ws["id"], "S3a 재시도 문제")
    fork = _request_fork(seed, recipient, link, cookie, "S3a 재시도 fork")

    jobs, runner, _ = seed.worker._build()
    base = seed.worker.fork_deps
    deps = (
        dataclasses.replace(base, storage=_FlakyCopy(base.storage))
        if fault == "storage"
        else dataclasses.replace(base, forks=_DropAfterCommit(base.forks))
    )
    definition = workspace_fork_definition(lambda: deps)
    job_id = uuid.UUID(fork["job_id"])
    for _ in range(5):
        record = jobs.get(job_id)
        assert record is not None
        if record.status in TERMINAL_STATUSES:
            break
        runner.run(definition, record.to_envelope().to_message())
    record = jobs.get(job_id)
    assert record is not None
    assert (record.status.value, record.attempts) == ("succeeded", 2)

    done = recipient.ok("GET", f"/me/forks/{fork['id']}")
    assert done["status"] == "COMPLETED"
    target = str(done["target_workspace_id"])
    assert seed.workspaces_owned_by(recipient.user.id) == 1
    assert seed.question_rows(target) == [("CONFIRMED", False, "S3a 재시도 문제")]
    (copy,) = recipient.ok("GET", f"/workspaces/{target}/documents")["items"]
    assert copy["id"] != doc
    ((_, key),) = _target_objects(seed, fork["id"])
    assert _object_exists(seed, key)
    assert _points(seed, target) > 0


# --- cancellation cleanup -------------------------------------------------------------------------


def test_a_cancelled_fork_removes_its_storage_copies_and_index_points(seed: Any) -> None:
    owner, ws, link, recipient, cookie = _shared(seed, "s3a-clean")
    _book(owner, ws["id"])
    res = recipient.fork(link["id"], cookie, f"S3a {seed.FORK_PAUSE_MARKER}")
    seed.assert_status(res, 202, "fork start")
    fork_id = res.json()["id"]
    recipient.wait_fork(fork_id, "COPYING")
    # Paused right before the commit: the copies exist now.
    deadline = time.monotonic() + 60
    objects: list[tuple[str, str]] = []
    while time.monotonic() < deadline:
        objects = _target_objects(seed, fork_id)
        if objects and _object_exists(seed, objects[0][1]) and _points(seed, objects[0][0]):
            break
        time.sleep(0.25)
    ((target_ws, key),) = objects
    assert _object_exists(seed, key), "the paused fork has not copied the PDF"
    assert _points(seed, target_ws) > 0, "the paused fork has not indexed the copy"

    seed.assert_status(owner.patch_link(ws["id"], link["id"], allow_fork=False), 200, "OFF")
    cancelled = recipient.wait_fork(fork_id, "CANCELLED")
    seed.worker.join()
    assert cancelled["error_code"] == "share_unavailable"
    assert not _object_exists(seed, key), "the copied PDF was left behind"
    assert _points(seed, target_ws) == 0, "the copy's Qdrant points were left behind"
    assert seed.workspaces_owned_by(recipient.user.id) == 0
