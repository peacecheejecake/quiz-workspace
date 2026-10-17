"""Retrieval evaluation harness (M2.6): dataset loading, runner, location check, sweep, reports.

Default tests run the seed dataset (``eval/datasets/retrieval-seed.json``) offline on the
in-process Qdrant with ``FakeEmbedder`` / ``FakeReranker`` and assert the exact numbers, which
match the M2.3 seed measurements (keyword R@5 0.500 / MRR 0.917, hybrid 0.583 / 0.917).

``models`` runs the full seed evaluation with Qwen3-Embedding-0.6B (MRL 256, as in M2.3) and
Qwen3-Reranker-0.6B and asserts at least the M2.3/M2.4 numbers: hybrid R@5 >= 0.667 without the
reranker and 1.0 with it, every direction R@5 1.0.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import BBox, Excerpt, SearchMode, SourceLocation
from book_core.evaluation import (
    DatasetError,
    EvalConfig,
    SweepConfig,
    build_index,
    corpus_document,
    evaluate,
    load_dataset,
    make_embedder,
    make_reranker,
    qdrant_client,
    render_markdown,
)
from book_core.evaluation.dataset import Dataset, EvalQuery, Judgement
from book_core.evaluation.runner import _location_found
from book_core.parser.fake import load_truth_document
from book_core.search import ExcerptResolver, RerankMode
from book_core.structure import build_revision, publish
from make_fixture_pdfs import OUT_DIR

REPO = Path(__file__).resolve().parents[3]
SEED_DATASET = REPO / "eval" / "datasets" / "retrieval-seed.json"
DIRECTIONS = ("en->en", "en->ko", "ko->en", "ko->ko")


def _run(report: dict[str, Any], mode: str, rerank: str) -> dict[str, Any]:
    runs: list[dict[str, Any]] = report["runs"]
    [run] = [r for r in runs if r["mode"] == mode and r["rerank"] == rerank]
    return run


@pytest.fixture(scope="module")
def fake_report() -> dict[str, Any]:
    dataset = load_dataset(SEED_DATASET)
    embedder = make_embedder("fake")
    with qdrant_client() as client:
        index = build_index(dataset, embedder, client)
        return evaluate(
            dataset,
            index,
            EvalConfig(name="seed-fake", sweep=SweepConfig(rrf_ks=(0, 60), depths=(5, 30))),
            embedder_name=embedder.model_name,
            reranker=make_reranker("fake"),
        )


# --- dataset -----------------------------------------------------------------------------------


def test_seed_dataset_is_generated_from_the_fixture() -> None:
    dataset = load_dataset(SEED_DATASET)
    seed = json.loads((OUT_DIR / "retrieval-seed.json").read_text(encoding="utf-8"))["queries"]
    assert [q.id for q in dataset.queries] == [q["id"] for q in seed]
    assert [q.text for q in dataset.queries] == [q["query"] for q in seed]
    assert dataset.languages == ("en", "ko")
    assert [d.id for d in dataset.documents] == ["book-ko", "book-en"]
    truth = json.loads((OUT_DIR / "book-ko.truth.json").read_text(encoding="utf-8"))
    section_blocks = [b["id"] for b in truth["blocks"] if b["section_id"] == "ch2-s2"]
    first = dataset.queries[0].judgements[0]
    assert (first.document_id, first.section_id, first.grade) == ("book-ko", "ch2-s2", 2)
    assert first.block_ids == tuple(section_blocks)
    # Every truth part of the judged blocks becomes an expected PDF location.
    parts = [
        (p["page"], b["id"])
        for b in truth["blocks"]
        if b["section_id"] == "ch2-s2"
        for p in b["parts"]
    ]
    assert [(loc.page, loc.block_id) for loc in first.locations] == parts
    for document in dataset.documents:
        assert document.revision.status.value == "published"
        assert document.chunks


def test_dataset_errors(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"schema_version": 1, "name": "x", "documents": []}))
    with pytest.raises(DatasetError, match="not valid"):
        load_dataset(bad)
    missing = tmp_path / "missing.json"
    missing.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": "x",
                "documents": [{"id": "book-ko", "truth": str(OUT_DIR / "book-ko.truth.json")}],
                "queries": [
                    {
                        "id": "q",
                        "language": "ko",
                        "text": "물",
                        "judgements": [{"document_id": "other", "section_id": "s"}],
                    }
                ],
            }
        )
    )
    with pytest.raises(DatasetError, match="unknown document other"):
        load_dataset(missing)
    with pytest.raises(DatasetError, match="cannot read"):
        load_dataset(tmp_path / "nope.json")


# --- runner with fakes (deterministic) ---------------------------------------------------------

# Overall metrics over both books (R@5, R@10, MRR@10, nDCG@10), FakeEmbedder/FakeReranker.
FAKE_EXPECTED = {
    ("keyword", "off"): (0.5, 0.5, 0.9167, 0.5754),
    ("keyword", "top_k"): (0.5, 0.5, 0.9167, 0.5754),
    ("semantic", "off"): (0.5, 0.6667, 0.7361, 0.5767),
    ("semantic", "top_k"): (0.5, 0.5833, 0.9167, 0.605),
    ("hybrid", "off"): (0.5833, 0.5833, 0.9167, 0.615),
    ("hybrid", "top_k"): (0.5, 0.5833, 0.9167, 0.605),
}


def test_fake_seed_metrics_are_deterministic(fake_report: dict[str, Any]) -> None:
    got = {
        (r["mode"], r["rerank"]): tuple(
            r["overall"][m] for m in ("R@5", "R@10", "MRR@10", "nDCG@10")
        )
        for r in fake_report["runs"]
    }
    assert got == FAKE_EXPECTED
    for run in fake_report["runs"]:
        assert run["overall"]["queries"] == 6
        assert run["by_query_language"]["ko"]["queries"] == 3


def test_directions_split_keyword_cross_language_failure(fake_report: dict[str, Any]) -> None:
    keyword = _run(fake_report, "keyword", "off")["directions"]
    assert tuple(keyword) == DIRECTIONS
    # BM25 cannot cross languages; same-language retrieval is perfect at 5.
    assert keyword["ko->en"]["R@5"] == 0.0
    assert keyword["en->ko"]["R@5"] == 0.0
    assert keyword["ko->ko"]["R@5"] == 1.0
    assert keyword["en->en"]["R@5"] == 1.0
    hybrid = _run(fake_report, "hybrid", "off")["directions"]
    assert hybrid["ko->en"]["R@5"] > 0
    for direction in DIRECTIONS:
        assert hybrid[direction]["queries"] == 3


def test_per_query_ranks_and_metrics(fake_report: dict[str, Any]) -> None:
    run = _run(fake_report, "keyword", "off")
    entry = next(q for q in run["queries"] if q["id"] == "q-ko-01")
    # q-ko-01's top keyword hit is the chapter-2 intro; the judged section is rank 2 (M2.3).
    assert entry["ranks"]["book-ko#ch2-s2"] == 2
    assert entry["ranks"]["book-en#ch2-s2"] is None
    assert entry["MRR@10"] == 0.5
    assert entry["R@5"] == 0.5
    assert set(entry["directions"]) == {"ko->ko", "ko->en"}


def test_location_mapping_check_passes_for_every_found_judgement(
    fake_report: dict[str, Any],
) -> None:
    for run in fake_report["runs"]:
        locations = run["locations"]
        found = sum(
            1 for q in run["queries"] for rank in q["ranks"].values() if rank and rank <= 10
        )
        assert locations["checked"] == found > 0
        assert locations["ok"] == locations["checked"], locations["failures"]
        assert locations["accuracy"] == 1.0


def test_location_check_detects_wrong_ground_truth() -> None:
    """A judgement whose ground-truth bbox is elsewhere on the page fails the check."""
    dataset = load_dataset(SEED_DATASET)
    query = dataset.queries[0]
    judgement = query.judgements[0]
    moved = tuple(loc.model_copy(update={"page": loc.page + 1}) for loc in judgement.locations)
    broken = Dataset(
        name="broken",
        description="",
        synthetic=True,
        documents=dataset.documents,
        queries=(
            query.model_copy(
                update={"judgements": (judgement.model_copy(update={"locations": moved}),)}
            ),
        ),
    )
    embedder = make_embedder("fake")
    with qdrant_client() as client:
        index = build_index(broken, embedder, client)
        report = evaluate(
            broken,
            index,
            EvalConfig(modes=(SearchMode.KEYWORD,), rerank=(RerankMode.OFF,), latency=False),
            embedder_name=embedder.model_name,
        )
    locations = report["runs"][0]["locations"]
    assert locations["checked"] == 1
    assert locations["ok"] == 0
    assert locations["failures"] == [{"query": query.id, "judgement": judgement.key}]


def test_location_needs_a_returned_box_when_the_judgement_has_one() -> None:
    page_box = BBox(x0=0, y0=0, x1=600, y1=800)
    judged = SourceLocation(page=2, bbox=BBox(x0=10, y0=10, x1=20, y1=20))
    assert _location_found(judged, [SourceLocation(page=2, bbox=page_box)])
    assert not _location_found(judged, [SourceLocation(page=2)])
    assert not _location_found(judged, [SourceLocation(page=3, bbox=page_box)])
    assert not _location_found(
        judged, [SourceLocation(page=2, bbox=BBox(x0=100, y0=100, x1=200, y1=200))]
    )
    assert _location_found(SourceLocation(page=2), [SourceLocation(page=2)])


def test_excerpts_without_boxes_fail_the_location_check(monkeypatch: pytest.MonkeyPatch) -> None:
    resolve = ExcerptResolver.resolve_hit

    def stripped(self: ExcerptResolver, *args: Any, **kwargs: Any) -> Excerpt:
        excerpt = resolve(self, *args, **kwargs)
        locations = tuple(loc.model_copy(update={"bbox": None}) for loc in excerpt.locations)
        return excerpt.model_copy(update={"locations": locations, "primary_location": locations[0]})

    monkeypatch.setattr(ExcerptResolver, "resolve_hit", stripped)
    dataset = load_dataset(SEED_DATASET)
    embedder = make_embedder("fake")
    with qdrant_client() as client:
        index = build_index(dataset, embedder, client)
        report = evaluate(
            dataset,
            index,
            EvalConfig(modes=(SearchMode.KEYWORD,), rerank=(RerankMode.OFF,), latency=False),
            embedder_name=embedder.model_name,
        )
    locations = report["runs"][0]["locations"]
    assert locations["checked"] == 6
    assert locations["ok"] == 0


def test_section_only_judgements_on_revision_ids() -> None:
    """Native judgements may name revision sections; subsections are included."""
    parsed = load_truth_document(OUT_DIR / "book-en.truth.json")
    revision = publish(build_revision(parsed, document_id="doc", revision_id="r7").revision)
    chapter = next(s for s in revision.sections if s.parent_id is None and "Treatment" in s.title)
    dataset = Dataset(
        name="native",
        description="",
        synthetic=True,
        documents=(corpus_document(revision),),
        queries=(
            EvalQuery(
                id="q1",
                language="en",
                text="chlorine disinfection",
                judgements=(Judgement(document_id="doc", section_id=chapter.id, grade=1),),
            ),
        ),
    )
    assert dataset.documents[0].language == "en"
    embedder = make_embedder("fake")
    with qdrant_client() as client:
        index = build_index(dataset, embedder, client, workspace_id="ws-native")
        report = evaluate(
            dataset,
            index,
            EvalConfig(modes=(SearchMode.KEYWORD,), rerank=(RerankMode.OFF,), directions=False),
            embedder_name=embedder.model_name,
        )
    run = report["runs"][0]
    assert run["overall"]["R@5"] == 1.0
    assert run["overall"]["MRR@10"] == 1.0
    assert run["locations"]["ok"] == run["locations"]["checked"] == 1
    assert "directions" not in run


def test_reranker_none_skips_top_k_runs() -> None:
    dataset = load_dataset(SEED_DATASET)
    embedder = make_embedder("fake")
    with qdrant_client() as client:
        index = build_index(dataset, embedder, client)
        report = evaluate(
            dataset,
            index,
            EvalConfig(reranker="none", latency=False, check_locations=False),
            embedder_name=embedder.model_name,
            reranker=None,
        )
    assert [(r["mode"], r["rerank"]) for r in report["runs"]] == [
        ("keyword", "off"),
        ("semantic", "off"),
        ("hybrid", "off"),
    ]
    assert report["models"]["reranker"] is None
    assert "latency_ms" not in report["runs"][0]


def test_latency_percentiles_are_reported(fake_report: dict[str, Any]) -> None:
    off = _run(fake_report, "hybrid", "off")["latency_ms"]
    assert off["search"]["count"] == 6
    assert 0 < off["search"]["p50"] <= off["search"]["p95"] <= off["search"]["max"]
    assert off["rerank"] is None
    on = _run(fake_report, "hybrid", "top_k")["latency_ms"]
    assert on["rerank"]["count"] >= 6
    assert on["rerank"]["p50"] <= on["rerank"]["p95"]


def test_sweep_grid_rows_and_best(fake_report: dict[str, Any]) -> None:
    sweep = fake_report["sweep"]
    assert [(r["rrf_k"], r["depth"]) for r in sweep["rows"]] == [(0, 5), (0, 30), (60, 5), (60, 30)]
    for row in sweep["rows"]:
        assert row["mode"] == "hybrid"
        assert row["rerank"] == "off"
        assert set(row) >= {"R@5", "R@10", "MRR@10", "nDCG@10", "cross R@5", "p50 ms"}
    # The default limits (k 60, depth 30) reproduce the main hybrid run.
    default = next(r for r in sweep["rows"] if (r["rrf_k"], r["depth"]) == (60, 30))
    assert default["R@5"] == _run(fake_report, "hybrid", "off")["overall"]["R@5"]
    best = sweep["best"]
    assert best["R@5"] == max(r["R@5"] for r in sweep["rows"])


def test_reports_hold_no_passages(fake_report: dict[str, Any]) -> None:
    text = json.dumps(fake_report, ensure_ascii=False)
    dataset = load_dataset(SEED_DATASET)
    for document in dataset.documents:
        for block in document.revision.blocks:
            if len(block.text) > 30:
                assert block.text not in text


def test_markdown_report(fake_report: dict[str, Any]) -> None:
    markdown = render_markdown(fake_report)
    assert markdown.startswith("# Retrieval evaluation: seed-fake\n")
    assert "| hybrid / rerank off | 0.583 | 0.583 | 0.917 | 0.615 | 7/7 |" in markdown
    assert "KO→EN" in markdown
    assert "## Sweep (RRF k x candidate depth)" in markdown
    assert "Location-mapping failures" not in markdown


def test_config_validation() -> None:
    with pytest.raises(ValueError, match="greater than or equal"):
        EvalConfig(results=0)
    with pytest.raises(ValueError, match="pattern"):
        EvalConfig(name="a b")
    assert EvalConfig().limits().rerank is RerankMode.TOP_K
    assert EvalConfig().limits(rerank=RerankMode.OFF, rrf_k=5).rrf_k == 5


# --- real models -------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def qwen3_report() -> Iterator[dict[str, Any]]:
    dataset = load_dataset(SEED_DATASET)
    embedder = make_embedder("qwen3", 256)
    with qdrant_client() as client:
        index = build_index(dataset, embedder, client)
        yield evaluate(
            dataset,
            index,
            EvalConfig(
                name="seed-qwen3",
                embedder="qwen3",
                embedding_dimension=256,
                reranker="qwen3",
            ),
            embedder_name=embedder.model_name,
            reranker=make_reranker("qwen3"),
        )


@pytest.mark.models
def test_eval_seed_with_qwen3_meets_the_m23_m24_numbers(qwen3_report: dict[str, Any]) -> None:
    print(render_markdown(qwen3_report))
    hybrid_off = _run(qwen3_report, "hybrid", "off")
    hybrid_on = _run(qwen3_report, "hybrid", "top_k")
    semantic_on = _run(qwen3_report, "semantic", "top_k")
    # M2.3: hybrid R@5 0.667 / MRR 0.917; M2.4: reranked hybrid and semantic R@5 1.0.
    assert hybrid_off["overall"]["R@5"] >= 0.666  # 4/6 (reported rounded to 0.6667)
    assert hybrid_off["overall"]["MRR@10"] >= 0.9
    assert hybrid_on["overall"]["R@5"] == 1.0
    assert hybrid_on["overall"]["MRR@10"] >= 0.9
    assert semantic_on["overall"]["R@5"] == 1.0
    for direction in DIRECTIONS:
        assert hybrid_off["directions"][direction]["R@5"] == 1.0, direction
        assert hybrid_on["directions"][direction]["R@5"] == 1.0, direction
    for run in qwen3_report["runs"]:
        assert run["locations"]["ok"] == run["locations"]["checked"], run["locations"]
    assert hybrid_on["latency_ms"]["rerank"]["count"] >= 6
