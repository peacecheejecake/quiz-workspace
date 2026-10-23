"""DB lookups behind the authorization dependencies.

`load_membership` reads the workspace and the caller's membership in one query, excluding
soft-deleted workspaces, optionally locking both rows for the rest of the request transaction.
`resolve_workspace_id` maps a resource id to the workspace it belongs to, using the resource
registry below; the client never supplies that mapping. `load_resource_membership` does both in
one query (PERF-1: one database round trip instead of two): the resource's own workspace joined
with the caller's membership in it, with the same filters and the same row locks
(the workspace and membership rows, never the resource row).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

from sqlalchemy import Column, ColumnElement, Select, Table, exists, select
from sqlalchemy.orm import Session

from quiz_api.authz.permissions import LockMode, Role
from quiz_api.repositories.forks import FORK_JOB_TYPE
from quiz_api.repositories.tables import (
    async_jobs,
    document_revisions,
    document_uploads,
    documents,
    practice_sessions,
    question_drafts,
    question_generation_runs,
    question_import_runs,
    questions,
    workspace_memberships,
    workspace_share_links,
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
    # M3.2a. A soft-deleted document and its revisions are invisible.
    DOCUMENT = "document"
    REVISION = "revision"
    # Upload intent; per-user: the route must additionally check `document_uploads.user_id`.
    UPLOAD = "upload"
    # S1a. Revoked and expired links stay addressable for their owner (policy edits, listing).
    SHARE_LINK = "share_link"


@dataclass(frozen=True)
class ResourceBinding:
    table: Table
    # Optional soft-delete column of the resource itself: a non-null value hides the resource.
    deleted_column: str | None = None
    # Optional extra visibility condition, e.g. "its parent is not soft-deleted".
    visible_when: ColumnElement[bool] | None = None

    @property
    def id(self) -> Column[uuid.UUID]:
        return self.table.c.id

    @property
    def workspace_id(self) -> Column[uuid.UUID]:
        return self.table.c.workspace_id


RESOURCES: dict[ResourceType, ResourceBinding] = {
    # S3a: a fork job lives in the *source* workspace but belongs to the forking user only; its
    # status is read through GET /me/forks/{id}, never through the workspace's /jobs routes.
    ResourceType.JOB: ResourceBinding(
        async_jobs, visible_when=async_jobs.c.job_type != FORK_JOB_TYPE
    ),
    ResourceType.QUESTION: ResourceBinding(questions, deleted_column="deleted_at"),
    ResourceType.PRACTICE_SESSION: ResourceBinding(practice_sessions),
    ResourceType.QUESTION_DRAFT: ResourceBinding(question_drafts),
    ResourceType.QUESTION_GENERATION_RUN: ResourceBinding(question_generation_runs),
    ResourceType.QUESTION_IMPORT_RUN: ResourceBinding(question_import_runs),
    ResourceType.DOCUMENT: ResourceBinding(documents, deleted_column="deleted_at"),
    ResourceType.REVISION: ResourceBinding(
        document_revisions,
        visible_when=exists().where(
            documents.c.id == document_revisions.c.document_id,
            documents.c.workspace_id == document_revisions.c.workspace_id,
            documents.c.deleted_at.is_(None),
        ),
    ),
    ResourceType.UPLOAD: ResourceBinding(document_uploads),
    ResourceType.SHARE_LINK: ResourceBinding(workspace_share_links),
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

    def load_resource_membership(
        self,
        resource_type: ResourceType,
        resource_id: uuid.UUID,
        user_id: uuid.UUID,
        lock: LockMode,
    ) -> MembershipRecord | None: ...


class TwoStepResourceMembership:
    """`load_resource_membership` composed from the two primitive lookups (test doubles)."""

    def load_resource_membership(
        self: Any,
        resource_type: ResourceType,
        resource_id: uuid.UUID,
        user_id: uuid.UUID,
        lock: LockMode,
    ) -> MembershipRecord | None:
        workspace_id = self.resolve_workspace_id(resource_type, resource_id)
        if workspace_id is None:
            return None
        record: MembershipRecord | None = self.load_membership(workspace_id, user_id, lock)
        return record


def membership_select(user_id: uuid.UUID, lock: LockMode) -> Select[Any]:
    """The caller's membership in a non-deleted workspace (add the workspace condition).

    With a lock, PostgreSQL re-checks the WHERE clause against the latest committed row version
    after waiting, so a workspace deleted (or a membership removed) concurrently is not returned.
    Only the workspace and membership rows are locked, also when the caller joins more tables.
    """
    stmt = (
        select(
            workspaces.c.id,
            workspaces.c.status,
            workspaces.c.archived_at,
            workspace_memberships.c.role,
        )
        .select_from(workspaces)
        .join(workspace_memberships, workspace_memberships.c.workspace_id == workspaces.c.id)
        .where(
            workspace_memberships.c.user_id == user_id,
            workspaces.c.deleted_at.is_(None),
            workspaces.c.status != "deleted",
        )
    )
    if lock is LockMode.SHARE:
        stmt = stmt.with_for_update(read=True, of=[workspaces, workspace_memberships])
    elif lock is LockMode.UPDATE:
        stmt = stmt.with_for_update(key_share=True, of=[workspaces, workspace_memberships])
    return stmt


def membership_record(
    session: Session, stmt: Select[Any], user_id: uuid.UUID
) -> MembershipRecord | None:
    row = session.execute(stmt).mappings().one_or_none()
    if row is None:
        return None
    return MembershipRecord(
        workspace_id=row["id"],
        user_id=user_id,
        role=Role(row["role"]),
        status=row["status"],
        archived_at=row["archived_at"],
    )


def _visible(binding: ResourceBinding, resource_id: uuid.UUID) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [binding.id == resource_id]
    if binding.deleted_column is not None:
        conditions.append(binding.table.c[binding.deleted_column].is_(None))
    if binding.visible_when is not None:
        conditions.append(binding.visible_when)
    return conditions


class SqlAccessRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def load_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        """The caller's membership in a non-deleted workspace, or `None`."""
        stmt = membership_select(user_id, lock).where(workspaces.c.id == workspace_id)
        return membership_record(self._session, stmt, user_id)

    def resolve_workspace_id(
        self, resource_type: ResourceType, resource_id: uuid.UUID
    ) -> uuid.UUID | None:
        binding = RESOURCES[resource_type]
        stmt = select(binding.workspace_id).where(*_visible(binding, resource_id))
        workspace_id: uuid.UUID | None = self._session.execute(stmt).scalar_one_or_none()
        return workspace_id

    def load_resource_membership(
        self,
        resource_type: ResourceType,
        resource_id: uuid.UUID,
        user_id: uuid.UUID,
        lock: LockMode,
    ) -> MembershipRecord | None:
        """`load_membership(resolve_workspace_id(...))` in one query; `None` when the resource
        is missing or invisible, or the caller is no member of its (live) workspace."""
        binding = RESOURCES[resource_type]
        stmt = (
            membership_select(user_id, lock)
            .join(binding.table, binding.workspace_id == workspaces.c.id)
            .where(*_visible(binding, resource_id))
        )
        return membership_record(self._session, stmt, user_id)
