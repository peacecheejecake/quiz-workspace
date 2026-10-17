"""Import runs and drafts as the `question.import` job sees them (M4.4a), on the `quiz_worker`
role.

Grants (supabase/migrations/20261018100000_question_import_worker.sql): the worker reads runs and
moves their state (`status`, `finished_at`, model/prompt provenance), reads import drafts and
inserts *pending* ones. It never updates or deletes a draft: review, edits and publishing are the
API's, so a job cannot overwrite what a human reviewed.

Reconciliation: drafts are keyed by `(import_run_id, position)` (unique). Every write inserts only
positions that have no draft yet, so a retried job (or a redelivered attempt) keeps the drafts a
failed attempt persisted (and any review of them) and adds the missing ones; the extraction of a
run is deterministic (it reads the revision pinned on the run), so a kept draft is what the retry
would have written.

Job fencing: every state write is conditioned on `async_job_id = <this job>`, so a stale job of a
run that was retried (and now points at a newer job) cannot move the run's state.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from sqlalchemy import Connection, Engine, text

from quiz_worker.document_store import DocumentBusyError, WorkspaceUnavailableError
from quiz_worker.errors import NonRetryableJobError

logger = logging.getLogger(__name__)

JOB_TYPE = "question.import"
_LOCK_POLL_SECONDS = 0.5

TerminalRunStatus = Literal["failed", "cancelled"]


class RunSupersededError(NonRetryableJobError):
    """The run was retried (it points at a newer job) or finished meanwhile."""

    code = "import_superseded"


@dataclass(frozen=True)
class RunRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    created_by: uuid.UUID | None
    status: str
    async_job_id: uuid.UUID | None
    document_id: uuid.UUID | None
    revision_id: uuid.UUID | None
    document_filename: str | None
    document_deleted: bool


@dataclass(frozen=True)
class DraftRow:
    """One `question_drafts` row the job writes (source_type `import`, review `pending`)."""

    position: int
    question_type: str
    question_number: int | None
    is_multi_answer: bool
    payload: dict[str, Any]
    validations: list[dict[str, Any]]
    # Essay model answer printed in the answer key (20261018120000); never accepted_answers.
    rubric: str | None = None


class ImportStore(Protocol):
    def run_lock(self, run_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]) -> Any:
        """Context manager serialising the jobs (and cleanups) of one run."""
        ...

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> RunRow | None: ...

    def job_count(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> int:
        """How many `question.import` jobs the run has had (1 = its first job)."""
        ...

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool: ...

    def mark_running(self, run_id: uuid.UUID, job_id: uuid.UUID) -> None: ...

    def insert_drafts(
        self, workspace_id: uuid.UUID, run_id: uuid.UUID, drafts: Sequence[DraftRow]
    ) -> int:
        """Insert the drafts whose position has none yet (own transaction); returns how many."""
        ...

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[DraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> int:
        """In one transaction: re-check (and lock) workspace access, insert the missing drafts
        and mark the run `succeeded`. Returns how many drafts were inserted."""
        ...

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None:
        """`failed`/`cancelled` while the run is still this job's and not finished."""
        ...

    def report_progress(
        self, job_id: uuid.UUID, attempt: int, stage: str, percent: int
    ) -> None: ...

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None: ...


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


_RUN = text(
    """
    select r.id, r.workspace_id, r.created_by, r.status, r.async_job_id,
           r.source_document_id, r.source_document_revision_id,
           d.filename, coalesce(d.deleted_at is not null, true) as document_deleted
      from public.question_import_runs r
      left join public.documents d
        on d.id = r.source_document_id and d.workspace_id = r.workspace_id
     where r.id = :run_id and r.workspace_id = :workspace_id
    """
)

# `on conflict do nothing` (no arbiter): the unique (import_run_id, position) index turns a
# position that already has a draft into a no-op instead of an error.
_INSERT_DRAFT = text(
    """
    insert into public.question_drafts (workspace_id, source_type, import_run_id, position,
                                        question_type, question_number, is_multi_answer, payload,
                                        validations, rubric)
    select :workspace_id, 'import', :run_id, :position, :question_type, :question_number,
           :is_multi_answer, cast(:payload as jsonb), cast(:validations as jsonb), :rubric
     where not exists (select 1 from public.question_drafts
                        where import_run_id = :run_id and position = :position)
    on conflict do nothing
    """
)


class PostgresImportStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    @contextmanager
    def run_lock(
        self, run_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        """Session-level advisory lock on a dedicated connection; a dead worker's connection
        drops and releases it."""
        key = f"quiz.question_import:{run_id}"
        with self._engine.connect() as conn:
            deadline = time.monotonic() + wait_seconds
            while not conn.execute(
                text("select pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
            ).scalar_one():
                conn.commit()
                if time.monotonic() >= deadline:
                    raise DocumentBusyError("another job is processing this import")
                check()
                time.sleep(_LOCK_POLL_SECONDS)
            conn.commit()
            try:
                yield
            finally:
                try:
                    conn.execute(
                        text("select pg_advisory_unlock(hashtextextended(:k, 0))"), {"k": key}
                    )
                    conn.commit()
                except Exception:
                    conn.invalidate()

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> RunRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(_RUN, {"run_id": run_id, "workspace_id": workspace_id})
                .mappings()
                .first()
            )
        if row is None:
            return None
        return RunRow(
            id=row["id"],
            workspace_id=row["workspace_id"],
            created_by=row["created_by"],
            status=row["status"],
            async_job_id=row["async_job_id"],
            document_id=row["source_document_id"],
            revision_id=row["source_document_revision_id"],
            document_filename=row["filename"],
            document_deleted=bool(row["document_deleted"]),
        )

    def job_count(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> int:
        with self._engine.begin() as conn:
            return int(
                conn.execute(
                    text(
                        "select count(*) from public.async_jobs where workspace_id = :w "
                        "and job_type = :t and payload ->> 'import_id' = :r"
                    ),
                    {"w": workspace_id, "t": JOB_TYPE, "r": str(run_id)},
                ).scalar_one()
            )

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
                    "update public.question_import_runs set status = 'running', "
                    "finished_at = null where id = :r and async_job_id = :j "
                    "and status in ('queued', 'running')"
                ),
                {"r": run_id, "j": job_id},
            )

    @staticmethod
    def _insert(
        conn: Connection, workspace_id: uuid.UUID, run_id: uuid.UUID, drafts: Sequence[DraftRow]
    ) -> int:
        created = 0
        for draft in drafts:
            result = conn.execute(
                _INSERT_DRAFT,
                {
                    "workspace_id": workspace_id,
                    "run_id": run_id,
                    "position": draft.position,
                    "question_type": draft.question_type,
                    "question_number": draft.question_number,
                    "is_multi_answer": draft.is_multi_answer,
                    "payload": _json(draft.payload),
                    "validations": _json(draft.validations),
                    "rubric": draft.rubric,
                },
            )
            created += result.rowcount or 0
        return created

    def insert_drafts(
        self, workspace_id: uuid.UUID, run_id: uuid.UUID, drafts: Sequence[DraftRow]
    ) -> int:
        with self._engine.begin() as conn:
            return self._insert(conn, workspace_id, run_id, drafts)

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        drafts: Sequence[DraftRow],
        *,
        llm_model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> int:
        with self._engine.begin() as conn:
            # Workspace first (FOR SHARE): an archive/delete/membership change commits before
            # this check or waits for this transaction.
            if not self._writable(conn, workspace_id, user_id, lock=True):
                raise WorkspaceUnavailableError("the workspace is no longer writable")
            current = conn.execute(
                text(
                    "select status, async_job_id from public.question_import_runs "
                    "where id = :r for update"
                ),
                {"r": run_id},
            ).one()
            if current.async_job_id != job_id or current.status not in {"queued", "running"}:
                raise RunSupersededError("the import run moved on to another job")
            created = self._insert(conn, workspace_id, run_id, drafts)
            conn.execute(
                text(
                    "update public.question_import_runs set status = 'succeeded', "
                    "finished_at = now(), llm_model = :m, prompt_version = :p where id = :r"
                ),
                {"r": run_id, "m": llm_model, "p": prompt_version},
            )
            before_commit()
        return created

    def mark_terminal(
        self, run_id: uuid.UUID, job_id: uuid.UUID, status: TerminalRunStatus
    ) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.question_import_runs set status = :s, finished_at = now() "
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
