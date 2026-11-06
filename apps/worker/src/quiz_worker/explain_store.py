"""AI explanations as the `question.ai_explain` job sees them (EXPL-B), on the `quiz_worker` role,
plus their Redis Stream.

Grants (supabase/migrations/20261104120000_ai_explanations.sql): the worker reads both
explanation tables and moves an unfinished row through `running` to `succeeded` / `failed`
(status, body, cited source numbers, error code) and supersedes the previous success of the key;
it writes `llm_feature_usage` (`feature = ai_explanation`, `ref_id`). The question content comes
from the revision the row is keyed on (bank `question_revisions` / `mock_exam_question_revisions`,
earlier migrations); passages from `content_blocks` through the ask store's readers. It never
reads practice sessions or attempts: an explanation has no user answer in its input (C04).

The finish write locks the row, re-checks that it is still running, that its creator is still a
member of the active workspace (`worker_ask_member_active`, row locks until commit) and that every
pinned passage revision is still its document's published one; it then supersedes the previous
success, stores the body and the cited source numbers and records usage in one transaction.
Nothing here logs question, passage or explanation text.

Redis Stream `explain:<explanation id>`: the ask stream's layout (`quiz_worker.ask_store`,
`AskStreamWriter` with this prefix); a delta's data is `{seq, text}` with `seq` counting deltas
from 0 (again from 0 after a `reset`).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from book_core.explain import ExplainQuestion, explain_question
from sqlalchemy import Connection, Engine, text

from quiz_worker.ask_store import LiveDocument, PostgresAskStore, Usage

JOB_TYPE = "question.ai_explain"
STREAM_KEY_PREFIX = "explain:"
LIVE = ("queued", "running")
TERMINAL = frozenset({"succeeded", "failed"})
KINDS = ("question", "mock_exam_question")


@dataclass(frozen=True)
class _Table:
    name: str
    target: str
    revision: str


_TABLES = {
    "question": _Table("question_ai_explanations", "question_id", "question_revision_id"),
    "mock_exam_question": _Table(
        "mock_exam_question_ai_explanations",
        "mock_exam_question_id",
        "mock_exam_question_revision_id",
    ),
}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class PinnedPassage:
    tag: int
    document_id: uuid.UUID
    revision_id: uuid.UUID
    chapter_id: uuid.UUID | None
    block_ids: list[str]
    page_from: int
    page_to: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


@dataclass(frozen=True)
class ExplanationRow:
    id: uuid.UUID
    kind: str
    workspace_id: uuid.UUID
    target_id: uuid.UUID
    revision_id: uuid.UUID
    status: str
    version: int
    job_id: uuid.UUID | None
    created_by: uuid.UUID | None
    prompt_version: str
    model: str
    sources: list[PinnedPassage]

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL


@dataclass(frozen=True)
class FinishOutcome:
    written: bool
    error_code: str | None = None


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _pinned(raw: Any) -> list[PinnedPassage]:
    out: list[PinnedPassage] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        document_id, revision_id = (
            _uuid(item.get("document_id")),
            _uuid(item.get("document_revision_id")),
        )
        tag, page_from, page_to = item.get("tag"), item.get("page_from"), item.get("page_to")
        if document_id is None or revision_id is None or not isinstance(tag, int):
            continue
        if not isinstance(page_from, int) or not isinstance(page_to, int):
            continue
        blocks = [b for b in item.get("block_ids") or [] if isinstance(b, str)]
        out.append(
            PinnedPassage(
                tag,
                document_id,
                revision_id,
                _uuid(item.get("chapter_id")),
                blocks,
                page_from,
                page_to,
                dict(item),
            )
        )
    return out


class PostgresExplainStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine
        self.passages = PostgresAskStore(engine)

    # --- the row -----------------------------------------------------------------------------

    def load(self, kind: str, explanation_id: uuid.UUID) -> ExplanationRow | None:
        table = _TABLES.get(kind)
        if table is None:
            return None
        with self._engine.connect() as conn:
            row = conn.execute(
                text(
                    f"select id, workspace_id, {table.target} as target_id, "  # noqa: S608
                    f"{table.revision} as revision_id, status, version, job_id, created_by, "
                    f"prompt_version, model, sources from public.{table.name} where id = :e"
                ),
                {"e": explanation_id},
            ).one_or_none()
        if row is None:
            return None
        return ExplanationRow(
            id=row.id,
            kind=kind,
            workspace_id=row.workspace_id,
            target_id=row.target_id,
            revision_id=row.revision_id,
            status=row.status,
            version=row.version,
            job_id=row.job_id,
            created_by=row.created_by,
            prompt_version=row.prompt_version,
            model=row.model,
            sources=_pinned(row.sources),
        )

    def for_job(self, job_id: uuid.UUID) -> ExplanationRow | None:
        with self._engine.connect() as conn:
            for kind, table in _TABLES.items():
                found: uuid.UUID | None = conn.execute(
                    text(f"select id from public.{table.name} where job_id = :j"),  # noqa: S608
                    {"j": job_id},
                ).scalar_one_or_none()
                if found is not None:
                    return self.load(kind, found)
        return None

    def status(self, row: ExplanationRow) -> str | None:
        table = _TABLES[row.kind]
        with self._engine.connect() as conn:
            found: str | None = conn.execute(
                text(f"select status from public.{table.name} where id = :e"),  # noqa: S608
                {"e": row.id},
            ).scalar_one_or_none()
        return found

    def start(self, row: ExplanationRow) -> bool:
        """queued/running -> running; False when it is no longer live."""
        table = _TABLES[row.kind]
        with self._engine.begin() as conn:
            done = conn.execute(
                text(
                    f"update public.{table.name} set status = 'running', "  # noqa: S608
                    "started_at = coalesce(started_at, now()) "
                    "where id = :e and status in ('queued', 'running')"
                ),
                {"e": row.id},
            )
        return bool(done.rowcount)

    def member_active(self, row: ExplanationRow) -> bool:
        if row.created_by is None:
            return False
        return self.passages.member_active(row.workspace_id, row.created_by)

    # --- input -------------------------------------------------------------------------------

    def question(self, row: ExplanationRow) -> ExplainQuestion | None:
        """The keyed revision of a live question (bank: not deleted; mock: still in its live mock
        exam). Content only; nothing about any user."""
        with self._engine.connect() as conn:
            if row.kind == "question":
                found = conn.execute(
                    text(
                        "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                        "r.accepted_answers, r.rubric "
                        "from public.question_revisions r "
                        "join public.questions q on q.id = r.question_id "
                        "where r.id = :r and q.id = :q and q.workspace_id = :w "
                        "and q.deleted_at is null"
                    ),
                    {"r": row.revision_id, "q": row.target_id, "w": row.workspace_id},
                ).one_or_none()
            else:
                found = conn.execute(
                    text(
                        "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                        "r.accepted_answers, r.rubric "
                        "from public.mock_exam_question_revisions r "
                        "join public.mock_exam_questions q on q.id = r.mock_exam_question_id "
                        "join public.mock_exams e on e.id = q.mock_exam_id "
                        "where r.id = :r and q.id = :q and q.workspace_id = :w "
                        "and q.removed_at is null and e.deleted_at is null"
                    ),
                    {"r": row.revision_id, "q": row.target_id, "w": row.workspace_id},
                ).one_or_none()
        if found is None:
            return None
        return explain_question(
            kind=row.kind,  # type: ignore[arg-type]
            question_type=found.question_type,
            stem=found.stem,
            options=list(found.options or []),
            correct_option_ids=found.correct_option_ids,
            accepted_answers=found.accepted_answers,
            rubric=found.rubric,
        )

    def documents(
        self, workspace_id: uuid.UUID, ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, LiveDocument]:
        return self.passages.documents(workspace_id, ids)

    # --- writes ------------------------------------------------------------------------------

    def finish(
        self,
        row: ExplanationRow,
        *,
        body: dict[str, Any],
        cited: Sequence[tuple[int, int]],
        truncated: bool,
        dropped_citations: int,
        usage: Usage | None,
    ) -> FinishOutcome:
        """Store the validated explanation after the re-checks (module docstring)."""
        table = _TABLES[row.kind]
        numbers = dict(cited)
        with self._engine.begin() as conn:
            status = conn.execute(
                text(f"select status from public.{table.name} where id = :e for update"),  # noqa: S608
                {"e": row.id},
            ).scalar_one_or_none()
            if status != "running":
                return FinishOutcome(False)
            failure: str | None = None
            if row.created_by is None or not self.passages.member_active(
                row.workspace_id, row.created_by, conn
            ):
                failure = "workspace_unavailable"
            elif not _revisions_current(conn, row.workspace_id, row.sources):
                failure = "sources_unavailable"
            if failure is not None:
                _fail(conn, table, row.id, failure)
                _usage(conn, row, usage, "failed", failure)
                return FinishOutcome(True, failure)
            sources = [
                {**s.raw, "number": numbers[s.tag]} if s.tag in numbers else s.raw
                for s in row.sources
            ]
            # The previous success of the key stops being current in this transaction.
            conn.execute(
                text(
                    f"update public.{table.name} set superseded_at = now() "  # noqa: S608
                    f"where {table.revision} = :r and prompt_version = :pv and model = :m "
                    "and status = 'succeeded' and superseded_at is null and id <> :e"
                ),
                {"r": row.revision_id, "pv": row.prompt_version, "m": row.model, "e": row.id},
            )
            conn.execute(
                text(
                    f"update public.{table.name} set status = 'succeeded', "  # noqa: S608
                    "body = cast(:body as jsonb), sources = cast(:sources as jsonb), "
                    "truncated = :trunc, dropped_citations = :dropped, error_code = null, "
                    "finished_at = now() where id = :e"
                ),
                {
                    "e": row.id,
                    "body": _json(body),
                    "sources": _json(sources),
                    "trunc": truncated,
                    "dropped": dropped_citations,
                },
            )
            _usage(conn, row, usage, "succeeded", None)
        return FinishOutcome(True)

    def fail(self, row: ExplanationRow, code: str, usage: Usage | None = None) -> bool:
        table = _TABLES[row.kind]
        with self._engine.begin() as conn:
            status = conn.execute(
                text(f"select status from public.{table.name} where id = :e for update"),  # noqa: S608
                {"e": row.id},
            ).scalar_one_or_none()
            if status not in LIVE:
                _usage(conn, row, usage, "failed", None)
                return False
            _fail(conn, table, row.id, code)
            _usage(conn, row, usage, "failed", code)
        return True


def _revisions_current(
    conn: Connection, workspace_id: uuid.UUID, pinned: Sequence[PinnedPassage]
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


def _fail(conn: Connection, table: _Table, explanation_id: uuid.UUID, code: str) -> None:
    conn.execute(
        text(
            f"update public.{table.name} set status = 'failed', error_code = :c, "  # noqa: S608
            "started_at = coalesce(started_at, now()), finished_at = now() where id = :e"
        ),
        {"e": explanation_id, "c": code},
    )


def _usage(
    conn: Connection, row: ExplanationRow, usage: Usage | None, status: str, code: str | None
) -> None:
    if usage is None or usage.llm_calls <= 0:
        return
    conn.execute(
        text(
            "insert into public.llm_feature_usage (feature, user_id, workspace_id, ref_id, model, "
            "input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, llm_calls, "
            "cost_usd, status, error_code) values ('ai_explanation', :u, :w, :ref, :model, :i, "
            ":o, :cr, :cc, :calls, :cost, :s, :code)"
        ),
        {
            "u": row.created_by,
            "w": row.workspace_id,
            "ref": row.id,
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
