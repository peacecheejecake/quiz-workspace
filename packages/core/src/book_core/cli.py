"""``core`` command line (architecture.md §4).

Implemented (Task M1.5): ``parse`` (PDF -> ``ParsedDocument`` JSON), ``structure``
(``ParsedDocument`` -> ``DocumentRevision`` JSON) and ``chunk`` (revision -> ``SearchChunk``
JSONL, optional ``ChunkDiff`` against older chunks). Task M2.6: ``index`` (revision/chunks ->
Qdrant), ``search`` (query -> hits JSON within a workspace/revision scope), ``excerpt`` (hit ->
``Excerpt`` JSON) and ``eval`` (dataset + config -> JSON/Markdown report). The ``questions``
commands are stubs until their Task lands.

Conventions: ``-`` means stdin/stdout; results go to stdout or ``-o``, summaries and warnings to
stderr. Exit codes: 0 ok, 2 usage error, 1 processing error. Error messages carry ids, counts
and file names only, never book text or queries. Docling is imported only for ``--parser
docling``; Qdrant, models and the evaluation package only by the commands that use them. The
Qdrant API key is read from ``QDRANT_API_KEY`` only, never from a flag.
"""

from __future__ import annotations

import dataclasses
import json
import os
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, NoReturn

import typer
from pydantic import BaseModel, ValidationError

from book_core.chunker import ChunkDiff, ChunkerConfig, ChunkingError, chunk_revision, diff_chunks
from book_core.contracts import DocumentRevision, ParsedDocument, SearchChunk
from book_core.log_redaction import redact
from book_core.parser import FakeParser, ParserError, ParserOptions
from book_core.structure import build_revision, publish

if TYPE_CHECKING:
    from book_core.parser import PdfParser

NOT_IMPLEMENTED_EXIT_CODE = 1
PROCESSING_ERROR_EXIT_CODE = 1
STDIO = "-"
STDIN_SOURCE_PATH = "document.pdf"
SOURCE_LABEL = "<source>"
_MAX_ERROR_CHARS = 300
_MAX_LABEL_CHARS = 80

app = typer.Typer(
    name="core",
    help="Quiz Workspace core: parse, chunk, index, search, excerpt, questions, eval.",
    no_args_is_help=True,
    add_completion=False,
    pretty_exceptions_enable=False,
)
questions_app = typer.Typer(
    name="questions", help="Extract or generate question drafts.", no_args_is_help=True
)
app.add_typer(questions_app)


class ParserName(StrEnum):
    DOCLING = "docling"
    FAKE = "fake"


class CliError(Exception):
    """A processing failure reported as one sanitized stderr line and exit code 1."""


# --------------------------------------------------------------------------------------------
# I/O helpers


def _fail(message: str, sensitive: Sequence[str] = ()) -> NoReturn:
    for value in sorted(set(sensitive), key=len, reverse=True):
        if value and value != STDIO:
            message = message.replace(value, _label(value))
    text = redact(" ".join(message.split()))
    if len(text) > _MAX_ERROR_CHARS:
        text = text[: _MAX_ERROR_CHARS - 1] + "…"
    typer.echo(f"error: {text}", err=True)
    raise typer.Exit(code=PROCESSING_ERROR_EXIT_CODE)


def _label(path: str) -> str:
    """Diagnostic name of a *local* input/output argument: its basename (``<stdin>`` for ``-``),
    control characters replaced, redacted and capped. Never raises.

    Only for files the CLI itself reads or writes. ``--source-path`` (a storage key or signed
    URL) is never passed here: diagnostics never derive anything from it.
    """
    if path == STDIO:
        return "<stdin>"
    name = os.path.basename(path.replace("\\", "/").rstrip("/"))
    name = redact("".join(c if c.isprintable() else "?" for c in name))
    if len(name) > _MAX_LABEL_CHARS:
        name = name[: _MAX_LABEL_CHARS - 1] + "…"
    return name or "<unnamed>"


def _same_file(a: str, b: str) -> bool:
    first, second = Path(a), Path(b)
    try:
        if first.exists() and second.exists():
            return first.samefile(second)
        return first.resolve() == second.resolve()
    except (OSError, ValueError):
        return False


def _check_destinations(outputs: Sequence[tuple[str | None, str]], inputs: Sequence[str]) -> None:
    """Reject (exit 2, before anything is read or written) an output file that is another
    output or one of the inputs, including via ``./`` spellings, symlinks and hard links."""
    files = [(path, hint) for path, hint in outputs if path is not None and path != STDIO]
    for i, (path, hint) in enumerate(files):
        for other, other_hint in files[:i]:
            if _same_file(path, other):
                raise typer.BadParameter(f"same file as {other_hint}", param_hint=hint)
        for source in inputs:
            if source != STDIO and _same_file(path, source):
                raise typer.BadParameter("would overwrite an input file", param_hint=hint)


def _require_input(path: str | None, hint: str) -> None:
    """A missing input file is a usage error (exit 2), like click's ``exists=True``."""
    if path is not None and path != STDIO and not Path(path).is_file():
        raise typer.BadParameter(f"file {_label(path)!r} does not exist", param_hint=hint)


def _read_bytes(path: str) -> bytes:
    if path == STDIO:
        return typer.get_binary_stream("stdin").read()
    try:
        return Path(path).read_bytes()
    except OSError as exc:
        raise CliError(f"cannot read {_label(path)}: {exc.strerror or type(exc).__name__}") from exc


def _write_text(path: str | None, text: str) -> None:
    if path is None or path == STDIO:
        stream = typer.get_binary_stream("stdout")
        stream.write(text.encode("utf-8"))
        stream.flush()
        return
    try:
        Path(path).write_text(text, encoding="utf-8", newline="")
    except OSError as exc:
        raise CliError(
            f"cannot write {_label(path)}: {exc.strerror or type(exc).__name__}"
        ) from exc


def _validation_summary(exc: ValidationError) -> str:
    """Error locations and types only; pydantic's default text echoes the input values."""
    parts = [
        f"{'.'.join(str(p) for p in err['loc']) or '<root>'}: {err['type']}"
        for err in exc.errors(include_input=False, include_url=False, include_context=False)
    ]
    shown = "; ".join(parts[:5])
    more = f" (+{len(parts) - 5} more)" if len(parts) > 5 else ""
    return f"{exc.error_count()} validation error(s): {shown}{more}"


def _load_json(path: str) -> Any:
    data = _read_bytes(path)
    try:
        return json.loads(data.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise CliError(f"{_label(path)} is not UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise CliError(
            f"{_label(path)} is not valid JSON (line {exc.lineno}, column {exc.colno})"
        ) from exc


def _validate[M: BaseModel](model: type[M], raw: Any, label: str) -> M:
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        raise CliError(
            f"{label} is not a valid {model.__name__}: {_validation_summary(exc)}"
        ) from exc


def dump_json(value: Any, *, compact: bool = False, sort_keys: bool = False) -> str:
    """Deterministic JSON text (UTF-8, not ASCII-escaped) with a trailing newline."""
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if compact:
        text = json.dumps(value, ensure_ascii=False, sort_keys=sort_keys, separators=(",", ":"))
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=sort_keys, indent=2)
    return text + "\n"


def dump_jsonl(chunks: Sequence[SearchChunk], *, sort_keys: bool = False) -> str:
    return "".join(dump_json(c, compact=True, sort_keys=sort_keys) for c in chunks)


def load_chunks_jsonl(path: str) -> list[SearchChunk]:
    data = _read_bytes(path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CliError(f"{_label(path)} is not UTF-8 JSONL") from exc
    return parse_chunks_jsonl(text, _label(path))


def parse_chunks_jsonl(text: str, label: str) -> list[SearchChunk]:
    """``SearchChunk`` JSONL already read into memory (``label`` names it in errors)."""
    chunks: list[SearchChunk] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CliError(f"{label} line {number} is not valid JSON") from exc
        chunks.append(_validate(SearchChunk, raw, f"{label} line {number}"))
    return chunks


def diff_to_json(diff: ChunkDiff) -> dict[str, Any]:
    return {
        **dataclasses.asdict(diff),
        "reindex_ids": list(diff.reindex_ids),
        "is_empty": diff.is_empty,
    }


@contextmanager
def _errors(sensitive: Sequence[str] = ()) -> Iterator[None]:
    """Map processing failures to exit code 1 with a sanitized one-line message.

    ``sensitive`` local paths are replaced by their ``_label`` wherever an underlying error
    message quotes them.
    """
    try:
        yield
    except CliError as exc:
        _fail(str(exc), sensitive)
    except ParserError as exc:
        _fail(f"parse failed ({type(exc).__name__}): {exc}", sensitive)
    except ChunkingError as exc:
        _fail(f"chunking failed: {exc}", sensitive)


# --------------------------------------------------------------------------------------------
# parse


def _make_parser(
    parser: ParserName, truth: Sequence[Path], *, ocr: bool, ocr_lang: str
) -> PdfParser:
    if parser is ParserName.FAKE:
        if ocr:
            raise typer.BadParameter("needs --parser docling", param_hint="--ocr")
        try:
            return FakeParser.from_truth_files(truth)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise CliError(f"cannot load truth file: {type(exc).__name__}") from exc
    if truth:
        raise typer.BadParameter("needs --parser fake", param_hint="--truth")
    # Imported here so `core --help` and the fake paths never load Docling or its models.
    from book_core.parser.docling_adapter import DoclingParser

    return DoclingParser(ParserOptions(ocr=ocr, ocr_lang=ocr_lang))


@contextmanager
def _pdf_path(pdf: str) -> Iterator[Path]:
    if pdf != STDIO:
        yield Path(pdf)
        return
    with tempfile.TemporaryDirectory(prefix="core-parse-") as tmp:
        path = Path(tmp) / STDIN_SOURCE_PATH
        path.write_bytes(_read_bytes(STDIO))
        yield path


@app.command(help="Parse a PDF into a ParsedDocument (JSON).")
def parse(
    pdf: Annotated[str, typer.Argument(help="PDF file, or - for stdin.", metavar="PDF")],
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="Output file (default stdout).")
    ] = None,
    parser: Annotated[
        ParserName, typer.Option("--parser", help="docling (real models) or fake (truth files).")
    ] = ParserName.DOCLING,
    truth: Annotated[
        list[Path] | None,
        typer.Option(
            "--truth",
            help="Fixture *.truth.json registered with the fake parser (repeatable).",
            exists=True,
            dir_okay=False,
        ),
    ] = None,
    ocr: Annotated[bool, typer.Option("--ocr", help="OCR pages without a text layer.")] = False,
    ocr_lang: Annotated[str, typer.Option("--ocr-lang", help="RapidOCR language.")] = "korean",
    source_path: Annotated[
        str | None,
        typer.Option(
            "--source-path",
            help="Value recorded as source_path (e.g. the storage key); default: file name.",
        ),
    ] = None,
    compact: Annotated[bool, typer.Option("--compact", help="One-line JSON.")] = False,
    sort_keys: Annotated[bool, typer.Option("--sort-keys", help="Sort JSON keys.")] = False,
) -> None:
    if source_path is not None and not source_path.strip():
        raise typer.BadParameter("must not be empty", param_hint="--source-path")
    _require_input(pdf, "PDF")
    truth_paths = [str(t) for t in truth or []]
    _check_destinations([(output, "--output")], [pdf, *truth_paths])
    # The parser only ever sees a local name, so its errors cannot quote --source-path; the
    # supplied value is recorded on the result afterwards and never echoed in diagnostics.
    local_name = STDIN_SOURCE_PATH if pdf == STDIO else Path(pdf).name
    shown = SOURCE_LABEL if pdf == STDIO and source_path else _label(pdf)
    with _errors([pdf, *truth_paths, output or STDIO]):
        engine = _make_parser(parser, truth or [], ocr=ocr, ocr_lang=ocr_lang)
        with _pdf_path(pdf) as path:
            document = engine.parse(path, source_path=local_name or STDIN_SOURCE_PATH)
        if source_path:
            document = document.model_copy(update={"source_path": source_path})
        _write_text(output, dump_json(document, compact=compact, sort_keys=sort_keys))
    typer.echo(
        f"parsed {shown}: {len(document.pages)} pages, "
        f"{len(document.blocks)} blocks, ocr_applied={str(document.ocr_applied).lower()}, "
        f"parser {document.parser_version}",
        err=True,
    )


# --------------------------------------------------------------------------------------------
# structure


def _structure(
    parsed: ParsedDocument, *, document_id: str, revision_id: str, published: bool
) -> DocumentRevision:
    try:
        result = build_revision(parsed, document_id=document_id, revision_id=revision_id)
    except ValidationError as exc:
        raise CliError(f"cannot build revision: {_validation_summary(exc)}") from exc
    revision = publish(result.revision) if published else result.revision
    # Warning messages may quote headings (book text): only codes and block ids are printed.
    for warning in result.warnings:
        ids = f" [{', '.join(warning.block_ids)}]" if warning.block_ids else ""
        typer.echo(f"warning: {warning.code}{ids}", err=True)
    typer.echo(
        f"structure {revision.revision_id}: {len(revision.sections)} sections, "
        f"{len(revision.blocks)} blocks ({len(result.front_matter_block_ids)} front matter, "
        f"{len(result.toc_block_ids)} toc), {len(result.warnings)} warnings, "
        f"status {revision.status.value}",
        err=True,
    )
    return revision


_DEFAULT_CHUNKING = ChunkerConfig()
_DOCUMENT_ID = typer.Option("--document-id", help="Document id recorded in the revision.")
_REVISION_ID = typer.Option("--revision-id", help="Revision id recorded in the revision.")


def _check_id(value: str | None, hint: str) -> None:
    if value is not None and (not value or len(value) > 256 or any(c.isspace() for c in value)):
        raise typer.BadParameter("must be 1-256 characters without whitespace", param_hint=hint)


@app.command(help="Build the first DocumentRevision (JSON) from a ParsedDocument.")
def structure(
    parsed: Annotated[str, typer.Argument(help="ParsedDocument JSON, or - for stdin.")],
    document_id: Annotated[str, _DOCUMENT_ID],
    revision_id: Annotated[str, _REVISION_ID],
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="Output file (default stdout).")
    ] = None,
    published: Annotated[
        bool, typer.Option("--publish", help="Mark the revision published.")
    ] = False,
    compact: Annotated[bool, typer.Option("--compact", help="One-line JSON.")] = False,
    sort_keys: Annotated[bool, typer.Option("--sort-keys", help="Sort JSON keys.")] = False,
) -> None:
    _check_id(document_id, "--document-id")
    _check_id(revision_id, "--revision-id")
    _require_input(parsed, "PARSED")
    _check_destinations([(output, "--output")], [parsed])
    with _errors([parsed, output or STDIO]):
        document = _validate(ParsedDocument, _load_json(parsed), _label(parsed))
        revision = _structure(
            document, document_id=document_id, revision_id=revision_id, published=published
        )
        _write_text(output, dump_json(revision, compact=compact, sort_keys=sort_keys))


# --------------------------------------------------------------------------------------------
# chunk


def _load_revision(
    path: str, *, document_id: str | None, revision_id: str | None
) -> DocumentRevision:
    raw = _load_json(path)
    if isinstance(raw, dict) and "revision_id" in raw:
        if document_id is not None or revision_id is not None:
            raise typer.BadParameter(
                "applies only to ParsedDocument input", param_hint="--document-id/--revision-id"
            )
        return _validate(DocumentRevision, raw, _label(path))
    if isinstance(raw, dict) and "parser_version" in raw:
        if document_id is None or revision_id is None:
            raise typer.BadParameter(
                "required for ParsedDocument input", param_hint="--document-id/--revision-id"
            )
        document = _validate(ParsedDocument, raw, _label(path))
        return _structure(
            document, document_id=document_id, revision_id=revision_id, published=False
        )
    raise CliError(f"{_label(path)} is neither a DocumentRevision nor a ParsedDocument")


@app.command(help="Chunk a DocumentRevision (or ParsedDocument) into SearchChunk JSONL.")
def chunk(
    source: Annotated[
        str, typer.Argument(help="DocumentRevision or ParsedDocument JSON, or - for stdin.")
    ],
    output: Annotated[
        str | None,
        typer.Option(
            "-o",
            "--output",
            help="Chunks JSONL (default stdout): parents, then children, each in reading order.",
        ),
    ] = None,
    target: Annotated[int, typer.Option("--target", help="Child target tokens.")] = (
        _DEFAULT_CHUNKING.target_tokens
    ),
    max_tokens: Annotated[int, typer.Option("--max", help="Child hard limit in tokens.")] = (
        _DEFAULT_CHUNKING.max_tokens
    ),
    overlap: Annotated[
        int, typer.Option("--overlap", help="Overlap tokens inside a split block.")
    ] = _DEFAULT_CHUNKING.overlap_tokens,
    parent_max: Annotated[int, typer.Option("--parent-max", help="Parent limit in tokens.")] = (
        _DEFAULT_CHUNKING.parent_max_tokens
    ),
    include_front_matter: Annotated[
        bool,
        typer.Option("--include-front-matter", help="Also chunk blocks outside every section."),
    ] = False,
    title: Annotated[
        str | None, typer.Option("--title", help="Document title prefixed to breadcrumbs.")
    ] = None,
    document_id: Annotated[str | None, _DOCUMENT_ID] = None,
    revision_id: Annotated[str | None, _REVISION_ID] = None,
    diff: Annotated[
        str | None,
        typer.Option("--diff", help="Older chunks JSONL to compare with; writes a ChunkDiff."),
    ] = None,
    diff_output: Annotated[
        str, typer.Option("--diff-output", help="Where the ChunkDiff JSON goes (default stdout).")
    ] = STDIO,
    sort_keys: Annotated[bool, typer.Option("--sort-keys", help="Sort JSON keys.")] = False,
) -> None:
    _check_id(document_id, "--document-id")
    _check_id(revision_id, "--revision-id")
    try:
        config = ChunkerConfig(
            target_tokens=target,
            max_tokens=max_tokens,
            overlap_tokens=overlap,
            parent_max_tokens=parent_max,
            include_front_matter=include_front_matter,
        )
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="chunk sizes") from exc
    if diff is not None:
        if diff_output == STDIO and (output is None or output == STDIO):
            raise typer.BadParameter(
                "writes to stdout; write chunks with -o FILE", param_hint="--diff-output"
            )
        if diff == STDIO and source == STDIO:
            raise typer.BadParameter("SOURCE already reads stdin", param_hint="--diff")
    _require_input(source, "SOURCE")
    _require_input(diff, "--diff")
    inputs = [source, *([diff] if diff is not None else [])]
    _check_destinations(
        [(output, "--output"), *([(diff_output, "--diff-output")] if diff is not None else [])],
        inputs,
    )
    with _errors([*inputs, output or STDIO, diff_output]):
        revision = _load_revision(source, document_id=document_id, revision_id=revision_id)
        old = load_chunks_jsonl(diff) if diff is not None else None
        result = chunk_revision(revision, document_title=title or None, config=config)
        _write_text(output, dump_jsonl(result.chunks, sort_keys=sort_keys))
        typer.echo(
            f"chunked {revision.revision_id}: {len(result.parents)} parents, "
            f"{len(result.children)} children, {len(result.uncovered_block_ids)} uncovered "
            f"blocks, tokenizer {result.tokenizer}",
            err=True,
        )
        if old is not None:
            changes = diff_chunks(old, result.chunks)
            _write_text(diff_output, dump_json(diff_to_json(changes), sort_keys=sort_keys))
            typer.echo(
                f"diff: {len(changes.added)} added, {len(changes.removed)} removed, "
                f"{len(changes.changed)} changed, {len(changes.unchanged)} unchanged",
                err=True,
            )


# --------------------------------------------------------------------------------------------
# index / search / excerpt / eval (Task M2.6)


class EmbedderName(StrEnum):
    FAKE = "fake"
    QWEN3 = "qwen3"


class RerankerName(StrEnum):
    NONE = "none"
    FAKE = "fake"
    QWEN3 = "qwen3"


_QDRANT_URL_ENV = "QDRANT_URL"
_QDRANT_KEY_ENV = "QDRANT_API_KEY"
_DEFAULT_QDRANT_URL = "http://127.0.0.1:6333"
_PREFIX_PATTERN = r"^[A-Za-z0-9_-]*$"

_QDRANT_URL = typer.Option(
    "--qdrant-url",
    help=f"Qdrant server URL (default ${_QDRANT_URL_ENV} or {_DEFAULT_QDRANT_URL}). The API key "
    f"is read from ${_QDRANT_KEY_ENV} only.",
)
_QDRANT_PATH = typer.Option(
    "--qdrant-path", help="Local on-disk Qdrant directory instead of a server (no Docker)."
)
_COLLECTION_PREFIX = typer.Option(
    "--collection-prefix", help="Prefix of the documents alias and its collections."
)
_EMBEDDER = typer.Option("--embedder", help="fake (deterministic) or qwen3 (real model).")
_EMBEDDING_DIM = typer.Option(
    "--embedding-dim", help="Embedding size (Qwen3 MRL; default: fake 64, Qwen3 full size)."
)
_WORKSPACE_ID = typer.Option("--workspace-id", help="Workspace the points belong to.")


def _check_prefix(prefix: str) -> None:
    import re

    if not re.match(_PREFIX_PATTERN, prefix):
        raise typer.BadParameter(
            "only letters, digits, '_' and '-' are allowed", param_hint="--collection-prefix"
        )


def _check_ids(values: Sequence[str], hint: str) -> None:
    for value in values:
        _check_id(value, hint)


@contextmanager
def _qdrant(url: str | None, path: str | None, *, memory: bool = False) -> Iterator[Any]:
    """A Qdrant client; failures are reported by exception type only (no URLs, no payloads)."""
    from book_core.evaluation import qdrant_client

    if url is not None and path is not None:
        raise typer.BadParameter("pass --qdrant-url or --qdrant-path, not both")
    if url is None and path is None and not memory:
        url = os.environ.get(_QDRANT_URL_ENV) or _DEFAULT_QDRANT_URL
    try:
        with qdrant_client(
            url=url, path=path, api_key=os.environ.get(_QDRANT_KEY_ENV) or None
        ) as client:
            yield client
    except (typer.Exit, typer.BadParameter, CliError):
        raise
    except Exception as exc:
        raise CliError(_runtime_error(exc)) from exc


def _runtime_error(exc: BaseException) -> str:
    """Our own index/model errors carry ids only; anything else (HTTP client, Qdrant responses
    that may echo payloads or URLs) is reported by type."""
    from book_core.embedding import ModelUnavailableError
    from book_core.indexing import IndexStoreError

    if isinstance(exc, IndexStoreError | ModelUnavailableError):
        return f"{type(exc).__name__}: {exc}"
    return f"index/search failed ({type(exc).__name__})"


def _embedder(name: EmbedderName, dimension: int | None) -> Any:
    from book_core.evaluation import make_embedder

    if dimension is not None and dimension < 1:
        raise typer.BadParameter("must be >= 1", param_hint="--embedding-dim")
    return make_embedder(name.value, dimension)


def _load_index_source(path: str) -> list[tuple[DocumentRevision | None, list[SearchChunk]]]:
    """A DocumentRevision JSON (chunked with the defaults) or SearchChunk JSONL, grouped by
    (document, revision)."""
    data = _read_bytes(path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CliError(f"{_label(path)} is not UTF-8") from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raw = None
    if isinstance(raw, dict) and "revision_id" in raw and "blocks" in raw:
        revision = _validate(DocumentRevision, raw, _label(path))
        return [(revision, list(chunk_revision(revision).chunks))]
    groups: dict[tuple[str, str], list[SearchChunk]] = {}
    # Parsed from the text already read: stdin cannot be read twice.
    for chunk in parse_chunks_jsonl(text, _label(path)):
        groups.setdefault((chunk.document_id, chunk.revision_id), []).append(chunk)
    if not groups:
        raise CliError(f"{_label(path)} holds no chunks")
    return [(None, chunks) for chunks in groups.values()]


@app.command(help="Index revisions (DocumentRevision JSON or chunks JSONL) into Qdrant.")
def index(
    sources: Annotated[
        list[str],
        typer.Argument(
            help="DocumentRevision JSON (chunked with the defaults) or SearchChunk JSONL files; "
            "- reads one from stdin."
        ),
    ],
    workspace_id: Annotated[str, _WORKSPACE_ID],
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="Index report JSON (default stdout).")
    ] = None,
    activate: Annotated[
        bool,
        typer.Option(
            "--activate/--no-activate", help="Mark each written revision as the active one."
        ),
    ] = True,
    rebuild_collection: Annotated[
        bool,
        typer.Option(
            "--rebuild",
            help="Write into a fresh physical collection and switch the alias to it (the "
            "previous target is kept for rollback).",
        ),
    ] = False,
    document_type: Annotated[
        str | None, typer.Option("--document-type", help="Payload document_type (e.g. book).")
    ] = None,
    embedder: Annotated[EmbedderName, _EMBEDDER] = EmbedderName.FAKE,
    embedding_dim: Annotated[int | None, _EMBEDDING_DIM] = None,
    qdrant_url: Annotated[str | None, _QDRANT_URL] = None,
    qdrant_path: Annotated[str | None, _QDRANT_PATH] = None,
    collection_prefix: Annotated[str, _COLLECTION_PREFIX] = "",
) -> None:
    from book_core.indexing import (
        CollectionNames,
        QdrantIndexStore,
        RevisionChunks,
        embedder_model_key,
        rebuild,
    )

    _check_id(workspace_id, "--workspace-id")
    _check_id(document_type, "--document-type")
    _check_prefix(collection_prefix)
    if sources.count(STDIO) > 1:
        raise typer.BadParameter("stdin can be read only once", param_hint="SOURCES")
    if rebuild_collection and document_type is not None:
        raise typer.BadParameter("is not supported with --rebuild", param_hint="--document-type")
    for source in sources:
        _require_input(source, "SOURCES")
    _check_destinations([(output, "--output")], sources)
    with _errors([*sources, output or STDIO]):
        items = [item for source in sources for item in _load_index_source(source)]
        seen: set[tuple[str, str]] = set()
        for _, chunks in items:
            key = (chunks[0].document_id, chunks[0].revision_id)
            if key in seen:
                raise CliError(f"revision {key[0]}/{key[1]} is given twice")
            seen.add(key)
        model = _embedder(embedder, embedding_dim)
        names = CollectionNames(prefix=collection_prefix)
        report: dict[str, Any] = {"workspace_id": workspace_id, "alias": names.alias}
        with _qdrant(qdrant_url, qdrant_path) as client:
            if rebuild_collection:
                rebuilt = rebuild(
                    client,
                    model,
                    [
                        RevisionChunks(
                            workspace_id,
                            chunks[0].document_id,
                            chunks[0].revision_id,
                            chunks,
                            active=activate,
                        )
                        for _, chunks in items
                    ],
                    names=names,
                )
                report.update(
                    collection=rebuilt.collection,
                    previous=rebuilt.previous,
                    revisions=[
                        {
                            "document_id": chunks[0].document_id,
                            "revision_id": chunks[0].revision_id,
                            "chunks": len(chunks),
                            "active": activate,
                        }
                        for _, chunks in items
                    ],
                )
            else:
                store = QdrantIndexStore(client, model, names=names)
                written = []
                for _, chunks in items:
                    document_id, revision_id = chunks[0].document_id, chunks[0].revision_id
                    result = store.index_revision(
                        workspace_id, document_id, revision_id, chunks, document_type=document_type
                    )
                    if activate:
                        store.activate_revision(workspace_id, document_id, revision_id)
                    written.append(
                        {
                            "document_id": document_id,
                            "revision_id": revision_id,
                            "chunks": len(chunks),
                            "embedded": result.embedded,
                            "reused": result.reused,
                            "refreshed": result.refreshed,
                            "unchanged": result.unchanged,
                            "active": activate,
                        }
                    )
                report.update(collection=store.ensure_collection(), revisions=written)
        report["model_key"] = embedder_model_key(model)
        _write_text(output, dump_json(report))
    typer.echo(
        f"indexed {len(items)} revision(s) into {report['collection']} "
        f"({sum(r['chunks'] for r in report['revisions'])} chunks, "
        f"activate={str(activate).lower()})",
        err=True,
    )


def _ranked_hit_json(item: Any) -> dict[str, Any]:
    return {
        "hit": item.hit.model_dump(mode="json"),
        "chunk": item.chunk.model_dump(mode="json"),
        "parent": item.parent.model_dump(mode="json") if item.parent is not None else None,
        "chapter_id": item.chapter_id,
        "scores": dict(item.scores),
        "ranks": dict(item.ranks),
    }


@app.command(help="Search indexed chunks (keyword/semantic/hybrid) within a scope.")
def search(
    query: Annotated[str, typer.Argument(help="Query text, or - to read it from stdin.")],
    workspace_id: Annotated[str, _WORKSPACE_ID],
    revision_ids: Annotated[
        list[str] | None,
        typer.Option(
            "--revision-id",
            help="Published revision in scope (repeatable). Default: the active revision of "
            "each --document-id.",
        ),
    ] = None,
    document_ids: Annotated[
        list[str] | None, typer.Option("--document-id", help="Document filter (repeatable).")
    ] = None,
    section_ids: Annotated[
        list[str] | None,
        typer.Option("--section-id", help="Section filter, exact chunk section (repeatable)."),
    ] = None,
    languages: Annotated[
        list[str] | None, typer.Option("--language", help="Chunk language filter (repeatable).")
    ] = None,
    mode: Annotated[str, typer.Option("--mode", help="keyword, semantic or hybrid.")] = "hybrid",
    reranker: Annotated[
        RerankerName,
        typer.Option("--reranker", help="Rerank the top --rerank-top candidates (default none)."),
    ] = RerankerName.NONE,
    dense_candidates: Annotated[int, typer.Option("--dense-candidates")] = 30,
    keyword_candidates: Annotated[int, typer.Option("--keyword-candidates")] = 30,
    rerank_top: Annotated[int, typer.Option("--rerank-top")] = 20,
    results: Annotated[int, typer.Option("--results")] = 10,
    rrf_k: Annotated[int, typer.Option("--rrf-k")] = 60,
    with_parents: Annotated[
        bool, typer.Option("--with-parents", help="Attach each hit's parent chunk.")
    ] = False,
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="Hits JSON (default stdout).")
    ] = None,
    embedder: Annotated[EmbedderName, _EMBEDDER] = EmbedderName.FAKE,
    embedding_dim: Annotated[int | None, _EMBEDDING_DIM] = None,
    qdrant_url: Annotated[str | None, _QDRANT_URL] = None,
    qdrant_path: Annotated[str | None, _QDRANT_PATH] = None,
    collection_prefix: Annotated[str, _COLLECTION_PREFIX] = "",
) -> None:
    from book_core.contracts import SearchMode
    from book_core.evaluation import make_reranker
    from book_core.indexing import CollectionNames, QdrantIndexStore, SearchScope
    from book_core.search import (
        InvalidQueryError,
        RerankMode,
        SearchFilters,
        SearchLimits,
        SearchService,
    )

    _check_id(workspace_id, "--workspace-id")
    _check_ids(revision_ids or [], "--revision-id")
    _check_ids(document_ids or [], "--document-id")
    _check_ids(section_ids or [], "--section-id")
    _check_ids(languages or [], "--language")
    _check_prefix(collection_prefix)
    try:
        search_mode = SearchMode(mode)
    except ValueError as exc:
        raise typer.BadParameter(
            "must be keyword, semantic or hybrid", param_hint="--mode"
        ) from exc
    try:
        limits = SearchLimits(
            dense_candidates=dense_candidates,
            keyword_candidates=keyword_candidates,
            rerank_top=rerank_top,
            results=results,
            rrf_k=rrf_k,
            rerank=RerankMode.OFF if reranker is RerankerName.NONE else RerankMode.TOP_K,
        )
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="limits") from exc
    if not revision_ids and not document_ids:
        raise typer.BadParameter(
            "give --revision-id, or --document-id to use the active revisions",
            param_hint="--revision-id",
        )
    _check_destinations([(output, "--output")], [])
    with _errors([output or STDIO]):
        text = _read_bytes(STDIO).decode("utf-8", errors="replace") if query == STDIO else query
        model = _embedder(embedder, embedding_dim)
        rerank_model = make_reranker(reranker.value)
        with _qdrant(qdrant_url, qdrant_path) as client:
            store = QdrantIndexStore(client, model, names=CollectionNames(prefix=collection_prefix))
            revisions = list(revision_ids or [])
            if not revisions:
                for document_id in document_ids or []:
                    active = store.active_revision(workspace_id, document_id)
                    if active is not None:
                        revisions.append(active)
                if not revisions:
                    raise CliError("no active revision for the given documents")
            scope = SearchScope(workspace_id=workspace_id, revision_ids=tuple(revisions))
            filters = SearchFilters(
                document_ids=tuple(document_ids or ()),
                section_ids=tuple(section_ids or ()),
                languages=tuple(languages or ()),
            )
            service = SearchService(store, reranker=rerank_model, limits=limits)
            try:
                result = service.search(
                    text, scope, mode=search_mode, filters=filters, with_parents=with_parents
                )
            except InvalidQueryError as exc:
                raise CliError(f"invalid query: {exc}") from exc
        document = {
            "query": result.query,
            "mode": result.mode.value,
            "query_language": result.query_language,
            "truncated": result.truncated,
            "warnings": list(result.warnings),
            "candidates": dict(result.candidates),
            "scope": {"workspace_id": workspace_id, "revision_ids": revisions},
            "hits": [_ranked_hit_json(h) for h in result.hits],
        }
        _write_text(output, dump_json(document))
    for warning in result.warnings:
        if not warning.startswith("query truncated"):
            typer.echo(f"warning: {warning}", err=True)
    typer.echo(
        f"search ({search_mode.value}, reranker {reranker.value}): {len(result.hits)} hits from "
        f"{len(revisions)} revision(s)",
        err=True,
    )


def _select_hits(
    raw: Any, rank: int | None, all_hits: bool, label: str
) -> tuple[list[Any], str | None]:
    """(chunks or SearchHits to resolve, query from the search output)."""
    from book_core.contracts import SearchHit

    if isinstance(raw, dict) and isinstance(raw.get("hits"), list):
        entries = raw["hits"]
        query = raw.get("query") if isinstance(raw.get("query"), str) else None
    else:
        entries, query = [raw], None
    items: list[Any] = []
    for position, entry in enumerate(entries, start=1):
        what = f"{label} hit {position}"
        if isinstance(entry, dict) and "chunk" in entry:
            items.append(_validate(SearchChunk, entry["chunk"], what))
        elif isinstance(entry, dict) and "chunk_id" in entry:
            items.append(_validate(SearchHit, entry, what))
        elif isinstance(entry, dict) and "content_hash" in entry:
            items.append(_validate(SearchChunk, entry, what))
        else:
            raise CliError(f"{what} is neither a search hit nor a chunk")
    if not items:
        raise CliError(f"{label} has no hits")
    if all_hits:
        return items, query
    wanted = 1 if rank is None else rank
    if wanted > len(items):
        raise CliError(f"{label} has {len(items)} hit(s); no rank {wanted}")
    return [items[wanted - 1]], query


@app.command(help="Resolve paragraph-complete excerpts (page/bbox) for search hits.")
def excerpt(
    hits: Annotated[
        str,
        typer.Argument(
            help="`core search` output, one hit, or one SearchChunk (JSON); - for stdin."
        ),
    ],
    revisions: Annotated[
        list[str],
        typer.Option("--revision", help="DocumentRevision JSON the hits belong to (repeatable)."),
    ],
    rank: Annotated[
        int | None, typer.Option("--rank", help="Hit to resolve, 1-based (default 1).", min=1)
    ] = None,
    all_hits: Annotated[
        bool, typer.Option("--all", help="Resolve every hit (writes a JSON list).")
    ] = False,
    query: Annotated[
        str | None,
        typer.Option("--query", help="Query for term highlights (default: the search's query)."),
    ] = None,
    context_before: Annotated[int, typer.Option("--context-before", min=0)] = 1,
    context_after: Annotated[int, typer.Option("--context-after", min=0)] = 1,
    cross_sections: Annotated[
        bool, typer.Option("--cross-sections", help="Let context cross section boundaries.")
    ] = False,
    max_chars: Annotated[int, typer.Option("--max-chars", min=1)] = 1600,
    title: Annotated[
        str | None, typer.Option("--title", help="Document title leading the breadcrumb.")
    ] = None,
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="Excerpt JSON (default stdout).")
    ] = None,
) -> None:
    from book_core.search import ExcerptConfig, ExcerptError, ExcerptResolver

    if rank is not None and all_hits:
        raise typer.BadParameter("cannot be combined with --all", param_hint="--rank")
    if hits == STDIO and STDIO in revisions:
        raise typer.BadParameter("HITS already reads stdin", param_hint="--revision")
    if revisions.count(STDIO) > 1:
        raise typer.BadParameter("stdin can be read only once", param_hint="--revision")
    _require_input(hits, "HITS")
    for path in revisions:
        _require_input(path, "--revision")
    _check_destinations([(output, "--output")], [hits, *revisions])
    config = ExcerptConfig(
        context_before=context_before,
        context_after=context_after,
        cross_sections=cross_sections,
        max_chars=max_chars,
    )
    with _errors([hits, *revisions, output or STDIO]):
        selected, search_query = _select_hits(_load_json(hits), rank, all_hits, _label(hits))
        resolvers: dict[tuple[str, str], ExcerptResolver] = {}
        for path in revisions:
            revision = _validate(DocumentRevision, _load_json(path), _label(path))
            resolvers[(revision.document_id, revision.revision_id)] = ExcerptResolver(
                revision, config=config, document_title=title
            )
        excerpts = []
        for item in selected:
            key = (item.document_id, item.revision_id)
            resolver = resolvers.get(key)
            if resolver is None:
                raise CliError(f"no --revision for {key[0]}/{key[1]}")
            try:
                excerpts.append(resolver.resolve_hit(item, query=query or search_query))
            except ExcerptError as exc:
                raise CliError(f"excerpt failed: {exc}") from exc
        if all_hits:
            _write_text(output, dump_json([e.model_dump(mode="json") for e in excerpts]))
        else:
            _write_text(output, dump_json(excerpts[0]))
    typer.echo(
        f"excerpt: {len(excerpts)} resolved, {sum(len(e.locations) for e in excerpts)} location(s)",
        err=True,
    )


@app.command(name="eval", help="Run the retrieval evaluation and write JSON/Markdown reports.")
def eval_command(
    dataset: Annotated[str, typer.Argument(help="Dataset JSON (eval/datasets/*.json).")],
    config: Annotated[
        str | None, typer.Option("--config", help="EvalConfig JSON (eval/configs/*.json).")
    ] = None,
    output: Annotated[
        str | None, typer.Option("-o", "--output", help="JSON report (default stdout).")
    ] = None,
    markdown: Annotated[
        str | None, typer.Option("--markdown", help="Also write a Markdown report here.")
    ] = None,
    name: Annotated[str | None, typer.Option("--name", help="Report name.")] = None,
    embedder: Annotated[EmbedderName | None, _EMBEDDER] = None,
    embedding_dim: Annotated[int | None, _EMBEDDING_DIM] = None,
    reranker: Annotated[
        RerankerName | None, typer.Option("--reranker", help="none, fake or qwen3.")
    ] = None,
    modes: Annotated[
        list[str] | None, typer.Option("--mode", help="Mode to run (repeatable).")
    ] = None,
    sweep: Annotated[
        bool, typer.Option("--sweep", help="Add the RRF k x depth sweep (config grid or default).")
    ] = False,
    no_latency: Annotated[
        bool, typer.Option("--no-latency", help="Leave timings out (deterministic report).")
    ] = False,
    qdrant_url: Annotated[
        str | None,
        typer.Option(
            "--qdrant-url",
            help=f"Index into this Qdrant server (API key from ${_QDRANT_KEY_ENV}); default: "
            "in-process memory.",
        ),
    ] = None,
    qdrant_path: Annotated[str | None, _QDRANT_PATH] = None,
    collection_prefix: Annotated[
        str | None,
        typer.Option(
            "--collection-prefix",
            help="Collection prefix on a server or --qdrant-path (default eval_<random>_); "
            "dropped afterwards unless --keep-index.",
        ),
    ] = None,
    keep_index: Annotated[
        bool, typer.Option("--keep-index", help="Keep the evaluation collections.")
    ] = False,
) -> None:
    import uuid

    from book_core.evaluation import (
        DatasetError,
        EvalConfig,
        SweepConfig,
        build_index,
        drop_prefixed,
        evaluate,
        load_dataset,
        make_reranker,
        render_markdown,
    )
    from book_core.indexing import CollectionNames

    if collection_prefix is not None:
        _check_prefix(collection_prefix)
    _require_input(dataset, "DATASET")
    if dataset == STDIO:
        raise typer.BadParameter("must be a file (relative paths resolve next to it)")
    _require_input(config, "--config")
    _check_destinations(
        [(output, "--output"), (markdown, "--markdown")],
        [dataset, *([config] if config is not None else [])],
    )
    with _errors([dataset, config or STDIO, output or STDIO, markdown or STDIO]):
        raw_config: dict[str, Any] = dict(_load_json(config)) if config is not None else {}
        overrides: dict[str, Any] = {}
        if name is not None:
            overrides["name"] = name
        if embedder is not None:
            overrides["embedder"] = embedder.value
        if embedding_dim is not None:
            overrides["embedding_dimension"] = embedding_dim
        if reranker is not None:
            overrides["reranker"] = reranker.value
        if modes:
            overrides["modes"] = modes
        if no_latency:
            overrides["latency"] = False
        settings = _validate(EvalConfig, {**raw_config, **overrides}, "eval config")
        if sweep and settings.sweep is None:
            settings = settings.model_copy(update={"sweep": SweepConfig()})
        try:
            data = load_dataset(dataset)
        except DatasetError as exc:
            raise CliError(f"dataset: {exc}") from exc
        model = _embedder(EmbedderName(settings.embedder), settings.embedding_dimension)
        rerank_model = make_reranker(settings.reranker)
        server = qdrant_url is not None
        persistent = server or qdrant_path is not None
        prefix = collection_prefix
        if prefix is None:
            # A server or local directory may hold a real corpus behind the unprefixed alias:
            # evaluation always builds an isolated, throw-away index there.
            prefix = f"eval_{uuid.uuid4().hex[:12]}_" if persistent else ""
        with _qdrant(qdrant_url, qdrant_path, memory=True) as client:
            try:
                built = build_index(data, model, client, names=CollectionNames(prefix=prefix))
                report = evaluate(
                    data,
                    built,
                    settings,
                    embedder_name=model.model_name,
                    reranker=rerank_model,
                    backend="server" if server else ("local" if qdrant_path else "memory"),
                )
            finally:
                if persistent and not keep_index and prefix:
                    drop_prefixed(client, prefix)
        if markdown is not None:
            _write_text(markdown, render_markdown(report))
        if output is not None or markdown is None:
            _write_text(output, dump_json(report))
    for run in report["runs"]:
        overall = run["overall"]
        typer.echo(
            f"{run['mode']}/rerank {run['rerank']}: "
            + " ".join(f"{k}={overall[k]:.3f}" for k in ("R@5", "R@10", "MRR@10", "nDCG@10")),
            err=True,
        )


# --------------------------------------------------------------------------------------------
# stubs

# Accept any arguments so a stub always reports "not implemented" rather than a usage error.
_STUB_SETTINGS: dict[str, Any] = {"allow_extra_args": True, "ignore_unknown_options": True}


def _stub(group: typer.Typer, name: str, help_text: str, task: str, label: str) -> None:
    def command() -> None:
        typer.echo(f"{label}: not implemented (Task {task})", err=True)
        raise typer.Exit(code=NOT_IMPLEMENTED_EXIT_CODE)

    group.command(
        name=name,
        help=f"{help_text} [not implemented: Task {task}]",
        context_settings=_STUB_SETTINGS,
    )(command)


_stub(
    questions_app,
    "extract",
    "Extract question drafts from a question PDF.",
    "M4.3",
    "core questions extract",
)
_stub(
    questions_app,
    "generate",
    "Generate variant question drafts.",
    "M6.1",
    "core questions generate",
)


def main() -> None:
    app()
