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
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
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


class UnknownUserError(Exception):
    """The token's user no longer exists in `auth.users` (deleted while the token is valid)."""


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

    def ensure_profile(self, user_id: uuid.UUID) -> ProfileRecord:
        """Create the profile if missing and return it; commits.

        `INSERT ... ON CONFLICT (user_id) DO NOTHING` is idempotent and race-safe: concurrent
        first requests insert at most one row and never fail on the conflict, and an existing
        profile is never modified. Raises `UnknownUserError` when the user has been deleted.
        """
        try:
            self._session.execute(
                insert(profiles)
                .values(user_id=user_id)
                .on_conflict_do_nothing(index_elements=[profiles.c.user_id])
            )
            self._session.commit()
        except IntegrityError:
            # Only the auth.users foreign key can fail here (the PK conflict is DO NOTHING).
            self._session.rollback()
            raise UnknownUserError from None
        profile = self.get_profile(user_id)
        if profile is None:  # the user was deleted (cascade) right after the insert
            raise UnknownUserError
        return profile

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
