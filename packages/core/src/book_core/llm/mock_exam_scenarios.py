"""The deterministic batched fake LLM of mock exam generation (APP_ENV=test only; MOCK-01,
assumptions K4-K7 of tests/e2e/fixtures/mock-exams.ts).

It answers ``mock_exam.generate`` requests from the ``mock_exam`` block of
``tests/fixtures/llm/generation-scenarios.json``: one item per source block (``<<<S1`` ...) of
the request, chosen by the bracketed ``[E2E-MOCK-…]`` marker of the source stem — a named source
(``sources.<key>.items.<VARIATION_TYPE>``) or a template (``E2E-MOCK-BULK-<nnn>``,
``E2E-MOCK-CRASH-<token>``) — with ``source_tag`` and every citation's ``passage_id`` (the
request's passage whose text holds the quote) filled in. The same request always gets the same
answer. Faults: ``malformed`` / ``truncated`` answer requests with more than ``sources_over``
sources with unparseable output (a truncated one says ``stop_reason=max_tokens``), and
``unavailable`` raises ``LLMProviderError``. A source without a known marker gets no item.

Test hooks: ``[E2E-MOCK-HOLD-<token>]`` holds the call until ``<hold dir>/<token>.release``
exists (K6); ``E2E-MOCK-CRASH-<token>`` raises :class:`MockExamSimulatedCrash` once per token
(K7). Every call is recorded in ``calls`` as ``(markers, request)``, and ``max_in_flight`` is the
most calls answered at once.
"""

from __future__ import annotations

import json
import re
import tempfile
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from book_core.llm.base import (
    LLMCallInfo,
    LLMOutputError,
    LLMProviderError,
    LLMRequest,
    LLMResult,
    LLMUsage,
    parse_structured_output,
)

MODEL_NAME = "fake-mock-exam-llm"
HOLD_DIR_NAME = "quiz-e2e-mock-exam-hold"
FAULT_DIR_NAME = "quiz-e2e-mock-exam-faults"
HOLD_TIMEOUT_SECONDS = 120.0

_MARKER = re.compile(r"\[(E2E-MOCK-[A-Za-z0-9-]+)\]")
_PASSAGE = re.compile(r"<<<(P\d+)[^\n]*\n(.*?)\n>>>", re.S)
_SOURCE = re.compile(r"<<<(S\d+)\n(.*?)\n>>>", re.S)
_VARIATION = re.compile(r"^variation_type: (\S+)$", re.M)
_BULK = re.compile(r"^E2E-MOCK-BULK-(\d{3})$")
_CRASH = re.compile(r"^E2E-MOCK-CRASH-([0-9a-f]{16})$")
_HOLD = re.compile(r"^E2E-MOCK-HOLD-([0-9a-f]{16})$")


class MockExamSimulatedCrash(BaseException):
    """Test-only: a worker killed mid-job (a BaseException, so the job is left running)."""


def default_hold_dir() -> Path:
    return Path(tempfile.gettempdir()) / HOLD_DIR_NAME


def default_fault_dir() -> Path:
    return Path(tempfile.gettempdir()) / FAULT_DIR_NAME


def _fill(value: Any, n: str) -> Any:
    if isinstance(value, str):
        return value.replace("{n}", n)
    if isinstance(value, list):
        return [_fill(v, n) for v in value]
    if isinstance(value, dict):
        return {k: _fill(v, n) for k, v in value.items()}
    return value


class MockExamScenarioLLM:
    """`LLMClient` answering batched mock exam requests (see the module docstring)."""

    def __init__(
        self,
        block: Mapping[str, Any],
        *,
        hold_dir: Path | None = None,
        fault_dir: Path | None = None,
        max_output_tokens: int = 16_000,
        hold_timeout: float = HOLD_TIMEOUT_SECONDS,
    ) -> None:
        self._sources: dict[str, dict[str, Any]] = {
            str(s["marker"]): dict(s) for s in block.get("sources", {}).values()
        }
        self._templates: dict[str, dict[str, Any]] = dict(block.get("templates", {}))
        self._hold_dir = hold_dir or default_hold_dir()
        self._fault_dir = fault_dir or default_fault_dir()
        self._max_output_tokens = max_output_tokens
        self._hold_timeout = hold_timeout
        self._lock = threading.Lock()
        self._in_flight = 0
        self.max_in_flight = 0
        self.calls: list[tuple[tuple[str, ...], LLMRequest]] = []

    @classmethod
    def from_file(cls, path: Path, **kwargs: Any) -> MockExamScenarioLLM:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(data["mock_exam"], **kwargs)

    @property
    def model_name(self) -> str:
        return MODEL_NAME

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        markers = tuple(dict.fromkeys(_MARKER.findall(request.prompt)))
        with self._lock:
            self.calls.append((markers, request))
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            self._hold(markers)
            self._crash(markers)
            return self._answer(request, schema)
        finally:
            with self._lock:
                self._in_flight -= 1

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output

    # -- hooks ----------------------------------------------------------------------------------

    def _hold(self, markers: tuple[str, ...]) -> None:
        for marker in markers:
            found = _HOLD.match(marker)
            if found is None:
                continue
            token = found.group(1)
            self._hold_dir.mkdir(parents=True, exist_ok=True)
            (self._hold_dir / f"{token}.held").touch()
            release = self._hold_dir / f"{token}.release"
            deadline = time.monotonic() + self._hold_timeout
            while not release.exists() and time.monotonic() < deadline:
                time.sleep(0.1)

    def _crash(self, markers: tuple[str, ...]) -> None:
        for marker in markers:
            found = _CRASH.match(marker)
            if found is None:
                continue
            self._fault_dir.mkdir(parents=True, exist_ok=True)
            flag = self._fault_dir / f"{found.group(1)}.crashed"
            with self._lock:
                if flag.exists():
                    continue
                flag.touch()
            raise MockExamSimulatedCrash("simulated worker crash (test fault)")

    # -- answer ---------------------------------------------------------------------------------

    def _scripted(self, marker: str) -> dict[str, Any] | None:
        if marker in self._sources:
            return self._sources[marker]
        bulk = _BULK.match(marker)
        if bulk is not None and "bulk" in self._templates:
            filled: dict[str, Any] = _fill(self._templates["bulk"], bulk.group(1))
            return filled
        if _CRASH.match(marker) is not None and "crash" in self._templates:
            return dict(self._templates["crash"])
        return None

    def _answer[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        head, _, tail = request.prompt.partition("\nSOURCES:\n")
        passages = [(tag, text) for tag, text in _PASSAGE.findall(head)]
        blocks = _SOURCE.findall(tail)
        scripted: list[tuple[str, str, dict[str, Any]]] = []
        for tag, body in blocks:
            found = _VARIATION.search(body)
            source = next(
                (s for m in _MARKER.findall(body) if (s := self._scripted(m)) is not None), None
            )
            if source is None or found is None:
                continue
            scripted.append((tag, found.group(1), source))
        for _, _, source in scripted:
            fault = source.get("fault")
            if isinstance(fault, dict) and fault.get("kind") == "unavailable":
                raise LLMProviderError("provider unavailable (test fault)", kind="unavailable")
        items: list[dict[str, Any]] = []
        for tag, variation, source in scripted:
            item = source.get("items", {}).get(variation)
            if item is None:
                continue
            citations = []
            for c in item.get("citations", []):
                quote = str(c["quote"])
                ids = [t for t, text in passages if quote in text]
                citations.append({"passage_id": ids[0] if ids else "P1", "quote": quote})
            items.append(
                {**item, "source_tag": tag, "variation_type": variation, "citations": citations}
            )
        raw = json.dumps({"items": items}, ensure_ascii=False)
        stop = "end_turn"
        for _, _, source in scripted:
            fault = source.get("fault")
            if not isinstance(fault, dict) or len(blocks) <= int(fault.get("sources_over", 0)):
                continue
            if fault.get("kind") == "malformed":
                raw = raw[: max(1, len(raw) // 2)]
                if raw.count('"') % 2 == 0:
                    raw = raw[:-1]
            elif fault.get("kind") == "truncated":
                cut = raw.rfind('{"', 0, max(2, len(raw) * 2 // 3))
                raw = raw[: max(1, cut + 20)]
                stop = "max_tokens"
        prompt_bytes = len(request.prompt.encode()) + len((request.system or "").encode())
        info = LLMCallInfo(
            task=request.task,
            prompt_version=request.prompt_version,
            model=MODEL_NAME,
            request_fingerprint=request.fingerprint(),
            usage=LLMUsage(
                input_tokens=-(-prompt_bytes // 4),
                output_tokens=self._max_output_tokens
                if stop == "max_tokens"
                else -(-len(raw.encode()) // 4),
            ),
            stop_reason=stop,
        )
        try:
            output = parse_structured_output(raw, schema)
        except LLMOutputError as exc:
            exc.call_info = info
            raise
        return LLMResult(output=output, info=info)
