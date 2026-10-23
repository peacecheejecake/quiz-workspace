"""Batch generation request rules and the random pick (QGEN-MULTI), without a database."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from pydantic import ValidationError
from quiz_api.api.question_generation_batches import (
    MAX_BATCH_SOURCES,
    GenerationBatchCreate,
    RandomSources,
    SelectedSources,
    _random_sources,
)
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.question_status import LastGradedResult
from quiz_api.repositories.question_generations import (
    LiveQuestionRecord,
    QuestionGenerationRepository,
)
from quiz_api.repositories.question_overview import OverviewFilter, OverviewRow

WS = uuid.uuid4()
USER = uuid.uuid4()


def _row(n: int, *, favorite: bool = False, graded: LastGradedResult | None = None) -> OverviewRow:
    return OverviewRow(
        question_id=uuid.UUID(int=n),
        question_type="MCQ",
        question_number=n,
        chapter_id=None,
        chapter_title=None,
        chapter_document_id=None,
        stem_head=f"문제 {n}",
        first_viewed_at=datetime(2026, 10, 1, tzinfo=UTC) if graded else None,
        last_graded_result=graded,
        needs_retry=False,
        is_favorite=favorite,
        is_pending_grading=False,
    )


class FakeOverview:
    def __init__(self, rows: list[OverviewRow]) -> None:
        self.rows_ = rows
        self.filters: list[OverviewFilter] = []

    def rows(self, workspace_id: uuid.UUID, user_id: uuid.UUID, flt: OverviewFilter) -> Any:
        assert (workspace_id, user_id) == (WS, USER)
        self.filters.append(flt)
        return self.rows_


class _FakeRepo:
    def live_questions(self, workspace_id: uuid.UUID, ids: list[uuid.UUID]) -> Any:
        assert workspace_id == WS
        return {
            i: LiveQuestionRecord(i, "CONFIRMED", uuid.uuid4(), i.int, f"문제 {i.int}") for i in ids
        }


REPO = cast(QuestionGenerationRepository, _FakeRepo())


def _overview(rows: list[OverviewRow]) -> Any:
    return FakeOverview(rows)


ROWS = [
    _row(1, favorite=True),
    _row(2),
    _row(3, graded="incorrect"),
    _row(4, favorite=True, graded="correct"),
    _row(5),
    _row(6, graded="incorrect"),
]


def _pick(selection: RandomSources, seed: int = 1, rows: list[OverviewRow] = ROWS) -> list[int]:
    picked = _random_sources(REPO, _overview(rows), WS, USER, selection, seed)
    return [q.id.int for q in picked]


def _random(**fields: Any) -> RandomSources:
    return RandomSources.model_validate({"mode": "random", "count": 3, **fields})


def test_same_seed_same_candidates_same_pick_and_no_repeats() -> None:
    a = _pick(_random(), seed=42)
    assert a == _pick(_random(), seed=42)
    assert len(set(a)) == 3
    assert {tuple(_pick(_random(), seed=s)) for s in range(20)} != {tuple(a)}


def test_filters_by_favorite_and_status_of_the_caller() -> None:
    assert sorted(_pick(_random(count=5, favorite=True))) == [1, 4]
    assert sorted(_pick(_random(count=5, favorite=False))) == [2, 3, 5, 6]
    assert sorted(_pick(_random(count=5, statuses=["incorrect"]))) == [3, 6]
    assert sorted(_pick(_random(count=5, statuses=["unseen", "correct"]))) == [1, 2, 4, 5]
    assert _pick(_random(count=5, favorite=True, statuses=["correct"])) == [4]


def test_scope_filters_go_to_the_overview_query() -> None:
    overview = _overview(ROWS)
    chapter = uuid.uuid4()
    _random_sources(REPO, overview, WS, USER, _random(chapter=str(chapter), question_type="MCQ"), 1)
    _random_sources(REPO, overview, WS, USER, _random(chapter="none"), 1)
    assert overview.filters == [
        OverviewFilter(chapter_id=chapter, question_type="MCQ"),
        OverviewFilter(no_chapter=True),
    ]


def test_no_candidate_is_a_409_without_runs() -> None:
    with pytest.raises(ProblemException) as caught:
        _pick(_random(statuses=["retry"]))
    assert caught.value.status_code == 409
    assert caught.value.problem_type is ProblemType.NO_MATCHING_QUESTIONS


def test_request_shape_limits() -> None:
    body = {"variation_types": ["PARAPHRASE"]}
    selected = GenerationBatchCreate.model_validate(
        {**body, "selection": {"mode": "selected", "question_ids": [str(uuid.uuid4())]}}
    )
    assert isinstance(selected.selection, SelectedSources)
    random_pick = GenerationBatchCreate.model_validate(
        {**body, "selection": {"mode": "random", "count": MAX_BATCH_SOURCES}}
    )
    assert isinstance(random_pick.selection, RandomSources)
    bad = [
        {"mode": "selected", "question_ids": []},
        {"mode": "selected", "question_ids": [str(uuid.uuid4()) for _ in range(21)]},
        {"mode": "random", "count": 0},
        {"mode": "random", "count": MAX_BATCH_SOURCES + 1},
        {"mode": "random", "count": 1, "chapter": "chapter-3"},
        {"mode": "random", "count": 1, "seed": -1},
        {"mode": "random", "count": 1, "statuses": ["wrong"]},
        {"mode": "other", "count": 1},
        {"mode": "random", "count": 1, "workspace_id": str(uuid.uuid4())},
    ]
    for selection in bad:
        with pytest.raises(ValidationError):
            GenerationBatchCreate.model_validate({**body, "selection": selection})
