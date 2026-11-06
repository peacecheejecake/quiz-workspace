"""Structured cells beside the GFM tables of a stem (UX12-STEMTABLE, questions.md §4 11)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    QuestionDraft,
    SourceLocation,
    TableContent,
    TableSpan,
)
from book_core.extractor import LLMOption, LLMQuestion, QuestionExtractor
from book_core.llm import FakeLLMClient
from book_core.question import (
    MAX_STEM_TABLES,
    aligned_stem_tables,
    gfm_table,
    stem_table_spans,
    variant_stem_tables,
)

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parents[3] / "tests/fixtures/stem-table-alignment.json").read_text()
)

MERGED = TableContent(
    rows=(("구분", "구분", "값"), ("A", "x", "1"), ("A", "y", "2")),
    header_rows=1,
    spans=(TableSpan(row=0, col=0, col_span=2), TableSpan(row=1, col=0, row_span=2)),
)
GFM = "| 구분 | 구분 | 값 |\n| --- | --- | --- |\n| A | x | 1 |\n| A | y | 2 |"
PLAIN = TableContent(rows=(("a", "b"), ("1", "2")), header_rows=1)
PLAIN_GFM = "| a | b |\n| --- | --- |\n| 1 | 2 |"
OPTIONS = ("① 응집", "② 침전")


def _doc(*items: str | TableContent) -> ParsedDocument:
    blocks = []
    for i, item in enumerate(items):
        location = (
            SourceLocation(page=1, bbox=BBox(x0=60, y0=40 + 20 * i, x1=500, y1=55 + 20 * i)),
        )
        if isinstance(item, str):
            blocks.append(Block(id=f"b{i}", type=BlockType.TEXT, text=item, locations=location))
        else:
            blocks.append(
                Block(
                    id=f"b{i}",
                    type=BlockType.TABLE,
                    text="\n".join(" | ".join(r) for r in item.rows),
                    locations=location,
                    table=item,
                )
            )
    return ParsedDocument(
        source_path="t.pdf",
        source_sha256="4" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=tuple(blocks),
    )


def _extract(*items: str | TableContent, llm: FakeLLMClient | None = None) -> QuestionDraft:
    (draft,) = QuestionExtractor(llm).extract(_doc(*items), document_id="t").drafts
    return draft


def _refined(stem: str) -> QuestionDraft:
    client = FakeLLMClient()
    client.script(
        "questions.extract",
        LLMQuestion(
            question_type="MCQ",
            multi_select=False,
            stem=stem,
            options=[LLMOption(label="①", text="응집"), LLMOption(label="②", text="침전")],
            answer=None,
        ),
    )
    return _extract("1. 표를 보고 답하시오.", MERGED, *OPTIONS, llm=client)


def test_gfm_table_repeats_merged_text_as_the_stem_stores_it() -> None:
    assert gfm_table(MERGED) == GFM


def test_aligned_keeps_an_entry_per_pipe_block() -> None:
    stem = f"옳은 것은?\n\n{GFM}\n\n사이 문장\n\n{PLAIN_GFM}"
    assert aligned_stem_tables(stem, (MERGED, PLAIN)) == (MERGED, PLAIN)


def test_a_count_mismatch_drops_everything() -> None:
    assert aligned_stem_tables(f"{GFM}\n\n{PLAIN_GFM}", (MERGED,)) is None
    assert aligned_stem_tables("표가 없다", (MERGED,)) is None


def test_null_and_empty_inputs_stay_null() -> None:
    assert aligned_stem_tables(GFM, None) is None
    assert aligned_stem_tables(GFM, ()) is None


def test_too_many_entries_stay_gfm() -> None:
    stem = "\n\n".join([PLAIN_GFM] * (MAX_STEM_TABLES + 1))
    assert aligned_stem_tables(stem, (PLAIN,) * (MAX_STEM_TABLES + 1)) is None


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_alignment_cases(case: dict[str, Any]) -> None:
    """The same cases as `alignedStemTables` in apps/web (apps/web/test/stem-table-edit.test.ts)."""
    tables = tuple(
        TableContent.model_validate(t) if t is not None else None for t in case["tables"]
    )
    got = aligned_stem_tables(case["stem"], tables)
    assert [t is not None for t in got or ()] == case["kept"]


def test_stem_table_spans_treats_no_entry_like_no_spans() -> None:
    assert stem_table_spans(None) == stem_table_spans((PLAIN,))
    assert stem_table_spans((MERGED,)) != stem_table_spans(None)


def test_variant_keeps_the_cells_only_with_the_same_stem() -> None:
    assert variant_stem_tables(GFM, GFM, (MERGED,)) == (MERGED,)
    assert variant_stem_tables(f"바꿔 쓴 문장\n\n{GFM}", GFM, (MERGED,)) is None


def test_a_payload_without_the_field_still_loads() -> None:
    draft = _extract("1. 옳은 것은?", *OPTIONS)
    payload = draft.model_dump(mode="json")
    del payload["stem_tables"]
    assert QuestionDraft.model_validate(payload).stem_tables is None


def test_extractor_fills_the_cells_beside_the_gfm() -> None:
    draft = _extract("1. 옳은 것은?", MERGED, *OPTIONS)
    assert GFM in draft.stem
    assert draft.stem_tables == (MERGED,)
    assert QuestionDraft.model_validate(draft.model_dump(mode="json")).stem_tables == (MERGED,)


def test_two_tables_stay_in_stem_order() -> None:
    draft = _extract("1. 옳은 것은?", MERGED, "그리고", PLAIN, *OPTIONS)
    assert draft.stem_tables == (MERGED, PLAIN)


def test_option_tables_put_nothing_in_the_cells() -> None:
    table = TableContent(rows=(("①", "응집"), ("②", "침전")))
    assert _extract("1. 옳은 것은?", table).stem_tables is None


def test_refine_copying_the_table_keeps_the_cells() -> None:
    draft = _refined(f"표를 보고 답하시오.\n\n{GFM}")
    assert "llm_text_rejected" not in {v.code for v in draft.validations}
    assert draft.stem_tables == (MERGED,)


def test_a_table_rewritten_by_refine_never_pairs_with_the_old_cells() -> None:
    draft = _refined(f"표를 보고 답하시오.\n\n{GFM.replace('x', 'q')}")
    assert "llm_text_rejected" in {v.code for v in draft.validations}
    assert aligned_stem_tables(draft.stem, draft.stem_tables) == draft.stem_tables
    assert "| A | x | 1 |" in draft.stem
