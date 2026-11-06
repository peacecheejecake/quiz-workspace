"""Mock exams (MOCK-B) over the tables of 20261102140000_mock_exams.sql.

The API creates mock exams, their revision history, queued generations with their pinned plan
and `mock_exam.generate` job, question edits (new revisions) and removals; the worker fills
generations. Routes commit once. Job idempotency: `mock_exam_generation:<generation id>:1`.
Activities `mock_exam.*` carry ids and counts only.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

JOB_TYPE = "mock_exam.generate"
JOB_SCHEMA_VERSION = 1
ACTIVE = ("queued", "running")


def job_key(generation_id: uuid.UUID) -> str:
    return f"mock_exam_generation:{generation_id}:1"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class GenerationRecord:
    id: uuid.UUID
    mock_exam_id: uuid.UUID
    version: int
    status: str
    job_id: uuid.UUID | None
    job_status: str | None
    job_error: str | None
    config: dict[str, Any]
    requested_count: int
    created_count: int
    skipped_count: int
    progress_done: int
    error_code: str | None
    seed: int
    created_at: datetime
    finished_at: datetime | None


@dataclass(frozen=True)
class ExamRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    version: int
    config: dict[str, Any]
    range: dict[str, Any]
    current_generation_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class QuestionRecord:
    id: uuid.UUID
    mock_exam_id: uuid.UUID
    generation_id: uuid.UUID
    position: int
    question_type: str
    variation_type: str
    revision_id: uuid.UUID
    revision_version: int
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    rubric: str | None
    validation_issues: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    source_question_id: uuid.UUID | None
    source_deleted: bool
    source_chapter_id: uuid.UUID | None
    source_number: int | None
    stem_tables: list[Any] | None = None


_GENERATION_COLUMNS = """
    g.id, g.mock_exam_id, g.version, g.status, g.job_id, j.status as job_status,
    j.last_error as job_error, g.config, g.requested_count, g.created_count, g.skipped_count,
    g.progress_done, g.error_code, g.seed, g.created_at, g.finished_at
"""
_GENERATIONS = (
    "select"
    + _GENERATION_COLUMNS
    + """
      from public.mock_exam_generations g
      left join public.async_jobs j on j.id = g.job_id and j.workspace_id = g.workspace_id
"""
)
_EXAM_COLUMNS = """
    e.id, e.workspace_id, e.title, e.version, e.config, e.range, e.current_generation_id,
    e.created_at, e.updated_at
"""
_QUESTIONS = """
    select q.id, q.mock_exam_id, q.generation_id, q.position, q.question_type, q.variation_type,
           r.id as revision_id, r.version as revision_version, r.stem, r.options,
           r.correct_option_ids, r.accepted_answers, r.is_multi_answer, r.explanation, r.rubric,
           r.validation_issues, r.evidence, r.stem_tables,
           s.id as source_question_id, s.deleted_at is not null as source_deleted,
           s.chapter_id as source_chapter_id, s.question_number as source_number
      from public.mock_exam_questions q
      join public.mock_exam_question_revisions r
        on r.id = q.active_revision_id and r.mock_exam_question_id = q.id
      left join public.questions s
        on s.id = q.source_question_id and s.workspace_id = q.workspace_id
"""


def _generation(row: Any) -> GenerationRecord:
    return GenerationRecord(
        id=row.id,
        mock_exam_id=row.mock_exam_id,
        version=int(row.version),
        status=row.status,
        job_id=row.job_id,
        job_status=row.job_status,
        job_error=row.job_error,
        config=dict(row.config or {}),
        requested_count=int(row.requested_count),
        created_count=int(row.created_count),
        skipped_count=int(row.skipped_count),
        progress_done=int(row.progress_done),
        error_code=row.error_code,
        seed=int(row.seed),
        created_at=row.created_at,
        finished_at=row.finished_at,
    )


def _exam(row: Any) -> ExamRecord:
    return ExamRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        title=row.title,
        version=int(row.version),
        config=dict(row.config or {}),
        range=dict(row.range or {}),
        current_generation_id=row.current_generation_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _question(row: Any) -> QuestionRecord:
    return QuestionRecord(
        id=row.id,
        mock_exam_id=row.mock_exam_id,
        generation_id=row.generation_id,
        position=int(row.position),
        question_type=row.question_type,
        variation_type=row.variation_type,
        revision_id=row.revision_id,
        revision_version=int(row.revision_version),
        stem=row.stem,
        options=list(row.options or []),
        correct_option_ids=list(row.correct_option_ids)
        if row.correct_option_ids is not None
        else None,
        accepted_answers=list(row.accepted_answers) if row.accepted_answers is not None else None,
        is_multi_answer=bool(row.is_multi_answer),
        explanation=row.explanation,
        rubric=row.rubric,
        validation_issues=list(row.validation_issues or []),
        evidence=list(row.evidence or []),
        stem_tables=row.stem_tables,
        source_question_id=row.source_question_id,
        source_deleted=bool(row.source_deleted) if row.source_question_id else True,
        source_chapter_id=row.source_chapter_id,
        source_number=row.source_number,
    )


class MockExamRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    def _activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: str,
        target_id: uuid.UUID,
        metadata: dict[str, Any],
        target_type: str = "mock_exam",
    ) -> None:
        self._session.execute(
            text(
                "insert into public.activity_events (workspace_id, actor_id, event_type, "
                "target_type, target_id, metadata) values (:w, :a, :e, :t, :id, "
                "cast(:m as jsonb))"
            ),
            {
                "w": workspace_id,
                "a": actor_id,
                "e": event_type,
                "t": target_type,
                "id": target_id,
                "m": _json(metadata),
            },
        )

    # --- reads -----------------------------------------------------------------------------------

    def exams(self, workspace_id: uuid.UUID) -> list[ExamRecord]:
        rows = self._session.execute(
            text(
                f"select {_EXAM_COLUMNS} from public.mock_exams e "  # noqa: S608
                "where e.workspace_id = :w and e.deleted_at is null "
                "order by e.created_at desc, e.id desc"
            ),
            {"w": workspace_id},
        )
        return [_exam(r) for r in rows]

    def exam(self, exam_id: uuid.UUID, *, lock: bool = False) -> ExamRecord | None:
        row = self._session.execute(
            text(
                f"select {_EXAM_COLUMNS} from public.mock_exams e "  # noqa: S608
                "where e.id = :id and e.deleted_at is null" + (" for update" if lock else "")
            ),
            {"id": exam_id},
        ).one_or_none()
        return _exam(row) if row is not None else None

    def generations(self, exam_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, GenerationRecord]:
        """generation id -> generation, for the given mock exams (any status)."""
        if not exam_ids:
            return {}
        rows = self._session.execute(
            text(_GENERATIONS + " where g.mock_exam_id = any(:ids)"), {"ids": list(exam_ids)}
        )
        return {r.id: _generation(r) for r in rows}

    def latest(self, exam_id: uuid.UUID) -> GenerationRecord | None:
        row = self._session.execute(
            text(_GENERATIONS + " where g.mock_exam_id = :e order by g.version desc limit 1"),
            {"e": exam_id},
        ).one_or_none()
        return _generation(row) if row is not None else None

    def question_counts(self, generation_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, int]:
        ids = list(set(generation_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            text(
                "select generation_id, count(*) as n from public.mock_exam_questions "
                "where generation_id = any(:ids) and removed_at is null group by generation_id"
            ),
            {"ids": ids},
        )
        return {r.generation_id: int(r.n) for r in rows}

    def plan_chapter_ranks(
        self, generation_ids: Iterable[uuid.UUID]
    ) -> dict[tuple[uuid.UUID, int], int]:
        """(generation id, position) -> the plan item's `chapter_rank` (MOCK-01-C10)."""
        ids = list(set(generation_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            text(
                "select g.id, (p->>'position')::int as position, "
                "coalesce((p->>'chapter_rank')::int, 0) as chapter_rank "
                "from public.mock_exam_generations g "
                "cross join lateral jsonb_array_elements(g.plan) p where g.id = any(:ids)"
            ),
            {"ids": ids},
        )
        return {(r.id, int(r.position)): int(r.chapter_rank) for r in rows}

    def questions(self, generation_id: uuid.UUID) -> list[QuestionRecord]:
        rows = self._session.execute(
            text(
                _QUESTIONS + " where q.generation_id = :g and q.removed_at is null "
                "order by q.position"
            ),
            {"g": generation_id},
        )
        return [_question(r) for r in rows]

    def question(self, question_id: uuid.UUID, *, lock: bool = False) -> QuestionRecord | None:
        if lock:
            self._session.execute(
                text("select 1 from public.mock_exam_questions where id = :q for update"),
                {"q": question_id},
            )
        row = self._session.execute(
            text(_QUESTIONS + " where q.id = :q and q.removed_at is null"), {"q": question_id}
        ).one_or_none()
        return _question(row) if row is not None else None

    # --- writes ----------------------------------------------------------------------------------

    def lock_workspace_generations(self, workspace_id: uuid.UUID) -> None:
        """Serialises generation starts of one workspace (the running limit)."""
        self._session.execute(
            text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"quiz.mock_exam_starts:{workspace_id}"},
        )

    def running_count(self, workspace_id: uuid.UUID) -> int:
        return int(
            self._session.execute(
                text(
                    "select count(*) from public.mock_exam_generations g "
                    "join public.mock_exams e on e.id = g.mock_exam_id "
                    "where g.workspace_id = :w and g.status in ('queued', 'running') "
                    "and e.deleted_at is null"
                ),
                {"w": workspace_id},
            ).scalar_one()
        )

    def active(self, exam_id: uuid.UUID) -> GenerationRecord | None:
        row = self._session.execute(
            text(_GENERATIONS + " where g.mock_exam_id = :e and g.status in ('queued', 'running')"),
            {"e": exam_id},
        ).one_or_none()
        return _generation(row) if row is not None else None

    def settle(self, generation_id: uuid.UUID, status: str, code: str) -> None:
        """A queued/running generation whose job already ended (or whose mock exam is deleted)
        ends `failed` / `cancelled`; never a success."""
        self._session.execute(
            text(
                "update public.mock_exam_generations set status = :s, error_code = :c, "
                "finished_at = now() where id = :g and status in ('queued', 'running')"
            ),
            {"g": generation_id, "s": status, "c": code},
        )

    def create_exam(
        self,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        title: str,
        config: dict[str, Any],
        range_: dict[str, Any],
    ) -> uuid.UUID:
        exam_id = uuid.uuid4()
        self._session.execute(
            text(
                "insert into public.mock_exams (id, workspace_id, title, config, range, "
                "created_by) values (:id, :w, :t, cast(:c as jsonb), cast(:r as jsonb), :a)"
            ),
            {
                "id": exam_id,
                "w": workspace_id,
                "t": title,
                "c": _json(config),
                "r": _json(range_),
                "a": actor_id,
            },
        )
        self._revision(exam_id, workspace_id, 1, title, config, range_, actor_id)
        self._activity(workspace_id, actor_id, "mock_exam.created", exam_id, {})
        return exam_id

    def _revision(
        self,
        exam_id: uuid.UUID,
        workspace_id: uuid.UUID,
        version: int,
        title: str,
        config: dict[str, Any],
        range_: dict[str, Any],
        actor_id: uuid.UUID,
    ) -> None:
        self._session.execute(
            text(
                "insert into public.mock_exam_revisions (workspace_id, mock_exam_id, version, "
                "title, config, range, edited_by) values (:w, :e, :v, :t, cast(:c as jsonb), "
                "cast(:r as jsonb), :a)"
            ),
            {
                "w": workspace_id,
                "e": exam_id,
                "v": version,
                "t": title,
                "c": _json(config),
                "r": _json(range_),
                "a": actor_id,
            },
        )

    def update_exam(
        self,
        exam: ExamRecord,
        actor_id: uuid.UUID,
        *,
        title: str | None = None,
        config: dict[str, Any] | None = None,
        range_: dict[str, Any] | None = None,
    ) -> None:
        """A rename or settings change: the new values and one `mock_exam_revisions` row."""
        new_title = title if title is not None else exam.title
        new_config = config if config is not None else exam.config
        new_range = range_ if range_ is not None else exam.range
        version = exam.version + 1
        self._session.execute(
            text(
                "update public.mock_exams set title = :t, config = cast(:c as jsonb), "
                "range = cast(:r as jsonb), version = :v where id = :id"
            ),
            {
                "id": exam.id,
                "t": new_title,
                "c": _json(new_config),
                "r": _json(new_range),
                "v": version,
            },
        )
        self._revision(
            exam.id, exam.workspace_id, version, new_title, new_config, new_range, actor_id
        )
        event = "mock_exam.renamed" if title is not None else "mock_exam.settings_changed"
        self._activity(exam.workspace_id, actor_id, event, exam.id, {"version": version})

    def create_generation(
        self,
        exam: ExamRecord,
        actor_id: uuid.UUID,
        *,
        config: dict[str, Any],
        range_: dict[str, Any],
        plan: list[dict[str, Any]],
        seed: int,
    ) -> uuid.UUID:
        """The queued generation (pinned plan) + its job + activity."""
        version = (
            int(
                self._session.execute(
                    text(
                        "select coalesce(max(version), 0) from public.mock_exam_generations "
                        "where mock_exam_id = :e"
                    ),
                    {"e": exam.id},
                ).scalar_one()
            )
            + 1
        )
        generation_id = uuid.uuid4()
        job_id: uuid.UUID = self._session.execute(
            text(
                "insert into public.async_jobs (workspace_id, created_by, job_type, "
                "schema_version, idempotency_key, payload) values (:w, :a, :t, :v, :k, "
                "cast(:p as jsonb)) returning id"
            ),
            {
                "w": exam.workspace_id,
                "a": actor_id,
                "t": JOB_TYPE,
                "v": JOB_SCHEMA_VERSION,
                "k": job_key(generation_id),
                "p": _json({"generation_id": str(generation_id)}),
            },
        ).scalar_one()
        self._session.execute(
            text(
                "insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, "
                "version, job_id, config, range, plan, seed, requested_count, created_by) "
                "values (:id, :w, :e, :v, :j, cast(:c as jsonb), cast(:r as jsonb), "
                "cast(:p as jsonb), :s, :n, :a)"
            ),
            {
                "id": generation_id,
                "w": exam.workspace_id,
                "e": exam.id,
                "v": version,
                "j": job_id,
                "c": _json(config),
                "r": _json(range_),
                "p": _json(plan),
                "s": seed,
                "n": len(plan),
                "a": actor_id,
            },
        )
        self._activity(
            exam.workspace_id,
            actor_id,
            "mock_exam.generation_requested",
            exam.id,
            {"generation_id": str(generation_id), "version": version, "question_count": len(plan)},
        )
        return generation_id

    def delete_exam(self, exam: ExamRecord, actor_id: uuid.UUID) -> None:
        """Soft delete; a queued/running generation is cancelled (its job too)."""
        active = self.active(exam.id)
        if active is not None:
            self.settle(active.id, "cancelled", "cancelled")
            if active.job_id is not None:
                self._session.execute(
                    text(
                        "update public.async_jobs set cancel_requested_at = coalesce("
                        "cancel_requested_at, now()) where id = :j and workspace_id = :w "
                        "and status in ('queued', 'running')"
                    ),
                    {"j": active.job_id, "w": exam.workspace_id},
                )
        self._session.execute(
            text("update public.mock_exams set deleted_at = now(), deleted_by = :a where id = :id"),
            {"id": exam.id, "a": actor_id},
        )
        self._activity(exam.workspace_id, actor_id, "mock_exam.deleted", exam.id, {})

    def edit_question(
        self,
        question: QuestionRecord,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        content: dict[str, Any],
    ) -> None:
        revision_id = uuid.uuid4()
        self._session.execute(
            text(
                "insert into public.mock_exam_question_revisions (id, workspace_id, "
                "mock_exam_question_id, version, stem, options, correct_option_ids, "
                "accepted_answers, is_multi_answer, explanation, rubric, evidence, "
                "validation_issues, origin, edited_by, stem_tables) "
                "values (:id, :w, :q, :v, :stem, "
                "cast(:options as jsonb), :correct, :accepted, :multi, :explanation, :rubric, "
                "cast(:evidence as jsonb), '[]'::jsonb, 'edited', :a, "
                "cast(:stem_tables as jsonb))"
            ),
            {
                "id": revision_id,
                "w": workspace_id,
                "q": question.id,
                "v": question.revision_version + 1,
                "stem": content["stem"],
                "options": _json(content["options"]),
                "correct": content["correct_option_ids"],
                "accepted": content["accepted_answers"],
                "multi": content["is_multi_answer"],
                "explanation": content["explanation"],
                "rubric": content["rubric"],
                "evidence": _json(question.evidence),
                "a": actor_id,
                "stem_tables": _json(content["stem_tables"])
                if content["stem_tables"] is not None
                else None,
            },
        )
        self._session.execute(
            text("update public.mock_exam_questions set active_revision_id = :r where id = :q"),
            {"r": revision_id, "q": question.id},
        )
        self._activity(
            workspace_id,
            actor_id,
            "mock_exam.question_edited",
            question.id,
            {"mock_exam_id": str(question.mock_exam_id), "version": question.revision_version + 1},
            target_type="mock_exam_question",
        )

    def remove_question(
        self, question: QuestionRecord, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ) -> None:
        self._session.execute(
            text(
                "update public.mock_exam_questions set removed_at = now(), removed_by = :a "
                "where id = :q and removed_at is null"
            ),
            {"q": question.id, "a": actor_id},
        )
        self._activity(
            workspace_id,
            actor_id,
            "mock_exam.question_removed",
            question.id,
            {"mock_exam_id": str(question.mock_exam_id)},
            target_type="mock_exam_question",
        )
