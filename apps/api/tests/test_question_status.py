"""quiz_api.question_status against the truth table shared with packages/ui (TS parity)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from quiz_api.question_status import DOT_STATUSES, StudyState, derive_dot_status, summarize

TABLE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts" / "question-status.truth.json").read_text(
        encoding="utf-8"
    )
)


def test_table_covers_every_input_combination() -> None:
    states = {tuple(sorted(row["state"].items())) for row in TABLE["derive"]}
    assert len(states) == len(TABLE["derive"]) == 24


@pytest.mark.parametrize("row", TABLE["derive"])
def test_derive_dot_status_matches_the_shared_table(row: dict[str, Any]) -> None:
    assert derive_dot_status(StudyState(**row["state"])) == row["status"]


@pytest.mark.parametrize("case", TABLE["summarize"], ids=lambda c: c["name"])
def test_summarize_matches_the_shared_table(case: dict[str, Any]) -> None:
    items = [(i["status"], i["is_favorite"]) for i in case["items"]]
    assert summarize(items) == case["counts"]


def test_favorite_never_changes_the_status() -> None:
    for row in TABLE["derive"]:
        flipped = {**row["state"], "is_favorite": not row["state"]["is_favorite"]}
        assert derive_dot_status(StudyState(**flipped)) == row["status"]


def test_status_counts_are_mutually_exclusive() -> None:
    items = [(s, i % 2 == 0) for i, s in enumerate(DOT_STATUSES * 3)]
    counts = summarize(items)
    assert sum(counts[s] for s in DOT_STATUSES) == counts["total"] == 15
    assert counts["favorite"] == 8
