"""Tables in question stems and option tables (QTABLE-01, questions.md §4 11, §6)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    SourceLocation,
    TableContent,
)
from book_core.extractor import (
    EXTRACT_PROMPT_VERSION,
    LLMOption,
    LLMQuestion,
    QuestionExtractor,
    classify_content,
    llm_requests,
)
from book_core.extractor.extractor import _source_lines
from book_core.extractor.segment import segment_chapters
from book_core.llm import FakeLLMClient
from book_core.question import break_stem_items, split_pipe_blocks

CASES = json.loads((Path(__file__).parents[3] / "tests/fixtures/question-tables.json").read_text())
Rows = tuple[tuple[str, ...], ...]
TABLE: Rows = (("단계", "작용"), ("응집", "결합"), ("침전", "(가) 가라앉힘"))
GFM = "| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 |\n| 침전 | (가) 가라앉힘 |"


def _doc(*items: str | Rows) -> ParsedDocument:
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
                    text="\n".join(" | ".join(r) for r in item),
                    locations=location,
                    table=TableContent(rows=item),
                )
            )
    return ParsedDocument(
        source_path="t.pdf",
        source_sha256="4" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=tuple(blocks),
    )


def _draft(*items: str | Rows):  # type: ignore[no-untyped-def]
    (draft,) = QuestionExtractor().extract(_doc(*items), document_id="t").drafts
    return draft


OPTIONS = ("① 응집", "② 침전")


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_pipe_blocks_match_the_shared_matrix(case: dict[str, object]) -> None:
    assert [list(s) for s in split_pipe_blocks(str(case["stem"]))] == case["segments"]
    normalized = str(case["normalized"])
    assert break_stem_items(str(case["stem"])) == normalized
    assert break_stem_items(normalized) == normalized


def test_a_table_stays_where_it_was_printed() -> None:
    draft = _draft("1. 표를 보고 답하시오.", TABLE, "위 표에서 옳은 것은?", *OPTIONS)
    assert draft.stem == f"표를 보고 답하시오.\n\n{GFM}\n\n위 표에서 옳은 것은?"
    assert [o.text for o in draft.options] == ["응집", "침전"]


def test_two_tables_stay_apart_and_their_labels_are_not_items() -> None:
    other: Rows = (("구분",), ("ㄱ. 갑",), ("ㄴ. 을",))
    draft = _draft("1. 옳은 것은?", TABLE, other, *OPTIONS)
    assert draft.stem == (f"옳은 것은?\n\n{GFM}\n\n| 구분 |\n| --- |\n| ㄱ. 갑 |\n| ㄴ. 을 |")


def test_a_table_after_the_options_is_kept_at_the_end_of_the_stem() -> None:
    draft = _draft("1. 옳은 것은?", *OPTIONS, TABLE)
    assert draft.stem == f"옳은 것은?\n\n{GFM}"
    assert len(draft.options) == 2


def test_table_in_stem_note_is_only_on_questions_with_a_table() -> None:
    (with_table, without) = (
        QuestionExtractor()
        .extract(_doc("1. 옳은 것은?", TABLE, *OPTIONS, "2. 맞는 것은?", *OPTIONS), document_id="t")
        .drafts
    )
    codes = {v.code: v for v in with_table.validations}
    assert codes["table_in_stem"].severity == "warning"
    assert "table_in_stem" not in {v.code for v in without.validations}


def test_an_option_table_is_not_a_stem_table() -> None:
    rows: Rows = (("", "단계", "작용"), ("①", "응집", "결합"), ("②", "침전", "가라앉힘"))
    draft = _draft("1. 옳은 것은?", rows)
    assert draft.stem == "옳은 것은? 단계 | 작용"
    assert [o.text for o in draft.options] == ["응집 | 결합", "침전 | 가라앉힘"]
    assert "table_in_stem" not in {v.code for v in draft.validations}


def test_labels_glued_to_the_cell_with_a_header_row() -> None:
    """The shape of 2024 Q38 (structure only): a header row, then ``①xxx`` beside a text cell."""
    rows: Rows = (
        ("구분", "내용"),
        ("①가나다", "라마바사"),
        ("② 아자차", "카타파하"),
        ("③거너더", "러머버서"),
        ("④어저처", "커터퍼허"),
    )
    draft = _draft("1. 옳은 것은?", rows)
    assert draft.stem == "옳은 것은? 구분 | 내용"
    assert [o.text for o in draft.options] == [
        "가나다 | 라마바사",
        "아자차 | 카타파하",
        "거너더 | 러머버서",
        "어저처 | 커터퍼허",
    ]


def test_labels_in_several_cells_of_one_row() -> None:
    rows: Rows = (("①갑", "② 을"), ("③병", "④ 정"))
    draft = _draft("1. 옳은 것은?", rows)
    assert draft.stem == "옳은 것은?"
    assert [o.text for o in draft.options] == ["갑", "을", "병", "정"]


def test_labels_in_several_cells_read_by_column_go_back_in_label_order() -> None:
    rows: Rows = (("① 갑", "③ 병"), ("② 을", "④ 정"))
    draft = _draft("1. 옳은 것은?", rows)
    assert [(o.id, o.text) for o in draft.options] == [
        ("opt-1", "갑"),
        ("opt-2", "을"),
        ("opt-3", "병"),
        ("opt-4", "정"),
    ]


@pytest.mark.parametrize(
    ("rows", "texts"),
    [
        # A dedicated label column: the cells beside it refer to labels, they open no option.
        (
            (("①", "①, ②", "가"), ("②", "②, ③", "나"), ("③", "③, ④", "다")),
            ["①, ② | 가", "②, ③ | 나", "③, ④ | 다"],
        ),
        (
            (("①", "②", "가"), ("②", "③", "나")),
            ["② | 가", "③ | 나"],
        ),
        # A bare reference that would also read as a gapless run of options.
        (
            (("①", "③ 갑"), ("②", "④ 을")),
            ["③ 갑", "④ 을"],
        ),
        # Labels glued to the first cell of each row.
        (
            (("①갑", "①, ②"), ("②을", "②, ③")),
            ["갑 | ①, ②", "을 | ②, ③"],
        ),
    ],
)
def test_cells_beside_a_label_column_stay_content(rows: Rows, texts: list[str]) -> None:
    draft = _draft("1. 옳은 것은?", rows)
    assert [o.text for o in draft.options] == texts
    assert draft.question_type == "MCQ"
    assert "table_in_stem" not in {v.code for v in draft.validations}


def test_a_label_cell_and_its_text_in_turn_are_several_options() -> None:
    rows: Rows = (("①", "갑", "②", "을"), ("③", "병", "④", "정"))
    draft = _draft("1. 옳은 것은?", rows)
    assert [o.text for o in draft.options] == ["갑", "을", "병", "정"]


@pytest.mark.parametrize(
    "rows",
    [
        # Labels used as content: not from ① and not consecutive.
        (("규정", "내용"), ("③항", "갑"), ("⑤항", "을")),
        # The first cell of a row holds no label.
        (("구분", "① 갑"), ("구분", "② 을")),
        # A single label is no option list.
        (("구분", "내용"), ("①항", "갑")),
    ],
)
def test_a_table_merely_mentioning_labels_goes_to_the_stem(rows: Rows) -> None:
    draft = _draft("1. 옳은 것은?", rows, *OPTIONS)
    assert "| --- |" in draft.stem
    assert [o.text for o in draft.options] == ["응집", "침전"]


def test_source_lines_hold_the_table_in_place() -> None:
    doc = _doc("1. 표를 보고 답하시오.", TABLE, "옳은 것은?", *OPTIONS)
    (raw,) = segment_chapters(doc.blocks).questions
    lines = _source_lines(raw, [])
    assert lines.index(GFM) == lines.index("옳은 것은?") - 1
    assert lines.index(GFM) > 0


def _refined(stem: str) -> set[str]:
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
    (draft,) = QuestionExtractor(client).extract(LLM_DOC, document_id="t").drafts
    assert draft.stem.count("| --- |") == 1
    return {v.code for v in draft.validations}


LLM_DOC = _doc("1. 표를 보고 답하시오.", TABLE, *OPTIONS)


def test_prompt_v4_carries_the_table_and_a_verbatim_rule() -> None:
    assert EXTRACT_PROMPT_VERSION == "questions.extract/v4"
    ((_, request),) = llm_requests(LLM_DOC)
    assert request.prompt_version == "questions.extract/v4"
    assert GFM in request.prompt
    assert "verbatim" in (request.system or "")


def test_a_table_stem_copied_by_the_llm_is_accepted() -> None:
    codes = _refined(f"표를 보고 답하시오.\n\n{GFM}")
    assert "llm_text_rejected" not in codes
    assert "table_in_stem" in codes


def test_a_table_flattened_by_the_llm_is_rejected_even_when_the_letters_match() -> None:
    codes = _refined(f"표를 보고 답하시오. {GFM.replace(chr(10), ' ')}")
    assert "llm_text_rejected" in codes


def test_a_dropped_table_is_rejected() -> None:
    assert "llm_text_rejected" in _refined("표를 보고 답하시오.")


def test_tables_in_stems_do_not_change_the_paper_classification() -> None:
    plain = _doc(
        *(line for n in range(1, 5) for line in (f"{n}. 옳은 것은?", "① 응집", "② 침전")),
        "서론 " * 40,
    )
    with_tables = _doc(
        *(line for n in range(1, 5) for line in (f"{n}. 옳은 것은?", TABLE, "① 응집", "② 침전")),
        "서론 " * 40,
    )
    # A table's cells count in the document's text as before, not as question text.
    assert classify_content(with_tables.blocks).coverage <= classify_content(plain.blocks).coverage
