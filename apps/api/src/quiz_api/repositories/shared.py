"""Reads behind the guest share session (S1b; docs/workspace-sharing.md §2-§5).

`link()` is the first query of every shared request: the link row with its stored digest (to
check the session MAC or the presented secret) and its *usability*, derived in SQL from the DB
clock: not revoked, not expired, workspace neither soft-deleted nor deleting. An archived
workspace stays readable until the owner revokes the link.

Content reads reuse the member repositories (documents through `SearchRepository`'s published
scope, questions through `QuestionRepository`), always with the link's workspace id from this
row, never from the client. Nothing here writes.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import documents, workspace_share_links, workspaces

_l = workspace_share_links
_w = workspaces

_USABLE = case(
    (
        and_(
            _l.c.revoked_at.is_(None),
            (_l.c.expires_at.is_(None)) | (_l.c.expires_at > func.now()),
            _w.c.deleted_at.is_(None),
            _w.c.status != "deleted",
        ),
        True,
    ),
    else_=False,
).label("usable")


@dataclass(frozen=True)
class SharedLink:
    id: uuid.UUID
    workspace_id: uuid.UUID
    workspace_name: str
    archived: bool
    allow_fork: bool
    expires_at: datetime | None
    usable: bool
    token_digest: bytes = field(repr=False)


class SharedRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def end_read(self) -> None:
        self._session.rollback()

    def link(self, link_id: uuid.UUID) -> SharedLink | None:
        """The link (usable or not) with its workspace, or None if the id is unknown."""
        row = self._session.execute(
            select(
                _l.c.id,
                _l.c.workspace_id,
                _l.c.allow_fork,
                _l.c.expires_at,
                _l.c.token_digest,
                _w.c.name,
                _w.c.status,
                _USABLE,
            )
            .join(_w, _w.c.id == _l.c.workspace_id)
            .where(_l.c.id == link_id)
        ).one_or_none()
        if row is None:
            return None
        return SharedLink(
            id=row.id,
            workspace_id=row.workspace_id,
            workspace_name=row.name,
            archived=row.status == "archived",
            allow_fork=row.allow_fork,
            expires_at=row.expires_at,
            usable=bool(row.usable),
            token_digest=bytes(row.token_digest),
        )

    def source_object_key(self, workspace_id: uuid.UUID, document_id: uuid.UUID) -> str | None:
        """Storage key of a live document's original PDF in this workspace."""
        key: str | None = self._session.execute(
            select(documents.c.source_object_key).where(
                documents.c.id == document_id,
                documents.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
            )
        ).scalar_one_or_none()
        return key
