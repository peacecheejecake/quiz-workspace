"""AI question and AI explanation evaluation (ASK-X): citations, grounding, refusals, leaks.

Runs the product's own request builders and output checks over the synthetic cases of
``eval/ask/ask-seed.json`` and measures:

- citation validity: the share of footnote tags in the raw answers that name a passage the
  request actually gave (``book_core.ask.validate_citations`` drops the rest), and the answers that
  had passages but cited none;
- grounding: the share of cited paragraphs whose cited passage supports them (character-bigram
  containment >= 0.3; with ``--provider llm`` an LLM judge is added);
- not-found accuracy: ``[NO_ANSWER]`` exactly when nothing relevant was given (and false refusals);
- ``hint`` answer leakage: the share of answers to a not-yet-submitted attached question (registered
  and mock exam questions) that name the correct option as correct or state the final answer
  (``정답은`` and number / option-text patterns; mentioning an option's text alone is no leak,
  ASK-01-C03; with ``--provider llm`` an LLM judge is added);
- AI explanation answer agreement: the explanation's ``[[ANSWER]]`` line equals the stored correct
  ids (``book_core.explain.finish_explanation`` rejects the rest), plus how many are valid at once
  and after the one coverage re-request;
- tokens, ``cost_usd`` (only with provider pricing: ``LLM_PRICE_*``) and the time to the first text.

Providers: ``fake`` (default) plays back the scripted outputs of the dataset (offline,
deterministic, with deliberate faults). ``llm`` uses the real provider from ``LLM_API_KEY`` /
``LLM_MODEL`` (billed; sends only the synthetic passages and questions of the dataset). Reports
hold numbers, case ids and codes, never question, passage or answer text.

    uv run python eval/ask/ask_eval.py
    uv run python eval/ask/ask_eval.py --provider llm \\
        -o eval/reports/ask-llm.json --markdown eval/reports/ask-llm.md
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from book_core.ask import (
    AskSource,
    HintQuestionContext,
    build_request,
    hint_context,
    validate_citations,
)
from book_core.explain import (
    ExplainQuestion,
    explain_question,
    finish_explanation,
    parse_output,
)
from book_core.explain import build_request as build_explain_request
from book_core.llm import LLMConfig, LLMUsage
from book_core.llm.streaming import (
    TextDelta,
    TextMessage,
    TextStreamClient,
    TextStreamEnd,
    TextStreamEvent,
    TextStreamRequest,
    create_text_stream_client,
    estimate_tokens,
)

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = Path(__file__).resolve().parent / "ask-seed.json"
ASK_MAX_OUTPUT_TOKENS = 2000
EXPLAIN_MAX_OUTPUT_TOKENS = 1500
SUPPORT_THRESHOLD = 0.3
_GROUP = re.compile(r"\[\s*(S\d{1,3}(?:\s*[,\N{FULLWIDTH COMMA}]\s*S\d{1,3})*)\s*\]")
_TAG = re.compile(r"S\d{1,3}")
_FOOTNOTE = re.compile(r"\[(\d{1,3})\]")


@dataclass(frozen=True)
class Dataset:
    path: Path
    passages: dict[str, AskSource]
    ask_cases: tuple[dict[str, Any], ...]
    explain_cases: tuple[dict[str, Any], ...]


# --- dataset -------------------------------------------------------------------------------------


def load_dataset(path: Path) -> Dataset:
    data = json.loads(path.read_text(encoding="utf-8"))
    truth = json.loads((REPO / data["book"]).read_text(encoding="utf-8"))
    if not truth.get("synthetic"):
        raise ValueError("only synthetic fixture truth files are accepted")
    blocks = {b["id"]: b for b in truth["blocks"]}
    passages: dict[str, AskSource] = {}
    for key, spec in data["passages"].items():
        picked = [blocks[b] for b in spec["blocks"]]
        pages = sorted({p["page"] for b in picked for p in b["parts"]})
        passages[key] = AskSource(
            tag="S0",
            document_title=truth["fixture_id"],
            chapter_title=spec["chapter"],
            page_from=pages[0],
            page_to=pages[-1],
            text="\n\n".join(b["text"] for b in picked),
        )
    return Dataset(
        path=path,
        passages=passages,
        ask_cases=tuple(data["ask_cases"]),
        explain_cases=tuple(data["explain_cases"]),
    )


def tagged(dataset: Dataset, keys: Sequence[str]) -> list[AskSource]:
    """The case's passages in rank order, tagged ``S1``..."""
    import dataclasses

    return [
        dataclasses.replace(dataset.passages[k], tag=f"S{n}") for n, k in enumerate(keys, start=1)
    ]


def mcq_options(options: Sequence[str]) -> list[dict[str, str]]:
    return [{"id": f"opt-{n}", "text": text} for n, text in enumerate(options, start=1)]


# --- providers -----------------------------------------------------------------------------------


class ScriptedClient:
    """Plays back the dataset's scripted raw outputs (offline). A request is found by its task and
    question (the ask question, or the explanation's stem); a case with a ``retry_script`` answers
    its second request with that."""

    model_name = "scripted-ask"

    def __init__(self, dataset: Dataset) -> None:
        self._scripts: dict[str, list[str]] = {}
        for case in dataset.ask_cases:
            self._scripts[f"ask.answer:{case['question']}"] = [case["script"]]
        for case in dataset.explain_cases:
            outputs = [case["script"]]
            if "retry_script" in case:
                outputs.append(case["retry_script"])
            self._scripts[f"question.ai_explain:{case['mcq']['stem']}"] = outputs

    def stream_text(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]:
        prompt = request.messages[-1].content
        if request.task == "ask.answer":
            key = prompt.rsplit("# 질문\n", 1)[-1].strip()
        else:
            match = re.search(r"^발문: (.*)$", prompt, flags=re.MULTILINE)
            key = match.group(1) if match else ""
        outputs = self._scripts.get(f"{request.task}:{key}")
        if outputs is None:
            raise KeyError(f"no scripted output for {request.task}")
        text = outputs.pop(0) if len(outputs) > 1 else outputs[0]
        return self._stream(request, text)

    @staticmethod
    def _stream(request: TextStreamRequest, text: str) -> Iterator[TextStreamEvent]:
        size = max(1, -(-len(text) // 4))
        for start in range(0, len(text), size):
            yield TextDelta(text[start : start + size])
        yield TextStreamEnd(
            model=ScriptedClient.model_name,
            stop_reason="end_turn",
            usage=LLMUsage(
                input_tokens=estimate_tokens(
                    request.system + "".join(m.content for m in request.messages)
                ),
                output_tokens=estimate_tokens(text),
            ),
        )


class Meter:
    """Runs one streamed call and keeps usage, time to first text and the text."""

    def __init__(self, client: TextStreamClient) -> None:
        self.client = client
        self.usage = LLMUsage()
        self.first_text_ms: list[float] = []
        self.calls = 0

    def text(self, request: TextStreamRequest) -> tuple[str, bool]:
        """(text, truncated)."""
        self.calls += 1
        start = time.perf_counter()
        parts: list[str] = []
        truncated = False
        for event in self.client.stream_text(request):
            if isinstance(event, TextDelta):
                if not parts:
                    self.first_text_ms.append((time.perf_counter() - start) * 1000)
                parts.append(event.text)
            else:
                self.usage = self.usage + event.usage
                truncated = event.truncated
        return "".join(parts), truncated


# --- metrics -------------------------------------------------------------------------------------


def bigrams(text: str) -> set[str]:
    flat = re.sub(r"[\W_]+", "", text)
    return {flat[i : i + 2] for i in range(len(flat) - 1)}


def supported(sentence: str, passage: str) -> bool:
    """Lexical support: at least 30% of the paragraph's character bigrams occur in the passage."""
    grams = bigrams(sentence)
    return bool(grams) and len(grams & bigrams(passage)) / len(grams) >= SUPPORT_THRESHOLD


def cited_paragraphs(text: str, cited_tags: Sequence[str]) -> list[tuple[str, list[int]]]:
    """(paragraph without footnotes, footnote numbers) for every paragraph (line) that has a
    footnote: the model puts the tag after the sentence it supports."""
    out: list[tuple[str, list[int]]] = []
    for part in re.split(r"\n+", text):
        numbers = [int(n) for n in _FOOTNOTE.findall(part) if 1 <= int(n) <= len(cited_tags)]
        body = _FOOTNOTE.sub("", part).strip()
        if numbers and body:
            out.append((body, numbers))
    return out


def raw_tags(raw: str) -> list[str]:
    return [t for group in _GROUP.findall(raw) for t in _TAG.findall(group)]


def leak_patterns(number: int, correct_text: str) -> list[re.Pattern[str]]:
    text = re.escape(correct_text)
    return [
        re.compile(r"정답\s*(?:은|는|이|:|입니다)"),
        re.compile(r"최종\s*(?:답|정답)"),
        re.compile(rf"(?<!\d){number}\s*번\s*(?:이|은|을)?\s*(?:정답|답)"),
        re.compile(rf"(?:답|정답)\s*(?:은|는|:)?\s*(?<!\d){number}\s*번"),
        re.compile(rf"{text}\s*(?:이|가|은|는)?\s*(?:정답|답)"),
    ]


def leaks(answer: str, number: int, correct_text: str) -> bool:
    """The answer names the correct option as correct or states the final answer."""
    return any(p.search(answer) for p in leak_patterns(number, correct_text))


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def percentile(values: Sequence[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round(p / 100 * (len(ordered) - 1))))
    return round(ordered[index], 3)


_JUDGE_SYSTEM = (
    "You grade one answer of a document assistant. Reply with exactly one word: YES or NO."
)


def judge(meter: Meter, instruction: str, material: str) -> bool | None:
    request = TextStreamRequest(
        task="eval.judge",
        prompt_version="eval.judge/v1",
        system=_JUDGE_SYSTEM,
        messages=(TextMessage("user", f"{instruction}\n\n{material}"),),
        max_tokens=16,
    )
    try:
        reply, _ = meter.text(request)
    except Exception:  # a judge outage leaves the metric to the patterns
        return None
    word = reply.strip().upper()
    return True if word.startswith("YES") else False if word.startswith("NO") else None


# --- cases ---------------------------------------------------------------------------------------


def hint_attachment(case: dict[str, Any]) -> HintQuestionContext:
    mcq = case["mcq"]
    options = mcq_options(mcq["options"])
    return hint_context(
        kind="mock_exam_question" if case["attachment"] == "mock_exam" else "question",
        number="1",
        chapter=None,
        question_type="MCQ",
        stem=mcq["stem"],
        options=options,
        displayed_option_ids=[o["id"] for o in options],
        selected_option_ids=[],
    )


def run_ask_case(
    dataset: Dataset, case: dict[str, Any], meter: Meter, *, use_judge: bool
) -> dict[str, Any]:
    sources = tagged(dataset, case["sources"])
    attachment = hint_attachment(case) if case["kind"] == "hint" else None
    request = build_request(
        question=case["question"],
        sources=sources,
        attachment=attachment,
        max_output_tokens=ASK_MAX_OUTPUT_TOKENS,
    )
    raw, _ = meter.text(request.to_text_request())
    result = validate_citations(raw, request.source_tags)
    tags = raw_tags(raw)
    texts = {s.tag: s.text for s in request.sources}
    sentences = cited_paragraphs(result.text, result.cited_tags)
    checks = [
        supported(body, texts[result.cited_tags[n - 1]])
        for body, nums in sentences
        for n in nums[:1]
    ]
    entry: dict[str, Any] = {
        "case": case["id"],
        "kind": case["kind"],
        "no_answer": result.no_answer,
        "tags": len(tags),
        "valid_tags": sum(1 for t in tags if t in texts),
        "dropped": result.dropped,
        "uncited": result.uncited,
        "cited_paragraphs": len(checks),
        "supported_sentences": sum(checks),
        "sources": len(sources),
    }
    if use_judge and not result.no_answer and sentences:
        verdicts = [
            judge(
                meter,
                "Is the sentence fully supported by the passage? Passage and sentence follow.",
                f"Passage:\n{texts[result.cited_tags[nums[0] - 1]]}\n\nSentence:\n{body}",
            )
            for body, nums in sentences
        ]
        entry["judged_sentences"] = sum(1 for v in verdicts if v is not None)
        entry["judge_supported"] = sum(1 for v in verdicts if v)
    if case["kind"] == "hint":
        mcq = case["mcq"]
        number = mcq["correct"]
        pattern_leak = leaks(result.text, number, mcq["options"][number - 1])
        leaked = pattern_leak
        if use_judge:
            verdict = judge(
                meter,
                "Does the answer say which option is correct or state the final answer? "
                "Mentioning an option's text without saying it is correct is NO.",
                f"Options: {mcq['options']}\nAnswer:\n{result.text}",
            )
            entry["judge_leak"] = verdict
            leaked = pattern_leak or bool(verdict)
        entry["leaked"] = leaked
        entry["attachment"] = case["attachment"]
        entry["disclosure"] = request.disclosure
        entry["hint_fields"] = list(request.attachment_fields)
    return entry


def explain_input(case: dict[str, Any]) -> ExplainQuestion:
    mcq = case["mcq"]
    return explain_question(
        kind="question",
        question_type="MCQ",
        stem=mcq["stem"],
        options=mcq_options(mcq["options"]),
        correct_option_ids=[f"opt-{mcq['correct']}"],
        accepted_answers=None,
        rubric=None,
        explanation=None,
    )


def run_explain_case(dataset: Dataset, case: dict[str, Any], meter: Meter) -> dict[str, Any]:
    question = explain_input(case)
    sources = tagged(dataset, case["sources"])
    request = build_explain_request(
        question=question, sources=sources, max_output_tokens=EXPLAIN_MAX_OUTPUT_TOKENS
    )
    raw, truncated = meter.text(request.to_text_request())
    parsed = parse_output(raw)
    agrees = parsed.correct_option_ids is not None and set(parsed.correct_option_ids) == set(
        question.correct_option_ids
    )
    finished = finish_explanation(raw, question, request.source_tags, truncated=truncated)
    retried = False
    if finished.body is None and finished.missing_option_ids:
        retried = True
        again = build_explain_request(
            question=question,
            sources=sources,
            max_output_tokens=EXPLAIN_MAX_OUTPUT_TOKENS,
            missing_option_ids=finished.missing_option_ids,
        )
        raw2, truncated2 = meter.text(again.to_text_request())
        finished_after = finish_explanation(raw2, question, again.source_tags, truncated=truncated2)
    else:
        finished_after = finished
    return {
        "case": case["id"],
        "answer_agrees": agrees,
        "valid_first": finished.body is not None,
        "valid_final": finished_after.body is not None,
        "re_requested": retried,
        "error_first": finished.error_code,
        "error_final": finished_after.error_code,
        "dropped_citations": finished_after.dropped_citations,
        "cited": len(finished_after.cited_tags),
    }


# --- report --------------------------------------------------------------------------------------


def summarize(
    ask: Sequence[dict[str, Any]], explain: Sequence[dict[str, Any]], meter: Meter
) -> dict[str, Any]:
    answered = [e for e in ask if not e["no_answer"]]
    answerable = [e for e in ask if e["kind"] != "not_found"]
    not_found = [e for e in ask if e["kind"] == "not_found"]
    hints = [e for e in ask if e["kind"] == "hint"]
    tags = sum(e["tags"] for e in answered)
    valid = sum(e["valid_tags"] for e in answered)
    cited = sum(e["cited_paragraphs"] for e in answered)
    sup = sum(e["supported_sentences"] for e in answered)
    judged = sum(e.get("judged_sentences", 0) for e in answered)
    judge_ok = sum(e.get("judge_supported", 0) for e in answered)
    refused_right = sum(1 for e in not_found if e["no_answer"])
    answered_right = sum(1 for e in answerable if not e["no_answer"])
    decisions = len(not_found) + len(answerable)
    errors: Counter[str] = Counter(e["error_final"] for e in explain if e["error_final"])
    by_attachment = {
        kind: {
            "cases": sum(1 for e in hints if e["attachment"] == kind),
            "leaked": sum(1 for e in hints if e["attachment"] == kind and e["leaked"]),
        }
        for kind in ("registered", "mock_exam")
    }
    ms = meter.first_text_ms
    return {
        "ask_cases": len(ask),
        "answers": len(answered),
        "citation_tags": tags,
        "citation_valid_rate": rate(valid, tags),
        "answers_with_dropped_tags": sum(1 for e in answered if e["dropped"]),
        "uncited_answers": sum(1 for e in answered if e["uncited"]),
        "cited_paragraphs": cited,
        "support_rate": rate(sup, cited),
        "judged_sentences": judged,
        "judge_support_rate": rate(judge_ok, judged),
        "not_found_cases": len(not_found),
        "not_found_correct": refused_right,
        "answerable_cases": len(answerable),
        "false_refusals": len(answerable) - answered_right,
        "not_found_accuracy": rate(refused_right + answered_right, decisions),
        "hint_cases": len(hints),
        "hint_leaked": sum(1 for e in hints if e["leaked"]),
        "hint_leak_rate": rate(sum(1 for e in hints if e["leaked"]), len(hints)),
        "hint_leaks_by_attachment": by_attachment,
        "explain_cases": len(explain),
        "explain_answer_agreement": rate(
            sum(1 for e in explain if e["answer_agrees"]), len(explain)
        ),
        "explain_valid_first": rate(sum(1 for e in explain if e["valid_first"]), len(explain)),
        "explain_valid_final": rate(sum(1 for e in explain if e["valid_final"]), len(explain)),
        "explain_re_requests": sum(1 for e in explain if e["re_requested"]),
        "explain_errors": dict(sorted(errors.items())),
        "llm_calls": meter.calls,
        "usage": meter.usage.model_dump(),
        "first_text_ms": {
            "count": len(ms),
            "p50": percentile(ms, 50),
            "p95": percentile(ms, 95),
        },
    }


def client_for(provider: str, dataset: Dataset) -> TextStreamClient:
    if provider == "fake":
        return ScriptedClient(dataset)
    config = LLMConfig.from_env()
    if config is None:
        raise SystemExit("--provider llm needs LLM_API_KEY and LLM_MODEL")
    return create_text_stream_client(config)


def run(
    dataset_path: Path = DEFAULT_DATASET,
    *,
    provider: str = "fake",
    client: TextStreamClient | None = None,
) -> dict[str, Any]:
    dataset = load_dataset(dataset_path)
    llm = client or client_for(provider, dataset)
    meter = Meter(llm)
    use_judge = provider == "llm"
    ask = [run_ask_case(dataset, c, meter, use_judge=use_judge) for c in dataset.ask_cases]
    explain = [run_explain_case(dataset, c, meter) for c in dataset.explain_cases]
    return {
        "eval": "ask",
        "provider": provider,
        "model": llm.model_name,
        "dataset": str(dataset_path.resolve().relative_to(REPO))
        if dataset_path.resolve().is_relative_to(REPO)
        else dataset_path.name,
        "summary": summarize(ask, explain, meter),
        "ask": ask,
        "explain": explain,
    }


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    cost = s["usage"]["cost_usd"]
    leaks_by = s["hint_leaks_by_attachment"]
    lines = [
        "# AI question and AI explanation evaluation",
        "",
        f"- provider: `{report['provider']}` · model: `{report['model']}`",
        f"- dataset: `{report['dataset']}` · ask cases: {s['ask_cases']} · "
        f"explanation cases: {s['explain_cases']}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| citation validity (known tags / raw tags) | {_pct(s['citation_valid_rate'])} "
        f"({s['citation_tags']} tags, {s['answers_with_dropped_tags']} answers lost a tag) |",
        f"| answers that had passages but cited none | {s['uncited_answers']} / {s['answers']} |",
        f"| grounding (cited paragraph supported by its passage) | {_pct(s['support_rate'])} "
        f"({s['cited_paragraphs']} paragraphs) |",
        f"| grounding, LLM judge | {_pct(s['judge_support_rate'])} ({s['judged_sentences']}) |",
        f"| not-found accuracy | {_pct(s['not_found_accuracy'])} "
        f"(refused {s['not_found_correct']}/{s['not_found_cases']}, "
        f"false refusals {s['false_refusals']}/{s['answerable_cases']}) |",
        f"| `hint` answer leakage | {_pct(s['hint_leak_rate'])} "
        f"({s['hint_leaked']}/{s['hint_cases']}; registered {leaks_by['registered']['leaked']}/"
        f"{leaks_by['registered']['cases']}, mock exam {leaks_by['mock_exam']['leaked']}/"
        f"{leaks_by['mock_exam']['cases']}) |",
        f"| AI explanation answer agreement | {_pct(s['explain_answer_agreement'])} "
        f"({s['explain_cases']} cases) |",
        f"| AI explanation valid at once / after the re-request | "
        f"{_pct(s['explain_valid_first'])} / {_pct(s['explain_valid_final'])} "
        f"({s['explain_re_requests']} re-request) |",
        f"| AI explanation failures | {s['explain_errors'] or '-'} |",
        f"| LLM calls | {s['llm_calls']} |",
        f"| input / output tokens | {s['usage']['input_tokens']} / {s['usage']['output_tokens']} |",
        f"| cost (USD, LLM_PRICE_*) | {cost if cost is not None else '-'} |",
        f"| first text p50 / p95 (ms, this process; queue wait and worker RAM are measured "
        f"on the stack) | {s['first_text_ms']['p50']} / {s['first_text_ms']['p95']} |",
        "",
        "| ask case | kind | answer | tags (known) | cited paragraphs (supported) | leaked |",
        "|---|---|---|---|---|---|",
    ]
    for e in report["ask"]:
        lines.append(
            f"| {e['case']} | {e['kind']} | {'refused' if e['no_answer'] else 'answered'} | "
            f"{e['tags']} ({e['valid_tags']}) | {e['cited_paragraphs']} "
            f"({e['supported_sentences']}) | {e.get('leaked', '-')} |"
        )
    lines += [
        "",
        "| explanation case | answer line | valid at once | after re-request | error |",
        "|---|---|---|---|---|",
    ]
    for e in report["explain"]:
        lines.append(
            f"| {e['case']} | {'ok' if e['answer_agrees'] else 'wrong'} | "
            f"{e['valid_first']} | {e['valid_final']} | "
            f"{e['error_final'] or e['error_first'] or '-'} |"
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
