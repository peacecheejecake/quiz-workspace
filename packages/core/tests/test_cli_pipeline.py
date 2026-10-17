"""``core parse`` / ``core structure`` / ``core chunk`` (M1.5) through the Typer app.

The default suite runs the fake parser on the fixture truth files and checks the CLI output
against the library pipeline (``FakeParser`` -> ``build_revision`` -> ``chunk_revision``), the
contracts, determinism, stdin/stdout and the error exit codes. The ``models``-marked test runs
real Docling on ``book-ko.pdf`` through the console script.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from book_core import cli
from book_core.chunker import ChunkerConfig, ChunkingError, chunk_revision, diff_chunks
from book_core.cli import app
from book_core.contracts import ChunkLevel, DocumentRevision, ParsedDocument, SearchChunk
from book_core.parser import FakeParser, ParserError
from book_core.structure import build_revision, publish
from make_fixture_pdfs import OUT_DIR
from typer.testing import CliRunner

BOOKS = ("book-ko", "book-en")
USAGE = 2
FAILED = 1
SMALL = ["--target", "64", "--max", "96", "--overlap", "24", "--parent-max", "208"]
SMALL_CONFIG = ChunkerConfig(
    target_tokens=64, max_tokens=96, overlap_tokens=24, parent_max_tokens=208
)
BOOK_TEXT = "UNIQUE-BOOK-SENTENCE-7f3a must never reach stderr"

runner = CliRunner()


def _pdf(book: str) -> Path:
    return OUT_DIR / f"{book}.pdf"


def _truth(book: str) -> Path:
    return OUT_DIR / f"{book}.truth.json"


def _fake_args(book: str) -> list[str]:
    return ["--parser", "fake", "--truth", str(_truth(book))]


def _expected(book: str) -> tuple[ParsedDocument, DocumentRevision]:
    parsed = FakeParser.from_truth_files([_truth(book)]).parse(_pdf(book))
    revision = build_revision(parsed, document_id="doc-1", revision_id="rev-1").revision
    return parsed, revision


def _invoke(args: list[str], stdin: bytes | None = None) -> tuple[int, bytes, str]:
    result = runner.invoke(app, args, input=stdin)
    return result.exit_code, result.stdout_bytes, result.stderr


def _ok(args: list[str], stdin: bytes | None = None) -> tuple[bytes, str]:
    code, out, err = _invoke(args, stdin)
    assert code == 0, err
    return out, err


def _chunks(data: bytes) -> list[SearchChunk]:
    return [SearchChunk.model_validate_json(line) for line in data.decode().splitlines()]


def _run_pipeline(book: str, tmp: Path, *chunk_args: str) -> tuple[Path, Path, Path]:
    parsed, revision, chunks = tmp / "parsed.json", tmp / "revision.json", tmp / "chunks.jsonl"
    _ok(["parse", str(_pdf(book)), *_fake_args(book), "-o", str(parsed)])
    _ok(
        [
            "structure",
            str(parsed),
            "--document-id",
            "doc-1",
            "--revision-id",
            "rev-1",
            "-o",
            str(revision),
        ]
    )
    _ok(["chunk", str(revision), "-o", str(chunks), *chunk_args])
    return parsed, revision, chunks


@pytest.mark.parametrize("book", BOOKS)
def test_pipeline_matches_library_and_contracts(book: str, tmp_path: Path) -> None:
    parsed_path, revision_path, chunks_path = _run_pipeline(book, tmp_path)
    expected_parsed, expected_revision = _expected(book)

    parsed = ParsedDocument.model_validate_json(parsed_path.read_bytes())
    assert parsed == expected_parsed
    assert parsed.source_path == f"{book}.pdf"

    revision = DocumentRevision.model_validate_json(revision_path.read_bytes())
    assert revision == expected_revision
    assert revision.content_hash is not None

    chunks = _chunks(chunks_path.read_bytes())
    assert chunks == list(chunk_revision(expected_revision).chunks)
    levels = [c.level for c in chunks]
    # Parents first, then children, each in reading order.
    assert levels == sorted(levels, key=lambda level: level is ChunkLevel.CHILD)
    assert ChunkLevel.PARENT in levels
    assert ChunkLevel.CHILD in levels
    parent_ids = {c.id for c in chunks if c.level is ChunkLevel.PARENT}
    assert all(c.parent_id in parent_ids for c in chunks if c.level is ChunkLevel.CHILD)
    block_ids = {b.id for b in revision.blocks}
    assert all(set(c.block_ids) <= block_ids for c in chunks)


@pytest.mark.parametrize("book", BOOKS)
def test_outputs_are_byte_identical_across_runs(book: str, tmp_path: Path) -> None:
    runs = []
    for name in ("a", "b"):
        (tmp_path / name).mkdir()
        runs.append(_run_pipeline(book, tmp_path / name, *SMALL))
    for a, b in zip(*runs, strict=True):
        assert a.read_bytes() == b.read_bytes()


def test_stdin_stdout_pipeline_matches_files(tmp_path: Path) -> None:
    book = "book-ko"
    _, revision_path, chunks_path = _run_pipeline(book, tmp_path)

    parsed, err = _ok(
        ["parse", "-", *_fake_args(book), "--source-path", f"{book}.pdf"], _pdf(book).read_bytes()
    )
    assert f"parsed {book}.pdf" in err
    revision, err = _ok(
        ["structure", "-", "--document-id", "doc-1", "--revision-id", "rev-1"], parsed
    )
    assert "structure rev-1" in err
    assert revision == revision_path.read_bytes()
    chunks, err = _ok(["chunk", "-"], revision)
    assert chunks == chunks_path.read_bytes()
    assert "parents" in err
    assert "children" in err


def test_stdin_pdf_defaults_to_neutral_source_path() -> None:
    out, _ = _ok(["parse", "-", *_fake_args("book-en")], _pdf("book-en").read_bytes())
    assert ParsedDocument.model_validate_json(out).source_path == "document.pdf"


def test_source_path_option_is_recorded(tmp_path: Path) -> None:
    out, _ = _ok(
        [
            "parse",
            str(_pdf("book-ko")),
            *_fake_args("book-ko"),
            "--source-path",
            "ws-1/doc-1/source.pdf",
        ]
    )
    assert ParsedDocument.model_validate_json(out).source_path == "ws-1/doc-1/source.pdf"


def test_json_formatting_options() -> None:
    args = ["parse", str(_pdf("book-en")), *_fake_args("book-en")]
    pretty, _ = _ok(args)
    compact, _ = _ok([*args, "--compact"])
    sorted_keys, _ = _ok([*args, "--compact", "--sort-keys"])
    assert pretty.startswith(b'{\n  "schema_version": 1')
    assert compact.count(b"\n") == 1
    assert compact.endswith(b"\n")
    assert json.loads(pretty) == json.loads(compact) == json.loads(sorted_keys)
    assert list(json.loads(sorted_keys)) == sorted(json.loads(sorted_keys))
    assert sorted_keys != compact


def test_text_input_with_fake_parser_and_no_truth(tmp_path: Path) -> None:
    source = tmp_path / "notes.txt"
    source.write_text("# 1 Intro\n\nFirst paragraph.\f## 1.1 More\n\nSecond.", encoding="utf-8")
    out, _ = _ok(["parse", str(source), "--parser", "fake"])
    parsed = ParsedDocument.model_validate_json(out)
    assert len(parsed.pages) == 2
    assert parsed.source_path == "notes.txt"


def test_chunk_accepts_parsed_document_with_ids(tmp_path: Path) -> None:
    parsed_path, _, chunks_path = _run_pipeline("book-en", tmp_path)
    out, err = _ok(["chunk", str(parsed_path), "--document-id", "doc-1", "--revision-id", "rev-1"])
    assert out == chunks_path.read_bytes()
    assert "structure rev-1" in err


def test_structure_publish_and_chunk_options(tmp_path: Path) -> None:
    parsed_path, _, _ = _run_pipeline("book-ko", tmp_path)
    out, _ = _ok(
        ["structure", str(parsed_path), "--document-id", "d", "--revision-id", "r", "--publish"]
    )
    revision = DocumentRevision.model_validate_json(out)
    assert revision.status.value == "published"
    revision_path = tmp_path / "published.json"
    revision_path.write_bytes(out)

    small, _ = _ok(["chunk", str(revision_path), *SMALL, "--title", "Book"])
    assert _chunks(small) == list(
        chunk_revision(revision, document_title="Book", config=SMALL_CONFIG).chunks
    )
    with_front, _ = _ok(["chunk", str(revision_path), "--include-front-matter"])
    expected = chunk_revision(revision, config=ChunkerConfig(include_front_matter=True))
    assert _chunks(with_front) == list(expected.chunks)


def test_chunk_diff(tmp_path: Path) -> None:
    _, revision_path, chunks_path = _run_pipeline("book-ko", tmp_path)
    same, err = _ok(
        [
            "chunk",
            str(revision_path),
            "-o",
            str(tmp_path / "again.jsonl"),
            "--diff",
            str(chunks_path),
        ]
    )
    report = json.loads(same)
    assert report["is_empty"] is True
    assert report["added"] == report["removed"] == report["changed"] == []
    assert "diff: 0 added" in err

    diff_path = tmp_path / "diff.json"
    out, _ = _ok(
        [
            "chunk",
            str(revision_path),
            *SMALL,
            "--diff",
            str(chunks_path),
            "--diff-output",
            str(diff_path),
        ]
    )
    old = _chunks(chunks_path.read_bytes())
    new = _chunks(out)
    expected = diff_chunks(old, new)
    report = json.loads(diff_path.read_text(encoding="utf-8"))
    assert report["is_empty"] is False
    assert report["added"] == list(expected.added)
    assert report["removed"] == list(expected.removed)
    assert report["reindex_ids"] == list(expected.reindex_ids)
    assert report["affected_parent_ids"] == list(expected.affected_parent_ids)


# ---------------------------------------------------------------------------------------------
# usage errors (exit 2)


@pytest.mark.parametrize(
    "args",
    [
        ["parse", "missing.pdf", "--parser", "fake"],
        ["parse", str(_pdf("book-ko")), "--parser", "fake", "--ocr"],
        ["parse", str(_pdf("book-ko")), "--parser", "docling", "--truth", str(_truth("book-ko"))],
        ["parse", str(_pdf("book-ko")), "--parser", "nope"],
        ["parse", str(_pdf("book-ko")), "--parser", "fake", "--source-path", " "],
        ["structure", "missing.json", "--document-id", "d", "--revision-id", "r"],
        ["structure", "-", "--revision-id", "r"],
        ["structure", "-", "--document-id", "has space", "--revision-id", "r"],
        ["chunk", "missing.json"],
        ["chunk", "-", "--target", "0"],
        ["chunk", "-", "--overlap", "300"],
        ["chunk", "-", "--parent-max", "10"],
        ["chunk", "-", "--diff", "-", "-o", "x.jsonl"],
    ],
    ids=lambda args: " ".join(a if "/" not in a else Path(a).name for a in args),
)
def test_usage_errors_exit_2(args: list[str]) -> None:
    code, out, _ = _invoke(args, b"{}")
    assert code == USAGE
    assert out == b""


def test_diff_to_stdout_needs_chunk_output_file(tmp_path: Path) -> None:
    _, revision_path, chunks_path = _run_pipeline("book-ko", tmp_path)
    code, _, err = _invoke(["chunk", str(revision_path), "--diff", str(chunks_path)])
    assert code == USAGE
    assert "-o FILE" in err


def test_parsed_input_needs_ids_and_revision_input_rejects_them(tmp_path: Path) -> None:
    parsed_path, revision_path, _ = _run_pipeline("book-en", tmp_path)
    code, _, _ = _invoke(["chunk", str(parsed_path)])
    assert code == USAGE
    code, _, _ = _invoke(["chunk", str(revision_path), "--document-id", "d"])
    assert code == USAGE


# ---------------------------------------------------------------------------------------------
# processing errors (exit 1, sanitized one-line message)


def _assert_failed(args: list[str], stdin: bytes | None = None) -> str:
    code, out, err = _invoke(args, stdin)
    assert code == FAILED, err
    assert out == b""
    assert err.startswith("error: ")
    assert "Traceback" not in err
    assert BOOK_TEXT not in err
    return err


def test_unregistered_pdf_with_fake_parser_fails() -> None:
    err = _assert_failed(["parse", str(_pdf("book-ko")), "--parser", "fake"])
    assert "UnknownDocumentError" in err
    assert "book-ko.pdf" in err


def test_invalid_json_inputs_fail(tmp_path: Path) -> None:
    assert "not valid JSON" in _assert_failed(
        ["structure", "-", "--document-id", "d", "--revision-id", "r"], b"{nope"
    )
    assert "not UTF-8" in _assert_failed(["chunk", "-"], b"\xff\xfe")
    assert "neither" in _assert_failed(["chunk", "-"], b'{"schema_version": 1}')
    _, revision_path, _ = _run_pipeline("book-ko", tmp_path)
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"id": "x"}\n', encoding="utf-8")
    err = _assert_failed(
        ["chunk", str(revision_path), "-o", str(tmp_path / "c.jsonl"), "--diff", str(bad)]
    )
    assert "bad.jsonl line 1" in err


def test_validation_errors_do_not_echo_book_text(tmp_path: Path) -> None:
    _, revision_path, _ = _run_pipeline("book-ko", tmp_path)
    revision = json.loads(revision_path.read_bytes())
    revision["blocks"][3]["text"] = BOOK_TEXT
    revision["blocks"][3]["ordinal"] = -1
    err = _assert_failed(["chunk", "-"], json.dumps(revision).encode())
    assert "DocumentRevision" in err
    assert "blocks.3.ordinal" in err

    parsed = json.loads(_ok(["parse", str(_pdf("book-ko")), *_fake_args("book-ko")])[0])
    parsed["blocks"][2]["text"] = BOOK_TEXT
    parsed["blocks"][2]["locations"] = []
    err = _assert_failed(
        ["structure", "-", "--document-id", "d", "--revision-id", "r"],
        json.dumps(parsed).encode(),
    )
    assert "ParsedDocument" in err


def test_parser_and_chunking_errors_are_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def parse_fails(self: FakeParser, path: Path, *, source_path: str | None = None) -> None:
        raise ParserError("conversion failed: " + "x" * 1000 + BOOK_TEXT)

    monkeypatch.setattr(FakeParser, "parse", parse_fails)
    err = _assert_failed(["parse", str(_pdf("book-ko")), *_fake_args("book-ko")])
    assert "parse failed (ParserError): conversion failed" in err
    assert len(err) <= 320
    monkeypatch.undo()

    _, revision_path, _ = _run_pipeline("book-ko", tmp_path)

    def chunk_fails(*args: object, **kwargs: object) -> None:
        raise ChunkingError("chunk of section 'sec-1' has 999 tokens, over max_tokens=384")

    monkeypatch.setattr(cli, "chunk_revision", chunk_fails)
    err = _assert_failed(["chunk", str(revision_path)])
    assert "chunking failed: chunk of section 'sec-1'" in err


def test_structure_warnings_print_codes_not_text(tmp_path: Path) -> None:
    source = tmp_path / "flat.txt"
    source.write_text(f"{BOOK_TEXT}\n\nplain paragraph only.", encoding="utf-8")
    parsed, _ = _ok(["parse", str(source), "--parser", "fake"])
    revision, err = _ok(["structure", "-", "--document-id", "d", "--revision-id", "r"], parsed)
    assert "warning: no_headings" in err
    assert BOOK_TEXT not in err
    DocumentRevision.model_validate_json(revision)


def test_fake_paths_never_import_docling(tmp_path: Path) -> None:
    script = (
        "import sys\n"
        "from typer.testing import CliRunner\n"
        "from book_core.cli import app\n"
        "runner = CliRunner()\n"
        "assert runner.invoke(app, ['--help']).exit_code == 0\n"
        f"assert runner.invoke(app, ['parse', {str(_pdf('book-en'))!r}, '--parser', 'fake',"
        f" '--truth', {str(_truth('book-en'))!r}, '-o', {str(tmp_path / 'p.json')!r}]"
        ").exit_code == 0\n"
        "loaded = sorted(m for m in sys.modules if m.split('.')[0] in {'docling', 'torch'})\n"
        "assert not loaded, loaded\n"
    )
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


# ---------------------------------------------------------------------------------------------
# real Docling (models marker)


@pytest.mark.models
def test_cli_docling_parse_to_chunks_book_ko(tmp_path: Path) -> None:
    executable = shutil.which("core")
    assert executable is not None
    parsed_path = tmp_path / "parsed.json"
    revision_path = tmp_path / "revision.json"
    chunks_path = tmp_path / "chunks.jsonl"
    commands = [
        ["parse", str(_pdf("book-ko")), "--parser", "docling", "-o", str(parsed_path)],
        [
            "structure",
            str(parsed_path),
            "--document-id",
            "doc-ko",
            "--revision-id",
            "rev-1",
            "--publish",
            "-o",
            str(revision_path),
        ],
        ["chunk", str(revision_path), "-o", str(chunks_path)],
    ]
    for argv in commands:
        result = subprocess.run(  # noqa: S603
            [executable, *argv], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0, result.stderr

    parsed = ParsedDocument.model_validate_json(parsed_path.read_bytes())
    assert parsed.source_path == "book-ko.pdf"
    assert parsed.parser_version.startswith("docling/")
    assert len(parsed.pages) == 4
    revision = DocumentRevision.model_validate_json(revision_path.read_bytes())
    assert revision == publish(
        build_revision(parsed, document_id="doc-ko", revision_id="rev-1").revision
    )
    assert revision.sections
    chunks = _chunks(chunks_path.read_bytes())
    assert chunks == list(chunk_revision(revision).chunks)
    children = [c for c in chunks if c.level is ChunkLevel.CHILD]
    assert children
    covered = {bid for c in children for bid in c.block_ids}
    assert {b.id for b in revision.blocks if b.section_id is not None} <= covered
    assert all(c.language == "ko" for c in children)
