"""Explainers: the provider adapter and the deterministic APP_ENV=test fake (AIEXPL-01-C08).

``Explainer.stream(request, meta)`` yields ``TextDelta``s then one ``TextStreamEnd``.
``ProviderExplainer`` sends ``request.to_text_request()`` to a ``TextStreamClient``.

``FakeExplainer`` (tests/e2e/fixtures/ai-explanations.ts E5-E7) answers from the request's
question in the tagged format: the correct option ids, a summary ``정답은 <정답 보기 글>입니다.
<S1 첫 문장> [S1]``, one line per option ``<보기 글>: 맞습니다|틀립니다. …`` and the concept
(S1's first sentence), in at least three whole-line chunks ~150 ms apart. Markers in the stem:

- ``E2E-EXPL-FAIL``: a provider error on the first call of a question revision;
- ``E2E-EXPL-MISMATCH``: on the first call of a revision, a wrong option as the answer and
  ``FAKE_RAW_SENTINEL`` in the summary (the worker must never show or store it);
- ``E2E-EXPL-MISSING-OPTION``: the last option left out on every call (re-request, then failed);
- ``E2E-EXPL-SLOW``: at least six chunks 500 ms apart;
- ``E2E-EXPL-HOLD-<token>``: before the first chunk, creates ``<hold dir>/<token>.held`` and waits
  (at most 120 s) for ``<token>.release``;
- ``E2E-EXPL-HOLDMID-<token>``: after the first chunk, creates ``<token>.mid`` and waits (at most
  120 s) for ``<token>.resume``.

"First call of a revision" is read from the call log, so it holds across processes: every call
writes ``<log dir>/ai_explanation/<target id>/<call id>.json`` with the target kind, revision id,
explanation id, attempt and markers only (never question or passage text), and is kept in
``calls`` as ``(markers, request)``. The markers mean nothing outside APP_ENV=test (the worker
builds this fake only there).
"""

from __future__ import annotations

import json
import re
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from book_core.ask.fake import first_sentence
from book_core.explain.prompts import NO_EVIDENCE_TEXT, ExplainRequest
from book_core.llm.base import LLMProviderError, LLMUsage
from book_core.llm.streaming import (
    TextDelta,
    TextStreamClient,
    TextStreamEnd,
    TextStreamEvent,
    estimate_tokens,
)

MARKER_FAIL = "E2E-EXPL-FAIL"
MARKER_MISMATCH = "E2E-EXPL-MISMATCH"
MARKER_MISSING_OPTION = "E2E-EXPL-MISSING-OPTION"
MARKER_SLOW = "E2E-EXPL-SLOW"
MARKER_HOLD = "E2E-EXPL-HOLD"
MARKER_HOLDMID = "E2E-EXPL-HOLDMID"
FAKE_RAW_SENTINEL = "E2E-EXPL-RAW-OUTPUT"
FAKE_MODEL = "fake-ai-explanation"
LOG_SUBDIR = "ai_explanation"
HOLD_TIMEOUT_SECONDS = 120.0
DEFAULT_LOG_DIR = Path(tempfile.gettempdir()) / "quiz-e2e-ask-fake-log"
DEFAULT_HOLD_DIR = Path(tempfile.gettempdir()) / "quiz-e2e-ask-hold"
_SIMPLE = (MARKER_FAIL, MARKER_MISMATCH, MARKER_MISSING_OPTION, MARKER_SLOW)
_HOLD = re.compile(re.escape(MARKER_HOLD) + r"-([A-Za-z0-9_]{1,64})")
_HOLDMID = re.compile(re.escape(MARKER_HOLDMID) + r"-([A-Za-z0-9_]{1,64})")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True, slots=True)
class ExplainCallMeta:
    """Who is being explained: the call log's directory (`target_id`) and record fields."""

    target_kind: str
    target_id: str
    revision_id: str
    explanation_id: str


@runtime_checkable
class Explainer(Protocol):
    @property
    def model_name(self) -> str: ...

    def stream(
        self, request: ExplainRequest, meta: ExplainCallMeta
    ) -> Iterator[TextStreamEvent]: ...


class ProviderExplainer:
    def __init__(self, client: TextStreamClient) -> None:
        self._client = client

    @property
    def model_name(self) -> str:
        return self._client.model_name

    def stream(self, request: ExplainRequest, meta: ExplainCallMeta) -> Iterator[TextStreamEvent]:
        return self._client.stream_text(request.to_text_request())


def markers_of(stem: str) -> tuple[str, ...]:
    found = [m for m in _SIMPLE if m in stem]
    if _HOLD.search(stem):
        found.append(MARKER_HOLD)
    if _HOLDMID.search(stem):
        found.append(MARKER_HOLDMID)
    return tuple(found)


def _lines(request: ExplainRequest, markers: tuple[str, ...], first_call: bool) -> list[str]:
    question = request.question
    lead = first_sentence(request.sources[0].text) if request.sources else ""
    cite = f"{lead} [{request.sources[0].tag}]" if request.sources else NO_EVIDENCE_TEXT
    if question.is_mcq:
        correct = " / ".join(question.correct_texts)
        answer = list(question.correct_option_ids)
        if MARKER_MISMATCH in markers and first_call:
            wrong = next((o for o in question.option_ids if o not in answer), None)
            answer = [wrong] if wrong else answer
        summary = f"정답은 {correct}입니다. {cite}"
        if MARKER_MISMATCH in markers and first_call:
            summary = f"{summary} {FAKE_RAW_SENTINEL}"
        lines = [f"[[ANSWER]] {', '.join(answer)}", "[[SUMMARY]]", summary]
        options = list(question.options)
        if MARKER_MISSING_OPTION in markers and options:
            options = options[:-1]
        for option in options:
            if option.option_id in question.correct_option_ids:
                why = f"{option.text}: 맞습니다. {cite}"
            else:
                why = f"{option.text}: 틀립니다. 정답은 {correct}입니다."
            lines += [f"[[OPTION {option.option_id}]]", why]
    else:
        answer_text = " / ".join(question.accepted_answers) or "채점 기준의 답"
        lines = ["[[SUMMARY]]", f"정답은 {answer_text}입니다. {cite}", "[[POINTS]]"]
        lines.append(f"채점 기준의 핵심: {question.rubric or answer_text}.")
    lines += ["[[CONCEPTS]]", cite]
    if MARKER_SLOW in markers:
        lines += [f"자세히 풀어 쓴 설명 {n}." for n in range(1, 11)]
    return lines


def _chunks(lines: list[str], count: int) -> list[str]:
    """The first chunk holds the answer, summary label and summary line; the rest is split in
    at least `count - 1` more whole-line chunks."""
    head, tail = lines[:3], lines[3:]
    size = max(1, -(-len(tail) // max(1, count - 1)))
    parts = [head] + [tail[i : i + size] for i in range(0, len(tail), size)]
    return ["".join(f"{line}\n" for line in part) for part in parts if part]


class FakeExplainer:
    def __init__(
        self,
        *,
        log_dir: Path | None = None,
        hold_dir: Path | None = None,
        delay_seconds: float = 0.15,
        slow_delay_seconds: float = 0.5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._log_dir = (log_dir or DEFAULT_LOG_DIR) / LOG_SUBDIR
        self._hold_dir = hold_dir or DEFAULT_HOLD_DIR
        self._delay = delay_seconds
        self._slow_delay = slow_delay_seconds
        self._sleep = sleep
        self._lock = threading.Lock()
        self.calls: list[tuple[tuple[str, ...], ExplainRequest]] = []

    @property
    def model_name(self) -> str:
        return FAKE_MODEL

    def stream(self, request: ExplainRequest, meta: ExplainCallMeta) -> Iterator[TextStreamEvent]:
        markers = markers_of(request.question.stem)
        with self._lock:
            self.calls.append((markers, request))
            first_call = not self._earlier_call(meta)
            self._record(meta, request, markers)
        return self._stream(request, markers, first_call)

    def _target_dir(self, meta: ExplainCallMeta) -> Path | None:
        return self._log_dir / meta.target_id if _SAFE_ID.match(meta.target_id) else None

    def _earlier_call(self, meta: ExplainCallMeta) -> bool:
        folder = self._target_dir(meta)
        if folder is None or not folder.is_dir():
            return False
        for path in folder.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("revision_id") == meta.revision_id:
                return True
        return False

    def _record(
        self, meta: ExplainCallMeta, request: ExplainRequest, markers: tuple[str, ...]
    ) -> None:
        folder = self._target_dir(meta)
        if folder is None:
            return
        record = {
            "target_kind": meta.target_kind,
            "revision_id": meta.revision_id,
            "explanation_id": meta.explanation_id,
            "attempt": request.attempt,
            "markers": list(markers),
        }
        try:
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
            (folder / name).write_text(json.dumps(record), encoding="utf-8")
        except OSError:
            pass

    def _wait(self, token: str, made: str, until: str) -> None:
        self._hold_dir.mkdir(parents=True, exist_ok=True)
        (self._hold_dir / f"{token}.{made}").write_text("")
        release = self._hold_dir / f"{token}.{until}"
        deadline = time.monotonic() + HOLD_TIMEOUT_SECONDS
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.1)

    def _stream(
        self, request: ExplainRequest, markers: tuple[str, ...], first_call: bool
    ) -> Iterator[TextStreamEvent]:
        stem = request.question.stem
        if MARKER_FAIL in markers and first_call:
            raise LLMProviderError("fake provider unavailable", kind="connection")
        hold = _HOLD.search(stem)
        if hold is not None:
            self._wait(hold.group(1), "held", "release")
        slow = MARKER_SLOW in markers
        chunks = _chunks(_lines(request, markers, first_call), 6 if slow else 3)
        mid = _HOLDMID.search(stem)
        for n, chunk in enumerate(chunks):
            if n == 1 and mid is not None:
                self._wait(mid.group(1), "mid", "resume")
            elif n:
                self._sleep(self._slow_delay if slow else self._delay)
            yield TextDelta(chunk)
        yield TextStreamEnd(
            model=FAKE_MODEL,
            stop_reason="end_turn",
            usage=LLMUsage(
                input_tokens=estimate_tokens(request.system + request.prompt),
                output_tokens=estimate_tokens("".join(chunks)),
            ),
        )
