"""Markdown rendering of evaluation reports (the JSON report is the source)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from book_core.evaluation.runner import METRIC_NAMES


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def _direction(key: str) -> str:
    source, _, target = key.partition("->")
    return f"{source.upper()}→{target.upper()}"


def _table(header: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[str]:
    lines = [
        "| " + " | ".join(header) + " |",
        "|" + "|".join("---" if i == 0 else "---:" for i in range(len(header))) + "|",
    ]
    lines.extend("| " + " | ".join(_fmt(c) for c in row) + " |" for row in rows)
    return lines


def _run_label(run: Mapping[str, Any]) -> str:
    return f"{run['mode']} / rerank {run['rerank']}"


def render_markdown(report: Mapping[str, Any]) -> str:
    dataset = report["dataset"]
    models = report["models"]
    config = report["config"]
    lines = [
        f"# Retrieval evaluation: {report['name']}",
        "",
        f"- Dataset: `{dataset['name']}` ({dataset['queries']} queries"
        + (", synthetic" if dataset.get("synthetic") else "")
        + "; "
        + ", ".join(f"{k} {v}" for k, v in dataset["query_languages"].items())
        + ")",
        "- Documents: "
        + ", ".join(
            f"`{d['id']}` ({d['language'] or '?'}, {d['children']} child chunks)"
            for d in dataset["documents"]
        ),
        f"- Embedder: `{models['embedder']}`; reranker: `{models['reranker'] or 'none'}`",
        f"- Index: {report['index']['backend']}, {report['index']['points']} points",
        f"- Limits: dense {config['dense_candidates']}, keyword {config['keyword_candidates']}, "
        f"RRF k {config['rrf_k']}, rerank top {config['rerank_top']}, results "
        f"{config['results']}",
        "",
        "Metrics: Recall@5/10, MRR@10, nDCG@10 (linear gain). A judgement is a (document, "
        "section); repeated hits of one section count once. Overall = every query against every "
        "document; directions = one document language at a time.",
        "",
        "## Overall",
        "",
    ]
    runs = report["runs"]
    with_latency = any("latency_ms" in r for r in runs)
    with_locations = any("locations" in r for r in runs)
    header = ["run", *METRIC_NAMES]
    if with_locations:
        header.append("location ok")
    if with_latency:
        header.extend(["search p50 ms", "search p95 ms", "rerank p50 ms", "rerank p95 ms"])
    rows = []
    for run in runs:
        row: list[Any] = [_run_label(run), *(run["overall"][m] for m in METRIC_NAMES)]
        if with_locations:
            loc = run.get("locations")
            row.append(f"{loc['ok']}/{loc['checked']}" if loc else None)
        if with_latency:
            latency = run.get("latency_ms") or {}
            search = latency.get("search") or {}
            rerank = latency.get("rerank") or {}
            row.extend([search.get("p50"), search.get("p95"), rerank.get("p50"), rerank.get("p95")])
        rows.append(row)
    lines.extend(_table(header, rows))

    directions = sorted({d for run in runs for d in run.get("directions", {})})
    if directions:
        lines.extend(["", "## By direction (query → documents)", ""])
        for metric in ("R@5", "MRR@10", "nDCG@10"):
            lines.extend([f"**{metric}**", ""])
            table_rows = [
                [_run_label(run), *(run["directions"].get(d, {}).get(metric) for d in directions)]
                for run in runs
                if "directions" in run
            ]
            lines.extend(_table(["run", *(_direction(d) for d in directions)], table_rows))
            lines.append("")

    failures = [(run, f) for run in runs for f in run.get("locations", {}).get("failures", [])]
    if failures:
        lines.extend(["## Location-mapping failures", ""])
        lines.extend(
            f"- {_run_label(run)}: query `{f['query']}`, judgement `{f['judgement']}`"
            for run, f in failures
        )
        lines.append("")

    sweep = report.get("sweep")
    if sweep:
        lines.extend(["## Sweep (RRF k x candidate depth)", ""])
        columns = [c for c in sweep["rows"][0] if c not in ("mode", "rerank")]
        lines.extend(
            _table(
                ["run", *columns],
                [
                    [f"{r['mode']} / rerank {r['rerank']}", *(r[c] for c in columns)]
                    for r in sweep["rows"]
                ],
            )
        )
        best = sweep.get("best")
        if best:
            lines.extend(
                [
                    "",
                    f"Best (R@5, then MRR@10, nDCG@10, then cheapest): {best['mode']} rerank "
                    f"{best['rerank']}, RRF k {best['rrf_k']}, depth {best['depth']}.",
                ]
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
