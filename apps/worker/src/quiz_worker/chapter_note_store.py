"""Chapter note rows, their pinned question revisions and the chapter text as the
`chapter_note.generate` job sees them (CHNOTE-B), on the `quiz_worker` role.

Grants (supabase/migrations/20261029130000_chapter_notes.sql): the worker reads notes and moves
a row's state / writes its result and the `superseded_at` of the chapter's older versions; it
reads questions, revisions, chapters and blocks. It never inserts or deletes notes and never
changes the pinned input (`question_refs`, chapter, job).

Idempotency: the result, the version number and superseding the previous version are written in
one transaction that also checks the row is still this job's queued/running generation, so a
redelivered job of a finished row does nothing. Every state write is fenced by `job_id`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import Connection, Engine, text

from quiz_worker.document_store import WorkspaceUnavailableError
from quiz_worker.errors import NonRetryableJobError
from quiz_worker.run_lock import advisory_run_lock

JOB_TYPE = "chapter_note.generate"


class NoteSupersededError(NonRetryableJobError):
    """The note row points at another job or finished meanwhile."""

    code = "note_superseded"


@dataclass(frozen=True)
class NoteRef:
    tag: str
    question_id: uuid.UUID
    question_revision_id: uuid.UUID
    label: str


@dataclass(frozen=True)
class NoteRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: str
    job_id: uuid.UUID | None
    document_id: uuid.UUID
    document_revision_id: uuid.UUID
    section_key: str
    refs: tuple[NoteRef, ...]


@dataclass(frozen=True)
class RevisionRow:
    """One pinned question revision (read even if the question changed since the request)."""

    question_id: uuid.UUID
    revision_id: uuid.UUID
    question_type: str
    stem: str
    options: list[dict[str, Any]]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    explanation: str | None
    # ESSAY model answer / grading criteria.
    rubric: str | None = None


class ChapterNoteStore(Protocol):
    def run_lock(
        self, note_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]: ...

    def load_note(self, workspace_id: uuid.UUID, note_id: uuid.UUID) -> NoteRow | None: ...

    def load_revisions(
        self, workspace_id: uuid.UUID, refs: Sequence[NoteRef]
    ) -> dict[uuid.UUID, RevisionRow]:
        """revision id -> pinned revision, for the refs whose revision still exists."""
        ...

    def reference_text(self, revision_id: uuid.UUID, section_key: str) -> str:
        """The chapter subtree's block texts in reading order, joined by newlines (the text
        `chapter_note_body_hash` hashes)."""
        ...

    def workspace_writable(self, workspace_id: uuid.UUID, user_id: uuid.UUID | None) -> bool: ...

    def mark_running(self, note_id: uuid.UUID, job_id: uuid.UUID, batches_total: int) -> None: ...

    def report_batches(self, note_id: uuid.UUID, job_id: uuid.UUID, done: int) -> None: ...

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        note_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        body: dict[str, Any],
        usage: dict[str, Any],
        dropped_items: int,
        model: str | None,
        prompt_version: str | None,
        before_commit: Callable[[], None],
    ) -> int:
        """In one transaction: re-check (and lock) workspace access, mark the row `succeeded`
        with the next version number of its chapter and supersede the previous version."""
        ...

    def mark_failed(self, note_id: uuid.UUID, job_id: uuid.UUID, error_code: str) -> None: ...

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None: ...


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse_refs(raw: Any) -> tuple[NoteRef, ...]:
    refs: list[NoteRef] = []
    for entry in raw if isinstance(raw, list) else []:
        refs.append(
            NoteRef(
                tag=str(entry["tag"]),
                question_id=uuid.UUID(str(entry["question_id"])),
                question_revision_id=uuid.UUID(str(entry["question_revision_id"])),
                label=str(entry.get("label") or ""),
            )
        )
    return tuple(refs)


_NOTE = text(
    """
    select id, workspace_id, status, job_id, document_id, document_revision_id, section_key,
           question_refs
      from public.chapter_notes
     where id = :note_id and workspace_id = :workspace_id
    """
)

_REVISIONS = text(
    """
    select q.id as question_id, q.question_type, r.id as revision_id, r.stem, r.options,
           r.correct_option_ids, r.accepted_answers, r.explanation, r.rubric
      from public.question_revisions r
      join public.questions q on q.id = r.question_id and q.workspace_id = r.workspace_id
     where r.workspace_id = :workspace_id and r.id = any(:ids)
    """
)

_REFERENCE = text(
    """
    with recursive tree as (
      select c.id from public.chapters c
       where c.document_revision_id = :revision_id and c.section_key = :section_key
      union all
      select c.id from public.chapters c join tree t on c.parent_id = t.id
       where c.document_revision_id = :revision_id
    )
    select b.text from public.content_blocks b
     where b.document_revision_id = :revision_id and b.chapter_id in (select id from tree)
     order by b.ordinal
    """
)


class PostgresChapterNoteStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def run_lock(
        self, note_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> AbstractContextManager[None]:
        return advisory_run_lock(
            self._engine,
            f"quiz.chapter_note:{note_id}",
            wait_seconds=wait_seconds,
            check=check,
            busy_message="another job is processing this chapter note",
        )

    def load_note(self, workspace_id: uuid.UUID, note_id: uuid.UUID) -> NoteRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(_NOTE, {"note_id": note_id, "workspace_id": workspace_id})
                .mappings()
                .first()
            )
        if row is None:
            return None
        return NoteRow(
            id=row["id"],
            workspace_id=row["workspace_id"],
            status=row["status"],
            job_id=row["job_id"],
            document_id=row["document_id"],
            document_revision_id=row["document_revision_id"],
            section_key=row["section_key"],
            refs=parse_refs(row["question_refs"]),
        )

    def load_revisions(
        self, workspace_id: uuid.UUID, refs: Sequence[NoteRef]
    ) -> dict[uuid.UUID, RevisionRow]:
        ids = [r.question_revision_id for r in refs]
        if not ids:
            return {}
        with self._engine.begin() as conn:
            rows = (
                conn.execute(_REVISIONS, {"workspace_id": workspace_id, "ids": ids})
                .mappings()
                .all()
            )
        return {
            r["revision_id"]: RevisionRow(
                question_id=r["question_id"],
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
                explanation=r["explanation"],
                rubric=r["rubric"],
            )
            for r in rows
        }

    def reference_text(self, revision_id: uuid.UUID, section_key: str) -> str:
        with self._engine.begin() as conn:
            texts = (
                conn.execute(_REFERENCE, {"revision_id": revision_id, "section_key": section_key})
                .scalars()
                .all()
            )
        return "\n".join(str(t) for t in texts)

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

    def mark_running(self, note_id: uuid.UUID, job_id: uuid.UUID, batches_total: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.chapter_notes set status = 'running', "
                    "batches_total = :t, batches_done = 0 "
                    "where id = :n and job_id = :j and status in ('queued', 'running')"
                ),
                {"n": note_id, "j": job_id, "t": max(1, batches_total)},
            )

    def report_batches(self, note_id: uuid.UUID, job_id: uuid.UUID, done: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.chapter_notes set batches_done = least(:d, batches_total) "
                    "where id = :n and job_id = :j and status = 'running'"
                ),
                {"n": note_id, "j": job_id, "d": done},
            )

    def finish(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID | None,
        note_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        body: dict[str, Any],
        usage: dict[str, Any],
        dropped_items: int,
        model: str | None,
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
                    "select status, job_id, document_id, section_key from public.chapter_notes "
                    "where id = :n for update"
                ),
                {"n": note_id},
            ).one()
            if current.job_id != job_id or current.status not in {"queued", "running"}:
                raise NoteSupersededError("the chapter note moved on to another job")
            version = int(
                conn.execute(
                    text(
                        "select coalesce(max(version), 0) + 1 from public.chapter_notes "
                        "where document_id = :d and section_key = :s and version is not null"
                    ),
                    {"d": current.document_id, "s": current.section_key},
                ).scalar_one()
            )
            conn.execute(
                text(
                    "update public.chapter_notes set superseded_at = now() "
                    "where document_id = :d and section_key = :s and status = 'succeeded' "
                    "and superseded_at is null and id <> :n"
                ),
                {"d": current.document_id, "s": current.section_key, "n": note_id},
            )
            conn.execute(
                text(
                    "update public.chapter_notes set status = 'succeeded', version = :v, "
                    "body = cast(:body as jsonb), usage = cast(:usage as jsonb), "
                    "dropped_items = :dropped, model = :m, prompt_version = :p, "
                    "error_code = null, finished_at = now(), "
                    "batches_done = coalesce(batches_total, batches_done) where id = :n"
                ),
                {
                    "n": note_id,
                    "v": version,
                    "body": _json(body),
                    "usage": _json(usage),
                    "dropped": dropped_items,
                    "m": model,
                    "p": prompt_version,
                },
            )
            before_commit()
        return version

    def mark_failed(self, note_id: uuid.UUID, job_id: uuid.UUID, error_code: str) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.chapter_notes set status = 'failed', error_code = :c, "
                    "finished_at = now() "
                    "where id = :n and job_id = :j and status in ('queued', 'running')"
                ),
                {"n": note_id, "j": job_id, "c": error_code},
            )

    def job_payload(self, job_id: uuid.UUID) -> dict[str, Any] | None:
        with self._engine.begin() as conn:
            payload = conn.execute(
                text("select payload from public.async_jobs where id = :j"), {"j": job_id}
            ).scalar_one_or_none()
        return dict(payload) if isinstance(payload, dict) else None
