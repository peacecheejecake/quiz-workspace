"""``core`` command line (architecture.md §4).

Implemented (Task M1.5): ``parse`` (PDF -> ``ParsedDocument`` JSON), ``structure``
(``ParsedDocument`` -> ``DocumentRevision`` JSON) and ``chunk`` (revision -> ``SearchChunk``
JSONL, optional ``ChunkDiff`` against older chunks). The other commands are stubs until their
Task lands.

Conventions: ``-`` means stdin/stdout; results go to stdout or ``-o``, summaries and warnings to
stderr. Exit codes: 0 ok, 2 usage error, 1 processing error. Error messages carry ids, counts
and file names only, never book text. Docling is imported only for ``--parser docling``.
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
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise CliError(f"{_label(path)} is not UTF-8 JSONL") from exc
    chunks: list[SearchChunk] = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CliError(f"{_label(path)} line {number} is not valid JSON") from exc
        chunks.append(_validate(SearchChunk, raw, f"{_label(path)} line {number}"))
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


_stub(app, "index", "Index chunks into Qdrant (dense + sparse).", "M2.6", "core index")
_stub(app, "search", "Search indexed chunks (keyword/semantic/hybrid).", "M2.6", "core search")
_stub(app, "excerpt", "Resolve a paragraph-complete excerpt for a hit.", "M2.6", "core excerpt")
_stub(app, "eval", "Run retrieval evaluation.", "M2.6", "core eval")
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
