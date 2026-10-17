"""Model and index adapters for document jobs, chosen by worker settings (M3.2b).

Production (`APP_ENV` local/preview/production with `auto`): Docling on CPU and Qwen3-Embedding.
`APP_ENV=test` with `auto` (E2E and infra tests, implementation-plan §7):

- parser: `FixtureParser` serves the ideal `ParsedDocument` of a synthetic fixture
  (`tests/fixtures/pdfs/*.truth.json`) when the uploaded bytes' SHA-256 matches it, and falls back
  to Docling for any other PDF. The Docling path itself is covered by a `models` test.
- embedder: the deterministic `FakeEmbedder`, wrapped in `FailureInjectingEmbedder`: text that
  contains `INDEX_FAILURE_MARKER` makes indexing fail (non-retryable), so DOC-02-AC04 can fail a
  reindex deterministically. The wrapper is installed only in APP_ENV=test.

Heavy imports (Docling, torch) happen only when the adapter is first used.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path

from book_core.contracts import ParsedDocument
from book_core.embedding import Embedder, FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from book_core.parser import FakeParser, ParserOptions, PdfParser, sha256_hex

from quiz_worker.errors import NonRetryableJobError
from quiz_worker.settings import EmbedderMode, ParserMode, WorkerSettings

INDEX_FAILURE_MARKER = "E2E-FAIL-INDEXING"
_REPO_FIXTURES = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "pdfs"


class WorkerNotConfiguredError(NonRetryableJobError):
    code = "worker_not_configured"


class IndexingFailedError(NonRetryableJobError):
    code = "indexing_failed"


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


class LazyDoclingParser:
    """Builds `DoclingParser` (and loads its models) on first use."""

    def __init__(self, options: ParserOptions) -> None:
        self._options = options
        self._parser: PdfParser | None = None

    def _get(self) -> PdfParser:
        if self._parser is None:
            from book_core.parser.docling_adapter import DoclingParser

            self._parser = DoclingParser(self._options)
        return self._parser

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
    mode = settings.embedder
    embedder: Embedder
    if mode is EmbedderMode.FAKE or (mode is EmbedderMode.AUTO and settings.is_test):
        embedder = FakeEmbedder()
    else:
        _prepare_offline(settings)
        from book_core.embedding import Qwen3Embedder, Qwen3EmbedderConfig

        embedder = Qwen3Embedder(Qwen3EmbedderConfig(local_files_only=settings.models_offline))
    if settings.is_test:
        embedder = FailureInjectingEmbedder(embedder)
    return embedder


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
