"""Re-match the chapters the matcher left empty once a book becomes ready (CHAP-MATCH,
docs/questions.md §14.4).

Runs after a book's revision became active (`document.parse`). Registered questions of the same
workspace whose chapter was decided by the matcher (`chapter_source = auto`) and is empty or only a
question-paper fallback are matched again with the shared matcher (`book_core.chapter_matching`:
book chapters first, then the paper's top-level chapter). The only write is the SECURITY DEFINER
`public.worker_rematch_chapters`, which rechecks everything under lock, so a chapter a person set
(`manual`) is never touched and a redelivery moves nothing twice.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from book_core.chapter_matching import BookChapter, ChapterMatcher, StartBlock, recommend
from sqlalchemy import Engine, text

logger = logging.getLogger(__name__)

BOOK = "book"
Move = tuple[uuid.UUID, uuid.UUID | None, uuid.UUID]


class RematchStore(Protocol):
    def candidates(self, workspace_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None]]: ...

    def start_blocks(
        self, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, StartBlock]: ...

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]: ...

    def apply(self, workspace_id: uuid.UUID, moves: Sequence[Move]) -> int: ...


def rematch_workspace(store: RematchStore, workspace_id: uuid.UUID) -> int:
    """Move the eligible questions of this workspace; returns how many the database moved."""
    candidates = store.candidates(workspace_id)
    if not candidates:
        return 0
    starts = store.start_blocks(workspace_id, [q for q, _ in candidates])
    matcher = ChapterMatcher(store.book_chapters(workspace_id))
    moves: list[Move] = []
    for question_id, current in candidates:
        found = recommend(starts.get(question_id), matcher)
        if found.chapter is None or found.chapter.id == current:
            continue
        if current is not None and found.reason == "paper_chapter":
            continue  # already under a paper chapter: a fallback never replaces it
        moves.append((question_id, current, found.chapter.id))
    return store.apply(workspace_id, moves) if moves else 0


def rematch_quietly(store: RematchStore, workspace_id: uuid.UUID) -> int:
    """`rematch_workspace` for the document job: the book is already published, so a failure here
    must never fail the job (the next book or document re-runs it)."""
    try:
        return rematch_workspace(store, workspace_id)
    except Exception:
        logger.warning("chapter re-match failed", exc_info=True)
        return 0


_DOC_TITLE = "coalesce(nullif(d.title, ''), d.filename)"


class SqlRematchStore:
    """`quiz_worker` reads (questions, question_sources, documents, chapters, content_blocks) and
    the one SECURITY DEFINER write."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def candidates(self, workspace_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
        with self._engine.connect() as conn:
            rows = conn.execute(
                text(
                    "select q.id, q.chapter_id from public.questions q "
                    "left join public.chapters c on c.id = q.chapter_id "
                    "  and c.workspace_id = q.workspace_id "
                    "left join public.documents d on d.id = c.document_id "
                    "  and d.workspace_id = c.workspace_id "
                    "where q.workspace_id = :w and q.deleted_at is null "
                    "  and q.publication_status = 'CONFIRMED' and q.chapter_source = 'auto' "
                    "  and (q.chapter_id is null or d.document_type <> 'book') "
                    "order by q.id"
                ),
                {"w": workspace_id},
            ).all()
        return [(r.id, r.chapter_id) for r in rows]

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        with self._engine.connect() as conn:
            return self._outline(conn, workspace_id, "d.document_type = 'book'")

    @staticmethod
    def _outline(conn: Any, workspace_id: uuid.UUID, where: str) -> list[BookChapter]:
        rows = conn.execute(
            text(
                f"select c.id, c.title, c.level, c.document_id, {_DOC_TITLE} as document_title "  # noqa: S608
                "from public.chapters c join public.documents d "
                "  on d.workspace_id = c.workspace_id and d.id = c.document_id "
                "  and d.active_revision_id = c.document_revision_id "
                f"where c.workspace_id = :w and d.deleted_at is null and {where} "
                "order by d.created_at, d.id, c.sort_order, c.id"
            ),
            {"w": workspace_id},
        ).all()
        return [
            BookChapter(r.id, r.title, r.document_id, r.document_title, int(r.level)) for r in rows
        ]

    def start_blocks(
        self, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, StartBlock]:
        """Per question that has a source: where it starts (docs/questions.md §14.2), as the
        API's redistribution preview reads it."""
        out: dict[uuid.UUID, StartBlock] = {}
        with self._engine.connect() as conn:
            firsts = conn.execute(
                text(
                    "select distinct on (s.question_id) s.question_id, s.document_id, "
                    "  s.document_revision_id, s.block_ids, s.page_start "
                    "from public.question_sources s "
                    "where s.workspace_id = :w and s.question_id = any(:ids) "
                    "order by s.question_id, s.import_run_id is null, s.created_at, s.id"
                ),
                {"w": workspace_id, "ids": list(question_ids)},
            ).all()
            doc_ids = sorted({r.document_id for r in firsts if r.document_id is not None})
            in_book: dict[uuid.UUID, bool] = {}
            if doc_ids:
                in_book = {
                    r.id: r.document_type == BOOK and r.content_kind != "mixed"
                    for r in conn.execute(
                        text(
                            "select id, document_type, content_kind from public.documents "
                            "where workspace_id = :w and id = any(:ids)"
                        ),
                        {"w": workspace_id, "ids": doc_ids},
                    )
                }
            groups: dict[
                tuple[uuid.UUID, bool], dict[uuid.UUID, tuple[str | None, int | None]]
            ] = {}
            for r in firsts:
                book = r.document_id is not None and in_book.get(r.document_id, False)
                if r.document_revision_id is None:
                    out[r.question_id] = StartBlock(in_book=book)
                    continue
                blocks = list(r.block_ids or ())
                ref = (blocks[0] if blocks else None, r.page_start)
                groups.setdefault((r.document_revision_id, book), {})[r.question_id] = ref
            book_nodes: dict[uuid.UUID, uuid.UUID | None] = {}
            for (revision_id, book), refs in groups.items():
                nodes = self._source_nodes(conn, workspace_id, revision_id, refs)
                if book:
                    book_nodes.update(nodes)
                else:
                    self._paper_blocks(conn, workspace_id, revision_id, nodes, out)
            current = self._current(
                conn,
                workspace_id,
                {n for n in book_nodes.values() if n is not None},
                book_only=True,
            )
            for qid, node in book_nodes.items():
                out[qid] = StartBlock(
                    in_book=True, book_chapter=current.get(node) if node is not None else None
                )
        return out

    @staticmethod
    def _source_nodes(
        conn: Any,
        workspace_id: uuid.UUID,
        revision_id: uuid.UUID,
        refs: Mapping[uuid.UUID, tuple[str | None, int | None]],
    ) -> dict[uuid.UUID, uuid.UUID | None]:
        """Per key: the outline node of its first source block, else of its page's first block."""
        block_ids = sorted({b for b, _ in refs.values() if b})
        by_block: dict[str, uuid.UUID | None] = {}
        if block_ids:
            by_block = {
                r.block_id: r.chapter_id
                for r in conn.execute(
                    text(
                        "select block_id, chapter_id from public.content_blocks "
                        "where workspace_id = :w and document_revision_id = :r "
                        "and block_id = any(:b)"
                    ),
                    {"w": workspace_id, "r": revision_id, "b": block_ids},
                )
            }
        pages = sorted({p for b, p in refs.values() if p is not None and b not in by_block})
        by_page: dict[int, uuid.UUID | None] = {}
        if pages:
            by_page = {
                r.page: r.chapter_id
                for r in conn.execute(
                    text(
                        "select distinct on (page) page, chapter_id from public.content_blocks "
                        "where workspace_id = :w and document_revision_id = :r "
                        "and page = any(:p) order by page, ordinal"
                    ),
                    {"w": workspace_id, "r": revision_id, "p": pages},
                )
            }
        out: dict[uuid.UUID, uuid.UUID | None] = {}
        for key, (block, page) in refs.items():
            if block is not None and block in by_block:
                out[key] = by_block[block]
            elif page is not None:
                out[key] = by_page.get(page)
            else:
                out[key] = None
        return out

    def _paper_blocks(
        self,
        conn: Any,
        workspace_id: uuid.UUID,
        revision_id: uuid.UUID,
        nodes: Mapping[uuid.UUID, uuid.UUID | None],
        out: dict[uuid.UUID, StartBlock],
    ) -> None:
        """Blocks of a question paper (or the question part of a `mixed` book): the outline
        titles of the block's chapter up to its top-level ancestor, and that ancestor in the
        document's current revision (level 1 only) as the fallback."""
        outline = {
            r.id: (r.parent_id, r.title)
            for r in conn.execute(
                text(
                    "select id, parent_id, title from public.chapters "
                    "where workspace_id = :w and document_revision_id = :r"
                ),
                {"w": workspace_id, "r": revision_id},
            )
        }
        chains: dict[uuid.UUID, list[str]] = {}
        tops: dict[uuid.UUID, uuid.UUID] = {}
        for key, node in nodes.items():
            titles: list[str] = []
            seen: set[uuid.UUID] = set()
            while node is not None and node in outline and node not in seen:
                seen.add(node)
                parent, title = outline[node]
                titles.append(title)
                if parent is None or parent not in outline:
                    tops[key] = node
                node = parent
            chains[key] = titles
        current = self._current(conn, workspace_id, set(tops.values()), book_only=False)
        for key, titles in chains.items():
            top = current.get(tops[key]) if key in tops else None
            out[key] = StartBlock(
                in_book=False,
                chain=tuple(titles),
                paper_chapter=top if top is not None and top.level == 1 else None,
            )

    @staticmethod
    def _current(
        conn: Any, workspace_id: uuid.UUID, chapter_ids: set[uuid.UUID], *, book_only: bool
    ) -> dict[uuid.UUID, BookChapter]:
        """chosen chapter id -> the same section in its document's current revision."""
        if not chapter_ids:
            return {}
        rows = conn.execute(
            text(
                "select c.id as chosen_id, cur.id, cur.title, cur.level, cur.document_id, "
                "coalesce(nullif(d.title, ''), d.filename) as document_title "
                "from public.chapters c join public.documents d "
                "  on d.workspace_id = c.workspace_id and d.id = c.document_id "
                "join public.chapters cur on cur.document_revision_id = d.active_revision_id "
                "  and cur.section_key = c.section_key "
                "where c.workspace_id = :w and c.id = any(:ids) and d.deleted_at is null "
                "and (not :book_only or d.document_type = 'book')"
            ),
            {"w": workspace_id, "ids": sorted(chapter_ids), "book_only": book_only},
        ).all()
        return {
            r.chosen_id: BookChapter(r.id, r.title, r.document_id, r.document_title, int(r.level))
            for r in rows
        }

    def apply(self, workspace_id: uuid.UUID, moves: Sequence[Move]) -> int:
        payload = [
            {
                "question_id": str(q),
                "expected_chapter_id": str(old) if old is not None else None,
                "chapter_id": str(new),
            }
            for q, old, new in moves
        ]
        with self._engine.begin() as conn:
            moved = conn.execute(
                text("select public.worker_rematch_chapters(:w, cast(:m as jsonb))"),
                {"w": workspace_id, "m": json.dumps(payload)},
            ).scalar_one()
        return int(moved)
