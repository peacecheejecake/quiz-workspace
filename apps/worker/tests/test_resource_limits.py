"""M7.4c: worker memory and time limits (Docling page queue, threads, per-job time limits)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError
from quiz_worker.adapters import build_index_store, parser_options
from quiz_worker.settings import WorkerSettings


def _settings(**env: str) -> WorkerSettings:
    return WorkerSettings.model_validate(env)


def test_docling_page_queue_is_bounded_by_default() -> None:
    options = parser_options(_settings())

    assert options.queue_max_size == 8
    assert options.page_batch_size == 4


def test_docling_page_queue_and_batch_are_configurable() -> None:
    options = parser_options(
        _settings(WORKER_PARSE_QUEUE_MAX_SIZE="4", WORKER_PARSE_PAGE_BATCH_SIZE="2")
    )

    assert (options.queue_max_size, options.page_batch_size) == (4, 2)


def test_page_batch_cannot_exceed_the_queue() -> None:
    with pytest.raises(ValidationError, match="WORKER_PARSE_PAGE_BATCH_SIZE"):
        _settings(WORKER_PARSE_QUEUE_MAX_SIZE="2", WORKER_PARSE_PAGE_BATCH_SIZE="4")


def test_worker_index_store_does_not_load_the_embedding_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # deps_from_settings builds the index store before parsing; with the local Qwen3 embedder
    # that used to load ~3 GB of weights just to learn the vector size.
    from book_core.embedding import qwen3

    def refuse(config: object) -> None:
        raise AssertionError("embedding weights loaded while building the index store")

    monkeypatch.setattr(qwen3, "_TransformersBackend", refuse)
    store = build_index_store(
        _settings(APP_ENV="local", WORKER_EMBEDDER="qwen3", QDRANT_URL="http://127.0.0.1:1")
    )

    assert store.collection_metadata()["dimension"] == 1024
