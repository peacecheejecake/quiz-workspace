"""Chapter redistribution reads and writes (UX9-REDIST-B, CHREDIST-01; docs/questions.md §14).

Reads: the workspace's CONFIRMED live questions in Heatmap order (the overview's FROM, conditions
and order, so the list is the Heatmap's set) and each question's first source block resolved for
the CHAPTER-MAP recommendation (`start_blocks`). Writes go through
`QuestionRepository.set_chapter` after `lock_questions`; the caller holds the documents first
(`QuestionRepository.lock_documents`) and commits.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import and_, func, insert, select
from sqlalchemy.orm import Session

from quiz_api.chapter_matching import BookChapter, StartBlock
from quiz_api.question_rules import PublicationStatus, QuestionType
from quiz_api.repositories.draft_chapters import BOOK, DraftChapterRepository, SourceRef
from quiz_api.repositories.question_overview import (
    heatmap_conditions,
    heatmap_order,
    heatmap_source,
)
from quiz_api.repositories.questions import ChapterSource
from quiz_api.repositories.tables import (
    activity_events,
    chapters,
    documents,
    question_revisions,
    question_sources,
    questions,
)

# Characters of the stem fetched for the 40-character preview.
STEM_HEAD = 400
REASSIGNED = "questions.chapters_reassigned"


@dataclass(frozen=True)
class ListedQuestion:
    question_id: uuid.UUID
    question_type: QuestionType
    question_number: int | None
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    chapter_document_id: uuid.UUID | None
    chapter_source: ChapterSource
    stem_head: str


@dataclass(frozen=True)
class LockedQuestion:
    id: uuid.UUID
    chapter_id: uuid.UUID | None
    publication_status: PublicationStatus


@dataclass(frozen=True)
class TargetChapter:
    """A chapter of this workspace named as a move target, and whether it may be one: an outline
    node of the active revision of a live book (`document_type = book`)."""

    id: uuid.UUID
    valid: bool


class ChapterRedistributionRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def listed(
        self, workspace_id: uuid.UUID, question_ids: Iterable[uuid.UUID] | None = None
    ) -> list[ListedQuestion]:
        """The Heatmap's questions (CONFIRMED, live) in Heatmap order; `question_ids` narrows
        them (ids that are not such questions here are left out)."""
        conditions = heatmap_conditions(workspace_id)
        if question_ids is not None:
            conditions.append(questions.c.id.in_(sorted(set(question_ids))))
        rows = self._session.execute(
            select(
                questions.c.id,
                questions.c.question_type,
                questions.c.question_number,
                questions.c.chapter_id,
                questions.c.chapter_source,
                chapters.c.title.label("chapter_title"),
                chapters.c.document_id.label("chapter_document_id"),
                func.substr(question_revisions.c.stem, 1, STEM_HEAD).label("stem_head"),
            )
            .select_from(heatmap_source())
            .where(*conditions)
            .order_by(*heatmap_order())
        )
        return [
            ListedQuestion(
                question_id=r.id,
                question_type=cast(QuestionType, r.question_type),
                question_number=r.question_number,
                chapter_id=r.chapter_id,
                chapter_title=r.chapter_title,
                chapter_document_id=r.chapter_document_id,
                chapter_source=cast(ChapterSource, r.chapter_source),
                stem_head=r.stem_head,
            )
            for r in rows
        ]

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        """Move targets: the current revision's outline of every live book, in outline order."""
        return DraftChapterRepository(self._session).book_chapters(workspace_id)

    def start_blocks(
        self, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, StartBlock]:
        """Per question that has a source: its start block (docs/questions.md §14.2). The source
        is the question's import provenance if it has one, else its oldest source row; the block
        is that row's first block id, else the first block of its first page, in the document
        revision the row cites. Questions without a source are left out (`no_source`)."""
        if not question_ids:
            return {}
        first = self._session.execute(
            select(
                question_sources.c.question_id,
                question_sources.c.document_id,
                question_sources.c.document_revision_id,
                question_sources.c.block_ids,
                question_sources.c.page_start,
            )
            .where(
                question_sources.c.workspace_id == workspace_id,
                question_sources.c.question_id.in_(sorted(set(question_ids))),
            )
            .order_by(
                question_sources.c.question_id,
                question_sources.c.import_run_id.is_(None),
                question_sources.c.created_at,
                question_sources.c.id,
            )
            .distinct(question_sources.c.question_id)
        ).all()
        doc_ids = sorted({r.document_id for r in first if r.document_id is not None})
        kinds: dict[uuid.UUID, bool] = {}
        if doc_ids:
            kinds = {
                d.id: d.document_type == BOOK and d.content_kind != "mixed"
                for d in self._session.execute(
                    select(
                        documents.c.id, documents.c.document_type, documents.c.content_kind
                    ).where(documents.c.workspace_id == workspace_id, documents.c.id.in_(doc_ids))
                )
            }

        draft_repo = DraftChapterRepository(self._session)
        by_revision: dict[tuple[uuid.UUID, bool], dict[uuid.UUID, SourceRef]] = {}
        out: dict[uuid.UUID, StartBlock] = {}
        for r in first:
            in_book = r.document_id is not None and kinds.get(r.document_id, False)
            if r.document_revision_id is None:
                out[r.question_id] = StartBlock(in_book=in_book)
                continue
            blocks = list(r.block_ids or ())
            ref = SourceRef(blocks[0] if blocks else None, r.page_start)
            by_revision.setdefault((r.document_revision_id, in_book), {})[r.question_id] = ref

        book_nodes: dict[uuid.UUID, uuid.UUID | None] = {}
        for (revision_id, in_book), refs in by_revision.items():
            if in_book:
                book_nodes.update(draft_repo.source_chapters(workspace_id, revision_id, refs))
            else:
                for qid, chain in draft_repo.source_chains(workspace_id, revision_id, refs).items():
                    out[qid] = StartBlock(in_book=False, chain=tuple(chain))
        current = draft_repo.current_book_chapters(
            workspace_id, [n for n in book_nodes.values() if n is not None]
        )
        for qid, node in book_nodes.items():
            out[qid] = StartBlock(
                in_book=True, book_chapter=current.get(node) if node is not None else None
            )
        return out

    def lock_questions(
        self, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, LockedQuestion]:
        """FOR UPDATE on the live questions of this workspace among `question_ids`, in id order;
        their chapter is read under the lock."""
        rows = self._session.execute(
            select(questions.c.id, questions.c.chapter_id, questions.c.publication_status)
            .where(
                questions.c.workspace_id == workspace_id,
                questions.c.id.in_(sorted(set(question_ids))),
                questions.c.deleted_at.is_(None),
            )
            .order_by(questions.c.id)
            .with_for_update()
        )
        return {
            r.id: LockedQuestion(r.id, r.chapter_id, cast(PublicationStatus, r.publication_status))
            for r in rows
        }

    def target_chapters(
        self, workspace_id: uuid.UUID, chapter_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, TargetChapter]:
        """The chapters of this workspace among `chapter_ids` (others are left out: a foreign or
        unknown chapter is 404) with their validity as a target. Read under the documents' lock."""
        ids = sorted(set(chapter_ids))
        if not ids:
            return {}
        rows = self._session.execute(
            select(
                chapters.c.id,
                and_(
                    documents.c.deleted_at.is_(None),
                    documents.c.document_type == BOOK,
                    documents.c.active_revision_id == chapters.c.document_revision_id,
                ).label("valid"),
            )
            .select_from(
                chapters.join(
                    documents,
                    and_(
                        documents.c.workspace_id == chapters.c.workspace_id,
                        documents.c.id == chapters.c.document_id,
                    ),
                )
            )
            .where(chapters.c.workspace_id == workspace_id, chapters.c.id.in_(ids))
        )
        return {r.id: TargetChapter(r.id, bool(r.valid)) for r in rows}

    def record_reassigned(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID, metadata: dict[str, Any]
    ) -> None:
        """One activity per request: counts, the source and ids only (never titles or stems)."""
        self._session.execute(
            insert(activity_events).values(
                workspace_id=workspace_id,
                actor_id=actor_id,
                event_type=REASSIGNED,
                target_type="workspace",
                target_id=workspace_id,
                metadata=metadata,
            )
        )
