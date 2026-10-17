"""The API's handle on the document index (M3.6a).

`SearchEngine` builds one `book_core.search.SearchService` per process on first use: a Qdrant
client, the same embedder the worker indexes with (`select_embedder` with the worker's
`WORKER_EMBEDDER` / `APP_ENV`) and the same collection namespace (`QDRANT_COLLECTION_PREFIX`).
Qwen3 weights load on the first search outside APP_ENV=test (the store reads the embedder's
dimension for its model key), so the build is serialised by a lock.

Interactive search runs without a reranker (implementation-plan §7: `SearchLimits.rerank` off by
default; CPU reranking costs seconds per query).
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable

from book_core.embedding import select_embedder
from book_core.indexing import CollectionNames, IndexStore, QdrantIndexStore
from book_core.search import SearchService

from quiz_api.settings import Environment, Settings

logger = logging.getLogger(__name__)

QDRANT_TIMEOUT_SECONDS = 10


class SearchUnavailableError(RuntimeError):
    """The index cannot be reached or is not configured (answered as 503)."""


def build_index_store(settings: Settings) -> IndexStore:
    if not settings.qdrant_url:
        raise SearchUnavailableError("QDRANT_URL is not set")
    from qdrant_client import QdrantClient

    if settings.search_models_offline:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    api_key = settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else None
    client = QdrantClient(
        url=settings.qdrant_url, api_key=api_key or None, timeout=QDRANT_TIMEOUT_SECONDS
    )
    embedder = select_embedder(
        settings.search_embedder,
        test_env=settings.app_env is Environment.TEST,
        local_files_only=settings.search_models_offline,
    )
    return QdrantIndexStore(
        client, embedder, names=CollectionNames(prefix=settings.qdrant_collection_prefix)
    )


class SearchEngine:
    def __init__(
        self,
        settings: Settings,
        *,
        store_factory: Callable[[Settings], IndexStore] = build_index_store,
    ) -> None:
        self._settings = settings
        self._factory = store_factory
        self._service: SearchService | None = None
        self._lock = threading.Lock()

    def service(self) -> SearchService:
        if self._service is None:
            with self._lock:
                if self._service is None:
                    try:
                        store = self._factory(self._settings)
                    except SearchUnavailableError:
                        raise
                    except Exception as exc:
                        # Type only: messages can carry URLs or model paths.
                        logger.warning("search: index unavailable (%s)", type(exc).__name__)
                        raise SearchUnavailableError("search index unavailable") from exc
                    self._service = SearchService(store)
        return self._service
