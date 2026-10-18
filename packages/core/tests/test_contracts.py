"""Serialization round-trips and invariants of the core contracts (P0.8)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    DocumentRevision,
    DraftOrigin,
    Excerpt,
    GeneratorInfo,
    PageInfo,
    ParsedDocument,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    ScoreType,
    SearchChunk,
    SearchHit,
    SearchMode,
    Section,
    SourceEvidence,
    SourceLocation,
    TableContent,
    TextSpan,
    ValidationIssue,
    ValidationSeverity,
    VariationType,
)
from pydantic import BaseModel, ValidationError

SHA = "a" * 64
LOC = SourceLocation(page=1, bbox=BBox(x0=10, y0=20, x1=200, y1=40), block_id="b1")


def _parsed_document() -> ParsedDocument:
    return ParsedDocument(
        source_path="books/sample.pdf",
        source_sha256=SHA,
        parser_version="docling-2",
        pages=(PageInfo(page=1, width=595, height=842), PageInfo(page=2, width=595, height=842)),
        sections=(
            Section(id="ch1", title="1장 개요", level=1),
            Section(id="ch1.1", title="Background", level=2, parent_id="ch1"),
        ),
        blocks=(
            Block(
                id="b1", type=BlockType.HEADING, text="1장 개요", section_id="ch1", locations=(LOC,)
            ),
            Block(
                id="b2",
                type=BlockType.TEXT,
                text="A paragraph spanning two pages.",
                section_id="ch1.1",
                locations=(SourceLocation(page=1), SourceLocation(page=2, block_id="b2")),
            ),
            Block(
                id="b3",
                type=BlockType.TABLE,
                text="a | b\n1 | 2",
                locations=(LOC.model_copy(update={"block_id": None}),),
                table=TableContent(rows=(("a", "b"), ("1", "2")), header_rows=1),
                caption_block_id="b4",
            ),
            Block(
                id="b4", type=BlockType.TEXT, text="Table 1.", locations=(SourceLocation(page=2),)
            ),
        ),
    )


def _revision() -> DocumentRevision:
    doc = _parsed_document()
    return DocumentRevision(
        document_id="doc-1",
        revision_id="rev-2",
        revision_number=2,
        parent_revision_id="rev-1",
        source_sha256=SHA,
        sections=doc.sections,
        blocks=doc.blocks,
    )


def _chunk() -> SearchChunk:
    return SearchChunk(
        id="c1",
        document_id="doc-1",
        revision_id="rev-2",
        parent_id="c0",
        section_id="ch1.1",
        content="A paragraph spanning two pages.",
        search_text="1장 개요 > Background\nA paragraph spanning two pages.",
        content_hash=SHA,
        language="en",
        block_ids=("b2",),
        locations=(SourceLocation(page=1), SourceLocation(page=2)),
    )


def _hit() -> SearchHit:
    return SearchHit(
        chunk_id="c1",
        document_id="doc-1",
        revision_id="rev-2",
        mode=SearchMode.HYBRID,
        score_type=ScoreType.RRF,
        score=0.0328,
        rank=1,
        passage="A paragraph",
        locations=(LOC,),
    )


def _excerpt() -> Excerpt:
    return Excerpt(
        document_id="doc-1",
        revision_id="rev-2",
        chunk_id="c1",
        text="A paragraph spanning two pages.",
        highlights=(TextSpan(start=0, end=11),),
        block_ids=("b2",),
        locations=(LOC,),
    )


def _imported_draft() -> QuestionDraft:
    return QuestionDraft(
        id="d1",
        origin=DraftOrigin.PDF_IMPORT,
        question_type=QuestionType.MCQ,
        stem="다음 중 옳은 것은?",
        options=(QuestionOption(id="o1", text="A"), QuestionOption(id="o2", text="B")),
        evidence=(SourceEvidence(document_id="qpdf-1", locations=(SourceLocation(page=3),)),),
        validations=(
            ValidationIssue(
                code="answer_missing",
                severity=ValidationSeverity.WARNING,
                message="No answer key found",
                field="correct_option_ids",
            ),
        ),
    )


def _generated_draft(**overrides: Any) -> QuestionDraft:
    data: dict[str, Any] = {
        "id": "d2",
        "origin": DraftOrigin.GENERATION,
        "question_type": QuestionType.MCQ,
        "stem": "Which is NOT true?",
        "options": (QuestionOption(id="x", text="A"), QuestionOption(id="y", text="B")),
        "correct_option_ids": ("y",),
        "variation_type": VariationType.INVERT_POLARITY,
        "parent_question_id": "q1",
        "source_question_revision_id": "qr1",
        "generator": GeneratorInfo(model="fake-llm", prompt_version="v1"),
    }
    data.update(overrides)
    return QuestionDraft(**data)


ROUND_TRIP_CASES: list[BaseModel] = [
    _parsed_document(),
    _revision(),
    _chunk(),
    _hit(),
    _excerpt(),
    _imported_draft(),
    _generated_draft(),
]


@pytest.mark.parametrize("model", ROUND_TRIP_CASES, ids=lambda m: type(m).__name__)
def test_json_round_trip_is_lossless(model: BaseModel) -> None:
    raw = model.model_dump_json()
    restored = type(model).model_validate_json(raw)
    assert restored == model
    assert restored.model_dump_json() == raw


@pytest.mark.parametrize("model", ROUND_TRIP_CASES, ids=lambda m: type(m).__name__)
def test_python_json_mode_round_trip(model: BaseModel) -> None:
    payload = json.loads(json.dumps(model.model_dump(mode="json")))
    assert type(model).model_validate(payload) == model


@pytest.mark.parametrize("model", ROUND_TRIP_CASES, ids=lambda m: type(m).__name__)
def test_json_schema_is_generated(model: BaseModel) -> None:
    schema = type(model).model_json_schema()
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False


def test_enum_values_use_documented_spelling() -> None:
    payload = json.loads(_generated_draft().model_dump_json())
    assert payload["question_type"] == "MCQ"
    assert payload["variation_type"] == "INVERT_POLARITY"
    assert payload["origin"] == "generation"
    assert payload["review_status"] == "pending"
    assert json.loads(_hit().model_dump_json())["mode"] == "hybrid"


def test_top_level_documents_carry_schema_version() -> None:
    for model in (_parsed_document(), _revision(), _chunk(), _imported_draft()):
        assert json.loads(model.model_dump_json())["schema_version"] == 1


def test_contracts_are_frozen_and_reject_unknown_fields() -> None:
    hit = _hit()
    with pytest.raises(ValidationError):
        hit.rank = 2
    with pytest.raises(ValidationError, match="extra"):
        SearchHit.model_validate({**hit.model_dump(), "unexpected": 1})


def test_non_finite_scores_are_rejected() -> None:
    with pytest.raises(ValidationError):
        SearchHit.model_validate({**_hit().model_dump(), "score": float("nan")})


@pytest.mark.parametrize(
    "box", [{"x0": 5, "y0": 0, "x1": 5, "y1": 10}, {"x0": 0, "y0": 10, "x1": 5, "y1": 2}]
)
def test_bbox_rejects_degenerate_boxes(box: dict[str, float]) -> None:
    with pytest.raises(ValidationError, match="x0 < x1"):
        BBox.model_validate(box)


def test_identifiers_reject_whitespace_and_empty() -> None:
    for bad in ("", "has space"):
        with pytest.raises(ValidationError):
            Section(id=bad, title="t", level=1)


def test_parsed_document_rejects_bbox_outside_page() -> None:
    doc = _parsed_document()
    outside = SourceLocation(page=1, bbox=BBox(x0=0, y0=0, x1=600, y1=10))
    block = Block(id="b9", type=BlockType.TEXT, text="x", locations=(outside,))
    with pytest.raises(ValidationError, match="exceeds page"):
        ParsedDocument.model_validate({**doc.model_dump(), "blocks": [block.model_dump()]})


def test_parsed_document_rejects_unknown_page_and_section() -> None:
    doc = _parsed_document()
    on_missing_page = Block(
        id="b9", type=BlockType.TEXT, text="x", locations=(SourceLocation(page=7),)
    )
    with pytest.raises(ValidationError, match="unknown page"):
        ParsedDocument.model_validate(
            {**doc.model_dump(), "blocks": [on_missing_page.model_dump()]}
        )
    orphan = Block(
        id="b9",
        type=BlockType.TEXT,
        text="x",
        section_id="nope",
        locations=(SourceLocation(page=1),),
    )
    with pytest.raises(ValidationError, match="unknown section"):
        ParsedDocument.model_validate({**doc.model_dump(), "blocks": [orphan.model_dump()]})


def test_section_hierarchy_requires_parent_first_and_deeper_level() -> None:
    with pytest.raises(ValidationError, match="unknown or later parent"):
        DocumentRevision.model_validate(
            {
                **_revision().model_dump(),
                "sections": [
                    {"id": "child", "title": "c", "level": 2, "parent_id": "root"},
                    {"id": "root", "title": "r", "level": 1},
                ],
                "blocks": [],
            }
        )
    with pytest.raises(ValidationError, match="deeper"):
        DocumentRevision.model_validate(
            {
                **_revision().model_dump(),
                "sections": [
                    {"id": "root", "title": "r", "level": 1},
                    {"id": "child", "title": "c", "level": 1, "parent_id": "root"},
                ],
                "blocks": [],
            }
        )


def test_duplicate_block_ids_are_rejected() -> None:
    revision = _revision()
    blocks = [b.model_dump() for b in revision.blocks]
    with pytest.raises(ValidationError, match="duplicate block id"):
        DocumentRevision.model_validate({**revision.model_dump(), "blocks": [*blocks, blocks[0]]})


@pytest.mark.parametrize(
    ("block", "message"),
    [
        ({"type": "text", "heading_level": 1}, "heading_level"),
        ({"type": "text", "table": {"rows": [["a"]]}}, "table cells"),
        ({"type": "heading", "caption_block_id": "b4"}, "captions"),
        ({"type": "image", "caption_block_id": "x"}, "own caption"),
        ({"type": "table", "table": {"rows": [["a", "b"], ["c"]]}}, "same number"),
        ({"type": "table", "table": {"rows": [["a"]], "header_rows": 2}}, "header_rows"),
    ],
)
def test_block_extras_are_type_checked(block: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        Block.model_validate({"id": "x", "text": "", "locations": [{"page": 1}], **block})


def test_caption_must_reference_an_existing_block() -> None:
    doc = _parsed_document()
    blocks = [b.model_dump() for b in doc.blocks]
    blocks[2]["caption_block_id"] = "missing"
    with pytest.raises(ValidationError, match="unknown caption block"):
        ParsedDocument.model_validate({**doc.model_dump(), "blocks": blocks})


def test_revision_cannot_be_its_own_parent() -> None:
    with pytest.raises(ValidationError, match="own parent"):
        DocumentRevision.model_validate({**_revision().model_dump(), "parent_revision_id": "rev-2"})


def test_search_hit_score_type_must_match_mode() -> None:
    with pytest.raises(ValidationError, match="not valid for mode"):
        SearchHit.model_validate({**_hit().model_dump(), "score_type": ScoreType.BM25})
    reranked = SearchHit.model_validate({**_hit().model_dump(), "score_type": ScoreType.RERANK})
    assert reranked.score_type is ScoreType.RERANK


def test_excerpt_highlight_must_fit_text() -> None:
    with pytest.raises(ValidationError, match="highlight exceeds"):
        Excerpt.model_validate(
            {**_excerpt().model_dump(), "highlights": [{"start": 0, "end": 999}]}
        )
    with pytest.raises(ValidationError, match="greater than start"):
        TextSpan(start=3, end=3)


def test_imported_draft_keeps_unknown_answer_as_null() -> None:
    draft = _imported_draft()
    payload = json.loads(draft.model_dump_json())
    assert payload["correct_option_ids"] is None
    assert payload["accepted_answers"] is None
    assert not draft.has_blocking_issues


def test_imported_draft_cannot_carry_lineage() -> None:
    with pytest.raises(ValidationError, match="lineage"):
        QuestionDraft.model_validate(
            {**_imported_draft().model_dump(), "variation_type": VariationType.PARAPHRASE}
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"variation_type": VariationType.OPTION_SHUFFLE},
        {"variation_type": None},
        {"parent_question_id": None},
        {"source_question_revision_id": None},
    ],
)
def test_generated_draft_requires_draft_variation_and_lineage(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _generated_draft(**overrides)


def test_correct_options_must_exist_and_be_unique() -> None:
    with pytest.raises(ValidationError, match="not among options"):
        _generated_draft(correct_option_ids=("z",))
    with pytest.raises(ValidationError, match="duplicate correct option id"):
        _generated_draft(correct_option_ids=("x", "x"))
    with pytest.raises(ValidationError, match="duplicate option id"):
        _generated_draft(
            options=(QuestionOption(id="x", text="A"), QuestionOption(id="x", text="B"))
        )


def test_draft_with_error_validation_cannot_be_approved() -> None:
    error = ValidationIssue(code="no_answer", severity=ValidationSeverity.ERROR, message="m")
    with pytest.raises(ValidationError, match="cannot be approved"):
        _generated_draft(validations=(error,), review_status=ReviewStatus.APPROVED)
    assert _generated_draft(validations=(error,)).has_blocking_issues
