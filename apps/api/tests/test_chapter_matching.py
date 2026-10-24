"""CHAPTER-MAP: suggesting a book chapter for an imported question (QIMPORT-01-AC08)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from quiz_api.chapter_matching import BookChapter, ChapterMatcher, title_key
from quiz_api.draft_chapters import DraftChapter, draft_chapters, source_ref
from quiz_api.repositories.draft_chapters import SourceRef
from quiz_api.repositories.question_imports import DraftRecord

BOOK = uuid.uuid4()
OTHER_BOOK = uuid.uuid4()


def chapter(title: str, document: uuid.UUID = BOOK, level: int = 1) -> BookChapter:
    return BookChapter(uuid.uuid4(), title, document, "교재", level)


@pytest.mark.parametrize(
    ("title", "number", "key"),
    [
        ("제1장 수신제도", "1", "수신제도"),
        ("1장 수신 제도", "1", "수신제도"),
        ("제 12 장  여신", "12", "여신"),
        ("1. 수신제도", "1", "수신제도"),
        ("10)  외환", "10", "외환"),
        ("1.2 강수와 유출", "1", "강수와유출"),
        ("Chapter 3: Deposits", "3", "deposits"),
        ("\uff30\uff21\uff32\uff34 \uff12 \u2013 Loans", "2", "loans"),  # full-width
        ("제1회 합성 확인 평가 — 물의 순환", None, "제1회합성확인평가물의순환"),
        ("2024년 기출", None, "2024년기출"),
        ("장점과 단점", None, "장점과단점"),
    ],
)
def test_title_keys_ignore_numbering_spacing_and_punctuation(
    title: str, number: str | None, key: str
) -> None:
    found = title_key(title)
    assert (found.number, found.key) == (number, key)


def test_qimport_01_ac08_exactly_one_matching_book_chapter_is_suggested() -> None:
    target = chapter("1장 수신 제도")
    matcher = ChapterMatcher([target, chapter("2장 여신제도"), chapter("1.1 예금의 종류", level=2)])

    found = matcher.suggest(["제1장 수신제도"])

    assert (found.chapter, found.match, found.source_title) == (target, "matched", "제1장 수신제도")


def test_the_deepest_matching_node_of_the_question_chain_decides() -> None:
    section = chapter("1.1 예금의 종류", level=2)
    matcher = ChapterMatcher([chapter("1장 수신제도"), section])

    assert matcher.suggest(["예금의 종류", "제1장 수신제도"]).chapter == section
    # A section the books do not have falls back to its chapter.
    found = matcher.suggest(["1-3 기출 문제", "제1장 수신제도"])
    assert (found.match, found.source_title) == ("matched", "제1장 수신제도")


def test_several_candidates_are_narrowed_by_number_or_left_ambiguous() -> None:
    first = chapter("1장 총론")
    matcher = ChapterMatcher([first, chapter("3장 총론", OTHER_BOOK)])
    assert matcher.suggest(["제1장 총론"]).chapter == first

    ambiguous = ChapterMatcher([chapter("1장 총론"), chapter("1장 총론", OTHER_BOOK)])
    found = ambiguous.suggest(["제1장 총론"])
    assert (found.chapter, found.match) == (None, "ambiguous")
    unnumbered = ambiguous.suggest(["총론"])
    assert (unnumbered.chapter, unnumbered.match) == (None, "ambiguous")


def test_no_match_and_no_source_chapter_suggest_nothing() -> None:
    matcher = ChapterMatcher([chapter("1장 물의 순환")])

    assert matcher.suggest(["제1회 합성 확인 평가 — 물의 순환과 정수 처리"]).match == "no_match"
    assert matcher.suggest([]).match == "no_source_chapter"
    # A number alone is no title: never matched by number only.
    assert matcher.suggest(["제1장"]).match == "no_match"
    assert ChapterMatcher([]).suggest(["제1장 수신제도"]).match == "no_match"


# --- draft_chapters: suggestion vs. the reviewer's choice -------------------------------------


class FakeChapterRepo:
    def __init__(self, books: list[BookChapter], chains: dict[str, list[str]]) -> None:
        self.books = books
        self.chains = chains
        self.refs: dict[uuid.UUID, SourceRef] = {}

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        return self.books

    def source_chains(
        self, workspace_id: uuid.UUID, revision_id: uuid.UUID, refs: dict[uuid.UUID, SourceRef]
    ) -> dict[uuid.UUID, list[str]]:
        self.refs = refs
        return {d: self.chains.get(r.block_id or f"page-{r.page}", []) for d, r in refs.items()}

    def current_book_chapters(
        self, workspace_id: uuid.UUID, ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, BookChapter]:
        return {c.id: c for c in self.books if c.id in ids}


def draft_record(
    block: str | None, *, manual: bool = False, chapter_id: uuid.UUID | None = None
) -> DraftRecord:
    location: dict[str, object] = {"page": 3}
    evidence = [
        {"document_id": "d", "block_ids": [block] if block else [], "locations": [location]}
    ]
    now = datetime(2026, 10, 23, tzinfo=UTC)
    return DraftRecord(
        id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        import_run_id=uuid.uuid4(),
        generation_run_id=None,
        source_type="import",
        position=0,
        question_type="ESSAY",
        question_number=1,
        is_multi_answer=False,
        rubric=None,
        payload={"evidence": evidence},
        validations=[],
        review_status="pending",
        reviewed_at=None,
        published_question_id=None,
        created_at=now,
        updated_at=now,
        chapter_id=chapter_id,
        chapter_manual=manual,
    )


def test_source_ref_is_the_first_block_else_the_first_page() -> None:
    assert source_ref({"evidence": [{"block_ids": ["b1", "b2"], "locations": [{"page": 2}]}]}) == (
        SourceRef("b1", 2)
    )
    assert source_ref({"evidence": [{"locations": [{"page": 4, "block_id": "b9"}]}]}) == (
        SourceRef("b9", 4)
    )
    assert source_ref({"evidence": []}) == SourceRef(None, None)


def test_qimport_01_ac08_the_reviewer_choice_wins_over_the_suggestion() -> None:
    target, other = chapter("1장 수신제도"), chapter("2장 여신제도")
    repo = FakeChapterRepo([target, other], {"b1": ["제1장 수신제도"]})
    auto = draft_record("b1")
    moved = draft_record("b1", manual=True, chapter_id=other.id)
    cleared = draft_record("b1", manual=True)
    gone = draft_record("b1", manual=True, chapter_id=uuid.uuid4())
    by_page = draft_record(None)

    out = draft_chapters(repo, uuid.uuid4(), uuid.uuid4(), [auto, moved, cleared, gone, by_page])  # type: ignore[arg-type]

    assert out[auto.id] == DraftChapter(target, "auto", "matched", "제1장 수신제도")
    assert out[moved.id] == DraftChapter(other, "manual", None, None)
    assert out[cleared.id] == DraftChapter(None, "manual", None, None)
    assert out[gone.id].chapter is None
    assert out[by_page.id].match == "no_source_chapter"
    assert repo.refs[by_page.id] == SourceRef(None, 3)
