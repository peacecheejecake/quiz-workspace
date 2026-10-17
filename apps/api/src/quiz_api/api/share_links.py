"""Owner share-link API (S1a, WS-SHARE-01; docs/workspace-sharing.md §1-§5).

    POST /workspaces/{id}/share-links                    issue a link (owner; not while archived);
                                                         201 with the secret, shown only here
    GET  /workspaces/{id}/share-links                    every link, newest first, no secret
    PATCH /workspaces/{id}/share-links/{linkId}          allow_fork / expires_at (owner; also
                                                         archived); revoked links are 409
    POST /workspaces/{id}/share-links/{linkId}/revoke    owner (also archived); repeat = no-op
    POST /workspaces/{id}/share-links/{linkId}/rotate    revoke + issue a replacement with the same
                                                         policy in one transaction (owner; not
                                                         while archived); 201 with the new secret

Authorization (A1.3 matrix): `workspace.share.create` for issue/rotate, `workspace.share.manage`
for list/PATCH/revoke; editors and viewers get 403 `insufficient-role`, non-members and
soft-deleted workspaces 404. A link id is resolved to its real workspace from the DB, so a link
of another workspace is the same 404 as a missing one.

Secrets: 32 CSPRNG bytes, returned once as unpadded base64url in `secret` and in
`share_url = <web origin>/share/{id}#k={secret}` (fragment only: it never reaches a server log
or a Referer). Only SHA-256 of the bytes is stored (`quiz_api.share_secrets`). Responses under
/api/v1 are `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

Idempotency-Key (issue and rotate): the secret is never written to the idempotency store. A
replay of a completed request returns the same status and the link's metadata with
`secret: null`, `share_url: null` and `secret_already_issued: true` (and `Idempotent-Replayed:
true`); a client that lost the first response rotates the link to get a new secret. Revoke is
naturally idempotent and PATCH is a set, so neither takes a key.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.orm import Session

from quiz_api.authz import (
    Action,
    LockMode,
    ResourceAccess,
    ResourceType,
    WorkspaceAccess,
    require_resource_access,
    require_workspace_access,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.share_links import (
    ShareLinkRecord,
    ShareLinkRepository,
    ShareLinkStatus,
)
from quiz_api.settings import Settings
from quiz_api.share_secrets import issue_secret

router = APIRouter(
    prefix="/workspaces/{workspace_id}/share-links",
    tags=["sharing"],
    responses=problem_responses(503),
)


class ShareLink(BaseModel):
    """A share link's metadata (never its secret or digest)."""

    id: uuid.UUID = Field(description="The public share id (`/share/{id}`).")
    workspace_id: uuid.UUID
    allow_fork: bool = Field(description="Whether signed-in viewers may fork (default off).")
    expires_at: datetime | None = Field(description="Null: never expires.")
    revoked_at: datetime | None
    status: ShareLinkStatus = Field(description="Derived from revoked_at / expires_at.")
    rotated_from_id: uuid.UUID | None = Field(
        description="The revoked link this one replaced (rotate)."
    )
    created_at: datetime
    updated_at: datetime


class IssuedShareLink(ShareLink):
    secret: str | None = Field(
        description=(
            "The link secret (unpadded base64url, 32 bytes). Returned only in this response; "
            "null when an Idempotency-Key retry replays an earlier issue."
        )
    )
    share_url: str | None = Field(
        description="`<web origin>/share/{id}#k={secret}`; null exactly when `secret` is."
    )
    secret_already_issued: bool = Field(
        description="True on an Idempotency-Key replay: the secret was shown once already."
    )


class ShareLinkList(BaseModel):
    items: list[ShareLink]


def _future(value: datetime | None) -> datetime | None:
    if value is not None and value <= datetime.now(UTC):
        raise ValueError("expires_at must be in the future")
    return value


class ShareLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow_fork: bool = False
    expires_at: AwareDatetime | None = Field(
        default=None, description="Future instant with a UTC offset; null or absent: no expiry."
    )

    @field_validator("expires_at")
    @classmethod
    def _check_expiry(cls, value: datetime | None) -> datetime | None:
        return _future(value)


class ShareLinkUpdate(BaseModel):
    """Only the fields present change; `expires_at: null` removes the expiry."""

    model_config = ConfigDict(extra="forbid")

    allow_fork: bool | None = None
    expires_at: AwareDatetime | None = None

    @field_validator("expires_at")
    @classmethod
    def _check_expiry(cls, value: datetime | None) -> datetime | None:
        return _future(value)

    @model_validator(mode="after")
    def _allow_fork_not_null(self) -> ShareLinkUpdate:
        if "allow_fork" in self.model_fields_set and self.allow_fork is None:
            raise ValueError("allow_fork must be true or false")
        return self

    def changes(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.model_fields_set}


def get_share_link_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ShareLinkRepository:
    return ShareLinkRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


ShareLinkRepo = Annotated[ShareLinkRepository, Depends(get_share_link_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]

CreateAccess = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.SHARE_CREATE))]
ListAccess = Annotated[
    WorkspaceAccess, Depends(require_workspace_access(Action.SHARE_MANAGE, lock=LockMode.NONE))
]


def _link_access(action: Action) -> Any:
    return Depends(
        require_resource_access(
            ResourceType.SHARE_LINK, action, param="link_id", workspace_param="workspace_id"
        )
    )


ManageLinkAccess = Annotated[ResourceAccess, _link_access(Action.SHARE_MANAGE)]
RotateLinkAccess = Annotated[ResourceAccess, _link_access(Action.SHARE_CREATE)]


def _out(record: ShareLinkRecord) -> ShareLink:
    return ShareLink(
        id=record.id,
        workspace_id=record.workspace_id,
        allow_fork=record.allow_fork,
        expires_at=record.expires_at,
        revoked_at=record.revoked_at,
        status=record.status,
        rotated_from_id=record.rotated_from_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _issued(record: ShareLinkRecord, secret: str | None, settings: Settings) -> IssuedShareLink:
    share_url = (
        None if secret is None else f"{settings.share_web_origin}/share/{record.id}#k={secret}"
    )
    return IssuedShareLink(
        **_out(record).model_dump(),
        secret=secret,
        share_url=share_url,
        secret_already_issued=secret is None,
    )


def _inactive(detail: str) -> ProblemException:
    return ProblemException(409, ProblemType.SHARE_LINK_INACTIVE, detail=detail)


def _issue(
    scope: str,
    body_hash: str,
    user_id: uuid.UUID,
    idempotency: IdempotencyStore,
    idempotency_key: str | None,
    repo: ShareLinkRepository,
    settings: Settings,
    run: Any,
) -> Any:
    """Shared Idempotency-Key handling of issue and rotate; `run(digest)` does the write."""
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)
    secret = issue_secret()
    record: ShareLinkRecord = run(secret.digest)
    if idempotency_key is not None:
        # The replay body: metadata only, never the secret.
        idempotency.save(
            user_id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_201_CREATED,
            _issued(record, None, settings).model_dump(mode="json"),
        )
    repo.commit()
    return _issued(record, secret.value, settings)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=IssuedShareLink,
    operation_id="createShareLink",
    responses=problem_responses(409),
)
def create_share_link(
    access: CreateAccess,
    body: ShareLinkCreate,
    repo: ShareLinkRepo,
    idempotency: IdempotencyStoreDep,
    settings: SettingsDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Issue a read-only share link (WS-SHARE-01-AC02). Fork is off unless `allow_fork`.

    The secret appears only in this response. A link is not a membership.
    """
    return _issue(
        f"POST /workspaces/{access.workspace_id}/share-links",
        request_hash(body.model_dump(mode="json")),
        access.user_id,
        idempotency,
        idempotency_key,
        repo,
        settings,
        lambda digest: repo.create(
            access.workspace_id,
            access.user_id,
            token_digest=digest,
            allow_fork=body.allow_fork,
            expires_at=body.expires_at,
        ),
    )


@router.get("", operation_id="listShareLinks")
def list_share_links(access: ListAccess, repo: ShareLinkRepo) -> ShareLinkList:
    """Every link of the workspace (revoked and expired included), newest first; no secrets."""
    return ShareLinkList(items=[_out(r) for r in repo.list(access.workspace_id)])


@router.patch("/{link_id}", operation_id="updateShareLink", responses=problem_responses(409))
def update_share_link(
    access: ManageLinkAccess, body: ShareLinkUpdate, repo: ShareLinkRepo
) -> ShareLink:
    """Change `allow_fork` and/or `expires_at` (WS-SHARE-01-AC03; allowed on archived).

    A revoked link is final (409 `share-link-inactive`); an expired one can get a new expiry.
    """
    ws = access.workspace
    link = repo.lock(ws.workspace_id, access.resource_id)
    if link.revoked_at is not None:
        raise _inactive("This share link is revoked; create a new link instead.")
    record = repo.update_policy(link, ws.user_id, body.changes())
    repo.commit()
    return _out(record)


@router.post("/{link_id}/revoke", operation_id="revokeShareLink")
def revoke_share_link(access: ManageLinkAccess, repo: ShareLinkRepo) -> ShareLink:
    """Revoke at once (WS-SHARE-01-AC04; allowed on archived). Repeating it is a no-op."""
    ws = access.workspace
    record = repo.revoke(repo.lock(ws.workspace_id, access.resource_id), ws.user_id)
    repo.commit()
    return _out(record)


@router.post(
    "/{link_id}/rotate",
    status_code=status.HTTP_201_CREATED,
    response_model=IssuedShareLink,
    operation_id="rotateShareLink",
    responses=problem_responses(409),
)
def rotate_share_link(
    access: RotateLinkAccess,
    repo: ShareLinkRepo,
    idempotency: IdempotencyStoreDep,
    settings: SettingsDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Revoke the link and issue a replacement (new id and secret, same policy) atomically.

    Only an active link can be rotated (409 `share-link-inactive` for revoked or expired ones:
    extend the expiry first, or create a new link).
    """
    ws = access.workspace

    def run(digest: bytes) -> ShareLinkRecord:
        link = repo.lock(ws.workspace_id, access.resource_id)
        if link.status != "active":
            raise _inactive("Only an active share link can be rotated.")
        return repo.rotate(link, ws.user_id, token_digest=digest)

    return _issue(
        f"POST /workspaces/{ws.workspace_id}/share-links/{access.resource_id}/rotate",
        request_hash({}),
        ws.user_id,
        idempotency,
        idempotency_key,
        repo,
        settings,
        run,
    )
