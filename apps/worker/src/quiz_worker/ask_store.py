"""AI question answers as the `ask.answer` job sees them (ASK-B), on the `quiz_worker` role, plus
the answer's Redis Stream.

Grants (supabase/migrations/20261102160000_ask.sql): the worker reads conversations, messages and
their pinned sources, finishes an unfinished answer (status, text, citation counts, model), marks
its cited sources, writes and purges `llm_feature_usage` and deletes expired conversations. It
reads documents, revisions, blocks, questions, question revisions and question sources (earlier
migrations) and mock exam questions and revisions; it never reads practice sessions or attempts:
the API pinned the session's option order and the user's own submission on the answer.

Content reads are split by disclosure level (ASK-01-C03): `hint_revision` selects only what a
question shows before submission (type, stem, options); `full_revision` adds the answer,
explanation and rubric and is only called for a `full` answer.

The finish write locks the message, re-checks that it is still unfinished (a stopped answer is
never written), that the user is still a member of the active workspace
(`worker_ask_member_active`, row locks until commit) and that every pinned source revision is
still its document's published one; it then stores the text, marks the cited sources and records
usage in one transaction. Nothing here logs message or passage text.

Redis Stream `ask:msg:<message id>` (`AskStreamWriter`): entries `event` / `seq` / `data` (JSON),
approximate MAXLEN, TTL 10 minutes refreshed on every write; mirrored by `quiz_api.ask_stream`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import Connection, Engine, text

JOB_TYPE = "ask.answer"
PURGE_TASK = "ask.purge"
RUNNING = ("queued", "retrieving", "streaming")
TERMINAL = frozenset({"succeeded", "no_sources", "stopped", "failed"})
STREAM_KEY_PREFIX = "ask:msg:"
STREAM_TTL_SECONDS = 600
STREAM_MAXLEN = 2000
USAGE_RETENTION = timedelta(days=396)  # 13 months


def stream_key(message_id: uuid.UUID | str) -> str:
    return f"{STREAM_KEY_PREFIX}{message_id}"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class AnswerRow:
    id: uuid.UUID
    conversation_id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    status: str
    question_message_id: uuid.UUID
    retry_of_message_id: uuid.UUID | None
    disclosure: str
    attachment_kind: str | None
    question_id: uuid.UUID | None
    question_revision_id: uuid.UUID | None
    mock_exam_question_id: uuid.UUID | None
    mock_exam_question_revision_id: uuid.UUID | None
    selected_option_ids: list[str]
    displayed_option_ids: list[str]
    submitted_answer: dict[str, Any] | None
    attempt_result: str | None
    context_char_limit: int | None
    job_id: uuid.UUID | None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL


@dataclass(frozen=True)
class PinnedSource:
    tag: int
    document_id: uuid.UUID
    revision_id: uuid.UUID
    chapter_id: uuid.UUID | None
    block_ids: list[str]
    page_from: int
    page_to: int


@dataclass(frozen=True)
class LiveDocument:
    id: uuid.UUID
    title: str
    document_type: str
    active_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class HintRevision:
    question_type: str
    number: str | None
    chapter: str | None
    stem: str
    options: list[dict[str, Any]]


@dataclass(frozen=True)
class FullRevision:
    question_type: str
    number: str | None
    chapter: str | None
    stem: str
    options: list[dict[str, Any]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    rubric: str | None


@dataclass(frozen=True)
class SourceRef:
    """A passage reference of the attached question (its `question_sources` / `evidence`)."""

    document_id: uuid.UUID
    revision_id: uuid.UUID | None
    block_ids: list[str]
    pages: list[int]


@dataclass(frozen=True)
class Usage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    llm_calls: int = 0
    cost_usd: float | None = None


@dataclass(frozen=True)
class Finished:
    status: str  # succeeded | no_sources
    text: str
    cited: Sequence[tuple[int, int]] = ()  # (tag, number)
    uncited: bool = False
    truncated: bool = False
    dropped_citations: int = 0
    model: str | None = None
    prompt_version: str | None = None
    usage: Usage | None = None


@dataclass(frozen=True)
class FinishOutcome:
    written: bool
    error_code: str | None = None


@dataclass(frozen=True)
class PurgeReport:
    conversations: int = 0
    usage: int = 0
    extra: dict[str, int] = field(default_factory=dict)


def _chapter_short(title: str | None) -> str | None:
    import re

    if not title:
        return None
    match = re.match(r"^\s*(\d+)\s*장", title)
    return f"{match.group(1)}장" if match else title.strip()


def _bank_number(chapter_title: str | None, question_number: int | None) -> str | None:
    parts = [
        p
        for p in (
            _chapter_short(chapter_title),
            f"{question_number}번" if question_number is not None else None,
        )
        if p
    ]
    return " ".join(parts) or None


class PostgresAskStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    # --- the answer --------------------------------------------------------------------------

    def answer_for_job(self, job_id: uuid.UUID) -> AnswerRow | None:
        with self._engine.connect() as conn:
            found: uuid.UUID | None = conn.execute(
                text("select id from public.ask_messages where job_id = :j"), {"j": job_id}
            ).scalar_one_or_none()
        return self.load_answer(found) if found is not None else None

    def load_answer(self, message_id: uuid.UUID) -> AnswerRow | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                text(
                    "select id, conversation_id, workspace_id, user_id, status, "
                    "question_message_id, retry_of_message_id, disclosure, attachment_kind, "
                    "question_id, question_revision_id, mock_exam_question_id, "
                    "mock_exam_question_revision_id, selected_option_ids, displayed_option_ids, "
                    "submitted_answer, attempt_result, context_char_limit, job_id "
                    "from public.ask_messages where id = :m and role = 'assistant'"
                ),
                {"m": message_id},
            ).one_or_none()
        if row is None:
            return None
        return AnswerRow(
            id=row.id,
            conversation_id=row.conversation_id,
            workspace_id=row.workspace_id,
            user_id=row.user_id,
            status=row.status,
            question_message_id=row.question_message_id,
            retry_of_message_id=row.retry_of_message_id,
            disclosure=row.disclosure,
            attachment_kind=row.attachment_kind,
            question_id=row.question_id,
            question_revision_id=row.question_revision_id,
            mock_exam_question_id=row.mock_exam_question_id,
            mock_exam_question_revision_id=row.mock_exam_question_revision_id,
            selected_option_ids=list(row.selected_option_ids or []),
            displayed_option_ids=list(row.displayed_option_ids or []),
            submitted_answer=dict(row.submitted_answer) if row.submitted_answer else None,
            attempt_result=row.attempt_result,
            context_char_limit=row.context_char_limit,
            job_id=row.job_id,
        )

    def status(self, message_id: uuid.UUID) -> str | None:
        with self._engine.connect() as conn:
            found: str | None = conn.execute(
                text("select status from public.ask_messages where id = :m"), {"m": message_id}
            ).scalar_one_or_none()
        return found

    def question_text(self, question_message_id: uuid.UUID) -> str:
        with self._engine.connect() as conn:
            found: str | None = conn.execute(
                text("select text from public.ask_messages where id = :m and role = 'user'"),
                {"m": question_message_id},
            ).scalar_one_or_none()
        return found or ""

    def history(self, answer: AnswerRow) -> list[tuple[str, str]]:
        """(question, latest finished answer text) of the questions before this answer's one."""
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select q.text as question, (select a.text from public.ask_messages a "
                    "where a.question_message_id = q.id and a.role = 'assistant' "
                    "and a.status in ('succeeded', 'no_sources', 'stopped') and a.text <> '' "
                    "order by a.created_at desc, a.id desc limit 1) as answer "
                    "from public.ask_messages q, public.ask_messages cur "
                    "where cur.id = :current and q.conversation_id = cur.conversation_id "
                    "and q.role = 'user' and (q.created_at, q.id) < (cur.created_at, cur.id) "
                    "order by q.created_at, q.id"
                ),
                {"current": answer.question_message_id},
            )
            return [(r.question, r.answer) for r in rows if r.answer]

    def mark(self, message_id: uuid.UUID, status: str) -> bool:
        """queued/retrieving -> `status` (retrieving | streaming); False if no longer running."""
        with self._engine.begin() as conn:
            done = conn.execute(
                text(
                    "update public.ask_messages set status = :s, "
                    "started_at = coalesce(started_at, now()) "
                    "where id = :m and status in ('queued', 'retrieving', 'streaming')"
                ),
                {"m": message_id, "s": status},
            )
        return bool(done.rowcount)

    def member_active(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, conn: Connection | None = None
    ) -> bool:
        statement = text("select public.worker_ask_member_active(:w, :u, :lock)")
        if conn is not None:
            return bool(
                conn.execute(statement, {"w": workspace_id, "u": user_id, "lock": True}).scalar()
            )
        with self._engine.connect() as own:
            return bool(
                own.execute(statement, {"w": workspace_id, "u": user_id, "lock": False}).scalar()
            )

    # --- pinned evidence ---------------------------------------------------------------------

    def sources(self, message_id: uuid.UUID) -> list[PinnedSource]:
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select tag, document_id, revision_id, chapter_id, block_ids, page_from, "
                    "page_to from public.ask_message_sources where message_id = :m order by tag"
                ),
                {"m": message_id},
            )
            return [
                PinnedSource(
                    r.tag,
                    r.document_id,
                    r.revision_id,
                    r.chapter_id,
                    list(r.block_ids),
                    r.page_from,
                    r.page_to,
                )
                for r in rows
            ]

    def documents(
        self, workspace_id: uuid.UUID, ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, LiveDocument]:
        """Live (not deleted) documents of the workspace whose active revision is published."""
        if not ids:
            return {}
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select d.id, d.title, d.document_type, d.active_revision_id "
                    "from public.documents d join public.document_revisions r "
                    "on r.id = d.active_revision_id and r.document_id = d.id "
                    "where d.workspace_id = :w and d.id = any(:ids) and d.deleted_at is null "
                    "and r.status = 'published'"
                ),
                {"w": workspace_id, "ids": list(ids)},
            )
            return {
                r.id: LiveDocument(r.id, r.title, r.document_type, r.active_revision_id)
                for r in rows
            }

    def chapter_titles(self, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not ids:
            return {}
        with self._engine.connect() as conn:
            rows = conn.execute(
                text("select id, title from public.chapters where id = any(:ids)"),
                {"ids": list(ids)},
            )
            return {r.id: r.title for r in rows}

    def block_texts(self, revision_id: uuid.UUID, block_ids: Sequence[str]) -> list[str]:
        """The texts of `block_ids` in the revision, in reading order (unknown ids skipped)."""
        if not block_ids:
            return []
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select text from public.content_blocks where document_revision_id = :r "
                    "and block_id = any(:ids) and btrim(text) <> '' order by ordinal"
                ),
                {"r": revision_id, "ids": list(block_ids)},
            )
            return [r.text for r in rows]

    def page_texts(self, revision_id: uuid.UUID, pages: Sequence[int]) -> list[str]:
        """Non-heading body text located on `pages`, in reading order."""
        if not pages:
            return []
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select text from public.content_blocks where document_revision_id = :r "
                    "and page = any(:p) and block_type <> 'heading' and btrim(text) <> '' "
                    "order by ordinal"
                ),
                {"r": revision_id, "p": list(pages)},
            )
            return [r.text for r in rows]

    # --- the attached question ---------------------------------------------------------------

    def hint_revision(self, answer: AnswerRow) -> HintRevision | None:
        """Stem and options only (never an answer column)."""
        with self._engine.connect() as conn:
            if answer.attachment_kind == "question":
                row = conn.execute(
                    text(
                        "select q.question_type, q.question_number, ch.title as chapter, "
                        "r.stem, r.options from public.question_revisions r "
                        "join public.questions q on q.id = r.question_id "
                        "left join public.chapters ch on ch.id = q.chapter_id "
                        "where r.id = :r and q.id = :q and q.deleted_at is null"
                    ),
                    {"r": answer.question_revision_id, "q": answer.question_id},
                ).one_or_none()
                if row is None:
                    return None
                return HintRevision(
                    row.question_type,
                    _bank_number(row.chapter, row.question_number),
                    row.chapter,
                    row.stem,
                    list(row.options or []),
                )
            row = conn.execute(
                text(
                    "select q.question_type, q.position, r.stem, r.options "
                    "from public.mock_exam_question_revisions r "
                    "join public.mock_exam_questions q on q.id = r.mock_exam_question_id "
                    "join public.mock_exams e on e.id = q.mock_exam_id "
                    "where r.id = :r and q.id = :q and q.removed_at is null "
                    "and e.deleted_at is null"
                ),
                {"r": answer.mock_exam_question_revision_id, "q": answer.mock_exam_question_id},
            ).one_or_none()
            if row is None:
                return None
            return HintRevision(
                row.question_type, f"문제 {row.position + 1}", None, row.stem, list(row.options)
            )

    def full_revision(self, answer: AnswerRow) -> tuple[FullRevision, list[SourceRef]] | None:
        """The answer-bearing content of a `full` answer, with its source references."""
        with self._engine.connect() as conn:
            if answer.attachment_kind == "question":
                row = conn.execute(
                    text(
                        "select q.question_type, q.question_number, ch.title as chapter, "
                        "r.stem, r.options, r.correct_option_ids, r.accepted_answers, "
                        "r.explanation, r.rubric from public.question_revisions r "
                        "join public.questions q on q.id = r.question_id "
                        "left join public.chapters ch on ch.id = q.chapter_id "
                        "where r.id = :r and q.id = :q and q.deleted_at is null"
                    ),
                    {"r": answer.question_revision_id, "q": answer.question_id},
                ).one_or_none()
                if row is None:
                    return None
                refs = [
                    SourceRef(
                        s.document_id,
                        s.document_revision_id,
                        list(s.block_ids or []),
                        _pages(s.page_start, s.page_end, s.locations),
                    )
                    for s in conn.execute(
                        text(
                            "select document_id, document_revision_id, page_start, page_end, "
                            "block_ids, locations from public.question_sources "
                            "where question_id = :q and document_id is not null "
                            "order by created_at, id"
                        ),
                        {"q": answer.question_id},
                    )
                ]
                number = _bank_number(row.chapter, row.question_number)
                chapter = row.chapter
            else:
                row = conn.execute(
                    text(
                        "select q.question_type, q.position, r.stem, r.options, "
                        "r.correct_option_ids, r.accepted_answers, r.explanation, r.rubric, "
                        "r.evidence from public.mock_exam_question_revisions r "
                        "join public.mock_exam_questions q on q.id = r.mock_exam_question_id "
                        "join public.mock_exams e on e.id = q.mock_exam_id "
                        "where r.id = :r and q.id = :q and q.removed_at is null "
                        "and e.deleted_at is null"
                    ),
                    {
                        "r": answer.mock_exam_question_revision_id,
                        "q": answer.mock_exam_question_id,
                    },
                ).one_or_none()
                if row is None:
                    return None
                refs = [r for e in row.evidence or [] if (r := _evidence_ref(e)) is not None]
                number = f"문제 {row.position + 1}"
                chapter = None
        return (
            FullRevision(
                question_type=row.question_type,
                number=number,
                chapter=chapter,
                stem=row.stem,
                options=list(row.options or []),
                correct_option_ids=list(row.correct_option_ids)
                if row.correct_option_ids is not None
                else None,
                accepted_answers=list(row.accepted_answers)
                if row.accepted_answers is not None
                else None,
                explanation=row.explanation,
                rubric=row.rubric,
            ),
            refs,
        )

    # --- writes ------------------------------------------------------------------------------

    def finish(
        self, answer: AnswerRow, result: Finished, pinned: Sequence[PinnedSource]
    ) -> FinishOutcome:
        """Write the finished answer after the re-checks (module docstring)."""
        with self._engine.begin() as conn:
            status = conn.execute(
                text("select status from public.ask_messages where id = :m for update"),
                {"m": answer.id},
            ).scalar_one_or_none()
            if status is None or status not in RUNNING:
                return FinishOutcome(False)
            failure: str | None = None
            if not self.member_active(answer.workspace_id, answer.user_id, conn):
                failure = "workspace_unavailable"
            elif not _revisions_current(conn, answer.workspace_id, pinned):
                failure = "sources_unavailable"
            if failure is not None:
                _fail(conn, answer.id, failure)
                _usage(conn, answer, result.usage, "failed", failure)
                return FinishOutcome(True, failure)
            conn.execute(
                text(
                    "update public.ask_messages set status = :s, text = :t, uncited = :uncited, "
                    "truncated = :trunc, dropped_citations = :dropped, model = :model, "
                    "prompt_version = :pv, error_code = null, finished_at = now(), "
                    "started_at = coalesce(started_at, now()) where id = :m"
                ),
                {
                    "m": answer.id,
                    "s": result.status,
                    "t": result.text[:50000],
                    "uncited": result.uncited,
                    "trunc": result.truncated,
                    "dropped": result.dropped_citations,
                    "model": result.model,
                    "pv": result.prompt_version,
                },
            )
            for tag, number in result.cited:
                conn.execute(
                    text(
                        "update public.ask_message_sources set cited = true, number = :n "
                        "where message_id = :m and tag = :t"
                    ),
                    {"m": answer.id, "t": tag, "n": number},
                )
            _usage(conn, answer, result.usage, result.status, None)
        return FinishOutcome(True)

    def fail(self, answer: AnswerRow, code: str, usage: Usage | None = None) -> bool:
        with self._engine.begin() as conn:
            status = conn.execute(
                text("select status from public.ask_messages where id = :m for update"),
                {"m": answer.id},
            ).scalar_one_or_none()
            if status is None or status not in RUNNING:
                _usage(conn, answer, usage, "stopped" if status == "stopped" else "failed", None)
                return False
            _fail(conn, answer.id, code)
            _usage(conn, answer, usage, "failed", code)
        return True

    def record_usage(self, answer: AnswerRow, usage: Usage | None, status: str) -> None:
        with self._engine.begin() as conn:
            _usage(conn, answer, usage, status, None)

    def purge(self, now: datetime, retention_days: int) -> PurgeReport:
        """Conversations idle past the retention and usage older than 13 months (idempotent)."""
        with self._engine.begin() as conn:
            conversations = conn.execute(
                text("delete from public.ask_conversations where last_message_at < :t"),
                {"t": now - timedelta(days=retention_days)},
            ).rowcount
            usage = conn.execute(
                text("delete from public.llm_feature_usage where created_at < :t"),
                {"t": now - USAGE_RETENTION},
            ).rowcount
        return PurgeReport(int(conversations or 0), int(usage or 0))


def _pages(page_start: int | None, page_end: int | None, locations: Any) -> list[int]:
    pages: set[int] = set()
    if page_start is not None and page_start >= 1:
        pages.update(range(page_start, min(page_end or page_start, page_start + 20) + 1))
    for raw in locations or []:
        page = raw.get("page") if isinstance(raw, Mapping) else None
        if isinstance(page, int) and page > 0:
            pages.add(page)
    return sorted(pages)


def _evidence_ref(raw: Any) -> SourceRef | None:
    if not isinstance(raw, Mapping):
        return None
    try:
        document_id = uuid.UUID(str(raw.get("document_id")))
    except ValueError:
        return None
    revision: uuid.UUID | None
    try:
        revision = uuid.UUID(str(raw["revision_id"])) if raw.get("revision_id") else None
    except ValueError:
        revision = None
    blocks = [str(b) for b in raw.get("block_ids") or [] if isinstance(b, str)]
    return SourceRef(document_id, revision, blocks, _pages(None, None, raw.get("locations")))


def _revisions_current(
    conn: Connection, workspace_id: uuid.UUID, pinned: Sequence[PinnedSource]
) -> bool:
    if not pinned:
        return True
    revisions = {s.revision_id for s in pinned}
    current = conn.execute(
        text(
            "select count(*) from public.documents d where d.workspace_id = :w "
            "and d.deleted_at is null and d.active_revision_id = any(:r)"
        ),
        {"w": workspace_id, "r": list(revisions)},
    ).scalar_one()
    return int(current) == len(revisions)


def _fail(conn: Connection, message_id: uuid.UUID, code: str) -> None:
    conn.execute(
        text(
            "update public.ask_messages set status = 'failed', error_code = :c, text = '', "
            "finished_at = now() where id = :m"
        ),
        {"m": message_id, "c": code},
    )


def _usage(
    conn: Connection, answer: AnswerRow, usage: Usage | None, status: str, code: str | None
) -> None:
    if usage is None or usage.llm_calls <= 0:
        return
    conn.execute(
        text(
            "insert into public.llm_feature_usage (feature, user_id, workspace_id, message_id, "
            "model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, "
            "llm_calls, cost_usd, status, error_code) values ('ask', :u, :w, "
            "(select id from public.ask_messages where id = :m), :model, :i, :o, :cr, :cc, "
            ":calls, :cost, :s, :code)"
        ),
        {
            "u": answer.user_id,
            "w": answer.workspace_id,
            "m": answer.id,
            "model": usage.model,
            "i": usage.input_tokens,
            "o": usage.output_tokens,
            "cr": usage.cache_read_tokens,
            "cc": usage.cache_creation_tokens,
            "calls": usage.llm_calls,
            "cost": usage.cost_usd,
            "s": status,
            "code": code,
        },
    )


class StreamWriter(Protocol):
    def append(
        self, message_id: uuid.UUID, event: str, seq: int, data: Mapping[str, Any]
    ) -> None: ...

    def last_seq(self, message_id: uuid.UUID) -> int: ...


class AskStreamWriter:
    def __init__(
        self, client: Any, *, ttl_seconds: int = STREAM_TTL_SECONDS, maxlen: int = STREAM_MAXLEN
    ) -> None:
        self._client = client
        self._ttl = ttl_seconds
        self._maxlen = maxlen

    def append(self, message_id: uuid.UUID, event: str, seq: int, data: Mapping[str, Any]) -> None:
        key = stream_key(message_id)
        pipe = self._client.pipeline(transaction=False)
        pipe.xadd(
            key,
            {"event": event, "seq": str(seq), "data": _json(dict(data))},
            maxlen=self._maxlen,
            approximate=True,
        )
        pipe.expire(key, self._ttl)
        pipe.execute()

    def last_seq(self, message_id: uuid.UUID) -> int:
        entries = self._client.xrevrange(stream_key(message_id), count=1)
        for _sid, fields in entries or []:
            raw = fields.get(b"seq", fields.get("seq"))
            try:
                return int(raw.decode() if isinstance(raw, bytes) else raw)
            except (TypeError, ValueError):
                return 0
        return 0


class NullStreamWriter:
    """No Redis configured (local runs): answers are still stored, nothing streams."""

    def append(self, message_id: uuid.UUID, event: str, seq: int, data: Mapping[str, Any]) -> None:
        return None

    def last_seq(self, message_id: uuid.UUID) -> int:
        return 0
