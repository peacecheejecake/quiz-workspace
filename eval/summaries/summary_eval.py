"""Document summary evaluation (DOCSUM-X): page-citation validity and chapter coverage.

Runs the worker's map/reduce (``book_core.summary.summarize_revision``) over each document and
measures what the summarizer *proposed* (before the pipeline drops out-of-range pages) and what
is stored:

- page citations of key points: share with pages, share inside the unit's page range, share
  *supported* by the cited pages (at least ``--support`` of the point's units — character
  bigrams of Korean words, word stems otherwise; ``source.units`` — occur in the text of those
  pages), mean support;
- chapter coverage: non-empty chapters whose unit has a summary and a key point; chapters the
  document summary reaches (a document key point citing a page of the chapter, or the chapter
  title named in the summary);
- calls, reused units and token usage (``cost_usd`` when ``LLM_PRICE_*`` is set).

Providers: ``fake`` (default) is the APP_ENV=test extractive fake — offline, deterministic, the
baseline (every citation trivially valid). ``llm`` uses the real provider from ``LLM_API_KEY`` /
``LLM_MODEL`` (+ optional ``LLM_PRICE_*``), billed, and sends the documents' text to it: run it
manually, only on the synthetic fixtures or documents you may send. Reports hold numbers, chapter
titles and file names only, never document or summary text.

    uv run python eval/summaries/summary_eval.py                      # synthetic books, fake
    uv run python eval/summaries/summary_eval.py --provider llm \\
        -o eval/reports/summaries-llm.json --markdown eval/reports/summaries-llm.md
    uv run python eval/summaries/summary_eval.py ~/private/book.parsed.json --provider llm
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from book_core.llm import LLMConfig, LLMUsage, create_llm_client
from book_core.summary import (
    DEFAULT_CHAPTER_CHARS,
    ChapterDigest,
    ExtractiveFakeSummarizer,
    InputBlock,
    LLMSummarizer,
    StoredUnit,
    Summarizer,
    SummaryBody,
    SummaryCall,
    SummaryLimits,
    SummaryTally,
    summarize_revision,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from source import DEFAULT_BOOKS, EvalDocument, contains, load_document, rate
from source import support as text_support

DEFAULT_SUPPORT = 0.65


@dataclass
class _Call:
    kind: str  # chapter | merge | document
    page_from: int | None
    page_to: int | None
    body: SummaryBody


class RecordingSummarizer:
    """Passes calls through and keeps each raw answer (pages not yet clamped)."""

    def __init__(self, inner: Summarizer) -> None:
        self.inner = inner
        self.calls: list[_Call] = []

    @property
    def model_name(self) -> str:
        return self.inner.model_name

    def summarize_chapter(
        self, title: str, blocks: Sequence[InputBlock], page_from: int, page_to: int
    ) -> SummaryCall:
        call = self.inner.summarize_chapter(title, blocks, page_from, page_to)
        self.calls.append(_Call("chapter", page_from, page_to, call.body))
        return call

    def merge_chapter(
        self, title: str, parts: Sequence[SummaryBody], page_from: int, page_to: int
    ) -> SummaryCall:
        call = self.inner.merge_chapter(title, parts, page_from, page_to)
        self.calls.append(_Call("merge", page_from, page_to, call.body))
        return call

    def summarize_document(
        self,
        title: str,
        chapters: Sequence[ChapterDigest],
        page_from: int | None,
        page_to: int | None,
    ) -> SummaryCall:
        call = self.inner.summarize_document(title, chapters, page_from, page_to)
        self.calls.append(_Call("document", page_from, page_to, call.body))
        return call


@dataclass
class MemoryStore:
    units: dict[tuple[str, str, str], StoredUnit] = field(default_factory=dict)

    def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None:
        return self.units.get((scope, section_key, input_hash))

    def save(
        self,
        scope: str,
        section_key: str,
        input_hash: str,
        body: SummaryBody,
        page_from: int | None,
        page_to: int | None,
        usage: LLMUsage | None,
    ) -> StoredUnit:
        unit = StoredUnit(
            id=f"{scope}:{section_key}:{input_hash[:12]}",
            body=body,
            page_from=page_from,
            page_to=page_to,
        )
        self.units[(scope, section_key, input_hash)] = unit
        return unit


@dataclass
class CitationTally:
    key_points: int = 0
    with_pages: int = 0
    in_range: int = 0
    supported: int = 0
    support_sum: float = 0.0

    def add(self, other: CitationTally) -> None:
        self.key_points += other.key_points
        self.with_pages += other.with_pages
        self.in_range += other.in_range
        self.supported += other.supported
        self.support_sum += other.support_sum

    def as_dict(self) -> dict[str, Any]:
        return {
            "key_points": self.key_points,
            "with_pages": self.with_pages,
            "in_range": self.in_range,
            "supported": self.supported,
            "pages_present_rate": rate(self.with_pages, self.key_points),
            "in_range_rate": rate(self.in_range, self.with_pages),
            "supported_rate": rate(self.supported, self.with_pages),
            "mean_support": (
                round(self.support_sum / self.with_pages, 4) if self.with_pages else None
            ),
        }


def citations(
    doc: EvalDocument,
    body: SummaryBody,
    page_from: int | None,
    page_to: int | None,
    threshold: float,
) -> CitationTally:
    tally = CitationTally(key_points=len(body.key_points))
    for point in body.key_points:
        if point.pages is None:
            continue
        tally.with_pages += 1
        lo, hi = point.pages.from_, point.pages.to
        if page_from is not None and page_to is not None and page_from <= lo <= hi <= page_to:
            tally.in_range += 1
        score = text_support(point.text, doc.pages_text(lo, hi)) if lo <= hi else 0.0
        tally.support_sum += score
        if score >= threshold:
            tally.supported += 1
    return tally


def evaluate_document(
    doc: EvalDocument, summarizer: Summarizer, *, chapter_chars: int, threshold: float
) -> dict[str, Any]:
    recorder = RecordingSummarizer(summarizer)
    tally = SummaryTally()
    result = summarize_revision(
        doc.chapters,
        document_title=doc.title,
        summarizer=recorder,
        store=MemoryStore(),
        limits=SummaryLimits(chapter_chars=chapter_chars),
        tally=tally,
    )

    proposed_chapter = CitationTally()
    proposed_document = CitationTally()
    for call in recorder.calls:
        target = proposed_document if call.kind == "document" else proposed_chapter
        # Each call is checked against the page range it was given (a part: the part's pages).
        target.add(citations(doc, call.body, call.page_from, call.page_to, threshold))
    stored = CitationTally()
    chapters: list[dict[str, Any]] = []
    nonempty = covered = reached = 0
    doc_unit = result.document
    for chapter, unit in zip(doc.chapters, result.chapters, strict=True):
        stored.add(citations(doc, unit.body, unit.page_from, unit.page_to, threshold))
        if chapter.empty:
            chapters.append({"title": chapter.title, "empty": True})
            continue
        nonempty += 1
        has_summary = bool(unit.body.summary_md.strip()) and bool(unit.body.key_points)
        covered += has_summary
        cited = any(
            p.pages is not None
            and chapter.page_from is not None
            and chapter.page_to is not None
            and p.pages.from_ <= chapter.page_to
            and p.pages.to >= chapter.page_from
            for p in doc_unit.body.key_points
        )
        named = contains(doc_unit.body.summary_md, chapter.title)
        reached += cited or named
        chapters.append(
            {
                "title": chapter.title,
                "pages": [chapter.page_from, chapter.page_to],
                "summarized": has_summary,
                "key_points": len(unit.body.key_points),
                "in_document_summary": cited or named,
            }
        )
    stored.add(citations(doc, doc_unit.body, doc_unit.page_from, doc_unit.page_to, threshold))
    calls = {kind: sum(c.kind == kind for c in recorder.calls) for kind in ("chapter", "merge")}
    calls["document"] = sum(c.kind == "document" for c in recorder.calls)
    return {
        "document": doc.name,
        "chapters_total": len(doc.chapters),
        "chapters_nonempty": nonempty,
        "chapters_summarized": covered,
        "chapters_in_document_summary": reached,
        "chapter_coverage": rate(covered, nonempty),
        "document_chapter_coverage": rate(reached, nonempty),
        "proposed_citations": {
            "chapter": proposed_chapter.as_dict(),
            "document": proposed_document.as_dict(),
        },
        "stored_citations": stored.as_dict(),
        "calls": calls,
        "generated_units": tally.generated_units,
        "reused_units": tally.reused_units,
        "usage": tally.usage.model_dump(),
        "chapters": chapters,
    }


def summarizer_for(provider: str) -> Summarizer:
    if provider == "fake":
        return ExtractiveFakeSummarizer(lambda: None)
    config = LLMConfig.from_env()
    if config is None:
        raise SystemExit("--provider llm needs LLM_API_KEY and LLM_MODEL")
    return LLMSummarizer(create_llm_client(config))


def run(
    paths: Sequence[Path],
    *,
    provider: str = "fake",
    chapter_chars: int = DEFAULT_CHAPTER_CHARS,
    threshold: float = DEFAULT_SUPPORT,
    summarizer: Summarizer | None = None,
) -> dict[str, Any]:
    used = summarizer or summarizer_for(provider)
    documents = [
        evaluate_document(load_document(p), used, chapter_chars=chapter_chars, threshold=threshold)
        for p in paths
    ]
    total = {
        k: sum(d[k] for d in documents)
        for k in ("chapters_nonempty", "chapters_summarized", "chapters_in_document_summary")
    }
    proposed = CitationTally()
    stored = CitationTally()
    for d in documents:
        for scope in ("chapter", "document"):
            proposed.add(CitationTally(**_counts(d["proposed_citations"][scope])))
        stored.add(CitationTally(**_counts(d["stored_citations"])))
    usage = LLMUsage()
    for d in documents:
        usage = usage + LLMUsage.model_validate(d["usage"])
    return {
        "eval": "document-summary",
        "provider": provider,
        "model": used.model_name,
        "support_threshold": threshold,
        "chapter_chars": chapter_chars,
        "summary": {
            "documents": len(documents),
            **total,
            "chapter_coverage": rate(total["chapters_summarized"], total["chapters_nonempty"]),
            "document_chapter_coverage": rate(
                total["chapters_in_document_summary"], total["chapters_nonempty"]
            ),
            "proposed_citations": proposed.as_dict(),
            "stored_citations": stored.as_dict(),
            "usage": usage.model_dump(),
        },
        "documents": documents,
    }


def _counts(d: dict[str, Any]) -> dict[str, Any]:
    keys = ("key_points", "with_pages", "in_range", "supported")
    out: dict[str, Any] = {k: d[k] for k in keys}
    out["support_sum"] = (d["mean_support"] or 0.0) * d["with_pages"]
    return out


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def _cost(value: float | None) -> str:
    return "-" if value is None else f"{value:.4f}"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    p, st = s["proposed_citations"], s["stored_citations"]
    lines = [
        "# Document summary evaluation",
        "",
        f"- provider: `{report['provider']}` · model: `{report['model']}`",
        f"- support threshold: {report['support_threshold']} · chapter chars: "
        f"{report['chapter_chars']}",
        f"- documents: {s['documents']} · non-empty chapters: {s['chapters_nonempty']}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| chapter coverage (summary + key point) | {_pct(s['chapter_coverage'])} |",
        f"| chapters reached by the document summary | {_pct(s['document_chapter_coverage'])} |",
        f"| proposed key points with pages | {_pct(p['pages_present_rate'])} "
        f"({p['with_pages']}/{p['key_points']}) |",
        f"| proposed page citations in range | {_pct(p['in_range_rate'])} |",
        f"| proposed page citations supported by the page text | {_pct(p['supported_rate'])} "
        f"(mean support {p['mean_support']}) |",
        f"| stored page citations supported | {_pct(st['supported_rate'])} "
        f"({st['supported']}/{st['with_pages']}) |",
        f"| input / output tokens | {s['usage']['input_tokens']} / {s['usage']['output_tokens']} |",
        f"| cost (USD, LLM_PRICE_*) | {_cost(s['usage']['cost_usd'])} |",
        "",
        "| document | chapters | coverage | in doc summary | citations supported | calls |",
        "|---|---|---|---|---|---|",
    ]
    for d in report["documents"]:
        pc = d["proposed_citations"]["chapter"]
        calls = d["calls"]
        lines.append(
            f"| {d['document']} | {d['chapters_nonempty']} | {_pct(d['chapter_coverage'])} | "
            f"{_pct(d['document_chapter_coverage'])} | {_pct(pc['supported_rate'])} | "
            f"{calls['chapter']}+{calls['merge']}+{calls['document']} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("inputs", nargs="*", type=Path, help="*.truth.json, core parse JSON, PDF")
    parser.add_argument("--provider", choices=("fake", "llm"), default="fake")
    parser.add_argument("--chapter-chars", type=int, default=DEFAULT_CHAPTER_CHARS)
    parser.add_argument("--support", type=float, default=DEFAULT_SUPPORT)
    parser.add_argument("-o", "--output", type=Path, help="JSON report path")
    parser.add_argument("--markdown", type=Path, help="Markdown report path")
    args = parser.parse_args(argv)
    report = run(
        args.inputs or list(DEFAULT_BOOKS),
        provider=args.provider,
        chapter_chars=args.chapter_chars,
        threshold=args.support,
    )
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(markdown(report), encoding="utf-8")
    sys.stdout.write(markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
