"""``core index`` / ``search`` / ``excerpt`` / ``eval`` (M2.6) through the Typer app.

Default tests use a local on-disk Qdrant (``--qdrant-path``, no server) and the fake embedder;
``infra`` repeats index + search against the shared Qdrant server under a unique collection
prefix that is dropped afterwards.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from book_core.cli import app
from book_core.contracts import Excerpt, SearchChunk, SearchHit
from book_core.evaluation import drop_prefixed
from make_fixture_pdfs import OUT_DIR
from qdrant_client import QdrantClient
from typer.testing import CliRunner

REPO = Path(__file__).resolve().parents[3]
SEED_DATASET = REPO / "eval" / "datasets" / "retrieval-seed.json"
BOOKS = ("book-ko", "book-en")
USAGE = 2
FAILED = 1
WS = "ws-cli"
MARKED_QUERY = "UNIQUE-QUERY-91c2 염소 소독"

runner = CliRunner()


def _invoke(args: list[str], stdin: bytes | None = None) -> tuple[int, bytes, str]:
    result = runner.invoke(app, args, input=stdin)
    return result.exit_code, result.stdout_bytes, result.stderr


def _ok(args: list[str], stdin: bytes | None = None) -> tuple[bytes, str]:
    code, out, err = _invoke(args, stdin)
    assert code == 0, err
    return out, err


@pytest.fixture(scope="module")
def artifacts(tmp_path_factory: pytest.TempPathFactory) -> dict[str, tuple[Path, Path]]:
    """Published revision JSON and chunks JSONL per book, built with the CLI."""
    tmp = tmp_path_factory.mktemp("artifacts")
    out: dict[str, tuple[Path, Path]] = {}
    for book in BOOKS:
        parsed, revision, chunks = (
            tmp / f"{book}.parsed.json",
            tmp / f"{book}.revision.json",
            tmp / f"{book}.chunks.jsonl",
        )
        truth = OUT_DIR / f"{book}.truth.json"
        _ok(
            [
                "parse",
                str(OUT_DIR / f"{book}.pdf"),
                "--parser",
                "fake",
                "--truth",
                str(truth),
                "-o",
                str(parsed),
            ]
        )
        _ok(
            [
                "structure",
                str(parsed),
                "--document-id",
                book,
                "--revision-id",
                "r1",
                "--publish",
                "-o",
                str(revision),
            ]
        )
        _ok(["chunk", str(revision), "-o", str(chunks)])
        out[book] = (revision, chunks)
    return out


def _index_args(artifacts: dict[str, tuple[Path, Path]], *location: str) -> list[str]:
    return [
        "index",
        *(str(artifacts[b][1]) for b in BOOKS),
        "--workspace-id",
        WS,
        *location,
    ]


@pytest.fixture
def local_index(artifacts: dict[str, tuple[Path, Path]], tmp_path: Path) -> list[str]:
    location = ["--qdrant-path", str(tmp_path / "qdrant")]
    out, err = _ok(_index_args(artifacts, *location))
    report = json.loads(out)
    assert report["workspace_id"] == WS
    assert [(r["document_id"], r["revision_id"], r["active"]) for r in report["revisions"]] == [
        ("book-ko", "r1", True),
        ("book-en", "r1", True),
    ]
    assert all(r["embedded"] > 0 for r in report["revisions"])
    assert report["collection"].startswith("documents_v1__fake-embedder-d64-")
    assert "indexed 2 revision(s)" in err
    return location


def _search(location: list[str], query: str, *args: str) -> dict[str, Any]:
    out, _ = _ok(["search", query, "--workspace-id", WS, *location, *args])
    data: dict[str, Any] = json.loads(out)
    return data


# --- index / search ------------------------------------------------------------------------------


def test_index_then_search_active_revisions(local_index: list[str]) -> None:
    result = _search(
        local_index,
        "염소",
        "--document-id",
        "book-ko",
        "--document-id",
        "book-en",
        "--mode",
        "keyword",
    )
    assert result["mode"] == "keyword"
    assert result["query_language"] == "ko"
    assert result["scope"] == {"workspace_id": WS, "revision_ids": ["r1", "r1"]}
    hits = result["hits"]
    assert hits
    top = SearchHit.model_validate(hits[0]["hit"])
    chunk = SearchChunk.model_validate(hits[0]["chunk"])
    assert (top.document_id, top.rank, top.chunk_id) == ("book-ko", 1, chunk.id)
    assert chunk.section_id == "sec-ch2-s2-heading"
    assert "bm25" in hits[0]["scores"]


def test_search_scope_and_filters(local_index: list[str]) -> None:
    hybrid = _search(local_index, "chlorine", "--revision-id", "r1", "--results", "50")
    assert {h["hit"]["document_id"] for h in hybrid["hits"]} == {"book-ko", "book-en"}
    assert hybrid["hits"][0]["hit"]["score_type"] == "rrf"
    only_en = _search(local_index, "chlorine", "--revision-id", "r1", "--language", "en")
    assert {h["chunk"]["language"] for h in only_en["hits"]} == {"en"}
    # Another workspace or an unknown revision sees nothing.
    out, _ = _ok(
        ["search", "chlorine", "--workspace-id", "ws-other", "--revision-id", "r1", *local_index]
    )
    assert json.loads(out)["hits"] == []
    assert _search(local_index, "chlorine", "--revision-id", "r2")["hits"] == []
    # No active revision for an unknown document.
    code, out, err = _invoke(
        ["search", "chlorine", "--workspace-id", WS, "--document-id", "nope", *local_index]
    )
    assert code == FAILED
    assert err.strip() == "error: no active revision for the given documents"


def test_search_with_reranker_and_parents(local_index: list[str]) -> None:
    result = _search(
        local_index,
        "chlorine disinfection",
        "--revision-id",
        "r1",
        "--reranker",
        "fake",
        "--with-parents",
        "--mode",
        "semantic",
    )
    first = result["hits"][0]
    assert first["hit"]["score_type"] == "rerank"
    assert {"cosine", "rerank"} <= set(first["scores"])
    assert first["parent"] is not None
    assert first["parent"]["level"] == "parent"


def test_search_reads_the_query_from_stdin(local_index: list[str]) -> None:
    out, _ = _ok(
        ["search", "-", "--workspace-id", WS, "--revision-id", "r1", *local_index],
        stdin="염소".encode(),
    )
    assert json.loads(out)["query"] == "염소"


def test_reindex_is_idempotent_and_revision_json_is_chunked(
    artifacts: dict[str, tuple[Path, Path]], local_index: list[str]
) -> None:
    out, _ = _ok(_index_args(artifacts, *local_index))
    report = json.loads(out)
    assert all(r["embedded"] == 0 for r in report["revisions"])
    assert all(r["unchanged"] == r["chunks"] for r in report["revisions"])
    # A DocumentRevision source is chunked with the defaults: same chunks, nothing to embed.
    out, _ = _ok(["index", str(artifacts["book-ko"][0]), "--workspace-id", WS, *local_index])
    [entry] = json.loads(out)["revisions"]
    assert (entry["document_id"], entry["embedded"]) == ("book-ko", 0)


def test_rebuild_switches_to_a_new_generation(
    artifacts: dict[str, tuple[Path, Path]], local_index: list[str]
) -> None:
    out, _ = _ok([*_index_args(artifacts, *local_index), "--rebuild"])
    report = json.loads(out)
    assert report["collection"].endswith("__g2")
    assert report["previous"] is not None
    assert not report["previous"].endswith("__g2")
    assert _search(local_index, "chlorine", "--revision-id", "r1")["hits"]


def test_no_activate_keeps_revisions_unsearchable_by_document(
    artifacts: dict[str, tuple[Path, Path]], tmp_path: Path
) -> None:
    location = ["--qdrant-path", str(tmp_path / "q")]
    _ok([*_index_args(artifacts, *location), "--no-activate"])
    code, _, err = _invoke(
        ["search", "물", "--workspace-id", WS, "--document-id", "book-ko", *location]
    )
    assert code == FAILED
    assert "no active revision" in err
    assert _search(location, "물", "--revision-id", "r1")["hits"]


# --- excerpt -------------------------------------------------------------------------------------


def test_excerpt_from_search_output(
    artifacts: dict[str, tuple[Path, Path]], local_index: list[str], tmp_path: Path
) -> None:
    hits = tmp_path / "hits.json"
    _ok(
        [
            "search",
            "chlorine",
            "--workspace-id",
            WS,
            "--revision-id",
            "r1",
            "--document-id",
            "book-en",
            *local_index,
            "-o",
            str(hits),
        ]
    )
    revisions = [arg for b in BOOKS for arg in ("--revision", str(artifacts[b][0]))]
    out, err = _ok(["excerpt", str(hits), *revisions])
    excerpt = Excerpt.model_validate_json(out)
    assert excerpt.document_id == "book-en"
    assert excerpt.primary_location is not None
    assert excerpt.primary_location.bbox is not None
    assert excerpt.term_highlights  # the search's query is used for term highlights
    assert "chlorine" in excerpt.text.lower()
    assert err.startswith("excerpt: 1 resolved")
    out, _ = _ok(["excerpt", str(hits), *revisions, "--all", "--context-before", "0"])
    all_excerpts = [Excerpt.model_validate(e) for e in json.loads(out)]
    assert len(all_excerpts) == len(json.loads(hits.read_text())["hits"])
    # A single chunk from stdin and an explicit rank.
    chunk = json.dumps(json.loads(hits.read_text())["hits"][0]["chunk"]).encode()
    out, _ = _ok(["excerpt", "-", *revisions], stdin=chunk)
    assert Excerpt.model_validate_json(out).chunk_id == excerpt.chunk_id
    out, _ = _ok(["excerpt", str(hits), *revisions, "--rank", "2"])
    assert Excerpt.model_validate_json(out).chunk_id != excerpt.chunk_id


def test_excerpt_errors(
    artifacts: dict[str, tuple[Path, Path]], local_index: list[str], tmp_path: Path
) -> None:
    hits = tmp_path / "hits.json"
    _ok(
        [
            "search",
            "chlorine",
            "--workspace-id",
            WS,
            "--revision-id",
            "r1",
            "--document-id",
            "book-en",
            *local_index,
            "-o",
            str(hits),
        ]
    )
    ko_only = ["--revision", str(artifacts["book-ko"][0])]
    code, _, err = _invoke(["excerpt", str(hits), *ko_only])
    assert code == FAILED
    assert err.strip() == "error: no --revision for book-en/r1"
    code, _, err = _invoke(["excerpt", str(hits), *ko_only, "--rank", "999"])
    assert code == FAILED
    assert "no rank 999" in err
    code, _, _ = _invoke(["excerpt", str(hits), *ko_only, "--rank", "1", "--all"])
    assert code == USAGE
    bad = tmp_path / "bad.json"
    bad.write_text('{"something": 1}')
    code, _, err = _invoke(["excerpt", str(bad), *ko_only])
    assert code == FAILED
    assert "neither a search hit nor a chunk" in err


# --- eval ----------------------------------------------------------------------------------------


def test_eval_writes_json_and_markdown(tmp_path: Path) -> None:
    report, markdown = tmp_path / "r.json", tmp_path / "r.md"
    _, err = _ok(
        [
            "eval",
            str(SEED_DATASET),
            "-o",
            str(report),
            "--markdown",
            str(markdown),
            "--name",
            "cli-seed",
        ]
    )
    data = json.loads(report.read_text(encoding="utf-8"))
    assert data["name"] == "cli-seed"
    assert data["index"]["backend"] == "memory"
    hybrid = next(r for r in data["runs"] if (r["mode"], r["rerank"]) == ("hybrid", "off"))
    assert (hybrid["overall"]["R@5"], hybrid["overall"]["MRR@10"]) == (0.5833, 0.9167)
    assert markdown.read_text(encoding="utf-8").startswith("# Retrieval evaluation: cli-seed")
    assert "hybrid/rerank off: R@5=0.583 R@10=0.583 MRR@10=0.917" in err
    # Without --markdown/-o the JSON goes to stdout.
    out, _ = _ok(["eval", str(SEED_DATASET), "--mode", "keyword", "--reranker", "none"])
    assert [(r["mode"], r["rerank"]) for r in json.loads(out)["runs"]] == [("keyword", "off")]


def test_eval_without_latency_is_byte_identical(tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {"name": "cfg", "modes": ["hybrid"], "sweep": {"rrf_ks": [10, 60], "depths": [5, 30]}}
        )
    )
    args = ["eval", str(SEED_DATASET), "--config", str(config), "--no-latency"]
    first, _ = _ok(args)
    second, _ = _ok(args)
    assert first == second
    data = json.loads(first)
    assert data["name"] == "cfg"
    assert len(data["sweep"]["rows"]) == 4
    assert "latency_ms" not in data["runs"][0]
    # --sweep adds the default grid when the config has none.
    out, _ = _ok(
        [
            "eval",
            str(SEED_DATASET),
            "--mode",
            "hybrid",
            "--reranker",
            "none",
            "--no-latency",
            "--sweep",
        ]
    )
    assert len(json.loads(out)["sweep"]["rows"]) == 5 * 5


def test_eval_usage_and_input_errors(tmp_path: Path) -> None:
    report = tmp_path / "r.json"
    for args in (
        ["eval", str(SEED_DATASET), "-o", str(SEED_DATASET)],
        ["eval", str(SEED_DATASET), "-o", str(report), "--markdown", str(report)],
        ["eval", str(tmp_path / "missing.json")],
        ["eval", "-"],
        ["eval", str(SEED_DATASET), "--collection-prefix", "bad prefix"],
    ):
        code, out, err = _invoke(args)
        assert code == USAGE, (args, err)
        assert out == b""
    assert not report.exists()
    bad_config = tmp_path / "c.json"
    bad_config.write_text(json.dumps({"results": 0}))
    code, _, err = _invoke(["eval", str(SEED_DATASET), "--config", str(bad_config)])
    assert code == FAILED
    assert "eval config is not a valid EvalConfig: 1 validation error(s): results" in err


# --- shared rules --------------------------------------------------------------------------------


def test_colliding_outputs_are_rejected(
    artifacts: dict[str, tuple[Path, Path]], local_index: list[str]
) -> None:
    revision, chunks = artifacts["book-ko"]
    before = {p: p.read_bytes() for p in (revision, chunks)}
    for args in (
        ["index", str(chunks), "--workspace-id", WS, *local_index, "-o", str(chunks)],
        ["excerpt", str(revision), "--revision", str(revision), "-o", str(revision)],
        ["excerpt", "-", "--revision", "-"],
        ["index", "-", "-", "--workspace-id", WS, *local_index],
    ):
        code, out, err = _invoke(args)
        assert code == USAGE, (args, err)
        assert out == b""
    assert {p: p.read_bytes() for p in (revision, chunks)} == before


@pytest.mark.parametrize(
    "args",
    [
        ["search", "q", "--workspace-id", WS],
        ["search", "q", "--workspace-id", WS, "--revision-id", "r1", "--mode", "fuzzy"],
        ["search", "q", "--workspace-id", WS, "--revision-id", "r1", "--results", "0"],
        ["search", "q", "--workspace-id", "a b", "--revision-id", "r1"],
        ["search", "q", "--workspace-id", WS, "--revision-id", "r1", "--collection-prefix", "x/"],
        ["index", "missing.jsonl", "--workspace-id", WS],
        [
            "search",
            "q",
            "--workspace-id",
            WS,
            "--revision-id",
            "r1",
            "--qdrant-url",
            "http://x",
            "--qdrant-path",
            "p",
        ],
    ],
)
def test_usage_errors_exit_2(args: list[str]) -> None:
    code, out, _ = _invoke(args)
    assert code == USAGE
    assert out == b""


def test_unreachable_qdrant_reports_the_type_only(
    artifacts: dict[str, tuple[Path, Path]],
) -> None:
    url = "http://127.0.0.1:9/secret-path?api-key=abc"
    code, out, err = _invoke(
        ["search", MARKED_QUERY, "--workspace-id", WS, "--revision-id", "r1", "--qdrant-url", url]
    )
    assert code == FAILED
    assert out == b""
    lines = err.splitlines()
    assert len(lines) == 1
    assert lines[0].startswith("error: index/search failed (")
    for fragment in ("UNIQUE-QUERY", "염소", "secret-path", "api-key", "127.0.0.1"):
        assert fragment not in err
    code, _, err = _invoke(
        ["index", str(artifacts["book-ko"][1]), "--workspace-id", WS, "--qdrant-url", url]
    )
    assert code == FAILED
    assert err.startswith("error: index/search failed (")
    assert "secret-path" not in err


def test_search_diagnostics_never_echo_the_query(local_index: list[str]) -> None:
    code, out, err = _invoke(
        ["search", MARKED_QUERY * 200, "--workspace-id", WS, "--revision-id", "r1", *local_index]
    )
    assert code == 0
    assert "UNIQUE-QUERY" not in err
    assert json.loads(out)["truncated"] is True


# --- shared Qdrant server ------------------------------------------------------------------------


@pytest.fixture
def server_location() -> Iterator[list[str]]:
    url = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
    client = QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY") or None, timeout=10)
    try:
        client.get_collections()
    except Exception as exc:
        client.close()
        reason = f"Qdrant not reachable at {url} ({exc.__class__.__name__}); run `make infra-up`"
        if os.environ.get("QUIZ_REQUIRE_INFRA") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    prefix = f"test_{uuid.uuid4().hex}_"
    try:
        yield ["--qdrant-url", url, "--collection-prefix", prefix]
    finally:
        drop_prefixed(client, prefix)
        assert not [c for c in client.get_collections().collections if c.name.startswith(prefix)]
        client.close()


@pytest.mark.infra
def test_index_and_search_on_the_server(
    artifacts: dict[str, tuple[Path, Path]], server_location: list[str]
) -> None:
    out, _ = _ok(_index_args(artifacts, *server_location))
    report = json.loads(out)
    prefix = server_location[-1]
    assert report["alias"] == f"{prefix}documents_v1"
    assert report["collection"].startswith(prefix)
    result = _search(server_location, "염소", "--document-id", "book-ko", "--mode", "keyword")
    assert result["hits"][0]["chunk"]["section_id"] == "sec-ch2-s2-heading"
    hybrid = _search(server_location, "chlorine", "--revision-id", "r1", "--reranker", "fake")
    assert hybrid["hits"]
    assert _search(server_location, "chlorine", "--revision-id", "r2")["hits"] == []


@pytest.mark.infra
def test_eval_on_the_server_drops_its_collections(server_location: list[str]) -> None:
    url, prefix = server_location[1], server_location[-1]
    out, _ = _ok(
        [
            "eval",
            str(SEED_DATASET),
            "--qdrant-url",
            url,
            "--collection-prefix",
            prefix,
            "--mode",
            "hybrid",
            "--no-latency",
        ]
    )
    data = json.loads(out)
    assert data["index"]["backend"] == "server"
    assert [r["overall"]["R@5"] for r in data["runs"]] == [0.5833, 0.5]
    client = QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY") or None)
    try:
        assert not [c for c in client.get_collections().collections if c.name.startswith(prefix)]
    finally:
        client.close()


SAMPLE_JSON = REPO / "eval" / "reports" / "sample-seed-fake.json"
SAMPLE_MD = REPO / "eval" / "reports" / "sample-seed-fake.md"


def test_committed_sample_report_is_current(tmp_path: Path) -> None:
    """The committed sample is `core eval` on the seed set with the fake config, no timings.

    Regenerate: uv run core eval eval/datasets/retrieval-seed.json --config
    eval/configs/fake.json --no-latency -o eval/reports/sample-seed-fake.json
    --markdown eval/reports/sample-seed-fake.md
    """
    report, markdown = tmp_path / "r.json", tmp_path / "r.md"
    _ok(
        [
            "eval",
            str(SEED_DATASET),
            "--config",
            str(REPO / "eval" / "configs" / "fake.json"),
            "--no-latency",
            "-o",
            str(report),
            "--markdown",
            str(markdown),
        ]
    )
    assert report.read_bytes() == SAMPLE_JSON.read_bytes()
    assert markdown.read_bytes() == SAMPLE_MD.read_bytes()
