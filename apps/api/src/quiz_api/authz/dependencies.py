"""Workspace authorization dependencies (docs/auth.md §4/§5, AUTH-API-AC02).

Every workspace-scoped route declares one of these; it runs on every request and decides from
the DB only: resource → workspace_id → the caller's membership → role/archived checks.

Outcome policy (404 vs 403):
  * 404 Not Found: "not visible to you". The workspace (or resource) does not exist, is
    soft-deleted, the caller is not a member, or the resource does not belong to the workspace
    named in the request. All of these return the same body, so a non-member cannot probe
    which ids exist.
  * 403 Forbidden: "visible, but not allowed". The caller is a member (so learns nothing new)
    but their role lacks the action (`ProblemType.INSUFFICIENT_ROLE`), or the action writes
    and the workspace is archived (`ProblemType.WORKSPACE_ARCHIVED`). Role is checked first.
  * 401 comes earlier from `CurrentUser`; the DB is not touched for unauthenticated calls.

Workspace and resource ids are read from the route's *path* only (`Path()`): a route that does
not have the placeholder cannot be satisfied (422), so the ids are never taken from the query
string. A workspace id the client sends elsewhere (body) must be checked with
`WorkspaceAccess.ensure_same_workspace`.

The membership lookup runs in the request's DB session and, for writes, locks the workspace and
membership rows (`LockMode`) until the route commits, so "check then act" is atomic.
"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Path
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz.permissions import Action, LockMode, Role, policy_for
from quiz_api.authz.repository import (
    AccessRepository,
    MembershipRecord,
    ResourceType,
    SqlAccessRepository,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType

WORKSPACE_NOT_FOUND = "Workspace not found."


def get_access_repository(session: Annotated[Session, Depends(get_db_session)]) -> AccessRepository:
    return SqlAccessRepository(session)


AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


@dataclass(frozen=True)
class WorkspaceAccess:
    """Proof that `user_id` may perform `action` in `workspace_id` (as of this transaction)."""

    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: Role
    status: str
    action: Action

    def ensure_same_workspace(self, claimed_workspace_id: uuid.UUID | None) -> None:
        """404 unless a client-supplied workspace id (e.g. in a body) is this workspace."""
        if claimed_workspace_id is not None and claimed_workspace_id != self.workspace_id:
            raise not_found(WORKSPACE_NOT_FOUND)


@dataclass(frozen=True)
class ResourceAccess:
    resource_type: ResourceType
    resource_id: uuid.UUID
    workspace: WorkspaceAccess


def not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def decide(
    record: MembershipRecord | None,
    action: Action,
    *,
    not_found_detail: str = WORKSPACE_NOT_FOUND,
) -> WorkspaceAccess:
    """Apply the permission matrix to a membership lookup (pure; raises the HTTP outcome)."""
    if record is None:
        raise not_found(not_found_detail)
    policy = policy_for(action)
    if not policy.allows(record.role):
        raise ProblemException(
            403,
            ProblemType.INSUFFICIENT_ROLE,
            detail="Your role in this workspace does not allow this action.",
        )
    if record.archived and not policy.allowed_when_archived:
        raise ProblemException(
            403,
            ProblemType.WORKSPACE_ARCHIVED,
            detail="This workspace is archived and read-only. Restore it to make changes.",
        )
    return WorkspaceAccess(
        workspace_id=record.workspace_id,
        user_id=record.user_id,
        role=record.role,
        status=record.status,
        action=action,
    )


def authorize_workspace(
    repo: AccessRepository,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    action: Action,
    lock: LockMode | None = None,
    *,
    not_found_detail: str = WORKSPACE_NOT_FOUND,
) -> WorkspaceAccess:
    """Check `action` for `user_id` in `workspace_id` inside the caller's transaction.

    `lock=None` uses the action's default lock from the permission matrix.
    """
    mode = policy_for(action).lock if lock is None else lock
    record = repo.load_membership(workspace_id, user_id, mode)
    return decide(record, action, not_found_detail=not_found_detail)


def authorize_resource(
    repo: AccessRepository,
    user_id: uuid.UUID,
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    action: Action,
    *,
    claimed_workspace_id: uuid.UUID | None = None,
    lock: LockMode | None = None,
) -> ResourceAccess:
    """Resolve the resource's real workspace from the DB, then authorize like a workspace.

    A missing resource and a resource outside `claimed_workspace_id` both answer 404 with the
    same body as an invisible workspace.
    """
    detail = f"{resource_type.value.capitalize()} not found."
    mode = policy_for(action).lock if lock is None else lock
    # One query: the resource's real workspace and the caller's membership in it (PERF-1).
    record = repo.load_resource_membership(resource_type, resource_id, user_id, mode)
    if record is not None and claimed_workspace_id not in (None, record.workspace_id):
        record = None
    access = decide(record, action, not_found_detail=detail)
    return ResourceAccess(resource_type=resource_type, resource_id=resource_id, workspace=access)


def _path_uuid(name: str) -> inspect.Parameter:
    return inspect.Parameter(
        name, inspect.Parameter.KEYWORD_ONLY, annotation=Annotated[uuid.UUID, Path()]
    )


def _with_signature(fn: Callable[..., Any], params: list[inspect.Parameter]) -> None:
    fn.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]


_USER = inspect.Parameter("user", inspect.Parameter.KEYWORD_ONLY, annotation=CurrentUser)
_REPO = inspect.Parameter("repo", inspect.Parameter.KEYWORD_ONLY, annotation=AccessRepo)


def require_workspace_access(
    action: Action, *, param: str = "workspace_id", lock: LockMode | None = None
) -> Callable[..., WorkspaceAccess]:
    """Dependency for routes addressed by workspace id in the path, e.g.

    `access: Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.DOCUMENT_EDIT))]`
    on `/workspaces/{workspace_id}/documents`.
    """

    def dependency(**kwargs: Any) -> WorkspaceAccess:
        return authorize_workspace(
            kwargs["repo"], kwargs["user"].id, kwargs[param], action, lock=lock
        )

    _with_signature(dependency, [_path_uuid(param), _USER, _REPO])
    return dependency


def require_resource_access(
    resource_type: ResourceType,
    action: Action,
    *,
    param: str,
    workspace_param: str | None = None,
    lock: LockMode | None = None,
) -> Callable[..., ResourceAccess]:
    """Dependency for routes addressed by a resource id in the path, e.g. `/jobs/{job_id}`
    (`param="job_id"`). With `workspace_param`, the path also names a workspace
    (`/workspaces/{workspace_id}/jobs/{job_id}`) that must be the resource's real workspace."""
    if workspace_param == param:
        raise ValueError("param and workspace_param must differ")

    def dependency(**kwargs: Any) -> ResourceAccess:
        return authorize_resource(
            kwargs["repo"],
            kwargs["user"].id,
            resource_type,
            kwargs[param],
            action,
            claimed_workspace_id=kwargs[workspace_param] if workspace_param else None,
            lock=lock,
        )

    params = [_path_uuid(param)]
    if workspace_param:
        params.append(_path_uuid(workspace_param))
    _with_signature(dependency, [*params, _USER, _REPO])
    return dependency
