"""The chapter an import draft is registered under (CHAPTER-MAP, QIMPORT-01-AC08): the workspace's
book chapters, the question PDF chapters of drafts, and chapter resolution to a book's current
revision (20261023130000_question_draft_chapters.sql). Reads only; callers commit.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.orm import Session, aliased

from quiz_api.chapter_matching import BookChapter
from quiz_api.repositories.tables import chapters, content_blocks, documents

BOOK = "book"
QUESTION_PAPER = "question_paper"


@dataclass(frozen=True)
class SourceRef:
    """Where a draft starts in the question PDF: its first source block, else its first page."""

    block_id: str | None
    page: int | None


def _document_title() -> ColumnElement[str]:
    return func.coalesce(func.nullif(documents.c.title, ""), documents.c.filename)


class DraftChapterRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        """Outline nodes of the current revision of every live book here, in outline order."""
        return self._current_outline(workspace_id, BOOK)

    def paper_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        """Level-1 outline nodes of the current revision of every live question paper here, in
        outline order (CHAP-MATCH: the fallback chapters and the editor's extra choices)."""
        return self._current_outline(workspace_id, QUESTION_PAPER, level_one=True)

    def _current_outline(
        self, workspace_id: uuid.UUID, document_type: str, *, level_one: bool = False
    ) -> list[BookChapter]:
        rows = self._session.execute(
            select(
                chapters.c.id,
                chapters.c.title,
                chapters.c.level,
                chapters.c.document_id,
                _document_title().label("document_title"),
            )
            .select_from(
                chapters.join(
                    documents,
                    and_(
                        documents.c.workspace_id == chapters.c.workspace_id,
                        documents.c.id == chapters.c.document_id,
                        documents.c.active_revision_id == chapters.c.document_revision_id,
                    ),
                )
            )
            .where(
                chapters.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
                documents.c.document_type == document_type,
                *([chapters.c.level == 1] if level_one else []),
            )
            .order_by(
                documents.c.created_at,
                documents.c.id,
                chapters.c.sort_order,
                chapters.c.id,
            )
        )
        return [
            BookChapter(r.id, r.title, r.document_id, r.document_title, int(r.level)) for r in rows
        ]

    def source_chapters(
        self,
        workspace_id: uuid.UUID,
        revision_id: uuid.UUID,
        refs: Mapping[uuid.UUID, SourceRef],
    ) -> dict[uuid.UUID, uuid.UUID | None]:
        """Per key: the outline node (`content_blocks.chapter_id`) of its first source block in
        this document revision, else of the first block (reading order) of its first page; None
        when neither is found or the block has no chapter."""
        if not refs:
            return {}
        block_ids = sorted({r.block_id for r in refs.values() if r.block_id})
        by_block: dict[str, uuid.UUID | None] = {}
        if block_ids:
            by_block = {
                row.block_id: row.chapter_id
                for row in self._session.execute(
                    select(content_blocks.c.block_id, content_blocks.c.chapter_id).where(
                        content_blocks.c.workspace_id == workspace_id,
                        content_blocks.c.document_revision_id == revision_id,
                        content_blocks.c.block_id.in_(block_ids),
                    )
                )
            }
        pages = sorted(
            {r.page for r in refs.values() if r.page is not None and r.block_id not in by_block}
        )
        by_page: dict[int, uuid.UUID | None] = {}
        if pages:
            # The chapter of the page's first block (reading order).
            by_page = {
                row.page: row.chapter_id
                for row in self._session.execute(
                    select(content_blocks.c.page, content_blocks.c.chapter_id)
                    .where(
                        content_blocks.c.workspace_id == workspace_id,
                        content_blocks.c.document_revision_id == revision_id,
                        content_blocks.c.page.in_(pages),
                    )
                    .order_by(content_blocks.c.page, content_blocks.c.ordinal)
                    .distinct(content_blocks.c.page)
                )
            }
        out: dict[uuid.UUID, uuid.UUID | None] = {}
        for key, ref in refs.items():
            if ref.block_id is not None and ref.block_id in by_block:
                out[key] = by_block[ref.block_id]
            elif ref.page is not None:
                out[key] = by_page.get(ref.page)
            else:
                out[key] = None
        return out

    def source_chains(
        self,
        workspace_id: uuid.UUID,
        revision_id: uuid.UUID,
        refs: Mapping[uuid.UUID, SourceRef],
    ) -> dict[uuid.UUID, list[str]]:
        """Per draft: the outline titles of its first source block in the question PDF revision,
        deepest first (empty when the block has no chapter)."""
        if not refs:
            return {}
        nodes = self.source_chapters(workspace_id, revision_id, refs)
        outline = {
            row.id: (row.parent_id, row.title)
            for row in self._session.execute(
                select(chapters.c.id, chapters.c.parent_id, chapters.c.title).where(
                    chapters.c.workspace_id == workspace_id,
                    chapters.c.document_revision_id == revision_id,
                )
            )
        }

        def chain(node: uuid.UUID | None) -> list[str]:
            titles: list[str] = []
            seen: set[uuid.UUID] = set()
            while node is not None and node in outline and node not in seen:
                seen.add(node)
                parent, title = outline[node]
                titles.append(title)
                node = parent
            return titles

        return {key: chain(node) for key, node in nodes.items()}

    def source_top_levels(
        self,
        workspace_id: uuid.UUID,
        revision_id: uuid.UUID,
        refs: Mapping[uuid.UUID, SourceRef],
    ) -> dict[uuid.UUID, uuid.UUID]:
        """Per key: the top-level outline ancestor (the node without a parent, CHAP-MATCH) of
        its source block's chapter in this document revision. Keys whose block has no chapter
        are left out."""
        nodes = self.source_chapters(workspace_id, revision_id, refs)
        if not any(n is not None for n in nodes.values()):
            return {}
        parents = {
            row.id: row.parent_id
            for row in self._session.execute(
                select(chapters.c.id, chapters.c.parent_id).where(
                    chapters.c.workspace_id == workspace_id,
                    chapters.c.document_revision_id == revision_id,
                )
            )
        }
        out: dict[uuid.UUID, uuid.UUID] = {}
        for key, node in nodes.items():
            seen: set[uuid.UUID] = set()
            while node is not None and node in parents and node not in seen:
                seen.add(node)
                up = parents[node]
                if up is None or up not in parents:
                    out[key] = node
                    break
                node = up
        return out

    def current_book_chapters(
        self, workspace_id: uuid.UUID, chapter_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, BookChapter]:
        """chosen chapter id -> the same section in its book's current revision (missing when
        the book was deleted or the section no longer exists)."""
        return self.current_chapters(workspace_id, chapter_ids, book_only=True)

    def current_chapters(
        self,
        workspace_id: uuid.UUID,
        chapter_ids: Iterable[uuid.UUID],
        *,
        book_only: bool,
    ) -> dict[uuid.UUID, BookChapter]:
        """Like `current_book_chapters`; `book_only=False` also resolves chapters of question
        papers (CHAP-MATCH fallback)."""
        ids = sorted(set(chapter_ids))
        if not ids:
            return {}
        current = aliased(chapters)
        rows = self._session.execute(
            select(
                chapters.c.id.label("chosen_id"),
                current.c.id,
                current.c.title,
                current.c.level,
                current.c.document_id,
                _document_title().label("document_title"),
            )
            .select_from(
                chapters.join(
                    documents,
                    and_(
                        documents.c.workspace_id == chapters.c.workspace_id,
                        documents.c.id == chapters.c.document_id,
                    ),
                ).join(
                    current,
                    and_(
                        current.c.document_revision_id == documents.c.active_revision_id,
                        current.c.section_key == chapters.c.section_key,
                    ),
                )
            )
            .where(
                chapters.c.workspace_id == workspace_id,
                chapters.c.id.in_(ids),
                documents.c.deleted_at.is_(None),
                *([documents.c.document_type == BOOK] if book_only else []),
            )
        )
        return {
            r.chosen_id: BookChapter(r.id, r.title, r.document_id, r.document_title, int(r.level))
            for r in rows
        }

    def lock_documents_of(self, workspace_id: uuid.UUID, chapter_ids: Iterable[uuid.UUID]) -> None:
        """FOR SHARE on the books of these chapters, in id order (the question lock order: a
        revision publish either commits first or waits for this transaction)."""
        ids = sorted(set(chapter_ids))
        if not ids:
            return
        doc_ids = sorted(
            set(
                self._session.execute(
                    select(chapters.c.document_id).where(
                        chapters.c.workspace_id == workspace_id, chapters.c.id.in_(ids)
                    )
                ).scalars()
            )
        )
        if doc_ids:
            self._session.execute(
                select(documents.c.id)
                .where(documents.c.workspace_id == workspace_id, documents.c.id.in_(doc_ids))
                .order_by(documents.c.id)
                .with_for_update(read=True)
            ).all()
