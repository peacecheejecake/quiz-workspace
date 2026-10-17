"""QuestionExtractor (M4.3): rule-based pre-extraction, LLM refinement, answer guarding.

Default tests run on the ideal ``questions-ko`` document (FakeParser over the fixture truth)
and ``FakeLLMClient``; the ``models``-marked test runs the rule-based path on real Docling output
of ``questions-ko.pdf``.
"""

from __future__ import annotations

import json
import re

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    DraftOrigin,
    PageInfo,
    ParsedDocument,
    QuestionType,
    ReviewStatus,
    SourceLocation,
    TableContent,
    ValidationSeverity,
)
from book_core.extractor import (
    EXTRACT_PROMPT_VERSION,
    LLMAnswer,
    LLMOption,
    LLMQuestion,
    QuestionExtraction,
    QuestionExtractor,
    llm_requests,
)
from book_core.llm import FakeLLMClient, LLMProviderError
from book_core.parser import FakeParser, document_from_pages
from book_core.question import (
    answer_option_keys,
    canonical_key,
    option_id,
    split_option_line,
    structural_issues,
)
from fixture_truth import QuestionsTruth, TruthQuestion
from make_fixture_pdfs import OUT_DIR

TRUTH_PATH = OUT_DIR / "questions-ko.truth.json"
PDF_PATH = OUT_DIR / "questions-ko.pdf"
DOC_ID = "doc-q1"
BOOK_TEXT = "PRIVATE BOOK PASSAGE 비공개 본문"


def _truth() -> QuestionsTruth:
    return QuestionsTruth.model_validate_json(TRUTH_PATH.read_bytes())


def _document() -> ParsedDocument:
    return FakeParser.from_truth_files([TRUTH_PATH]).parse(PDF_PATH)


def _codes(issues: object) -> set[str]:
    return {i.code for i in issues}  # type: ignore[attr-defined]


def _iou(a: BBox, b: BBox) -> float:
    ix = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    iy = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    inter = ix * iy
    return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter)


def _inside(a: BBox, b: BBox) -> float:
    """Share of ``a``'s area that lies inside ``b``."""
    ix = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    iy = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    return ix * iy / ((a.x1 - a.x0) * (a.y1 - a.y0))


def _expected_ids(question: TruthQuestion) -> tuple[str, ...] | None:
    if question.answer is None or question.answer.correct_option_labels is None:
        return None
    return tuple(option_id(canonical_key(label)) for label in question.answer.correct_option_labels)


def assert_matches_truth(
    result: QuestionExtraction, truth: QuestionsTruth, *, min_iou: float
) -> None:
    assert [q.number for q in result.questions] == [q.number for q in truth.questions]
    for got, want in zip(result.questions, truth.questions, strict=True):
        draft = got.draft
        assert draft.origin is DraftOrigin.PDF_IMPORT
        assert draft.review_status is ReviewStatus.PENDING
        assert draft.variation_type is None
        assert draft.question_type is want.question_type, want.number
        assert got.multi_select is want.multi_select, want.number
        assert draft.stem == want.stem
        assert [(o.id, o.text) for o in draft.options] == [
            (option_id(canonical_key(o.label)), o.text) for o in want.options
        ]
        assert draft.correct_option_ids == _expected_ids(want)
        want_text = want.answer.accepted_answers if want.answer is not None else None
        assert draft.accepted_answers == want_text
        if want.answer is None:
            assert draft.correct_option_ids is None
            assert "answer_missing" in _codes(draft.validations)
        assert not draft.has_blocking_issues, (want.number, draft.validations)

        region = draft.evidence[0]
        assert region.document_id == DOC_ID
        assert [loc.page for loc in region.locations] == [want.page]
        bbox = region.locations[0].bbox
        assert bbox is not None
        assert _inside(bbox, want.bbox) >= 0.9, (want.number, bbox, want.bbox)
        if want.question_type is not QuestionType.ESSAY:  # truth includes the blank answer box
            assert _iou(bbox, want.bbox) >= min_iou, (want.number, bbox, want.bbox)

        figures = draft.evidence[1:]
        if want.figure is None:
            assert figures == ()
        else:
            (figure,) = figures
            assert figure.quote == want.figure.caption
            pages = {loc.page for loc in figure.locations}
            assert pages == {want.figure.page}
            image_bbox = figure.locations[0].bbox
            assert image_bbox is not None
            assert _iou(image_bbox, want.figure.bbox) >= min_iou
    assert (
        sum(
            1
            for q in result.questions
            if q.draft.correct_option_ids is None and q.draft.accepted_answers is None
        )
        == 3
    )


# ------------------------------------------------------------------------------------------
# Rule-based path on the ideal document


def test_questions_ko_gives_eight_drafts_matching_truth() -> None:
    result = QuestionExtractor().extract(_document(), document_id=DOC_ID, revision_id="rev-1")
    assert_matches_truth(result, _truth(), min_iou=0.99)
    assert result.warnings == ()
    assert result.llm_calls == ()
    assert all(q.draft.generator is None and not q.refined_by_llm for q in result.questions)
    assert all(e.revision_id == "rev-1" for d in result.drafts for e in d.evidence)


def test_extraction_is_deterministic() -> None:
    first = QuestionExtractor().extract(_document(), document_id=DOC_ID)
    second = QuestionExtractor().extract(_document(), document_id=DOC_ID)
    assert first.model_dump_json() == second.model_dump_json()
    assert [d.id for d in first.drafts] == [f"{DOC_ID}-q{n:03d}" for n in range(1, 9)]
    assert QuestionExtraction.model_validate_json(first.model_dump_json()) == first


# ------------------------------------------------------------------------------------------
# LLM refinement


def _llm_output(question: TruthQuestion, *, with_answer: bool = True) -> LLMQuestion:
    answer = None
    if with_answer and question.answer is not None:
        answer = LLMAnswer(
            option_labels=(
                list(question.answer.correct_option_labels)
                if question.answer.correct_option_labels
                else None
            ),
            text_answers=(
                list(question.answer.accepted_answers) if question.answer.accepted_answers else None
            ),
        )
    return LLMQuestion(
        question_type=question.question_type.value,
        multi_select=question.multi_select,
        stem=question.stem,
        options=[LLMOption(label=o.label, text=o.text) for o in question.options],
        answer=answer,
    )


def _scripted(overrides: dict[int, object] | None = None) -> FakeLLMClient:
    truth = {q.number: q for q in _truth().questions}
    client = FakeLLMClient(model_name="fake-llm-1")
    for number, request in llm_requests(_document()):
        response = (overrides or {}).get(number, _llm_output(truth[number]))
        client.script(request, response)  # type: ignore[arg-type]
    return client


def test_llm_refinement_with_valid_output_matches_truth_and_records_provenance() -> None:
    client = _scripted()
    result = QuestionExtractor(client).extract(_document(), document_id=DOC_ID)

    assert_matches_truth(result, _truth(), min_iou=0.99)
    assert len(client.calls) == 8
    assert all(q.refined_by_llm for q in result.questions)
    for draft in result.drafts:
        assert draft.generator is not None
        assert draft.generator.model == "fake-llm-1"
        assert draft.generator.prompt_version == EXTRACT_PROMPT_VERSION
        assert not {c for c in _codes(draft.validations) if c.startswith("llm_")}
    assert len(result.llm_calls) == 8
    assert result.llm_usage.input_tokens == sum(c.usage.input_tokens for c in result.llm_calls)
    assert result.llm_usage.input_tokens > 0


def test_llm_request_contains_only_the_questions_own_source() -> None:
    truth = _truth()
    requests = dict(llm_requests(_document()))
    q2 = requests[2]
    assert q2.prompt_version == EXTRACT_PROMPT_VERSION
    assert truth.questions[1].stem in q2.prompt
    assert "2. A, C, D" in q2.prompt
    for other in truth.questions:
        if other.number != 2:
            assert other.stem not in q2.prompt
    for line in truth.answer_key_lines:
        if not line.startswith("2."):
            assert line not in q2.prompt
    assert truth.title not in q2.prompt
    assert truth.instructions not in q2.prompt
    q3 = requests[3]
    assert "[그림 1] 물 순환 단면 모식도" in q3.prompt
    assert "(none)" in q3.prompt  # no answer key line for question 3
    assert llm_requests(_document()) == list(requests.items())


def test_llm_text_fixes_are_accepted_only_when_grounded_in_the_source() -> None:
    truth = {q.number: q for q in _truth().questions}
    spaced = _llm_output(truth[1]).model_copy(
        update={"stem": "물이 액체에서  기체로 변하는\n과정을 무엇이라 하는가?"}
    )
    invented = _llm_output(truth[5]).model_copy(
        update={
            "stem": "염소 소독을 하는 이유는?",
            "options": [
                LLMOption(label="①", text="물을 맛있게 한다."),
                *_llm_output(truth[5]).options[1:],
            ],
        }
    )
    client = _scripted({1: spaced, 5: invented})
    result = QuestionExtractor(client).extract(_document(), document_id=DOC_ID)
    by_number = {q.number: q.draft for q in result.questions}

    assert "llm_text_rejected" not in _codes(by_number[1].validations)
    q5 = by_number[5]
    assert q5.stem == truth[5].stem
    assert [o.text for o in q5.options] == [o.text for o in truth[5].options]
    rejected = [v for v in q5.validations if v.code == "llm_text_rejected"]
    assert {v.field for v in rejected} == {"stem", "options"}


def test_hallucinated_llm_answers_are_rejected_and_answers_stay_from_the_key() -> None:
    truth = {q.number: q for q in _truth().questions}
    overrides: dict[int, object] = {
        # Question 3: no answer key line, the model "solves" it.
        3: _llm_output(truth[3]).model_copy(
            update={"answer": LLMAnswer(option_labels=["③"], text_answers=None)}
        ),
        # Question 6: no answer key line, invented text answer.
        6: _llm_output(truth[6]).model_copy(
            update={"answer": LLMAnswer(option_labels=None, text_answers=["여과"])}
        ),
        # Question 1: the key says ②, the model says ③.
        1: _llm_output(truth[1]).model_copy(
            update={"answer": LLMAnswer(option_labels=["③"], text_answers=None)}
        ),
        # Question 4: the model drops the key answer; the key still applies.
        4: _llm_output(truth[4], with_answer=False),
    }
    result = QuestionExtractor(_scripted(overrides)).extract(_document(), document_id=DOC_ID)
    by_number = {q.number: q.draft for q in result.questions}

    for number in (3, 6):
        draft = by_number[number]
        assert draft.correct_option_ids is None
        assert draft.accepted_answers is None
        assert {"llm_answer_rejected", "answer_missing"} <= _codes(draft.validations)
        warning = next(v for v in draft.validations if v.code == "llm_answer_rejected")
        assert warning.severity is ValidationSeverity.WARNING
    assert by_number[1].correct_option_ids == ("opt-2",)
    assert "llm_answer_rejected" in _codes(by_number[1].validations)
    assert by_number[4].accepted_answers == ("응결",)
    assert "llm_answer_rejected" not in _codes(by_number[4].validations)


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all " + BOOK_TEXT,
        json.dumps({"question_type": "MCQ", "stem": BOOK_TEXT}),
        json.dumps(
            {
                "question_type": "QUIZ",
                "multi_select": False,
                "stem": BOOK_TEXT,
                "options": [],
                "answer": None,
            }
        ),
    ],
    ids=["invalid-json", "missing-fields", "bad-enum"],
)
def test_malformed_llm_output_falls_back_to_pre_extraction(raw: str) -> None:
    client = FakeLLMClient()
    client.script("questions.extract", raw)
    baseline = QuestionExtractor().extract(_document(), document_id=DOC_ID)
    result = QuestionExtractor(client).extract(_document(), document_id=DOC_ID)

    assert_matches_truth(result, _truth(), min_iou=0.99)
    for got, base in zip(result.questions, baseline.questions, strict=True):
        assert not got.refined_by_llm
        assert got.draft.generator is None
        invalid = [v for v in got.draft.validations if v.code == "llm_output_invalid"]
        assert len(invalid) == 1
        assert "PRIVATE" not in invalid[0].message
        assert "비공개" not in invalid[0].message
        others = [v for v in got.draft.validations if v.code != "llm_output_invalid"]
        assert others == list(base.draft.validations)


def test_provider_failure_falls_back_to_pre_extraction() -> None:
    client = FakeLLMClient()
    client.script(
        "questions.extract",
        LLMProviderError("provider returned HTTP 529", kind="http_status", status_code=529),
    )
    result = QuestionExtractor(client).extract(_document(), document_id=DOC_ID)
    assert_matches_truth(result, _truth(), min_iou=0.99)
    assert all("llm_unavailable" in _codes(d.validations) for d in result.drafts)
    assert result.llm_calls == ()


def test_llm_type_that_contradicts_printed_options_is_rejected() -> None:
    truth = {q.number: q for q in _truth().questions}
    essay = _llm_output(truth[7]).model_copy(update={"question_type": "MCQ"})
    result = QuestionExtractor(_scripted({7: essay})).extract(_document(), document_id=DOC_ID)
    draft = next(q.draft for q in result.questions if q.number == 7)
    assert draft.question_type is QuestionType.ESSAY
    assert "llm_type_rejected" in _codes(draft.validations)


# ------------------------------------------------------------------------------------------
# Layout variants (synthetic text documents)


def _doc(*pages: list[str]) -> ParsedDocument:
    """One block per printed line, like Docling output."""
    blocks = [[line for block in page for line in block.split("\n")] for page in pages]
    return document_from_pages(blocks, source_path="x.pdf", source_sha256="0" * 64)


def _extract(*pages: list[str]) -> QuestionExtraction:
    return QuestionExtractor().extract(_doc(*pages), document_id="d")


def test_inline_options_heading_answer_key_and_packed_entries() -> None:
    result = _extract(
        [
            "1. 다음 중 가장 큰 수는?\n① 1 ② 2 ③ 3 ④ 4",
            "2. (1)과 (2) 중 옳은 것을 모두 고르시오.\n(1) 가\n(2) 나\n(3) 다",
            "3. 증발을 설명하시오.",
        ],
        ["# 정답", "1. ④ 2. (1), (3)", "3. 물이 기체가 되는 현상"],
    )
    q1, q2, q3 = result.drafts
    assert [o.text for o in q1.options] == ["1", "2", "3", "4"]
    assert q1.correct_option_ids == ("opt-4",)
    assert q2.correct_option_ids == ("opt-1", "opt-3")
    assert result.questions[1].multi_select
    assert q3.question_type is QuestionType.ESSAY
    assert q3.accepted_answers == ("물이 기체가 되는 현상",)
    assert result.warnings == ()


def test_question_merged_into_one_paragraph_is_split_into_stem_and_options() -> None:
    doc = document_from_pages(
        [["1. 물이 기체로 변하는 과정은? ① 응결 ② 증발"], ["정답", "1. ②"]],
        source_path="x.pdf",
        source_sha256="0" * 64,
    )
    (draft,) = QuestionExtractor().extract(doc, document_id="d").drafts
    assert draft.stem == "물이 기체로 변하는 과정은?"
    assert [(o.id, o.text) for o in draft.options] == [("opt-1", "응결"), ("opt-2", "증발")]
    assert draft.correct_option_ids == ("opt-2",)


def test_unmapped_conflicting_and_unknown_answer_key_entries_are_warnings() -> None:
    result = _extract(
        [
            "1. 고르시오.\nA. 가\nB. 나",
            "2. 쓰시오.",
            "3. 고르시오.\n① 가\n② 나",
        ],
        ["정답", "1. ③", "2. ②", "3. ①", "3. ②", "9. A"],
    )
    q1, q2, q3 = result.drafts
    assert q1.correct_option_ids is None
    assert "answer_key_unmapped" in _codes(q1.validations)
    assert q2.accepted_answers is None
    assert "answer_key_type_mismatch" in _codes(q2.validations)
    assert q3.correct_option_ids is None
    assert "answer_key_conflict" in _codes(q3.validations)
    assert "answer_key_unknown_number" in _codes(result.warnings)


def test_multi_select_inconsistency_option_gap_and_missing_figure_are_flagged() -> None:
    result = _extract(
        [
            "1. [그림 2]에서 옳은 것은?\n① 가\n② 나\n④ 라",
            "2. 옳은 것을 모두 고르시오.\n① 가\n② 나\n③ 다",
        ],
        ["정답", "1. ①, ②", "2. ③"],
    )
    q1, q2 = result.drafts
    assert {"mcq_multi_inconsistent", "option_sequence_gap", "figure_missing"} <= _codes(
        q1.validations
    )
    assert "mcq_multi_inconsistent" in _codes(q2.validations)
    assert not q1.has_blocking_issues


def test_shared_figure_before_the_questions_is_linked_by_its_label() -> None:
    page = PageInfo(page=1, width=595.0, height=842.0)
    loc = (SourceLocation(page=1, bbox=BBox(x0=60, y0=60, x1=300, y1=200)),)
    doc = ParsedDocument(
        source_path="f.pdf",
        source_sha256="2" * 64,
        parser_version="test",
        pages=(page,),
        blocks=(
            Block(id="img", type=BlockType.IMAGE, text="", locations=loc),
            Block(id="cap", type=BlockType.TEXT, text="[그림 3] 정수장 배치도", locations=loc),
            Block(
                id="q1", type=BlockType.TEXT, text="1. [그림 3]의 A 단계를 쓰시오.", locations=loc
            ),
        ),
    )
    (draft,) = QuestionExtractor().extract(doc, document_id="f").drafts
    figure = draft.evidence[1]
    assert figure.block_ids == ("img", "cap")
    assert figure.quote == "[그림 3] 정수장 배치도"
    assert "figure_missing" not in _codes(draft.validations)


def test_duplicate_numbers_number_gaps_and_no_answer_key() -> None:
    result = _extract(["1. 첫 문제를 쓰시오.", "1. 같은 번호의 다른 문제를 쓰시오.", "3. 쓰시오."])
    assert [d.id for d in result.drafts] == ["d-q001-1", "d-q001-2", "d-q003"]
    assert all("duplicate_question_number" in _codes(d.validations) for d in result.drafts[:2])
    assert {"question_number_gap", "answer_key_missing"} <= _codes(result.warnings)


def test_no_questions() -> None:
    result = _extract(["제목", "본문 문장입니다."])
    assert result.questions == ()
    assert "no_questions_found" in _codes(result.warnings)


def test_answer_key_table_and_layout_essay() -> None:
    page = PageInfo(page=1, width=595.0, height=842.0)

    def block(i: int, text: str, y0: float, y1: float, **kw: object) -> Block:
        return Block(
            id=f"b{i}",
            type=kw.pop("type", BlockType.TEXT),  # type: ignore[arg-type]
            text=text,
            locations=(SourceLocation(page=1, bbox=BBox(x0=60, y0=y0, x1=500, y1=y1)),),
            **kw,  # type: ignore[arg-type]
        )

    rows = (("번호", "1", "2"), ("정답", "②", "가"))
    doc = ParsedDocument(
        source_path="t.pdf",
        source_sha256="1" * 64,
        parser_version="test",
        pages=(page,),
        blocks=(
            block(1, "1. 고르시오.", 60, 70),
            block(2, "① 가", 72, 82),
            block(3, "② 나", 84, 94),
            block(4, "2. 물의 순환 과정을 쓰시오.", 110, 120),
            block(5, "답안지", 300, 310, type=BlockType.HEADING),
            block(6, "정답", 400, 410, type=BlockType.HEADING),
            block(
                7,
                "번호 | 1 | 2\n정답 | ② | 가",
                420,
                440,
                type=BlockType.TABLE,
                table=TableContent(rows=rows, header_rows=1),
            ),
        ),
    )
    result = QuestionExtractor().extract(doc, document_id="t")
    q1, q2 = result.drafts
    assert q1.correct_option_ids == ("opt-2",)
    assert q2.question_type is QuestionType.ESSAY  # large blank area before the next block
    assert q2.accepted_answers == ("가",)


# ------------------------------------------------------------------------------------------
# Shared question helpers


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("① 응결", [("①", "응결")]),
        ("①응결 ②증발", [("①", "응결"), ("②", "증발")]),
        ("A. 응집", [("A", "응집")]),
        ("(B) 증산", [("B", "증산")]),
        ("3) 셋", [("3", "셋")]),
        ("a) one", [("a", "one")]),
        ("Apple is red", None),
        ("2.5 L의 물", None),
    ],
)
def test_split_option_line(text: str, expected: list[tuple[str, str]] | None) -> None:
    assert split_option_line(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("②", ("2",)),
        ("A, C, D", ("A", "C", "D")),
        ("②, ④", ("2", "4")),
        ("3번", ("3",)),
        ("(1), (3)", ("1", "3")),
        ("B와 D", ("B", "D")),
        ("응결", None),
        ("100 mL", None),
        ("", None),
    ],
)
def test_answer_option_keys(text: str, expected: tuple[str, ...] | None) -> None:
    assert answer_option_keys(text) == expected


def test_structural_issues_cover_answer_and_type_rules() -> None:
    from book_core.contracts import QuestionOption, SourceEvidence

    evidence = (SourceEvidence(document_id="d", locations=(SourceLocation(page=1),)),)
    opts = (QuestionOption(id="opt-1", text="a"), QuestionOption(id="opt-1", text="b"))
    codes = _codes(
        structural_issues(
            question_type=QuestionType.MCQ,
            options=opts,
            correct_option_ids=("opt-9",),
            accepted_answers=None,
            evidence=(),
        )
    )
    assert {"duplicate_option_id", "answer_not_in_options", "provenance_missing"} <= codes
    codes = _codes(
        structural_issues(
            question_type=QuestionType.ESSAY,
            options=opts[:1],
            correct_option_ids=("opt-1",),
            accepted_answers=None,
            evidence=evidence,
        )
    )
    assert {"options_not_allowed", "option_answer_not_allowed"} <= codes


def test_validation_messages_never_quote_source_text() -> None:
    result = _extract([f"1. {BOOK_TEXT} 고르시오.\nA. {BOOK_TEXT}\nC. x"], ["정답", "1. ⑤"])
    for issue in (*result.drafts[0].validations, *result.warnings):
        assert "PRIVATE" not in issue.message
        assert "비공개" not in issue.message


# ------------------------------------------------------------------------------------------
# Real Docling output (rule-based path only)


@pytest.mark.models
def test_questions_ko_on_real_docling_output_matches_truth() -> None:
    from book_core.parser.docling_adapter import DoclingParser

    document = DoclingParser().parse(PDF_PATH)
    result = QuestionExtractor().extract(document, document_id=DOC_ID)
    # Docling boxes cover the glyph cells, truth boxes the font ascent/descent and the number
    # column (see test_parser_docling.py), so single-line questions overlap their truth box with
    # IoU ~0.6 while lying inside it.
    assert_matches_truth(result, _truth(), min_iou=0.55)
    assert result.warnings == ()
    assert all(
        re.fullmatch(r"p\d+-b\d{3}-[0-9a-f]{10}", b)
        for d in result.drafts
        for e in d.evidence
        for b in e.block_ids
    )
