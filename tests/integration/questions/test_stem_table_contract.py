"""UX12-STEMTABLE C03-C05: structured stem cells on the question write and read paths.

The stem stays the source; cells that do not line up with it are dropped, not refused. Mock exam
paths are in mock_exams/test_mock_exams_contract.py, Fork in supabase/tests/33_stem_tables.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

pytestmark = pytest.mark.infra

GFM = "| 구분 | 구분 | 값 |\n| --- | --- | --- |\n| A | x | 1 |\n| A | y | 2 |"
TABLE = {
    "rows": [["구분", "구분", "값"], ["A", "x", "1"], ["A", "y", "2"]],
    "header_rows": 1,
    "spans": [
        {"row": 0, "col": 0, "row_span": 1, "col_span": 2},
        {"row": 1, "col": 0, "row_span": 2, "col_span": 1},
    ],
}


def _create(seed: Any, client: Any, ws: str) -> dict[str, Any]:
    body = seed.mcq(f"표를 보시오 [{uuid.uuid4().hex[:8]}]\n\n{GFM}", ["가", "나"], 0)
    out: dict[str, Any] = client.create_question(ws, {**body, "stem_tables": [TABLE]})
    return out


def test_ux12_stemtable_c04_create_and_edit_keep_cells_that_line_up(seed: Any) -> None:
    alice = seed.client("stemtable-c04")
    ws = alice.create_workspace()["id"]
    question = _create(seed, alice, ws)
    revision = question["revision"]
    assert revision["stem_tables"] == [TABLE]

    # An edit that leaves the block alone keeps the cells without sending them.
    edited = alice.ok(
        "PATCH",
        f"/questions/{question['id']}",
        {"base_revision_id": revision["id"], "stem": f"앞 문장\n\n{GFM}"},
    )
    assert edited["revision"]["version"] == 2
    assert edited["revision"]["stem_tables"] == [TABLE]

    # A hand edit of the block falls back to GFM: no guess, no error.
    changed = alice.ok(
        "PATCH",
        f"/questions/{question['id']}",
        {
            "base_revision_id": edited["revision"]["id"],
            "stem": GFM.replace("| A | y | 2 |", "| B | y | 2 |"),
        },
    )
    assert changed["revision"]["stem_tables"] is None


def test_ux12_stemtable_c04_cells_sent_with_another_stem_are_dropped(seed: Any) -> None:
    alice = seed.client("stemtable-c04-drop")
    ws = alice.create_workspace()["id"]
    body = seed.mcq(f"표 없음 [{uuid.uuid4().hex[:8]}]", ["가", "나"], 0)
    saved = alice.create_question(ws, {**body, "stem_tables": [TABLE]})
    assert saved["revision"]["stem_tables"] is None


def test_ux12_stemtable_c04_a_broken_grid_is_refused(seed: Any) -> None:
    alice = seed.client("stemtable-c04-grid")
    ws = alice.create_workspace()["id"]
    body = seed.mcq(f"표 [{uuid.uuid4().hex[:8]}]", ["가", "나"], 0)
    broken = {**TABLE, "rows": [["a", "b"], ["c"]]}
    res = alice.call("POST", f"/workspaces/{ws}/questions", {**body, "stem_tables": [broken]})
    assert res.status_code == 422


def test_ux12_stemtable_c05_practice_and_preview_carry_the_cells_without_answers(
    seed: Any,
) -> None:
    alice = seed.client("stemtable-c05")
    ws = alice.create_workspace()["id"]
    question = _create(seed, alice, ws)
    session = alice.ok("POST", f"/questions/{question['id']}/practice-sessions", {}, (200, 201))
    assert session["stem_tables"] == [TABLE]
    assert "correct_option_ids" not in session
    preview = alice.ok("GET", f"/questions/{question['id']}/preview")
    assert preview["stem_tables"] == [TABLE]
    assert "correct_option_ids" not in preview
