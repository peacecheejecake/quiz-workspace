"""Workspace lifecycle API (M3.1a, WS-01; docs/architecture.md §6, docs/auth.md §4).

    POST   /workspaces                  create (caller becomes owner); `Idempotency-Key` aware
    GET    /workspaces?status=          the caller's active or archived workspaces
    GET    /workspaces/{id}             one workspace (any member)
    PATCH  /workspaces/{id}             rename (owner; not while archived)
    POST   /workspaces/{id}/archive     owner; idempotent (archiving an archived one is a no-op)
    POST   /workspaces/{id}/restore     owner; idempotent (restoring an active one is a no-op)
    DELETE /workspaces/{id}             owner; soft delete, 204. Afterwards every route answers
                                        404 for it, including a repeated DELETE.

Authorization is the A1.3 dependency on every `{workspace_id}` route: non-member, unknown and
soft-deleted ids are the same 404; members lacking the role get 403 `insufficient-role`; writes
to an archived workspace get 403 `workspace-archived`. Lifecycle actions lock the workspace and
membership rows (`LockMode.UPDATE`) in the request session, and the write plus its
`activity_events` row commit in that same transaction.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz import Action, WorkspaceAccess, require_workspace_access
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.me import MembershipRole, WorkspaceStatus
from quiz_api.repositories.workspaces import WorkspaceRecord, WorkspaceRepository

router = APIRouter(prefix="/workspaces", tags=["workspaces"], responses=problem_responses(503))

CREATE_SCOPE = "POST /workspaces"

# Mirrors `workspaces_name_length` (non-blank, <= 200 characters) after trimming surrounding
# whitespace; control characters are rejected.
WorkspaceName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f]+$"
    ),
]


class Workspace(BaseModel):
    id: uuid.UUID
    name: str
    role: MembershipRole = Field(description="The caller's membership role.")
    status: WorkspaceStatus = Field(description="Archived workspaces are read-only.")
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class WorkspaceList(BaseModel):
    items: list[Workspace]


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: WorkspaceName


class WorkspaceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: WorkspaceName


def get_workspace_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> WorkspaceRepository:
    return WorkspaceRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


WorkspaceRepo = Annotated[WorkspaceRepository, Depends(get_workspace_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]


def _access(action: Action) -> Any:
    return Depends(require_workspace_access(action))


ReadAccess = Annotated[WorkspaceAccess, _access(Action.READ)]
UpdateAccess = Annotated[WorkspaceAccess, _access(Action.WORKSPACE_UPDATE)]
ArchiveAccess = Annotated[WorkspaceAccess, _access(Action.WORKSPACE_ARCHIVE)]
RestoreAccess = Annotated[WorkspaceAccess, _access(Action.WORKSPACE_RESTORE)]
DeleteAccess = Annotated[WorkspaceAccess, _access(Action.WORKSPACE_DELETE)]


def _out(record: WorkspaceRecord, role: str) -> Workspace:
    """`role` is a `MembershipRole` or an authz `Role` (a str enum with the same values)."""
    return Workspace(
        id=record.id,
        name=record.name,
        role=cast(MembershipRole, str(role)),
        status=record.status,
        archived_at=record.archived_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=Workspace,
    operation_id="createWorkspace",
    responses=problem_responses(409),
)
def create_workspace(
    body: WorkspaceCreate,
    user: CurrentUser,
    repo: WorkspaceRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Create a workspace; the caller becomes its owner (WS-01-AC02)."""
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user.id, CREATE_SCOPE, idempotency_key)
        stored = idempotency.find(user.id, CREATE_SCOPE, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)
    try:
        created = _out(repo.create(user.id, body.name), "owner")
        if idempotency_key is not None:
            idempotency.save(
                user.id,
                CREATE_SCOPE,
                idempotency_key,
                body_hash,
                status.HTTP_201_CREATED,
                created.model_dump(mode="json"),
            )
        repo.commit()
    except IntegrityError:
        # The only expected violation: the token's user was deleted (owner_id FK).
        repo.session.rollback()
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid access token.",
            headers={"WWW-Authenticate": 'Bearer realm="api", error="invalid_token"'},
        ) from None
    return created


@router.get("", operation_id="listWorkspaces")
def list_workspaces(
    user: CurrentUser,
    repo: WorkspaceRepo,
    status_filter: Annotated[
        Literal["active", "archived"],
        Query(alias="status", description="Which tab: active (default) or archived."),
    ] = "active",
) -> WorkspaceList:
    """The caller's workspaces in one status; soft-deleted workspaces never appear."""
    return WorkspaceList(
        items=[_out(m.workspace, m.role) for m in repo.list_for_member(user.id, status_filter)]
    )


@router.get("/{workspace_id}", operation_id="getWorkspace")
def get_workspace(access: ReadAccess, repo: WorkspaceRepo) -> Workspace:
    return _out(repo.get(access.workspace_id), access.role)


@router.patch("/{workspace_id}", operation_id="updateWorkspace")
def update_workspace(access: UpdateAccess, body: WorkspaceUpdate, repo: WorkspaceRepo) -> Workspace:
    """Rename (owner). Renaming to the current name is a no-op without an activity event."""
    record = repo.rename(access.workspace_id, access.user_id, body.name)
    repo.commit()
    return _out(record, access.role)


@router.post("/{workspace_id}/archive", operation_id="archiveWorkspace")
def archive_workspace(access: ArchiveAccess, repo: WorkspaceRepo) -> Workspace:
    """Make the workspace read-only (owner). Repeating it returns the archived workspace."""
    record = repo.archive(access.workspace_id, access.user_id)
    repo.commit()
    return _out(record, access.role)


@router.post("/{workspace_id}/restore", operation_id="restoreWorkspace")
def restore_workspace(access: RestoreAccess, repo: WorkspaceRepo) -> Workspace:
    """Make an archived workspace writable again (owner). Repeating it is a no-op."""
    record = repo.restore(access.workspace_id, access.user_id)
    repo.commit()
    return _out(record, access.role)


@router.delete(
    "/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="deleteWorkspace",
)
def delete_workspace(access: DeleteAccess, repo: WorkspaceRepo) -> Response:
    """Soft delete (owner, also from archived). The workspace then answers 404 everywhere."""
    repo.soft_delete(access.workspace_id, access.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
