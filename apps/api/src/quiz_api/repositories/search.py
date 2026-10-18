"""Reads that build the server-side search scope and the excerpt content (M3.6a).

Runs in the request session after the route authorized the caller for the workspace. The scope
comes from the database only: non-deleted documents of the workspace and their *active*
revision, which must be published (implementation-plan §7: DB-published revision ids are the
authority, Qdrant is a mirror). Nothing here writes.
"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from sqlalchemy import RowMapping, or_, select
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import chapters, content_blocks, document_revisions, documents

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


@dataclass(frozen=True)
class SearchableDocument:
    id: uuid.UUID
    title: str
    document_type: str
    sha256: str
    revision_id: uuid.UUID
    revision_number: int


@dataclass(frozen=True)
class ChapterRow:
    id: uuid.UUID
    document_id: uuid.UUID
    revision_id: uuid.UUID
    parent_id: uuid.UUID | None
    section_key: str
    title: str
    level: int
    sort_order: int
    heading_block_id: str | None


def _chapter(row: RowMapping) -> ChapterRow:
    return ChapterRow(
        id=row["id"],
        document_id=row["document_id"],
        revision_id=row["document_revision_id"],
        parent_id=row["parent_id"],
        section_key=row["section_key"],
        title=row["title"],
        level=row["level"],
        sort_order=row["sort_order"],
        heading_block_id=row["heading_block_id"],
    )


_CHAPTER_COLUMNS = (
    chapters.c.id,
    chapters.c.document_id,
    chapters.c.document_revision_id,
    chapters.c.parent_id,
    chapters.c.section_key,
    chapters.c.title,
    chapters.c.level,
    chapters.c.sort_order,
    chapters.c.heading_block_id,
)


class SearchRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def end_read(self) -> None:
        """End the read transaction before the (slow) index query; later reads start anew."""
        self._session.rollback()

    def searchable_documents(self, workspace_id: uuid.UUID) -> list[SearchableDocument]:
        """Non-deleted documents with a published active revision, oldest first."""
        rows = self._session.execute(
            select(
                documents.c.id,
                documents.c.title,
                documents.c.document_type,
                documents.c.sha256,
                document_revisions.c.id.label("revision_id"),
                document_revisions.c.revision_number,
            )
            .join(
                document_revisions,
                (document_revisions.c.id == documents.c.active_revision_id)
                & (document_revisions.c.document_id == documents.c.id),
            )
            .where(
                documents.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
                document_revisions.c.workspace_id == workspace_id,
                document_revisions.c.status == "published",
            )
            .order_by(documents.c.created_at, documents.c.id)
        )
        return [
            SearchableDocument(
                id=row.id,
                title=row.title,
                document_type=row.document_type,
                sha256=row.sha256,
                revision_id=row.revision_id,
                revision_number=row.revision_number,
            )
            for row in rows
        ]

    def existing_documents(
        self, workspace_id: uuid.UUID, document_ids: Collection[uuid.UUID]
    ) -> set[uuid.UUID]:
        """Which of `document_ids` are non-deleted documents of this workspace."""
        if not document_ids:
            return set()
        rows = self._session.execute(
            select(documents.c.id).where(
                documents.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
                documents.c.id.in_(list(document_ids)),
            )
        )
        return {row.id for row in rows}

    def chapters_by_id(
        self, workspace_id: uuid.UUID, chapter_ids: Collection[uuid.UUID]
    ) -> list[ChapterRow]:
        """Chapters (of any revision) of non-deleted documents of this workspace."""
        if not chapter_ids:
            return []
        rows = self._session.execute(
            select(*_CHAPTER_COLUMNS)
            .join(documents, documents.c.id == chapters.c.document_id)
            .where(
                chapters.c.workspace_id == workspace_id,
                documents.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
                chapters.c.id.in_(list(chapter_ids)),
            )
        ).mappings()
        return [_chapter(row) for row in rows]

    def chapters_of(self, revision_ids: Collection[uuid.UUID]) -> list[ChapterRow]:
        if not revision_ids:
            return []
        rows = self._session.execute(
            select(*_CHAPTER_COLUMNS)
            .where(chapters.c.document_revision_id.in_(list(revision_ids)))
            .order_by(chapters.c.document_revision_id, chapters.c.sort_order)
        ).mappings()
        return [_chapter(row) for row in rows]

    def blocks(
        self,
        revision_id: uuid.UUID,
        *,
        chapter_ids: Sequence[uuid.UUID] | None = None,
        without_chapter: bool = False,
    ) -> list[RowMapping]:
        """Blocks of a revision in reading order; with `chapter_ids`, only blocks of those
        chapters (plus blocks outside any chapter when `without_chapter`)."""
        stmt = select(*_BLOCK_COLUMNS).where(content_blocks.c.document_revision_id == revision_id)
        if chapter_ids is not None:
            conditions = [content_blocks.c.chapter_id.in_(list(chapter_ids))]
            if without_chapter:
                conditions.append(content_blocks.c.chapter_id.is_(None))
            stmt = stmt.where(or_(*conditions))
        return list(self._session.execute(stmt.order_by(content_blocks.c.ordinal)).mappings())
