"""FIGTBL-1: printed figure text reaches the stem and the model; merged table cells print once."""

from __future__ import annotations

from book_core.chunker import chunk_revision  # noqa: F401  (import check of the public API)
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
from book_core.extractor import LLMOption, LLMQuestion, QuestionExtractor, llm_requests
from book_core.llm import FakeLLMClient
from book_core.structure import build_revision  # noqa: F401

FIGURE = "A\n(70 y, spouse of B)\nB\nB"
MERGED = TableContent(
    rows=(("- payee: Kim", "- payee: Kim", "- payee: Kim"), ("a", "b", "c")),
    header_rows=0,
    spans=(TableSpan(row=0, col=0, col_span=3),),
)
ONCE_GFM = "| - payee: Kim |  |  |\n| --- | --- | --- |\n| a | b | c |"
REPEATED_GFM = "| - payee: Kim | - payee: Kim | - payee: Kim |\n| --- | --- | --- |\n| a | b | c |"
OPTIONS = ("① 응집", "② 침전")


def _doc(*items: str | TableContent | tuple[str, str]) -> ParsedDocument:
    """Text, a table, or ``("image", text)`` blocks in reading order."""
    blocks = []
    for i, item in enumerate(items):
        where = (SourceLocation(page=1, bbox=BBox(x0=60, y0=40 + 20 * i, x1=500, y1=55 + 20 * i)),)
        if isinstance(item, str):
            blocks.append(Block(id=f"b{i}", type=BlockType.TEXT, text=item, locations=where))
        elif isinstance(item, TableContent):
            text = "\n".join(" | ".join(r) for r in item.rows_once())
            blocks.append(
                Block(id=f"b{i}", type=BlockType.TABLE, text=text, locations=where, table=item)
            )
        else:
            blocks.append(Block(id=f"b{i}", type=BlockType.IMAGE, text=item[1], locations=where))
    return ParsedDocument(
        source_path="t.pdf",
        source_sha256="5" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=tuple(blocks),
    )


def _client(stem: str) -> FakeLLMClient:
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
    return client


def _extract(doc: ParsedDocument, client: FakeLLMClient | None = None) -> QuestionDraft:
    (draft,) = QuestionExtractor(client).extract(doc, document_id="t").drafts
    return draft


def _codes(draft: QuestionDraft) -> set[str]:
    return {v.code for v in draft.validations}


FIGURE_DOC = ("1. 가계도를 보고 답하시오.", ("image", FIGURE), *OPTIONS)


def test_figure_text_follows_the_referring_sentence_in_the_stem() -> None:
    draft = _extract(_doc(*FIGURE_DOC))
    assert draft.stem == f"가계도를 보고 답하시오.\n{FIGURE}"
    assert [o.text for o in draft.options] == ["응집", "침전"]


def test_the_model_sees_a_figure_marker_then_the_figure_lines() -> None:
    ((_, request),) = llm_requests(_doc(*FIGURE_DOC))
    printed = request.prompt.split("<<<\n")[1].split("\n>>>")[0].split("\n")
    assert printed[:6] == [
        "1. 가계도를 보고 답하시오.",
        "[그림]",
        "A",
        "(70 y, spouse of B)",
        "B",
        "B",
    ]
    assert printed[6:] == ["① 응집", "② 침전"]


def test_a_model_stem_with_the_figure_lines_is_accepted() -> None:
    client = _client(f"가계도를 보고 답하시오.\n{FIGURE}")
    draft = _extract(_doc(*FIGURE_DOC), client)
    assert "llm_text_rejected" not in _codes(draft)
    assert draft.stem == f"가계도를 보고 답하시오.\n{FIGURE}"


def test_a_model_stem_that_drops_the_figure_lines_is_rejected() -> None:
    draft = _extract(_doc(*FIGURE_DOC), _client("가계도를 보고 답하시오."))
    assert "llm_text_rejected" in _codes(draft)
    assert FIGURE in draft.stem


def test_an_image_without_text_adds_nothing() -> None:
    draft = _extract(_doc("1. 그림을 보고 답하시오.", ("image", ""), *OPTIONS))
    assert draft.stem == "그림을 보고 답하시오."
    ((_, request),) = llm_requests(_doc("1. 그림을 보고 답하시오.", ("image", ""), *OPTIONS))
    assert "[그림]" not in request.prompt


def test_the_model_sees_a_merged_cell_once_and_the_stem_keeps_the_repeated_table() -> None:
    doc = _doc("1. 표를 보고 답하시오.", MERGED, *OPTIONS)
    ((_, request),) = llm_requests(doc)
    assert ONCE_GFM in request.prompt
    assert REPEATED_GFM not in request.prompt
    draft = _extract(doc, _client(f"표를 보고 답하시오.\n\n{ONCE_GFM}"))
    assert "llm_text_rejected" not in _codes(draft)
    assert REPEATED_GFM in draft.stem
    assert draft.stem_tables == (MERGED,)


def test_a_table_without_merged_cells_reaches_the_model_unchanged() -> None:
    plain = TableContent(rows=(("a", "b"), ("1", "2")), header_rows=1)
    ((_, request),) = llm_requests(_doc("1. 표를 보고 답하시오.", plain, *OPTIONS))
    assert "| a | b |\n| --- | --- |\n| 1 | 2 |" in request.prompt


def test_a_labelled_shared_figure_adds_its_text_after_the_referring_sentence() -> None:
    shared = ("image", "Plant A\nPlant B")
    doc = _doc(
        shared, "[그림 3] 배치도", "1. [그림 3]의 A 단계를 쓰시오.", "2. 다른 문제를 쓰시오."
    )
    first = _extract_all(doc)[0]
    assert first.stem == "[그림 3]의 A 단계를 쓰시오.\nPlant A\nPlant B"
    assert _extract_all(doc)[1].stem == "다른 문제를 쓰시오."
    request = llm_requests(doc)[0][1]
    assert "[그림]\nPlant A\nPlant B" in request.prompt


def _extract_all(doc: ParsedDocument) -> list[QuestionDraft]:
    return list(QuestionExtractor(None).extract(doc, document_id="t").drafts)
