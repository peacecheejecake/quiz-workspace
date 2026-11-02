"""`ask.answer` without a database (ASK-01-C05/C09/C11): in-memory store and stream, the
deterministic fake answerer. The Postgres paths are covered by tests/integration/ask."""

from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from book_core.ask import AskCallMeta, AskRequest, FakeAskAnswerer
from book_core.llm import LLMProviderError, LLMUsage, TextDelta, TextStreamEnd, TextStreamEvent
from quiz_worker import serve
from quiz_worker.ask_job import AskAnswerPayloadV1, AskJobDeps, run_ask_answer
from quiz_worker.ask_store import (
    AnswerRow,
    Finished,
    FinishOutcome,
    LiveDocument,
    PinnedSource,
    Usage,
)
from quiz_worker.celery_app import INTERACTIVE_QUEUE, build_celery_config, queue_for, task_name
from quiz_worker.runner import JobContext
from quiz_worker.settings import WorkerSettings
from quiz_worker.store import InMemoryJobStore

WS = uuid.uuid4()
DOC = uuid.uuid4()
REV = uuid.uuid4()
JOB = uuid.uuid4()


@dataclass
class FakeStore:
    answer: AnswerRow
    status_value: str = "queued"
    member: bool = True
    revision: uuid.UUID = REV
    finished: list[Finished] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    usage: list[tuple[Usage | None, str]] = field(default_factory=list)
    stop_after_status_reads: int | None = None
    reads: int = 0

    def load_answer(self, _message_id: uuid.UUID) -> AnswerRow:
        return replace(self.answer, status=self.status_value)

    def status(self, _message_id: uuid.UUID) -> str:
        self.reads += 1
        if self.stop_after_status_reads is not None and self.reads > self.stop_after_status_reads:
            self.status_value = "stopped"
        return self.status_value

    def mark(self, _message_id: uuid.UUID, status: str) -> bool:
        if self.status_value not in ("queued", "retrieving", "streaming"):
            return False
        self.status_value = status
        return True

    def member_active(self, *_args: Any) -> bool:
        return self.member

    def sources(self, _message_id: uuid.UUID) -> list[PinnedSource]:
        return [PinnedSource(1, DOC, REV, None, ["b1"], 2, 2)]

    def documents(self, _ws: uuid.UUID, _ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, LiveDocument]:
        return {DOC: LiveDocument(DOC, "책", "book", self.revision)}

    def chapter_titles(self, _ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]:
        return {}

    def block_texts(self, _revision: uuid.UUID, _ids: Sequence[str]) -> list[str]:
        return ["가나다 원리는 합성 개념이다. 둘째 문장."]

    def page_texts(self, _revision: uuid.UUID, _pages: Sequence[int]) -> list[str]:
        return []

    def question_text(self, _id: uuid.UUID) -> str:
        return self.answer_question

    def history(self, _answer: AnswerRow) -> list[tuple[str, str]]:
        return []

    def finish(
        self, _answer: AnswerRow, result: Finished, _pinned: Sequence[PinnedSource]
    ) -> FinishOutcome:
        if self.status_value not in ("queued", "retrieving", "streaming"):
            return FinishOutcome(False)
        self.finished.append(result)
        self.status_value = result.status
        return FinishOutcome(True)

    def fail(self, _answer: AnswerRow, code: str, usage: Usage | None = None) -> bool:
        self.failed.append(code)
        self.usage.append((usage, "failed"))
        self.status_value = "failed"
        return True

    def record_usage(self, _answer: AnswerRow, usage: Usage | None, status: str) -> None:
        self.usage.append((usage, status))

    answer_question: str = "가나다 원리를 설명해 줘"


class MemoryStream:
    def __init__(self) -> None:
        self.events: list[tuple[str, int, dict[str, Any]]] = []

    def append(self, _message_id: uuid.UUID, event: str, seq: int, data: Mapping[str, Any]) -> None:
        self.events.append((event, seq, dict(data)))

    def last_seq(self, _message_id: uuid.UUID) -> int:
        return self.events[-1][1] if self.events else 0


def _answer(**changes: Any) -> AnswerRow:
    base = AnswerRow(
        id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        workspace_id=WS,
        user_id=uuid.uuid4(),
        status="queued",
        question_message_id=uuid.uuid4(),
        retry_of_message_id=None,
        disclosure="none",
        attachment_kind=None,
        question_id=None,
        question_revision_id=None,
        mock_exam_question_id=None,
        mock_exam_question_revision_id=None,
        selected_option_ids=[],
        displayed_option_ids=[],
        submitted_answer=None,
        attempt_result=None,
        context_char_limit=16000,
        job_id=JOB,
    )
    return replace(base, **changes)


def _run(store: FakeStore, llm: Any, stream: MemoryStream | None = None, retries: int = 2) -> Any:
    deps = AskJobDeps(
        store=store,  # type: ignore[arg-type]
        stream=stream or MemoryStream(),
        llm=llm,
        llm_max_retries=retries,
        sleep=lambda _s: None,
    )
    ctx = JobContext(
        job_id=JOB,
        job_type="ask.answer",
        workspace_id=WS,
        created_by=store.answer.user_id,
        idempotency_key=None,
        schema_version=1,
        attempt=1,
        max_attempts=2,
        _store=InMemoryJobStore(),
    )
    return run_ask_answer(deps, ctx, AskAnswerPayloadV1(message_id=store.answer.id))


@pytest.fixture
def fake(tmp_path: Path) -> FakeAskAnswerer:
    return FakeAskAnswerer(log_dir=tmp_path, hold_dir=tmp_path, sleep=lambda _s: None)


def test_ask_01_c05_streams_contiguous_deltas_then_done_and_stores_validated_text(
    fake: FakeAskAnswerer,
) -> None:
    store, stream = FakeStore(_answer()), MemoryStream()
    result = _run(store, fake, stream)
    assert result["status"] == "succeeded"
    assert [e[1] for e in stream.events] == list(range(1, len(stream.events) + 1))
    assert stream.events[-1][0] == "done"
    assert all(e[2]["seq"] == e[1] for e in stream.events if e[0] == "delta")
    [finished] = store.finished
    assert "[1]" in finished.text
    assert "[S1]" not in finished.text
    assert finished.cited == [(1, 1)]
    assert set(result) <= {
        "status",
        "sources",
        "dropped_citations",
        "llm_calls",
        "usage",
        "error_code",
    }


def test_ask_01_c09_retries_only_before_the_first_delta(fake: FakeAskAnswerer) -> None:
    store = FakeStore(_answer())
    store.answer_question = "E2E-ASK-FAIL 질문"
    result = _run(store, fake, retries=2)
    assert len(fake.calls) == 3
    assert store.failed == ["llm_unavailable"]
    assert result["llm_calls"] == 3

    class BreaksAfterDelta:
        model_name = "x"
        calls = 0

        def stream(self, _request: AskRequest, _meta: AskCallMeta) -> Iterator[TextStreamEvent]:
            self.calls += 1
            yield TextDelta("가" * 30)
            raise LLMProviderError("down", kind="connection")

    broken = BreaksAfterDelta()
    store = FakeStore(_answer())
    _run(store, broken, retries=2)
    assert broken.calls == 1
    assert store.failed == ["llm_unavailable"]


def test_ask_01_c09_finished_stopped_and_moved_answers(fake: FakeAskAnswerer) -> None:
    done = FakeStore(_answer(), status_value="succeeded")
    assert _run(done, fake)["status"] == "skipped"
    assert not fake.calls
    crashed = FakeStore(_answer(), status_value="streaming")
    _run(crashed, fake)
    assert crashed.failed == ["ask_failed"]
    gone = FakeStore(_answer(), member=False)
    _run(gone, fake)
    assert gone.failed == ["workspace_unavailable"]
    moved = FakeStore(_answer(), revision=uuid.uuid4())
    _run(moved, fake)
    assert moved.failed == ["sources_unavailable"]
    assert not fake.calls


def test_ask_01_c05_a_stop_closes_the_provider_stream(tmp_path: Path) -> None:
    slow = FakeAskAnswerer(log_dir=tmp_path, hold_dir=tmp_path, sleep=lambda _s: None)
    store = FakeStore(_answer(), stop_after_status_reads=4)
    store.answer_question = "E2E-ASK-SLOW 질문"
    stream = MemoryStream()
    result = _run(store, slow, stream)
    assert result["status"] == "stopped"
    assert not store.finished
    deltas = [e for e in stream.events if e[0] == "delta"]
    assert 0 < len(deltas) < 40


def test_no_answer_and_truncation(fake: FakeAskAnswerer) -> None:
    store = FakeStore(_answer())
    store.answer_question = "E2E-ASK-NOANSWER 질문"
    _run(store, fake)
    assert store.finished[0].status == "no_sources"

    class Truncating:
        model_name = "x"

        def stream(self, _request: AskRequest, _meta: AskCallMeta) -> Iterator[TextStreamEvent]:
            yield TextDelta("답 [S1]")
            yield TextStreamEnd("x", "max_tokens", LLMUsage(input_tokens=5, output_tokens=7))

    store = FakeStore(_answer())
    _run(store, Truncating())
    [finished] = store.finished
    assert finished.truncated
    assert finished.text.endswith("(답이 길어 잘렸습니다)")
    assert finished.usage is not None
    assert (finished.usage.input_tokens, finished.usage.llm_calls) == (5, 1)


def test_interactive_queue_routing_and_process() -> None:
    assert queue_for("ask.answer") == INTERACTIVE_QUEUE
    assert queue_for("document.parse") == "quiz.jobs"
    config = build_celery_config(WorkerSettings(_env_file=None, WORKER_TASK_ALWAYS_EAGER=True))  # type: ignore[call-arg]
    assert config["task_routes"] == {task_name("ask.answer"): {"queue": INTERACTIVE_QUEUE}}
    assert "ask-purge" in config["beat_schedule"]
    argv = serve.build_worker_argv(2, "info", beat=False, queue=INTERACTIVE_QUEUE)
    assert "--queues=interactive" in argv
    assert "--beat" not in argv
