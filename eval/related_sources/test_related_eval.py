"""Offline checks of the ASK-X related passages evaluation (fake embedder, synthetic fixtures)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import related_eval


def test_the_report_numbers() -> None:
    report = related_eval.run()
    s = report["summary"]
    assert s["cases"] == 9
    # The question's own source block is always in the list, first.
    assert s["source_block_inclusion"] == 1.0
    assert s["own_sources_first"] is True
    assert s["recall_at_5"] == pytest.approx(8 / 11, abs=1e-4)
    assert s["cases_with_every_gold"] == 6
    # The fixture book has four pages and a list has one row per page.
    assert s["rows_per_list"] == 4.0
    assert s["repeated_pages"] == 0


def test_question_papers_question_parts_and_imports_never_reach_the_list() -> None:
    s = related_eval.run()["summary"]
    assert s["excluded_rows"] == {"question_paper": 0, "question_part": 0, "imported_source": 0}
    # The check is not vacuous: without the rules the same queries do reach those passages.
    control = s["control_without_the_rules"]
    assert control["paper_hits"] > 0
    assert control["question_part_hits"] > 0
    assert control["imported_refs_dropped"] == 1


def test_the_report_holds_no_passage_or_question_text() -> None:
    report = related_eval.run()
    text = json.dumps(report, ensure_ascii=False) + related_eval.markdown(report)
    seed = related_eval.load_seed(related_eval.DEFAULT_DATASET)
    for case in seed.cases:
        assert case["stem"] not in text
    for block in seed.truth["blocks"]:
        if block["type"] == "text":
            assert block["text"][:20] not in text
    assert "증발" not in text
