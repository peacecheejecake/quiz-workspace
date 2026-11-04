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
    # QVIEW-B run link
    "practice_run_id",
    "run_position",
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


PRACTICE_OPERATIONS = (
    ("/api/v1/questions/{question_id}/practice-sessions", "post"),
    ("/api/v1/practice-sessions/{session_id}", "get"),
    ("/api/v1/practice-sessions/{session_id}/submit", "post"),
    ("/api/v1/practice-sessions/{session_id}/self-grade", "post"),
    ("/api/v1/practice-runs/{run_id}/items/{position}", "get"),
    ("/api/v1/mock-exam-questions/{mock_exam_question_id}/practice-sessions", "post"),
    ("/api/v1/mock-practice-sessions/{mock_practice_session_id}/submit", "post"),
    ("/api/v1/mock-practice-sessions/{mock_practice_session_id}/self-grade", "post"),
)
HIGHLIGHT_KEYS = {"quote", "anchor", "anchor_current", "anchor_status"}


def test_qview_01_c09_hilite_01_c07_practice_response_schemas_have_no_highlight_fields() -> None:
    """QVIEW-01-C09 / HILITE-01-C07: highlights are loaded separately after submission; no
    practice response (bank session, run item, mock exam session) can carry them."""
    spec = json.loads(render_openapi())
    for path, method in PRACTICE_OPERATIONS:
        op = spec["paths"][path][method]
        for code, response in op["responses"].items():
            if not code.startswith("2"):
                continue
            for media in response.get("content", {}).values():
                props = _reachable_properties(spec, media["schema"], set())
                assert props, f"{method} {path} {code}: empty schema"
                leaked = {p for p in props if "highlight" in p.lower()} | (props & HIGHLIGHT_KEYS)
                assert not leaked, f"{method} {path} {code}: {leaked}"
