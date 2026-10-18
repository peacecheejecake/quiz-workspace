"""M7.4c: worker memory and time limits (Docling page queue, threads, per-job time limits)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError
from quiz_worker.adapters import parser_options
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
