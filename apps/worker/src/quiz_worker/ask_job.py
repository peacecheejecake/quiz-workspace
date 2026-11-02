"""`ask.answer` v1: one AI question answer (ASK-B, ASK-01 "실행 경로", C02-C11).

Payload (written by apps/api `POST /ask/conversations/{id}/messages`, `…/retry`,
`…/regenerate`): `{message_id}`, the queued answer. The job runs on the Celery queue
`interactive` (its own worker process, `WORKER_QUEUE=interactive`, so a long `document.parse`
never delays an answer).

1. Load the answer. Nothing happens for a finished (or deleted) one — a redelivery calls nothing
   (C09). An answer a crashed attempt already streamed to fails `ask_failed` (no automatic retry
   after the first delta).
2. Re-check (C09): the user is still a member of the active workspace (`workspace_unavailable`),
   every pinned evidence revision is still its document's published one (`sources_unavailable`).
3. Read the pinned passages' blocks from Postgres (never copied from the API), the attached
   question at the pinned disclosure level (`hint`: stem and options only) and the last turns.
   No passage and no question: `no_sources` without any LLM call (usage 0).
4. Stream the answer (`book_core.ask.build_request`), coalescing deltas (~100 ms or 20
   characters) into the Redis Stream `ask:msg:<id>`; before every delta the message is checked
   and a stopped one closes the provider stream. A provider error before the first delta is
   retried `LLM_MAX_RETRIES` times (usage accumulates); after it the answer fails.
5. Validate the citations (`validate_citations`), then write the answer, its cited sources and
   the usage after the same re-checks under row locks (`PostgresAskStore.finish`), and `done`.

The job result holds counts, usage and codes only (C07); logs carry ids and counts only.

`ask.purge` (Celery beat, daily) deletes conversations idle past `ASK_RETENTION_DAYS` and usage
older than 13 months (C08, idempotent).

LLM: APP_ENV=test the deterministic `book_core.ask.FakeAskAnswerer` (markers, call record in
`WORKER_ASK_FAKE_LOG_DIR`, hold barrier in `WORKER_ASK_HOLD_DIR`); elsewhere the configured
provider's streaming client, only with `WORKER_ASK_LLM` on and `LLM_API_KEY` set.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from book_core.ask import (
    NOT_FOUND_TEXT,
    PROMPT_VERSION,
    TRUNCATED_SUFFIX,
    AskAnswerer,
    AskCallMeta,
    AskSource,
    FakeAskAnswerer,
    HistoryTurn,
    ProviderAskAnswerer,
    QuestionContext,
    build_request,
    full_context,
    hint_context,
    validate_citations,
)
from book_core.llm import LLMProviderError, TextDelta, TextStreamEnd
from pydantic import BaseModel, ConfigDict

from quiz_worker.adapters import WorkerNotConfiguredError
from quiz_worker.ask_store import (
    JOB_TYPE,
    AnswerRow,
    AskStreamWriter,
    Finished,
    FullRevision,
    NullStreamWriter,
    PinnedSource,
    PostgresAskStore,
    PurgeReport,
    SourceRef,
    StreamWriter,
    Usage,
)
from quiz_worker.retry import RetryPolicy
from quiz_worker.runner import JobContext, JobDefinition, JobResult, TerminalReason
from quiz_worker.settings import WorkerSettings

logger = logging.getLogger(__name__)

MIXED = "mixed"
FLUSH_SECONDS = 0.1
FLUSH_CHARS = 20
SOURCE_CHARS = 2000
PASSAGE_CHARS = 2000
RETRY_BASE_SECONDS = 0.5
RETRY_MAX_SECONDS = 4.0


class AskAnswerPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    message_id: uuid.UUID


@dataclass
class AskJobDeps:
    store: PostgresAskStore
    stream: StreamWriter
    llm: AskAnswerer | None
    enabled: bool = True
    max_output_tokens: int = 2000
    effort: str | None = "low"
    history_turns: int = 3
    llm_max_retries: int = 2
    retention_days: int = 90
    sleep: Callable[[float], None] = field(default=time.sleep)

    def purge(self, now: datetime | None = None) -> PurgeReport:
        """One `ask.purge` pass (C08)."""
        report = self.store.purge(now or datetime.now(UTC), self.retention_days)
        logger.info(
            "ask purge: %d conversations, %d usage rows", report.conversations, report.usage
        )
        return report


def error_code_of(exc: LLMProviderError) -> str:
    if exc.kind == "timeout":
        return "llm_timeout"
    if exc.kind == "refusal":
        return "llm_refused"
    return "llm_unavailable"


class _Stream:
    """The answer's Redis Stream: coalesced deltas with contiguous `seq`."""

    def __init__(self, deps: AskJobDeps, message_id: uuid.UUID) -> None:
        self._deps = deps
        self._id = message_id
        self.seq = deps.stream.last_seq(message_id)
        self.sent = 0
        self.text: list[str] = []
        self._buffer: list[str] = []
        self._flushed_at = time.monotonic()
        if self.seq:
            # An earlier attempt wrote to this stream before anything reached the message state:
            # clients drop what they received.
            self._event("reset", {})

    def _event(self, event: str, data: dict[str, Any]) -> None:
        self.seq += 1
        try:
            self._deps.stream.append(self._id, event, self.seq, data)
        except Exception as exc:  # the answer is still stored; clients fall back to polling
            logger.warning("ask: stream write failed (%s)", type(exc).__name__)

    def add(self, text: str) -> bool:
        """Buffer a provider delta; True when the buffer should be flushed now."""
        self._buffer.append(text)
        self.text.append(text)
        pending = sum(len(t) for t in self._buffer)
        return pending >= FLUSH_CHARS or time.monotonic() - self._flushed_at >= FLUSH_SECONDS

    def flush(self) -> None:
        if not self._buffer:
            return
        chunk = "".join(self._buffer)
        self._buffer = []
        self._flushed_at = time.monotonic()
        self._event("delta", {"seq": self.seq + 1, "text": chunk})
        self.sent += 1

    def done(self) -> None:
        self._event("done", {})

    def error(self, code: str) -> None:
        self._event("error", {"code": code})


class _StoppedError(Exception):
    pass


def _result(
    status: str,
    *,
    sources: int = 0,
    dropped: int = 0,
    usage: Usage | None = None,
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


def _passage(
    store: PostgresAskStore,
    revision_id: uuid.UUID,
    ref: SourceRef | PinnedSource,
    exclude: frozenset[str] = frozenset(),
) -> str:
    texts = store.block_texts(revision_id, ref.block_ids, exclude)
    if not texts:
        pages = (
            ref.pages if isinstance(ref, SourceRef) else list(range(ref.page_from, ref.page_to + 1))
        )
        texts = store.page_texts(revision_id, pages, exclude)
    return "\n\n".join(texts)[:PASSAGE_CHARS]


def _sources(
    store: PostgresAskStore, answer: AnswerRow, pinned: list[PinnedSource]
) -> list[AskSource] | None:
    """The pinned passages from Postgres, None when a revision is no longer the published one."""
    docs = store.documents(answer.workspace_id, list({s.document_id for s in pinned}))
    chapters = store.chapter_titles([s.chapter_id for s in pinned if s.chapter_id])
    out: list[AskSource] = []
    excluded: dict[uuid.UUID, frozenset[str]] = {}
    for source in pinned:
        doc = docs.get(source.document_id)
        if doc is None or doc.active_revision_id != source.revision_id:
            return None
        if doc.content_kind == MIXED and source.revision_id not in excluded:
            # Re-check the API's rule: no question-part block of a `mixed` book reaches the model.
            excluded[source.revision_id] = store.question_part_block_ids(source.revision_id)
        body = _passage(
            store, source.revision_id, source, excluded.get(source.revision_id, frozenset())
        )
        if not body.strip():
            continue
        out.append(
            AskSource(
                tag=f"S{source.tag}",
                document_title=doc.title,
                chapter_title=chapters.get(source.chapter_id) if source.chapter_id else None,
                page_from=source.page_from,
                page_to=source.page_to,
                text=body[:SOURCE_CHARS],
            )
        )
    return out


def _submitted(answer: AnswerRow, revision: FullRevision) -> str | None:
    raw = answer.submitted_answer
    if not raw:
        return None
    ids = raw.get("selected_option_ids")
    if isinstance(ids, list):
        order = list(answer.displayed_option_ids) or [str(o.get("id")) for o in revision.options]
        texts = {str(o.get("id")): str(o.get("text", "")) for o in revision.options}
        numbered = {i: n for n, i in enumerate(order, start=1)}
        return ", ".join(f"{numbered.get(i, '?')}. {texts.get(i, '')}" for i in ids) or "(none)"
    text = raw.get("answer_text")
    return str(text) if isinstance(text, str) else None


def _attachment(store: PostgresAskStore, answer: AnswerRow) -> QuestionContext | None:
    if answer.disclosure == "none" or answer.attachment_kind is None:
        return None
    kind = "question" if answer.attachment_kind == "question" else "mock_exam_question"
    if answer.disclosure == "hint":
        hint = store.hint_revision(answer)
        if hint is None:
            return None
        return hint_context(
            kind=kind,  # type: ignore[arg-type]
            number=hint.number,
            chapter=hint.chapter,
            question_type=hint.question_type,
            stem=hint.stem,
            options=hint.options,
            displayed_option_ids=answer.displayed_option_ids,
            selected_option_ids=answer.selected_option_ids,
        )
    found = store.full_revision(answer)
    if found is None:
        return None
    revision, refs = found
    docs = store.documents(answer.workspace_id, list({r.document_id for r in refs}))
    passages: list[str] = []
    for ref in refs:
        doc = docs.get(ref.document_id)
        # Only this workspace's live books, in their published revision (C10: no question
        # paper, no imported question PDF, never the stored quote).
        if doc is None or doc.document_type != "book" or doc.active_revision_id is None:
            continue
        body = _passage(store, doc.active_revision_id, ref)
        if body.strip():
            passages.append(body)
    return full_context(
        kind=kind,  # type: ignore[arg-type]
        number=revision.number,
        chapter=revision.chapter,
        question_type=revision.question_type,
        stem=revision.stem,
        options=revision.options,
        displayed_option_ids=answer.displayed_option_ids,
        selected_option_ids=answer.selected_option_ids,
        correct_option_ids=revision.correct_option_ids,
        accepted_answers=revision.accepted_answers,
        explanation=revision.explanation,
        rubric=revision.rubric,
        submitted_answer=_submitted(answer, revision),
        result=answer.attempt_result,
        question_sources=passages,
    )


def run_ask_answer(deps: AskJobDeps, ctx: JobContext, payload: AskAnswerPayloadV1) -> JobResult:
    store = deps.store
    answer = store.load_answer(payload.message_id)
    if (
        answer is None
        or answer.workspace_id != ctx.workspace_id
        or (answer.job_id is not None and answer.job_id != ctx.job_id)
    ):
        return _result("skipped")
    if answer.terminal:
        return _result("skipped")
    stream = _Stream(deps, answer.id)

    def fail(code: str, usage: Usage | None = None) -> JobResult:
        store.fail(answer, code, usage)
        stream.error(code)
        return _result("failed", usage=usage, code=code)

    if answer.status == "streaming":
        return fail("ask_failed")
    if not store.member_active(answer.workspace_id, answer.user_id):
        return fail("workspace_unavailable")
    if not deps.enabled or deps.llm is None:
        return fail("llm_unavailable")
    if not store.mark(answer.id, "retrieving"):
        return _result("stopped")
    pinned = store.sources(answer.id)
    sources = _sources(store, answer, pinned)
    if sources is None:
        return fail("sources_unavailable")
    attachment = _attachment(store, answer)
    if not sources and attachment is None:
        outcome = store.finish(answer, Finished(status="no_sources", text=NOT_FOUND_TEXT), pinned)
        if outcome.error_code:
            stream.error(outcome.error_code)
            return _result("failed", code=outcome.error_code)
        stream.done()
        return _result("no_sources")

    history = [HistoryTurn(q, a) for q, a in store.history(answer)]
    request = build_request(
        question=store.question_text(answer.question_message_id),
        sources=sources,
        attachment=attachment,
        history=history,
        max_output_tokens=deps.max_output_tokens,
        effort=deps.effort,  # type: ignore[arg-type]
        max_context_chars=answer.context_char_limit or 16_000,
        history_turns=deps.history_turns,
    )
    meta = AskCallMeta(message_id=str(answer.id), retry=answer.retry_of_message_id is not None)
    model = deps.llm.model_name
    calls = 0
    tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    cost: float | None = None
    end: TextStreamEnd | None = None

    def usage() -> Usage:
        return Usage(
            model=model,
            input_tokens=tokens["input"],
            output_tokens=tokens["output"],
            cache_read_tokens=tokens["cache_read"],
            cache_creation_tokens=tokens["cache_creation"],
            llm_calls=calls,
            cost_usd=cost,
        )

    def stopped() -> bool:
        return store.status(answer.id) not in ("retrieving", "streaming")

    for attempt in range(deps.llm_max_retries + 1):
        if store.status(answer.id) not in ("retrieving", "streaming"):
            store.record_usage(answer, usage(), "stopped")
            return _result("stopped", usage=usage())
        calls += 1
        events = deps.llm.stream(request, meta)
        try:
            for event in events:
                if isinstance(event, TextDelta):
                    if stream.add(event.text):
                        if stream.sent == 0:
                            store.mark(answer.id, "streaming")
                        if stopped():
                            raise _StoppedError()
                        stream.flush()
                elif isinstance(event, TextStreamEnd):
                    end = event
        except _StoppedError:
            close = getattr(events, "close", None)
            if callable(close):
                close()
            store.record_usage(answer, usage(), "stopped")
            return _result("stopped", usage=usage())
        except LLMProviderError as exc:
            if stream.sent > 0 or stream.text:
                return fail(error_code_of(exc), usage())
            if attempt >= deps.llm_max_retries:
                return fail(error_code_of(exc), usage())
            deps.sleep(min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2**attempt))
            continue
        break
    if end is not None:
        tokens["input"] += end.usage.input_tokens
        tokens["output"] += end.usage.output_tokens
        tokens["cache_read"] += end.usage.cache_read_input_tokens
        tokens["cache_creation"] += end.usage.cache_creation_input_tokens
        cost = end.usage.cost_usd
        model = end.model or model
    if stream.text and stream.sent == 0:
        store.mark(answer.id, "streaming")
    if stopped():
        store.record_usage(answer, usage(), "stopped")
        return _result("stopped", usage=usage())
    stream.flush()

    raw = "".join(stream.text)
    known = [s.tag for s in request.sources]
    checked = validate_citations(raw, known)
    if checked.no_answer:
        finished = Finished(
            status="no_sources",
            text=NOT_FOUND_TEXT,
            dropped_citations=checked.dropped,
            model=model,
            prompt_version=PROMPT_VERSION,
            usage=usage(),
        )
    else:
        truncated = end is not None and end.truncated
        body = checked.text + (f"\n\n{TRUNCATED_SUFFIX}" if truncated else "")
        finished = Finished(
            status="succeeded",
            text=body,
            cited=[(int(tag[1:]), n) for n, tag in enumerate(checked.cited_tags, start=1)],
            uncited=checked.uncited,
            truncated=truncated,
            dropped_citations=checked.dropped,
            model=model,
            prompt_version=PROMPT_VERSION,
            usage=usage(),
        )
    outcome = store.finish(answer, finished, pinned)
    if not outcome.written:
        store.record_usage(answer, usage(), "stopped")
        return _result("stopped", usage=usage())
    if outcome.error_code:
        stream.error(outcome.error_code)
        return _result("failed", usage=usage(), code=outcome.error_code)
    stream.done()
    return _result(
        finished.status,
        sources=len(finished.cited),
        dropped=checked.dropped,
        usage=usage(),
    )


def cleanup_ask_answer(deps: AskJobDeps, ctx: JobContext, reason: TerminalReason) -> None:
    """A job that ended failed/cancelled without finishing its answer fails the answer."""
    answer = deps.store.answer_for_job(ctx.job_id)
    if answer is None or answer.terminal:
        return
    deps.store.fail(answer, "ask_failed")


# --------------------------------------------------------------------------------------------
# Definition and per-process runtime
# --------------------------------------------------------------------------------------------

DepsProvider = Callable[[], AskJobDeps]


def ask_answer_definition(provider: DepsProvider) -> JobDefinition[AskAnswerPayloadV1]:
    return JobDefinition(
        job_type=JOB_TYPE,
        payload_models={1: AskAnswerPayloadV1},
        handler=lambda ctx, payload: run_ask_answer(provider(), ctx, payload),
        # Matches the `max_attempts` the API inserts: one retry of a crashed attempt.
        retry_policy=RetryPolicy(max_attempts=2, base_delay_seconds=1, max_delay_seconds=5),
        cleanup=lambda ctx, reason: cleanup_ask_answer(provider(), ctx, reason),
    )


def build_ask_llm(settings: WorkerSettings) -> AskAnswerer | None:
    """APP_ENV=test: the deterministic fake (never a real provider). Elsewhere the configured
    provider's streaming client, or None when `LLM_API_KEY` is unset."""
    from book_core.llm import LLMConfig, LLMConfigError, create_text_stream_client

    if settings.is_test:
        return FakeAskAnswerer(
            log_dir=Path(settings.ask_fake_log_dir) if settings.ask_fake_log_dir else None,
            hold_dir=Path(settings.ask_hold_dir) if settings.ask_hold_dir else None,
        )
    try:
        config = LLMConfig.from_env()
    except LLMConfigError:
        raise WorkerNotConfiguredError("the LLM configuration is invalid") from None
    if config is None:
        return None
    return ProviderAskAnswerer(create_text_stream_client(config))


def build_stream_writer(settings: WorkerSettings) -> StreamWriter:
    if settings.redis_url is None:
        return NullStreamWriter()
    import redis

    client = redis.Redis.from_url(
        settings.redis_url.get_secret_value(), socket_timeout=10, socket_connect_timeout=3
    )
    return AskStreamWriter(client)


def ask_deps(settings: WorkerSettings, engine: Any) -> AskJobDeps:
    return AskJobDeps(
        store=PostgresAskStore(engine),
        stream=build_stream_writer(settings),
        llm=build_ask_llm(settings) if settings.ask_llm else None,
        enabled=settings.ask_llm,
        max_output_tokens=settings.ask_max_output_tokens,
        effort=settings.ask_llm_effort,
        history_turns=settings.ask_history_turns,
        llm_max_retries=settings.llm_max_retries,
        retention_days=settings.ask_retention_days,
    )


def deps_from_settings(settings: WorkerSettings) -> AskJobDeps:
    if settings.worker_database_url is None:
        raise WorkerNotConfiguredError("WORKER_DATABASE_URL is not set")
    from quiz_worker.pg_store import create_job_store_engine

    engine = create_job_store_engine(
        settings.worker_database_url,
        pool_size=1 + settings.ask_worker_concurrency,
        connect_timeout_seconds=settings.db_connect_timeout_seconds,
    )
    return ask_deps(settings, engine)


class LazyAskDeps:
    """Builds the dependencies once per process, on the first job."""

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._deps: AskJobDeps | None = None
        self._lock = threading.Lock()

    def __call__(self) -> AskJobDeps:
        with self._lock:
            if self._deps is None:
                self._deps = deps_from_settings(self._settings)
            return self._deps
