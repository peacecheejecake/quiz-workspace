"""Mock exam generations as the `mock_exam.generate` job sees them (MOCK-B), on the
`quiz_worker` role.

Grants (supabase/migrations/20261102140000_mock_exams.sql): the worker reads its generation and
the mock exam, writes the generation's progress/result columns, inserts and settles the
per-item checkpoints, inserts the made questions with their first (`generated`) revisions and
sets `mock_exams.current_generation_id`. It reads the bank (questions, revisions, sources)
through the grants of 20261018150000 and never writes it.

Checkpoint: `store_batch` writes one finished batch (its questions, the items' new status, the
call count and usage) in one transaction, so a restarted job only re-packs `pending` / `failed`
items and never calls a finished batch again.

Fencing: every write is conditioned on the generation still being `queued`/`running` for this
job (`job_id`) and the mock exam not being deleted, re-checked under row locks together with
the workspace (`worker_workspace_writable`, FOR SHARE).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import Connection, Engine, text

from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.errors import NonRetryableJobError
from quiz_worker.question_sources import QuestionContentRow, SourceQuestionRow, SourceRow
from quiz_worker.run_lock import advisory_run_lock

JOB_TYPE = "mock_exam.generate"

ItemStatus = Literal["pending", "done", "failed", "skipped"]
FinalStatus = Literal["succeeded", "partial", "failed", "cancelled"]


class MockExamUnavailableError(NonRetryableJobError):
    """The mock exam was deleted or the generation was cancelled / taken over meanwhile."""

    code = "mock_exam_unavailable"


@dataclass(frozen=True)
class GenerationRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    mock_exam_id: uuid.UUID
    status: str
    job_id: uuid.UUID | None
    config: dict[str, Any]
    plan: list[dict[str, Any]]
    seed: int
    requested_count: int
    exam_deleted: bool


@dataclass(frozen=True)
class ItemRow:
    position: int
    source_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID
    variation_type: str
    status: str


@dataclass(frozen=True)
class MadeQuestion:
    """One question to store (a passed item or an OPTION_SHUFFLE copy)."""

    position: int
    question_type: str
    variation_type: str
    source_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID
    stem: str
    options: list[dict[str, str]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    is_multi_answer: bool
    explanation: str | None
    rubric: str | None
    evidence: list[dict[str, Any]]
    validation_issues: list[dict[str, Any]]


@dataclass
class BatchWrite:
    """What one finished batch (or skipped items) changes."""

    made: list[MadeQuestion] = field(default_factory=list)
    settled: dict[int, tuple[ItemStatus, str | None]] = field(default_factory=dict)
    """position -> (failed | skipped, reason code)."""
    llm_calls: int = 0
    batches_done: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


_GENERATION = text(
    """
    select g.id, g.workspace_id, g.mock_exam_id, g.status, g.job_id, g.config, g.plan, g.seed,
           g.requested_count, e.deleted_at is not null as exam_deleted
      from public.mock_exam_generations g
      join public.mock_exams e on e.id = g.mock_exam_id and e.workspace_id = g.workspace_id
     where g.id = :g and g.workspace_id = :w
    """
)

_REVISIONS = text(
    """
    select q.id, q.question_type, r.id as revision_id, r.stem, r.options, r.correct_option_ids,
           r.accepted_answers, r.is_multi_answer, r.explanation, r.rubric
      from public.question_revisions r
      join public.questions q on q.id = r.question_id and q.workspace_id = r.workspace_id
     where r.workspace_id = :w and r.id = any(:ids)
    """
)

_SOURCES = text(
    """
    select question_id, document_id, document_revision_id, page_start, page_end, block_ids,
           locations
      from public.question_sources
     where workspace_id = :w and question_id = any(:ids)
     order by created_at, id
    """
)


@dataclass(frozen=True)
class PinnedSource:
    row: SourceQuestionRow
    rubric: str | None


class PostgresMockExamStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def run_lock(
        self, mock_exam_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]:
        return advisory_run_lock(
            self._engine,
            f"quiz.mock_exam:{mock_exam_id}",
            wait_seconds=wait_seconds,
            check=check,
            busy_message="another job is generating this mock exam",
        )

    def load_generation(
        self, workspace_id: uuid.UUID, generation_id: uuid.UUID
    ) -> GenerationRow | None:
        with self._engine.begin() as conn:
            row = conn.execute(_GENERATION, {"g": generation_id, "w": workspace_id}).first()
        if row is None:
            return None
        return GenerationRow(
            id=row.id,
            workspace_id=row.workspace_id,
            mock_exam_id=row.mock_exam_id,
            status=row.status,
            job_id=row.job_id,
            config=dict(row.config or {}),
            plan=list(row.plan or []),
            seed=int(row.seed),
            requested_count=int(row.requested_count),
            exam_deleted=bool(row.exam_deleted),
        )

    @staticmethod
    def _writable(
        conn: Connection, workspace_id: uuid.UUID, user_id: uuid.UUID | None, *, lock: bool
    ) -> bool:
        return bool(
            conn.execute(
                text("select public.worker_workspace_writable(:w, :u, :l)"),
                {"w": workspace_id, "u": user_id, "l": lock},
            ).scalar_one()
        )

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool:
        with self._engine.begin() as conn:
            return self._writable(conn, workspace_id, user_id, lock=False)

    def start(
        self, generation: GenerationRow, job_id: uuid.UUID, plan: Sequence[dict[str, Any]]
    ) -> list[ItemRow]:
        """Marks the generation running and creates its item checkpoints once (idempotent)."""
        with self._engine.begin() as conn:
            moved = conn.execute(
                text(
                    "update public.mock_exam_generations set status = 'running', "
                    "started_at = coalesce(started_at, now()) "
                    "where id = :g and job_id = :j and status in ('queued', 'running')"
                ),
                {"g": generation.id, "j": job_id},
            ).rowcount
            if not moved:
                raise MockExamUnavailableError("the generation moved on")
            for item in plan:
                conn.execute(
                    text(
                        "insert into public.mock_exam_generation_items (generation_id, position, "
                        "workspace_id, source_question_id, source_question_revision_id, "
                        "variation_type) values (:g, :p, :w, :q, :r, :v) "
                        "on conflict (generation_id, position) do nothing"
                    ),
                    {
                        "g": generation.id,
                        "p": int(item["position"]),
                        "w": generation.workspace_id,
                        "q": item["question_id"],
                        "r": item["question_revision_id"],
                        "v": item["variation_type"],
                    },
                )
            rows = conn.execute(
                text(
                    "select position, source_question_id, source_question_revision_id, "
                    "variation_type, status from public.mock_exam_generation_items "
                    "where generation_id = :g order by position"
                ),
                {"g": generation.id},
            ).all()
        return [
            ItemRow(
                r.position,
                r.source_question_id,
                r.source_question_revision_id,
                r.variation_type,
                r.status,
            )
            for r in rows
        ]

    def load_sources(
        self, workspace_id: uuid.UUID, revision_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, PinnedSource]:
        """revision id -> the pinned source revision (also of a since deleted question: the
        plan pinned it at request time) with the question's stored sources."""
        ids = list(dict.fromkeys(revision_ids))
        if not ids:
            return {}
        with self._engine.begin() as conn:
            rows = conn.execute(_REVISIONS, {"w": workspace_id, "ids": ids}).mappings().all()
            qids = list({r["id"] for r in rows})
            sources: dict[uuid.UUID, list[SourceRow]] = {}
            for s in conn.execute(_SOURCES, {"w": workspace_id, "ids": qids}).mappings():
                sources.setdefault(s["question_id"], []).append(
                    SourceRow(
                        document_id=s["document_id"],
                        document_revision_id=s["document_revision_id"],
                        page_start=s["page_start"],
                        page_end=s["page_end"],
                        block_ids=tuple(s["block_ids"] or ()),
                        locations=list(s["locations"] or []),
                    )
                )
        out: dict[uuid.UUID, PinnedSource] = {}
        for r in rows:
            out[r["revision_id"]] = PinnedSource(
                row=SourceQuestionRow(
                    question_id=r["id"],
                    revision_id=r["revision_id"],
                    question_type=r["question_type"],
                    stem=r["stem"],
                    options=list(r["options"] or []),
                    correct_option_ids=list(r["correct_option_ids"])
                    if r["correct_option_ids"] is not None
                    else None,
                    accepted_answers=list(r["accepted_answers"])
                    if r["accepted_answers"] is not None
                    else None,
                    is_multi_answer=bool(r["is_multi_answer"]),
                    explanation=r["explanation"],
                    sources=tuple(sources.get(r["id"], [])),
                ),
                rubric=r["rubric"],
            )
        return out

    def workspace_questions(self, workspace_id: uuid.UUID) -> list[QuestionContentRow]:
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                    "r.accepted_answers from public.questions q "
                    "join public.question_revisions r "
                    "  on r.id = q.active_revision_id and r.question_id = q.id "
                    "where q.workspace_id = :w and q.deleted_at is null"
                ),
                {"w": workspace_id},
            ).mappings()
            return [_content(r) for r in rows]

    def generation_questions(self, generation_id: uuid.UUID) -> list[QuestionContentRow]:
        """The questions this generation already stored (sibling duplicates on resume)."""
        with self._engine.begin() as conn:
            rows = conn.execute(
                text(
                    "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                    "r.accepted_answers from public.mock_exam_questions q "
                    "join public.mock_exam_question_revisions r on r.id = q.active_revision_id "
                    "where q.generation_id = :g"
                ),
                {"g": generation_id},
            ).mappings()
            return [_content(r) for r in rows]

    def _fence(
        self,
        conn: Connection,
        generation: GenerationRow,
        job_id: uuid.UUID,
        user_id: uuid.UUID | None,
    ) -> None:
        # Workspace first (FOR SHARE), then the generation row.
        if not self._writable(conn, generation.workspace_id, user_id, lock=True):
            raise WorkspaceUnavailableError("the workspace is no longer writable")
        row = conn.execute(
            text(
                "select g.status, g.job_id, e.deleted_at "
                "from public.mock_exam_generations g "
                "join public.mock_exams e on e.id = g.mock_exam_id "
                "where g.id = :g for update of g"
            ),
            {"g": generation.id},
        ).first()
        # The API cancels the generation in the transaction that deletes the mock exam, so the
        # generation row lock serialises against a delete.
        if row is None or row.job_id != job_id or row.status not in {"queued", "running"}:
            raise MockExamUnavailableError("the generation moved on (cancelled or replaced)")
        if row.deleted_at is not None:
            raise MockExamUnavailableError("the mock exam was deleted")

    def store_batch(
        self,
        generation: GenerationRow,
        job_id: uuid.UUID,
        user_id: uuid.UUID | None,
        write: BatchWrite,
        *,
        before_commit: Callable[[], None],
    ) -> None:
        """One checkpoint (see the module docstring)."""
        with self._engine.begin() as conn:
            self._fence(conn, generation, job_id, user_id)
            for made in write.made:
                self._insert(conn, generation, made)
            for position, (status, reason) in write.settled.items():
                conn.execute(
                    text(
                        "update public.mock_exam_generation_items set status = :s, "
                        "skip_reason = :r where generation_id = :g and position = :p "
                        "and status in ('pending', 'failed')"
                    ),
                    {"g": generation.id, "p": position, "s": status, "r": reason},
                )
            conn.execute(
                text(
                    """
                    update public.mock_exam_generations g
                       set llm_calls = g.llm_calls + :calls,
                           batches_done = g.batches_done + :batches,
                           usage = jsonb_build_object(
                             'input_tokens',
                             coalesce((g.usage ->> 'input_tokens')::bigint, 0) + :inp,
                             'output_tokens',
                             coalesce((g.usage ->> 'output_tokens')::bigint, 0) + :outp),
                           created_count = c.done,
                           progress_done = c.done + c.skipped
                      from (select count(*) filter (where status = 'done') as done,
                                   count(*) filter (where status = 'skipped') as skipped
                              from public.mock_exam_generation_items
                             where generation_id = :g) c
                     where g.id = :g
                    """
                ),
                {
                    "g": generation.id,
                    "calls": write.llm_calls,
                    "batches": write.batches_done,
                    "inp": write.input_tokens,
                    "outp": write.output_tokens,
                },
            )
            before_commit()

    @staticmethod
    def _insert(conn: Connection, generation: GenerationRow, made: MadeQuestion) -> None:
        done = conn.execute(
            text(
                "select status from public.mock_exam_generation_items "
                "where generation_id = :g and position = :p"
            ),
            {"g": generation.id, "p": made.position},
        ).scalar_one_or_none()
        if done == "done":
            return
        question_id = uuid.uuid4()
        revision_id = uuid.uuid4()
        conn.execute(
            text(
                "insert into public.mock_exam_questions (id, workspace_id, mock_exam_id, "
                "generation_id, position, question_type, variation_type, source_question_id, "
                "source_question_revision_id) values (:id, :w, :e, :g, :p, :t, :v, :sq, :sr)"
            ),
            {
                "id": question_id,
                "w": generation.workspace_id,
                "e": generation.mock_exam_id,
                "g": generation.id,
                "p": made.position,
                "t": made.question_type,
                "v": made.variation_type,
                "sq": made.source_question_id,
                "sr": made.source_question_revision_id,
            },
        )
        conn.execute(
            text(
                "insert into public.mock_exam_question_revisions (id, workspace_id, "
                "mock_exam_question_id, version, stem, options, correct_option_ids, "
                "accepted_answers, is_multi_answer, explanation, rubric, evidence, "
                "validation_issues, origin) values (:id, :w, :q, 1, :stem, "
                "cast(:options as jsonb), :correct, :accepted, :multi, :explanation, :rubric, "
                "cast(:evidence as jsonb), cast(:issues as jsonb), 'generated')"
            ),
            {
                "id": revision_id,
                "w": generation.workspace_id,
                "q": question_id,
                "stem": made.stem,
                "options": _json(made.options),
                "correct": made.correct_option_ids,
                "accepted": made.accepted_answers,
                "multi": made.is_multi_answer,
                "explanation": made.explanation,
                "rubric": made.rubric,
                "evidence": _json(made.evidence),
                "issues": _json(made.validation_issues),
            },
        )
        conn.execute(
            text("update public.mock_exam_questions set active_revision_id = :r where id = :q"),
            {"r": revision_id, "q": question_id},
        )
        conn.execute(
            text(
                "update public.mock_exam_generation_items set status = 'done', skip_reason = null, "
                "mock_exam_question_id = :q where generation_id = :g and position = :p"
            ),
            {"q": question_id, "g": generation.id, "p": made.position},
        )

    def set_batches_total(self, generation_id: uuid.UUID, job_id: uuid.UUID, total: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.mock_exam_generations "
                    "set batches_total = coalesce(batches_total, 0) + :n "
                    "where id = :g and job_id = :j and status = 'running'"
                ),
                {"g": generation_id, "j": job_id, "n": total},
            )

    def finish(
        self,
        generation: GenerationRow,
        job_id: uuid.UUID,
        user_id: uuid.UUID | None,
        *,
        model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> tuple[str, int, int]:
        """Settles every open item as skipped, sets the final status (succeeded | partial |
        failed `no_valid_questions`) and shows a generation with questions. Returns
        (status, created, skipped)."""
        with self._engine.begin() as conn:
            self._fence(conn, generation, job_id, user_id)
            conn.execute(
                text(
                    "update public.mock_exam_generation_items set status = 'skipped', "
                    "skip_reason = coalesce(skip_reason, 'validation_failed') "
                    "where generation_id = :g and status in ('pending', 'failed')"
                ),
                {"g": generation.id},
            )
            done, skipped = conn.execute(
                text(
                    "select count(*) filter (where status = 'done'), "
                    "count(*) filter (where status = 'skipped') "
                    "from public.mock_exam_generation_items where generation_id = :g"
                ),
                {"g": generation.id},
            ).one()
            if done == 0:
                status, code = "failed", "no_valid_questions"
            elif done < generation.requested_count:
                status, code = "partial", None
            else:
                status, code = "succeeded", None
            conn.execute(
                text(
                    "update public.mock_exam_generations set status = :s, error_code = :c, "
                    "created_count = :d, skipped_count = :k, progress_done = :d + :k, "
                    "model = :m, prompt_version = :pv, finished_at = now() where id = :g"
                ),
                {
                    "g": generation.id,
                    "s": status,
                    "c": code,
                    "d": done,
                    "k": skipped,
                    "m": model,
                    "pv": prompt_version,
                },
            )
            if status != "failed":
                conn.execute(
                    text(
                        "update public.mock_exams set current_generation_id = :g "
                        "where id = :e and deleted_at is null"
                    ),
                    {"g": generation.id, "e": generation.mock_exam_id},
                )
            before_commit()
        return status, int(done), int(skipped)

    def mark_terminal(
        self, generation_id: uuid.UUID, job_id: uuid.UUID, status: FinalStatus, code: str | None
    ) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.mock_exam_generations set status = :s, error_code = :c, "
                    "finished_at = now() where id = :g and job_id = :j "
                    "and status in ('queued', 'running')"
                ),
                {"g": generation_id, "j": job_id, "s": status, "c": code},
            )

    def usage(self, generation_id: uuid.UUID) -> tuple[int, int, int, int]:
        """(llm_calls, batches_done, input_tokens, output_tokens) recorded so far."""
        with self._engine.begin() as conn:
            row = conn.execute(
                text(
                    "select llm_calls, batches_done, "
                    "coalesce((usage ->> 'input_tokens')::bigint, 0) as i, "
                    "coalesce((usage ->> 'output_tokens')::bigint, 0) as o "
                    "from public.mock_exam_generations where id = :g"
                ),
                {"g": generation_id},
            ).one()
        return int(row.llm_calls), int(row.batches_done), int(row.i), int(row.o)

    def live_documents(
        self, workspace_id: uuid.UUID, document_ids: Sequence[uuid.UUID]
    ) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
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
        found = {r.id: r.active_revision_id for r in rows}
        return [(i, found[i]) for i in ids if i in found]

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        with self._engine.begin() as conn:
            payload = conn.execute(
                text("select payload from public.async_jobs where id = :j"), {"j": job_id}
            ).scalar_one_or_none()
        return dict(payload) if isinstance(payload, dict) else None


def _content(r: Any) -> QuestionContentRow:
    return QuestionContentRow(
        question_type=r["question_type"],
        stem=r["stem"],
        options=list(r["options"] or []),
        correct_option_ids=list(r["correct_option_ids"])
        if r["correct_option_ids"] is not None
        else None,
        accepted_answers=list(r["accepted_answers"]) if r["accepted_answers"] is not None else None,
    )
