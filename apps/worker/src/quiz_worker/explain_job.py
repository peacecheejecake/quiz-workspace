"""`question.ai_explain` v1: one shared AI explanation of a question revision (EXPL-B, AIEXPL-01
"캐싱", C03-C09).

Payload (written by apps/api `POST …/ai-explanation`, `…/regenerate`, bank and mock):
`{kind, explanation_id, target_id}` — `kind` names the table (`question` |
`mock_exam_question`), `target_id` the explained question. The job runs on the Celery queue
`interactive` (like `ask.answer`).

1. Load the row. Nothing happens for a finished (or deleted) one; a redelivery calls nothing.
2. Re-check: the creator is still a member of the active workspace (`workspace_unavailable`), the
   question is still there (`question_unavailable`), every pinned passage revision is still its
   document's published one (`sources_unavailable`).
3. Read the keyed revision (stem, options, the answer, rubric; never a user's answer or the human
   explanation) and the pinned passages from Postgres (never copied from the API); a `mixed`
   book's question-part blocks stay out (the API's retrieval rule, re-checked).
4. Stream the explanation (`book_core.explain.build_request`) through `ExplanationStream`: whole
   display lines go to the Redis Stream `explain:<id>` as they complete; for a multiple-choice
   question nothing is published before the answer line matched the server's correct option ids
   (else `explanation_answer_mismatch`, nothing shown or stored). No provider retry: a failed
   call fails the explanation (`다시 시도` makes a new one).
5. Validate (`finish_explanation`): every option exactly once, else one re-request (a `reset`
   on the stream) and then `explanation_incomplete`; citations renumbered by the ASK rules. Write
   the body, the cited sources and one usage row after the same re-checks under row locks
   (`PostgresExplainStore.finish`), then `done`.

Cancelling (UX12-EXPLCANCEL): the API finishes the row. The loop reads its status at most every
`stop_check_seconds` and before every provider call, closes the provider stream, records what the
run spent (`stopped`) and stops; a cancel that wins the race with the finish write ends the same
way. A closed stream has no `TextStreamEnd`, so the interrupted call counts the input the provider
reported at its start and an estimate of the rest (`_Tokens.interrupted`): the monthly cap has to
see a paid call. Nothing more is written to the Redis Stream: the stream routes see the row's
status.

The job result holds counts, usage and codes only (C06); logs carry ids and counts only.

LLM: APP_ENV=test the deterministic `book_core.explain.FakeExplainer` (markers, call log in
`WORKER_ASK_FAKE_LOG_DIR/ai_explanation`, hold barriers in `WORKER_ASK_HOLD_DIR`); elsewhere the
configured provider's streaming client, only with `WORKER_AI_EXPLANATIONS` on and `LLM_API_KEY`.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from math import ceil
from pathlib import Path
from typing import Any, Literal, cast

from book_core.ask import AskSource
from book_core.explain import (
    INCOMPLETE,
    AnswerMismatchError,
    ExplainCallMeta,
    Explainer,
    ExplanationStream,
    FakeExplainer,
    ProviderExplainer,
    build_request,
    finish_explanation,
)
from book_core.explain.output import ANSWER_MISMATCH
from book_core.llm import (
    LLMProviderError,
    LLMUsage,
    TextDelta,
    TextStreamEnd,
    TextStreamEvent,
    TextStreamUsage,
)
from book_core.llm.config import Effort
from pydantic import BaseModel, ConfigDict

from quiz_worker.adapters import WorkerNotConfiguredError, route_effort_or_default
from quiz_worker.ask_job import error_code_of
from quiz_worker.ask_store import AskStreamWriter, NullStreamWriter, StreamWriter, Usage
from quiz_worker.explain_store import (
    JOB_TYPE,
    STREAM_KEY_PREFIX,
    ExplanationRow,
    PinnedPassage,
    PostgresExplainStore,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

MIXED = "mixed"
PASSAGE_CHARS = 2000
EFFORT: Effort = "low"
# One re-request when an option is missing (C04); the provider call itself is not retried.
MAX_CALLS = 2
# Estimating an interrupted call: Korean text runs near two characters per token, so this errs high.
CHARS_PER_TOKEN = 2


class ExplainPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["question", "mock_exam_question"]
    explanation_id: uuid.UUID
    target_id: uuid.UUID


@dataclass
class ExplainJobDeps:
    store: PostgresExplainStore
    stream: StreamWriter
    llm: Explainer | None
    enabled: bool = True
    max_output_tokens: int = 1500
    effort: Effort = EFFORT
    stop_check_seconds: float = 1.0


class _CancelledError(Exception):
    """The row stopped being live while the provider was streaming."""


class _Stream:
    """The explanation's Redis Stream: events with a global `seq` (the SSE id), deltas carrying
    their own index from 0 (again from 0 after a `reset`)."""

    def __init__(self, deps: ExplainJobDeps, explanation_id: uuid.UUID) -> None:
        self._deps = deps
        self._id = explanation_id
        try:
            self.seq = deps.stream.last_seq(explanation_id)
        except Exception as exc:  # Redis down: the explanation is still stored; clients poll
            logger.warning("explain: stream read failed (%s)", type(exc).__name__)
            self.seq = 0
        self.deltas = 0
        if self.seq:
            self.reset()  # an earlier attempt wrote here: clients drop what they received

    def _event(self, event: str, data: dict[str, Any]) -> None:
        self.seq += 1
        try:
            self._deps.stream.append(self._id, event, self.seq, data)
        except Exception as exc:  # clients fall back to polling
            logger.warning("explain: stream write failed (%s)", type(exc).__name__)

    def delta(self, text: str) -> None:
        if not text:
            return
        self._event("delta", {"seq": self.deltas, "text": text})
        self.deltas += 1

    def reset(self) -> None:
        self._event("reset", {})
        self.deltas = 0

    def done(self) -> None:
        self._event("done", {})

    def error(self, code: str) -> None:
        self._event("error", {"code": code})


def _result(
    status: str,
    *,
    usage: Usage | None = None,
    sources: int = 0,
    dropped: int = 0,
    code: str | None = None,
) -> JobResult:
    out: dict[str, Any] = {
        "status": status,
        "sources": sources,
        "dropped_citations": dropped,
        "llm_calls": usage.llm_calls if usage else 0,
        "usage": {
            "input_tokens": usage.input_tokens if usage else 0,
            "output_tokens": usage.output_tokens if usage else 0,
            "cache_read_tokens": usage.cache_read_tokens if usage else 0,
        },
        "error_code": code,
    }
    return out


def _passages(store: PostgresExplainStore, row: ExplanationRow) -> list[AskSource] | None:
    """The pinned passages from Postgres; None when a revision is no longer the published one."""
    readers = store.passages
    pinned: list[PinnedPassage] = row.sources
    docs = store.documents(row.workspace_id, list({s.document_id for s in pinned}))
    chapters = readers.chapter_titles([s.chapter_id for s in pinned if s.chapter_id])
    excluded: dict[uuid.UUID, frozenset[str]] = {}
    out: list[AskSource] = []
    for source in pinned:
        doc = docs.get(source.document_id)
        if doc is None or doc.active_revision_id != source.revision_id:
            return None
        if doc.document_type != "book":
            continue  # never a question paper (the API pins books only; re-checked)
        if doc.content_kind == MIXED and source.revision_id not in excluded:
            excluded[source.revision_id] = readers.question_part_block_ids(source.revision_id)
        skip = excluded.get(source.revision_id, frozenset())
        texts = readers.block_texts(source.revision_id, source.block_ids, skip)
        if not texts and not source.block_ids:
            pages = list(range(source.page_from, min(source.page_to, source.page_from + 20) + 1))
            texts = readers.page_texts(source.revision_id, pages, skip)
        body = "\n\n".join(texts)[:PASSAGE_CHARS]
        if not body.strip():
            continue
        out.append(
            AskSource(
                tag=f"S{source.tag}",
                document_title=doc.title,
                chapter_title=chapters.get(source.chapter_id) if source.chapter_id else None,
                page_from=source.page_from,
                page_to=source.page_to,
                text=body,
            )
        )
    return out


class _Tokens:
    def __init__(self, model: str) -> None:
        self.model = model
        self.calls = 0
        self.input = self.output = self.cache_read = self.cache_creation = 0
        self.cost: float | None = None
        self._prompt_chars = 0
        self._reported: LLMUsage | None = None
        self._received_chars = 0

    def begin(self, prompt_chars: int) -> None:
        self.calls += 1
        self._prompt_chars = prompt_chars
        self._reported = None
        self._received_chars = 0

    def reported(self, usage: LLMUsage) -> None:
        self._reported = usage

    def received(self, text: str) -> None:
        self._received_chars += len(text)

    def interrupted(self) -> None:
        """The call being read was closed before its `TextStreamEnd`: what the provider reported,
        an estimate from the characters for the rest. Text the model made but nobody read is not
        in it, nor is the cost, which only the provider's final count gives."""
        known = self._reported or LLMUsage()
        self.input += known.input_tokens or ceil(self._prompt_chars / CHARS_PER_TOKEN)
        self.cache_read += known.cache_read_input_tokens
        self.cache_creation += known.cache_creation_input_tokens
        self.output += max(known.output_tokens, ceil(self._received_chars / CHARS_PER_TOKEN))

    def add(self, end: TextStreamEnd) -> None:
        self.input += end.usage.input_tokens
        self.output += end.usage.output_tokens
        self.cache_read += end.usage.cache_read_input_tokens
        self.cache_creation += end.usage.cache_creation_input_tokens
        if end.usage.cost_usd is not None:
            self.cost = (self.cost or 0.0) + end.usage.cost_usd
        self.model = end.model or self.model

    def usage(self) -> Usage:
        return Usage(
            model=self.model,
            input_tokens=self.input,
            output_tokens=self.output,
            cache_read_tokens=self.cache_read,
            cache_creation_tokens=self.cache_creation,
            llm_calls=self.calls,
            cost_usd=self.cost,
        )


def _close(events: Iterator[TextStreamEvent] | None) -> None:
    close = getattr(events, "close", None)
    if callable(close):
        close()


def run_explain(deps: ExplainJobDeps, ctx: JobContext, payload: ExplainPayloadV1) -> JobResult:
    store = deps.store
    row = store.load(payload.kind, payload.explanation_id)
    if (
        row is None
        or row.workspace_id != ctx.workspace_id
        or row.target_id != payload.target_id
        or (row.job_id is not None and row.job_id != ctx.job_id)
        or row.terminal
    ):
        return _result("skipped")
    stream = _Stream(deps, row.id)

    def fail(code: str, usage: Usage | None = None) -> JobResult:
        store.fail(row, code, usage)
        stream.error(code)
        return _result("failed", usage=usage, code=code)

    if not store.member_active(row):
        return fail("workspace_unavailable")
    if not deps.enabled or deps.llm is None:
        return fail("llm_unavailable")
    if not store.start(row):
        return _result("skipped")
    question = store.question(row)
    if question is None:
        return fail("question_unavailable")
    sources = _passages(store, row)
    if sources is None:
        return fail("sources_unavailable")

    llm = deps.llm
    tokens = _Tokens(llm.model_name)
    meta = ExplainCallMeta(
        target_kind=row.kind,
        target_id=str(row.target_id),
        revision_id=str(row.revision_id),
        explanation_id=str(row.id),
    )
    checked_at = time.monotonic()

    def cancelled(*, now: bool = False) -> bool:
        nonlocal checked_at
        moment = time.monotonic()
        if not now and moment - checked_at < deps.stop_check_seconds:
            return False
        checked_at = moment
        return store.status(row) != "running"

    def stop() -> JobResult:
        store.record_usage(row, tokens.usage())
        return _result("cancelled", usage=tokens.usage())

    missing: tuple[str, ...] = ()
    for attempt in range(MAX_CALLS):
        if cancelled(now=True):
            return stop()
        request = build_request(
            question=question,
            sources=sources,
            max_output_tokens=deps.max_output_tokens,
            effort=deps.effort,
            missing_option_ids=missing,
        )
        if attempt:
            stream.reset()
        shown = ExplanationStream(question)
        end: TextStreamEnd | None = None
        tokens.begin(len(request.system) + len(request.prompt))
        events: Iterator[TextStreamEvent] | None = None
        try:
            events = llm.stream(request, meta)
            for event in events:
                if isinstance(event, TextDelta):
                    tokens.received(event.text)
                    if cancelled():
                        raise _CancelledError
                    stream.delta(shown.feed(event.text))
                elif isinstance(event, TextStreamUsage):
                    tokens.reported(event.usage)
                elif isinstance(event, TextStreamEnd):
                    end = event
            stream.delta(shown.finish())
        except _CancelledError:
            _close(events)
            tokens.interrupted()
            return stop()
        except AnswerMismatchError:
            _close(events)
            return fail(ANSWER_MISMATCH, tokens.usage())
        except LLMProviderError as exc:
            return fail(error_code_of(exc), tokens.usage())
        if end is not None:
            tokens.add(end)
        checked = finish_explanation(
            shown.raw,
            question,
            request.source_tags,
            truncated=end is not None and end.truncated,
        )
        if checked.body is None:
            if checked.error_code == INCOMPLETE and attempt + 1 < MAX_CALLS:
                missing = checked.missing_option_ids or question.option_ids
                continue
            return fail(checked.error_code or INCOMPLETE, tokens.usage())
        cited = [(int(tag[1:]), n) for n, tag in enumerate(checked.cited_tags, start=1)]
        outcome = store.finish(
            row,
            body=checked.body,
            cited=cited,
            truncated=checked.truncated,
            dropped_citations=checked.dropped_citations,
            usage=tokens.usage(),
        )
        if not outcome.written:
            return stop()
        if outcome.error_code:
            stream.error(outcome.error_code)
            return _result("failed", usage=tokens.usage(), code=outcome.error_code)
        stream.done()
        return _result(
            "succeeded",
            usage=tokens.usage(),
            sources=len(cited),
            dropped=checked.dropped_citations,
        )
    return fail(INCOMPLETE, tokens.usage())  # pragma: no cover - the loop always returns


def cleanup_explain(deps: ExplainJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    """A job that ended failed/cancelled without finishing its explanation fails it."""
    row = deps.store.for_job(ctx.job_id)
    if row is None or row.terminal:
        return
    deps.store.fail(row, "explanation_failed")


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], ExplainJobDeps]


def explain_definition(provider: DepsProvider) -> JobDefinition[ExplainPayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: ExplainPayloadV1},
        handler=lambda ctx, payload: run_explain(provider(), ctx, payload),
        # Matches the `max_attempts` the API inserts: one retry of a crashed attempt.
        retry_policy=RetryPolicy(max_attempts=2, base_delay_seconds=1, max_delay_seconds=5),
        cleanup=lambda ctx, reason: cleanup_explain(provider(), ctx, reason),
    )


def build_explainer(settings: WorkerSettings) -> Explainer | None:
    """APP_ENV=test: the deterministic fake (never a real provider). Elsewhere the configured
    provider's streaming client, or None when `LLM_API_KEY` is unset."""
    from book_core.llm import LLMConfig, LLMConfigError, create_text_stream_client

    if settings.is_test:
        return FakeExplainer(
            log_dir=Path(settings.ask_fake_log_dir) if settings.ask_fake_log_dir else None,
            hold_dir=Path(settings.ask_hold_dir) if settings.ask_hold_dir else None,
        )
    try:
        config = LLMConfig.from_env(route="AI_EXPLANATIONS")
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    if config is None:
        return None
    return ProviderExplainer(create_text_stream_client(config))


def explain_stream_writer(settings: WorkerSettings) -> StreamWriter:
    if settings.redis_url is None:
        return NullStreamWriter()
    import redis

    client = redis.Redis.from_url(
        settings.redis_url.get_secret_value(), socket_timeout=10, socket_connect_timeout=3
    )
    return AskStreamWriter(client, key_prefix=STREAM_KEY_PREFIX)


def explain_deps(settings: WorkerSettings, engine: Any) -> ExplainJobDeps:
    return ExplainJobDeps(
        store=PostgresExplainStore(engine),
        stream=explain_stream_writer(settings),
        llm=build_explainer(settings) if settings.ai_explanations else None,
        enabled=settings.ai_explanations,
        max_output_tokens=settings.ai_explanation_max_output_tokens,
        effort=cast(Effort, route_effort_or_default("AI_EXPLANATIONS", EFFORT)),
    )


def deps_from_settings(settings: WorkerSettings) -> ExplainJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=1 + settings.ask_worker_concurrency,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return explain_deps(settings, engine)


class LazyExplainDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: ExplainJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> ExplainJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
