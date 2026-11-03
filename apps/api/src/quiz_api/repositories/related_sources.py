"""Reads and writes of stored related-passage lists (RELSRC-B, 20261104130000_related_sources.sql).

Runs in whatever session the route gives it (the request session, or the session bound to the
connection that holds the per-question advisory lock). Registered questions and mock exam
questions use the same code with their own tables (`MOCK` / `BANK`). Stored items are passage
references only; nothing here reads or writes passage text except `blocks`, which the route uses
to rebuild excerpts in memory. Nothing here logs.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class Kind:
    table: str
    owner: str
    revision: str
    lock_prefix: str


BANK = Kind("question_related_sources", "question_id", "question_revision_id", "relsrc:q:")
MOCK = Kind(
    "mock_exam_question_related_sources",
    "mock_exam_question_id",
    "mock_exam_question_revision_id",
    "relsrc:m:",
)


@dataclass(frozen=True)
class QuestionRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: str
    active_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class ProofSession:
    revision_id: uuid.UUID
    submitted: bool


@dataclass(frozen=True)
class RevisionContent:
    question_type: str
    stem: str
    options: list[Any]
    correct_option_ids: list[str] | None
    accepted_answers: list[str] | None
    rubric: str | None
    evidence: list[Any]


@dataclass(frozen=True)
class SourceRef:
    document_id: uuid.UUID
    block_ids: tuple[str, ...]


@dataclass(frozen=True)
class StoredList:
    id: uuid.UUID
    items: list[dict[str, Any]]
    superseded: bool


@dataclass(frozen=True)
class BlockRow:
    block_id: str
    text: str
    page: int
    chapter_id: uuid.UUID | None


@contextmanager
def lock_lists(conn: Connection, kind: Kind, owner_id: uuid.UUID) -> Iterator[None]:
    """Advisory lock of one question's lists while the block runs (session-level, taken and
    committed before the block so the block's own transaction starts after it; released at the
    end, or by dropping the connection if the unlock cannot run)."""
    key = {"k": f"{kind.lock_prefix}{owner_id}"}
    conn.execute(text("select pg_advisory_lock(hashtextextended(:k, 0))"), key)
    conn.commit()
    try:
        yield
    finally:
        try:
            if conn.in_transaction():
                conn.rollback()
            conn.execute(text("select pg_advisory_unlock(hashtextextended(:k, 0))"), key)
            conn.commit()
        except Exception:  # the connection is dropped instead
            conn.invalidate()  # closing the session releases its locks


class RelatedSourcesRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    # --- targets and proofs ----------------------------------------------------------------------

    def bank_question(self, question_id: uuid.UUID) -> QuestionRow | None:
        row = self._session.execute(
            text(
                "select id, workspace_id, publication_status, active_revision_id "
                "from public.questions where id = :q and deleted_at is null"
            ),
            {"q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return QuestionRow(row.id, row.workspace_id, row.publication_status, row.active_revision_id)

    def mock_question(self, question_id: uuid.UUID) -> QuestionRow | None:
        """A mock exam question still in its live mock exam (MOCK-P's visibility)."""
        row = self._session.execute(
            text(
                "select q.id, q.workspace_id, q.active_revision_id "
                "from public.mock_exam_questions q "
                "join public.mock_exams e on e.id = q.mock_exam_id "
                "and e.workspace_id = q.workspace_id "
                "where q.id = :q and q.removed_at is null and e.deleted_at is null"
            ),
            {"q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return QuestionRow(row.id, row.workspace_id, "CONFIRMED", row.active_revision_id)

    def bank_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, question_id: uuid.UUID
    ) -> ProofSession | None:
        """The caller's own practice session of THIS question (any other is no proof)."""
        row = self._session.execute(
            text(
                "select s.question_revision_id as revision_id, exists (select 1 "
                "from public.question_attempts a where a.practice_session_id = s.id "
                "and a.user_id = s.user_id) as submitted from public.practice_sessions s "
                "where s.id = :s and s.user_id = :u and s.question_id = :q"
            ),
            {"s": session_id, "u": user_id, "q": question_id},
        ).one_or_none()
        return ProofSession(row.revision_id, row.submitted) if row is not None else None

    def mock_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, question_id: uuid.UUID
    ) -> ProofSession | None:
        row = self._session.execute(
            text(
                "select s.mock_exam_question_revision_id as revision_id, exists (select 1 "
                "from public.mock_exam_attempts a where a.practice_session_id = s.id "
                "and a.user_id = s.user_id) as submitted "
                "from public.mock_exam_practice_sessions s "
                "where s.id = :s and s.user_id = :u and s.mock_exam_question_id = :q"
            ),
            {"s": session_id, "u": user_id, "q": question_id},
        ).one_or_none()
        return ProofSession(row.revision_id, row.submitted) if row is not None else None

    def revision(self, kind: Kind, revision_id: uuid.UUID) -> RevisionContent | None:
        if kind is BANK:
            sql = (
                "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                "r.accepted_answers, r.rubric, '[]'::jsonb as evidence "
                "from public.question_revisions r join public.questions q on q.id = r.question_id "
                "where r.id = :r"
            )
        else:
            sql = (
                "select q.question_type, r.stem, r.options, r.correct_option_ids, "
                "r.accepted_answers, r.rubric, r.evidence "
                "from public.mock_exam_question_revisions r "
                "join public.mock_exam_questions q on q.id = r.mock_exam_question_id "
                "where r.id = :r"
            )
        row = self._session.execute(text(sql), {"r": revision_id}).one_or_none()
        if row is None:
            return None
        return RevisionContent(
            question_type=row.question_type,
            stem=row.stem,
            options=list(row.options or []),
            correct_option_ids=list(row.correct_option_ids)
            if row.correct_option_ids is not None
            else None,
            accepted_answers=list(row.accepted_answers)
            if row.accepted_answers is not None
            else None,
            rubric=row.rubric,
            evidence=list(row.evidence or []),
        )

    def question_sources(self, question_id: uuid.UUID) -> list[SourceRef]:
        """The question's own source rows with a document, imported ones excluded (a merged
        keeper has only its own rows: merges move study state, not sources)."""
        rows = self._session.execute(
            text(
                "select document_id, block_ids from public.question_sources "
                "where question_id = :q and document_id is not null and import_run_id is null "
                "order by created_at, id"
            ),
            {"q": question_id},
        )
        return [SourceRef(r.document_id, tuple(r.block_ids or ())) for r in rows]

    # --- stored lists ----------------------------------------------------------------------------

    def stored(
        self, kind: Kind, revision_id: uuid.UUID, fingerprint: str, version: str
    ) -> StoredList | None:
        row = self._session.execute(
            text(
                f"select id, items, superseded_at is not null as superseded "  # noqa: S608
                f"from public.{kind.table} where {kind.revision} = :r "
                "and corpus_fingerprint = :f and retrieval_version = :v"
            ),
            {"r": revision_id, "f": fingerprint, "v": version},
        ).one_or_none()
        if row is None:
            return None
        return StoredList(row.id, list(row.items or []), bool(row.superseded))

    def _supersede_others(self, kind: Kind, owner_id: uuid.UUID, keep: uuid.UUID | None) -> None:
        self._session.execute(
            text(
                f"update public.{kind.table} set superseded_at = now() "  # noqa: S608
                f"where {kind.owner} = :o and superseded_at is null "
                "and (cast(:k as uuid) is null or id <> cast(:k as uuid))"
            ),
            {"o": owner_id, "k": keep},
        )

    def make_current(self, kind: Kind, owner_id: uuid.UUID, row_id: uuid.UUID) -> None:
        """The list of the question's current key again (a corpus that came back, e.g. a book
        added then deleted): every other list is superseded."""
        self._supersede_others(kind, owner_id, row_id)
        self._session.execute(
            text(
                f"update public.{kind.table} set superseded_at = null "  # noqa: S608
                "where id = :id and superseded_at is not null"
            ),
            {"id": row_id},
        )

    def insert(
        self,
        kind: Kind,
        *,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        revision_id: uuid.UUID,
        fingerprint: str,
        version: str,
        items: Sequence[Mapping[str, Any]],
        current: bool,
    ) -> uuid.UUID:
        """A new list; the current key's list supersedes the others, a list of an older revision
        (an old practice session) is stored as superseded right away."""
        if current:
            self._supersede_others(kind, owner_id, None)
        row = self._session.execute(
            text(
                f"insert into public.{kind.table} (workspace_id, {kind.owner}, "  # noqa: S608
                f"{kind.revision}, corpus_fingerprint, retrieval_version, items, superseded_at) "
                "values (:w, :o, :r, :f, :v, cast(:items as jsonb), "
                "case when :current then null else now() end) "
                f"on conflict ({kind.revision}, corpus_fingerprint, retrieval_version) do nothing "
                "returning id"
            ),
            {
                "w": workspace_id,
                "o": owner_id,
                "r": revision_id,
                "f": fingerprint,
                "v": version,
                "items": json.dumps(list(items), ensure_ascii=False, separators=(",", ":")),
                "current": current,
            },
        ).one_or_none()
        if row is not None:
            found: uuid.UUID = row.id
            return found
        existing = self.stored(kind, revision_id, fingerprint, version)
        assert existing is not None  # noqa: S101 - the conflict row exists
        return existing.id

    # --- passage content -------------------------------------------------------------------------

    def blocks(self, revision_id: uuid.UUID, block_ids: Sequence[str]) -> dict[str, BlockRow]:
        if not block_ids:
            return {}
        rows = self._session.execute(
            text(
                "select block_id, text, page, chapter_id from public.content_blocks "
                "where document_revision_id = :r and block_id = any(:ids)"
            ),
            {"r": revision_id, "ids": list(dict.fromkeys(block_ids))},
        )
        return {r.block_id: BlockRow(r.block_id, r.text, r.page, r.chapter_id) for r in rows}
