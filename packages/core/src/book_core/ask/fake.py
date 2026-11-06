"""Answerers: the provider adapter and the deterministic APP_ENV=test fake (ASK-01-C11).

``AskAnswerer.stream(request, meta)`` yields ``TextDelta``s then one ``TextStreamEnd``.
``ProviderAskAnswerer`` sends ``request.to_text_request()`` to a ``TextStreamClient``.

``FakeAskAnswerer`` (tests/e2e/fixtures/ask.ts Q7/Q8) streams, for a normal question, the first
sentence of each of the top two passages as ``<sentence> [S1]`` / ``<sentence> [S2]`` and a last
line ``이전 턴 <n>개`` in at least three deltas ~150 ms apart. Markers in the user's question:

- ``E2E-ASK-FAIL``: a provider error on every call of an answer that is not a retry;
- ``E2E-ASK-SLOW``: 40 deltas 500 ms apart;
- ``E2E-ASK-BADCITE``: a valid ``[S1]`` and an unknown ``[S9]``;
- ``E2E-ASK-NOANSWER``: the answer starts with ``[NO_ANSWER]``;
- ``E2E-ASK-UNCITED``: an answer without any footnote;
- ``E2E-ASK-MARKDOWN``: ``MARKDOWN_ANSWER``, every Markdown syntax of UX12-ASKMD with ``[S1]``
  (with ``E2E-ASK-SLOW``: in 40 deltas);
- ``E2E-ASK-LEAK-PROBE``: echoes the attached question's DTO, one ``<field>: <value>`` line per
  field (``attachment: none`` without one), then the turn count;
- ``E2E-ASK-HOLD-<token>``: before the first delta, creates ``<hold dir>/<token>.held`` and waits
  (at most 120 s) for ``<token>.release``.

Every call appends one JSON line to ``<log dir>/ask-<message id>.jsonl`` with counts, settings and
field names only (no question, passage or answer text) and is kept in ``calls`` as
``(markers, request)``. The markers mean nothing outside APP_ENV=test (the worker builds this fake
only there).
"""

from __future__ import annotations

import dataclasses
import json
import re
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from book_core.ask.prompts import NO_ANSWER_MARK, AskRequest
from book_core.llm.base import LLMProviderError, LLMUsage
from book_core.llm.streaming import (
    TextDelta,
    TextStreamClient,
    TextStreamEnd,
    TextStreamEvent,
    estimate_tokens,
)

MARKER_FAIL = "E2E-ASK-FAIL"
MARKER_SLOW = "E2E-ASK-SLOW"
MARKER_BADCITE = "E2E-ASK-BADCITE"
MARKER_NOANSWER = "E2E-ASK-NOANSWER"
MARKER_LEAK_PROBE = "E2E-ASK-LEAK-PROBE"
MARKER_UNCITED = "E2E-ASK-UNCITED"
MARKER_MARKDOWN = "E2E-ASK-MARKDOWN"
MARKER_HOLD = "E2E-ASK-HOLD"
_SIMPLE_MARKERS = (
    MARKER_FAIL,
    MARKER_SLOW,
    MARKER_BADCITE,
    MARKER_NOANSWER,
    MARKER_LEAK_PROBE,
    MARKER_UNCITED,
    MARKER_MARKDOWN,
)
_HOLD = re.compile(re.escape(MARKER_HOLD) + r"-([A-Za-z0-9_-]{1,64})")
_SENTENCE_END = re.compile(r"(?<=[.!?。])\s+|\n+")
FAKE_MODEL = "fake-ask"
HOLD_TIMEOUT_SECONDS = 120.0
DEFAULT_LOG_DIR = Path(tempfile.gettempdir()) / "quiz-e2e-ask-fake-log"
DEFAULT_HOLD_DIR = Path(tempfile.gettempdir()) / "quiz-e2e-ask-hold"
MARKDOWN_ANSWER = """## 핵심 정리

**굵게**, *기울임*, ~~취소선~~, `인라인 코드`를 씁니다 [S1]

| 왼쪽 구분 | 가운데 설명 | 오른쪽 수치 |
| :--- | :---: | ---: |
| 물의순환을설명하는아주긴칸 | 증발과응결을설명하는아주긴칸 [S1] | 1234567890123456789 |
| 정수처리를설명하는아주긴칸 | 침전과여과를설명하는아주긴칸 | 42 |

### 세부 단계

- 첫 항목 [S1]
  - 중첩 항목
- [x] 끝낸 일
- [ ] 남은 일

1. 순서 하나
2. 순서 둘

> 인용 문장 [S1]

```python
print("코드 블록은 그대로입니다")
```

---

[참고 링크](https://example.com/guide)

<script>alert(1)</script>

![그림](https://example.com/a.png)

[위험한 링크](javascript:alert(1))"""


@dataclass(frozen=True, slots=True)
class AskCallMeta:
    """Who is being answered: the answer message id (the record's file name) and whether it is
    a user's `다시 시도` of a failed answer."""

    message_id: str
    retry: bool = False


@runtime_checkable
class AskAnswerer(Protocol):
    @property
    def model_name(self) -> str: ...

    def stream(self, request: AskRequest, meta: AskCallMeta) -> Iterator[TextStreamEvent]: ...


class ProviderAskAnswerer:
    def __init__(self, client: TextStreamClient) -> None:
        self._client = client

    @property
    def model_name(self) -> str:
        return self._client.model_name

    def stream(self, request: AskRequest, meta: AskCallMeta) -> Iterator[TextStreamEvent]:
        return self._client.stream_text(request.to_text_request())


def markers_of(question: str) -> tuple[str, ...]:
    found = [m for m in _SIMPLE_MARKERS if m in question]
    if _HOLD.search(question):
        found.append(MARKER_HOLD)
    return tuple(found)


def first_sentence(text: str) -> str:
    for part in _SENTENCE_END.split(text.strip()):
        if part.strip():
            return part.strip()
    return text.strip()


def _value(value: object) -> str:
    if isinstance(value, tuple):
        return " | ".join(_value(v) for v in value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        number = getattr(value, "number", None)
        text = getattr(value, "text", None)
        if number is not None and text is not None:
            return f"{number}. {text}"
    return "" if value is None else str(value)


def _probe(request: AskRequest) -> list[str]:
    attachment = request.attachment
    if attachment is None:
        return ["attachment: none"]
    return [
        f"{f.name}: {_value(getattr(attachment, f.name))}" for f in dataclasses.fields(attachment)
    ]


class FakeAskAnswerer:
    def __init__(
        self,
        *,
        log_dir: Path | None = None,
        hold_dir: Path | None = None,
        delay_seconds: float = 0.15,
        slow_delay_seconds: float = 0.5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._log_dir = log_dir or DEFAULT_LOG_DIR
        self._hold_dir = hold_dir or DEFAULT_HOLD_DIR
        self._delay = delay_seconds
        self._slow_delay = slow_delay_seconds
        self._sleep = sleep
        self._lock = threading.Lock()
        self.calls: list[tuple[tuple[str, ...], AskRequest]] = []

    @property
    def model_name(self) -> str:
        return FAKE_MODEL

    def stream(self, request: AskRequest, meta: AskCallMeta) -> Iterator[TextStreamEvent]:
        markers = markers_of(request.question)
        with self._lock:
            self.calls.append((markers, request))
        return self._stream(request, meta, markers)

    def answer_text(self, request: AskRequest, markers: tuple[str, ...]) -> str:
        turns = f"이전 턴 {len(request.history)}개"
        sentences = [first_sentence(s.text) for s in request.sources[:2]]
        if MARKER_NOANSWER in markers:
            return f"{NO_ANSWER_MARK} 근거 구절로는 이 질문에 답할 수 없습니다."
        if MARKER_LEAK_PROBE in markers:
            return "\n".join([*_probe(request), turns])
        if MARKER_MARKDOWN in markers:
            return MARKDOWN_ANSWER
        if MARKER_BADCITE in markers:
            lead = f"{sentences[0]} [S1]" if sentences else "근거 없는 설명"
            return f"{lead}\n\n근거에 없는 내용입니다 [S9]\n\n{turns}"
        if MARKER_UNCITED in markers:
            lead = sentences[0] if sentences else "근거 없는 설명"
            return f"{lead}\n\n{turns}"
        body = [f"{s} [S{n}]" for n, s in enumerate(sentences, start=1)]
        if not body:
            body = ["문서에서 근거를 찾지 못해 첨부한 문제 내용으로만 설명합니다."]
        if MARKER_SLOW in markers:
            body += [f"자세히 풀어 쓴 설명 {n}." for n in range(1, 21)]
        return "\n\n".join([*body, turns])

    def _stream(
        self, request: AskRequest, meta: AskCallMeta, markers: tuple[str, ...]
    ) -> Iterator[TextStreamEvent]:
        sent = 0
        try:
            if MARKER_FAIL in markers and not meta.retry:
                raise LLMProviderError("fake provider unavailable", kind="connection")
            hold = _HOLD.search(request.question)
            if hold is not None:
                self._hold(hold.group(1))
            text = self.answer_text(request, markers)
            slow = MARKER_SLOW in markers
            for chunk in _chunks(text, 40 if slow else 4):
                if sent:
                    self._sleep(self._slow_delay if slow else self._delay)
                sent += 1
                yield TextDelta(chunk)
            yield TextStreamEnd(
                model=FAKE_MODEL,
                stop_reason="end_turn",
                usage=LLMUsage(
                    input_tokens=estimate_tokens(
                        request.system
                        + request.prompt
                        + "".join(t.question + t.answer for t in request.history)
                    ),
                    output_tokens=estimate_tokens(text),
                ),
            )
        finally:
            self._record(request, meta, markers, sent)

    def _hold(self, token: str) -> None:
        self._hold_dir.mkdir(parents=True, exist_ok=True)
        (self._hold_dir / f"{token}.held").write_text("")
        release = self._hold_dir / f"{token}.release"
        deadline = time.monotonic() + HOLD_TIMEOUT_SECONDS
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.1)

    def _record(
        self, request: AskRequest, meta: AskCallMeta, markers: tuple[str, ...], sent: int
    ) -> None:
        record = {
            "message_id": meta.message_id,
            "markers": list(markers),
            "history_turns": len(request.history),
            "source_tags": list(request.source_tags),
            "context_chars": request.context_chars,
            "max_output_tokens": request.max_output_tokens,
            "effort": request.effort,
            "disclosure": request.disclosure,
            "attachment_fields": list(request.attachment_fields),
            "deltas_sent": sent,
        }
        try:
            self._log_dir.mkdir(parents=True, exist_ok=True)
            with (self._log_dir / f"ask-{meta.message_id}.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass


def _chunks(text: str, count: int) -> list[str]:
    size = max(1, -(-len(text) // count))
    return [text[i : i + size] for i in range(0, len(text), size)]
