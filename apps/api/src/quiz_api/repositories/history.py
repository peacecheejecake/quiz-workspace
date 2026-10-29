"""Workspace history reads (M7.1, HISTORY-01): activity feed, job list, the caller's attempts.

All three lists are keyset-paginated newest first on `(timestamp, id)` and each page is one
index-bounded query (`limit + 1` rows) plus batched label lookups for that page only:

    activities  activity_events_workspace_created_idx (workspace_id, created_at desc, id desc)
    jobs        async_jobs_workspace_created_id_idx   (workspace_id, created_at desc, id desc)
    attempts    question_attempts_workspace_user_submitted_idx
                                     (workspace_id, user_id, submitted_at desc, id desc)

Every query and every label lookup is filtered by the authorized `workspace_id`, so an id stored
in event metadata or a job payload can never pull a label from another workspace. Labels are
document titles, workspace names and question numbers: never block text, question stems,
answers or explanations. Personal study-state events (`visibility: actor`) are returned to
their own actor only (implementation-plan §7, workspace-sharing.md §1).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import Select, and_, func, or_, select, true, tuple_
from sqlalchemy.orm import Session

from quiz_api.practice_grading import AttemptResult
from quiz_api.repositories.jobs import JobStatus, JobView, error_code, progress_of
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    document_revisions,
    documents,
    profiles,
    question_attempts,
    question_generation_runs,
    question_import_runs,
    question_revisions,
    questions,
    workspaces,
)

STUDY_STATE_EVENT = "question.study_state_changed"
PARSE_JOB_TYPE = "document.parse"
# Written by the publishing worker; the reconciler re-runs it, so History offers no retry.
INDEX_SYNC_JOB_TYPE = "document.index_sync"
# DOCSUM-B: a summary job works on its document (payload `document_id`); `다시 시도` lives in the
# summary panel, so History offers no retry either.
SUMMARY_JOB_TYPE = "document.summarize"
DOCUMENT_JOB_TYPES = frozenset({PARSE_JOB_TYPE, INDEX_SYNC_JOB_TYPE, SUMMARY_JOB_TYPE})
IMPORT_JOB_TYPE = "question.import"
# QIMP-JOB: registers a submitted selection; it works on its import run (no retry from History:
# the import page submits what is still unregistered again).
REGISTER_JOB_TYPE = "question.import_register"
IMPORT_JOB_TYPES = frozenset({IMPORT_JOB_TYPE, REGISTER_JOB_TYPE})
RETRYABLE_STATUSES: frozenset[str] = frozenset({"failed", "cancelled"})


@dataclass(frozen=True)
class Cursor:
    """Keyset position: the last item's timestamp and id."""

    at: datetime
    id: uuid.UUID


@dataclass(frozen=True)
class Actor:
    id: uuid.UUID
    display_name: str | None


@dataclass(frozen=True)
class RevisionRef:
    id: uuid.UUID | None
    number: int | None


@dataclass(frozen=True)
class ActivityRecord:
    id: uuid.UUID
    event_type: str
    target_type: str
    target_id: uuid.UUID | None
    target_label: str | None
    actor: Actor | None
    created_at: datetime
    revision: RevisionRef | None


@dataclass(frozen=True)
class JobTarget:
    target_type: str | None
    target_id: uuid.UUID | None
    target_label: str | None
    retryable: bool
    # Document jobs: the revision the job parsed/indexed (a retry pins the publish to it).
    target_revision_id: uuid.UUID | None = None


@dataclass(frozen=True)
class WorkspaceJobRecord:
    job: JobView
    target: JobTarget


@dataclass(frozen=True)
class WorkspaceAttemptRecord:
    id: uuid.UUID
    question_id: uuid.UUID
    question_number: int | None
    question_type: str
    question_revision_id: uuid.UUID
    revision_version: int
    practice_session_id: uuid.UUID
    displayed_option_ids: list[str]
    submitted_answer: dict[str, Any]
    result: AttemptResult
    grading_method: str | None
    grades_attempt_id: uuid.UUID | None
    submitted_at: datetime
    graded_at: datetime | None


def question_label(number: int | None) -> str | None:
    """ "N번 문제" for a numbered question (UI copy is Korean first); None when unnumbered."""
    return f"{number}번 문제" if number is not None else None


def as_uuid(value: Any) -> uuid.UUID | None:
    """A UUID from untrusted JSON (event metadata, job payload); None for anything else."""
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def as_version(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 1 else None


def _page[T](rows: Sequence[T], limit: int, key: Any) -> tuple[list[T], Cursor | None]:
    items = list(rows[:limit])
    if len(rows) > limit and items:
        at, item_id = key(items[-1])
        return items, Cursor(at, item_id)
    return items, None


def _ids(values: Iterable[uuid.UUID | None]) -> set[uuid.UUID]:
    return {v for v in values if v is not None}


# --- page queries (one index-bounded statement each; tests EXPLAIN them) ------------------------


def activities_query(
    workspace_id: uuid.UUID, viewer_id: uuid.UUID, *, limit: int, after: Cursor | None
) -> Select[Any]:
    ae = activity_events
    personal = or_(
        ae.c.event_type == STUDY_STATE_EVENT,
        # coalesce: events without the key must not turn the filter into NULL (hidden).
        func.coalesce(ae.c.metadata["visibility"].astext, "") == "actor",
    )
    # activity_events alone, so the page is always an index range scan; actor names are looked
    # up for the page afterwards (_Labels).
    stmt = select(
        ae.c.id,
        ae.c.event_type,
        ae.c.target_type,
        ae.c.target_id,
        ae.c.actor_id,
        ae.c.metadata,
        ae.c.created_at,
    ).where(
        ae.c.workspace_id == workspace_id,
        or_(~personal, ae.c.actor_id == viewer_id),
    )
    if after is not None:
        stmt = stmt.where(tuple_(ae.c.created_at, ae.c.id) < tuple_(after.at, after.id))
    return stmt.order_by(ae.c.created_at.desc(), ae.c.id.desc()).limit(limit + 1)


def jobs_query(workspace_id: uuid.UUID, *, limit: int, after: Cursor | None) -> Select[Any]:
    j = async_jobs
    stmt = select(
        j.c.id,
        j.c.job_type,
        j.c.status,
        j.c.payload,
        j.c.result,
        j.c.last_error,
        j.c.attempts,
        j.c.max_attempts,
        j.c.cancel_requested_at,
        j.c.created_at,
        j.c.updated_at,
        j.c.started_at,
        j.c.finished_at,
    ).where(j.c.workspace_id == workspace_id)
    if after is not None:
        stmt = stmt.where(tuple_(j.c.created_at, j.c.id) < tuple_(after.at, after.id))
    return stmt.order_by(j.c.created_at.desc(), j.c.id.desc()).limit(limit + 1)


def attempts_query(
    workspace_id: uuid.UUID, user_id: uuid.UUID, *, limit: int, after: Cursor | None
) -> Select[Any]:
    """`user_id`'s attempts in the workspace (on questions that are not deleted)."""
    qa = question_attempts
    stmt = (
        select(
            qa.c.id,
            qa.c.question_id,
            questions.c.question_number,
            questions.c.question_type,
            qa.c.question_revision_id,
            question_revisions.c.version.label("revision_version"),
            qa.c.practice_session_id,
            qa.c.displayed_option_ids,
            qa.c.submitted_answer,
            qa.c.result,
            qa.c.grading_method,
            qa.c.grades_attempt_id,
            qa.c.submitted_at,
            qa.c.graded_at,
        )
        .select_from(
            qa.join(
                questions,
                and_(
                    questions.c.id == qa.c.question_id,
                    questions.c.workspace_id == qa.c.workspace_id,
                ),
            ).join(question_revisions, question_revisions.c.id == qa.c.question_revision_id)
        )
        .where(
            qa.c.workspace_id == workspace_id,
            qa.c.user_id == user_id,
            questions.c.deleted_at.is_(None),
        )
    )
    if after is not None:
        stmt = stmt.where(tuple_(qa.c.submitted_at, qa.c.id) < tuple_(after.at, after.id))
    return stmt.order_by(qa.c.submitted_at.desc(), qa.c.id.desc()).limit(limit + 1)


class HistoryRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    # --- activities ----------------------------------------------------------------------------

    def activities(
        self,
        workspace_id: uuid.UUID,
        viewer_id: uuid.UUID,
        *,
        limit: int,
        after: Cursor | None = None,
    ) -> tuple[list[ActivityRecord], Cursor | None]:
        rows = self._session.execute(
            activities_query(workspace_id, viewer_id, limit=limit, after=after)
        ).all()
        rows, cursor = _page(rows, limit, lambda r: (r.created_at, r.id))
        labels = _Labels(self._session, workspace_id)
        for r in rows:
            labels.want(r.target_type, r.target_id, r.metadata)
            labels.want_actor(r.actor_id)
        labels.load()
        items = [
            ActivityRecord(
                id=r.id,
                event_type=r.event_type,
                target_type=r.target_type,
                target_id=r.target_id,
                target_label=labels.label(r.target_type, r.target_id),
                actor=Actor(r.actor_id, labels.display_names.get(r.actor_id))
                if r.actor_id is not None
                else None,
                created_at=r.created_at,
                revision=labels.revision(r.target_type, r.target_id, r.metadata),
            )
            for r in rows
        ]
        return items, cursor

    # --- jobs ----------------------------------------------------------------------------------

    def jobs(
        self,
        workspace_id: uuid.UUID,
        *,
        can_retry: Callable[[str], bool],
        limit: int,
        after: Cursor | None = None,
    ) -> tuple[list[WorkspaceJobRecord], Cursor | None]:
        rows = self._session.execute(jobs_query(workspace_id, limit=limit, after=after)).all()
        rows, cursor = _page(rows, limit, lambda r: (r.created_at, r.id))
        targets = _JobTargets(self._session, workspace_id, rows)
        items = []
        for r in rows:
            progress, stage = progress_of(r.status, r.result)
            view = JobView(
                id=r.id,
                job_type=r.job_type,
                status=cast(JobStatus, r.status),
                progress=progress,
                stage=stage,
                error_code=error_code(r.status, r.last_error),
                attempts=r.attempts,
                max_attempts=r.max_attempts,
                cancel_requested=r.cancel_requested_at is not None,
                created_at=r.created_at,
                updated_at=r.updated_at,
                started_at=r.started_at,
                finished_at=r.finished_at,
            )
            items.append(WorkspaceJobRecord(view, targets.target(r, can_retry=can_retry)))
        return items, cursor

    # --- attempts ------------------------------------------------------------------------------

    def attempts(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        limit: int,
        after: Cursor | None = None,
    ) -> tuple[list[WorkspaceAttemptRecord], Cursor | None]:
        rows = self._session.execute(
            attempts_query(workspace_id, user_id, limit=limit, after=after)
        ).all()
        rows, cursor = _page(rows, limit, lambda r: (r.submitted_at, r.id))
        items = [
            WorkspaceAttemptRecord(
                id=r.id,
                question_id=r.question_id,
                question_number=r.question_number,
                question_type=r.question_type,
                question_revision_id=r.question_revision_id,
                revision_version=r.revision_version,
                practice_session_id=r.practice_session_id,
                displayed_option_ids=list(r.displayed_option_ids),
                submitted_answer=dict(r.submitted_answer),
                result=cast(AttemptResult, r.result),
                grading_method=r.grading_method,
                grades_attempt_id=r.grades_attempt_id,
                submitted_at=r.submitted_at,
                graded_at=r.graded_at,
            )
            for r in rows
        ]
        return items, cursor


# --- label lookups (one query per kind, per page) -----------------------------------------------


class _Labels:
    """Target labels and revisions for one page of activity events."""

    def __init__(self, session: Session, workspace_id: uuid.UUID) -> None:
        self._session = session
        self._workspace_id = workspace_id
        self._documents: set[uuid.UUID] = set()
        self._doc_revisions: set[uuid.UUID] = set()
        self._questions: set[uuid.UUID] = set()
        self._imports: set[uuid.UUID] = set()
        self._question_versions: set[tuple[uuid.UUID, int]] = set()
        self.document_titles: dict[uuid.UUID, str] = {}
        # revision id -> (document id, revision number)
        self.doc_revision_numbers: dict[uuid.UUID, tuple[uuid.UUID, int]] = {}
        self.question_numbers: dict[uuid.UUID, int | None] = {}
        self.question_revision_ids: dict[tuple[uuid.UUID, int], uuid.UUID] = {}
        self.import_titles: dict[uuid.UUID, str | None] = {}
        self.workspace_name: str | None = None
        self._workspace = False
        self._actors: set[uuid.UUID] = set()
        self.display_names: dict[uuid.UUID, str | None] = {}

    def want_actor(self, actor_id: uuid.UUID | None) -> None:
        if actor_id is not None:
            self._actors.add(actor_id)

    def want(self, target_type: str, target_id: uuid.UUID | None, metadata: Any) -> None:
        meta = metadata if isinstance(metadata, dict) else {}
        if target_id is None:
            return
        if target_type == "document":
            self._documents.add(target_id)
            revision_id = as_uuid(meta.get("revision_id"))
            if revision_id is not None:
                self._doc_revisions.add(revision_id)
        elif target_type == "question":
            self._questions.add(target_id)
            version = as_version(meta.get("version"))
            if version is not None:
                self._question_versions.add((target_id, version))
        elif target_type == "question_import":
            self._imports.add(target_id)
        elif target_type == "workspace":
            self._workspace = target_id == self._workspace_id

    def load(self) -> None:
        ws = self._workspace_id
        s = self._session
        if self._documents:
            self.document_titles = dict(
                s.execute(
                    select(documents.c.id, documents.c.title).where(
                        documents.c.workspace_id == ws, documents.c.id.in_(self._documents)
                    )
                ).all()
            )
        if self._doc_revisions:
            for rid, doc_id, number in s.execute(
                select(
                    document_revisions.c.id,
                    document_revisions.c.document_id,
                    document_revisions.c.revision_number,
                ).where(
                    document_revisions.c.workspace_id == ws,
                    document_revisions.c.id.in_(self._doc_revisions),
                )
            ).all():
                self.doc_revision_numbers[rid] = (doc_id, number)
        if self._questions:
            self.question_numbers = dict(
                s.execute(
                    select(questions.c.id, questions.c.question_number).where(
                        questions.c.workspace_id == ws, questions.c.id.in_(self._questions)
                    )
                ).all()
            )
        if self._question_versions:
            for qid, version, rid in s.execute(
                select(
                    question_revisions.c.question_id,
                    question_revisions.c.version,
                    question_revisions.c.id,
                ).where(
                    question_revisions.c.workspace_id == ws,
                    tuple_(question_revisions.c.question_id, question_revisions.c.version).in_(
                        sorted(self._question_versions)
                    ),
                )
            ).all():
                self.question_revision_ids[(qid, version)] = rid
        if self._imports:
            self.import_titles = _import_titles(s, ws, self._imports)
        if self._actors:
            self.display_names = dict(
                s.execute(
                    select(profiles.c.user_id, profiles.c.display_name).where(
                        profiles.c.user_id.in_(self._actors)
                    )
                ).all()
            )
        if self._workspace:
            self.workspace_name = s.execute(
                select(workspaces.c.name).where(workspaces.c.id == ws)
            ).scalar_one_or_none()

    def label(self, target_type: str, target_id: uuid.UUID | None) -> str | None:
        if target_id is None:
            return None
        if target_type == "document":
            return self.document_titles.get(target_id)
        if target_type == "question":
            return question_label(self.question_numbers.get(target_id))
        if target_type == "question_import":
            return self.import_titles.get(target_id)
        if target_type == "workspace" and target_id == self._workspace_id:
            return self.workspace_name
        return None

    def revision(
        self, target_type: str, target_id: uuid.UUID | None, metadata: Any
    ) -> RevisionRef | None:
        meta = metadata if isinstance(metadata, dict) else {}
        if target_id is None:
            return None
        if target_type == "document":
            revision_id = as_uuid(meta.get("revision_id"))
            if revision_id is None:
                return None
            found = self.doc_revision_numbers.get(revision_id)
            # A revision of another document (never written today) is not shown as this one's.
            if found is None or found[0] != target_id:
                return None
            return RevisionRef(revision_id, found[1])
        if target_type == "question":
            version = as_version(meta.get("version"))
            if version is None:
                return None
            return RevisionRef(self.question_revision_ids.get((target_id, version)), version)
        return None


def _import_titles(
    session: Session, workspace_id: uuid.UUID, run_ids: set[uuid.UUID]
) -> dict[uuid.UUID, str | None]:
    """Import run -> its question paper's title (a deleted paper keeps no label)."""
    rows = session.execute(
        select(question_import_runs.c.id, documents.c.title)
        .select_from(
            question_import_runs.outerjoin(
                documents,
                and_(
                    documents.c.id == question_import_runs.c.source_document_id,
                    documents.c.workspace_id == question_import_runs.c.workspace_id,
                    documents.c.deleted_at.is_(None),
                ),
            )
        )
        .where(
            question_import_runs.c.workspace_id == workspace_id,
            question_import_runs.c.id.in_(run_ids),
        )
    ).all()
    return dict(rows)


@dataclass(frozen=True)
class _DocumentState:
    title: str
    deleted: bool
    # The correction draft a publish (reindex) job would publish: the newest revision when it is
    # a draft numbered above the active one (repositories/document_content.current_draft).
    draft_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class _ImportState:
    title: str | None
    async_job_id: uuid.UUID | None
    retryable_run: bool


class _JobTargets:
    """What each job of one page works on, and whether the caller can start it again."""

    def __init__(self, session: Session, workspace_id: uuid.UUID, rows: list[Any]) -> None:
        self._documents: dict[uuid.UUID, _DocumentState] = {}
        self._imports: dict[uuid.UUID, _ImportState] = {}
        self._generations: dict[uuid.UUID, uuid.UUID] = {}
        doc_ids = _ids(
            as_uuid(_payload(r).get("document_id"))
            for r in rows
            if r.job_type in DOCUMENT_JOB_TYPES
        )
        import_ids = _ids(
            as_uuid(_payload(r).get("import_id")) for r in rows if r.job_type in IMPORT_JOB_TYPES
        )
        other_job_ids = {
            r.id for r in rows if r.job_type not in DOCUMENT_JOB_TYPES | IMPORT_JOB_TYPES
        }
        if doc_ids:
            self._documents = _document_states(session, workspace_id, doc_ids)
        if import_ids:
            self._imports = _import_states(session, workspace_id, import_ids)
        if other_job_ids:
            self._generations = dict(
                session.execute(
                    select(
                        question_generation_runs.c.async_job_id, question_generation_runs.c.id
                    ).where(
                        question_generation_runs.c.workspace_id == workspace_id,
                        question_generation_runs.c.async_job_id.in_(other_job_ids),
                    )
                ).all()
            )

    def target(self, row: Any, *, can_retry: Callable[[str], bool]) -> JobTarget:
        failed = row.status in RETRYABLE_STATUSES
        payload = _payload(row)
        if row.job_type in DOCUMENT_JOB_TYPES:
            doc_id = as_uuid(payload.get("document_id"))
            doc = self._documents.get(doc_id) if doc_id is not None else None
            if doc_id is None or doc is None:
                return JobTarget("document", None, None, retryable=False)
            # Retry = POST /documents/{id}/publish of the same correction draft (DOC-02-AC04).
            # The first parse of an upload has no draft to publish and no retry endpoint.
            revision_id = as_uuid(payload.get("revision_id"))
            retryable = (
                row.job_type == PARSE_JOB_TYPE
                and can_retry("document")
                and failed
                and not doc.deleted
                and revision_id is not None
                and revision_id == doc.draft_revision_id
            )
            return JobTarget(
                "document", doc_id, doc.title, retryable=retryable, target_revision_id=revision_id
            )
        if row.job_type in IMPORT_JOB_TYPES:
            run_id = as_uuid(payload.get("import_id"))
            run = self._imports.get(run_id) if run_id is not None else None
            if run_id is None or run is None:
                return JobTarget("question_import", None, None, retryable=False)
            if row.job_type == REGISTER_JOB_TYPE:
                return JobTarget("question_import", run_id, run.title, retryable=False)
            # Retry = POST /question-imports/{id}/retry: only the run's current job, while the
            # run is failed/cancelled and its question paper still exists (QIMPORT-01-AC04).
            retryable = (
                can_retry("question_import")
                and failed
                and run.retryable_run
                and run.async_job_id == row.id
            )
            return JobTarget("question_import", run_id, run.title, retryable=retryable)
        generation = self._generations.get(row.id)
        if generation is not None:
            return JobTarget("question_generation", generation, None, retryable=False)
        return JobTarget(None, None, None, retryable=False)


def _payload(row: Any) -> dict[str, Any]:
    return row.payload if isinstance(row.payload, dict) else {}


def _document_states(
    session: Session, workspace_id: uuid.UUID, doc_ids: set[uuid.UUID]
) -> dict[uuid.UUID, _DocumentState]:
    active = document_revisions.alias("active")
    latest = (
        select(
            document_revisions.c.id,
            document_revisions.c.revision_number,
            document_revisions.c.status,
        )
        .where(document_revisions.c.document_id == documents.c.id)
        .order_by(document_revisions.c.revision_number.desc())
        .limit(1)
        .lateral("latest")
    )
    rows = session.execute(
        select(
            documents.c.id,
            documents.c.title,
            documents.c.deleted_at,
            active.c.revision_number.label("active_number"),
            latest.c.id.label("latest_id"),
            latest.c.revision_number.label("latest_number"),
            latest.c.status.label("latest_status"),
        )
        .select_from(
            documents.outerjoin(active, active.c.id == documents.c.active_revision_id).outerjoin(
                latest, true()
            )
        )
        .where(documents.c.workspace_id == workspace_id, documents.c.id.in_(doc_ids))
    ).all()
    out: dict[uuid.UUID, _DocumentState] = {}
    for r in rows:
        draft = (
            r.latest_id
            if r.active_number is not None
            and r.latest_status == "draft"
            and r.latest_number is not None
            and r.latest_number > r.active_number
            else None
        )
        out[r.id] = _DocumentState(r.title, r.deleted_at is not None, draft)
    return out


def _import_states(
    session: Session, workspace_id: uuid.UUID, run_ids: set[uuid.UUID]
) -> dict[uuid.UUID, _ImportState]:
    rows = session.execute(
        select(
            question_import_runs.c.id,
            question_import_runs.c.async_job_id,
            question_import_runs.c.source_document_id,
            documents.c.title,
            documents.c.deleted_at,
        )
        .select_from(
            question_import_runs.outerjoin(
                documents,
                and_(
                    documents.c.id == question_import_runs.c.source_document_id,
                    documents.c.workspace_id == question_import_runs.c.workspace_id,
                ),
            )
        )
        .where(
            question_import_runs.c.workspace_id == workspace_id,
            question_import_runs.c.id.in_(run_ids),
        )
    ).all()
    out: dict[uuid.UUID, _ImportState] = {}
    for r in rows:
        paper_exists = r.title is not None and r.deleted_at is None
        out[r.id] = _ImportState(
            title=r.title if paper_exists else None,
            async_job_id=r.async_job_id,
            retryable_run=paper_exists,
        )
    return out
