"""Chapter note rules without a database (CHNOTE-B): fingerprint, labels, footnote numbering and
links, generation status, and the contract shapes (shared responses never carry member-only
fields; practice responses never carry note fields)."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from quiz_api.api.chapter_notes import generation_out
from quiz_api.chapter_notes import (
    Ref,
    input_fingerprint,
    parse_refs,
    present_body,
    question_label,
    stem_preview,
)
from quiz_api.main import create_app
from quiz_api.repositories.chapter_notes import NoteRow
from quiz_api.settings import Environment, Settings

Q = [uuid.UUID(int=i + 1) for i in range(4)]
R = [uuid.UUID(int=100 + i) for i in range(4)]


def test_fingerprint_matches_the_sql_function_value() -> None:
    # supabase/tests/19_chapter_notes.test.sql asserts the SQL function gives the same digest.
    refs = [
        ("20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000002"),
        ("20000000-0000-4000-8000-00000000000a", "30000000-0000-4000-8000-00000000000a"),
        ("20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"),
    ]
    assert (
        input_fingerprint(refs, "a" * 64)
        == "539b6a1e30e3dc0b1025c8d951e5dd969bf124ebcdb5feb216e7cf18a34a47cc"
    )


def test_fingerprint_is_order_independent_and_sensitive_to_every_input() -> None:
    body = "b" * 64
    base = input_fingerprint([(Q[0], R[0]), (Q[1], R[1])], body)
    assert re.fullmatch(r"[0-9a-f]{64}", base)
    assert base == input_fingerprint([(Q[1], R[1]), (Q[0], R[0])], body)
    assert base != input_fingerprint([(Q[0], R[0]), (Q[1], R[2])], body), "revision change"
    assert base != input_fingerprint([(Q[0], R[0])], body), "removed"
    assert base != input_fingerprint([(Q[0], R[0]), (Q[1], R[1]), (Q[2], R[2])], body), "added"
    assert base != input_fingerprint([(Q[0], R[0]), (Q[1], R[1])], "c" * 64), "text changed"
    empty = hashlib.sha256(("\n" + body).encode()).hexdigest()
    assert input_fingerprint([], body) == empty


def test_labels_follow_the_heatmap_numbering() -> None:
    assert question_label(3, "3장 물", 12, 1) == "3장 12번"
    assert question_label(1, "Chapter 1", None, 4) == "1장 4번"
    assert question_label(None, "부록", 2, 1) == "부록 2번"


def test_stem_preview_is_forty_characters_of_collapsed_text() -> None:
    assert stem_preview("  가나다\n라마바  ") == "가나다 라마바"
    assert len(stem_preview("가" * 100)) == 40


def _refs() -> list[Ref]:
    return [Ref(f"Q{i + 1}", Q[i], R[i], f"1장 {i + 1}번") for i in range(3)]


def test_footnotes_are_numbered_by_first_citation_and_link_only_live_questions() -> None:
    body = {
        "sections": [
            {
                "heading": "A",
                "items": [{"text": "x", "tags": ["Q2"]}, {"text": "y", "tags": ["Q1", "Q2"]}],
            },
            {
                "heading": "B",
                "items": [{"text": "z", "tags": ["Q3", "Q99"]}, {"text": "w", "tags": ["Q99"]}],
            },
            {"heading": "C", "items": [{"text": "only unknown", "tags": ["Q42"]}]},
        ]
    }
    linkable = {Q[0]: "첫 문제 발문", Q[1]: "둘째 문제 발문"}  # Q3 was deleted
    sections, footnotes = present_body(body, _refs(), linkable)
    assert [s.heading for s in sections] == ["A", "B"], "a section without cited items is left out"
    assert [(i.text, i.footnotes) for i in sections[0].items] == [("x", [1]), ("y", [2, 1])]
    assert [(i.text, i.footnotes) for i in sections[1].items] == [("z", [3])]
    assert [(f.number, f.question_id, f.label, f.stem_preview) for f in footnotes] == [
        (1, Q[1], "1장 2번", "둘째 문제 발문"),
        (2, Q[0], "1장 1번", "첫 문제 발문"),
        (3, None, "1장 3번", None),
    ]


def test_parse_refs_skips_malformed_entries() -> None:
    raw = [
        {"tag": "Q1", "question_id": str(Q[0]), "question_revision_id": str(R[0]), "label": "x"},
        {"tag": "Q2", "question_id": "nope", "question_revision_id": str(R[1])},
        {"tag": "Q3"},
    ]
    assert [r.tag for r in parse_refs(raw)] == ["Q1"]
    assert parse_refs(None) == []


def _row(status: str, job_status: str | None, **kw: Any) -> NoteRow:
    now = datetime(2026, 10, 29, tzinfo=UTC)
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "workspace_id": uuid.uuid4(),
        "document_id": uuid.uuid4(),
        "section_key": "ch1",
        "version": None,
        "status": status,
        "job_id": uuid.uuid4(),
        "job_status": job_status,
        "job_error": None,
        "input_fingerprint": "0" * 64,
        "refs": _refs(),
        "body": None,
        "usage": None,
        "error_code": None,
        "batches_total": None,
        "batches_done": None,
        "created_at": now,
        "finished_at": None,
        "superseded_at": None,
    }
    values.update(kw)
    return NoteRow(**values)


def test_generation_status_and_error_codes() -> None:
    running = generation_out(_row("running", "running", batches_total=3, batches_done=1))
    assert (running.status, running.error_code) == ("running", None)
    assert running.progress is not None
    assert running.progress.batches_total == 3
    failed = generation_out(_row("failed", "failed", error_code="note_citation_invalid"))
    assert (failed.status, failed.error_code) == ("failed", "note_citation_invalid")
    lost = generation_out(_row("queued", "failed", job_error="llm_timeout: the provider timed out"))
    assert (lost.status, lost.error_code) == ("failed", "llm_timeout")
    cancelled = generation_out(_row("running", "cancelled"))
    assert (cancelled.status, cancelled.error_code) == ("failed", "cancelled")
    assert generation_out(_row("queued", "queued")).progress is None


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    app = create_app(Settings(APP_ENV="test"), readiness_checkers=[])  # type: ignore[call-arg]
    out: dict[str, Any] = app.openapi()
    return out


def _schema_keys(spec: dict[str, Any], name: str, seen: set[str] | None = None) -> set[str]:
    seen = seen if seen is not None else set()
    if name in seen:
        return set()
    seen.add(name)
    schema = spec["components"]["schemas"][name]
    keys = set(schema.get("properties", {}))
    for ref in re.findall(r'"\$ref": "#/components/schemas/([^"]+)"', json.dumps(schema)):
        keys |= _schema_keys(spec, ref, seen)
    return keys


def test_the_shared_note_never_exposes_member_only_fields(spec: dict[str, Any]) -> None:
    keys = _schema_keys(spec, "SharedChapterNote") | _schema_keys(spec, "SharedChapterNoteList")
    for member_only in (
        "versions",
        "generation",
        "usage",
        "input_fingerprint",
        "question_refs",
        "question_revision_id",
        "error_code",
        "job_id",
    ):
        assert member_only not in keys, member_only


def test_practice_responses_carry_no_note_fields(spec: dict[str, Any]) -> None:
    for path, methods in spec["paths"].items():
        if "practice-sessions" not in path:
            continue
        for op in methods.values():
            for response in op.get("responses", {}).values():
                refs = re.findall(r'"\$ref": "#/components/schemas/([^"]+)"', json.dumps(response))
                for ref in refs:
                    keys = _schema_keys(spec, ref)
                    assert not [k for k in keys if re.search("note|footnote", k, re.I)], path


def test_note_routes_are_in_the_contract(spec: dict[str, Any]) -> None:
    ops = {op["operationId"] for methods in spec["paths"].values() for op in methods.values()}
    assert {
        "listChapterNotes",
        "getChapterNote",
        "createChapterNote",
        "listSharedChapterNotes",
        "getSharedChapterNote",
    } <= ops


@pytest.mark.parametrize(
    ("app_env", "switch", "model", "available"),
    [
        ("test", False, None, False),
        ("test", True, None, True),
        ("local", True, None, False),
        ("local", True, "  ", False),
        ("local", True, "model-a", True),
        ("local", False, "model-a", False),
        ("production", True, "model-a", True),
        ("production", True, None, False),
    ],
)
def test_notes_are_available_only_with_the_switch_and_a_provider(
    app_env: str, switch: bool, model: str | None, available: bool
) -> None:
    settings = Settings.model_construct(
        app_env=Environment(app_env), chapter_notes=switch, llm_model=model
    )
    assert settings.chapter_notes_available is available


def test_settings_read_the_switch_and_model_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKER_CHAPTER_NOTES", "true")
    monkeypatch.setenv("LLM_MODEL", "model-a")
    settings = Settings(_env_file=None, APP_ENV="local")  # type: ignore[call-arg]
    assert (settings.chapter_notes, settings.llm_model) == (True, "model-a")
    assert settings.chapter_notes_available
