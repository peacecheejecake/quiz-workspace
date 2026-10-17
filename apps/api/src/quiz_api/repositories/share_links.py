"""Owner-side share-link reads and writes (S1a; docs/workspace-sharing.md §4-§5).

Runs in the request session after the route's authorization dependency (owner-only actions,
workspace and membership rows locked FOR SHARE); writes lock the link row itself (FOR UPDATE) so
concurrent revoke / rotate / policy edits of one link serialise. Every write records an
`activity_events` row in the same transaction; nothing here commits on its own.

`token_digest` is written here and never read back: no method returns it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

from sqlalchemy import case, func, insert, select, update
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import activity_events, workspace_share_links

ShareLinkStatus = Literal["active", "expired", "revoked"]

ShareLinkEventType = Literal[
    "share_link.created",
    "share_link.updated",
    "share_link.revoked",
    "share_link.rotated",
]

_t = workspace_share_links

# Derived from the DB clock so every reader agrees on "expired".
_STATUS = case(
    (_t.c.revoked_at.is_not(None), "revoked"),
    (_t.c.expires_at <= func.now(), "expired"),
    else_="active",
).label("status")

_COLUMNS = (
    _t.c.id,
    _t.c.workspace_id,
    _t.c.allow_fork,
    _t.c.expires_at,
    _t.c.revoked_at,
    _t.c.rotated_from_id,
    _t.c.created_at,
    _t.c.updated_at,
    _STATUS,
)


@dataclass(frozen=True)
class ShareLinkRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    allow_fork: bool
    expires_at: datetime | None
    revoked_at: datetime | None
    rotated_from_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    status: ShareLinkStatus


def _record(row: Any) -> ShareLinkRecord:
    return ShareLinkRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        allow_fork=row.allow_fork,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        rotated_from_id=row.rotated_from_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        status=cast(ShareLinkStatus, row.status),
    )


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class ShareLinkRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    # --- reads -----------------------------------------------------------------------------------

    def list(self, workspace_id: uuid.UUID) -> list[ShareLinkRecord]:
        """Every link of the workspace (revoked and expired included), newest first."""
        stmt = (
            select(*_COLUMNS)
            .where(_t.c.workspace_id == workspace_id)
            .order_by(_t.c.created_at.desc(), _t.c.id.desc())
        )
        return [_record(row) for row in self._session.execute(stmt)]

    def lock(self, workspace_id: uuid.UUID, link_id: uuid.UUID) -> ShareLinkRecord:
        """The link, locked FOR UPDATE (authorization already resolved it to this workspace)."""
        row = self._session.execute(
            select(*_COLUMNS)
            .where(_t.c.id == link_id, _t.c.workspace_id == workspace_id)
            .with_for_update(of=_t)
        ).one()
        return _record(row)

    # --- writes (caller commits) ----------------------------------------------------------------

    def create(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        *,
        token_digest: bytes,
        allow_fork: bool,
        expires_at: datetime | None,
    ) -> ShareLinkRecord:
        record = self._insert(workspace_id, actor_id, token_digest, allow_fork, expires_at, None)
        self._event(
            record,
            actor_id,
            "share_link.created",
            {"allow_fork": allow_fork, "expires_at": _iso(expires_at)},
        )
        return record

    def update_policy(
        self, link: ShareLinkRecord, actor_id: uuid.UUID, changes: dict[str, Any]
    ) -> ShareLinkRecord:
        """Apply `allow_fork` / `expires_at` changes; unchanged values record no event."""
        changed = {k: v for k, v in changes.items() if getattr(link, k) != v}
        if not changed:
            return link
        record = self._update(link.id, **changed)
        metadata = {
            k: _iso(v) if isinstance(v, datetime) or v is None else v for k, v in changed.items()
        }
        self._event(record, actor_id, "share_link.updated", metadata)
        return record

    def revoke(self, link: ShareLinkRecord, actor_id: uuid.UUID) -> ShareLinkRecord:
        """Idempotent: revoking a revoked link changes nothing and records no event."""
        if link.revoked_at is not None:
            return link
        record = self._update(link.id, revoked_at=func.now())
        self._event(record, actor_id, "share_link.revoked", {})
        return record

    def rotate(
        self, link: ShareLinkRecord, actor_id: uuid.UUID, *, token_digest: bytes
    ) -> ShareLinkRecord:
        """Revoke `link` and issue its replacement (same policy, new id and digest) atomically."""
        self._update(link.id, revoked_at=func.now())
        replacement = self._insert(
            link.workspace_id,
            actor_id,
            token_digest,
            link.allow_fork,
            link.expires_at,
            link.id,
        )
        self._event(link, actor_id, "share_link.rotated", {"replacement_id": str(replacement.id)})
        return replacement

    def _insert(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        token_digest: bytes,
        allow_fork: bool,
        expires_at: datetime | None,
        rotated_from_id: uuid.UUID | None,
    ) -> ShareLinkRecord:
        row = self._session.execute(
            insert(_t)
            .values(
                workspace_id=workspace_id,
                created_by=actor_id,
                token_digest=token_digest,
                allow_fork=allow_fork,
                expires_at=expires_at,
                rotated_from_id=rotated_from_id,
            )
            .returning(*_COLUMNS)
        ).one()
        return _record(row)

    def _update(self, link_id: uuid.UUID, **values: Any) -> ShareLinkRecord:
        row = self._session.execute(
            update(_t).where(_t.c.id == link_id).values(**values).returning(*_COLUMNS)
        ).one()
        return _record(row)

    def _event(
        self,
        link: ShareLinkRecord,
        actor_id: uuid.UUID,
        event_type: ShareLinkEventType,
        metadata: dict[str, Any],
    ) -> None:
        """Audit event on the workspace feed. Metadata holds policy values only, never secrets."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=link.workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="share_link",
                target_id=link.id,
                metadata=metadata,
            )
        )
