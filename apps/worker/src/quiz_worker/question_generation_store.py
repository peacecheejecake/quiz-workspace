"""Generation runs, their source question and drafts as the `question.generate` job sees them
(M6.2), on the `quiz_worker` role.

Grants (supabase/migrations/20261018150000_question_generation_worker.sql): the worker reads runs
and moves their state (`status`, `finished_at`, model/prompt provenance, the passages it used),
reads the workspace's questions/revisions/sources, reads generation drafts and inserts *pending*
ones. It never updates or deletes a draft and never writes a question: review, edits and
publishing are the API's.

Idempotency: drafts are keyed by `(generation_run_id, position)` (unique) and are written in the
same transaction that marks the run `succeeded`, so a run either has all of one attempt's drafts
or none; a redelivered job of a succeeded run does nothing, and an insert never touches an
existing (possibly reviewed) draft.

Job fencing: every state write is conditioned on `async_job_id = <this job>`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from sqlalchemy import Connection, Engine, text

from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.errors import NonRetryableJobError
from quiz_worker.run_lock import advisory_run_lock

JOB_TYPE = "question.generate"

TerminalRunStatus = Literal["failed", "cancelled"]


class RunSupersededError(NonRetryableJobError):
    """The run points at another job or finished meanwhile."""

    code = "generation_superseded"


@dataclass(frozen=True)
class GenerationRunRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    status: str
    async_job_id: uuid.UUID | None
    source_question_id: uuid.UUID
    source_revision_id: uuid.UUID
    variation_types: tuple[str, ...]
    candidate_count: int
    params: dict[str, Any]


@dataclass(frozen=True)
class SourceRow:
    """One `question_sources` row of the source question."""

    document_id: uuid.UUID | None
    document_revision_id: uuid.UUID | None
    page_start: int | None
    page_end: int | None
    block_ids: tuple[str, ...]
    locations: list[dict[str, Any]]


@dataclass(frozen=True)
class SourceQuestionRow:
    """The pinned source revision of a live question."""

    question_id: uuid.UUID
    revision_id: uuid.UUID
    question_type: str
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    sources: tuple[SourceRow, ...]


@dataclass(frozen=True)
class QuestionContentRow:
    """The active revision of a live question (for duplicate fingerprints)."""

    question_type: str
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None


@dataclass(frozen=True)
class LiveDocument:
    id: uuid.UUID
    active_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class GenerationDraftRow:
    """One `question_drafts` row the job writes (source_type `generation`, review `pending`)."""

    position: int
    question_type: str
    is_multi_answer: bool
    payload: dict[str, Any]
    validations: list[dict[str, Any]]


class GenerationStore(Protocol):
    def run_lock(
        self, run_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]: ...

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> GenerationRunRow | None: ...

    def load_source(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, revision_id: uuid.UUID
    ) -> SourceQuestionRow | None:
        """The pinned revision when the question is still live (not soft-deleted)."""
        ...

    def live_documents(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> list[LiveDocument]: ...

    def workspace_questions(self, workspace_id: uuid.UUID) -> list[QuestionContentRow]: ...

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool: ...

    def mark_running(self, run_id: uuid.UUID, job_id: uuid.UUID) -> None: ...

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[GenerationDraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        passages: list[dict[str, Any]],
        before_commit: Callable[[], None],
    ) -> int:
        """In one transaction: re-check (and lock) workspace access, insert the drafts whose
        position has none yet, record the provenance and mark the run `succeeded`."""
        ...

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None: ...

    def report_progress(
        self, job_id: uuid.UUID, attempt: int, stage: str, percent: int
    ) -> None: ...

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None: ...


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


_RUN = text(
    """
    select id, workspace_id, created_by, status, async_job_id, source_question_id,
           source_question_revision_id, variation_types, candidate_count, params
      from public.question_generation_runs
     where id = :run_id and workspace_id = :workspace_id
    """
)

_SOURCE = text(
    """
    select q.id, q.question_type, r.id as revision_id, r.stem, r.options, r.correct_option_ids,
           r.accepted_answers, r.is_multi_answer, r.explanation
      from public.questions q
      join public.question_revisions r
        on r.question_id = q.id and r.workspace_id = q.workspace_id
     where q.workspace_id = :workspace_id and q.id = :question_id and r.id = :revision_id
       and q.deleted_at is null
    """
)

_SOURCES = text(
    """
    select document_id, document_revision_id, page_start, page_end, block_ids, locations
      from public.question_sources
     where workspace_id = :workspace_id and question_id = :question_id
     order by created_at, id
    """
)

_QUESTIONS = text(
    """
    select q.question_type, r.stem, r.options, r.correct_option_ids, r.accepted_answers
      from public.questions q
      join public.question_revisions r
        on r.id = q.active_revision_id and r.question_id = q.id
     where q.workspace_id = :workspace_id and q.deleted_at is null
    """
)

_INSERT_DRAFT = text(
    """
    insert into public.question_drafts (workspace_id, source_type, generation_run_id, position,
                                        question_type, is_multi_answer, payload, validations)
    select :workspace_id, 'generation', :run_id, :position, :question_type, :is_multi_answer,
           cast(:payload as jsonb), cast(:validations as jsonb)
     where not exists (select 1 from public.question_drafts
                        where generation_run_id = :run_id and position = :position)
    on conflict do nothing
    """
)


class PostgresGenerationStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def run_lock(
        self, run_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]:
        return advisory_run_lock(
            self._engine,
            f"quiz.question_generation:{run_id}",
            wait_seconds=wait_seconds,
            check=check,
            busy_message="another job is processing this generation run",
        )

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> GenerationRunRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(_RUN, {"run_id": run_id, "workspace_id": workspace_id})
                .mappings()
                .first()
            )
        if row is None:
            return None
        return GenerationRunRow(
            id=row["id"],
            workspace_id=row["workspace_id"],
            created_by=row["created_by"],
            status=row["status"],
            async_job_id=row["async_job_id"],
            source_question_id=row["source_question_id"],
            source_revision_id=row["source_question_revision_id"],
            variation_types=tuple(row["variation_types"]),
            candidate_count=int(row["candidate_count"]),
            params=dict(row["params"] or {}),
        )

    def load_source(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, revision_id: uuid.UUID
    ) -> SourceQuestionRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    _SOURCE,
                    {
                        "workspace_id": workspace_id,
                        "question_id": question_id,
                        "revision_id": revision_id,
                    },
                )
                .mappings()
                .first()
            )
            if row is None:
                return None
            sources = [
                SourceRow(
                    document_id=s["document_id"],
                    document_revision_id=s["document_revision_id"],
                    page_start=s["page_start"],
                    page_end=s["page_end"],
                    block_ids=tuple(s["block_ids"] or ()),
                    locations=list(s["locations"] or []),
                )
                for s in conn.execute(
                    _SOURCES, {"workspace_id": workspace_id, "question_id": question_id}
                ).mappings()
            ]
        return SourceQuestionRow(
            question_id=row["id"],
            revision_id=row["revision_id"],
            question_type=row["question_type"],
            stem=row["stem"],
            options=list(row["options"] or []),
            correct_option_ids=list(row["correct_option_ids"])
            if row["correct_option_ids"] is not None
            else None,
            accepted_answers=list(row["accepted_answers"])
            if row["accepted_answers"] is not None
            else None,
            is_multi_answer=bool(row["is_multi_answer"]),
            explanation=row["explanation"],
            sources=tuple(sources),
        )

    def live_documents(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> list[LiveDocument]:
        ids = list(dict.fromkeys(document_ids))
        if not ids:
            return []
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    "select id, active_revision_id from public.documents "
                    "where workspace_id = :w and id = any(:ids) and deleted_at is null"
                ),
                {"w": workspace_id, "ids": ids},
            ).all()
        found = {r.id: LiveDocument(r.id, r.active_revision_id) for r in rows}
        return [found[i] for i in ids if i in found]

    def workspace_questions(self, workspace_id: uuid.UUID) -> list[QuestionContentRow]:
        with self._engine.begin() as conn:
            rows = conn.execute(_QUESTIONS, {"workspace_id": workspace_id}).mappings().all()
        return [
            QuestionContentRow(
                question_type=r["question_type"],
                stem=r["stem"],
                options=list(r["options"] or []),
                correct_option_ids=list(r["correct_option_ids"])
                if r["correct_option_ids"] is not None
                else None,
                accepted_answers=list(r["accepted_answers"])
                if r["accepted_answers"] is not None
                else None,
            )
            for r in rows
        ]

    @staticmethod
    def _writable(
        conn: Connection, workspace_id: uuid.UUID, user_id: uuid.UUID | None, *, lock: bool
    ) -> bool:
        # supabase/migrations/20261017230000_worker_workspace_access.sql
        return bool(
            conn.execute(
                text("select public.worker_workspace_writable(:w, :u, :l)"),
                {"w": workspace_id, "u": user_id, "l": lock},
            ).scalar_one()
        )

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        with self._engine.begin() as conn:
            return self._writable(conn, workspace_id, user_id, lock=False)

    def mark_running(self, run_id: uuid.UUID, job_id: uuid.UUID) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.question_generation_runs set status = 'running', "
                    "finished_at = null where id = :r and async_job_id = :j "
                    "and status in ('queued', 'running')"
                ),
                {"r": run_id, "j": job_id},
            )

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[GenerationDraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        passages: list[dict[str, Any]],
        before_commit: Callable[[], None],
    ) -> int:
        with self._engine.begin() as conn:
            # Workspace first (FOR SHARE): an archive/delete/membership change commits before
            # this check or waits for this transaction.
            if not self._writable(conn, workspace_id, user_id, lock=True):
                raise WorkspaceUnavailableError("the workspace is no longer writable")
            current = conn.execute(
                text(
                    "select status, async_job_id from public.question_generation_runs "
                    "where id = :r for update"
                ),
                {"r": run_id},
            ).one()
            if current.async_job_id != job_id or current.status not in {"queued", "running"}:
                raise RunSupersededError("the generation run moved on to another job")
            created = 0
            for draft in drafts:
                result = conn.execute(
                    _INSERT_DRAFT,
                    {
                        "workspace_id": workspace_id,
                        "run_id": run_id,
                        "position": draft.position,
                        "question_type": draft.question_type,
                        "is_multi_answer": draft.is_multi_answer,
                        "payload": _json(draft.payload),
                        "validations": _json(draft.validations),
                    },
                )
                created += result.rowcount or 0
            conn.execute(
                text(
                    "update public.question_generation_runs set status = 'succeeded', "
                    "finished_at = now(), llm_model = :m, prompt_version = :p, "
                    "passages = cast(:passages as jsonb) where id = :r"
                ),
                {"r": run_id, "m": llm_model, "p": prompt_version, "passages": _json(passages)},
            )
            before_commit()
        return created

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.question_generation_runs set status = :s, finished_at = now() "
                    "where id = :r and async_job_id = :j and status in ('queued', 'running')"
                ),
                {"r": run_id, "j": job_id, "s": status},
            )

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.async_jobs "
                    "set result = jsonb_build_object('progress', jsonb_build_object("
                    "      'stage', cast(:s as text), 'percent', cast(:p as int))) "
                    "where id = :j and status = 'running' and attempts = :a"
                ),
                {"j": job_id, "a": attempt, "s": stage, "p": percent},
            )

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        with self._engine.begin() as conn:
            payload = conn.execute(
                text("select payload from public.async_jobs where id = :j"), {"j": job_id}
            ).scalar_one_or_none()
        return dict(payload) if isinstance(payload, dict) else None
