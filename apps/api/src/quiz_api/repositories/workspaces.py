"""Workspace lifecycle writes and caller-scoped reads (M3.1a).

Every write runs in the request session *after* the route's authorization dependency has
locked the workspace and membership rows (A1.3 `LockMode.UPDATE` for lifecycle actions), and
records an `activity_events` row in the same transaction; the route commits once. Nothing here
commits on its own.

State machine (docs: supabase baseline `workspaces_status_timestamps`):
    active --archive--> archived --restore--> active
    active | archived --delete--> deleted (terminal; `archived_at` is kept)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import func, insert, select, update
from sqlalchemy.orm import Session

from quiz_api.repositories.me import MembershipRole, WorkspaceStatus
from quiz_api.repositories.tables import activity_events, workspace_memberships, workspaces

ActivityEventType = Literal[
    "workspace.created",
    "workspace.renamed",
    "workspace.archived",
    "workspace.restored",
    "workspace.deleted",
]


@dataclass(frozen=True)
class WorkspaceRecord:
    id: uuid.UUID
    name: str
    status: WorkspaceStatus
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class MemberWorkspace:
    workspace: WorkspaceRecord
    role: MembershipRole


_COLUMNS = (
    workspaces.c.id,
    workspaces.c.name,
    workspaces.c.status,
    workspaces.c.archived_at,
    workspaces.c.created_at,
    workspaces.c.updated_at,
)


def _record(row: Any) -> WorkspaceRecord:
    return WorkspaceRecord(
        id=row.id,
        name=row.name,
        status=cast(WorkspaceStatus, row.status),
        archived_at=row.archived_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class WorkspaceRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    # --- reads -----------------------------------------------------------------------------------

    def list_for_member(self, user_id: uuid.UUID, status: WorkspaceStatus) -> list[MemberWorkspace]:
        """The caller's non-deleted workspaces in one status (Active/Archived tabs).

        Active: newest first. Archived: most recently archived first.
        """
        order = (
            (workspaces.c.archived_at.desc(), workspaces.c.id)
            if status == "archived"
            else (workspaces.c.created_at.desc(), workspaces.c.id)
        )
        stmt = (
            select(*_COLUMNS, workspace_memberships.c.role)
            .join(workspace_memberships, workspace_memberships.c.workspace_id == workspaces.c.id)
            .where(
                workspace_memberships.c.user_id == user_id,
                workspaces.c.status == status,
                workspaces.c.deleted_at.is_(None),
            )
            .order_by(*order)
        )
        return [
            MemberWorkspace(_record(row), cast(MembershipRole, row.role))
            for row in self._session.execute(stmt)
        ]

    def get(self, workspace_id: uuid.UUID) -> WorkspaceRecord:
        """A workspace the caller was just authorized for (the authz lookup proved it exists)."""
        row = self._session.execute(select(*_COLUMNS).where(workspaces.c.id == workspace_id)).one()
        return _record(row)

    # --- writes (caller commits) ----------------------------------------------------------------

    def create(self, owner_id: uuid.UUID, name: str) -> WorkspaceRecord:
        """Workspace + owner membership + `workspace.created` event in the current transaction.

        Raises `sqlalchemy.exc.IntegrityError` if `owner_id` is not an existing auth user.
        """
        row = self._session.execute(
            insert(workspaces).values(name=name, owner_id=owner_id).returning(*_COLUMNS)
        ).one()
        record = _record(row)
        self._session.execute(
            insert(workspace_memberships).values(
                workspace_id=record.id, user_id=owner_id, role="owner"
            )
        )
        self.record_activity(record.id, owner_id, "workspace.created", {"name": name})
        return record

    def rename(self, workspace_id: uuid.UUID, actor_id: uuid.UUID, name: str) -> WorkspaceRecord:
        current = self.get(workspace_id)
        if current.name == name:
            return current
        record = self._update(workspace_id, name=name)
        self.record_activity(
            workspace_id,
            actor_id,
            "workspace.renamed",
            {"previous_name": current.name, "name": name},
        )
        return record

    def archive(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> WorkspaceRecord:
        """Idempotent: archiving an archived workspace changes nothing and records no event."""
        current = self.get(workspace_id)
        if current.status == "archived":
            return current
        record = self._update(workspace_id, status="archived", archived_at=func.now())
        self.record_activity(workspace_id, actor_id, "workspace.archived", {})
        return record

    def restore(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> WorkspaceRecord:
        """Idempotent: restoring an active workspace changes nothing and records no event."""
        current = self.get(workspace_id)
        if current.status == "active":
            return current
        record = self._update(workspace_id, status="active", archived_at=None)
        self.record_activity(workspace_id, actor_id, "workspace.restored", {})
        return record

    def soft_delete(self, workspace_id: uuid.UUID, actor_id: uuid.UUID) -> None:
        """Terminal soft delete; the row (and its memberships, for history) stay."""
        current = self.get(workspace_id)
        self._update(workspace_id, status="deleted", deleted_at=func.now())
        self.record_activity(
            workspace_id, actor_id, "workspace.deleted", {"previous_status": current.status}
        )

    def record_activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: ActivityEventType,
        metadata: dict[str, str],
    ) -> None:
        """Append an audit event. Metadata holds names/statuses only, never secrets."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="workspace",
                target_id=workspace_id,
                metadata=metadata,
            )
        )

    def _update(self, workspace_id: uuid.UUID, **values: Any) -> WorkspaceRecord:
        row = self._session.execute(
            update(workspaces)
            .where(workspaces.c.id == workspace_id)
            .values(**values)
            .returning(*_COLUMNS)
        ).one()
        return _record(row)
