"""Mock exam validation evaluation (MOCK-X): the share of requested questions that pass validation.

Runs the mock exam AI generation steps (``pipeline.generate``: token-budget batches, per-item
validation where every ``error`` blocks storage, halving unreadable answers, one re-request of the
failed items) over the synthetic cases of ``eval/mock_exams/mock-seed.json`` and measures:

- pass rate: stored questions / requested questions; first-pass rate (before the re-request);
- failure codes of the items that were skipped (e.g. ``inverted_answer_mismatch``,
  ``citation_quote_not_found``, ``llm_output_invalid``);
- re-requested items, unreadable answers, LLM calls per case and calls per stored question;
- token usage (``cost_usd`` when ``LLM_PRICE_*`` is set).

Providers: ``fake`` (default) answers from the scripted ``mock_exam`` block of
tests/fixtures/llm/generation-scenarios.json (offline, deterministic, with deliberate faults).
``llm`` uses the real provider from ``LLM_API_KEY`` / ``LLM_MODEL`` (billed; sends the synthetic
source questions and the synthetic fixture passages only). Reports hold numbers, case ids and codes,
never question or passage text.

    uv run python eval/mock_exams/mock_exam_eval.py
    uv run python eval/mock_exams/mock_exam_eval.py --provider llm \\
        -o eval/reports/mock-exams-llm.json --markdown eval/reports/mock-exams-llm.md
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.contracts import Excerpt, QuestionOption, QuestionType, SourceLocation, VariationType
from book_core.generation import SourceQuestion
from book_core.llm import LLMClient, LLMConfig, LLMUsage, create_llm_client
from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import GenerationSource, GenerationTally, generate

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = Path(__file__).resolve().parent / "mock-seed.json"


@dataclass(frozen=True)
class Case:
    id: str
    variation_type: VariationType
    sources: tuple[GenerationSource, ...]


@dataclass(frozen=True)
class Dataset:
    block: dict[str, Any]
    passages: dict[str, Excerpt]
    cases: tuple[Case, ...]
    path: Path


def page_passages(truth: Path) -> dict[str, Excerpt]:
    """One passage per page of a synthetic truth file (``p<page>``), its blocks verbatim."""
    data: dict[str, Any] = json.loads(truth.read_text(encoding="utf-8"))
    if not data.get("synthetic"):
        raise ValueError(f"{truth.name}: only synthetic fixture truth files are accepted")
    pages: dict[int, list[str]] = {}
    for block in data["blocks"]:
        for page in sorted({p["page"] for p in block.get("parts", [])}):
            pages.setdefault(page, []).append(block["text"])
    return {
        f"p{page}": Excerpt(
            document_id="eval-book",
            revision_id="eval-revision",
            text="\n\n".join(texts),
            block_ids=(f"p{page}",),
            locations=(SourceLocation(page=page),),
        )
        for page, texts in sorted(pages.items())
    }


def _source(key: str, raw: dict[str, Any], *, with_marker: bool) -> SourceQuestion:
    stem = f"{raw['stem']} [{raw['marker']}]" if with_marker else raw["stem"]
    return SourceQuestion(
        question_id=f"q-{key}",
        revision_id=f"r-{key}",
        question_type=QuestionType(raw["question_type"]),
        stem=stem,
        options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in raw["options"]),
        correct_option_ids=tuple(raw["correct_option_ids"]),
        is_multi_answer=raw["is_multi_answer"],
        explanation=raw.get("explanation"),
    )


def load_dataset(path: Path, *, with_marker: bool = True) -> Dataset:
    """``with_marker`` keeps the fake's ``[E2E-MOCK-…]`` marker at the end of each stem (the
    real provider gets the plain synthetic stem)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    block = json.loads((REPO / data["scenarios"]).read_text(encoding="utf-8"))["mock_exam"]
    passages = page_passages(REPO / data["book"])
    cases: list[Case] = []
    for case in data["cases"]:
        variation = VariationType(case["variation_type"])
        sources: list[GenerationSource] = []
        for position, key in enumerate(case["sources"]):
            raw = block["sources"][key]
            sources.append(
                GenerationSource(
                    position=position,
                    source=_source(key, raw, with_marker=with_marker),
                    variation_type=variation,
                    chapter_rank=raw["chapter"] or 99,
                    passages=(f"p{raw['source_page']}",),
                )
            )
        cases.append(Case(id=case["id"], variation_type=variation, sources=tuple(sources)))
    return Dataset(block=block, passages=passages, cases=tuple(cases), path=path)


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def client_for(provider: str, dataset: Dataset) -> LLMClient:
    if provider == "fake":
        return MockExamScenarioLLM(dataset.block)
    config = LLMConfig.from_env()
    if config is None:
        raise SystemExit("--provider llm needs LLM_API_KEY and LLM_MODEL")
    return create_llm_client(config)


def _summary(tallies: Sequence[GenerationTally]) -> dict[str, Any]:
    usage = LLMUsage()
    skipped: Counter[str] = Counter()
    for t in tallies:
        usage = usage + t.usage
        skipped.update(t.skipped)
    count = {
        name: sum(getattr(t, name) for t in tallies)
        for name in (
            "requested",
            "accepted",
            "first_pass_accepted",
            "re_requested",
            "unreadable",
            "llm_calls",
            "batches",
            "provider_errors",
            "warnings",
        )
    }
    return {
        "cases": len(tallies),
        "failed_cases": sum(1 for t in tallies if t.accepted == 0),
        **count,
        "pass_rate": rate(count["accepted"], count["requested"]),
        "first_pass_rate": rate(count["first_pass_accepted"], count["requested"]),
        "calls_per_question": rate(count["llm_calls"], count["accepted"]),
        "skipped": dict(sorted(skipped.items())),
        "usage": usage.model_dump(),
    }


def run(
    dataset_path: Path = DEFAULT_DATASET,
    *,
    provider: str = "fake",
    client: LLMClient | None = None,
) -> dict[str, Any]:
    dataset = load_dataset(dataset_path, with_marker=provider == "fake")
    llm = client or client_for(provider, dataset)
    tallies: list[GenerationTally] = []
    cases: list[dict[str, Any]] = []
    for case in dataset.cases:
        tally = generate(case.sources, dataset.passages, llm)
        tallies.append(tally)
        cases.append(
            {
                "case": case.id,
                "variation_type": case.variation_type.value,
                **tally.as_dict(),
                "pass_rate": rate(tally.accepted, tally.requested),
            }
        )
    return {
        "eval": "mock-exams",
        "provider": provider,
        "model": llm.model_name,
        "dataset": str(dataset_path.resolve().relative_to(REPO))
        if dataset_path.resolve().is_relative_to(REPO)
        else dataset_path.name,
        "summary": _summary(tallies),
        "cases": cases,
    }


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def _codes(skipped: dict[str, int]) -> str:
    return ", ".join(f"`{code}` {n}" for code, n in skipped.items()) or "-"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    cost = s["usage"]["cost_usd"]
    lines = [
        "# Mock exam validation evaluation",
        "",
        f"- provider: `{report['provider']}` · model: `{report['model']}`",
        f"- dataset: `{report['dataset']}` · cases: {s['cases']} (no question: "
        f"{s['failed_cases']}) · requested questions: {s['requested']}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| pass rate (stored / requested) | {_pct(s['pass_rate'])} "
        f"({s['accepted']}/{s['requested']}) |",
        f"| first-pass rate (before the re-request) | {_pct(s['first_pass_rate'])} "
        f"({s['first_pass_accepted']}/{s['requested']}) |",
        f"| re-requested items / unreadable answers | {s['re_requested']} / {s['unreadable']} |",
        f"| stored with a warning (확인 필요) | {s['warnings']} |",
        f"| skipped (final code) | {_codes(s['skipped'])} |",
        f"| LLM calls / validated batches | {s['llm_calls']} / {s['batches']} |",
        f"| calls per stored question | {s['calls_per_question'] or '-'} |",
        f"| input / output tokens | {s['usage']['input_tokens']} / {s['usage']['output_tokens']} |",
        f"| cost (USD, LLM_PRICE_*) | {cost if cost is not None else '-'} |",
        "",
        "| case | type | pass rate | re-requested | unreadable | calls | skipped |",
        "|---|---|---|---|---|---|---|",
    ]
    for c in report["cases"]:
        lines.append(
            f"| {c['case']} | {c['variation_type']} | {_pct(c['pass_rate'])} "
            f"({c['accepted']}/{c['requested']}) | {c['re_requested']} | {c['unreadable']} | "
            f"{c['llm_calls']} | {_codes(c['skipped'])} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--provider", choices=("fake", "llm"), default="fake")
    parser.add_argument("-o", "--output", type=Path, help="JSON report path")
    parser.add_argument("--markdown", type=Path, help="Markdown report path")
    args = parser.parse_args(argv)
    report = run(args.dataset, provider=args.provider)
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
