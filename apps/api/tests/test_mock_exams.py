"""Mock exam API pieces that need no stack (MOCK-B): request limits, the presentation of
generations and the answer-free viewer shape (MOCK-01-C05/C06). The routes run against the
stack in tests/integration/questions/mock_exams."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from quiz_api.api.mock_exams import (
    MockExamConfig,
    MockExamCreate,
    SourceRef,
    _check_config,
    _question_json,
    generation_out,
    question_out,
)
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.repositories.mock_exams import GenerationRecord, QuestionRecord
from quiz_api.settings import Settings

ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric"}
NOW = datetime(2026, 11, 2, tzinfo=UTC)


def settings(on: bool) -> Settings:
    return Settings(APP_ENV="test", WORKER_MOCK_EXAMS=on)  # type: ignore[call-arg]


def test_question_count_limits() -> None:
    _check_config(
        MockExamConfig(variation_types=["PARAPHRASE"], question_count=100), settings(True)
    )
    _check_config(
        MockExamConfig(variation_types=["OPTION_SHUFFLE"], question_count=None), settings(False)
    )
    for count in (101, None):
        with pytest.raises(RequestValidationError):
            _check_config(
                MockExamConfig(variation_types=["PARAPHRASE"], question_count=count),
                settings(True),
            )
    with pytest.raises(ValidationError):
        MockExamConfig(variation_types=["PARAPHRASE"], question_count=0)
    with pytest.raises(ValidationError):
        MockExamConfig(variation_types=[], question_count=1)
    with pytest.raises(ValidationError):
        MockExamConfig(variation_types=["PARAPHRASE", "PARAPHRASE"], question_count=1)


def test_ai_types_need_the_feature() -> None:
    with pytest.raises(ProblemException) as info:
        _check_config(
            MockExamConfig(variation_types=["PARAPHRASE"], question_count=1), settings(False)
        )
    assert info.value.problem_type is ProblemType.MOCK_LLM_DISABLED


def test_a_client_workspace_id_is_refused() -> None:
    with pytest.raises(ValidationError):
        MockExamCreate.model_validate(
            {
                "title": "x",
                "config": {"variation_types": ["OPTION_SHUFFLE"], "question_count": 1},
                "range": {"all": True},
                "workspace_id": str(uuid.uuid4()),
            }
        )


def generation(**kw: object) -> GenerationRecord:
    base: dict[str, object] = {
        "id": uuid.uuid4(),
        "mock_exam_id": uuid.uuid4(),
        "version": 1,
        "status": "running",
        "job_id": uuid.uuid4(),
        "job_status": "running",
        "job_error": None,
        "config": {},
        "requested_count": 20,
        "created_count": 0,
        "skipped_count": 0,
        "progress_done": 7,
        "error_code": None,
        "seed": 1,
        "created_at": NOW,
        "finished_at": None,
    }
    return GenerationRecord(**{**base, **kw})  # type: ignore[arg-type]


def test_generation_progress_and_a_lost_job() -> None:
    running = generation_out(generation())
    assert running.progress is not None
    assert (running.progress.done, running.progress.total) == (7, 20)
    lost = generation_out(generation(job_status="failed", job_error="worker_lost: x"))
    assert lost.status == "failed"
    assert lost.error_code
    assert lost.progress is None


def test_viewers_get_no_answers() -> None:
    q = QuestionRecord(
        id=uuid.uuid4(),
        mock_exam_id=uuid.uuid4(),
        generation_id=uuid.uuid4(),
        position=0,
        question_type="MCQ",
        variation_type="PARAPHRASE",
        revision_id=uuid.uuid4(),
        revision_version=2,
        stem="stem",
        options=[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}],
        correct_option_ids=["opt-1"],
        accepted_answers=None,
        is_multi_answer=False,
        explanation="why",
        rubric=None,
        validation_issues=[{"code": "polarity_unchanged", "severity": "warning"}],
        evidence=[],
        source_question_id=None,
        source_deleted=True,
        source_chapter_id=None,
        source_number=None,
    )
    ref = SourceRef(question_id=None, label="원본 삭제됨")
    viewer = _question_json(question_out(q, ref, answers=False), answers=False)
    assert not ANSWER_KEYS & set(viewer)
    assert "validation_issues" not in viewer
    assert viewer["edited"] is True
    editor = _question_json(question_out(q, ref, answers=True), answers=True)
    assert editor["correct_option_ids"] == ["opt-1"]
    assert editor["validation_issues"] == [{"code": "polarity_unchanged", "severity": "warning"}]
