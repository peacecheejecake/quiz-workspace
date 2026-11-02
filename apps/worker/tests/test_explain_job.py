"""`question.ai_explain` without a database (AIEXPL-01-C04/C05/C06/C08): in-memory store and
stream, the deterministic fake explainer. The Postgres paths are covered by
tests/integration/questions/ai_explanations."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from book_core.explain import (
    ExplainCallMeta,
    ExplainQuestion,
    ExplainRequest,
    FakeExplainer,
    explain_question,
)
from book_core.llm import LLMProviderError, TextStreamEvent
from quiz_worker.ask_store import LiveDocument, Usage
from quiz_worker.explain_job import ExplainJobDeps, ExplainPayloadV1, run_explain
from quiz_worker.explain_store import ExplanationRow, FinishOutcome, PinnedPassage
from quiz_worker.runner import JobContext
from quiz_worker.store import InMemoryJobStore

WS, DOC, REV, JOB, TARGET, QREV = (uuid.uuid4() for _ in range(6))
USER = uuid.uuid4()
QUESTION_SECRET = "E2E-QUESTION-PART-SECRET"  # noqa: S105 - a marker string
BLOCKS = {"b1": "햇빛이 바다를 데운다. 둘째 문장.", "q1": f"1. 문제 {QUESTION_SECRET}"}
OPTIONS = [{"id": f"opt-{i}", "text": t} for i, t in enumerate(["증발", "응결", "강수"], 1)]


class Readers:
    def __init__(self, content_kind: str | None) -> None:
        self.content_kind = content_kind

    def chapter_titles(self, _ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]:
        return {}

    def block_texts(
        self, _rev: uuid.UUID, ids: Sequence[str], exclude: frozenset[str] = frozenset()
    ) -> list[str]:
        return [BLOCKS[i] for i in ids if i in BLOCKS and i not in exclude]

    def page_texts(
        self, _rev: uuid.UUID, _pages: Sequence[int], exclude: frozenset[str] = frozenset()
    ) -> list[str]:
        return []

    def question_part_block_ids(self, _rev: uuid.UUID) -> frozenset[str]:
        return frozenset({"q1"})


@dataclass
class FakeStore:
    stem: str = "물이 수증기가 되는 과정은?"
    status_value: str = "queued"
    member: bool = True
    blocks: list[str] = field(default_factory=lambda: ["b1"])
    content_kind: str | None = "book"
    finished: list[dict[str, Any]] = field(default_factory=list)
    failed: list[tuple[str, Usage | None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.passages = Readers(self.content_kind)

    def row(self) -> ExplanationRow:
        return ExplanationRow(
            id=uuid.UUID(int=7),
            kind="question",
            workspace_id=WS,
            target_id=TARGET,
            revision_id=QREV,
            status=self.status_value,
            version=1,
            job_id=JOB,
            created_by=USER,
            prompt_version="question.ai_explain/v1",
            model="fake-ai-explanation",
            sources=[PinnedPassage(1, DOC, REV, None, self.blocks, 2, 2, {"tag": 1})],
        )

    def load(self, _kind: str, _id: uuid.UUID) -> ExplanationRow:
        return self.row()

    def start(self, _row: ExplanationRow) -> bool:
        if self.status_value not in ("queued", "running"):
            return False
        self.status_value = "running"
        return True

    def member_active(self, _row: ExplanationRow) -> bool:
        return self.member

    def question(self, _row: ExplanationRow) -> ExplainQuestion:
        return explain_question(
            kind="question",
            question_type="MCQ",
            stem=self.stem,
            options=OPTIONS,
            correct_option_ids=["opt-1"],
            accepted_answers=None,
            rubric=None,
            explanation="사람 해설",
        )

    def documents(self, _ws: uuid.UUID, _ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, LiveDocument]:
        return {DOC: LiveDocument(DOC, "책", "book", REV, self.content_kind)}

    def finish(self, _row: ExplanationRow, **kwargs: Any) -> FinishOutcome:
        if self.status_value != "running":
            return FinishOutcome(False)
        self.finished.append(kwargs)
        self.status_value = "succeeded"
        return FinishOutcome(True)

    def fail(self, _row: ExplanationRow, code: str, usage: Usage | None = None) -> bool:
        self.failed.append((code, usage))
        self.status_value = "failed"
        return True


@dataclass
class MemoryStream:
    events: list[tuple[str, int, dict[str, Any]]] = field(default_factory=list)

    def append(self, _id: uuid.UUID, event: str, seq: int, data: Mapping[str, Any]) -> None:
        self.events.append((event, seq, dict(data)))

    def last_seq(self, _id: uuid.UUID) -> int:
        return self.events[-1][1] if self.events else 0


@pytest.fixture
def fake(tmp_path: Path) -> FakeExplainer:
    return FakeExplainer(log_dir=tmp_path, hold_dir=tmp_path, delay_seconds=0)


def _run(store: FakeStore, llm: Any, stream: MemoryStream | None = None) -> dict[str, Any]:
    deps = ExplainJobDeps(store=store, stream=stream or MemoryStream(), llm=llm)  # type: ignore[arg-type]
    ctx = JobContext(
        job_id=JOB,
        job_type="question.ai_explain",
        workspace_id=WS,
        created_by=USER,
        idempotency_key=None,
        schema_version=1,
        attempt=1,
        max_attempts=2,
        _store=InMemoryJobStore(),
    )
    payload = ExplainPayloadV1(kind="question", explanation_id=uuid.UUID(int=7), target_id=TARGET)
    result = run_explain(deps, ctx, payload)
    assert result is not None
    return dict(result)


def test_aiexpl_01_c05_deltas_count_from_zero_then_done(fake: FakeExplainer) -> None:
    store, stream = FakeStore(), MemoryStream()
    result = _run(store, fake, stream)
    assert result["status"] == "succeeded"
    deltas = [d for e, _s, d in stream.events if e == "delta"]
    assert [d["seq"] for d in deltas] == list(range(len(deltas)))
    assert len(deltas) >= 2
    assert stream.events[-1][0] == "done"
    assert [s for _e, s, _d in stream.events] == list(range(1, len(stream.events) + 1))
    text = "".join(d["text"] for d in deltas)
    assert "**정답과 이유**" in text
    assert "[[" not in text
    [done] = store.finished
    assert done["cited"] == [(1, 1)]
    assert done["body"]["summary_md"].endswith("[1]")
    usage = done["usage"]
    assert usage.llm_calls == 1
    assert usage.input_tokens > 0


def test_aiexpl_01_c04_a_mismatching_answer_is_never_streamed_or_stored(
    fake: FakeExplainer,
) -> None:
    store, stream = FakeStore(stem="x [E2E-EXPL-MISMATCH]"), MemoryStream()
    result = _run(store, fake, stream)
    assert result["status"] == "failed"
    assert result["error_code"] == "explanation_answer_mismatch"
    assert [e for e, _s, _d in stream.events] == ["error"]
    assert store.finished == []
    assert "E2E-EXPL-RAW-OUTPUT" not in json.dumps(result)


def test_aiexpl_01_c04_a_missing_option_is_requested_once_more_then_failed(
    fake: FakeExplainer,
) -> None:
    store, stream = FakeStore(stem="x [E2E-EXPL-MISSING-OPTION]"), MemoryStream()
    result = _run(store, fake, stream)
    assert result["error_code"] == "explanation_incomplete"
    assert result["llm_calls"] == 2
    assert len(fake.calls) == 2
    assert fake.calls[1][1].missing_option_ids == ("opt-3",)
    assert "reset" in [e for e, _s, _d in stream.events]
    [(_code, usage)] = store.failed
    assert usage is not None
    assert usage.llm_calls == 2


def test_aiexpl_01_c08_a_provider_error_fails_without_a_retry(fake: FakeExplainer) -> None:
    store = FakeStore(stem="x [E2E-EXPL-FAIL]")
    result = _run(store, fake)
    assert (result["status"], result["error_code"]) == ("failed", "llm_unavailable")
    assert len(fake.calls) == 1


def test_aiexpl_01_c02_the_worker_rechecks_membership_and_the_switch(fake: FakeExplainer) -> None:
    gone = FakeStore(member=False)
    assert _run(gone, fake)["error_code"] == "workspace_unavailable"
    off = FakeStore()
    assert _run(off, None)["error_code"] == "llm_unavailable"
    assert fake.calls == []
    finished = FakeStore(status_value="succeeded")
    assert _run(finished, fake)["status"] == "skipped"


def test_aiexpl_01_c04_a_mixed_books_question_part_never_reaches_the_model(
    fake: FakeExplainer,
) -> None:
    store = FakeStore(blocks=["b1", "q1"], content_kind="mixed")
    _run(store, fake)
    request: ExplainRequest = fake.calls[-1][1]
    assert QUESTION_SECRET not in request.prompt
    assert "햇빛이 바다를 데운다" in request.prompt


def test_aiexpl_01_c06_the_job_result_holds_counts_and_codes_only(fake: FakeExplainer) -> None:
    store = FakeStore()
    result = _run(store, fake)
    keys = {"status", "sources", "dropped_citations", "llm_calls", "usage", "error_code"}
    assert set(result) == keys
    assert store.stem not in json.dumps(result, ensure_ascii=False)


class Exploding:
    model_name = "x"

    def stream(self, _request: ExplainRequest, _meta: ExplainCallMeta) -> Iterator[TextStreamEvent]:
        raise LLMProviderError("timeout", kind="timeout")


def test_provider_timeouts_map_to_llm_timeout() -> None:
    store = FakeStore()
    assert _run(store, Exploding())["error_code"] == "llm_timeout"
    assert replace(store.row(), status="failed").terminal
