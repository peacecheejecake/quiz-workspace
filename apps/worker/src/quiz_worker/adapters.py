"""Model and index adapters for document jobs, chosen by worker settings (M3.2b).

Production (`APP_ENV` local/preview/production with `auto`): Docling on CPU and Qwen3-Embedding.
`APP_ENV=test` with `auto` (E2E and infra tests, implementation-plan §7):

- parser: `FixtureParser` serves the ideal `ParsedDocument` of a synthetic fixture
  (`tests/fixtures/pdfs/*.truth.json`) when the uploaded bytes' SHA-256 matches it, and falls back
  to Docling for any other PDF. The Docling path itself is covered by a `models` test.
- embedder: the deterministic `FakeEmbedder`, wrapped in `FailureInjectingEmbedder`: text that
  contains `INDEX_FAILURE_MARKER` makes indexing fail (non-retryable), so DOC-02-AC04 can fail a
  reindex deterministically. The wrapper is installed only in APP_ENV=test.

`WORKER_EMBEDDER=workers_ai` (staging/production, M7.4b) embeds on Cloudflare Workers AI. Every
embedder is wrapped in `JobErrorEmbedder`, which turns the adapters' `EmbeddingUnavailableError`s
from document embedding into job errors with a stable code: `embedding_quota_exceeded` /
`embedding_unavailable` (retryable, job backoff) and `embedding_not_configured` /
`embedding_invalid_response` (fail). Indexing writes vectors before the publish transaction, so a
failed batch leaves the revision a draft (the previous published revision stays live) and the retry
embeds only the chunks still missing. Query embedding is left as is: search degrades to BM25.

Heavy imports (Docling, torch) happen only when the adapter is first used.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from book_core.contracts import ParsedDocument
from book_core.embedding import (
    Embedder,
    EmbedderMode,
    EmbeddingAuthError,
    EmbeddingQuotaExceededError,
    EmbeddingResponseError,
    EmbeddingUnavailableError,
    select_embedder,
    uses_fake_embedder,
)
from book_core.embedding.workers_ai import workers_ai_config
from book_core.indexing import CollectionNames, QdrantIndexStore
from book_core.parser import FakeParser, ParserOptions, PdfParser, sha256_hex

from quiz_worker.errors import JobError, NonRetryableJobError
from quiz_worker.settings import ParserMode, WorkerSettings

if TYPE_CHECKING:
    from book_core.parser.docling_adapter import DoclingParser

INDEX_FAILURE_MARKER = "E2E-FAIL-INDEXING"
_REPO_FIXTURES = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "pdfs"


class WorkerNotConfiguredError(NonRetryableJobError):
    code = "worker_not_configured"


class IndexingFailedError(NonRetryableJobError):
    code = "indexing_failed"


class EmbeddingQuotaExceededJobError(JobError):
    code = "embedding_quota_exceeded"


class EmbeddingUnavailableJobError(JobError):
    code = "embedding_unavailable"


class EmbeddingNotConfiguredJobError(NonRetryableJobError):
    code = "embedding_not_configured"


class EmbeddingInvalidResponseJobError(NonRetryableJobError):
    code = "embedding_invalid_response"


def embedding_job_error(exc: EmbeddingUnavailableError) -> JobError:
    """The job error for an embedder failure. The adapters write their messages from status codes
    and counts only (never input text or credentials), so the message is kept."""
    message = str(exc)
    if isinstance(exc, EmbeddingAuthError):
        return EmbeddingNotConfiguredJobError(message)
    if isinstance(exc, EmbeddingResponseError):
        return EmbeddingInvalidResponseJobError(message)
    if isinstance(exc, EmbeddingQuotaExceededError):
        return EmbeddingQuotaExceededJobError(message)
    return EmbeddingUnavailableJobError(message)


class JobErrorEmbedder:
    """`Embedder` whose document-embedding failures are job errors (see the module docstring)."""

    def __init__(self, inner: Embedder) -> None:
        self.inner = inner

    @property
    def model_name(self) -> str:
        return self.inner.model_name

    @property
    def dimension(self) -> int:
        return self.inner.dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        try:
            return self.inner.embed_documents(texts)
        except EmbeddingUnavailableError as exc:
            raise embedding_job_error(exc) from None

    def embed_query(self, text: str) -> list[float]:
        return self.inner.embed_query(text)


def wrap_embedding_errors(embedder: Embedder) -> JobErrorEmbedder:
    return JobErrorEmbedder(embedder)


class FailureInjectingEmbedder:
    """Test-only `Embedder` that refuses documents containing the E2E failure marker."""

    def __init__(self, inner: Embedder, marker: str = INDEX_FAILURE_MARKER) -> None:
        self._inner = inner
        self._marker = marker

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    @property
    def dimension(self) -> int:
        return self._inner.dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if any(self._marker in t for t in texts):
            raise IndexingFailedError("indexing failed (injected test failure)")
        return self._inner.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return self._inner.embed_query(text)


@runtime_checkable
class PreparableParser(Protocol):
    """A parser whose models can be loaded ahead of the first `parse` (UX3-JOB): the job reports
    a `preparing` stage while they load, and a worker child can warm them up at start."""

    @property
    def prepared(self) -> bool: ...

    def prepare(self) -> None: ...


class LazyDoclingParser:
    """Builds `DoclingParser` (and loads its models) on first use, or on `prepare`."""

    def __init__(self, options: ParserOptions) -> None:
        self._options = options
        self._parser: DoclingParser | None = None
        self._lock = threading.Lock()

    def _get(self) -> DoclingParser:
        with self._lock:
            if self._parser is None:
                from book_core.parser.docling_adapter import DoclingParser

                self._parser = DoclingParser(self._options)
            return self._parser

    @property
    def prepared(self) -> bool:
        return self._parser is not None and self._parser.prepared

    def prepare(self) -> None:
        """Load the models now; a concurrent `parse` waits for it instead of loading twice."""
        self._get().prepare()

    @property
    def parser_version(self) -> str:
        return self._get().parser_version

    def parse(self, path: Path, *, source_path: str | None = None) -> ParsedDocument:
        return self._get().parse(path, source_path=source_path)


class FixtureParser:
    """Fixture truth by SHA-256, else the fallback parser (APP_ENV=test)."""

    def __init__(self, fixtures: FakeParser, known: frozenset[str], fallback: PdfParser) -> None:
        self._fixtures = fixtures
        self._known = known
        self._fallback = fallback
        self._last = fixtures.parser_version

    @classmethod
    def from_dir(cls, directory: Path, fallback: PdfParser) -> FixtureParser:
        fixtures = FakeParser.from_truth_files(sorted(directory.glob("*.truth.json")))
        known = frozenset(
            sha256_hex(p.read_bytes()) for p in directory.glob("*.pdf") if p.is_file()
        )
        return cls(fixtures, known, fallback)

    @property
    def parser_version(self) -> str:
        return self._last

    def parse(self, path: Path, *, source_path: str | None = None) -> ParsedDocument:
        if sha256_hex(path.read_bytes()) in self._known:
            parsed = self._fixtures.parse(path, source_path=source_path)
        else:
            parsed = self._fallback.parse(path, source_path=source_path)
        self._last = parsed.parser_version
        return parsed


def parser_options(settings: WorkerSettings) -> ParserOptions:
    artifacts = settings.models_artifacts_path
    return ParserOptions(
        artifacts_path=Path(artifacts) if artifacts else None,
        device="cpu",
        document_timeout=settings.parse_timeout_seconds,
        queue_max_size=settings.parse_queue_max_size,
        page_batch_size=settings.parse_page_batch_size,
        # None: Docling reads DOCLING_NUM_THREADS / OMP_NUM_THREADS (set by serve).
        num_threads=settings.num_threads,
    )


def _prepare_offline(settings: WorkerSettings) -> None:
    if settings.models_offline:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")


def build_parser(settings: WorkerSettings) -> PdfParser:
    _prepare_offline(settings)
    docling = LazyDoclingParser(parser_options(settings))
    mode = settings.parser
    if mode is ParserMode.DOCLING or (mode is ParserMode.AUTO and not settings.is_test):
        return docling
    directory = Path(settings.fixture_pdf_dir) if settings.fixture_pdf_dir else _REPO_FIXTURES
    if mode is ParserMode.FAKE:
        paths = sorted(directory.glob("*.truth.json")) if directory.is_dir() else []
        return FakeParser.from_truth_files(paths)
    if not directory.is_dir():
        raise WorkerNotConfiguredError("fixture PDF directory not found (WORKER_FIXTURE_PDF_DIR)")
    return FixtureParser.from_dir(directory, docling)


def build_embedder(settings: WorkerSettings) -> Embedder:
    # Shared with the API's query embedder (book_core.embedding.select_embedder).
    mode = EmbedderMode(settings.embedder.value)
    hosted = None
    if mode is EmbedderMode.WORKERS_AI:
        token = settings.cloudflare_api_token
        try:
            hosted = workers_ai_config(
                settings.cloudflare_account_id,
                token.get_secret_value() if token else None,
                batch_size=settings.cloudflare_ai_batch_size,
                timeout_seconds=settings.cloudflare_ai_timeout_seconds,
            )
        except ValueError:
            raise WorkerNotConfiguredError(
                "CLOUDFLARE_ACCOUNT_ID is not a valid account id"
            ) from None
        if hosted is None:
            raise WorkerNotConfiguredError(
                "WORKER_EMBEDDER=workers_ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
            )
    elif not uses_fake_embedder(mode, test_env=settings.is_test):
        _prepare_offline(settings)
    embedder = select_embedder(
        mode,
        test_env=settings.is_test,
        local_files_only=settings.models_offline,
        workers_ai=hosted,
    )
    wrapped: Embedder = JobErrorEmbedder(embedder)
    if settings.is_test:
        wrapped = FailureInjectingEmbedder(wrapped)
    return wrapped


def build_index_store(settings: WorkerSettings) -> QdrantIndexStore:
    if not settings.qdrant_url:
        raise WorkerNotConfiguredError("QDRANT_URL is not set")
    from qdrant_client import QdrantClient

    api_key = settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else None
    client = QdrantClient(url=settings.qdrant_url, api_key=api_key or None, timeout=60)
    return QdrantIndexStore(
        client,
        build_embedder(settings),
        names=CollectionNames(prefix=settings.qdrant_collection_prefix),
    )


def page_count(path: Path) -> int | None:
    """Pages of a PDF via pdfium (installed with the parser extra); None if unavailable."""
    try:
        import pypdfium2  # type: ignore[import-untyped]
    except ImportError:  # pragma: no cover - the dev install always has it
        return None
    try:
        pdf = pypdfium2.PdfDocument(str(path))
    except pypdfium2.PdfiumError:
        return -1
    try:
        return len(pdf)
    finally:
        pdf.close()
