"""QVIEW-B logic the browser cannot observe: the range resolver's pure selection, the size cap of
the request, run order and seeds, summaries, and that no run read schema can carry an answer
(QVIEW-01-C01~C03, C07). The DB side is in tests/integration/questions/practice_runs."""

from __future__ import annotations

import json
import random
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError
from quiz_api.api.practice import PracticeSessionCreate
from quiz_api.api.practice_runs import (
    MAX_SEED,
    PRACTICE_RUN_TEST_SEED,
    PracticeRun,
    PracticeRunCreate,
    RunItem,
    RunResults,
    position_result,
    run_order,
    run_summary,
    server_seed,
)
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.idempotency import request_hash
from quiz_api.openapi_export import render_openapi
from quiz_api.question_ranges import MAX_RANGE_IDS, QuestionRange, RangeRow, select_range
from quiz_api.repositories.practice_runs import RunProgress, RunRecord
from quiz_api.settings import Environment, Settings

ANSWER_KEYS = {
    "correct_option_ids",
    "accepted_answers",
    "explanation",
    "rubric",
    "correct_answer",
    "submitted_answer",
}

CH1, CH2 = uuid.uuid4(), uuid.uuid4()


def row(
    chapter: uuid.UUID | None,
    *,
    status: Any = "unseen",
    favorite: bool = False,
    retry: bool = False,
    question_type: Any = "MCQ",
) -> RangeRow:
    return RangeRow(uuid.uuid4(), chapter, question_type, status, favorite, retry)


# Heatmap: 1장 3 questions, 2장 2, then two without a chapter.
HEATMAP = [
    row(CH1),
    row(CH1, status="incorrect"),
    row(CH1, favorite=True),
    row(CH2, status="correct", question_type="ESSAY"),
    row(CH2, status="retry", retry=True),
    row(None),
    row(None, status="viewed", question_type="SHORT_ANSWER"),
]
IDS = [r.question_id for r in HEATMAP]


def pick(**range_: Any) -> list[uuid.UUID]:
    return select_range(HEATMAP, QuestionRange.model_validate(range_))


# --- resolver: selection ------------------------------------------------------------------------


def test_all_is_the_heatmap_in_order() -> None:
    assert pick(all=True) == IDS


def test_groups_and_singles_keep_heatmap_order() -> None:
    assert pick(chapter_ids=[str(CH2)]) == IDS[3:5]
    assert pick(chapter_ids=["none"]) == IDS[5:]
    assert pick(question_ids=[str(IDS[4]), str(IDS[0])]) == [IDS[0], IDS[4]]
    assert pick(chapter_ids=[str(CH2)], question_ids=[str(IDS[0])]) == [IDS[0], IDS[3], IDS[4]]
    assert pick(chapter_ids=[str(CH1)], excluded_question_ids=[str(IDS[1])]) == [IDS[0], IDS[2]]
    assert pick() == []


def test_filters_narrow_the_whole_selection() -> None:
    assert pick(all=True, filters={"status": ["incorrect", "retry"]}) == [IDS[1], IDS[4]]
    assert pick(all=True, filters={"favorite": True}) == [IDS[2]]
    assert pick(all=True, filters={"retry": False, "type": "MCQ"}) == [*IDS[:3], IDS[5]]
    # An explicitly picked question that the filter hides is not in the result.
    assert pick(question_ids=[str(IDS[0])], filters={"status": ["incorrect"]}) == []


@pytest.mark.parametrize("field", ["question_ids", "excluded_question_ids"])
def test_ids_outside_the_heatmap_are_refused_not_dropped(field: str) -> None:
    # Drafts, archived (merged duplicates included), deleted and foreign ids are never rows.
    with pytest.raises(ProblemException) as exc:
        pick(all=True, **{field: [str(IDS[0]), str(uuid.uuid4())]})
    assert exc.value.status_code == 422
    assert exc.value.problem_type is ProblemType.RANGE_INVALID


def test_id_lists_are_capped_at_5000_each() -> None:
    ids = [str(uuid.uuid4()) for _ in range(MAX_RANGE_IDS)]
    QuestionRange.model_validate({"question_ids": ids, "excluded_question_ids": ids})
    for field in ("question_ids", "excluded_question_ids", "chapter_ids"):
        with pytest.raises(ValidationError):
            QuestionRange.model_validate({field: [*ids, str(uuid.uuid4())]})


def test_range_rejects_unknown_fields_and_bad_chapters() -> None:
    with pytest.raises(ValidationError):
        QuestionRange.model_validate({"all": True, "workspace_id": str(uuid.uuid4())})
    with pytest.raises(ValidationError):
        QuestionRange.model_validate({"chapter_ids": ["not-a-chapter"]})


# --- request ------------------------------------------------------------------------------------


def test_create_body_ignores_client_identity_and_checks_the_mock_pair() -> None:
    body = PracticeRunCreate.model_validate(
        {
            "source": "bank",
            "range": {"all": True},
            "workspace_id": str(uuid.uuid4()),
            "user_id": str(uuid.uuid4()),
        }
    )
    assert not {"workspace_id", "user_id"} & set(body.model_dump())
    with pytest.raises(ValidationError):
        PracticeRunCreate.model_validate({"source": "mock", "range": {}})
    with pytest.raises(ValidationError):
        PracticeRunCreate.model_validate(
            {"source": "bank", "mock_exam_id": str(uuid.uuid4()), "range": {}}
        )
    for bad in (-1, MAX_SEED + 1):
        with pytest.raises(ValidationError):
            PracticeRunCreate.model_validate({"source": "bank", "range": {}, "seed": bad})


def test_idempotency_hash_ignores_client_identity_fields() -> None:
    plain = {"source": "bank", "range": {"all": True}, "random_order": True}
    spoofed = {**plain, "workspace_id": str(uuid.uuid4())}
    h = [
        request_hash(PracticeRunCreate.model_validate(b).model_dump(mode="json"))
        for b in (plain, spoofed)
    ]
    assert h[0] == h[1]
    other = {**plain, "random_order": False}
    assert request_hash(PracticeRunCreate.model_validate(other).model_dump(mode="json")) != h[0]


def test_session_body_pairs_run_and_position() -> None:
    assert PracticeSessionCreate.model_validate({}).model_dump(exclude_none=True) == {}
    PracticeSessionCreate.model_validate({"practice_run_id": str(uuid.uuid4()), "run_position": 1})
    for bad in (
        {"practice_run_id": str(uuid.uuid4())},
        {"run_position": 1},
        {"practice_run_id": str(uuid.uuid4()), "run_position": 0},
        {"practice_run_id": str(uuid.uuid4()), "run_position": 5001},
    ):
        with pytest.raises(ValidationError):
            PracticeSessionCreate.model_validate(bad)


# --- order and seed -----------------------------------------------------------------------------


def test_order_is_heatmap_or_the_seeded_shuffle() -> None:
    assert run_order(IDS, False, 99) == IDS
    expected = list(IDS)
    random.Random(12345).shuffle(expected)  # noqa: S311
    assert run_order(IDS, True, 12345) == expected
    assert run_order(IDS, True, 12345) == run_order(IDS, True, 12345)
    assert sorted(run_order(IDS, True, 7)) == sorted(IDS)


def test_test_env_seed_is_fixed_and_gives_the_fixture_order() -> None:
    test_env = Settings.model_construct(app_env=Environment.TEST)
    assert server_seed(test_env) == PRACTICE_RUN_TEST_SEED
    assert run_order([1, 2, 3, 4, 5], True, PRACTICE_RUN_TEST_SEED) == [3, 4, 2, 5, 1]  # type: ignore[list-item]


@pytest.mark.parametrize("env", [Environment.LOCAL, Environment.PREVIEW, Environment.PRODUCTION])
def test_other_environments_draw_a_random_seed(env: Environment) -> None:
    settings = Settings.model_construct(app_env=env)
    seeds = {server_seed(settings) for _ in range(8)}
    assert len(seeds) > 1
    assert all(0 <= s <= MAX_SEED for s in seeds)


# --- summary ------------------------------------------------------------------------------------


def run(total: int, finished: bool) -> RunRecord:
    now = datetime(2026, 11, 2, tzinfo=UTC)
    return RunRecord(
        uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), "bank", None, False, 1, total, now,
        now if finished else None,
    )  # fmt: skip


def test_summary_counts_skipped_before_the_furthest_position_while_open() -> None:
    # 5 positions, reached 5: 1 correct, 1 incorrect, 2 pending, position 3 skipped (AC06).
    progress = RunProgress(
        reached=5, submitted=4, correct=1, incorrect=1, pending=2, submitted_before_reached=3
    )
    open_summary = run_summary(run(5, False), progress)
    assert open_summary.model_dump() == {"correct": 1, "incorrect": 1, "pending": 2, "skipped": 1}
    nothing = RunProgress(0, 0, 0, 0, 0, 0)
    assert run_summary(run(3, False), nothing).skipped == 0
    assert run_summary(run(3, True), nothing).skipped == 3


def test_position_result() -> None:
    r = run(5, False)
    assert position_result(r, 3, 1, "graded", "correct") == "correct"
    assert position_result(r, 3, 1, "pending_grade", "pending") == "pending"
    assert position_result(r, 3, 2, "open", None) == "skipped"
    assert position_result(r, 3, 2, None, None) == "skipped"
    assert position_result(r, 3, 3, "open", None) is None
    assert position_result(r, 3, 4, None, None) is None
    assert position_result(run(5, True), 0, 4, None, None) == "skipped"


# --- no answers in run reads (C03) --------------------------------------------------------------


def _props(spec: dict[str, Any], node: Any, seen: set[str], skip: set[str]) -> set[str]:
    if isinstance(node, list):
        return {k for n in node for k in _props(spec, n, seen, skip)}
    if not isinstance(node, dict):
        return set()
    ref = node.get("$ref")
    if isinstance(ref, str):
        name = ref.rsplit("/", 1)[-1]
        if ref in seen or name in skip:
            return set()
        seen.add(ref)
        target: Any = spec
        for part in ref.removeprefix("#/").split("/"):
            target = target[part]
        return _props(spec, target, seen, skip)
    found = set(node.get("properties", {}))
    return found | {k for v in node.values() for k in _props(spec, v, seen, skip)}


def _response(spec: dict[str, Any], path: str, method: str, code: str) -> Any:
    op = spec["paths"][f"/api/v1{path}"][method]
    return op["responses"][code]["content"]["application/json"]["schema"]


def test_run_reads_have_no_answer_fields() -> None:
    spec = json.loads(render_openapi())
    for path, method, code in (
        ("/workspaces/{workspace_id}/practice-runs", "post", "201"),
        ("/practice-runs/{run_id}", "get", "200"),
        ("/practice-runs/{run_id}/finish", "post", "200"),
        ("/practice-runs/{run_id}/results", "get", "200"),
    ):
        props = _props(spec, _response(spec, path, method, code), set(), set())
        assert props, path
        assert not props & (ANSWER_KEYS | {"stem", "options", "item_ids"}), path


def test_an_item_carries_answers_only_inside_its_attempt() -> None:
    spec = json.loads(render_openapi())
    schema = _response(spec, "/practice-runs/{run_id}/items/{position}", "get", "200")
    outside = _props(spec, schema, set(), skip={"RunAttempt"})
    assert {"stem", "options", "attempt"} <= outside
    assert not outside & ANSWER_KEYS
    inside = _props(spec, schema, set(), set())
    assert {"correct_option_ids", "explanation", "rubric", "accepted_answers"} <= inside


def test_run_models_are_an_allowlist() -> None:
    assert set(PracticeRun.model_fields) == {
        "id", "workspace_id", "source", "mock_exam_id", "random_order", "seed", "total",
        "answered", "reached", "created_at", "finished_at", "summary",
    }  # fmt: skip
    assert set(RunResults.model_fields) == {"total", "offset", "limit", "items"}
    assert "attempt" in RunItem.model_fields
    assert not set(RunItem.model_fields) & ANSWER_KEYS
