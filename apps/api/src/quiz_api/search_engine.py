"""The API's handle on the document index (M3.6a).

`SearchEngine` builds one `book_core.search.SearchService` per process on first use: a Qdrant
client, the same embedder the worker indexes with (`select_embedder` with the worker's
`WORKER_EMBEDDER` / `APP_ENV`) and the same collection namespace (`QDRANT_COLLECTION_PREFIX`).
Qwen3 weights load on the first search outside APP_ENV=test (the store reads the embedder's
dimension for its model key), so the build is serialised by a lock.

Interactive search runs without a reranker (implementation-plan §7: `SearchLimits.rerank` off by
default; CPU reranking costs seconds per query).

`WORKER_EMBEDDER=workers_ai` (M7.4b) embeds queries on Cloudflare Workers AI with the worker's
`CLOUDFLARE_*` credentials (two attempts, `CLOUDFLARE_AI_TIMEOUT_SECONDS` each); no model is loaded
in this process. When the query embedder fails, `SearchService` degrades to BM25
(SEARCH-01-AC06). APP_ENV=test only: `QueryFailureInjectingEmbedder` makes a query containing
`QUERY_EMBEDDING_FAILURE_MARKER` fail like an unavailable hosted embedder, so E2E can reproduce the
degrade deterministically (never installed in another environment).
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Sequence

from book_core.embedding import (
    Embedder,
    EmbedderMode,
    EmbeddingUnavailableError,
    select_embedder,
)
from book_core.embedding.workers_ai import workers_ai_config
from book_core.indexing import CollectionNames, IndexStore, QdrantIndexStore
from book_core.search import SearchService

from quiz_api.settings import Environment, Settings

logger = logging.getLogger(__name__)

QDRANT_TIMEOUT_SECONDS = 10


# Interactive search: a slow hosted embedder should degrade quickly rather than hang the request.
QUERY_EMBEDDING_ATTEMPTS = 2
QUERY_EMBEDDING_FAILURE_MARKER = "E2E-FAIL-EMBEDDING"


class SearchUnavailableError(RuntimeError):
    """The index cannot be reached or is not configured (answered as 503)."""


class QueryFailureInjectingEmbedder:
    """APP_ENV=test only: queries containing the marker fail like an unavailable hosted embedder."""

    def __init__(self, inner: Embedder, marker: str = QUERY_EMBEDDING_FAILURE_MARKER) -> None:
        self._inner = inner
        self._marker = marker

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    @property
    def dimension(self) -> int:
        return self._inner.dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return self._inner.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        if self._marker in text:
            raise EmbeddingUnavailableError("query embedding unavailable (injected test failure)")
        return self._inner.embed_query(text)


def build_query_embedder(settings: Settings) -> Embedder:
    """The worker's embedder (same model key), configured for interactive queries."""
    test_env = settings.app_env is Environment.TEST
    hosted = None
    if EmbedderMode(settings.search_embedder) is EmbedderMode.WORKERS_AI:
        token = settings.cloudflare_api_token
        try:
            hosted = workers_ai_config(
                settings.cloudflare_account_id,
                token.get_secret_value() if token else None,
                batch_size=settings.cloudflare_ai_batch_size,
                timeout_seconds=settings.cloudflare_ai_timeout_seconds,
                max_attempts=QUERY_EMBEDDING_ATTEMPTS,
            )
        except ValueError:
            raise SearchUnavailableError(
                "CLOUDFLARE_ACCOUNT_ID is not a valid account id"
            ) from None
        if hosted is None:
            raise SearchUnavailableError(
                "WORKER_EMBEDDER=workers_ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
            )
    elif settings.search_models_offline:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    embedder = select_embedder(
        settings.search_embedder,
        test_env=test_env,
        local_files_only=settings.search_models_offline,
        workers_ai=hosted,
    )
    return QueryFailureInjectingEmbedder(embedder) if test_env else embedder


def build_index_store(settings: Settings) -> IndexStore:
    if not settings.qdrant_url:
        raise SearchUnavailableError("QDRANT_URL is not set")
    from qdrant_client import QdrantClient

    embedder = build_query_embedder(settings)
    api_key = settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else None
    client = QdrantClient(
        url=settings.qdrant_url, api_key=api_key or None, timeout=QDRANT_TIMEOUT_SECONDS
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
