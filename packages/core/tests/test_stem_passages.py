"""Stem passages (questions.md §4 12, UX12-PASSAGE): the extractor's line shape of ``<제목>``
blocks. ``apps/web/test/stem-passages.test.tsx`` reads the same fixture."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from book_core.extractor.llm_refine import EXTRACT_PROMPT_VERSION, SYSTEM_PROMPT, build_request
from book_core.extractor.segment import RawQuestion
from book_core.question import break_stem_items

CASES = json.loads((Path(__file__).parents[3] / "tests/fixtures/stem-passages.json").read_text())
TABLE = "| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 |"


@pytest.mark.parametrize("case", CASES, ids=[str(case["name"]) for case in CASES])
def test_passages_match_the_shared_matrix(case: dict[str, str]) -> None:
    assert break_stem_items(case["stem"]) == case["normalized"]
    assert break_stem_items(case["normalized"]) == case["normalized"]


def test_passages_on_each_side_of_a_table() -> None:
    stem = f"옳은 것은? <자료 A> ∙갑 : 하나 ∙을 : 둘\n\n{TABLE}\n\n<자료 B> ∙병 : 셋 ∙정 : 넷"
    expected = (
        f"옳은 것은?\n\n<자료 A>\n∙갑 : 하나\n∙을 : 둘\n\n{TABLE}\n\n<자료 B>\n∙병 : 셋\n∙정 : 넷"
    )
    assert break_stem_items(stem) == expected
    assert break_stem_items(expected) == expected


def test_a_passage_wrapped_over_printed_lines_gets_the_same_shape() -> None:
    parts = ["옳은 것은?", "<자료>", "∙갑 : 하나", "∙을 : 둘", "(가) 병", "(나) 정"]
    question = RawQuestion(number=1, stem_lines=[], stem_parts=parts)
    assert question.stem == "옳은 것은?\n\n<자료>\n∙갑 : 하나\n∙을 : 둘\n\n(가) 병\n(나) 정"


def test_the_refine_prompt_keeps_the_passage_shape() -> None:
    assert EXTRACT_PROMPT_VERSION == "questions.extract/v5"
    assert build_request(["옳은 것은?"], []).prompt_version == "questions.extract/v5"
    assert '"<제목>"' in SYSTEM_PROMPT
