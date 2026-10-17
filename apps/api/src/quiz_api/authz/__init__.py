"""Workspace authorization: permission matrix, DB lookups and FastAPI dependencies."""

from quiz_api.authz.dependencies import (
    ResourceAccess,
    WorkspaceAccess,
    authorize_resource,
    authorize_workspace,
    decide,
    get_access_repository,
    require_resource_access,
    require_workspace_access,
)
from quiz_api.authz.permissions import PERMISSIONS, Action, ActionPolicy, LockMode, Role
from quiz_api.authz.repository import (
    RESOURCES,
    AccessRepository,
    MembershipRecord,
    ResourceBinding,
    ResourceType,
    SqlAccessRepository,
)

__all__ = [
    "PERMISSIONS",
    "RESOURCES",
    "AccessRepository",
    "Action",
    "ActionPolicy",
    "LockMode",
    "MembershipRecord",
    "ResourceAccess",
    "ResourceBinding",
    "ResourceType",
    "Role",
    "SqlAccessRepository",
    "WorkspaceAccess",
    "authorize_resource",
    "authorize_workspace",
    "decide",
    "get_access_repository",
    "require_resource_access",
    "require_workspace_access",
]
