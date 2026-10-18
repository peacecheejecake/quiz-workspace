"""Question variant generation runs, their drafts and lineage (M6.2) over
`question_generation_runs` / `question_drafts` / `question_lineage` / `question_sources`
(20261017180000_question_domain.sql, 20261018150000_question_generation_worker.sql).

The API creates runs and their `question.generate` jobs, reviews drafts (shared draft PATCH in
quiz_api.api.question_imports) and publishes them; the worker
(`quiz_worker.question_generation_job`) moves the run state and inserts drafts. Routes commit once.

Job idempotency: the run's job has the key `question_generation:<run id>:1` in the
`(workspace_id, created_by, job_type, idempotency_key)` scope.

Run status as presented: like imports (quiz_api.repositories.question_imports.present_status).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from quiz_api.repositories.jobs import error_code
from quiz_api.repositories.question_imports import (
    _DRAFT_COLUMNS,
    DraftRecord,
    RunStatus,
    _draft,
    present_status,
)
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    question_drafts,
    question_generation_runs,
    question_lineage,
    question_revisions,
    question_sources,
    questions,
)

GENERATE_JOB_TYPE = "question.generate"
GENERATE_JOB_SCHEMA_VERSION = 1


def generation_job_key(run_id: uuid.UUID) -> str:
    return f"question_generation:{run_id}:1"


@dataclass(frozen=True)
class GenerationRunRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: RunStatus
    job_id: uuid.UUID | None
    error_code: str | None
    source_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID
    variation_types: list[str]
    candidate_count: int
    params: dict[str, Any]
    llm_model: str | None
    prompt_version: str | None
    draft_count: int
    published_count: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


@dataclass(frozen=True)
class StoredSourceRecord:
    """A `question_sources` row with its block-level provenance."""

    document_id: uuid.UUID | None
    document_revision_id: uuid.UUID | None
    page_start: int | None
    page_end: int | None
    block_ids: list[str]
    locations: list[dict[str, Any]]


@dataclass(frozen=True)
class SourceRevisionRecord:
    """The pinned source revision of a run (the question may since be deleted or edited)."""

    question_id: uuid.UUID
    revision_id: uuid.UUID
    question_type: str
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    chapter_id: uuid.UUID | None
    deleted: bool


@dataclass(frozen=True)
class ContentRecord:
    question_type: str
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None


_draft_counts = (
    select(
        question_drafts.c.generation_run_id.label("run_id"),
        func.count().label("drafts"),
        func.count(question_drafts.c.published_question_id).label("published"),
    )
    .where(question_drafts.c.generation_run_id.is_not(None))
    .group_by(question_drafts.c.generation_run_id)
    .subquery()
)


def _run_select() -> Any:
    runs = question_generation_runs
    return select(
        runs.c.id,
        runs.c.workspace_id,
        runs.c.status,
        runs.c.async_job_id,
        runs.c.source_question_id,
        runs.c.source_question_revision_id,
        runs.c.variation_types,
        runs.c.candidate_count,
        runs.c.params,
        runs.c.llm_model,
        runs.c.prompt_version,
        runs.c.created_by,
        runs.c.created_at,
        runs.c.updated_at,
        runs.c.finished_at,
        async_jobs.c.status.label("job_status"),
        async_jobs.c.last_error.label("job_error"),
        func.coalesce(_draft_counts.c.drafts, 0).label("drafts"),
        func.coalesce(_draft_counts.c.published, 0).label("published"),
    ).select_from(
        runs.outerjoin(
            async_jobs,
            and_(
                async_jobs.c.id == runs.c.async_job_id,
                async_jobs.c.workspace_id == runs.c.workspace_id,
            ),
        ).outerjoin(_draft_counts, _draft_counts.c.run_id == runs.c.id)
    )


def _run(row: Any) -> GenerationRunRecord:
    status = present_status(row.status, row.job_status)
    return GenerationRunRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        status=status,
        job_id=row.async_job_id,
        error_code=error_code(status, row.job_error),
        source_question_id=row.source_question_id,
        source_question_revision_id=row.source_question_revision_id,
        variation_types=list(row.variation_types),
        candidate_count=int(row.candidate_count),
        params=dict(row.params or {}),
        llm_model=row.llm_model,
        prompt_version=row.prompt_version,
        draft_count=int(row.drafts),
        published_count=int(row.published),
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        finished_at=row.finished_at,
    )


class QuestionGenerationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- runs -----------------------------------------------------------------------------------

    def get_run(self, run_id: uuid.UUID) -> GenerationRunRecord | None:
        row = self._session.execute(
            _run_select().where(question_generation_runs.c.id == run_id)
        ).one_or_none()
        return _run(row) if row is not None else None

    def list_runs(
        self,
        workspace_id: uuid.UUID,
        *,
        limit: int,
        source_question_id: uuid.UUID | None = None,
    ) -> list[GenerationRunRecord]:
        runs = question_generation_runs
        stmt = _run_select().where(runs.c.workspace_id == workspace_id)
        if source_question_id is not None:
            stmt = stmt.where(runs.c.source_question_id == source_question_id)
        rows = self._session.execute(
            stmt.order_by(runs.c.created_at.desc(), runs.c.id.desc()).limit(limit)
        )
        return [_run(r) for r in rows]

    def passages(self, run_id: uuid.UUID) -> list[dict[str, Any]]:
        found = self._session.execute(
            select(question_generation_runs.c.passages).where(
                question_generation_runs.c.id == run_id
            )
        ).scalar_one_or_none()
        return list(found) if isinstance(found, list) else []

    def source_evidence(self, run_id: uuid.UUID) -> list[dict[str, Any]] | None:
        """The source question's evidence the job generated with (NULL: not snapshotted)."""
        found = self._session.execute(
            select(question_generation_runs.c.source_evidence).where(
                question_generation_runs.c.id == run_id
            )
        ).scalar_one_or_none()
        return list(found) if isinstance(found, list) else None

    def lock_dedupe(self, workspace_id: uuid.UUID) -> None:
        """Serialise generation publishes of one workspace until the transaction ends, so the
        duplicate check and the inserts it guards are atomic (a second publisher reads the first
        one's committed questions)."""
        self._session.execute(
            select(
                func.pg_advisory_xact_lock(
                    func.hashtextextended(f"quiz.generation_publish:{workspace_id}", 0)
                )
            )
        )

    def create_run(
        self,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        question_id: uuid.UUID,
        revision_id: uuid.UUID,
        variation_types: Sequence[str],
        candidate_count: int,
        params: dict[str, Any],
    ) -> uuid.UUID:
        """The run (pinned to the source revision) + its job + activity."""
        run_id = uuid.uuid4()
        key = generation_job_key(run_id)
        self._session.execute(
            pg_insert(async_jobs)
            .values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                created_by=actor_id,
                job_type=GENERATE_JOB_TYPE,
                schema_version=GENERATE_JOB_SCHEMA_VERSION,
                idempotency_key=key,
                payload={"generation_id": str(run_id)},
            )
            .on_conflict_do_nothing()
        )
        job_id: uuid.UUID = self._session.execute(
            select(async_jobs.c.id).where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.created_by == actor_id,
                async_jobs.c.job_type == GENERATE_JOB_TYPE,
                async_jobs.c.idempotency_key == key,
            )
        ).scalar_one()
        self._session.execute(
            insert(question_generation_runs).values(
                id=run_id,
                workspace_id=workspace_id,
                created_by=actor_id,
                source_question_id=question_id,
                source_question_revision_id=revision_id,
                variation_types=list(variation_types),
                candidate_count=candidate_count,
                async_job_id=job_id,
                status="queued",
                params=params,
            )
        )
        self._activity(
            workspace_id,
            actor_id,
            "question_generation.started",
            run_id,
            {"variation_types": list(variation_types), "candidate_count": candidate_count},
        )
        return run_id

    # --- source question ------------------------------------------------------------------------

    def source_revision(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID, revision_id: uuid.UUID
    ) -> SourceRevisionRecord | None:
        row = self._session.execute(
            select(
                questions.c.id,
                questions.c.question_type,
                questions.c.chapter_id,
                questions.c.deleted_at,
                question_revisions.c.id.label("revision_id"),
                question_revisions.c.stem,
                question_revisions.c.options,
                question_revisions.c.correct_option_ids,
                question_revisions.c.accepted_answers,
                question_revisions.c.is_multi_answer,
                question_revisions.c.explanation,
            )
            .select_from(
                questions.join(
                    question_revisions,
                    and_(
                        question_revisions.c.question_id == questions.c.id,
                        question_revisions.c.workspace_id == questions.c.workspace_id,
                    ),
                )
            )
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.id == question_id,
                question_revisions.c.id == revision_id,
            )
        ).one_or_none()
        if row is None:
            return None
        return SourceRevisionRecord(
            question_id=row.id,
            revision_id=row.revision_id,
            question_type=row.question_type,
            stem=row.stem,
            options=list(row.options or []),
            correct_option_ids=list(row.correct_option_ids)
            if row.correct_option_ids is not None
            else None,
            accepted_answers=list(row.accepted_answers)
            if row.accepted_answers is not None
            else None,
            is_multi_answer=bool(row.is_multi_answer),
            explanation=row.explanation,
            chapter_id=row.chapter_id,
            deleted=row.deleted_at is not None,
        )

    def stored_sources(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID
    ) -> list[StoredSourceRecord]:
        rows = self._session.execute(
            select(
                question_sources.c.document_id,
                question_sources.c.document_revision_id,
                question_sources.c.page_start,
                question_sources.c.page_end,
                question_sources.c.block_ids,
                question_sources.c.locations,
            )
            .where(
                question_sources.c.workspace_id == workspace_id,
                question_sources.c.question_id == question_id,
            )
            .order_by(question_sources.c.created_at, question_sources.c.id)
        )
        return [
            StoredSourceRecord(
                r.document_id,
                r.document_revision_id,
                r.page_start,
                r.page_end,
                list(r.block_ids or []),
                list(r.locations or []),
            )
            for r in rows
        ]

    def workspace_contents(self, workspace_id: uuid.UUID) -> list[ContentRecord]:
        """Active revisions of the workspace's live questions (duplicate fingerprints)."""
        rows = self._session.execute(
            select(
                questions.c.question_type,
                question_revisions.c.stem,
                question_revisions.c.options,
                question_revisions.c.correct_option_ids,
                question_revisions.c.accepted_answers,
            )
            .select_from(
                questions.join(
                    question_revisions,
                    and_(
                        question_revisions.c.id == questions.c.active_revision_id,
                        question_revisions.c.question_id == questions.c.id,
                    ),
                )
            )
            .where(questions.c.workspace_id == workspace_id, questions.c.deleted_at.is_(None))
        )
        return [
            ContentRecord(
                r.question_type,
                r.stem,
                list(r.options or []),
                list(r.correct_option_ids) if r.correct_option_ids is not None else None,
                list(r.accepted_answers) if r.accepted_answers is not None else None,
            )
            for r in rows
        ]

    # --- drafts ---------------------------------------------------------------------------------

    def list_drafts(self, run_id: uuid.UUID) -> list[DraftRecord]:
        rows = self._session.execute(
            select(*_DRAFT_COLUMNS)
            .where(question_drafts.c.generation_run_id == run_id)
            .order_by(question_drafts.c.position, question_drafts.c.id)
        )
        return [_draft(r) for r in rows]

    def lock_drafts(self, run_id: uuid.UUID, draft_ids: Iterable[uuid.UUID]) -> list[DraftRecord]:
        """The run's drafts among `draft_ids`, FOR UPDATE in position order (one lock order)."""
        ids = list(set(draft_ids))
        if not ids:
            return []
        rows = self._session.execute(
            select(*_DRAFT_COLUMNS)
            .where(question_drafts.c.generation_run_id == run_id, question_drafts.c.id.in_(ids))
            .order_by(question_drafts.c.position, question_drafts.c.id)
            .with_for_update()
        )
        return [_draft(r) for r in rows]

    # --- publishing -----------------------------------------------------------------------------

    def insert_source(
        self,
        *,
        workspace_id: uuid.UUID,
        question_id: uuid.UUID,
        document_id: uuid.UUID,
        revision_id: uuid.UUID | None,
        page_start: int | None,
        page_end: int | None,
        block_ids: Sequence[str],
        locations: list[dict[str, Any]],
    ) -> None:
        self._session.execute(
            insert(question_sources).values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                question_id=question_id,
                document_id=document_id,
                document_revision_id=revision_id,
                page_start=page_start,
                page_end=page_end,
                block_ids=list(block_ids),
                locations=locations,
            )
        )

    def insert_lineage(
        self,
        *,
        workspace_id: uuid.UUID,
        parent_question_id: uuid.UUID,
        child_question_id: uuid.UUID,
        source_question_revision_id: uuid.UUID,
        variation_type: str,
        run_id: uuid.UUID,
        draft_id: uuid.UUID,
        llm_model: str | None,
        prompt_version: str | None,
        source_block_ids: Sequence[str],
    ) -> None:
        self._session.execute(
            insert(question_lineage).values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                parent_question_id=parent_question_id,
                child_question_id=child_question_id,
                source_question_revision_id=source_question_revision_id,
                variation_type=variation_type,
                generation_run_id=run_id,
                draft_id=draft_id,
                llm_model=llm_model,
                prompt_version=prompt_version,
                source_block_ids=list(source_block_ids),
            )
        )

    def _activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: str,
        run_id: uuid.UUID,
        metadata: dict[str, Any],
    ) -> None:
        """Ids, types and counts only: never question text or answers."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="question_generation",
                target_id=run_id,
                metadata=metadata,
            )
        )

    def record_published(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID, run_id: uuid.UUID, count: int
    ) -> None:
        self._activity(
            workspace_id, actor_id, "question_generation.published", run_id, {"count": count}
        )
