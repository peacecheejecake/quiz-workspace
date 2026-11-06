"""`stem_tables` in the API without a database (UX12-STEMTABLE C04, C05)."""

from __future__ import annotations

from typing import Any

import pytest
from book_core.contracts import QuestionDraft, TableContent, TableSpan
from fastapi import FastAPI
from pydantic import ValidationError
from quiz_api.draft_reextract import changed_fields
from quiz_api.main import create_app
from quiz_api.question_drafts import content_of, recompute_validations, with_review
from quiz_api.question_rules import QuestionContent
from quiz_api.settings import Settings
from quiz_api.stem_tables import (
    StemTableInput,
    edited_stem_tables,
    parse_stem_tables,
    sent_stem_tables,
    stem_tables_out,
)

GFM = "| a | a |\n| --- | --- |\n| 1 | 2 |"
TABLE = TableContent(
    rows=(("a", "a"), ("1", "2")),
    header_rows=1,
    spans=(TableSpan(row=0, col=0, col_span=2),),
)
SENT = StemTableInput(
    rows=[["a", "a"], ["1", "2"]],
    header_rows=1,
    spans=[{"row": 0, "col": 0, "row_span": 1, "col_span": 2}],  # type: ignore[list-item]
)


def _content(stem: str = GFM, tables: tuple[TableContent | None, ...] | None = None) -> Any:
    return QuestionContent(
        question_type="ESSAY",
        stem=stem,
        options=(),
        correct_option_ids=None,
        is_multi_answer=False,
        accepted_answers=None,
        explanation=None,
        rubric=None,
        stem_tables=tables,
    )


def _openapi() -> dict[str, Any]:
    settings = Settings(APP_ENV="test")  # type: ignore[call-arg]
    app: FastAPI = create_app(settings, readiness_checkers=[])
    return app.openapi()


def test_a_grid_that_is_not_rectangular_is_refused() -> None:
    with pytest.raises(ValidationError):
        StemTableInput(rows=[["a", "b"], ["1"]], header_rows=1)


def test_a_span_outside_the_grid_is_refused() -> None:
    with pytest.raises(ValidationError):
        StemTableInput(
            rows=[["a"]],
            header_rows=0,
            spans=[{"row": 0, "col": 0, "row_span": 2, "col_span": 1}],  # type: ignore[list-item]
        )


def test_sent_cells_that_do_not_line_up_are_dropped_not_refused() -> None:
    assert sent_stem_tables(GFM, [SENT]) == (TABLE,)
    assert sent_stem_tables(GFM.replace("1", "9"), [SENT]) is None
    assert sent_stem_tables("표가 없다", [SENT]) is None


def test_an_edit_that_omits_the_field_keeps_cells_that_still_fit() -> None:
    kept = edited_stem_tables(f"앞 문장\n\n{GFM}", sent=False, tables=None, stored=(TABLE,))
    assert kept == (TABLE,)


def test_an_edit_that_changes_the_block_without_the_field_falls_back_to_gfm() -> None:
    stem = GFM.replace("1", "9")
    assert edited_stem_tables(stem, sent=False, tables=None, stored=(TABLE,)) is None


def test_an_edit_sending_null_clears_the_cells() -> None:
    assert edited_stem_tables(GFM, sent=True, tables=None, stored=(TABLE,)) is None


def test_stored_values_round_trip_and_null_stays_null() -> None:
    stored = [TABLE.model_dump(mode="json"), None]
    assert parse_stem_tables(stored) == (TABLE, None)
    out = stem_tables_out(stored)
    assert out is not None and out[0] is not None and out[1] is None
    assert out[0].spans is not None and out[0].spans[0].col_span == 2
    assert stem_tables_out(None) is None and parse_stem_tables(None) is None


def test_a_draft_edit_writes_the_cells_into_the_payload() -> None:
    draft = QuestionDraft.model_validate(
        {
            "id": "d1",
            "origin": "pdf_import",
            "question_type": "ESSAY",
            "stem": "문제",
        }
    )
    content = _content(tables=(TABLE,))
    updated = with_review(draft, content, recompute_validations(content, draft), "pending")
    assert updated.stem == GFM and updated.stem_tables == (TABLE,)
    assert content_of(updated, is_multi_answer=False).stem_tables == (TABLE,)


def test_a_reextraction_reports_new_merged_cells_on_the_same_stem() -> None:
    changed = changed_fields(_content(tables=(TABLE,)), "ESSAY", GFM, [], None, None, None, None)
    assert changed == ["table"]


def test_cells_without_merges_are_no_change() -> None:
    plain = TableContent(rows=TABLE.rows, header_rows=1)
    assert changed_fields(_content(tables=(plain,)), "ESSAY", GFM, [], None, None, None, None) == []


def test_a_changed_stem_is_reported_once() -> None:
    changed = changed_fields(_content("다른 문제"), "ESSAY", GFM, [], None, None, None, (TABLE,))
    assert changed == ["stem"]


READ_MODELS = (
    "PracticeSession",
    "PracticeSessionDetail",
    "MockPracticeSession",
    "MockExamQuestion",
    "QuestionRevision",
    "QuestionPreview",
    "RunItem",
    "RetrySession",
    "DraftPayload",
)


@pytest.mark.parametrize("name", READ_MODELS)
def test_the_field_sits_beside_the_stem_in_read_models(name: str) -> None:
    properties = _openapi()["components"]["schemas"][name]["properties"]
    assert "stem" in properties and "stem_tables" in properties


def test_the_field_is_never_where_the_stem_is_absent() -> None:
    schemas = _openapi()["components"]["schemas"]
    without = [
        name
        for name, schema in schemas.items()
        if "stem_tables" in schema.get("properties", {})
        and "stem" not in schema.get("properties", {})
    ]
    assert without == []
