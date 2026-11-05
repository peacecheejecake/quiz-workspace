"""Reads and writes of AI question conversations (ASK-B, 20261104100000_ask.sql).

Runs in the request session after the route checked the caller: every conversation / message
lookup is filtered by the caller's own `user_id` (a conversation is personal: another member, the
workspace Owner included, gets the same `None` as an unknown id).

Nothing here reads an attached question's answer, accepted answers, rubric, explanation or source
passages (ASK-01-C03): the API pins ids (question / revision / session), the session's option
order and, once the caller submitted, the caller's own submitted answer and result; the worker
builds the LLM context from those. Stems and option texts are read for the chip label and the
evidence query only. Nothing here logs message text.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

ASK_JOB_TYPE = "ask.answer"
ASK_JOB_SCHEMA_VERSION = 1
# One retry of a crashed attempt (provider retries happen inside the job, before any delta).
ASK_JOB_MAX_ATTEMPTS = 2
RUNNING = ("queued", "retrieving", "streaming")
TERMINAL = frozenset({"succeeded", "no_sources", "stopped", "failed"})
_CHAPTER_NUMBER = re.compile(r"^\s*(\d+)\s*장")
LABEL_STEM_CHARS = 40


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def stem_head(stem: str, size: int = LABEL_STEM_CHARS) -> str:
    flat = " ".join(stem.split())
    return flat if len(flat) <= size else flat[:size].rstrip() + "…"


def chapter_short(title: str | None) -> str | None:
    if not title:
        return None
    match = _CHAPTER_NUMBER.match(title)
    return f"{match.group(1)}장" if match else title.strip()


@dataclass(frozen=True)
class ConversationRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    title: str | None
    scope: dict[str, Any]
    attachment_kind: str | None
    attachment_view: str | None
    attachment_label: str | None
    question_id: uuid.UUID | None
    practice_session_id: uuid.UUID | None
    mock_exam_question_id: uuid.UUID | None
    mock_practice_session_id: uuid.UUID | None
    selected_option_ids: list[str]
    created_at: datetime
    last_message_at: datetime


@dataclass(frozen=True)
class MessageRow:
    id: uuid.UUID
    conversation_id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    status: str
    question_message_id: uuid.UUID | None
    retry_of_message_id: uuid.UUID | None
    regenerated_from_message_id: uuid.UUID | None
    text: str
    scope: dict[str, Any]
    disclosure: str
    attachment_kind: str | None
    selected_option_ids: list[str]
    degraded: list[str]
    error_code: str | None
    uncited: bool
    truncated: bool
    dropped_citations: int
    job_id: uuid.UUID | None
    created_at: datetime
    finished_at: datetime | None
    feedback: str | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL


@dataclass(frozen=True)
class SourceRow:
    message_id: uuid.UUID
    tag: int
    rank: int
    document_id: uuid.UUID
    document_title: str
    document_type: str
    revision_id: uuid.UUID
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    block_ids: list[str]
    page_from: int
    page_to: int
    cited: bool
    number: int | None
    outdated: bool


@dataclass(frozen=True)
class AttachTarget:
    """What attaching a question needs: ids, the chip label, the evidence query text."""

    question_id: uuid.UUID
    label: str
    revision_id: uuid.UUID
    query_text: str


@dataclass(frozen=True)
class SessionTarget:
    id: uuid.UUID
    revision_id: uuid.UUID
    displayed_option_ids: list[str]
    submitted: bool


@dataclass(frozen=True)
class AttemptSummary:
    submitted_answer: dict[str, Any]
    result: str


@dataclass(frozen=True)
class AttachmentPin:
    """The attachment as one answer uses it (pinned on the answer message)."""

    kind: str
    disclosure: str
    question_id: uuid.UUID | None = None
    question_revision_id: uuid.UUID | None = None
    practice_session_id: uuid.UUID | None = None
    mock_exam_question_id: uuid.UUID | None = None
    mock_exam_question_revision_id: uuid.UUID | None = None
    mock_practice_session_id: uuid.UUID | None = None
    displayed_option_ids: list[str] = field(default_factory=list)
    selected_option_ids: list[str] = field(default_factory=list)
    attempt: AttemptSummary | None = None
    query_text: str = ""


_CONVERSATION_COLUMNS = """
    c.id, c.workspace_id, c.user_id, c.title, c.scope, c.attachment_kind, c.attachment_view,
    c.attachment_label, c.question_id, c.practice_session_id, c.mock_exam_question_id,
    c.mock_practice_session_id, c.selected_option_ids, c.created_at, c.last_message_at
"""

_MESSAGE_COLUMNS = """
    m.id, m.conversation_id, m.workspace_id, m.user_id, m.role, m.status, m.question_message_id,
    m.retry_of_message_id, m.regenerated_from_message_id, m.text, m.scope, m.disclosure,
    m.attachment_kind, m.selected_option_ids, m.degraded, m.error_code, m.uncited, m.truncated,
    m.dropped_citations, m.job_id, m.created_at, m.finished_at,
    (select f.reason from public.ask_message_feedback f where f.message_id = m.id) as feedback
"""


def _conversation(row: Any) -> ConversationRow:
    return ConversationRow(
        id=row.id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        title=row.title,
        scope=dict(row.scope or {}),
        attachment_kind=row.attachment_kind,
        attachment_view=row.attachment_view,
        attachment_label=row.attachment_label,
        question_id=row.question_id,
        practice_session_id=row.practice_session_id,
        mock_exam_question_id=row.mock_exam_question_id,
        mock_practice_session_id=row.mock_practice_session_id,
        selected_option_ids=list(row.selected_option_ids or []),
        created_at=row.created_at,
        last_message_at=row.last_message_at,
    )


def _message(row: Any) -> MessageRow:
    return MessageRow(
        id=row.id,
        conversation_id=row.conversation_id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        role=row.role,
        status=row.status,
        question_message_id=row.question_message_id,
        retry_of_message_id=row.retry_of_message_id,
        regenerated_from_message_id=row.regenerated_from_message_id,
        text=row.text,
        scope=dict(row.scope or {}),
        disclosure=row.disclosure,
        attachment_kind=row.attachment_kind,
        selected_option_ids=list(row.selected_option_ids or []),
        degraded=list(row.degraded or []),
        error_code=row.error_code,
        uncited=bool(row.uncited),
        truncated=bool(row.truncated),
        dropped_citations=int(row.dropped_citations),
        job_id=row.job_id,
        created_at=row.created_at,
        finished_at=row.finished_at,
        feedback=row.feedback,
    )


class AskRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- conversations ---------------------------------------------------------------------------

    def conversation(
        self, conversation_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> ConversationRow | None:
        row = self._session.execute(
            text(
                f"select {_CONVERSATION_COLUMNS} from public.ask_conversations c "  # noqa: S608
                "where c.id = :c and c.user_id = :u" + (" for update" if lock else "")
            ),
            {"c": conversation_id, "u": user_id},
        ).one_or_none()
        return _conversation(row) if row is not None else None

    def list_conversations(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> list[ConversationRow]:
        cursor = "and (c.last_message_at, c.id) < (:at, :id)" if after else ""
        rows = self._session.execute(
            text(
                f"select {_CONVERSATION_COLUMNS} from public.ask_conversations c "  # noqa: S608
                f"where c.workspace_id = :w and c.user_id = :u {cursor} "
                # Nobody asked here yet (질문하기 creates it before a question): not listed; its
                # link still opens it (user decision 2026-11-03).
                "and exists (select 1 from public.ask_messages m where m.conversation_id = c.id) "
                "order by c.last_message_at desc, c.id desc limit :n"
            ),
            {
                "w": workspace_id,
                "u": user_id,
                "n": limit,
                "at": after[0] if after else None,
                "id": after[1] if after else None,
            },
        )
        return [_conversation(r) for r in rows]

    def create_conversation(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        scope: Mapping[str, Any],
        kind: str | None,
        view: str | None,
        label: str | None,
        question_id: uuid.UUID | None,
        practice_session_id: uuid.UUID | None,
        mock_exam_question_id: uuid.UUID | None,
        mock_practice_session_id: uuid.UUID | None,
        selected_option_ids: Sequence[str],
    ) -> uuid.UUID:
        new_id: uuid.UUID = self._session.execute(
            text(
                "insert into public.ask_conversations (workspace_id, user_id, scope, "
                "attachment_kind, attachment_view, attachment_label, question_id, "
                "practice_session_id, mock_exam_question_id, mock_practice_session_id, "
                "selected_option_ids) values (:w, :u, cast(:scope as jsonb), :kind, :view, "
                ":label, :q, :ps, :mq, :mps, :sel) returning id"
            ),
            {
                "w": workspace_id,
                "u": user_id,
                "scope": _json(dict(scope)),
                "kind": kind,
                "view": view,
                "label": label,
                "q": question_id,
                "ps": practice_session_id,
                "mq": mock_exam_question_id,
                "mps": mock_practice_session_id,
                "sel": list(selected_option_ids),
            },
        ).scalar_one()
        return new_id

    def delete_conversation(self, conversation_id: uuid.UUID) -> None:
        self._session.execute(
            text("delete from public.ask_conversations where id = :c"), {"c": conversation_id}
        )

    def clear_attachment(self, conversation_id: uuid.UUID) -> None:
        self._session.execute(
            text(
                "update public.ask_conversations set attachment_kind = null, "
                "attachment_view = null, attachment_label = null, question_id = null, "
                "practice_session_id = null, mock_exam_question_id = null, "
                "mock_practice_session_id = null, selected_option_ids = '{}' where id = :c"
            ),
            {"c": conversation_id},
        )

    def touch(
        self,
        conversation_id: uuid.UUID,
        *,
        title: str | None,
        scope: Mapping[str, Any] | None,
        selected_option_ids: Sequence[str] | None,
    ) -> None:
        self._session.execute(
            text(
                "update public.ask_conversations set last_message_at = now(), "
                "title = coalesce(title, :title), "
                "scope = coalesce(cast(:scope as jsonb), scope), "
                "selected_option_ids = coalesce(cast(:sel as text[]), selected_option_ids) "
                "where id = :c"
            ),
            {
                "c": conversation_id,
                "title": title,
                "scope": _json(dict(scope)) if scope is not None else None,
                "sel": list(selected_option_ids) if selected_option_ids is not None else None,
            },
        )

    # --- messages --------------------------------------------------------------------------------

    def messages(self, conversation_id: uuid.UUID) -> list[MessageRow]:
        rows = self._session.execute(
            text(
                f"select {_MESSAGE_COLUMNS} from public.ask_messages m "  # noqa: S608
                # A question and its answer share `created_at` (one transaction): the question
                # comes first, whatever their ids.
                "where m.conversation_id = :c "
                "order by m.created_at, (m.role = 'assistant'), m.id"
            ),
            {"c": conversation_id},
        )
        return [_message(r) for r in rows]

    def message(
        self, message_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
    ) -> MessageRow | None:
        row = self._session.execute(
            text(
                f"select {_MESSAGE_COLUMNS} from public.ask_messages m "  # noqa: S608
                "where m.id = :m and m.user_id = :u" + (" for update of m" if lock else "")
            ),
            {"m": message_id, "u": user_id},
        ).one_or_none()
        return _message(row) if row is not None else None

    def sources(self, message_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[SourceRow]]:
        if not message_ids:
            return {}
        rows = self._session.execute(
            text(
                "select s.message_id, s.tag, s.rank, s.document_id, d.title as document_title, "
                "d.document_type, s.revision_id, s.chapter_id, ch.title as chapter_title, "
                "s.block_ids, s.page_from, s.page_to, s.cited, s.number, "
                "(d.deleted_at is not null or d.active_revision_id is distinct from s.revision_id)"
                " as outdated "
                "from public.ask_message_sources s "
                "join public.documents d on d.id = s.document_id "
                "and d.workspace_id = s.workspace_id "
                "left join public.chapters ch on ch.id = s.chapter_id "
                "where s.message_id = any(:ids) order by s.message_id, s.tag"
            ),
            {"ids": list(message_ids)},
        )
        out: dict[uuid.UUID, list[SourceRow]] = {}
        for r in rows:
            out.setdefault(r.message_id, []).append(
                SourceRow(
                    message_id=r.message_id,
                    tag=r.tag,
                    rank=r.rank,
                    document_id=r.document_id,
                    document_title=r.document_title,
                    document_type=r.document_type,
                    revision_id=r.revision_id,
                    chapter_id=r.chapter_id,
                    chapter_title=r.chapter_title,
                    block_ids=list(r.block_ids),
                    page_from=r.page_from,
                    page_to=r.page_to,
                    cited=bool(r.cited),
                    number=r.number,
                    outdated=bool(r.outdated),
                )
            )
        return out

    def question_count(self, conversation_id: uuid.UUID) -> int:
        count: int = self._session.execute(
            text(
                "select count(*) from public.ask_messages "
                "where conversation_id = :c and role = 'user'"
            ),
            {"c": conversation_id},
        ).scalar_one()
        return count

    def running_answer(self, user_id: uuid.UUID) -> bool:
        return bool(
            self._session.execute(
                text(
                    "select exists (select 1 from public.ask_messages where user_id = :u "
                    "and role = 'assistant' and status in ('queued', 'retrieving', 'streaming'))"
                ),
                {"u": user_id},
            ).scalar_one()
        )

    def answers_on(self, user_id: uuid.UUID, day: date) -> int:
        """Answers accepted for the user on an Asia/Seoul `day` (ask_daily_counts, written by a
        trigger on every answer and kept when conversations are deleted — user decision
        2026-11-02)."""
        count: int | None = self._session.execute(
            text("select answers from public.ask_daily_counts where user_id = :u and day = :d"),
            {"u": user_id, "d": day},
        ).scalar_one_or_none()
        return count or 0

    def tokens_since(self, since: datetime) -> int:
        total: int = self._session.execute(
            text(
                "select coalesce(sum(input_tokens + output_tokens + cache_read_tokens + "
                "cache_creation_tokens), 0) from public.llm_feature_usage "
                "where feature = 'ask' and created_at >= :t"
            ),
            {"t": since},
        ).scalar_one()
        return int(total)

    def answer_versions(self, question_message_id: uuid.UUID) -> int:
        count: int = self._session.execute(
            text(
                "select count(*) from public.ask_messages "
                "where question_message_id = :q and role = 'assistant'"
            ),
            {"q": question_message_id},
        ).scalar_one()
        return count

    def last_question_id(self, conversation_id: uuid.UUID) -> uuid.UUID | None:
        found: uuid.UUID | None = self._session.execute(
            text(
                "select id from public.ask_messages where conversation_id = :c and role = 'user' "
                "order by created_at desc, id desc limit 1"
            ),
            {"c": conversation_id},
        ).scalar_one_or_none()
        return found

    def insert_question(
        self, conversation: ConversationRow, question: str, scope: Mapping[str, Any]
    ) -> uuid.UUID:
        new_id: uuid.UUID = self._session.execute(
            text(
                "insert into public.ask_messages (conversation_id, workspace_id, user_id, role, "
                "status, text, scope) values (:c, :w, :u, 'user', 'succeeded', :t, "
                "cast(:scope as jsonb)) returning id"
            ),
            {
                "c": conversation.id,
                "w": conversation.workspace_id,
                "u": conversation.user_id,
                "t": question,
                "scope": _json(dict(scope)),
            },
        ).scalar_one()
        return new_id

    def insert_answer(
        self,
        conversation: ConversationRow,
        *,
        question_message_id: uuid.UUID,
        scope: Mapping[str, Any],
        pin: AttachmentPin | None,
        context_char_limit: int,
        degraded: Sequence[str],
        retry_of: uuid.UUID | None = None,
        regenerated_from: uuid.UUID | None = None,
    ) -> tuple[uuid.UUID, uuid.UUID]:
        """The queued answer and its `ask.answer` job (one transaction with the caller)."""
        answer_id = uuid.uuid4()
        job_id = uuid.uuid4()
        self._session.execute(
            text(
                "insert into public.async_jobs (id, workspace_id, created_by, job_type, "
                "schema_version, payload, max_attempts) values (:j, :w, :u, :t, :v, "
                "cast(:p as jsonb), :a)"
            ),
            {
                "j": job_id,
                "w": conversation.workspace_id,
                "u": conversation.user_id,
                "t": ASK_JOB_TYPE,
                "v": ASK_JOB_SCHEMA_VERSION,
                "p": _json({"message_id": str(answer_id)}),
                "a": ASK_JOB_MAX_ATTEMPTS,
            },
        )
        attempt = pin.attempt if pin is not None else None
        self._session.execute(
            text(
                "insert into public.ask_messages (id, conversation_id, workspace_id, user_id, "
                "role, status, question_message_id, retry_of_message_id, "
                "regenerated_from_message_id, scope, disclosure, attachment_kind, question_id, "
                "question_revision_id, practice_session_id, mock_exam_question_id, "
                "mock_exam_question_revision_id, mock_practice_session_id, selected_option_ids, "
                "displayed_option_ids, submitted_answer, attempt_result, context_char_limit, "
                "degraded, job_id) values (:id, :c, :w, :u, 'assistant', 'queued', :q, :retry, "
                ":regen, cast(:scope as jsonb), :disclosure, :kind, :qid, :qrev, :ps, :mq, "
                ":mqrev, :mps, :sel, :shown, cast(:submitted as jsonb), :result, :limit, "
                ":degraded, :j)"
            ),
            {
                "id": answer_id,
                "c": conversation.id,
                "w": conversation.workspace_id,
                "u": conversation.user_id,
                "q": question_message_id,
                "retry": retry_of,
                "regen": regenerated_from,
                "scope": _json(dict(scope)),
                "disclosure": pin.disclosure if pin is not None else "none",
                "kind": pin.kind if pin is not None else None,
                "qid": pin.question_id if pin else None,
                "qrev": pin.question_revision_id if pin else None,
                "ps": pin.practice_session_id if pin else None,
                "mq": pin.mock_exam_question_id if pin else None,
                "mqrev": pin.mock_exam_question_revision_id if pin else None,
                "mps": pin.mock_practice_session_id if pin else None,
                "sel": list(pin.selected_option_ids) if pin else [],
                "shown": list(pin.displayed_option_ids) if pin else [],
                "submitted": _json(attempt.submitted_answer) if attempt else None,
                "result": attempt.result if attempt else None,
                "limit": context_char_limit,
                "degraded": list(degraded),
                "j": job_id,
            },
        )
        return answer_id, job_id

    def insert_sources(
        self, message_id: uuid.UUID, workspace_id: uuid.UUID, sources: Sequence[Any]
    ) -> None:
        for tag, source in enumerate(sources, start=1):
            self._session.execute(
                text(
                    "insert into public.ask_message_sources (message_id, tag, rank, workspace_id, "
                    "document_id, revision_id, chapter_id, block_ids, matched_block_ids, "
                    "page_from, page_to, chunk_id, score, score_type) values (:m, :tag, :rank, "
                    ":w, :d, :r, :ch, :blocks, :matched, :pf, :pt, :chunk, :score, :st)"
                ),
                {
                    "m": message_id,
                    "tag": tag,
                    "rank": source.rank,
                    "w": workspace_id,
                    "d": source.document_id,
                    "r": source.revision_id,
                    "ch": source.chapter_id,
                    "blocks": list(source.block_ids),
                    "matched": list(source.matched_block_ids),
                    "pf": source.page_from,
                    "pt": source.page_to,
                    "chunk": source.chunk_id,
                    "score": source.score,
                    "st": source.score_type,
                },
            )

    def cancel(self, message_id: uuid.UUID, partial_text: str) -> None:
        self._session.execute(
            text(
                "update public.ask_messages set status = 'stopped', text = :t, finished_at = now() "
                "where id = :m and status in ('queued', 'retrieving', 'streaming')"
            ),
            {"m": message_id, "t": partial_text[:50000]},
        )

    def set_feedback(self, message_id: uuid.UUID, user_id: uuid.UUID, reason: str) -> None:
        self._session.execute(
            text(
                "insert into public.ask_message_feedback (message_id, user_id, reason) "
                "values (:m, :u, :r) "
                "on conflict (message_id) do update set reason = excluded.reason"
            ),
            {"m": message_id, "u": user_id, "r": reason},
        )

    # --- attachments (no answer columns) ----------------------------------------------------------

    def bank_question(self, workspace_id: uuid.UUID, question_id: uuid.UUID) -> AttachTarget | None:
        """A live (not deleted) question of this workspace, any publication status."""
        row = self._session.execute(
            text(
                "select q.id, q.question_number, q.active_revision_id, ch.title as chapter_title, "
                "r.stem, r.options from public.questions q "
                "join public.question_revisions r on r.id = q.active_revision_id "
                "and r.question_id = q.id "
                "left join public.chapters ch on ch.id = q.chapter_id "
                "where q.id = :q and q.workspace_id = :w and q.deleted_at is null"
            ),
            {"q": question_id, "w": workspace_id},
        ).one_or_none()
        if row is None:
            return None
        head = " ".join(
            p
            for p in (
                chapter_short(row.chapter_title),
                f"{row.question_number}번" if row.question_number is not None else None,
            )
            if p
        )
        label = f"{head} · {stem_head(row.stem)}" if head else stem_head(row.stem)
        return AttachTarget(
            question_id=row.id,
            label=label,
            revision_id=row.active_revision_id,
            query_text=_query_text(row.stem, row.options),
        )

    def revision_query_text(self, revision_id: uuid.UUID, *, mock: bool) -> str:
        table = "mock_exam_question_revisions" if mock else "question_revisions"
        row = self._session.execute(
            text(f"select stem, options from public.{table} where id = :r"),  # noqa: S608
            {"r": revision_id},
        ).one_or_none()
        return _query_text(row.stem, row.options) if row is not None else ""

    def bank_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, question_id: uuid.UUID
    ) -> SessionTarget | None:
        """The caller's own practice session of that question."""
        row = self._session.execute(
            text(
                "select s.id, s.question_revision_id, s.displayed_option_ids, exists (select 1 "
                "from public.question_attempts a where a.practice_session_id = s.id "
                "and a.user_id = s.user_id) as submitted from public.practice_sessions s "
                "where s.id = :s and s.user_id = :u and s.question_id = :q "
                "and not exists (select 1 from public.practice_reset_epochs e "
                "where e.user_id = s.user_id and e.question_id = s.question_id "
                "and e.epoch > s.reset_epoch)"
            ),
            {"s": session_id, "u": user_id, "q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return SessionTarget(
            row.id, row.question_revision_id, list(row.displayed_option_ids or []), row.submitted
        )

    def bank_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> AttemptSummary | None:
        """The caller's submission of the session and its current result (a grade of a pending
        answer is a later attempt)."""
        row = self._session.execute(
            text(
                "select (select a.submitted_answer from public.question_attempts a "
                "where a.practice_session_id = :s and a.user_id = :u "
                "and exists (select 1 from public.practice_sessions s "
                "where s.id = a.practice_session_id "
                "and not exists (select 1 from public.practice_reset_epochs e "
                "where e.user_id = s.user_id "
                "and e.question_id = s.question_id and e.epoch > s.reset_epoch)) "
                "and a.grades_attempt_id is null "
                "order by a.submitted_at, a.id limit 1) as submitted_answer, "
                "(select a.result from public.question_attempts a "
                "where a.practice_session_id = :s and a.user_id = :u "
                "and exists (select 1 from public.practice_sessions s "
                "where s.id = a.practice_session_id "
                "and not exists (select 1 from public.practice_reset_epochs e "
                "where e.user_id = s.user_id "
                "and e.question_id = s.question_id and e.epoch > s.reset_epoch)) "
                "order by a.submitted_at desc, a.id desc limit 1) as result"
            ),
            {"s": session_id, "u": user_id},
        ).one()
        if row.submitted_answer is None or row.result is None:
            return None
        return AttemptSummary(dict(row.submitted_answer), row.result)

    def mock_question(self, workspace_id: uuid.UUID, question_id: uuid.UUID) -> AttachTarget | None:
        """A mock exam question still in its live mock exam (MOCK-P's visibility)."""
        row = self._session.execute(
            text(
                "select q.id, q.position, q.active_revision_id, r.stem, r.options "
                "from public.mock_exam_questions q "
                "join public.mock_exams e on e.id = q.mock_exam_id "
                "and e.workspace_id = q.workspace_id "
                "join public.mock_exam_question_revisions r on r.id = q.active_revision_id "
                "and r.mock_exam_question_id = q.id "
                "where q.id = :q and q.workspace_id = :w and q.removed_at is null "
                "and e.deleted_at is null"
            ),
            {"q": question_id, "w": workspace_id},
        ).one_or_none()
        if row is None:
            return None
        return AttachTarget(
            question_id=row.id,
            label=f"문제 {row.position + 1} · {stem_head(row.stem)}",
            revision_id=row.active_revision_id,
            query_text=_query_text(row.stem, row.options),
        )

    def mock_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, question_id: uuid.UUID
    ) -> SessionTarget | None:
        row = self._session.execute(
            text(
                "select s.id, s.mock_exam_question_revision_id as revision_id, "
                "s.displayed_option_ids, exists (select 1 from public.mock_exam_attempts a "
                "where a.practice_session_id = s.id and a.user_id = s.user_id) as submitted "
                "from public.mock_exam_practice_sessions s "
                "where s.id = :s and s.user_id = :u and s.mock_exam_question_id = :q"
            ),
            {"s": session_id, "u": user_id, "q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return SessionTarget(
            row.id, row.revision_id, list(row.displayed_option_ids or []), row.submitted
        )

    def mock_attempt(self, session_id: uuid.UUID, user_id: uuid.UUID) -> AttemptSummary | None:
        """The caller's submission of the session and its current result (a grade of a pending
        answer is a later attempt)."""
        row = self._session.execute(
            text(
                "select (select a.submitted_answer from public.mock_exam_attempts a "
                "where a.practice_session_id = :s and a.user_id = :u "
                "and a.grades_attempt_id is null "
                "order by a.submitted_at, a.id limit 1) as submitted_answer, "
                "(select a.result from public.mock_exam_attempts a "
                "where a.practice_session_id = :s and a.user_id = :u "
                "order by a.submitted_at desc, a.id desc limit 1) as result"
            ),
            {"s": session_id, "u": user_id},
        ).one()
        if row.submitted_answer is None or row.result is None:
            return None
        return AttemptSummary(dict(row.submitted_answer), row.result)


def _query_text(stem: str, options: Any) -> str:
    texts = [str(o.get("text", "")) for o in options or [] if isinstance(o, dict)]
    return " ".join([stem, *texts])
