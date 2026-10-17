"""DB lookups behind the authorization dependencies.

`load_membership` reads the workspace and the caller's membership in one query, excluding
soft-deleted workspaces, optionally locking both rows for the rest of the request transaction.
`resolve_workspace_id` maps a resource id to the workspace it belongs to, using the resource
registry below; the client never supplies that mapping.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Protocol

from sqlalchemy import Column, Table, select
from sqlalchemy.orm import Session

from quiz_api.authz.permissions import LockMode, Role
from quiz_api.repositories.tables import (
    async_jobs,
    practice_sessions,
    question_drafts,
    question_generation_runs,
    question_import_runs,
    questions,
    workspace_memberships,
    workspaces,
)


class ResourceType(StrEnum):
    """Workspace-owned resources addressable by their own id (`/jobs/{id}`, `/documents/{id}`).

    Later tasks add a member here and a `ResourceBinding` in `RESOURCES` for each new table.
    """

    JOB = "job"
    QUESTION = "question"
    # Per-user: the route must additionally check `practice_sessions.user_id` is the caller.
    PRACTICE_SESSION = "practice_session"
    QUESTION_DRAFT = "question_draft"
    QUESTION_GENERATION_RUN = "question_generation_run"
    QUESTION_IMPORT_RUN = "question_import_run"


@dataclass(frozen=True)
class ResourceBinding:
    table: Table
    # Optional soft-delete column of the resource itself: a non-null value hides the resource.
    deleted_column: str | None = None

    @property
    def id(self) -> Column[uuid.UUID]:
        return self.table.c.id

    @property
    def workspace_id(self) -> Column[uuid.UUID]:
        return self.table.c.workspace_id


RESOURCES: dict[ResourceType, ResourceBinding] = {
    ResourceType.JOB: ResourceBinding(async_jobs),
    ResourceType.QUESTION: ResourceBinding(questions, deleted_column="deleted_at"),
    ResourceType.PRACTICE_SESSION: ResourceBinding(practice_sessions),
    ResourceType.QUESTION_DRAFT: ResourceBinding(question_drafts),
    ResourceType.QUESTION_GENERATION_RUN: ResourceBinding(question_generation_runs),
    ResourceType.QUESTION_IMPORT_RUN: ResourceBinding(question_import_runs),
}


@dataclass(frozen=True)
class MembershipRecord:
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: Role
    status: str
    archived_at: datetime | None

    @property
    def archived(self) -> bool:
        return self.status == "archived"


class AccessRepository(Protocol):
    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None: ...

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None: ...


class SqlAccessRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        """The caller's membership in a non-deleted workspace, or `None`.

        With a lock, PostgreSQL re-checks the WHERE clause against the latest committed row
        version after waiting, so a workspace deleted (or a membership removed) concurrently
        is not returned.
        """
        stmt = (
            select(
                workspaces.c.id,
                workspaces.c.status,
                workspaces.c.archived_at,
                workspace_memberships.c.role,
            )
            .join(workspace_memberships, workspace_memberships.c.workspace_id == workspaces.c.id)
            .where(
                workspaces.c.id == workspace_id,
                workspace_memberships.c.user_id == user_id,
                workspaces.c.deleted_at.is_(None),
                workspaces.c.status != "deleted",
            )
        )
        if lock is LockMode.SHARE:
            stmt = stmt.with_for_update(read=True, of=[workspaces, workspace_memberships])
        elif lock is LockMode.UPDATE:
            stmt = stmt.with_for_update(key_share=True, of=[workspaces, workspace_memberships])
        row = self._session.execute(stmt).mappings().one_or_none()
        if row is None:
            return None
        return MembershipRecord(
            workspace_id=row["id"],
            user_id=user_id,
            role=Role(row["role"]),
            status=row["status"],
            archived_at=row["archived_at"],
        )

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        binding = RESOURCES[resource_type]
        stmt = select(binding.workspace_id).where(binding.id == resource_id)
        if binding.deleted_column is not None:
            stmt = stmt.where(binding.table.c[binding.deleted_column].is_(None))
        workspace_id: uuid.UUID | None = self._session.execute(stmt).scalar_one_or_none()
        return workspace_id
