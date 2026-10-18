"""`document.parse` on real Docling models (book-ko through the worker pipeline, no Celery).

`make test-models` only (downloads ~0.5 GB of HF weights on first run). DB and Storage are the
in-memory fakes and Qdrant runs in local mode; the embedder stays the fake (Qwen3 is covered by
packages/core's own `models` tests), so this checks the production parser path end to end:
Docling output -> structure -> DB rows -> chunks -> index -> publish.
"""

from __future__ import annotations

import json
import uuid

import pytest
from quiz_worker.document_job import (
    JOB_TYPE,
    DocumentJobDeps,
    DocumentParsePayloadV1,
    Limits,
    run_document_parse,
)
from quiz_worker.envelope import JobEnvelope
from quiz_worker.runner import context_for
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore

from .document_fakes import PDF_DIR, FakeDocumentStore, FakeStorage, memory_index, points

pytestmark = pytest.mark.models


def test_docling_parse_of_book_ko_through_the_worker() -> None:
    from quiz_worker.adapters import LazyDoclingParser, build_parser

    settings = WorkerSettings.model_validate({"APP_ENV": "local", "WORKER_PARSER": "docling"})
    parser = build_parser(settings)
    assert isinstance(parser, LazyDoclingParser)

    data = (PDF_DIR / "book-ko.pdf").read_bytes()
    truth = json.loads((PDF_DIR / "book-ko.truth.json").read_text(encoding="utf-8"))
    store, storage = FakeDocumentStore(), FakeStorage()
    document, revision = store.add_document(data, title=truth["title"])
    storage.put_source(document, data)
    index, client = memory_index("models_")
    deps = DocumentJobDeps(
        documents=store, storage=storage, index=index, parser=parser, limits=Limits()
    )
    jobs = InMemoryJobStore()
    envelope = JobEnvelope(
        job_id=uuid.uuid4(),
        job_type=JOB_TYPE,
        schema_version=1,
        idempotency_key=None,
        workspace_id=document.workspace_id,
        created_by=None,
        payload={"document_id": str(document.id), "revision_id": str(revision.id)},
    )
    jobs.create(envelope, max_attempts=3)
    claim = jobs.claim(envelope, worker_id="models", lease_seconds=3600)
    assert claim.record is not None

    result = run_document_parse(
        deps,
        context_for(claim.record, jobs),
        DocumentParsePayloadV1.model_validate(envelope.payload),
    )

    assert result is not None
    assert result["revision_id"] == str(revision.id)
    assert store.documents[document.id].status == "ready"
    rev = store.revisions[revision.id]
    assert rev.status == "published"
    chapters = {c["title"] for c in store.chapters[revision.id]}
    expected = {s["title"] for s in truth["sections"]}
    assert len(chapters & expected) >= len(expected) - 1, (chapters, expected)
    blocks = store.blocks[revision.id]
    assert {b["page"] for b in blocks} <= {p["page"] for p in truth["pages"]}
    assert all(b["provenance"]["locations"] for b in blocks)
    stored = points(index, client, document.id)
    assert stored
    assert {p["active"] for p in stored} == {True}
    assert parser.parser_version.startswith("docling/")
