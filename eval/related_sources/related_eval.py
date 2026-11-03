"""Related passages evaluation (ASK-X, RELSRC-01 method A: search only, no LLM).

Runs the product's own query builder and list merge (``book_core.search.related``) over a
hybrid search of the synthetic fixture (in-process Qdrant, the deterministic fake embedder; the
same scope rule as the API: published books only) and measures, per question and in total:

- source-block inclusion: the share of the questions' own source blocks that are in the list (they
  come first, ``from_question_source``);
- recall@5: the share of the judged gold passages that are in the five rows;
- the excluded sources: rows from a question paper, rows from the question part of a 교재+문제
  document and rows from a question's imported (question PDF) source must all be 0. A control run
  without the scope rules counts what each rule keeps out (it must be above 0, or the check proves
  nothing);
- list size and one row per page (no repeated page of a document).

The fake embedder has no semantics, so the offline numbers show the keyword half of the search and
the list rules, not the model's quality: run the real embedder/reranker through ``make eval-models``
for that. Reports hold case ids, block ids and numbers, never passages or questions.

    uv run python eval/related_sources/related_eval.py
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.contracts import SearchMode
from book_core.embedding import FakeEmbedder
from book_core.evaluation.dataset import Dataset, load_dataset
from book_core.evaluation.runner import build_index, qdrant_client
from book_core.indexing import SearchScope
from book_core.search import RerankMode, SearchFilters, SearchLimits, SearchService
from book_core.search.related import RelatedCandidate, merge_related, related_query

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = Path(__file__).resolve().parent / "related-seed.json"
LIMIT = 5
# The API searches `limit * CANDIDATE_FACTOR` candidates before merging; the same here.
CANDIDATES = LIMIT * 3
BOOK = "book-ko"
PAPER = "paper-ko"
MIXED = "mixed-ko"


@dataclass(frozen=True)
class Seed:
    cases: tuple[dict[str, Any], ...]
    question_blocks: tuple[str, ...]
    truth: dict[str, Any]
    path: Path


def load_seed(path: Path) -> Seed:
    data = json.loads(path.read_text(encoding="utf-8"))
    truth = json.loads((REPO / data["book"]).read_text(encoding="utf-8"))
    if not truth.get("synthetic"):
        raise ValueError("only synthetic fixture truth files are accepted")
    return Seed(tuple(data["cases"]), tuple(data["question_blocks"]), truth, path)


def derive(truth: dict[str, Any], document_id: str, rewrite: Any) -> dict[str, Any]:
    """A copy of the book's truth file under another id whose text blocks go through `rewrite`."""
    out: dict[str, Any] = json.loads(json.dumps(truth))
    out["fixture_id"] = document_id
    out["title"] = document_id
    for block in out["blocks"]:
        if block["type"] == "text":
            block["text"] = rewrite(block)
    return out


def build_dataset(seed: Seed, workdir: Path) -> Dataset:
    questions = set(seed.question_blocks)
    files = {
        BOOK: seed.truth,
        PAPER: derive(seed.truth, PAPER, lambda b: f"[문제지] 문제. {b['text']} 정답을 고르시오."),
        MIXED: derive(
            seed.truth,
            MIXED,
            lambda b: (
                f"[문제] {b['text']}"
                if b["id"] in questions
                else f"부록 {b['id']}: 목차와 서식만 안내하는 합성 문장이다."
            ),
        ),
    }
    documents = []
    for document_id, truth in files.items():
        path = workdir / f"{document_id}.truth.json"
        path.write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")
        documents.append({"id": document_id, "language": "ko", "truth": path.name})
    gold = sorted({g for case in seed.cases for g in case["gold"]})
    dataset_file = workdir / "related-dataset.json"
    dataset_file.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": "related-sources",
                "synthetic": True,
                "documents": documents,
                "queries": [
                    {
                        "id": "placeholder",
                        "language": "ko",
                        "text": "placeholder",
                        "judgements": [{"document_id": BOOK, "block_ids": gold[:1]}],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return load_dataset(dataset_file)


def revision_map(dataset: Dataset, document_id: str) -> tuple[dict[str, str], dict[str, int]]:
    """truth block id -> revision block id, revision block id -> first page."""
    revision = dataset.document(document_id).revision
    to_revision: dict[str, str] = {}
    pages: dict[str, int] = {}
    for block in revision.blocks:
        pages[block.id] = block.locations[0].page if block.locations else 0
        for source in (block.id, *block.source_block_ids):
            to_revision[source] = block.id
    return to_revision, pages


def correct_text(case: dict[str, Any]) -> str:
    return str(case["options"][case["correct"] - 1])


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def run(seed_path: Path = DEFAULT_DATASET) -> dict[str, Any]:
    seed = load_seed(seed_path)
    with tempfile.TemporaryDirectory(prefix="related-eval-") as tmp:
        dataset = build_dataset(seed, Path(tmp))
    to_rev, pages = revision_map(dataset, BOOK)
    mixed_to_rev, _ = revision_map(dataset, MIXED)
    question_part = {mixed_to_rev[b] for b in seed.question_blocks}
    documents = {d.id: d for d in dataset.documents}

    def scope(ids: Sequence[str]) -> tuple[SearchScope, SearchFilters]:
        return (
            SearchScope(
                workspace_id="eval",
                revision_ids=tuple(documents[i].revision_id for i in ids),
                document_ids=tuple(ids),
            ),
            SearchFilters(document_ids=tuple(ids)),
        )

    limits = SearchLimits(
        dense_candidates=30,
        keyword_candidates=30,
        results=CANDIDATES,
        rerank=RerankMode.OFF,
    )
    cases: list[dict[str, Any]] = []
    control = {"paper_hits": 0, "question_part_hits": 0, "imported_refs_dropped": 0}
    with qdrant_client() as client:
        index = build_index(dataset, FakeEmbedder(), client)
        service = SearchService(index.store, reranker=None, limits=limits)

        def hits_of(query: str, ids: Sequence[str]) -> list[RelatedCandidate]:
            scoped, filters = scope(ids)
            result = service.search(
                query, scoped, mode=SearchMode.HYBRID, filters=filters, limits=limits
            )
            return [
                RelatedCandidate(
                    h.hit.document_id,
                    h.hit.revision_id,
                    tuple(h.chunk.block_ids),
                    min(loc.page for loc in h.hit.locations),
                    max(loc.page for loc in h.hit.locations),
                    score=h.hit.score,
                )
                for h in result.hits
            ]

        for case in seed.cases:
            options = [{"id": f"opt-{n}", "text": t} for n, t in enumerate(case["options"], 1)]
            query = related_query(
                case["stem"],
                question_type="MCQ",
                options=options,
                correct_option_ids=[f"opt-{case['correct']}"],
            )
            # The scope rule: the book only (a question paper is never searched; the question
            # part of a mixed document would be dropped from the hits of `mixed-ko`, which the
            # scope does not list either).
            hits = [
                h
                for h in hits_of(query, (BOOK, MIXED))
                if not (h.document_id == MIXED and set(h.block_ids) & question_part)
            ]
            hits = [h for h in hits if h.document_id == BOOK or h.document_id == MIXED]
            unfiltered = hits_of(query, (BOOK, PAPER, MIXED))
            control["paper_hits"] += sum(1 for h in unfiltered if h.document_id == PAPER)
            control["question_part_hits"] += sum(
                1 for h in unfiltered if h.document_id == MIXED and set(h.block_ids) & question_part
            )
            sources: list[RelatedCandidate] = []
            revision_id = documents[BOOK].revision_id
            for block in case["own_sources"]:
                rev_block = to_rev[block]
                sources.append(
                    RelatedCandidate(
                        BOOK, revision_id, (rev_block,), pages[rev_block], pages[rev_block]
                    )
                )
            for ref in case.get("imported_sources", []):
                control["imported_refs_dropped"] += 1  # a source in a question paper: dropped
                if ref["document"] != PAPER:
                    raise ValueError("an imported source names the question paper")
            rows = merge_related(sources, hits, limit=LIMIT)
            row_blocks = {b for r in rows for b in r.block_ids}
            gold = [to_rev[g] for g in case["gold"]]
            own = [to_rev[b] for b in case["own_sources"]]
            question_rows = sum(
                1 for r in rows if r.document_id == MIXED and set(r.block_ids) & question_part
            )
            cases.append(
                {
                    "case": case["id"],
                    "rows": len(rows),
                    "own_sources": len(own),
                    "own_sources_in_list": sum(1 for b in own if b in row_blocks),
                    "own_sources_first": all(r.from_question_source for r in rows[: len(own)]),
                    "gold": len(gold),
                    "gold_in_list": sum(1 for b in gold if b in row_blocks),
                    "paper_rows": sum(1 for r in rows if r.document_id == PAPER),
                    "question_part_rows": question_rows,
                    "imported_rows": sum(
                        1 for r in rows if r.document_id == PAPER and r.from_question_source
                    ),
                    "repeated_pages": len(rows)
                    - len({(r.document_id, r.page_start) for r in rows}),
                    "gold_ranks": [
                        next((n for n, r in enumerate(rows, 1) if g in r.block_ids), None)
                        for g in gold
                    ],
                }
            )
    return {
        "eval": "related-sources",
        "dataset": str(seed_path.resolve().relative_to(REPO))
        if seed_path.resolve().is_relative_to(REPO)
        else seed_path.name,
        "embedder": FakeEmbedder().model_name,
        "limit": LIMIT,
        "summary": summarize(cases, control),
        "cases": cases,
    }


def summarize(cases: Sequence[dict[str, Any]], control: dict[str, int]) -> dict[str, Any]:
    own = sum(c["own_sources"] for c in cases)
    gold = sum(c["gold"] for c in cases)
    return {
        "cases": len(cases),
        "source_block_inclusion": rate(sum(c["own_sources_in_list"] for c in cases), own),
        "own_sources_first": all(c["own_sources_first"] for c in cases),
        "recall_at_5": rate(sum(c["gold_in_list"] for c in cases), gold),
        "cases_with_every_gold": sum(1 for c in cases if c["gold_in_list"] == c["gold"]),
        "rows_per_list": round(sum(c["rows"] for c in cases) / len(cases), 2) if cases else None,
        "excluded_rows": {
            "question_paper": sum(c["paper_rows"] for c in cases),
            "question_part": sum(c["question_part_rows"] for c in cases),
            "imported_source": sum(c["imported_rows"] for c in cases),
        },
        "repeated_pages": sum(c["repeated_pages"] for c in cases),
        "control_without_the_rules": control,
    }


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    ex = s["excluded_rows"]
    ctl = s["control_without_the_rules"]
    lines = [
        "# Related passages evaluation",
        "",
        f"- embedder: `{report['embedder']}` (keyword half of the search; offline) · "
        f"limit: {report['limit']} rows · dataset: `{report['dataset']}` · cases: {s['cases']}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| question source blocks in the list | {_pct(s['source_block_inclusion'])}, "
        f"first: {s['own_sources_first']} |",
        f"| recall@5 of the gold passages | {_pct(s['recall_at_5'])} "
        f"({s['cases_with_every_gold']}/{s['cases']} lists hold every gold passage) |",
        f"| rows per list | {s['rows_per_list']} |",
        f"| rows from a question paper / a mixed document's question part / an imported source | "
        f"{ex['question_paper']} / {ex['question_part']} / {ex['imported_source']} |",
        f"| repeated pages in a list | {s['repeated_pages']} |",
        f"| control without the rules: paper hits / question-part hits / imported refs | "
        f"{ctl['paper_hits']} / {ctl['question_part_hits']} / {ctl['imported_refs_dropped']} |",
        "",
        "| case | rows | source blocks in list | gold in list | gold ranks |",
        "|---|---|---|---|---|",
    ]
    for c in report["cases"]:
        lines.append(
            f"| {c['case']} | {c['rows']} | {c['own_sources_in_list']}/{c['own_sources']} | "
            f"{c['gold_in_list']}/{c['gold']} | {c['gold_ranks']} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("-o", "--output", type=Path, help="JSON report path")
    parser.add_argument("--markdown", type=Path, help="Markdown report path")
    args = parser.parse_args(argv)
    report = run(args.dataset)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(markdown(report), encoding="utf-8")
    sys.stdout.write(markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
