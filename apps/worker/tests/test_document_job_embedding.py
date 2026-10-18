"""Hosted embedder failures during `document.parse` (M7.4b, Cloudflare Workers AI Free plan).

Quota / 429 / 5xx / timeouts are retryable job failures with a stable, non-leaking code; a
revision is published (document READY) only after every chunk is embedded, never on partial
vectors; auth/config errors fail without retry.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from book_core.embedding import (
    EmbeddingAuthError,
    EmbeddingQuotaExceededError,
    EmbeddingResponseError,
    EmbeddingUnavailableError,
    FakeEmbedder,
)
from book_core.embedding.workers_ai import WorkersAIEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from qdrant_client import QdrantClient
from quiz_worker.adapters import (
    WorkerNotConfiguredError,
    build_embedder,
    embedding_job_error,
    wrap_embedding_errors,
)
from quiz_worker.errors import JobError, is_retryable, sanitize_error
from quiz_worker.runner import RunOutcome
from quiz_worker.settings import WorkerSettings

from .test_document_job import FlakyIndex, World

BOOK_SNIPPET = "염소"


class ScriptedEmbedder(FakeEmbedder):
    """FakeEmbedder whose `embed_documents` raises `failures[n]` on the n-th call (None = ok)."""

    def __init__(self, failures: Sequence[Exception | None]) -> None:
        super().__init__()
        self.failures = list(failures)
        self.calls = 0
        self.embedded = 0

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        call = self.calls
        self.calls += 1
        failure = self.failures[call] if call < len(self.failures) else None
        if failure is not None:
            raise failure
        self.embedded += len(texts)
        return super().embed_documents(texts)


def _world(embedder: ScriptedEmbedder) -> World:
    world = World()
    client = QdrantClient(location=":memory:")
    store = QdrantIndexStore(
        client,
        wrap_embedding_errors(embedder),
        names=CollectionNames(prefix="unit_"),
        batch_size=4,
    )
    world.client = client
    world.index = FlakyIndex(store)
    world.deps.index = world.index
    return world


def _child_count(world: World, document: Any) -> int:
    return sum(1 for p in world.points(document) if p.get("level") == "child")


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (
            EmbeddingQuotaExceededError("Workers AI quota exceeded (HTTP 429)"),
            "embedding_quota_exceeded",
        ),
        (EmbeddingUnavailableError("Workers AI unavailable (HTTP 503)"), "embedding_unavailable"),
    ],
)
def test_quota_and_outages_mid_document_retry_and_never_publish_partial_vectors(
    failure: Exception, code: str
) -> None:
    # Batch 1 embeds, batch 2 fails: some vectors are written, the revision must stay a draft.
    embedder = ScriptedEmbedder([None, failure])
    world = _world(embedder)
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)

    first = world.run(envelope)

    assert first.outcome is RunOutcome.RETRY
    assert first.error is not None
    assert first.error.startswith(code)
    assert first.countdown is not None
    assert first.countdown > 0
    doc = world.store.documents[document.id]
    assert doc.status == "processing"
    assert doc.active_revision_id is None
    assert world.store.revisions[revision.id].status == "draft"
    assert {p["active"] for p in world.points(document)} <= {False}
    partial = embedder.embedded
    assert partial > 0

    second = world.run(envelope)

    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    doc = world.store.documents[document.id]
    assert (doc.status, doc.active_revision_id) == ("ready", revision.id)
    # The retry embedded only what was missing; every child chunk has its vector now.
    total = _child_count(world, document)
    assert embedder.embedded == total
    assert {p["active"] for p in world.points(document)} == {True}


def test_quota_on_every_attempt_fails_with_the_code_and_cleans_up() -> None:
    quota = EmbeddingQuotaExceededError("Workers AI quota exceeded (HTTP 429)")
    world = _world(ScriptedEmbedder([None, quota, quota, quota]))
    document, revision = world.upload()
    envelope = world.submit(document, revision.id)

    outcomes = [world.run(envelope).outcome for _ in range(3)]

    assert outcomes == [RunOutcome.RETRY, RunOutcome.RETRY, RunOutcome.FAILED]
    doc = world.store.documents[document.id]
    assert doc.status == "failed"
    assert (world.store.last_errors[document.id] or "").startswith("embedding_quota_exceeded")
    assert world.points(document) == []


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (
            EmbeddingAuthError("Workers AI rejected the credentials (HTTP 401)"),
            "embedding_not_configured",
        ),
        (
            EmbeddingResponseError("Workers AI returned 256-dimensional vectors"),
            "embedding_invalid_response",
        ),
    ],
)
def test_auth_and_contract_errors_fail_without_retry(failure: Exception, code: str) -> None:
    world = _world(ScriptedEmbedder([failure]))
    document, revision = world.upload()

    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.FAILED
    assert (result.error or "").startswith(code)
    assert world.store.documents[document.id].status == "failed"


def test_job_errors_carry_only_the_code_and_the_adapter_message() -> None:
    cases = {
        EmbeddingQuotaExceededError("q"): ("embedding_quota_exceeded", True),
        EmbeddingUnavailableError("u"): ("embedding_unavailable", True),
        EmbeddingAuthError("a"): ("embedding_not_configured", False),
        EmbeddingResponseError("r"): ("embedding_invalid_response", False),
    }
    for exc, (code, retryable) in cases.items():
        job_error = embedding_job_error(exc)
        assert isinstance(job_error, JobError)
        assert job_error.code == code
        assert is_retryable(job_error) is retryable
        assert sanitize_error(job_error) == f"{code}: {exc}"
    # Query embedding (generation's related-passage search) is left to the search degrade path.
    wrapped = wrap_embedding_errors(ScriptedEmbedder([]))
    assert len(wrapped.embed_query(BOOK_SNIPPET)) == FakeEmbedder().dimension


BASE = {"WORKER_DATABASE_URL": "postgresql://worker:pw@127.0.0.1:1/x"}


def test_workers_ai_mode_builds_the_hosted_embedder_from_settings() -> None:
    settings = WorkerSettings.model_validate(
        {
            **BASE,
            "APP_ENV": "preview",
            "WORKER_EMBEDDER": "workers_ai",
            "CLOUDFLARE_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
            "CLOUDFLARE_API_TOKEN": "cf-token-0123456789abcdef0123456789",
            "CLOUDFLARE_AI_BATCH_SIZE": "8",
        }
    )
    assert "cf-token" not in repr(settings)
    embedder = build_embedder(settings)
    assert embedder.model_name == "cloudflare-workers-ai:@cf/qwen/qwen3-embedding-0.6b"
    assert embedder.dimension == 1024
    inner = getattr(embedder, "inner", embedder)
    assert isinstance(inner, WorkersAIEmbedder)
    assert inner.config.batch_size == 8


def test_workers_ai_mode_without_credentials_is_not_configured() -> None:
    settings = WorkerSettings.model_validate(
        {**BASE, "APP_ENV": "preview", "WORKER_EMBEDDER": "workers_ai"}
    )
    with pytest.raises(WorkerNotConfiguredError) as info:
        build_embedder(settings)
    assert "CLOUDFLARE_API_TOKEN" in str(info.value)
