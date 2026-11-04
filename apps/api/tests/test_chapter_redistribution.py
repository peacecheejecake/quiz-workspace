"""UX9-REDIST-B logic the browser cannot observe (CHREDIST-01-C02..C05): the recommendation rule
and its equality with the import draft suggestion (property test), the assignment's lock order
(documents before questions, the order a correction publish cannot deadlock with), that every
refusal happens before any write, the Idempotency-Key rules, labels and answer-free schemas.
The DB side is tests/integration/questions/chapter_redistribution."""

from __future__ import annotations

import json
import random
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from quiz_api.api import chapter_redistribution as redist
from quiz_api.api.questions import get_idempotency_store
from quiz_api.authz import Action, Role, WorkspaceAccess
from quiz_api.chapter_matching import (
    BookChapter,
    ChapterMatcher,
    StartBlock,
    recommend,
)
from quiz_api.draft_chapters import draft_chapters
from quiz_api.errors import ProblemType
from quiz_api.idempotency import request_hash
from quiz_api.main import create_app
from quiz_api.openapi_export import render_openapi
from quiz_api.repositories.chapter_redistribution import LockedQuestion, TargetChapter
from quiz_api.repositories.draft_chapters import SourceRef
from quiz_api.repositories.idempotency import StoredResponse
from quiz_api.repositories.question_imports import DraftRecord
from quiz_api.settings import Settings

BOOK, OTHER = uuid.uuid4(), uuid.uuid4()
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "options"}


def chapter(title: str, document: uuid.UUID = BOOK, level: int = 1) -> BookChapter:
    return BookChapter(uuid.uuid4(), title, document, "교재", level)


# --- recommendation rule (C05) -------------------------------------------------------------------


def test_no_source_and_book_sources() -> None:
    matcher = ChapterMatcher([chapter("1장 물의 순환")])
    ch2 = chapter("2장 정수 처리")
    assert recommend(None, matcher).reason == "no_source"
    found = recommend(StartBlock(in_book=True, book_chapter=ch2), matcher)
    assert (found.chapter, found.reason) == (ch2, "source_in_book")
    gone = recommend(StartBlock(in_book=True, book_chapter=None), matcher)
    assert (gone.chapter, gone.reason) == (None, "no_source_chapter")


def test_question_paper_sources_match_titles_never_numbers() -> None:
    one, two = chapter("1장 개요"), chapter("2장 주의 집중")
    matcher = ChapterMatcher([one, two])
    assert recommend(StartBlock(False, chain=("제2장 주의 집중",)), matcher).chapter == two
    assert recommend(StartBlock(False, chain=("제2장 기타",)), matcher).reason == "no_match"
    assert recommend(StartBlock(False), matcher).reason == "no_source_chapter"
    twins = ChapterMatcher([chapter("1장 개요"), chapter("1장 개요", OTHER)])
    assert recommend(StartBlock(False, chain=("개요",)), twins).reason == "ambiguous"


def test_chap_match_paper_chapter_is_the_fallback_for_no_match_and_ambiguous() -> None:
    paper = chapter("제1회 모의평가", OTHER, 1)
    matcher = ChapterMatcher([chapter("1장 물의 순환")])
    start = StartBlock(False, chain=("01 이것은?", "제1회 모의평가"), paper_chapter=paper)
    miss = recommend(start, matcher)
    assert (miss.chapter, miss.reason) == (paper, "paper_chapter")
    twins = ChapterMatcher([chapter("1장 개요"), chapter("1장 개요", OTHER)])
    both = recommend(StartBlock(False, chain=("개요",), paper_chapter=paper), twins)
    assert (both.chapter, both.reason) == (paper, "paper_chapter")


def test_chap_match_a_book_match_wins_over_the_fallback_and_no_chain_has_none() -> None:
    paper, hit = chapter("제1회 모의평가", OTHER, 1), chapter("2장 정수 처리")
    matcher = ChapterMatcher([hit])
    found = recommend(StartBlock(False, chain=("정수 처리",), paper_chapter=paper), matcher)
    assert (found.chapter, found.reason) == (hit, "matched")
    empty = recommend(StartBlock(False, paper_chapter=None), matcher)
    assert (empty.chapter, empty.reason) == (None, "no_source_chapter")
    assert recommend(StartBlock(False, chain=("기타",)), matcher).reason == "no_match"


TITLES = ["개요", "주의 집중", "물의 순환", "정수 처리", "기출", "요약"]
PREFIXES = ["", "제{n}장 ", "{n}장 ", "{n}. ", "Chapter {n} "]


def _title(rng: random.Random) -> str:
    prefix = rng.choice(PREFIXES).format(n=rng.randint(1, 3))
    return prefix + rng.choice(TITLES)


@dataclass
class FakeDraftRepo:
    books: list[BookChapter]
    chains: dict[uuid.UUID, list[str]]

    def book_chapters(self, workspace_id: uuid.UUID) -> list[BookChapter]:
        return self.books

    def source_chains(
        self, workspace_id: uuid.UUID, revision_id: uuid.UUID, refs: dict[uuid.UUID, SourceRef]
    ) -> dict[uuid.UUID, list[str]]:
        return {k: self.chains[k] for k in refs}

    def current_book_chapters(self, *_: Any) -> dict[uuid.UUID, BookChapter]:
        return {}


@pytest.mark.parametrize("seed", range(40))
def test_property_question_recommendation_equals_the_draft_suggestion(seed: int) -> None:
    """For the same question-paper block (its outline chain), a registered question's
    recommendation is the import draft's suggestion: same chapter, same reason."""
    rng = random.Random(seed)  # noqa: S311 - deterministic cases, not secrets
    books = [
        chapter(_title(rng), rng.choice([BOOK, OTHER]), rng.randint(1, 2))
        for _ in range(rng.randint(0, 6))
    ]
    chains = {uuid.uuid4(): [_title(rng) for _ in range(rng.randint(0, 3))] for _ in range(8)}
    repo = FakeDraftRepo(books, chains)
    drafts = [_import_draft(d) for d in chains]
    suggested = draft_chapters(repo, uuid.uuid4(), uuid.uuid4(), drafts)  # type: ignore[arg-type]
    matcher = ChapterMatcher(books)
    for draft_id, chain in chains.items():
        question = recommend(StartBlock(in_book=False, chain=tuple(chain)), matcher)
        draft = suggested[draft_id]
        assert question.chapter == draft.chapter
        assert question.reason == draft.match


def _import_draft(draft_id: uuid.UUID) -> DraftRecord:
    fields: dict[str, Any] = dict.fromkeys(DraftRecord.__dataclass_fields__)
    fields.update(id=draft_id, source_type="import", chapter_manual=False, chapter_id=None)
    fields["payload"] = {"evidence": [{"block_ids": ["b1"]}]}
    return DraftRecord(**fields)


# --- labels -------------------------------------------------------------------------------------


def test_labels_and_stem_preview() -> None:
    assert redist.number_label(3, "3장 정수", 12) == "3장 12번"
    assert redist.number_label(None, "부록", 2) == "부록 2번"
    assert redist.number_label(None, None, 5) == "5번"
    assert redist.number_label(None, None, None) == "번호 없음"
    assert redist.stem_preview("  가\n나   " + "다" * 60) == ("가 나 " + "다" * 60)[:40]
    assert len(redist.stem_preview("x" * 100)) == 40


def test_no_schema_of_the_feature_carries_answers() -> None:
    spec = json.loads(render_openapi())
    schemas = spec["components"]["schemas"]
    for name in (
        "RedistributionList",
        "RedistributionQuestion",
        "RedistributionPreview",
        "RedistributionPreviewItem",
        "ChapterAssignmentResult",
    ):
        assert not ANSWER_KEYS & set(schemas[name]["properties"]), name


# --- assignment route with recording fakes (C02, C03, lock order) ---------------------------------

WS, USER = uuid.uuid4(), uuid.uuid4()
CH1, CH2, PAPER = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


@dataclass
class World:
    """Questions (id -> current chapter, status), chapters (id -> valid target), calls."""

    questions: dict[uuid.UUID, tuple[uuid.UUID | None, str]] = field(default_factory=dict)
    chapters: dict[uuid.UUID, bool] = field(default_factory=dict)
    calls: list[tuple[str, Any]] = field(default_factory=list)
    stored: dict[str, StoredResponse] = field(default_factory=dict)

    # QuestionRepository
    @contextmanager
    def savepoint(self) -> Iterator[None]:
        yield

    def lock_documents(self, workspace_id: uuid.UUID, *, chapter_ids: Any = ()) -> None:
        self.calls.append(("lock_documents", sorted(str(c) for c in chapter_ids if c)))

    def set_chapter(self, workspace_id: uuid.UUID, moves: Any, **kw: Any) -> None:
        self.calls.append(("set_chapter", (list(moves), kw)))
        for qid, _, to in moves:
            self.questions[qid] = (to, self.questions[qid][1])

    def commit(self) -> None:
        self.calls.append(("commit", None))

    def rollback(self) -> None:
        self.calls.append(("rollback", None))

    # ChapterRedistributionRepository
    def lock_questions(self, workspace_id: uuid.UUID, ids: Any) -> dict[uuid.UUID, Any]:
        self.calls.append(("lock_questions", sorted(ids)))
        return {
            q: LockedQuestion(q, self.questions[q][0], self.questions[q][1])  # type: ignore[arg-type]
            for q in ids
            if q in self.questions
        }

    def target_chapters(self, workspace_id: uuid.UUID, ids: Any) -> dict[uuid.UUID, Any]:
        self.calls.append(("target_chapters", sorted(ids)))
        return {c: TargetChapter(c, self.chapters[c]) for c in ids if c in self.chapters}

    def record_reassigned(self, workspace_id: uuid.UUID, actor: uuid.UUID, meta: Any) -> None:
        self.calls.append(("activity", meta))

    # IdempotencyStore
    def lock(self, user: uuid.UUID, scope: str, key: str) -> None:
        self.calls.append(("idempotency_lock", key))

    def find(self, user: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        return self.stored.get(key)

    def save(self, user: uuid.UUID, scope: str, key: str, h: str, status: int, body: Any) -> None:
        self.stored[key] = StoredResponse(h, status, body)

    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


@pytest.fixture
def world() -> World:
    w = World()
    w.chapters = {CH1: True, CH2: True, PAPER: False}
    return w


@pytest.fixture
def api(world: World) -> Iterator[TestClient]:
    app: FastAPI = create_app(Settings.model_construct(), readiness_checkers=[])
    access = WorkspaceAccess(WS, USER, Role.OWNER, "active", Action.QUESTION_EDIT)
    app.dependency_overrides[redist._edit_workspace] = lambda: access
    app.dependency_overrides[redist._repo] = lambda: world
    app.dependency_overrides[redist._questions] = lambda: world
    app.dependency_overrides[get_idempotency_store] = lambda: world
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def _post(api: TestClient, items: list[dict[str, Any]], key: str | None = None, **kw: Any) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    return api.post(
        f"/api/v1/workspaces/{WS}/questions/chapter-assignments",
        json={"source": kw.get("source", "manual"), "items": items},
        headers=headers,
    )


def _item(q: uuid.UUID, to: uuid.UUID | None, expected: uuid.UUID | None) -> dict[str, Any]:
    return {
        "question_id": str(q),
        "chapter_id": str(to) if to else None,
        "expected_chapter_id": str(expected) if expected else None,
    }


def test_documents_are_locked_before_the_questions(world: World, api: TestClient) -> None:
    q1, q2 = uuid.uuid4(), uuid.uuid4()
    world.questions = {q1: (CH1, "CONFIRMED"), q2: (None, "CONFIRMED")}
    res = _post(api, [_item(q1, CH2, CH1), _item(q2, CH2, None)])
    assert res.status_code == 200, res.text
    assert res.json() == {"moved": 2, "unchanged": 0}
    names = world.names()
    assert names.index("lock_documents") < names.index("lock_questions")
    assert names.index("lock_questions") < names.index("set_chapter") < names.index("commit")
    # Target and expected (current) chapters' documents, in one call.
    assert world.calls[0] == ("lock_documents", sorted([str(CH1), str(CH2)]))
    _, kw = dict(world.calls)["set_chapter"]
    assert (kw["chapter_source"], kw["change_source"]) == ("manual", "manual")
    assert dict(world.calls)["activity"] == {
        "source": "manual",
        "moved": 2,
        "unchanged": 0,
        "chapter_id": str(CH2),
    }


@pytest.mark.parametrize(
    ("case", "status", "ptype"),
    [
        ("missing", 404, None),
        ("draft", 409, ProblemType.QUESTION_NOT_CONFIRMED),
        ("stale", 409, ProblemType.CHAPTER_CHANGED),
        ("foreign-chapter", 404, None),
        ("paper-chapter", 422, ProblemType.CHAPTER_INVALID),
    ],
)
def test_every_refusal_happens_before_any_write(
    world: World, api: TestClient, case: str, status: int, ptype: str | None
) -> None:
    good, other = uuid.uuid4(), uuid.uuid4()
    world.questions = {good: (CH1, "CONFIRMED"), other: (CH1, "CONFIRMED")}
    second = {
        "missing": _item(uuid.uuid4(), CH2, CH1),
        "draft": _item(other, CH2, CH1),
        "stale": _item(other, CH2, CH2),
        "foreign-chapter": _item(other, uuid.uuid4(), CH1),
        "paper-chapter": _item(other, PAPER, CH1),
    }[case]
    if case == "draft":
        world.questions[other] = (CH1, "DRAFT")
    res = _post(api, [_item(good, CH2, CH1), second])
    assert res.status_code == status, res.text
    if ptype:
        assert res.json()["type"] == ptype
    if case == "stale":
        assert res.json()["question_ids"] == [str(other)]
    assert "set_chapter" not in world.names()
    assert "activity" not in world.names()
    assert "commit" not in world.names()


def test_recommendation_moves_are_auto_and_unchanged_items_are_counted(
    world: World, api: TestClient
) -> None:
    q1, q2 = uuid.uuid4(), uuid.uuid4()
    world.questions = {q1: (None, "CONFIRMED"), q2: (CH2, "CONFIRMED")}
    res = _post(api, [_item(q1, CH1, None), _item(q2, CH2, CH2)], source="recommendation")
    assert res.json() == {"moved": 1, "unchanged": 1}
    moves, kw = dict(world.calls)["set_chapter"]
    assert moves == [(q1, None, CH1)]
    assert (kw["chapter_source"], kw["change_source"]) == ("auto", "recommendation")


def test_nothing_moved_writes_no_activity(world: World, api: TestClient) -> None:
    q1 = uuid.uuid4()
    world.questions = {q1: (CH2, "CONFIRMED")}
    assert _post(api, [_item(q1, CH2, CH2)]).json() == {"moved": 0, "unchanged": 1}
    assert "activity" not in world.names()


def test_duplicates_and_sizes_are_422(world: World, api: TestClient) -> None:
    q1 = uuid.uuid4()
    world.questions = {q1: (CH1, "CONFIRMED")}
    assert _post(api, [_item(q1, CH2, CH1), _item(q1, CH2, CH1)]).status_code == 422
    assert _post(api, []).status_code == 422
    many = [_item(uuid.uuid4(), CH2, CH1) for _ in range(redist.MAX_ITEMS + 1)]
    assert _post(api, many).status_code == 422
    assert world.calls == []


def test_same_key_replays_before_checks_other_body_is_422(world: World, api: TestClient) -> None:
    q1, q2 = uuid.uuid4(), uuid.uuid4()
    world.questions = {q1: (CH1, "CONFIRMED"), q2: (CH1, "CONFIRMED")}
    items = [_item(q1, CH2, CH1)]
    first = _post(api, items, key="k-1")
    assert first.status_code == 200
    moved = len([c for c in world.calls if c[0] == "set_chapter"])
    again = _post(api, items, key="k-1")
    assert (again.status_code, again.json()) == (200, first.json())
    assert again.headers["Idempotent-Replayed"] == "true"
    assert len([c for c in world.calls if c[0] == "set_chapter"]) == moved, "no second write"
    # Keyless repeat: the expected chapter is stale now.
    keyless = _post(api, items)
    assert keyless.status_code == 409
    assert keyless.json()["type"] == ProblemType.CHAPTER_CHANGED
    reused = _post(api, [_item(q2, CH2, CH1)], key="k-1")
    assert reused.status_code == 422
    assert reused.json()["type"] == ProblemType.IDEMPOTENCY_KEY_REUSED
    assert world.questions[q2][0] == CH1


def test_request_hash_ignores_nothing_of_the_body() -> None:
    a = redist.ChapterAssignmentRequest.model_validate(
        {"source": "manual", "items": [_item(uuid.UUID(int=1), CH1, None)]}
    )
    b = a.model_copy(update={"source": "recommendation"})
    assert request_hash(a.model_dump(mode="json")) != request_hash(b.model_dump(mode="json"))
