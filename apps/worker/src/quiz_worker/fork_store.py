"""Fork rows as the `workspace.fork` job sees them (S3a), on the `quiz_worker` role.

Grants come from supabase/migrations/20261018170000_workspace_forks.sql: the worker reads
`workspace_forks`, moves a running fork's `status` / `progress` / `last_error` (PENDING ->
COPYING, -> FAILED / CANCELLED; the RLS policy refuses anything once a fork is terminal) and
calls three functions:

- `worker_fork_documents(fork)`: the copy plan of the pinned documents (source and target ids,
  Storage keys), computed in SQL so the keys the worker copies to are exactly the ones the commit
  writes;
- `worker_fork_source_usable(fork)`: link still usable for forking (no lock; polled between
  steps);
- `worker_fork_commit(fork)`: SECURITY DEFINER; re-checks the link with the source workspace and
  link rows locked FOR SHARE and writes the whole copy (workspace, membership, documents,
  revisions, chapters, blocks, questions, sources, lineage, `document.index_sync` obligations)
  in this transaction. The worker itself has no privilege on any of those tables.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol, cast

from sqlalchemy import Engine, text

ForkStatus = Literal["PENDING", "COPYING", "COMPLETED", "FAILED", "CANCELLED"]
CommitOutcome = Literal["completed", "unusable", "cancelled", "failed", "not_found"]
ACTIVE_STATUSES: frozenset[str] = frozenset({"PENDING", "COPYING"})


@dataclass(frozen=True)
class ForkRow:
    id: uuid.UUID
    status: ForkStatus
    name: str
    forked_by: uuid.UUID
    source_workspace_id: uuid.UUID | None
    target_workspace_id: uuid.UUID | None


@dataclass(frozen=True)
class ForkDocument:
    source_document_id: uuid.UUID
    source_revision_id: uuid.UUID
    target_workspace_id: uuid.UUID
    target_document_id: uuid.UUID
    target_revision_id: uuid.UUID
    document_type: str
    title: str
    source_object_key: str
    target_object_key: str
    source_parsed_object_key: str | None
    target_parsed_object_key: str | None


class ForkStore(Protocol):
    def get(self, fork_id: uuid.UUID) -> ForkRow | None: ...

    def documents(self, fork_id: uuid.UUID) -> list[ForkDocument]:
        """The copy plan of the pinned documents (empty for an unknown fork)."""
        ...

    def source_usable(self, fork_id: uuid.UUID) -> bool:
        """Running fork whose link is still usable for forking (no lock)."""
        ...

    def mark(
        self,
        fork_id: uuid.UUID,
        status: ForkStatus,
        *,
        progress: int | None = None,
        error: str | None = None,
    ) -> bool:
        """Move a running (PENDING/COPYING) fork; False when it is terminal already."""
        ...

    def commit(self, fork_id: uuid.UUID) -> CommitOutcome:
        """`worker_fork_commit`: re-check under a lock and write the copy in one transaction."""
        ...


class PostgresForkStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def get(self, fork_id: uuid.UUID) -> ForkRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "select id, status, name, forked_by, source_workspace_id, "
                        "target_workspace_id from public.workspace_forks where id = :f"
                    ),
                    {"f": fork_id},
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return ForkRow(
            id=row["id"],
            status=cast(ForkStatus, row["status"]),
            name=row["name"],
            forked_by=row["forked_by"],
            source_workspace_id=row["source_workspace_id"],
            target_workspace_id=row["target_workspace_id"],
        )

    def documents(self, fork_id: uuid.UUID) -> list[ForkDocument]:
        with self._engine.begin() as conn:
            rows = (
                conn.execute(text("select * from public.worker_fork_documents(:f)"), {"f": fork_id})
                .mappings()
                .all()
            )
        return [ForkDocument(**dict(row)) for row in rows]

    def source_usable(self, fork_id: uuid.UUID) -> bool:
        with self._engine.begin() as conn:
            return bool(
                conn.execute(
                    text("select public.worker_fork_source_usable(:f)"), {"f": fork_id}
                ).scalar_one()
            )

    def mark(
        self,
        fork_id: uuid.UUID,
        status: ForkStatus,
        *,
        progress: int | None = None,
        error: str | None = None,
    ) -> bool:
        with self._engine.begin() as conn:
            updated = conn.execute(
                text(
                    "update public.workspace_forks "
                    "set status = :s, progress = coalesce(:p, progress), "
                    "    last_error = coalesce(:e, last_error) "
                    "where id = :f and status in ('PENDING', 'COPYING') returning id"
                ),
                {"f": fork_id, "s": status, "p": progress, "e": error[:500] if error else None},
            ).first()
        return updated is not None

    def commit(self, fork_id: uuid.UUID) -> CommitOutcome:
        with self._engine.begin() as conn:
            outcome = conn.execute(
                text("select public.worker_fork_commit(:f)"), {"f": fork_id}
            ).scalar_one()
        return cast(CommitOutcome, str(outcome))
