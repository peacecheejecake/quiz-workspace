"""M7.3 Qdrant rebuild (`python -m quiz_worker.reindex`) against the local stack.

Documents are uploaded through the API and published by the real `document.parse` job (in-process
JobRunner, `quiz_worker` role, Supabase Storage, APP_ENV=test fixture parser + fake embedder) into
Qdrant collections under a per-module prefix. The test then drops those collections (a lost
index) and rebuilds them with the CLI, scoped to one workspace: the published active revision
comes back active, other workspaces and soft-deleted documents stay out, a second run embeds
nothing, `--dry-run` never touches Qdrant and `--after` resumes.

Needs `make infra-up`, the quiz_api / quiz_worker login steps (AGENTS.md §7) and
SUPABASE_SECRET_KEY in `.env` or the environment. Fixtures: conftest.py.
"""

from __future__ import annotations

import io
import json
import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_worker import reindex
from quiz_worker.adapters import FailureInjectingEmbedder, build_parser
from quiz_worker.document_job import DocumentJobDeps, Limits, document_parse_definition
from quiz_worker.document_store import PostgresDocumentStore
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.runner import JobRunner, RunOutcome
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import SupabaseStorage

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DATABASE_URL = os.environ.get(
    "WORKER_DATABASE_URL", "postgresql://quiz_worker:change-me-local@127.0.0.1:54322/postgres"
)


@dataclass
class Rig:
    settings: WorkerSettings
    client: QdrantClient
    names: CollectionNames
    deps: DocumentJobDeps
    jobs: PostgresJobStore
    engine: Any

    def publish(self, job_id: str) -> None:
        record = self.jobs.get(uuid.UUID(job_id))
        assert record is not None, "job row missing"
        runner = JobRunner(self.jobs, worker_id="it-m73", lease_seconds=600)
        result = runner.run(
            document_parse_definition(lambda: self.deps), record.to_envelope().to_message()
        )
        assert result.outcome is RunOutcome.SUCCEEDED, result.error

    def drop_index(self) -> None:
        for alias in self.client.get_aliases().aliases:
            if alias.alias_name == self.names.alias:
                self.client.update_collection_aliases(
                    change_aliases_operations=[
                        qm.DeleteAliasOperation(
                            delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                        )
                    ]
                )
        for collection in self.client.get_collections().collections:
            if self.names.owns(collection.name):
                self.client.delete_collection(collection.name)

    def collections(self) -> list[str]:
        return [
            c.name for c in self.client.get_collections().collections if self.names.owns(c.name)
        ]

    def points(self, document_id: str) -> list[dict[str, Any]]:
        (collection,) = self.collections()
        flt = qm.Filter(
            must=[qm.FieldCondition(key="document_id", match=qm.MatchValue(value=document_id))]
        )
        records, _ = self.client.scroll(
            collection, scroll_filter=flt, limit=10_000, with_payload=True
        )
        return [dict(r.payload or {}) for r in records]

    def cli(self, *argv: str) -> tuple[int, list[dict[str, Any]]]:
        out = io.StringIO()
        code = reindex.main(list(argv), settings=self.settings, out=out)
        return code, [json.loads(line) for line in out.getvalue().splitlines()]


@pytest.fixture(scope="module")
def rig() -> Iterator[Rig]:
    base = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    if not base.supabase_secret_key or not base.supabase_url:
        pytest.fail("SUPABASE_SECRET_KEY / SUPABASE_URL missing (Storage access)")
    prefix = f"it_m73_{uuid.uuid4().hex[:8]}_"
    settings = base.model_copy(
        update={
            "app_env": Environment.TEST,
            "worker_database_url": WORKER_DATABASE_URL,
            "qdrant_url": base.qdrant_url or "http://127.0.0.1:6333",
            "qdrant_collection_prefix": prefix,
        }
    )
    client = QdrantClient(url=settings.qdrant_url, timeout=30)
    names = CollectionNames(prefix=prefix)
    engine = create_job_store_engine(WORKER_DATABASE_URL, pool_size=4)
    secret = settings.supabase_secret_key
    assert secret is not None
    assert settings.supabase_url
    storage = SupabaseStorage(settings.supabase_url, secret.get_secret_value())
    deps = DocumentJobDeps(
        documents=PostgresDocumentStore(engine),
        storage=storage,
        index=QdrantIndexStore(client, FailureInjectingEmbedder(FakeEmbedder()), names=names),
        parser=build_parser(settings),
        limits=Limits(lock_wait_seconds=10),
    )
    r = Rig(settings, client, names, deps, PostgresJobStore(engine), engine)
    try:
        yield r
    finally:
        r.drop_index()
        storage.close()
        engine.dispose()
        client.close()


def _published_book(seed: Any, rig: Rig, label: str) -> tuple[Any, str, str, str]:
    owner = seed.client(label)
    ws = owner.create_workspace()
    _, _, done = owner.upload_book(ws["id"])
    rig.publish(done["job_id"])
    document = owner.ok("GET", f"/documents/{done['document_id']}")
    return owner, ws["id"], done["document_id"], document["active_revision_id"]


def test_m73_reindex_rebuilds_a_lost_index_for_one_workspace(seed: Any, rig: Rig) -> None:
    _, ws, doc, rev = _published_book(seed, rig, "m73-a")
    _, other_ws, other_doc, _ = _published_book(seed, rig, "m73-b")
    before = {p["chunk_id"] for p in rig.points(doc)}
    assert before
    assert rig.points(other_doc)

    rig.drop_index()
    assert rig.collections() == []

    code, lines = rig.cli("--workspace", ws)

    assert code == 0, lines
    *outcomes, summary = lines
    assert [(o["document_id"], o["status"]) for o in outcomes] == [(doc, "indexed")]
    assert outcomes[0]["revision_id"] == rev
    assert outcomes[0]["embedded"] > 0
    assert summary["summary"]["indexed"] == 1
    assert summary["summary"]["last_document_id"] == doc
    rebuilt = rig.points(doc)
    assert {p["chunk_id"] for p in rebuilt} == before
    assert {(p["workspace_id"], p["revision_id"], p["active"]) for p in rebuilt} == {
        (ws, rev, True)
    }
    assert rig.points(other_doc) == [], "another workspace must not be rebuilt"
    assert other_ws != ws

    # Idempotent: a second run stores nothing new.
    code, lines = rig.cli("--workspace", ws)
    assert code == 0
    assert [(o["status"], o["embedded"]) for o in lines[:-1]] == [("indexed", 0)]
    assert {p["chunk_id"] for p in rig.points(doc)} == before


def test_m73_reindex_skips_deleted_documents_and_resumes(seed: Any, rig: Rig) -> None:
    owner = seed.client("m73-resume")
    ws = owner.create_workspace()["id"]
    docs = []
    for _ in range(3):
        _, _, done = owner.upload_book(ws)
        rig.publish(done["job_id"])
        docs.append(done["document_id"])
    docs.sort()
    owner.ok("DELETE", f"/documents/{docs[1]}", expected=(200, 202, 204))

    listed = [str(t.document_id) for t in reindex.iter_targets(rig.engine, [uuid.UUID(ws)])]
    assert listed == [docs[0], docs[2]]
    paged = [
        str(t.document_id) for t in reindex.iter_targets(rig.engine, [uuid.UUID(ws)], page_size=1)
    ]
    assert paged == listed
    everywhere = {str(t.document_id) for t in reindex.iter_targets(rig.engine, None)}
    assert {docs[0], docs[2]} <= everywhere
    assert docs[1] not in everywhere

    rig.drop_index()
    code, lines = rig.cli("--workspace", ws, "--limit", "1")
    assert code == 0
    assert [o["document_id"] for o in lines[:-1]] == [docs[0]]
    code, lines = rig.cli("--workspace", ws, "--after", docs[0])
    assert code == 0
    assert [(o["document_id"], o["status"]) for o in lines[:-1]] == [(docs[2], "indexed")]
    assert rig.points(docs[2])
    assert rig.points(docs[1]) == []


def test_m73_reindex_dry_run_never_touches_qdrant(seed: Any, rig: Rig) -> None:
    _, ws, doc, rev = _published_book(seed, rig, "m73-dry")
    rig.drop_index()

    code, lines = rig.cli("--workspace", ws, "--dry-run")

    assert code == 0
    *outcomes, summary = lines
    assert [(o["document_id"], o["revision_id"], o["status"]) for o in outcomes] == [
        (doc, rev, "planned")
    ]
    assert outcomes[0]["chunks"] > 0
    assert summary["dry_run"] is True
    assert rig.collections() == [], "dry run must not create collections"
