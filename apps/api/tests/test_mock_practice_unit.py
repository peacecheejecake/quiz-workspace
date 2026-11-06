"""MOCK-P logic the browser cannot observe: mock exam answers are graded by stable option ids
(the shared `grade_submission` / `practice_grading`), the open-session shape cannot carry an
answer (QVIEW-01-C03, AGENTS.md §5), and a mock run's range is the mock exam's listed questions
(`select_mock_range`). The DB side is in tests/integration/questions/practice_runs and
tests/integration/questions/mock_exams."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.exceptions import RequestValidationError
from quiz_api.api.mock_practice import (
    MockPracticeSession,
    MockSubmitResult,
    result_out,
    session_out,
)
from quiz_api.api.practice import SubmitBody, grade_submission
from quiz_api.api.practice_runs import select_mock_range
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.openapi_export import render_openapi
from quiz_api.practice_grading import shuffled_option_ids
from quiz_api.question_ranges import QuestionRange
from quiz_api.repositories.mock_practice import (
    MockRevision,
    MockRunCandidate,
    MockSessionRecord,
)

ANSWER_KEYS = {
    "correct_option_ids",
    "accepted_answers",
    "explanation",
    "rubric",
    "correct_answer",
    "outcome",
    "result",
    "attempt",
}
SESSION_FIELDS = {
    "id",
    "workspace_id",
    "mock_exam_id",
    "mock_exam_question_id",
    "revision_id",
    "question_type",
    "stem",
    "stem_tables",
    "is_multi_answer",
    "options",
    "displayed_option_ids",
    "state",
    "opened_at",
    "practice_run_id",
    "run_position",
}
EXPLANATION = "모의 해설 비밀"


def _revision(
    *,
    correct: list[str] | None = None,
    multi: bool = False,
    accepted: list[str] | None = None,
) -> MockRevision:
    return MockRevision(
        id=uuid.uuid4(),
        version=1,
        stem="모의 문제",
        options=[{"id": f"opt-{c}", "text": f"보기 {c}"} for c in "abcd"],
        correct_option_ids=correct,
        accepted_answers=accepted,
        is_multi_answer=multi,
        explanation=EXPLANATION,
        rubric="채점 기준 비밀",
    )


def _session(rev: MockRevision, question_type: str = "MCQ") -> MockSessionRecord:
    return MockSessionRecord(
        id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        mock_exam_id=uuid.uuid4(),
        mock_exam_question_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        question_type=question_type,  # type: ignore[arg-type]
        variation_type="OPTION_SHUFFLE",
        displayed_option_ids=shuffled_option_ids([o["id"] for o in rev.options], 7),
        state="open",
        opened_at=datetime(2026, 11, 2, tzinfo=UTC),
        submitted_at=None,
        graded_at=None,
        revision=rev,
        practice_run_id=None,
        run_position=None,
    )


# --- grading by option id -----------------------------------------------------------------------


def test_mcq_is_graded_by_option_id_whatever_the_displayed_order() -> None:
    rev = _revision(correct=["opt-c"])
    session = _session(rev)
    assert session.displayed_option_ids != ["opt-a", "opt-b", "opt-c", "opt-d"]
    answer, result = grade_submission("MCQ", rev, SubmitBody(selected_option_ids=["opt-c"]))
    assert (answer, result) == ({"selected_option_ids": ["opt-c"]}, "correct")
    # The option shown third is not "the third option": positions are never graded.
    shown_third = session.displayed_option_ids[2]
    expected = "correct" if shown_third == "opt-c" else "incorrect"
    assert grade_submission("MCQ", rev, SubmitBody(selected_option_ids=[shown_third]))[1] == (
        expected
    )
    assert grade_submission("MCQ", rev, SubmitBody(selected_option_ids=["opt-a"]))[1] == (
        "incorrect"
    )


def test_multi_answer_mcq_is_set_equality_and_positions_are_not_options() -> None:
    rev = _revision(correct=["opt-a", "opt-d"], multi=True)
    body = SubmitBody(selected_option_ids=["opt-d", "opt-a"])
    assert grade_submission("MCQ", rev, body)[1] == "correct"
    assert grade_submission("MCQ", rev, SubmitBody(selected_option_ids=["opt-a"]))[1] == (
        "incorrect"
    )
    for bad in (["0"], ["1"], ["opt-a", "opt-a"], []):
        with pytest.raises(RequestValidationError):
            grade_submission("MCQ", rev, SubmitBody(selected_option_ids=bad))
    with pytest.raises(RequestValidationError):
        grade_submission(
            "MCQ", _revision(correct=["opt-a"]), SubmitBody(selected_option_ids=["opt-a", "opt-b"])
        )


def test_without_a_known_answer_the_submission_waits_for_a_self_grade() -> None:
    assert grade_submission("MCQ", _revision(), SubmitBody(selected_option_ids=["opt-a"]))[1] == (
        "pending"
    )
    assert grade_submission("ESSAY", _revision(), SubmitBody(answer_text="설명"))[1] == "pending"
    short = _revision(accepted=["증발"])
    assert grade_submission("SHORT_ANSWER", short, SubmitBody(answer_text=" 증발 "))[1] == (
        "correct"
    )
    with pytest.raises(RequestValidationError):
        grade_submission("ESSAY", _revision(), SubmitBody(selected_option_ids=["opt-a"]))


# --- no answers before submission ---------------------------------------------------------------


def _reachable_properties(spec: dict[str, Any], node: Any, seen: set[str]) -> set[str]:
    if isinstance(node, list):
        return {k for n in node for k in _reachable_properties(spec, n, seen)}
    if not isinstance(node, dict):
        return set()
    ref = node.get("$ref")
    if isinstance(ref, str):
        if ref in seen:
            return set()
        seen.add(ref)
        target: Any = spec
        for part in ref.removeprefix("#/").split("/"):
            target = target[part]
        return _reachable_properties(spec, target, seen)
    found = set(node.get("properties", {}))
    return found | {k for v in node.values() for k in _reachable_properties(spec, v, seen)}


def test_the_mock_session_model_is_an_allowlist() -> None:
    assert set(MockPracticeSession.model_fields) == SESSION_FIELDS


def test_an_open_mock_session_carries_no_answer() -> None:
    session = _session(_revision(correct=["opt-b"], accepted=["x"]))
    dumped = session_out(session).model_dump(mode="json")
    assert not set(dumped) & ANSWER_KEYS
    assert EXPLANATION not in json.dumps(dumped, ensure_ascii=False)
    assert [o["id"] for o in dumped["options"]] == session.displayed_option_ids


def test_the_open_mock_session_schema_has_no_answer_fields() -> None:
    spec = json.loads(render_openapi())
    op = spec["paths"]["/api/v1/mock-exam-questions/{mock_exam_question_id}/practice-sessions"]
    schema = op["post"]["responses"]["201"]["content"]["application/json"]["schema"]
    props = _reachable_properties(spec, schema, set())
    assert props, "the 201 response schema is empty"
    assert not props & ANSWER_KEYS


def test_answers_are_revealed_only_by_the_submit_result() -> None:
    spec = json.loads(render_openapi())
    submit = spec["paths"]["/api/v1/mock-practice-sessions/{mock_practice_session_id}/submit"][
        "post"
    ]
    schema = submit["responses"]["200"]["content"]["application/json"]["schema"]
    assert {"correct_option_ids", "explanation", "rubric"} <= _reachable_properties(
        spec, schema, set()
    )
    session = _session(_revision(correct=["opt-b"]))
    out = result_out(session, uuid.uuid4(), "incorrect")
    assert isinstance(out, MockSubmitResult)
    assert (out.correct_option_ids, out.explanation) == (["opt-b"], EXPLANATION)


# --- mock run ranges ----------------------------------------------------------------------------


def _candidates(*types: str) -> list[MockRunCandidate]:
    return [MockRunCandidate(uuid.uuid4(), t) for t in types]  # type: ignore[arg-type]


def _range(**kw: Any) -> QuestionRange:
    return QuestionRange.model_validate(kw)


def test_a_mock_range_keeps_mock_exam_order_and_applies_exclusions_and_type() -> None:
    a, b, c = _candidates("MCQ", "ESSAY", "MCQ")
    rows = [a, b, c]
    assert select_mock_range(rows, _range(all=True)) == [a.id, b.id, c.id]
    assert select_mock_range(rows, _range(question_ids=[str(c.id), str(a.id)])) == [a.id, c.id]
    assert select_mock_range(rows, _range(all=True, excluded_question_ids=[str(b.id)])) == [
        a.id,
        c.id,
    ]
    assert select_mock_range(rows, _range(all=True, filters={"type": "ESSAY"})) == [b.id]
    assert select_mock_range(rows, _range()) == []


@pytest.mark.parametrize(
    "bad",
    [
        {"question_ids": [str(uuid.uuid4())]},
        {"all": True, "excluded_question_ids": [str(uuid.uuid4())]},
        {"chapter_ids": ["none"]},
        {"all": True, "filters": {"status": ["unseen"]}},
        {"all": True, "filters": {"favorite": False}},
        {"all": True, "filters": {"retry": True}},
    ],
)
def test_a_mock_range_refuses_what_the_mock_exam_does_not_list(bad: dict[str, Any]) -> None:
    with pytest.raises(ProblemException) as exc:
        select_mock_range(_candidates("MCQ"), _range(**bad))
    assert exc.value.problem_type is ProblemType.RANGE_INVALID
