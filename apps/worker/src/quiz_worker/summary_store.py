"""Summary runs and units as `document.summarize` sees them (DOCSUM-B), on the `quiz_worker` role.

Grants come from supabase/migrations/20261029120000_document_summaries.sql: the worker reads
runs and moves their state (status, usage, progress, error code, timestamps), inserts units and a
run's unit links. Runs are created only by `worker_start_document_summary` (publish) and the API.

Supersession (DOCSUM-01-C03): the publish transaction of a newer revision locks the document row
FOR UPDATE and marks unfinished older runs `superseded`. `finish` re-checks under FOR SHARE on the
same row and FOR UPDATE on the run, so a run superseded (or whose revision stopped being the
active one) while it was generating commits nothing.

Nothing here stores or logs text other than the unit bodies themselves: run usage holds counts,
tokens and cost; progress holds counts; error codes are codes.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from book_core.llm import LLMUsage
from book_core.summary import StoredUnit, SummaryBody, UnitStore
from sqlalchemy import Engine, text

from quiz_worker.document_store import DocumentBusyError, WorkspaceUnavailableError

JOB_TYPE = "document.summarize"
_LOCK_POLL_SECONDS = 0.5

FinishOutcome = Literal[
    "succeeded", "superseded", "not_running", "document_unavailable", "workspace_unavailable"
]


@dataclass(frozen=True)
class RunRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID
    status: str
    job_id: uuid.UUID | None
    document_title: str
    document_filename: str
    document_type: str
    content_kind: str | None
    document_deleted: bool
    active_revision_id: uuid.UUID | None
    # Usage recorded by an earlier attempt of this run (tokens/cost carry over).
    usage: Mapping[str, Any] | None = None


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def usage_json(usage: LLMUsage | None) -> dict[str, Any] | None:
    if usage is None:
        return None
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cost_usd": usage.cost_usd,
    }


def _writable(
    conn: Any, workspace_id: Any, user_id: uuid.UUID | None, *, lock: bool = True
) -> bool:
    # supabase/migrations/20261017230000_worker_workspace_access.sql
    return bool(
        conn.execute(
            text("select public.worker_workspace_writable(:w, :u, :l)"),
            {"w": workspace_id, "u": user_id, "l": lock},
        ).scalar_one()
    )


class PostgresUnitStore:
    """`book_core.summary.UnitStore` over one document's units for one prompt version + model."""

    def __init__(
        self,
        engine: Engine,
        workspace_id: uuid.UUID,
        document_id: uuid.UUID,
        *,
        prompt_version: str,
        model: str,
        user_id: uuid.UUID | None = None,
        run_id: uuid.UUID | None = None,
    ) -> None:
        self._engine = engine
        self._user_id = user_id
        self._run_id = run_id
        self._key = {
            "w": workspace_id,
            "d": document_id,
            "pv": prompt_version,
            "m": model,
        }

    def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "select id, body, page_from, page_to, generated_by_run_id "
                        "from public.document_summary_units "
                        "where workspace_id = :w and document_id = :d and scope = :s "
                        "and section_key = :k and input_hash = :h and prompt_version = :pv "
                        "and model = :m"
                    ),
                    {**self._key, "s": scope, "k": section_key, "h": input_hash},
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        generated_by = row["generated_by_run_id"]
        return StoredUnit(
            str(row["id"]),
            SummaryBody.from_json(row["body"]),
            row["page_from"],
            row["page_to"],
            str(generated_by) if generated_by is not None else None,
        )

    def save(
        self,
        scope: str,
        section_key: str,
        input_hash: str,
        body: SummaryBody,
        page_from: int | None,
        page_to: int | None,
        usage: LLMUsage | None,
    ) -> StoredUnit:
        values = {
            **self._key,
            "s": scope,
            "k": section_key,
            "h": input_hash,
            "b": _json(body.to_json()),
            "pf": page_from,
            "pt": page_to,
            "u": _json(usage_json(usage)) if usage is not None else None,
            "run": self._run_id,
        }
        with self._engine.begin() as conn:
            # Never into a workspace archived/deleted meanwhile (rows locked FOR SHARE).
            if not _writable(conn, self._key["w"], self._user_id):
                raise WorkspaceUnavailableError("the workspace is no longer writable")
            conn.execute(
                text(
                    "insert into public.document_summary_units (workspace_id, document_id, scope, "
                    "section_key, input_hash, prompt_version, model, body, page_from, page_to, "
                    "usage, generated_by_run_id) values (:w, :d, :s, :k, :h, :pv, :m, "
                    "cast(:b as jsonb), :pf, :pt, cast(:u as jsonb), :run) "
                    "on conflict do nothing"
                ),
                values,
            )
        found = self.find(scope, section_key, input_hash)
        assert found is not None  # noqa: S101 - inserted or already there
        return found


class SummaryStore(Protocol):
    def summary_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Any: ...

    def load_run(self, workspace_id: uuid.UUID, run_id: uuid.UUID) -> RunRow | None: ...

    def mark_running(
        self, run_id: uuid.UUID, job_id: uuid.UUID, *, prompt_version: str, model: str
    ) -> bool: ...

    def report_progress(
        self, run_id: uuid.UUID, job_id: uuid.UUID, done: int, total: int
    ) -> None: ...

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool: ...

    def unit_store(
        self, run: RunRow, user_id: uuid.UUID | None, *, prompt_version: str, model: str
    ) -> UnitStore: ...

    def record_usage(
        self, run_id: uuid.UUID, job_id: uuid.UUID, usage: Mapping[str, Any]
    ) -> None: ...

    def finish(
        self,
        run: RunRow,
        job_id: uuid.UUID,
        unit_ids: Sequence[str],
        usage: Mapping[str, Any],
        *,
        user_id: uuid.UUID | None,
        before_commit: Callable[[], None],
    ) -> FinishOutcome: ...

    def mark_failed(
        self,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        error_code: str,
        usage: Mapping[str, Any] | None,
    ) -> None: ...

    def job_payload(self, job_id: uuid.UUID) -> tuple[Mapping[str, Any], str | None] | None: ...


class PostgresSummaryStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        with self._engine.begin() as conn:
            return _writable(conn, workspace_id, user_id, lock=False)

    def unit_store(
        self, run: RunRow, user_id: uuid.UUID | None, *, prompt_version: str, model: str
    ) -> UnitStore:
        return PostgresUnitStore(
            self._engine,
            run.workspace_id,
            run.document_id,
            prompt_version=prompt_version,
            model=model,
            user_id=user_id,
            run_id=run.id,
        )

    def record_usage(self, run_id: uuid.UUID, job_id: uuid.UUID, usage: Mapping[str, Any]) -> None:
        """The usage so far of a running run (an attempt that will be retried)."""
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.document_summary_runs set usage = cast(:u as jsonb) "
                    "where id = :r and job_id = :j and status in ('queued', 'running')"
                ),
                {"r": run_id, "j": job_id, "u": _json(dict(usage))},
            )

    @contextmanager
    def summary_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        """Session advisory lock serialising summary jobs of one document (never the parse
        job's `quiz.document:` lock, so a publish never waits for an LLM call)."""
        key = f"quiz.document_summary:{document_id}"
        with self._engine.connect() as conn:
            deadline = time.monotonic() + wait_seconds
            while not conn.execute(
                text("select pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
            ).scalar_one():
                conn.commit()
                if time.monotonic() >= deadline:
                    raise DocumentBusyError("another summary job is running for this document")
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
                conn.execute(
                    text(
                        "select r.id, r.workspace_id, r.document_id, r.document_revision_id, "
                        "r.status, r.job_id, d.title, d.filename, d.document_type, "
                        "d.content_kind, d.deleted_at is not null as deleted, "
                        "d.active_revision_id, r.usage "
                        "from public.document_summary_runs r "
                        "join public.documents d on d.id = r.document_id "
                        "and d.workspace_id = r.workspace_id "
                        "where r.id = :r and r.workspace_id = :w"
                    ),
                    {"r": run_id, "w": workspace_id},
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return RunRow(
            id=row["id"],
            workspace_id=row["workspace_id"],
            document_id=row["document_id"],
            revision_id=row["document_revision_id"],
            status=row["status"],
            job_id=row["job_id"],
            document_title=row["title"],
            document_filename=row["filename"],
            document_type=row["document_type"],
            content_kind=row["content_kind"],
            document_deleted=row["deleted"],
            active_revision_id=row["active_revision_id"],
            usage=row["usage"],
        )

    def mark_running(
        self, run_id: uuid.UUID, job_id: uuid.UUID, *, prompt_version: str, model: str
    ) -> bool:
        """queued/running -> running for this run's own job; False when it ended meanwhile."""
        with self._engine.begin() as conn:
            found = conn.execute(
                text(
                    "update public.document_summary_runs set status = 'running', "
                    "started_at = coalesce(started_at, now()), prompt_version = :pv, model = :m "
                    "where id = :r and job_id = :j and status in ('queued', 'running') "
                    "returning id"
                ),
                {"r": run_id, "j": job_id, "pv": prompt_version, "m": model[:200]},
            ).scalar_one_or_none()
        return found is not None

    def report_progress(self, run_id: uuid.UUID, job_id: uuid.UUID, done: int, total: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.document_summary_runs set progress = cast(:p as jsonb) "
                    "where id = :r and job_id = :j and status = 'running'"
                ),
                {
                    "r": run_id,
                    "j": job_id,
                    "p": _json({"chapters_done": done, "chapters_total": total}),
                },
            )

    def finish(
        self,
        run: RunRow,
        job_id: uuid.UUID,
        unit_ids: Sequence[str],
        usage: Mapping[str, Any],
        *,
        user_id: uuid.UUID | None,
        before_commit: Callable[[], None],
    ) -> FinishOutcome:
        """Under the workspace and document row locks: link the units (position 0 = document)
        and mark the run `succeeded`, unless it is no longer running or its revision is no
        longer the active one (then `superseded`, nothing written), or its workspace is no longer
        writable for the run's user (nothing written)."""
        with self._engine.begin() as conn:
            if not _writable(conn, run.workspace_id, user_id):
                return "workspace_unavailable"
            doc = (
                conn.execute(
                    text(
                        "select active_revision_id, deleted_at is not null as deleted "
                        "from public.documents where id = :d for share"
                    ),
                    {"d": run.document_id},
                )
                .mappings()
                .one()
            )
            status = conn.execute(
                text(
                    "select status from public.document_summary_runs "
                    "where id = :r and job_id = :j for update"
                ),
                {"r": run.id, "j": job_id},
            ).scalar_one_or_none()
            if status != "running":
                return "not_running"
            if doc["deleted"]:
                return "document_unavailable"
            if doc["active_revision_id"] != run.revision_id:
                conn.execute(
                    text(
                        "update public.document_summary_runs set status = 'superseded', "
                        "finished_at = now() where id = :r"
                    ),
                    {"r": run.id},
                )
                return "superseded"
            for position, unit_id in enumerate(unit_ids):
                conn.execute(
                    text(
                        "insert into public.document_summary_run_units "
                        "(workspace_id, run_id, unit_id, position) values (:w, :r, :u, :p)"
                    ),
                    {"w": run.workspace_id, "r": run.id, "u": unit_id, "p": position},
                )
            conn.execute(
                text(
                    "update public.document_summary_runs set status = 'succeeded', "
                    "usage = cast(:u as jsonb), finished_at = now() where id = :r"
                ),
                {"r": run.id, "u": _json(dict(usage))},
            )
            before_commit()
        return "succeeded"

    def mark_failed(
        self,
        run_id: uuid.UUID,
        job_id: uuid.UUID,
        error_code: str,
        usage: Mapping[str, Any] | None,
    ) -> None:
        """A run of this job that is still queued/running ends `failed` with a code."""
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.document_summary_runs set status = 'failed', "
                    "error_code = :c, usage = coalesce(cast(:u as jsonb), usage), "
                    "finished_at = now() "
                    "where id = :r and job_id = :j and status in ('queued', 'running')"
                ),
                {
                    "r": run_id,
                    "j": job_id,
                    "c": error_code,
                    "u": _json(dict(usage)) if usage is not None else None,
                },
            )

    def job_payload(self, job_id: uuid.UUID) -> tuple[Mapping[str, Any], str | None] | None:
        with self._engine.begin() as conn:
            row = conn.execute(
                text("select payload, last_error from public.async_jobs where id = :j"),
                {"j": job_id},
            ).first()
        if row is None:
            return None
        return row[0], row[1]
