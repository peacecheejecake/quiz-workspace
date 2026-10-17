"""Role → permission matrix for workspace-scoped actions (docs/auth.md §4).

`PERMISSIONS` is the single source of truth: one row per action with the roles allowed to
perform it, whether it is allowed while the workspace is archived, and the row lock the
authorization query takes so the check and the action happen in one transaction.

Role draft (auth.md §4): owner = everything; editor = edit documents/questions + practice;
viewer = read + own practice/favorites. Archived workspaces are read-only: only the owner's
lifecycle actions (restore, delete, archive itself) and share-link revocation/policy changes
(docs/screens/workspace-sharing.md) remain possible. Personal practice writes count as writes.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final


class Role(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class LockMode(StrEnum):
    """Row lock taken on the workspace and membership rows by the authorization query.

    The lock lives until the request transaction ends, so a route that checks and then acts in
    the same session cannot race a concurrent archive/delete/role change.
    """

    NONE = "none"
    # FOR SHARE: content writes. Blocks a concurrent archive/delete/membership change of the
    # same rows (which take UPDATE) until commit; does not block other readers or writers.
    SHARE = "share"
    # FOR NO KEY UPDATE: lifecycle and membership changes. Serialises against SHARE holders and
    # other lifecycle changes; does not block inserts of rows referencing the workspace.
    UPDATE = "update"


class Action(StrEnum):
    # Read anything in the workspace: metadata, documents, questions, search, jobs, activities.
    READ = "workspace.read"
    # The caller's own practice data: practice sessions, attempts, my-state, favorites.
    PRACTICE = "workspace.practice"
    DOCUMENT_EDIT = "document.edit"
    # Questions, drafts, generation/import runs and their approval.
    QUESTION_EDIT = "question.edit"
    WORKSPACE_UPDATE = "workspace.update"
    WORKSPACE_ARCHIVE = "workspace.archive"
    WORKSPACE_RESTORE = "workspace.restore"
    WORKSPACE_DELETE = "workspace.delete"
    MEMBERS_MANAGE = "workspace.members.manage"
    SHARE_CREATE = "workspace.share.create"
    # Revoke a share link or change its policy (allow_fork, expiry).
    SHARE_MANAGE = "workspace.share.manage"


@dataclass(frozen=True)
class ActionPolicy:
    roles: frozenset[Role]
    writes: bool
    allowed_when_archived: bool
    lock: LockMode

    def allows(self, role: Role) -> bool:
        return role in self.roles


_ALL = frozenset(Role)
_EDITORS = frozenset({Role.OWNER, Role.EDITOR})
_OWNER = frozenset({Role.OWNER})


def _read(roles: frozenset[Role]) -> ActionPolicy:
    return ActionPolicy(roles, writes=False, allowed_when_archived=True, lock=LockMode.NONE)


def _write(roles: frozenset[Role], *, archived_ok: bool = False) -> ActionPolicy:
    return ActionPolicy(roles, writes=True, allowed_when_archived=archived_ok, lock=LockMode.SHARE)


def _lifecycle(*, archived_ok: bool) -> ActionPolicy:
    return ActionPolicy(
        _OWNER, writes=True, allowed_when_archived=archived_ok, lock=LockMode.UPDATE
    )


PERMISSIONS: Final[Mapping[Action, ActionPolicy]] = MappingProxyType(
    {
        Action.READ: _read(_ALL),
        Action.PRACTICE: _write(_ALL),
        Action.DOCUMENT_EDIT: _write(_EDITORS),
        Action.QUESTION_EDIT: _write(_EDITORS),
        Action.WORKSPACE_UPDATE: _lifecycle(archived_ok=False),
        # Allowed on an archived workspace so M3.1a can answer a repeated archive idempotently.
        Action.WORKSPACE_ARCHIVE: _lifecycle(archived_ok=True),
        Action.WORKSPACE_RESTORE: _lifecycle(archived_ok=True),
        Action.WORKSPACE_DELETE: _lifecycle(archived_ok=True),
        Action.MEMBERS_MANAGE: _lifecycle(archived_ok=False),
        Action.SHARE_CREATE: _write(_OWNER),
        Action.SHARE_MANAGE: _write(_OWNER, archived_ok=True),
    }
)

# Fail at import, not at request time, if an action is added without a policy.
if set(PERMISSIONS) != set(Action):  # pragma: no cover - guarded by tests
    raise RuntimeError("every Action needs a row in PERMISSIONS")


def policy_for(action: Action) -> ActionPolicy:
    return PERMISSIONS[action]
