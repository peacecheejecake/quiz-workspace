"""Chapter edits on the active revision (CHMAN-01). Reads go straight to the tables; every write
to a published revision goes through the `chapter_edit_*` SECURITY DEFINER functions
(20261106150000_chapter_edit.sql): quiz_api holds no privilege that reaches past the guard.
Workspace chapters (UX12-CHAPTERADD) have no revision, so they are written directly.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, bindparam, delete, func, insert, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from quiz_api.chapter_tree import PlacedNode
from quiz_api.repositories.tables import (
    activity_events,
    chapter_notes,
    chapters,
    documents,
    question_drafts,
    question_import_runs,
    questions,
    workspace_chapter_trees,
)

BOOK = "book"
USER_KEY_PREFIX = "user-"


@dataclass(frozen=True)
class BookRow:
    id: uuid.UUID
    title: str
    revision_id: uuid.UUID
    version: int


@dataclass(frozen=True)
class EditableDocument:
    """`revision_id` is None when the document is not a live book with a published revision."""

    workspace_id: uuid.UUID
    revision_id: uuid.UUID | None


@dataclass(frozen=True)
class ChapterRef:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_id: uuid.UUID | None  # None with the revision: a Workspace chapter
    document_revision_id: uuid.UUID | None
    parent_id: uuid.UUID | None
    section_key: str


_CHAPTER_COLUMNS = (
    chapters.c.id,
    chapters.c.parent_id,
    chapters.c.section_key,
    chapters.c.title,
    chapters.c.level,
    chapters.c.sort_order,
    chapters.c.page,
)


class ChapterEditRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    # --- reads ----------------------------------------------------------------------------------

    def books(self, workspace_id: uuid.UUID) -> list[BookRow]:
        """Live books with a published revision, oldest first (the document list's order)."""
        rows = self._session.execute(
            select(
                documents.c.id,
                documents.c.title,
                documents.c.active_revision_id,
                documents.c.chapter_tree_version,
            )
            .where(
                documents.c.workspace_id == workspace_id,
                documents.c.deleted_at.is_(None),
                documents.c.document_type == BOOK,
                documents.c.active_revision_id.is_not(None),
            )
            .order_by(documents.c.created_at, documents.c.id)
        )
        return [BookRow(r.id, r.title, r.active_revision_id, r.chapter_tree_version) for r in rows]

    def book_title(self, document_id: uuid.UUID) -> str:
        return str(
            self._session.execute(
                select(
                    func.coalesce(func.nullif(documents.c.title, ""), documents.c.filename)
                ).where(documents.c.id == document_id)
            ).scalar_one()
        )

    def version(self, document_id: uuid.UUID) -> int:
        return int(
            self._session.execute(
                select(documents.c.chapter_tree_version).where(documents.c.id == document_id)
            ).scalar_one()
        )

    def editable_document(self, document_id: uuid.UUID) -> EditableDocument | None:
        row = self._session.execute(
            select(
                documents.c.workspace_id,
                documents.c.document_type,
                documents.c.active_revision_id,
                documents.c.deleted_at,
            ).where(documents.c.id == document_id)
        ).one_or_none()
        if row is None:
            return None
        editable = row.document_type == BOOK and row.deleted_at is None
        return EditableDocument(row.workspace_id, row.active_revision_id if editable else None)

    def chapter(self, chapter_id: uuid.UUID) -> ChapterRef | None:
        row = self._session.execute(
            select(
                chapters.c.id,
                chapters.c.workspace_id,
                chapters.c.document_id,
                chapters.c.document_revision_id,
                chapters.c.parent_id,
                chapters.c.section_key,
            ).where(chapters.c.id == chapter_id)
        ).one_or_none()
        if row is None:
            return None
        return ChapterRef(
            row.id,
            row.workspace_id,
            row.document_id,
            row.document_revision_id,
            row.parent_id,
            row.section_key,
        )

    def tree(self, revision_id: uuid.UUID) -> list[RowMapping]:
        return list(
            self._session.execute(
                select(*_CHAPTER_COLUMNS)
                .where(chapters.c.document_revision_id == revision_id)
                .order_by(chapters.c.sort_order, chapters.c.id)
            ).mappings()
        )

    def workspace_tree(self, workspace_id: uuid.UUID) -> list[RowMapping]:
        """The Workspace chapters (UX12-CHAPTERADD) in outline order."""
        return list(
            self._session.execute(
                select(*_CHAPTER_COLUMNS)
                .where(
                    chapters.c.workspace_id == workspace_id,
                    chapters.c.document_revision_id.is_(None),
                )
                .order_by(chapters.c.sort_order, chapters.c.id)
            ).mappings()
        )

    def workspace_version(self, workspace_id: uuid.UUID) -> int:
        found = self._session.execute(
            select(workspace_chapter_trees.c.version).where(
                workspace_chapter_trees.c.workspace_id == workspace_id
            )
        ).scalar_one_or_none()
        return int(found) if found is not None else 0

    def question_counts(self, workspace_id: uuid.UUID) -> dict[uuid.UUID, int]:
        """Live CONFIRMED questions per chapter (what the Heatmap shows)."""
        rows = self._session.execute(
            select(questions.c.chapter_id, func.count())
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.deleted_at.is_(None),
                questions.c.publication_status == "CONFIRMED",
                questions.c.chapter_id.is_not(None),
            )
            .group_by(questions.c.chapter_id)
        )
        return {chapter_id: int(count) for chapter_id, count in rows}

    def attached_question_counts(self, workspace_id: uuid.UUID) -> dict[uuid.UUID, int]:
        """Every question per chapter, in any state: what a delete has to move (the foreign key
        has no action, see `questions_in_chapter`)."""
        rows = self._session.execute(
            select(questions.c.chapter_id, func.count())
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.chapter_id.is_not(None),
            )
            .group_by(questions.c.chapter_id)
        )
        return {chapter_id: int(count) for chapter_id, count in rows}

    def noted_sections(self, workspace_id: uuid.UUID) -> set[tuple[uuid.UUID, str]]:
        """(document, section_key) of every chapter with a current note."""
        rows = self._session.execute(
            select(chapter_notes.c.document_id, chapter_notes.c.section_key)
            .where(
                chapter_notes.c.workspace_id == workspace_id,
                chapter_notes.c.status == "succeeded",
                chapter_notes.c.superseded_at.is_(None),
            )
            .distinct()
        )
        return {(r.document_id, r.section_key) for r in rows}

    def questions_in_chapter(
        self, workspace_id: uuid.UUID, chapter_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """FOR UPDATE, in id order: every row pointing at the chapter, in any state (the foreign
        key has no action, so a draft, archived or deleted question would block the delete)."""
        return list(
            self._session.execute(
                select(questions.c.id)
                .where(
                    questions.c.workspace_id == workspace_id,
                    questions.c.chapter_id == chapter_id,
                )
                .order_by(questions.c.id)
                .with_for_update()
            ).scalars()
        )

    # --- writes ---------------------------------------------------------------------------------

    def create(
        self,
        workspace_id: uuid.UUID,
        document_id: uuid.UUID,
        chapter_id: uuid.UUID,
        parent_id: uuid.UUID | None,
        title: str,
    ) -> None:
        self._session.execute(
            text("select public.chapter_edit_create(:w, :d, :c, :p, :t)"),
            {"w": workspace_id, "d": document_id, "c": chapter_id, "p": parent_id, "t": title},
        )

    def rename(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, chapter_id: uuid.UUID, title: str
    ) -> None:
        self._session.execute(
            text("select public.chapter_edit_rename(:w, :d, :c, :t)"),
            {"w": workspace_id, "d": document_id, "c": chapter_id, "t": title},
        )

    def delete(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, chapter_id: uuid.UUID
    ) -> None:
        self._session.execute(
            text("select public.chapter_edit_delete(:w, :d, :c)"),
            {"w": workspace_id, "d": document_id, "c": chapter_id},
        )

    def write_tree(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, nodes: Sequence[PlacedNode]
    ) -> None:
        payload = [
            {
                "id": str(n.id),
                "parent_id": str(n.parent_id) if n.parent_id else None,
                "level": n.level,
                "sort_order": n.sort_order,
            }
            for n in nodes
        ]
        self._session.execute(
            text("select public.chapter_edit_tree(:w, :d, cast(:n as jsonb))"),
            {"w": workspace_id, "d": document_id, "n": json.dumps(payload)},
        )

    def sync_draft(
        self,
        workspace_id: uuid.UUID,
        document_id: uuid.UUID,
        draft_id: uuid.UUID,
        renamed_key: str | None = None,
    ) -> None:
        self._session.execute(
            text("select public.chapter_edit_sync_draft(:w, :d, :r, :k)"),
            {"w": workspace_id, "d": document_id, "r": draft_id, "k": renamed_key},
        )

    def finish(self, workspace_id: uuid.UUID, document_id: uuid.UUID, content_hash: str) -> int:
        return int(
            self._session.execute(
                text("select public.chapter_edit_finish(:w, :d, :h)"),
                {"w": workspace_id, "d": document_id, "h": content_hash},
            ).scalar_one()
        )

    # Workspace chapters are no revision content: plain writes under the tree row's lock.

    def lock_workspace_tree(self, workspace_id: uuid.UUID) -> None:
        """FOR UPDATE on the tree row, made on first use. Before any document or question."""
        self._session.execute(
            pg_insert(workspace_chapter_trees)
            .values(workspace_id=workspace_id)
            .on_conflict_do_nothing(index_elements=["workspace_id"])
        )
        self._session.execute(
            select(workspace_chapter_trees.c.workspace_id)
            .where(workspace_chapter_trees.c.workspace_id == workspace_id)
            .with_for_update()
        ).one()

    def create_workspace_chapter(
        self,
        workspace_id: uuid.UUID,
        chapter_id: uuid.UUID,
        parent_id: uuid.UUID | None,
        title: str,
    ) -> None:
        # level and sort_order are placeholders until `write_workspace_tree`.
        self._session.execute(
            insert(chapters).values(
                id=chapter_id,
                workspace_id=workspace_id,
                workspace_level_of=workspace_id,
                parent_id=parent_id,
                section_key=f"{USER_KEY_PREFIX}{chapter_id}",
                level=1,
                sort_order=0,
                title=title,
            )
        )

    def rename_workspace_chapter(self, chapter_id: uuid.UUID, title: str) -> None:
        self._session.execute(
            update(chapters)
            .where(chapters.c.id == chapter_id, chapters.c.document_revision_id.is_(None))
            .values(title=title)
        )

    def delete_workspace_chapter(self, chapter_id: uuid.UUID, heir: uuid.UUID | None) -> None:
        """Its children go to its parent, as in `chapter_edit_delete`."""
        self._session.execute(
            update(chapters).where(chapters.c.parent_id == chapter_id).values(parent_id=heir)
        )
        self._session.execute(delete(chapters).where(chapters.c.id == chapter_id))

    def write_workspace_tree(self, workspace_id: uuid.UUID, nodes: Sequence[PlacedNode]) -> None:
        if not nodes:
            return
        self._session.execute(
            update(chapters)
            .where(
                chapters.c.id == bindparam("node_id"),
                chapters.c.workspace_id == workspace_id,
                chapters.c.document_revision_id.is_(None),
            )
            .values(
                parent_id=bindparam("node_parent"),
                level=bindparam("node_level"),
                sort_order=bindparam("node_order"),
            ),
            [
                {
                    "node_id": n.id,
                    "node_parent": n.parent_id,
                    "node_level": n.level,
                    "node_order": n.sort_order,
                }
                for n in nodes
            ],
        )

    def finish_workspace(self, workspace_id: uuid.UUID) -> int:
        return int(
            self._session.execute(
                update(workspace_chapter_trees)
                .where(workspace_chapter_trees.c.workspace_id == workspace_id)
                .values(version=workspace_chapter_trees.c.version + 1)
                .returning(workspace_chapter_trees.c.version)
            ).scalar_one()
        )

    def record_workspace_activity(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        event_type: str,
        metadata: dict[str, Any],
    ) -> None:
        """Ids and counts only (C05)."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=event_type,
                target_type="workspace",
                target_id=workspace_id,
                metadata=metadata,
            )
        )

    def move_drafts(
        self, workspace_id: uuid.UUID, chapter_id: uuid.UUID, target_id: uuid.UUID | None
    ) -> None:
        """Import drafts and runs that chose this chapter follow the deleted chapter's questions.
        `chapter_manual` stays: a person chose a chapter, and the target is the person's choice."""
        self._session.execute(
            update(question_drafts)
            .where(
                question_drafts.c.workspace_id == workspace_id,
                question_drafts.c.chapter_id == chapter_id,
            )
            .values(chapter_id=target_id)
        )
        self._session.execute(
            update(question_import_runs)
            .where(
                and_(
                    question_import_runs.c.workspace_id == workspace_id,
                    question_import_runs.c.target_chapter_id == chapter_id,
                )
            )
            .values(target_chapter_id=target_id)
        )
