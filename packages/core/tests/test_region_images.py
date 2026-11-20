"""FIGTBL-2: printed table / figure crops go with the refine request; corrected cells survive."""

from __future__ import annotations

import base64

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
from book_core.extractor import MAX_IMAGE_EDGE, LLMOption, LLMQuestion, QuestionExtractor
from book_core.llm import FakeLLMClient

OPTIONS = ("① 응집", "② 침전")
PRINTED = (("구분", "가", "나"), ("갑", "재산", ""), ("을", "부채", "x"))
MERGED = TableContent(
    rows=(("Kim", "Kim", "Kim"), ("a", "b", "c")),
    spans=(TableSpan(row=0, col=0, col_span=3),),
)


def _gfm(rows: tuple[tuple[str, ...], ...]) -> str:
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * len(rows[0])]
    return "\n".join(lines + ["| " + " | ".join(r) + " |" for r in rows[1:]])


def _doc(*items: str | TableContent | tuple[str, str]) -> ParsedDocument:
    blocks = []
    for i, item in enumerate(items):
        where = (SourceLocation(page=2, bbox=BBox(x0=60, y0=40 + 20 * i, x1=500, y1=55 + 20 * i)),)
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
        source_sha256="6" * 64,
        parser_version="test",
        pages=(PageInfo(page=2, width=595.0, height=842.0),),
        blocks=tuple(blocks),
    )


class _Renderer:
    def __init__(self) -> None:
        self.calls: list[tuple[int, BBox, int]] = []

    def __call__(self, page: int, bbox: BBox, *, max_edge: int) -> bytes | None:
        self.calls.append((page, bbox, max_edge))
        return b"PNG" + bytes([len(self.calls)])


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


def _run(
    doc: ParsedDocument, stem: str, renderer: _Renderer | None = None
) -> tuple[QuestionDraft, FakeLLMClient]:
    client = _client(stem)
    extraction = QuestionExtractor(client).extract(doc, document_id="t", region_renderer=renderer)
    (draft,) = extraction.drafts
    return draft, client


def _codes(draft: QuestionDraft) -> set[str]:
    return {v.code for v in draft.validations}


TABLE_DOC = ("1. 표를 보고 답하시오.", TableContent(rows=PRINTED), *OPTIONS)


def test_a_table_question_sends_a_padded_crop_and_a_figure_question_its_figure() -> None:
    renderer = _Renderer()
    _, client = _run(_doc(*TABLE_DOC), f"표를 보고 답하시오.\n\n{_gfm(PRINTED)}", renderer)
    ((page, box, edge),) = renderer.calls
    assert (page, edge) == (2, MAX_IMAGE_EDGE)
    assert box.x0 < 60 < 500 < box.x1
    assert box.y0 < 60 < 75 < box.y1
    (image,) = client.calls[0].images
    assert base64.b64decode(image.data) == b"PNG\x01"
    assert image.media_type == "image/png"

    figure = _Renderer()
    _, client = _run(
        _doc("1. 가계도를 보고 답하시오.", ("image", "A\nB"), *OPTIONS),
        "가계도를 보고 답하시오.\nA\nB",
        figure,
    )
    assert len(figure.calls) == 1
    assert len(client.calls[0].images) == 1


def test_no_renderer_or_nothing_printed_means_no_images_and_no_calls() -> None:
    _, client = _run(_doc(*TABLE_DOC), f"표를 보고 답하시오.\n\n{_gfm(PRINTED)}")
    assert client.calls[0].images == ()
    renderer = _Renderer()
    _, client = _run(_doc("1. 옳은 것은?", *OPTIONS), "옳은 것은?", renderer)
    assert renderer.calls == []
    assert client.calls[0].images == ()


def test_at_most_three_images_per_question() -> None:
    renderer = _Renderer()
    tables = [TableContent(rows=(("h", str(n)), ("a", "b"))) for n in range(5)]
    doc = _doc("1. 표를 보고 답하시오.", *tables, *OPTIONS)
    stem = "표를 보고 답하시오.\n\n" + "\n\n".join(
        _gfm((("h", str(n)), ("a", "b"))) for n in range(5)
    )
    _, client = _run(doc, stem, renderer)
    assert len(renderer.calls) == 3
    assert len(client.calls[0].images) == 3


def test_a_failing_renderer_leaves_the_question_without_images() -> None:
    def broken(page: int, bbox: BBox, *, max_edge: int) -> bytes | None:
        raise RuntimeError("PRIVATE")

    client = _client(f"표를 보고 답하시오.\n\n{_gfm(PRINTED)}")
    (draft,) = (
        QuestionExtractor(client)
        .extract(_doc(*TABLE_DOC), document_id="t", region_renderer=broken)
        .drafts
    )
    assert client.calls[0].images == ()
    assert "llm_text_rejected" not in _codes(draft)


def test_cells_the_model_put_back_in_place_are_accepted_and_stored() -> None:
    fixed = (("구분", "가", "나"), ("갑", "", "재산"), ("을", "부채", "x"))
    draft, _ = _run(_doc(*TABLE_DOC), f"표를 보고 답하시오.\n\n{_gfm(fixed)}")
    assert "llm_text_rejected" not in _codes(draft)
    assert _gfm(fixed) in draft.stem
    assert draft.stem_tables is not None
    assert draft.stem_tables[0] is not None
    assert draft.stem_tables[0].rows == fixed


def test_a_corrected_table_keeps_the_merged_cell_that_still_fits() -> None:
    doc = _doc("1. 표를 보고 답하시오.", MERGED, *OPTIONS)
    model = (("Kim", "", ""), ("a", "", "bc"))
    draft, _ = _run(doc, f"표를 보고 답하시오.\n\n{_gfm(model)}")
    assert "llm_text_rejected" not in _codes(draft)
    assert draft.stem_tables is not None
    assert draft.stem_tables[0] is not None
    table = draft.stem_tables[0]
    assert table.rows == (("Kim", "Kim", "Kim"), ("a", "", "bc"))
    assert table.spans == MERGED.spans


def test_a_table_with_other_text_is_still_rejected() -> None:
    altered = (("구분", "가", "나"), ("갑", "", "재물"), ("을", "부채", "x"))
    draft, _ = _run(_doc(*TABLE_DOC), f"표를 보고 답하시오.\n\n{_gfm(altered)}")
    assert "llm_text_rejected" in _codes(draft)
    assert _gfm(PRINTED) in draft.stem
    assert "재물" not in draft.stem


def test_reordered_text_is_rejected_even_with_the_same_letters() -> None:
    swapped = (("구분", "가", "나"), ("재산", "갑", ""), ("을", "부채", "x"))
    draft, _ = _run(_doc(*TABLE_DOC), f"표를 보고 답하시오.\n\n{_gfm(swapped)}")
    assert "llm_text_rejected" in _codes(draft)
