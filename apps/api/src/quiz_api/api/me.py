"""`GET /me` and `GET /me/workspaces` (docs/auth.md §3/§5, AUTH-API-AC01/AC02).

Both are scoped exclusively by the verified token `sub`; query parameters and headers such as
`user_id`, `workspace_id` or `X-User-Id` are not declared and therefore never read.
`/me` only reads the profile: idempotent profile initialisation (upsert) belongs to A1.3, so a
user without a `profiles` row gets `profile: null`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.repositories.me import MembershipRole, MeRepository, WorkspaceStatus

router = APIRouter(prefix="/me", tags=["me"], responses=problem_responses(503))


class Profile(BaseModel):
    display_name: str | None
    created_at: datetime
    updated_at: datetime


class Me(BaseModel):
    id: uuid.UUID = Field(description="The verified user id (token `sub`).")
    profile: Profile | None = Field(description="`null` until the profile is initialised.")


class MyWorkspace(BaseModel):
    id: uuid.UUID
    name: str
    role: MembershipRole = Field(description="The caller's membership role.")
    status: WorkspaceStatus = Field(description="Archived workspaces are read-only.")
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class MyWorkspaceList(BaseModel):
    items: list[MyWorkspace]


def get_me_repository(session: Annotated[Session, Depends(get_db_session)]) -> MeRepository:
    return MeRepository(session)


MeRepo = Annotated[MeRepository, Depends(get_me_repository)]


@router.get("", operation_id="getMe")
def get_me(user: CurrentUser, repo: MeRepo) -> Me:
    """The authenticated user and their profile."""
    record = repo.get_profile(user.id)
    profile = (
        None
        if record is None
        else Profile(
            display_name=record.display_name,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
    )
    return Me(id=user.id, profile=profile)


@router.get("/workspaces", operation_id="listMyWorkspaces")
def list_my_workspaces(user: CurrentUser, repo: MeRepo) -> MyWorkspaceList:
    """Workspaces the caller is a member of (soft-deleted ones excluded), newest first."""
    return MyWorkspaceList(
        items=[
            MyWorkspace(
                id=w.id,
                name=w.name,
                role=w.role,
                status=w.status,
                archived_at=w.archived_at,
                created_at=w.created_at,
                updated_at=w.updated_at,
            )
            for w in repo.list_member_workspaces(user.id)
        ]
    )
