"""CHAP-MATCH worker side: who is re-matched and what is sent to the database. The SQL function's
own rules (manual untouched, rechecks under lock, workspace) are pgTAP 27_chapter_rematch."""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from book_core.chapter_matching import BookChapter, StartBlock
from quiz_worker.chapter_rematch import Move, rematch_quietly, rematch_workspace

WS, OTHER_WS = uuid.uuid4(), uuid.uuid4()
BOOK_DOC, PAPER_DOC = uuid.uuid4(), uuid.uuid4()


def chap(title: str, doc: uuid.UUID, level: int = 1) -> BookChapter:
    return BookChapter(uuid.uuid4(), title, doc, "doc", level)


@dataclass
class Store:
    cands: dict[uuid.UUID, list[tuple[uuid.UUID, uuid.UUID | None]]] = field(default_factory=dict)
    starts: dict[uuid.UUID, StartBlock] = field(default_factory=dict)
    books: dict[uuid.UUID, list[BookChapter]] = field(default_factory=dict)
    applied: list[tuple[uuid.UUID, list[Move]]] = field(default_factory=list)
    seen: set[uuid.UUID] = field(default_factory=set)
    fail: bool = False

    def candidates(self, workspace_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
        self.seen.add(workspace_id)
        if self.fail:
            raise RuntimeError("db down")
        return self.cands.get(workspace_id, [])

    def start_blocks(
        self, workspace_id: uuid.UUID, question_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, StartBlock]:
        self.seen.add(workspace_id)
        return {q: self.starts[q] for q in question_ids if q in self.starts}

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        self.seen.add(workspace_id)
        return self.books.get(workspace_id, [])

    def apply(self, workspace_id: uuid.UUID, moves: Sequence[Move]) -> int:
        self.applied.append((workspace_id, list(moves)))
        return len(moves)


def test_a_book_match_is_sent_with_the_expected_old_chapter() -> None:
    book, paper = chap("2장 정수 처리", BOOK_DOC), chap("제1회", PAPER_DOC)
    q1, q2 = uuid.uuid4(), uuid.uuid4()
    s = Store(cands={WS: [(q1, None), (q2, paper.id)]}, books={WS: [book]})
    block = StartBlock(False, chain=("정수 처리",), paper_chapter=paper)
    s.starts = {q1: block, q2: block}
    assert rematch_workspace(s, WS) == 2
    assert s.applied == [(WS, [(q1, None, book.id), (q2, paper.id, book.id)])]


def test_the_paper_fallback_applies_only_to_a_question_without_a_chapter() -> None:
    paper, other = chap("제1회", PAPER_DOC), chap("제2회", PAPER_DOC)
    empty, under_paper = uuid.uuid4(), uuid.uuid4()
    s = Store(cands={WS: [(empty, None), (under_paper, other.id)]})
    block = StartBlock(False, chain=("01 ?",), paper_chapter=paper)
    s.starts = {empty: block, under_paper: block}
    assert rematch_workspace(s, WS) == 1
    assert s.applied == [(WS, [(empty, None, paper.id)])]


def test_no_source_no_match_and_unchanged_send_nothing() -> None:
    paper = chap("제1회", PAPER_DOC)
    nosrc, same = uuid.uuid4(), uuid.uuid4()
    s = Store(cands={WS: [(nosrc, None), (same, paper.id)]})
    s.starts = {same: StartBlock(False, chain=("x",), paper_chapter=paper)}
    assert rematch_workspace(s, WS) == 0
    assert s.applied == []


def test_only_the_given_workspace_is_read_or_written() -> None:
    paper = chap("제1회", PAPER_DOC)
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    block = StartBlock(False, chain=("x",), paper_chapter=paper)
    s = Store(
        cands={WS: [(mine, None)], OTHER_WS: [(theirs, None)]},
        starts={mine: block, theirs: block},
    )
    rematch_workspace(s, WS)
    assert s.seen == {WS}
    assert [w for w, _ in s.applied] == [WS]


def test_a_failure_never_escapes_the_document_job() -> None:
    assert rematch_quietly(Store(fail=True), WS) == 0
