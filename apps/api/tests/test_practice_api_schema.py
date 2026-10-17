"""M5.2: the practice-session response shapes cannot carry answers (AGENTS.md §5, QPLAY-01).

Checked on the OpenAPI document: every schema reachable from the open/resume responses of an
OPEN session (the 201 of POST /questions/{id}/practice-sessions) has no answer field, and the
session model is an explicit allowlist.
"""

from __future__ import annotations

import json
from typing import Any

from quiz_api.api.practice import PracticeOption, PracticeSession
from quiz_api.openapi_export import render_openapi

ANSWER_KEYS = {
    "correct_option_ids",
    "accepted_answers",
    "explanation",
    "rubric",
    "correct_answer",
    "outcome",
    "result",
}
SESSION_FIELDS = {
    "id",
    "workspace_id",
    "question_id",
    "question_revision_id",
    "question_type",
    "chapter_id",
    "question_number",
    "stem",
    "is_multi_answer",
    "options",
    "displayed_option_ids",
    "state",
    "opened_at",
}


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


def test_session_models_are_an_allowlist() -> None:
    assert set(PracticeSession.model_fields) == SESSION_FIELDS
    assert set(PracticeOption.model_fields) == {"id", "text"}


def test_open_session_response_schema_has_no_answer_fields() -> None:
    spec = json.loads(render_openapi())
    op = spec["paths"]["/api/v1/questions/{question_id}/practice-sessions"]["post"]
    schema = op["responses"]["201"]["content"]["application/json"]["schema"]
    props = _reachable_properties(spec, schema, set())
    assert props, "the 201 response schema is empty"
    assert not props & ANSWER_KEYS


def test_answers_are_only_in_the_submit_result() -> None:
    spec = json.loads(render_openapi())
    submit = spec["paths"]["/api/v1/practice-sessions/{session_id}/submit"]["post"]
    schema = submit["responses"]["200"]["content"]["application/json"]["schema"]
    assert {"correct_option_ids", "explanation", "rubric"} <= _reachable_properties(
        spec, schema, set()
    )
