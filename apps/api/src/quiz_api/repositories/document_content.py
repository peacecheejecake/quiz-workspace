"""Revision content reads and correction writes (M3.4, DOC-02).

Runs in the request session after the route authorized the caller; nothing here commits on its
own. Writers serialise on the document row (`lock_document`, FOR UPDATE: draft creation, edits,
publish requests and the worker's publish transaction all take it first) and then on the draft
revision row (FOR UPDATE). The revision content guard (20261017210000) additionally refuses any
chapter/block write once the revision is published.

Draft model: a document has at most one *correction draft*: the newest revision, status `draft`,
numbered above the active (published) revision. It is created on the first correction by copying
the chapters and blocks of the active revision (new chapter ids, same section keys / block ids),
so block ids, provenance and order are stable across revisions.

`content_hash` of a correction draft is NULL until a publish is requested; from then on every
content write recomputes it, so the parse job (which reuses stored content of a draft with a hash
instead of re-parsing the PDF) never sees content that does not match it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from book_core.contracts import DocumentRevision
from sqlalchemy import RowMapping, func, insert, select, text, update
from sqlalchemy.orm import Session

from quiz_api.document_content import revision_from_rows
from quiz_api.repositories.documents import (
    _JOB_COLUMNS,
    PARSE_JOB_SCHEMA_VERSION,
    PARSE_JOB_TYPE,
    JobRow,
    RevisionStatus,
    _job,
)
from quiz_api.repositories.tables import (
    activity_events,
    async_jobs,
    chapters,
    content_blocks,
    document_revisions,
    documents,
)

ACTIVE_JOB_STATUSES = ("queued", "running")


@dataclass(frozen=True)
class DocumentRef:
    id: uuid.UUID
    workspace_id: uuid.UUID
    sha256: str
    source_object_key: str
    active_revision_id: uuid.UUID | None


@dataclass(frozen=True)
class RevisionRow:
    id: uuid.UUID
    document_id: uuid.UUID
    revision_number: int
    parent_revision_id: uuid.UUID | None
    status: RevisionStatus
    content_hash: str | None
    parser_version: str | None
    published_at: datetime | None
    created_at: datetime

    @property
    def is_draft(self) -> bool:
        return self.status == "draft"


@dataclass(frozen=True)
class JobBrief:
    id: uuid.UUID
    status: str


_REVISION_COLUMNS = (
    document_revisions.c.id,
    document_revisions.c.document_id,
    document_revisions.c.revision_number,
    document_revisions.c.parent_revision_id,
    document_revisions.c.status,
    document_revisions.c.content_hash,
    document_revisions.c.parser_version,
    document_revisions.c.published_at,
    document_revisions.c.created_at,
)

_CHAPTER_COLUMNS = (
    chapters.c.id,
    chapters.c.parent_id,
    chapters.c.section_key,
    chapters.c.level,
    chapters.c.sort_order,
    chapters.c.title,
    chapters.c.page,
    chapters.c.heading_block_id,
)

_BLOCK_COLUMNS = (
    content_blocks.c.block_id,
    content_blocks.c.ordinal,
    content_blocks.c.chapter_id,
    content_blocks.c.block_type,
    content_blocks.c.text,
    content_blocks.c.page,
    content_blocks.c.provenance,
    content_blocks.c.attributes,
    content_blocks.c.edited,
)

# Copy a revision's chapter tree under new ids (parents mapped through the same CTE, which is
# materialised once: it is referenced twice and calls a volatile function). The parent FK is
# checked at the end of the statement, so row order does not matter.
_COPY_CHAPTERS = text(
    """
    with src as (
      select * from public.chapters where document_revision_id = :src
    ), ids as (
      select id as old_id, gen_random_uuid() as new_id from src
    )
    insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                                 section_key, level, sort_order, title, page, heading_block_id)
    select i.new_id, s.workspace_id, s.document_id, :dst, p.new_id, s.section_key, s.level,
           s.sort_order, s.title, s.page, s.heading_block_id
      from src s
      join ids i on i.old_id = s.id
      left join ids p on p.old_id = s.parent_id
    """
)

# Then the blocks, re-pointed at the copied chapter with the same section key.
_COPY_BLOCKS = text(
    """
    insert into public.content_blocks (workspace_id, document_id, document_revision_id, block_id,
                                       ordinal, chapter_id, block_type, text, page, provenance,
                                       attributes, edited)
    select b.workspace_id, b.document_id, :dst, b.block_id, b.ordinal, nc.id, b.block_type,
           b.text, b.page, b.provenance, b.attributes, b.edited
      from public.content_blocks b
      left join public.chapters oc on oc.id = b.chapter_id
      left join public.chapters nc
        on nc.document_revision_id = :dst and nc.section_key = oc.section_key
     where b.document_revision_id = :src
    """
)

# A chapter and all its descendants (same revision).
_SUBTREE = text(
    """
    with recursive tree as (
      select id from public.chapters where document_revision_id = :r and id = :c
      union all
      select c.id from public.chapters c join tree t on c.parent_id = t.id
       where c.document_revision_id = :r
    )
    select id from tree
    """
)


def _revision(row: Any) -> RevisionRow:
    return RevisionRow(
        id=row.id,
        document_id=row.document_id,
        revision_number=row.revision_number,
        parent_revision_id=row.parent_revision_id,
        status=cast(RevisionStatus, row.status),
        content_hash=row.content_hash,
        parser_version=row.parser_version,
        published_at=row.published_at,
        created_at=row.created_at,
    )


class DocumentContentRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- documents and revisions ----------------------------------------------------------------

    def document(self, document_id: uuid.UUID, *, lock: bool = False) -> DocumentRef:
        """A document the route already authorized. `lock` = FOR UPDATE (every content writer
        and the worker's publish take it first)."""
        stmt = select(
            documents.c.id,
            documents.c.workspace_id,
            documents.c.sha256,
            documents.c.source_object_key,
            documents.c.active_revision_id,
        ).where(documents.c.id == document_id)
        if lock:
            stmt = stmt.with_for_update()
        row = self._session.execute(stmt).one()
        return DocumentRef(
            id=row.id,
            workspace_id=row.workspace_id,
            sha256=row.sha256,
            source_object_key=row.source_object_key,
            active_revision_id=row.active_revision_id,
        )

    def revision(
        self, document_id: uuid.UUID, revision_id: uuid.UUID, *, lock: bool = False
    ) -> RevisionRow | None:
        stmt = select(*_REVISION_COLUMNS).where(
            document_revisions.c.document_id == document_id,
            document_revisions.c.id == revision_id,
        )
        if lock:
            stmt = stmt.with_for_update()
        row = self._session.execute(stmt).one_or_none()
        return _revision(row) if row is not None else None

    def latest_revision(self, document_id: uuid.UUID) -> RevisionRow | None:
        row = self._session.execute(
            select(*_REVISION_COLUMNS)
            .where(document_revisions.c.document_id == document_id)
            .order_by(document_revisions.c.revision_number.desc())
            .limit(1)
        ).one_or_none()
        return _revision(row) if row is not None else None

    def current_draft(self, document: DocumentRef, *, lock: bool = False) -> RevisionRow | None:
        """The correction draft: the newest revision if it is a draft numbered above the active
        revision (None without an active revision: the first parse is still pending)."""
        if document.active_revision_id is None:
            return None
        latest = self.latest_revision(document.id)
        if latest is None or not latest.is_draft or latest.id == document.active_revision_id:
            return None
        active = self.revision(document.id, document.active_revision_id)
        if active is None or latest.revision_number <= active.revision_number:
            return None
        return self.revision(document.id, latest.id, lock=True) if lock else latest

    def list_revisions(self, document_id: uuid.UUID) -> list[RevisionRow]:
        rows = self._session.execute(
            select(*_REVISION_COLUMNS)
            .where(document_revisions.c.document_id == document_id)
            .order_by(document_revisions.c.revision_number.desc())
        )
        return [_revision(row) for row in rows]

    def create_draft(
        self,
        document: DocumentRef,
        source: RevisionRow,
        *,
        parent_revision_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> RevisionRow:
        """Revision n+1 (draft) with a copy of `source`'s content. Call with the document row
        locked."""
        number = self._session.execute(
            select(func.max(document_revisions.c.revision_number)).where(
                document_revisions.c.document_id == document.id
            )
        ).scalar_one()
        draft_id = uuid.uuid4()
        self._session.execute(
            insert(document_revisions).values(
                id=draft_id,
                workspace_id=document.workspace_id,
                document_id=document.id,
                revision_number=int(number or 0) + 1,
                parent_revision_id=parent_revision_id,
                status="draft",
                parser_version=source.parser_version,
                source_object_key=document.source_object_key,
                created_by=actor_id,
            )
        )
        self._copy_content(source.id, draft_id)
        draft = self.revision(document.id, draft_id, lock=True)
        assert draft is not None  # noqa: S101 - inserted above
        return draft

    def replace_draft_content(self, draft: RevisionRow, source: RevisionRow) -> None:
        self._session.execute(
            text("delete from public.content_blocks where document_revision_id = :r"),
            {"r": draft.id},
        )
        self._session.execute(
            text("delete from public.chapters where document_revision_id = :r"), {"r": draft.id}
        )
        self._copy_content(source.id, draft.id)

    def _copy_content(self, source_id: uuid.UUID, draft_id: uuid.UUID) -> None:
        params = {"src": source_id, "dst": draft_id}
        self._session.execute(_COPY_CHAPTERS, params)
        self._session.execute(_COPY_BLOCKS, params)

    def set_content_hash(self, revision_id: uuid.UUID, content_hash: str) -> None:
        self._session.execute(
            update(document_revisions)
            .where(document_revisions.c.id == revision_id, document_revisions.c.status == "draft")
            .values(content_hash=content_hash)
        )

    # --- content --------------------------------------------------------------------------------

    def chapters(self, revision_id: uuid.UUID) -> list[RowMapping]:
        return list(
            self._session.execute(
                select(*_CHAPTER_COLUMNS).where(chapters.c.document_revision_id == revision_id)
            ).mappings()
        )

    def chapter_subtree(self, revision_id: uuid.UUID, chapter_id: uuid.UUID) -> list[uuid.UUID]:
        return [
            row.id for row in self._session.execute(_SUBTREE, {"r": revision_id, "c": chapter_id})
        ]

    def blocks(
        self,
        revision_id: uuid.UUID,
        *,
        chapter_ids: Sequence[uuid.UUID] | None = None,
        page: int | None = None,
        after: int | None = None,
        limit: int = 100,
    ) -> list[RowMapping]:
        stmt = select(*_BLOCK_COLUMNS).where(content_blocks.c.document_revision_id == revision_id)
        if chapter_ids is not None:
            stmt = stmt.where(content_blocks.c.chapter_id.in_(list(chapter_ids)))
        if page is not None:
            stmt = stmt.where(content_blocks.c.page == page)
        if after is not None:
            stmt = stmt.where(content_blocks.c.ordinal > after)
        stmt = stmt.order_by(content_blocks.c.ordinal).limit(limit)
        return list(self._session.execute(stmt).mappings())

    def block(self, revision_id: uuid.UUID, block_id: str) -> RowMapping | None:
        return (
            self._session.execute(
                select(*_BLOCK_COLUMNS).where(
                    content_blocks.c.document_revision_id == revision_id,
                    content_blocks.c.block_id == block_id,
                )
            )
            .mappings()
            .one_or_none()
        )

    def section_key(self, chapter_id: uuid.UUID) -> str | None:
        key = self._session.execute(
            select(chapters.c.section_key).where(chapters.c.id == chapter_id)
        ).scalar_one_or_none()
        return cast(str | None, key)

    def update_block(
        self, revision_id: uuid.UUID, block_id: str, *, new_text: str, attributes: dict[str, Any]
    ) -> None:
        self._session.execute(
            update(content_blocks)
            .where(
                content_blocks.c.document_revision_id == revision_id,
                content_blocks.c.block_id == block_id,
            )
            .values(text=new_text, attributes=attributes, edited=True)
        )

    def rename_section(self, revision_id: uuid.UUID, heading_block_id: str, title: str) -> None:
        self._session.execute(
            update(chapters)
            .where(
                chapters.c.document_revision_id == revision_id,
                chapters.c.heading_block_id == heading_block_id,
            )
            .values(title=title)
        )

    def load_content(self, document: DocumentRef, revision: RevisionRow) -> DocumentRevision:
        """The whole revision as a `DocumentRevision` (content hash computed)."""
        return revision_from_rows(
            document_id=str(document.id),
            revision_id=str(revision.id),
            revision_number=revision.revision_number,
            parent_revision_id=(
                str(revision.parent_revision_id) if revision.parent_revision_id else None
            ),
            source_sha256=document.sha256,
            chapters=self.chapters(revision.id),
            blocks=self.blocks(revision.id, limit=2**31 - 1),
        )

    # --- jobs and activity ----------------------------------------------------------------------

    def active_parse_job(self, workspace_id: uuid.UUID, revision_id: uuid.UUID) -> JobRow | None:
        """A queued or running `document.parse` job for this revision (a publish in flight)."""
        row = self._session.execute(
            select(*_JOB_COLUMNS)
            .where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.job_type == PARSE_JOB_TYPE,
                async_jobs.c.status.in_(ACTIVE_JOB_STATUSES),
                async_jobs.c.payload["revision_id"].astext == str(revision_id),
            )
            .order_by(async_jobs.c.created_at.desc())
            .limit(1)
        ).one_or_none()
        return _job(row) if row is not None else None

    def latest_parse_jobs(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID
    ) -> dict[uuid.UUID, JobBrief]:
        """revision id -> its newest `document.parse` job."""
        rows = self._session.execute(
            select(
                async_jobs.c.id,
                async_jobs.c.status,
                async_jobs.c.payload["revision_id"].astext.label("revision_id"),
            )
            .where(
                async_jobs.c.workspace_id == workspace_id,
                async_jobs.c.job_type == PARSE_JOB_TYPE,
                async_jobs.c.payload["document_id"].astext == str(document_id),
            )
            .order_by(async_jobs.c.created_at.asc())
        )
        found: dict[uuid.UUID, JobBrief] = {}
        for row in rows:
            try:
                found[uuid.UUID(row.revision_id)] = JobBrief(row.id, row.status)
            except (TypeError, ValueError):
                continue
        return found

    def create_parse_job(
        self, document: DocumentRef, revision_id: uuid.UUID, *, actor_id: uuid.UUID
    ) -> JobRow:
        job_id = uuid.uuid4()
        self._session.execute(
            insert(async_jobs).values(
                id=job_id,
                workspace_id=document.workspace_id,
                created_by=actor_id,
                job_type=PARSE_JOB_TYPE,
                schema_version=PARSE_JOB_SCHEMA_VERSION,
                # Deduplicated by the draft lock + `active_parse_job` instead: a failed publish
                # of the same draft must be retryable with a new job.
                idempotency_key=None,
                payload={"document_id": str(document.id), "revision_id": str(revision_id)},
            )
        )
        row = self._session.execute(select(*_JOB_COLUMNS).where(async_jobs.c.id == job_id)).one()
        return _job(row)

    def record_activity(
        self,
        document: DocumentRef,
        actor_id: uuid.UUID,
        event_type: str,
        metadata: dict[str, Any],
    ) -> None:
        # Ids only: never block text (activity_events must not carry raw book text).
        self._session.execute(
            insert(activity_events).values(
                workspace_id=document.workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="document",
                target_id=document.id,
                metadata=metadata,
            )
        )
