"""ASK-01-C03: the practice and mock practice responses are unchanged by AI questions (no answer
or disclosure field added for the AI question feature, nothing removed)."""

from __future__ import annotations

from typing import Any

import pytest
from quiz_api.main import create_app
from quiz_api.settings import Settings

# The response models of POST/GET practice sessions and submit, bank and mock, as of ASK-B.
EXPECTED = {
    "PracticeSession": {
        "chapter_id", "displayed_option_ids", "id", "is_multi_answer", "opened_at", "options",
        "practice_run_id", "question_id", "question_number", "question_revision_id",
        "question_type", "run_position", "state", "stem", "stem_tables", "workspace_id",
    },
    "PracticeSessionDetail": {
        "chapter_id", "displayed_option_ids", "graded_at", "id", "is_multi_answer", "opened_at",
        "options", "outcome", "practice_run_id", "question_id", "question_number",
        "question_revision_id", "question_type", "run_position", "state", "stem", "stem_tables",
        "submitted_at", "workspace_id",
    },
    "SubmitResult": {
        "accepted_answers", "attempt_id", "correct_option_ids", "explanation",
        "practice_session_id", "question_revision_id", "result", "rubric", "state",
    },
    "MockPracticeSession": {
        "displayed_option_ids", "id", "is_multi_answer", "mock_exam_id", "mock_exam_question_id",
        "opened_at", "options", "practice_run_id", "question_type", "revision_id",
        "run_position", "state", "stem", "stem_tables", "workspace_id",
    },
    "MockSubmitResult": {
        "accepted_answers", "attempt_id", "correct_option_ids", "explanation",
        "mock_exam_question_id", "practice_session_id", "result", "revision_id", "rubric",
        "state",
    },
}  # fmt: skip


@pytest.fixture(scope="module")
def schemas() -> dict[str, Any]:
    spec = create_app(Settings(), readiness_checkers=[]).openapi()
    found: dict[str, Any] = spec["components"]["schemas"]
    return found


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_ask_01_c03_practice_response_schemas_are_unchanged(
    schemas: dict[str, Any], name: str
) -> None:
    properties = set(schemas[name].get("properties", {}))
    assert properties == EXPECTED[name]
    assert not {p for p in properties if "ask" in p or "disclosure" in p}
