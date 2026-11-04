"""CHAP-MATCH: re-matching the chapters the matcher left empty (docs/questions.md §14.4): who is
eligible, that a person's chapter is never touched, idempotency and workspace isolation. The
SQL side (candidates, locks) runs against a real database in tests/integration."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from quiz_api.chapter_matching import BookChapter, StartBlock
from quiz_api.chapter_rematch import rematch_empty_chapters
from quiz_api.repositories.chapter_redistribution import LockedQuestion, TargetChapter

WS_A, WS_B, USER = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
BOOK_DOC, PAPER_DOC = uuid.uuid4(), uuid.uuid4()


def chap(title: str, doc: uuid.UUID, level: int = 1) -> BookChapter:
    return BookChapter(uuid.uuid4(), title, doc, "doc", level)


@dataclass
class Q:
    chapter: uuid.UUID | None
    source: str = "auto"
    status: str = "CONFIRMED"
    start: StartBlock | None = None


@dataclass
class Db:
    """Per workspace: questions and chapters; one fake serves both repositories."""

    questions: dict[uuid.UUID, dict[uuid.UUID, Q]] = field(default_factory=dict)
    chapters: dict[uuid.UUID, list[BookChapter]] = field(default_factory=dict)
    valid: set[uuid.UUID] = field(default_factory=set)
    calls: list[str] = field(default_factory=list)
    seen_workspaces: set[uuid.UUID] = field(default_factory=set)

    def _paper_ids(self) -> set[uuid.UUID]:
        return {c.id for cs in self.chapters.values() for c in cs if c.document_id == PAPER_DOC}

    def rematch_candidates(self, ws: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
        self.seen_workspaces.add(ws)
        papers = self._paper_ids()
        return [
            (qid, q.chapter)
            for qid, q in self.questions.get(ws, {}).items()
            if q.source == "auto"
            and q.status == "CONFIRMED"
            and (q.chapter is None or q.chapter in papers)
        ]

    def start_blocks(self, ws: uuid.UUID, ids: Any) -> dict[uuid.UUID, StartBlock]:
        self.seen_workspaces.add(ws)
        found = {i: self.questions[ws][i].start for i in ids}
        return {i: s for i, s in found.items() if s is not None}

    def book_chapters(self, ws: uuid.UUID) -> list[BookChapter]:
        self.seen_workspaces.add(ws)
        return [c for c in self.chapters.get(ws, []) if c.document_id == BOOK_DOC]

    def lock_documents(self, ws: uuid.UUID, *, chapter_ids: Any = ()) -> None:
        self.calls.append("lock_documents")

    def lock_questions(self, ws: uuid.UUID, ids: Any) -> dict[uuid.UUID, LockedQuestion]:
        self.calls.append("lock_questions")
        return {
            i: LockedQuestion(i, q.chapter, q.status, q.source)  # type: ignore[arg-type]
            for i in ids
            if (q := self.questions.get(ws, {}).get(i)) is not None
        }

    def target_chapters(self, ws: uuid.UUID, ids: Any) -> dict[uuid.UUID, TargetChapter]:
        return {i: TargetChapter(i, i in self.valid) for i in ids}

    def set_chapter(self, ws: uuid.UUID, moves: Any, **kw: Any) -> None:
        self.calls.append("set_chapter")
        assert (kw["chapter_source"], kw["change_source"]) == ("auto", "recommendation")
        for qid, _, to in moves:
            self.questions[ws][qid].chapter = to


def world() -> tuple[Db, BookChapter, BookChapter]:
    db = Db()
    book = chap("2장 정수 처리", BOOK_DOC)
    paper = chap("제1회 모의평가", PAPER_DOC)
    db.chapters[WS_A] = [book, paper]
    db.valid = {book.id, paper.id}
    return db, book, paper


def run(db: Db, ws: uuid.UUID = WS_A) -> int:
    return rematch_empty_chapters(db, db, ws, USER)  # type: ignore[arg-type]


def test_empty_chapter_gets_the_book_chapter_when_one_matches() -> None:
    db, book, paper = world()
    q = uuid.uuid4()
    start = StartBlock(False, chain=("정수 처리",), paper_chapter=paper)
    db.questions[WS_A] = {q: Q(None, start=start)}
    assert run(db) == 1
    assert db.questions[WS_A][q].chapter == book.id
    assert db.calls.index("lock_documents") < db.calls.index("lock_questions")
    assert db.calls.index("lock_questions") < db.calls.index("set_chapter")


def test_empty_chapter_falls_back_to_the_paper_chapter() -> None:
    db, _, paper = world()
    q = uuid.uuid4()
    db.questions[WS_A] = {q: Q(None, start=StartBlock(False, chain=("01 ?",), paper_chapter=paper))}
    assert run(db) == 1
    assert db.questions[WS_A][q].chapter == paper.id


def test_a_paper_fallback_is_upgraded_when_a_book_matches_later() -> None:
    db, book, paper = world()
    q = uuid.uuid4()
    start = StartBlock(False, chain=("정수 처리",), paper_chapter=paper)
    db.questions[WS_A] = {q: Q(paper.id, start=start)}
    assert run(db) == 1
    assert db.questions[WS_A][q].chapter == book.id


def test_a_persons_chapter_is_never_touched() -> None:
    db, book, paper = world()
    manual_none, manual_paper, in_book = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    start = StartBlock(False, chain=("정수 처리",), paper_chapter=paper)
    db.questions[WS_A] = {
        manual_none: Q(None, source="manual", start=start),
        manual_paper: Q(paper.id, source="manual", start=start),
        in_book: Q(book.id, start=start),
    }
    assert run(db) == 0
    assert [q.chapter for q in db.questions[WS_A].values()] == [None, paper.id, book.id]
    assert "set_chapter" not in db.calls


def test_a_question_a_person_took_over_under_the_lock_is_skipped() -> None:
    db, _, paper = world()
    q = uuid.uuid4()
    db.questions[WS_A] = {q: Q(None, start=StartBlock(False, chain=("x",), paper_chapter=paper))}
    original = db.lock_questions

    def raced(ws: uuid.UUID, ids: Any) -> dict[uuid.UUID, LockedQuestion]:
        db.questions[ws][q].source = "manual"
        return original(ws, ids)

    db.lock_questions = raced  # type: ignore[method-assign]
    assert run(db) == 0
    assert db.questions[WS_A][q].chapter is None


def test_rematching_twice_moves_nothing_the_second_time() -> None:
    db, _, paper = world()
    q = uuid.uuid4()
    db.questions[WS_A] = {q: Q(None, start=StartBlock(False, chain=("x",), paper_chapter=paper))}
    assert (run(db), run(db)) == (1, 0)


def test_no_source_stays_empty_and_an_invalid_target_is_skipped() -> None:
    db, _, paper = world()
    nosrc, stale = uuid.uuid4(), uuid.uuid4()
    db.questions[WS_A] = {
        nosrc: Q(None),
        stale: Q(None, start=StartBlock(False, chain=("x",), paper_chapter=paper)),
    }
    db.valid.discard(paper.id)
    assert run(db) == 0


def test_only_the_requested_workspace_is_read_and_changed() -> None:
    db, _, paper = world()
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    start = StartBlock(False, chain=("x",), paper_chapter=paper)
    db.questions[WS_A] = {mine: Q(None, start=start)}
    db.questions[WS_B] = {theirs: Q(None, start=start)}
    assert run(db, WS_A) == 1
    assert db.questions[WS_B][theirs].chapter is None
    assert db.seen_workspaces == {WS_A}
