"""Chapter note evaluation (DOCSUM-X): footnote precision and coverage.

Runs the worker's ``ChapterNoteGenerator`` (batching, citation checks, one re-request, dropping
invalid items) on a synthetic dataset of chapters with questions and explanations
(``eval/summaries/notes-seed.json``) and measures:

- proposed items (every response, re-requests included): share whose citations are valid
  (non-empty, only input tags) before the validator; items dropped; re-requests;
- footnote precision: of the stored (item, cited question) pairs, the share where the item names
  at least one of that question's ``keywords`` (the footnote points at a question that supports
  the item); item support: items with at least one supported footnote;
- footnote coverage: input questions cited by at least one stored item; keyword coverage:
  question keywords named by an item that cites that question;
- calls and token usage (``cost_usd`` when ``LLM_PRICE_*`` is set).

Providers: ``fake`` (default) answers each chapter with the dataset's scripted ``fake_response``
(offline, deterministic, with deliberate faults). ``llm`` uses the real provider from
``LLM_API_KEY`` / ``LLM_MODEL`` (billed; sends the synthetic questions, explanations and fixture
chapter text). Reports hold numbers and chapter ids only, never note or question text.

    uv run python eval/summaries/note_eval.py
    uv run python eval/summaries/note_eval.py --provider llm \\
        -o eval/reports/notes-llm.json --markdown eval/reports/notes-llm.md
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from book_core.llm import (
    FakeLLMClient,
    LLMClient,
    LLMConfig,
    LLMRequest,
    LLMResult,
    LLMUsage,
    create_llm_client,
)
from book_core.notes import (
    TASK,
    ChapterNoteGenerator,
    LLMNoteOutput,
    NoteCitationError,
    NoteOption,
    NoteQuestion,
    NoteRequest,
    check_response,
    plan_batches,
    question_size,
)
from book_core.notes.prompts import batch_tag
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
from source import REPO, contains, load_document, rate

DEFAULT_DATASET = Path(__file__).resolve().parent / "notes-seed.json"


class RecordingClient:
    """Passes calls through and keeps the raw structured outputs and usage."""

    def __init__(self, inner: LLMClient) -> None:
        self.inner = inner
        self.outputs: list[LLMNoteOutput] = []
        # (request fingerprint, output) per call: a re-request repeats its batch's request.
        self.calls: list[tuple[str, LLMNoteOutput]] = []
        self.usage = LLMUsage()

    @property
    def model_name(self) -> str:
        return self.inner.model_name

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        result = self.inner.complete(request, schema)
        if isinstance(result.output, LLMNoteOutput):
            self.outputs.append(result.output)
            self.calls.append((request.fingerprint(), result.output))
        self.usage = self.usage + result.info.usage
        return result

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output


@dataclass
class ChapterCase:
    id: str
    reference_text: str
    questions: tuple[NoteQuestion, ...]
    keywords: dict[str, tuple[str, ...]]
    fake_response: dict[str, Any] | None = None


def load_dataset(path: Path) -> list[ChapterCase]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cases: list[ChapterCase] = []
    for chapter in data["chapters"]:
        doc = load_document(REPO / chapter["book"])
        questions: list[NoteQuestion] = []
        keywords: dict[str, tuple[str, ...]] = {}
        for i, q in enumerate(chapter["questions"], start=1):
            tag = f"Q{i}"
            questions.append(
                NoteQuestion(
                    tag=tag,
                    label=f"{chapter['chapter_number']}장 {i}번",
                    question_type=q["question_type"],
                    stem=q["stem"],
                    options=tuple(
                        NoteOption(text=o["text"], correct=o["correct"])
                        for o in q.get("options", [])
                    ),
                    accepted_answers=tuple(q.get("accepted_answers", [])),
                    explanation=q.get("explanation"),
                )
            )
            keywords[tag] = tuple(q["keywords"])
        cases.append(
            ChapterCase(
                id=chapter["id"],
                reference_text=doc.chapter_text(chapter["section_id"]),
                questions=tuple(questions),
                keywords=keywords,
                fake_response=chapter.get("fake_response"),
            )
        )
    return cases


@dataclass
class Tally:
    chapters: int = 0
    failed: int = 0
    questions: int = 0
    proposed_items: int = 0
    proposed_valid: int = 0
    stored_items: int = 0
    dropped_items: int = 0
    llm_calls: int = 0
    batches: int = 0
    footnotes: int = 0
    footnotes_supported: int = 0
    items_supported: int = 0
    questions_cited: int = 0
    keywords: int = 0
    keywords_covered: int = 0
    usage: LLMUsage = field(default_factory=LLMUsage)

    def add(self, other: Tally) -> None:
        for name in self.__dataclass_fields__:
            if name == "usage":
                self.usage = self.usage + other.usage
            else:
                setattr(self, name, getattr(self, name) + getattr(other, name))

    def as_dict(self) -> dict[str, Any]:
        counts = {n: getattr(self, n) for n in self.__dataclass_fields__ if n != "usage"}
        return {
            **counts,
            "proposed_citation_validity": rate(self.proposed_valid, self.proposed_items),
            "footnote_precision": rate(self.footnotes_supported, self.footnotes),
            "item_support": rate(self.items_supported, self.stored_items),
            "footnote_coverage": rate(self.questions_cited, self.questions),
            "keyword_coverage": rate(self.keywords_covered, self.keywords),
            "re_requests": self.llm_calls - self.batches,
            "usage": self.usage.model_dump(),
        }


def evaluate_chapter(case: ChapterCase, client: LLMClient) -> Tally:
    recorder = RecordingClient(client)
    tally = Tally(chapters=1, questions=len(case.questions))
    tally.keywords = sum(len(k) for k in case.keywords.values())
    known = {q.tag for q in case.questions}
    try:
        result = ChapterNoteGenerator(recorder).generate(
            NoteRequest(questions=case.questions, reference_text=case.reference_text)
        )
    except NoteCitationError:
        result = None
        tally.failed = 1
    tally.usage = recorder.usage
    tally.llm_calls = len(recorder.outputs)
    # Proposed = every item of every response (a re-request's response counts again).
    for output in recorder.outputs:
        for proposed in output.sections:
            for raw in proposed.items:
                tally.proposed_items += 1
                tags = [t.strip() for t in raw.tags]
                tally.proposed_valid += bool(tags) and all(t in known for t in tags)
    # Batches, re-requests and finally dropped items come from the recorded calls, so a chapter
    # whose every item fails validation (NoteCitationError) is counted like any other.
    batches = _batch_calls(recorder.calls)
    tally.batches = len(batches)
    for fingerprint, last in batches:
        size = _batch_size(recorder.calls, fingerprint, case)
        checked = check_response(last, [batch_tag(i) for i in range(size)], case.reference_text)
        tally.dropped_items += checked.dropped
    if result is None:
        return tally
    cited: set[str] = set()
    covered: set[tuple[str, str]] = set()
    for section in result.sections:
        for item in section.items:
            tally.stored_items += 1
            supported = False
            for tag in item.tags:
                cited.add(tag)
                tally.footnotes += 1
                hits = [k for k in case.keywords.get(tag, ()) if contains(item.text, k)]
                covered.update((tag, k) for k in hits)
                if hits:
                    tally.footnotes_supported += 1
                    supported = True
            tally.items_supported += supported
    tally.questions_cited = len(cited & known)
    tally.keywords_covered = len(covered)
    return tally


def _batch_calls(calls: Sequence[tuple[str, LLMNoteOutput]]) -> list[tuple[str, LLMNoteOutput]]:
    """One entry per batch (consecutive calls with the same request), with its last response."""
    batches: list[tuple[str, LLMNoteOutput]] = []
    for fingerprint, output in calls:
        if batches and batches[-1][0] == fingerprint:
            batches[-1] = (fingerprint, output)
        else:
            batches.append((fingerprint, output))
    return batches


def _batch_size(
    calls: Sequence[tuple[str, LLMNoteOutput]], fingerprint: str, case: ChapterCase
) -> int:
    """Questions in the batch of ``fingerprint`` (the generator's own contiguous plan)."""
    plan = plan_batches([question_size(q) for q in case.questions])
    order = [f for i, (f, _) in enumerate(calls) if i == 0 or calls[i - 1][0] != f]
    return len(plan[order.index(fingerprint)])


def client_for(provider: str) -> Callable[[ChapterCase], LLMClient]:
    if provider == "fake":

        def fake(case: ChapterCase) -> LLMClient:
            if case.fake_response is None:
                raise SystemExit(f"{case.id}: no fake_response in the dataset")
            client = FakeLLMClient("fake-scripted-note")
            client.script(TASK, case.fake_response)
            return client

        return fake
    config = LLMConfig.from_env()
    if config is None:
        raise SystemExit("--provider llm needs LLM_API_KEY and LLM_MODEL")
    real = create_llm_client(config)
    return lambda case: real


def run(
    dataset: Path = DEFAULT_DATASET,
    *,
    provider: str = "fake",
    clients: Callable[[ChapterCase], LLMClient] | None = None,
) -> dict[str, Any]:
    make = clients or client_for(provider)
    total = Tally()
    chapters: list[dict[str, Any]] = []
    model = None
    for case in load_dataset(dataset):
        client = make(case)
        model = client.model_name
        tally = evaluate_chapter(case, client)
        total.add(tally)
        chapters.append({"chapter": case.id, **tally.as_dict()})
    return {
        "eval": "chapter-notes",
        "provider": provider,
        "model": model,
        "dataset": str(dataset.resolve().relative_to(REPO))
        if dataset.resolve().is_relative_to(REPO)
        else dataset.name,
        "summary": total.as_dict(),
        "chapters": chapters,
    }


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    cost = s["usage"]["cost_usd"]
    lines = [
        "# Chapter note evaluation",
        "",
        f"- provider: `{report['provider']}` · model: `{report['model']}`",
        f"- dataset: `{report['dataset']}` · chapters: {s['chapters']} (failed {s['failed']})"
        f" · questions: {s['questions']}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| footnote precision (cited question supports the item) | "
        f"{_pct(s['footnote_precision'])} ({s['footnotes_supported']}/{s['footnotes']}) |",
        f"| items with a supported footnote | {_pct(s['item_support'])} |",
        f"| footnote coverage (questions cited) | {_pct(s['footnote_coverage'])} "
        f"({s['questions_cited']}/{s['questions']}) |",
        f"| keyword coverage | {_pct(s['keyword_coverage'])} |",
        f"| proposed items with valid citations | {_pct(s['proposed_citation_validity'])} "
        f"({s['proposed_valid']}/{s['proposed_items']}) |",
        f"| dropped items / re-requests | {s['dropped_items']} / {s['re_requests']} |",
        f"| LLM calls / input / output tokens | {s['llm_calls']} / "
        f"{s['usage']['input_tokens']} / {s['usage']['output_tokens']} |",
        f"| cost (USD, LLM_PRICE_*) | {cost if cost is not None else '-'} |",
        "",
        "| chapter | precision | coverage | keyword coverage | dropped | calls |",
        "|---|---|---|---|---|---|",
    ]
    for c in report["chapters"]:
        lines.append(
            f"| {c['chapter']} | {_pct(c['footnote_precision'])} | "
            f"{_pct(c['footnote_coverage'])} | {_pct(c['keyword_coverage'])} | "
            f"{c['dropped_items']} | {c['llm_calls']} |"
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
