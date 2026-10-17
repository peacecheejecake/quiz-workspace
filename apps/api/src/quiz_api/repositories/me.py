"""Caller-scoped reads for `/me` and `/me/workspaces`.

Every query is keyed by the verified user id passed in by the route; there is no parameter
through which a client could widen the scope.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import profiles, workspace_memberships, workspaces

MembershipRole = Literal["owner", "editor", "viewer"]
WorkspaceStatus = Literal["active", "archived"]


@dataclass(frozen=True)
class ProfileRecord:
    user_id: uuid.UUID
    display_name: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class MemberWorkspaceRecord:
    id: uuid.UUID
    name: str
    status: WorkspaceStatus
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    role: MembershipRole


class MeRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get_profile(self, user_id: uuid.UUID) -> ProfileRecord | None:
        row = (
            self._session.execute(
                select(
                    profiles.c.user_id,
                    profiles.c.display_name,
                    profiles.c.created_at,
                    profiles.c.updated_at,
                ).where(profiles.c.user_id == user_id)
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        return ProfileRecord(
            user_id=row["user_id"],
            display_name=row["display_name"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_member_workspaces(self, user_id: uuid.UUID) -> list[MemberWorkspaceRecord]:
        """Workspaces the user is a member of; soft-deleted ones are never returned."""
        stmt = (
            select(
                workspaces.c.id,
                workspaces.c.name,
                workspaces.c.status,
                workspaces.c.archived_at,
                workspaces.c.created_at,
                workspaces.c.updated_at,
                workspace_memberships.c.role,
            )
            .join(workspace_memberships, workspace_memberships.c.workspace_id == workspaces.c.id)
            .where(
                workspace_memberships.c.user_id == user_id,
                workspaces.c.deleted_at.is_(None),
                workspaces.c.status != "deleted",
            )
            .order_by(workspaces.c.created_at.desc(), workspaces.c.id)
        )
        return [
            MemberWorkspaceRecord(
                id=row["id"],
                name=row["name"],
                status=cast(WorkspaceStatus, row["status"]),
                archived_at=row["archived_at"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                role=cast(MembershipRole, row["role"]),
            )
            for row in self._session.execute(stmt).mappings()
        ]
