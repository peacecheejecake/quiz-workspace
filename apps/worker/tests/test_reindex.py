"""Unit tests of the Qdrant rebuild (quiz_worker.reindex, M7.3) on the in-memory fakes.

A document is published through the real `document.parse` job (test_document_job.World), then
re-indexed into a fresh in-memory Qdrant standing in for a lost index. The Postgres source query
and the CLI against the local stack are covered by tests/integration/workspaces/test_reindex.py.
"""

from __future__ import annotations

import io
import json
import uuid
from dataclasses import replace
from typing import Any

import pytest
from book_core.chunker import chunk_revision
from quiz_worker import reindex
from quiz_worker.reindex import Target, parse_args, reindex_document, run
from quiz_worker.runner import RunOutcome
from quiz_worker.settings import WorkerSettings

from .document_fakes import memory_index, points
from .test_document_job import World


def _published(world: World) -> Target:
    document, revision = world.upload(title="합성 교재")
    result = world.run(world.submit(document, revision.id))
    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    return Target(document.workspace_id, document.id, revision.id)


@pytest.fixture
def world() -> World:
    return World()


def test_rebuilds_a_lost_index_from_the_db(world: World) -> None:
    target = _published(world)
    original = world.points(world.store.documents[target.document_id])
    fresh, client = memory_index(prefix="rebuilt_")

    summary = run(iter([target]), world.store, fresh)

    assert [o.status for o in summary.outcomes] == ["indexed"]
    outcome = summary.outcomes[0]
    rebuilt = points(fresh, client, target.document_id)
    assert len(rebuilt) == len(original) == outcome.chunks
    assert {p["chunk_id"] for p in rebuilt} == {p["chunk_id"] for p in original}
    assert {p["revision_id"] for p in rebuilt} == {str(target.revision_id)}
    assert {p["workspace_id"] for p in rebuilt} == {str(target.workspace_id)}
    assert {p["active"] for p in rebuilt} == {True}
    assert {p["document_type"] for p in rebuilt} == {"book"}
    assert outcome.embedded
    assert outcome.embedded > 0
    assert summary.ok


def test_second_run_embeds_nothing(world: World) -> None:
    target = _published(world)
    fresh, client = memory_index(prefix="rebuilt_")
    run(iter([target]), world.store, fresh)
    before = points(fresh, client, target.document_id)

    again = run(iter([target]), world.store, fresh)

    assert [(o.status, o.embedded) for o in again.outcomes] == [("indexed", 0)]
    assert points(fresh, client, target.document_id) == before


def test_dry_run_reads_the_db_only(world: World) -> None:
    target = _published(world)
    document = world.store.documents[target.document_id]
    content = world.store.load_content(document, world.store.revisions[target.revision_id])

    summary = run(iter([target]), world.store, None)

    expected = len(chunk_revision(content, document_title=document.title).chunks)
    assert [(o.status, o.chunks) for o in summary.outcomes] == [("planned", expected)]
    assert summary.ok


def test_documents_changed_since_listing_are_skipped(world: World) -> None:
    target = _published(world)
    fresh, client = memory_index(prefix="rebuilt_")
    document = world.store.documents[target.document_id]
    world.store.documents[target.document_id] = replace(document, deleted=True)
    stale = Target(target.workspace_id, target.document_id, uuid.uuid4())
    other_workspace = Target(uuid.uuid4(), target.document_id, target.revision_id)

    summary = run(iter([target, stale, other_workspace]), world.store, fresh)

    assert [(o.status, o.reason) for o in summary.outcomes] == [
        ("skipped", "no_longer_active"),
        ("skipped", "not_found"),
        ("skipped", "not_found"),
    ]
    assert points(fresh, client, target.document_id) == []
    assert summary.ok


def test_busy_and_failed_documents_fail_the_run_without_leaking(world: World) -> None:
    target = _published(world)

    class Broken:
        def index_revision(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("qdrant at http://admin:hunter2@qdrant:6333 is down")

    failed = reindex_document(world.store, Broken(), target)  # type: ignore[arg-type]
    world.store.busy = True
    busy = reindex_document(world.store, Broken(), target)  # type: ignore[arg-type]

    assert failed.status == "failed"
    assert failed.reason is not None
    assert "hunter2" not in failed.reason
    assert (busy.status, busy.reason) == ("busy", "document_busy")
    summary = reindex.Summary([failed, busy])
    assert not summary.ok
    assert summary.as_dict()["failed"] == 1


def test_fail_fast_and_limit_stop_early(world: World) -> None:
    first, second = _published(world), _published(world)
    fresh, _ = memory_index(prefix="rebuilt_")
    assert len(run(iter([first, second]), world.store, fresh, limit=1).outcomes) == 1
    world.store.busy = True
    stopped = run(iter([first, second]), world.store, fresh, fail_fast=True)
    assert [o.status for o in stopped.outcomes] == ["busy"]


def test_resolves_a_pending_index_sync_obligation(world: World) -> None:
    target = _published(world)
    sync_id = world.store.sync_jobs[target.revision_id]
    world.store.sync_status[sync_id] = "queued"  # the inline mirror had failed
    fresh, _ = memory_index(prefix="rebuilt_")

    run(iter([target]), world.store, fresh)

    assert world.store.sync_status[sync_id] == "resolved"


def test_cli_requires_a_scope_and_validates_ids() -> None:
    with pytest.raises(SystemExit):
        parse_args([])
    with pytest.raises(SystemExit):
        parse_args(["--all", "--workspace", str(uuid.uuid4())])
    with pytest.raises(SystemExit):
        parse_args(["--workspace", "not-a-uuid"])
    with pytest.raises(SystemExit):
        parse_args(["--all", "--limit", "0"])
    ws = uuid.uuid4()
    args = parse_args(["--workspace", str(ws), "--workspace", str(ws), "--dry-run"])
    assert (args.workspace, args.all, args.dry_run) == ([ws, ws], False, True)


def test_cli_without_a_database_url_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_DATABASE_URL", raising=False)
    out = io.StringIO()
    code = reindex.main(
        ["--all", "--dry-run"],
        settings=WorkerSettings(_env_file=None),  # type: ignore[call-arg]
        out=out,
    )
    assert code == 2
    assert out.getvalue() == ""


def test_summary_reports_ids_and_counts_only(world: World) -> None:
    target = _published(world)
    fresh, _ = memory_index(prefix="rebuilt_")
    summary = run(iter([target]), world.store, fresh)
    rendered = json.dumps(summary.as_dict())
    assert "합성 교재" not in rendered
    assert summary.as_dict()["last_document_id"] == str(target.document_id)
