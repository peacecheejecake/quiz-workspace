"""Document summary runs and units (DOCSUM-B; supabase/migrations/20261029120000).

The API reads runs and units, creates runs for `요약 만들기` / `다시 시도` (with their unpublished
`document.summarize` job) and toggles a document's opt-in. Units and run links are written by the
worker only. Every query is scoped by the document id the route authorized.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

JOB_TYPE = "document.summarize"
LIVE_STATUSES = ("queued", "running")


@dataclass(frozen=True)
class SummaryDocument:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_type: str
    status: str
    active_revision_id: uuid.UUID | None
    summary_enabled_at: datetime | None


@dataclass(frozen=True)
class RunRecord:
    id: uuid.UUID
    revision_id: uuid.UUID
    status: str
    trigger: str
    job_id: uuid.UUID | None
    error_code: str | None
    progress: dict[str, Any] | None
    usage: dict[str, Any] | None
    created_at: datetime


@dataclass(frozen=True)
class UnitRecord:
    scope: str
    section_key: str
    body: dict[str, Any]
    page_from: int | None
    page_to: int | None


@dataclass(frozen=True)
class StoredSummary:
    run: RunRecord
    published_at: datetime | None
    units: list[UnitRecord]


_RUN_COLUMNS = (
    "r.id, r.document_revision_id, r.status, r.trigger, r.job_id, r.error_code, r.progress, "
    "r.usage, r.created_at"
)


def _run(row: Any) -> RunRecord:
    return RunRecord(
        id=row.id,
        revision_id=row.document_revision_id,
        status=row.status,
        trigger=row.trigger,
        job_id=row.job_id,
        error_code=row.error_code,
        progress=row.progress,
        usage=row.usage,
        created_at=row.created_at,
    )


class DocumentSummaryRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    def document(self, document_id: uuid.UUID, *, lock: bool = False) -> SummaryDocument | None:
        """A live document (FOR UPDATE with `lock`: serialises with a publish, which starts
        summaries under the same row lock)."""
        row = self._session.execute(
            text(
                "select id, workspace_id, document_type, status, active_revision_id, "  # noqa: S608 - fixed SQL fragments, values are bound
                "summary_enabled_at from public.documents where id = :d and deleted_at is null"
                + (" for update" if lock else "")
            ),
            {"d": document_id},
        ).first()
        if row is None:
            return None
        return SummaryDocument(
            id=row.id,
            workspace_id=row.workspace_id,
            document_type=row.document_type,
            status=row.status,
            active_revision_id=row.active_revision_id,
            summary_enabled_at=row.summary_enabled_at,
        )

    def current_run(self, document_id: uuid.UUID, revision_id: uuid.UUID) -> RunRecord | None:
        """The newest run of `revision_id` (any status)."""
        row = self._session.execute(
            text(
                f"select {_RUN_COLUMNS} from public.document_summary_runs r "  # noqa: S608 - fixed SQL fragments, values are bound
                "where r.document_id = :d and r.document_revision_id = :rev "
                "order by r.created_at desc, r.id desc limit 1"
            ),
            {"d": document_id, "rev": revision_id},
        ).first()
        return _run(row) if row is not None else None

    def get_run(self, run_id: uuid.UUID) -> RunRecord | None:
        row = self._session.execute(
            text(f"select {_RUN_COLUMNS} from public.document_summary_runs r where r.id = :r"),  # noqa: S608 - fixed SQL fragments, values are bound
            {"r": run_id},
        ).first()
        return _run(row) if row is not None else None

    def latest_summary(
        self, document_id: uuid.UUID, revision_id: uuid.UUID | None = None
    ) -> StoredSummary | None:
        """The newest succeeded run (of `revision_id` only, when given) with its units in
        display order (position 0 = the document summary)."""
        params: dict[str, Any] = {"d": document_id}
        where = ""
        if revision_id is not None:
            where = " and r.document_revision_id = :rev"
            params["rev"] = revision_id
        row = self._session.execute(
            text(
                f"select {_RUN_COLUMNS}, v.published_at from public.document_summary_runs r "  # noqa: S608 - fixed SQL fragments, values are bound
                "join public.document_revisions v on v.id = r.document_revision_id "
                "where r.document_id = :d and r.status = 'succeeded'" + where + " "
                "order by r.created_at desc, r.id desc limit 1"
            ),
            params,
        ).first()
        if row is None:
            return None
        units = self._session.execute(
            text(
                "select u.scope, u.section_key, u.body, u.page_from, u.page_to "
                "from public.document_summary_run_units ru "
                "join public.document_summary_units u on u.id = ru.unit_id "
                "where ru.run_id = :r order by ru.position"
            ),
            {"r": row.id},
        ).all()
        return StoredSummary(
            run=_run(row),
            published_at=row.published_at,
            units=[
                UnitRecord(u.scope, u.section_key, u.body, u.page_from, u.page_to) for u in units
            ],
        )

    def enable(self, document: SummaryDocument, actor_id: uuid.UUID) -> bool:
        """Opt in (auto refresh on); records `document.summary_enabled` only on a change."""
        if document.summary_enabled_at is not None:
            return False
        self._session.execute(
            text(
                "update public.documents set summary_enabled_at = now(), "
                "summary_enabled_by = :u where id = :d"
            ),
            {"d": document.id, "u": actor_id},
        )
        self._activity(document, actor_id, "document.summary_enabled")
        return True

    def disable(self, document: SummaryDocument, actor_id: uuid.UUID) -> bool:
        """Auto refresh off; records `document.summary_auto_disabled` only on a change."""
        if document.summary_enabled_at is None:
            return False
        self._session.execute(
            text(
                "update public.documents set summary_enabled_at = null, "
                "summary_enabled_by = null, summary_disabled_at = now(), "
                "summary_disabled_by = :u where id = :d"
            ),
            {"d": document.id, "u": actor_id},
        )
        self._activity(document, actor_id, "document.summary_auto_disabled")
        return True

    def _activity(self, document: SummaryDocument, actor_id: uuid.UUID, event: str) -> None:
        # Ids only (DOCSUM-01-C04).
        self._session.execute(
            text(
                "insert into public.activity_events (workspace_id, actor_id, event_type, "
                "target_type, target_id, metadata) values (:w, :u, :e, 'document', :d, "
                "cast(:m as jsonb))"
            ),
            {
                "w": document.workspace_id,
                "u": actor_id,
                "e": event,
                "d": document.id,
                "m": json.dumps({"revision_id": str(document.active_revision_id)}),
            },
        )

    def start_run(
        self, document: SummaryDocument, actor_id: uuid.UUID, trigger: str
    ) -> tuple[uuid.UUID, uuid.UUID]:
        """A queued run of the active revision + its unpublished job; unfinished runs of older
        revisions are superseded (as a publish does)."""
        assert document.active_revision_id is not None  # noqa: S101 - checked by the route
        run_id, job_id = uuid.uuid4(), uuid.uuid4()
        self._session.execute(
            text(
                "update public.document_summary_runs set status = 'superseded', "
                "finished_at = now() where document_id = :d and status in ('queued', 'running') "
                "and document_revision_id <> :rev"
            ),
            {"d": document.id, "rev": document.active_revision_id},
        )
        self._session.execute(
            text(
                "insert into public.async_jobs (id, workspace_id, created_by, job_type, "
                "schema_version, idempotency_key, payload) values (:j, :w, :u, :t, 1, :k, "
                "cast(:p as jsonb))"
            ),
            {
                "j": job_id,
                "w": document.workspace_id,
                "u": actor_id,
                "t": JOB_TYPE,
                "k": f"document_summary:{run_id}",
                "p": json.dumps({"run_id": str(run_id), "document_id": str(document.id)}),
            },
        )
        self._session.execute(
            text(
                "insert into public.document_summary_runs (id, workspace_id, document_id, "
                "document_revision_id, status, trigger, job_id, created_by) values "
                "(:r, :w, :d, :rev, 'queued', :t, :j, :u)"
            ),
            {
                "r": run_id,
                "w": document.workspace_id,
                "d": document.id,
                "rev": document.active_revision_id,
                "t": trigger,
                "j": job_id,
                "u": actor_id,
            },
        )
        return run_id, job_id
