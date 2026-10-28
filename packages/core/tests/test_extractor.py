"""QuestionExtractor (M4.3): rule-based pre-extraction, LLM refinement, answer guarding.

Default tests run on the ideal ``questions-ko`` document (FakeParser over the fixture truth)
and ``FakeLLMClient``; the ``models``-marked test runs the rule-based path on real Docling output
of ``questions-ko.pdf``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    DraftOrigin,
    PageInfo,
    ParsedDocument,
    QuestionDraft,
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


def _refine_one(number: int, proposal: LLMQuestion) -> tuple[QuestionDraft, set[str | None]]:
    result = QuestionExtractor(_scripted({number: proposal})).extract(
        _document(), document_id=DOC_ID
    )
    draft = next(q.draft for q in result.questions if q.number == number)
    rejected = {v.field for v in draft.validations if v.code == "llm_text_rejected"}
    return draft, rejected


def _truth_question(number: int) -> TruthQuestion:
    return next(q for q in _truth().questions if q.number == number)


def test_llm_option_texts_swapped_between_labels_are_rejected() -> None:
    good = _llm_output(_truth_question(1))
    # 응결 <-> 증발 with the labels kept: the printed key (②) would then point at 응결.
    swapped = [LLMOption(label="①", text="증발"), LLMOption(label="②", text="응결")]
    draft, rejected = _refine_one(
        1, good.model_copy(update={"options": swapped + good.options[2:]})
    )
    assert rejected == {"options"}
    assert [(o.id, o.text) for o in draft.options[:2]] == [("opt-1", "응결"), ("opt-2", "증발")]
    assert draft.correct_option_ids == ("opt-2",)


def test_llm_relabelled_options_are_rejected() -> None:
    good = _llm_output(_truth_question(1))
    relabelled = [LLMOption(label="②", text="응결"), LLMOption(label="①", text="증발")]
    draft, rejected = _refine_one(
        1, good.model_copy(update={"options": relabelled + good.options[2:]})
    )
    assert rejected == {"options"}
    assert draft.options[1].text == "증발"


def test_llm_text_moved_from_option_to_stem_is_rejected() -> None:
    q1 = _truth_question(1)
    good = _llm_output(q1)
    moved = good.model_copy(
        update={
            "stem": q1.stem + " 응결",
            "options": [LLMOption(label="①", text=""), *good.options[1:]],
        }
    )
    draft, rejected = _refine_one(1, moved)
    assert rejected == {"stem", "options"}
    assert draft.stem == q1.stem
    assert draft.options[0].text == "응결"


def test_llm_partially_rewritten_option_text_is_rejected() -> None:
    good = _llm_output(_truth_question(5))
    rewritten = [LLMOption(label="②", text="병원성 미생물을 없앤다.")]
    draft, rejected = _refine_one(
        5, good.model_copy(update={"options": good.options[:1] + rewritten + good.options[2:]})
    )
    assert rejected == {"options"}
    assert draft.options[1].text == "병원성 미생물을 줄인다."


def _single_question_llm(stem: str, options: list[tuple[str, str]]) -> QuestionDraft:
    client = FakeLLMClient()
    client.script(
        "questions.extract",
        LLMQuestion(
            question_type="MCQ",
            multi_select=False,
            stem=stem,
            options=[LLMOption(label=label, text=text) for label, text in options],
            answer=None,
        ),
    )
    doc = _doc(["1. 물이 기체가 되는 과정은? 가. 응결 나. 증발"])
    (draft,) = QuestionExtractor(client).extract(doc, document_id="d").drafts
    return draft


def test_llm_split_of_unrecognised_options_is_accepted_when_it_reproduces_the_print() -> None:
    draft = _single_question_llm("물이 기체가 되는 과정은?", [("가", "응결"), ("나", "증발")])
    assert draft.question_type is QuestionType.MCQ
    assert [(o.id, o.text) for o in draft.options] == [("opt-가", "응결"), ("opt-나", "증발")]
    assert "llm_text_rejected" not in _codes(draft.validations)


@pytest.mark.parametrize(
    ("stem", "options"),
    [
        ("물이 기체가 되는 과정은?", [("가", "증발"), ("나", "응결")]),
        ("물이 기체가 되는 과정은? 가. 응결", [("나", "증발")]),
        ("물이 기체가 되는 과정은?", [("가", "응결")]),
        ("물이 기체가 되는 과정은?", [("가", "응결"), ("나", "증발함")]),
    ],
    ids=["swapped", "option-in-stem", "dropped", "rewritten"],
)
def test_llm_split_that_does_not_reproduce_the_print_is_rejected(
    stem: str, options: list[tuple[str, str]]
) -> None:
    draft = _single_question_llm(stem, options)
    assert draft.options == ()
    assert draft.question_type is QuestionType.SHORT_ANSWER
    assert draft.stem == "물이 기체가 되는 과정은? 가. 응결 나. 증발"
    assert "llm_text_rejected" in _codes(draft.validations)


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


def _question_bank() -> ParsedDocument:
    """A question bank laid out like a real exam workbook, as Docling emits it: bare question
    numbers (``01``, no period) on heading blocks, one block per option, an inline ``정답: ②``
    line plus a printed explanation after every question, numbering restarting per chapter,
    a stem wrapped over two heading blocks and options running onto the next page."""
    return _doc(
        [
            "3 문제은행 및 해설 문제풀이",
            "# ※ 다음을 읽고 알맞은 답을 고르시오(1~3번).",
            "# 01 예금 거래에 관한 설명 중 틀린 것은? ( )",
            "① 첫째 설명이다.",
            "② 둘째 설명이다.",
            "③ 셋째 설명이다.",
            "④ 넷째 설명이다.",
            "# 정답: ②",
            "② 둘째 설명은 이렇게 고쳐야 함",
            "# 02 이율 변경 시 처리로 맞는 것은? ( )",
            "① 가를 안내하였다.",
            "② 나를 안내하였다.",
        ],
        [
            "③ 다를 안내하였다.",
            "④ 라를 안내하였다.",
            "# 정답: ③",
            "해설 첫 줄",
            "∙ 해설 둘째 줄",
            "# 03 기업여신 관리점 일원화 원칙에도 불구하고 관리점을 달리 운영할 수 있는 경우에 "
            "해당하지",
            "# 않는 것은? ( )",
            "① 갑",
            "② 을",
            "③ 병",
            "④ 정",
            "# 정답: ④.",
        ],
        [
            "# ※ 다음을 읽고 알맞은 답을 고르시오(1~2번).",
            "# 01 다음 중 틀린 것은? ( )",
            "① 하나",
            "② 둘",
            "③ 셋",
            "④ 넷",
            "# 정답: ①",
            "# 02 소득 증빙이 어려워 신고소득으로 연소득을 산정하려 한다.",
            "다음 중 잘못된 업무처리 방법은? ( )",
            "① 가",
            "② 나",
            "③ 다",
            "④ 라",
            "# 정답: ③",
            "③ 잘못된 이유",
        ],
    )


def test_question_bank_with_bare_numbers_and_inline_answers() -> None:
    document = _question_bank()
    result = QuestionExtractor().extract(document, document_id="d")
    assert [q.number for q in result.questions] == [1, 2, 3, 1, 2]
    assert [d.id for d in result.drafts] == [
        "d-q001-1",
        "d-q002-1",
        "d-q003",
        "d-q001-2",
        "d-q002-2",
    ]
    q1, q2, q3, q4, q5 = result.drafts
    assert q1.stem == "예금 거래에 관한 설명 중 틀린 것은? ( )"
    assert [o.text for o in q1.options] == [
        "첫째 설명이다.",
        "둘째 설명이다.",
        "셋째 설명이다.",
        "넷째 설명이다.",
    ]
    assert q3.stem == (
        "기업여신 관리점 일원화 원칙에도 불구하고 관리점을 달리 운영할 수 있는 경우에 "
        "해당하지 않는 것은? ( )"
    )
    assert q5.stem == (
        "소득 증빙이 어려워 신고소득으로 연소득을 산정하려 한다. "
        "다음 중 잘못된 업무처리 방법은? ( )"
    )
    for draft in result.drafts:
        assert draft.question_type is QuestionType.MCQ
        assert [o.id for o in draft.options] == ["opt-1", "opt-2", "opt-3", "opt-4"]
    # Answers come from each question's own printed 정답 line, even with repeated numbers.
    assert [d.correct_option_ids for d in result.drafts] == [
        ("opt-2",),
        ("opt-3",),
        ("opt-4",),
        ("opt-1",),
        ("opt-3",),
    ]
    # The printed explanation is kept as the draft's explanation, never as options.
    assert q1.explanation == "② 둘째 설명은 이렇게 고쳐야 함"
    assert q2.explanation == "해설 첫 줄\n∙ 해설 둘째 줄"
    assert q3.explanation is None
    assert q4.explanation is None
    issues = {c for d in result.drafts for c in _codes(d.validations)}
    assert not issues & {
        "duplicate_question_number",
        "duplicate_option_label",
        "option_sequence_gap",
        "answer_key_unmapped",
    }
    assert result.warnings == ()
    assert all(d.review_status is ReviewStatus.PENDING for d in result.drafts)


def test_question_bank_evidence_covers_stem_and_every_option_only() -> None:
    document = _question_bank()
    by_id = {b.id: b for b in document.blocks}
    result = QuestionExtractor().extract(document, document_id="d")
    q2 = result.drafts[1]
    (evidence,) = q2.evidence
    texts = [by_id[b].text for b in evidence.block_ids]
    assert texts == [
        "02 이율 변경 시 처리로 맞는 것은? ( )",
        "① 가를 안내하였다.",
        "② 나를 안내하였다.",
        "③ 다를 안내하였다.",
        "④ 라를 안내하였다.",
    ]
    # One region per page: the stem and options on page 1, the rest of the options on page 2.
    assert [loc.page for loc in evidence.locations] == [1, 2]
    first, second = evidence.locations
    assert first.bbox is not None
    assert second.bbox is not None
    stem_box = by_id[evidence.block_ids[0]].locations[0].bbox
    last_box = by_id[evidence.block_ids[-1]].locations[0].bbox
    assert stem_box is not None
    assert last_box is not None
    assert first.bbox.y0 == stem_box.y0
    assert second.bbox.y1 == last_box.y1


def test_bare_numbered_lines_without_question_cues_are_not_questions() -> None:
    result = _extract(
        ["3 문제은행 및 해설 문제풀이", "2026 개정판", "# 1 서론", "본문 문장입니다."]
    )
    assert result.questions == ()


def test_question_bank_llm_sees_only_its_own_answer_line_and_cannot_change_it() -> None:
    document = _question_bank()
    plain = QuestionExtractor().extract(document, document_id="d").drafts
    requests = llm_requests(document)
    assert [n for n, _ in requests] == [1, 2, 3, 1, 2]
    keys = ["②", "③", "④", "①", "③"]
    client = FakeLLMClient(model_name="fake-llm-1")
    for i, ((_, request), draft) in enumerate(zip(requests, plain, strict=True)):
        assert f"정답: {keys[i]}" in request.prompt
        assert all(f"정답: {k}" not in request.prompt for k in set(keys) - {keys[i]})
        assert "해설 첫 줄" not in request.prompt  # the explanation is not sent
        wrong = i == 3
        client.script(
            request,
            LLMQuestion(
                question_type="MCQ",
                multi_select=False,
                stem=draft.stem,
                options=[LLMOption(label=o.id[4:], text=o.text) for o in draft.options],
                answer=LLMAnswer(option_labels=["②" if wrong else keys[i]], text_answers=None),
            ),
        )
    refined = QuestionExtractor(client).extract(document, document_id="d")
    assert all(q.refined_by_llm for q in refined.questions)
    assert [d.correct_option_ids for d in refined.drafts] == [d.correct_option_ids for d in plain]
    assert "llm_answer_rejected" in _codes(refined.drafts[3].validations)
    assert refined.drafts[1].explanation == plain[1].explanation


def test_numbered_explanation_after_an_inline_answer_is_not_a_question() -> None:
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "정답: ②",
            "1. 첫 번째 이유입니다.",
            "2. 두 번째 이유입니다.",
            "2. 다음 중 틀린 것은?",
            "① 다",
            "② 라",
            "정답: ①",
            "1. 셋째 이유입니다.",
            "2. 넷째 이유입니다.",
        ]
    )
    assert [q.number for q in result.questions] == [1, 2]
    q1, q2 = result.drafts
    assert q1.explanation == "1. 첫 번째 이유입니다.\n2. 두 번째 이유입니다."
    assert q2.explanation == "1. 셋째 이유입니다.\n2. 넷째 이유입니다."
    assert [d.correct_option_ids for d in result.drafts] == [("opt-2",), ("opt-1",)]


def test_question_after_an_inline_answer_with_its_cue_on_a_later_line() -> None:
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "정답: ②",
            "1. 첫 번째 이유입니다.",
            "2. 다음 글을 읽고",
            "물음에 답하시오.",
            "① 다",
            "② 라",
            "③ 마",
            "④ 바",
            "정답: ③",
            "3. 다음 중 틀린 것은?",
            "① 사",
            "② 아",
            "정답: ①",
            "1. 마지막 이유입니다.",
        ]
    )
    assert [q.number for q in result.questions] == [1, 2, 3]
    q1, q2, q3 = result.drafts
    assert q1.explanation == "1. 첫 번째 이유입니다."
    assert q2.stem == "다음 글을 읽고 물음에 답하시오."
    assert len(q2.options) == 4
    assert [d.correct_option_ids for d in result.drafts] == [("opt-2",), ("opt-3",), ("opt-1",)]
    assert q3.explanation == "1. 마지막 이유입니다."


def test_numbered_explanation_line_then_a_section_heading_ends_the_explanation() -> None:
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "정답: ②",
            "1. 첫 번째 이유입니다.",
            "# 다음 단원",
            "안내 문장입니다.",
            "2. 다음 중 틀린 것은?",
            "① 다",
            "② 라",
            "정답: ①",
        ]
    )
    assert [q.number for q in result.questions] == [1, 2]
    q1, q2 = result.drafts
    assert q1.explanation == "1. 첫 번째 이유입니다."
    assert q2.correct_option_ids == ("opt-1",)


def test_caption_like_line_after_a_numbered_explanation_line_stays_in_the_explanation() -> None:
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "정답: ②",
            "1. 첫 번째 이유입니다.",
            "[그림 1] 설명 문장입니다.",
            "2. 두 번째 이유입니다.",
        ]
    )
    (draft,) = result.drafts
    assert draft.explanation == (
        "1. 첫 번째 이유입니다.\n[그림 1] 설명 문장입니다.\n2. 두 번째 이유입니다."
    )
    assert len(draft.evidence) == 1


def test_question_after_an_explanation_with_inline_options_on_a_continuation_line() -> None:
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "정답: ②",
            "1. 첫 번째 이유입니다.",
            "2. 다음 빈칸에 들어갈",
            "알맞은 말: ① 응결 ② 증발",
        ]
    )
    assert [q.number for q in result.questions] == [1, 2]
    q1, q2 = result.drafts
    assert q1.explanation == "1. 첫 번째 이유입니다."
    assert [(o.id, o.text) for o in q2.options] == [("opt-1", "응결"), ("opt-2", "증발")]
    assert q2.correct_option_ids is None  # no printed answer: stays a draft without one


_LayoutBlock = tuple[str, str] | tuple[str, tuple[tuple[str, ...], ...]]

# The same question 2 in every option layout the segmenter reads; it has no question cue and no
# printed answer, so each must be recognised by its options alone.
_OPTION_LAYOUTS: dict[str, list[_LayoutBlock]] = {
    "inline": [("text", "2. 알맞은 말 ① 응결 ② 증발")],
    "inline_continuation": [("text", "2. 빈칸에 들어갈"), ("text", "알맞은 말 ① 응결 ② 증발")],
    "line_by_line": [("text", "2. 알맞은 말"), ("text", "① 응결"), ("text", "② 증발")],
    "table": [("text", "2. 알맞은 말"), ("table", (("①", "응결"), ("②", "증발")))],
    "continuation_table": [
        ("text", "2. 알맞은 말"),
        ("table", (("①", "응결"), ("②", "증발"))),
        ("table", (("③", "강수"),)),
    ],
    "grid": [("text", "2. 알맞은 말"), ("text", "① 응결 ③ 강수"), ("text", "② 증발 ④ 바람")],
}


@pytest.mark.parametrize("layout", sorted(_OPTION_LAYOUTS))
def test_every_option_layout_is_a_question_after_an_inline_answer_explanation(
    layout: str,
) -> None:
    page = PageInfo(page=1, width=595.0, height=842.0)
    specs: list[_LayoutBlock] = [
        ("text", "1. 다음 중 옳은 것은?"),
        ("text", "① 가"),
        ("text", "② 나"),
        ("heading", "정답: ②"),
        ("text", "1. 첫 번째 이유입니다."),
        *_OPTION_LAYOUTS[layout],
    ]
    blocks = []
    for i, (kind, content) in enumerate(specs):
        loc = (SourceLocation(page=1, bbox=BBox(x0=60, y0=40 + 20 * i, x1=500, y1=55 + 20 * i)),)
        if kind == "table":
            rows = content
            assert isinstance(rows, tuple)
            blocks.append(
                Block(
                    id=f"b{i}",
                    type=BlockType.TABLE,
                    text="\n".join(" | ".join(r) for r in rows),
                    locations=loc,
                    table=TableContent(rows=rows),
                )
            )
        else:
            assert isinstance(content, str)
            block_type = BlockType.HEADING if kind == "heading" else BlockType.TEXT
            blocks.append(Block(id=f"b{i}", type=block_type, text=content, locations=loc))
    doc = ParsedDocument(
        source_path="l.pdf",
        source_sha256="3" * 64,
        parser_version="test",
        pages=(page,),
        blocks=tuple(blocks),
    )
    result = QuestionExtractor().extract(doc, document_id="l")
    assert [q.number for q in result.questions] == [1, 2]
    q1, q2 = result.drafts
    assert q1.explanation == "1. 첫 번째 이유입니다."
    assert len(q2.options) >= 2
    assert q2.correct_option_ids is None


def test_option_grid_read_row_wise_is_put_back_in_label_order() -> None:
    result = _extract(["# 01 옳은 것은? ( )", "① 가", "③ 다", "② 나", "④ 라", "# 정답: ③"])
    (draft,) = result.drafts
    assert [(o.id, o.text) for o in draft.options] == [
        ("opt-1", "가"),
        ("opt-2", "나"),
        ("opt-3", "다"),
        ("opt-4", "라"),
    ]
    assert draft.correct_option_ids == ("opt-3",)
    assert "option_sequence_gap" not in _codes(draft.validations)


def test_options_printed_as_table_rows() -> None:
    page = PageInfo(page=1, width=595.0, height=842.0)

    def block(i: int, text: str, **kw: object) -> Block:
        y0 = 60.0 + 20 * i
        return Block(
            id=f"b{i}",
            type=kw.pop("type", BlockType.TEXT),  # type: ignore[arg-type]
            text=text,
            locations=(SourceLocation(page=1, bbox=BBox(x0=60, y0=y0, x1=500, y1=y0 + 15)),),
            **kw,  # type: ignore[arg-type]
        )

    rows = (
        ("보기", "(가)", "(나)"),
        ("①", "6개월", "1년"),
        ("②", "1년", "1년"),
        ("③", "6개월", "6개월"),
    )
    doc = ParsedDocument(
        source_path="t.pdf",
        source_sha256="1" * 64,
        parser_version="test",
        pages=(page,),
        blocks=(
            block(0, "05 (가)~(나)에 들어갈 기간이 맞는 것은? ( )", type=BlockType.HEADING),
            block(1, "- 이직기간이 (가) 이상인 경우"),
            block(
                2,
                "\n".join(" | ".join(r) for r in rows),
                type=BlockType.TABLE,
                table=TableContent(rows=rows, header_rows=1),
            ),
            block(3, "정답: ①", type=BlockType.HEADING),
        ),
    )
    (draft,) = QuestionExtractor().extract(doc, document_id="t").drafts
    assert draft.question_type is QuestionType.MCQ
    assert draft.stem == (
        "(가)~(나)에 들어갈 기간이 맞는 것은? ( ) - 이직기간이 (가) 이상인 경우 보기 | (가) | (나)"
    )
    assert [(o.id, o.text) for o in draft.options] == [
        ("opt-1", "6개월 | 1년"),
        ("opt-2", "1년 | 1년"),
        ("opt-3", "6개월 | 6개월"),
    ]
    assert draft.correct_option_ids == ("opt-1",)
    assert draft.evidence[0].block_ids == ("b0", "b1", "b2")


def test_option_table_continued_on_the_next_page_keeps_every_option() -> None:
    pages = (
        PageInfo(page=1, width=595.0, height=842.0),
        PageInfo(page=2, width=595.0, height=842.0),
    )

    def block(i: int, page: int, text: str, **kw: object) -> Block:
        y0 = 60.0 + 20 * i
        return Block(
            id=f"b{i}",
            type=kw.pop("type", BlockType.TEXT),  # type: ignore[arg-type]
            text=text,
            locations=(SourceLocation(page=page, bbox=BBox(x0=60, y0=y0, x1=500, y1=y0 + 15)),),
            **kw,  # type: ignore[arg-type]
        )

    def table(i: int, page: int, rows: tuple[tuple[str, ...], ...]) -> Block:
        text = "\n".join(" | ".join(r) for r in rows)
        return block(i, page, text, type=BlockType.TABLE, table=TableContent(rows=rows))

    doc = ParsedDocument(
        source_path="t.pdf",
        source_sha256="1" * 64,
        parser_version="test",
        pages=pages,
        blocks=(
            block(0, 1, "07 (가)에 들어갈 기간이 맞는 것은? ( )", type=BlockType.HEADING),
            table(1, 1, (("보기", "(가)"), ("①", "1개월"), ("②", "2개월"))),
            table(2, 2, (("③", "3개월"), ("④", "4개월"))),
            block(3, 2, "정답: ④", type=BlockType.HEADING),
        ),
    )
    (draft,) = QuestionExtractor().extract(doc, document_id="t").drafts
    assert [(o.id, o.text) for o in draft.options] == [
        ("opt-1", "1개월"),
        ("opt-2", "2개월"),
        ("opt-3", "3개월"),
        ("opt-4", "4개월"),
    ]
    assert draft.correct_option_ids == ("opt-4",)
    assert draft.evidence[0].block_ids == ("b0", "b1", "b2")
    assert [loc.page for loc in draft.evidence[0].locations] == [1, 2]
    ((_, request),) = llm_requests(doc)
    assert "③ | 3개월" in request.prompt  # the continuation table is refined with the rest


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


Rows = tuple[tuple[str, ...], ...]


def _table_answers(rows: Rows) -> tuple[list[str | None], set[str]]:
    """Answers of three short-answer questions read from an answer-key table."""
    loc = (SourceLocation(page=1),)
    questions = [
        Block(id=f"q{n}", type=BlockType.TEXT, text=f"{n}. 값을 쓰시오.", locations=loc)
        for n in (1, 2, 3)
    ]
    doc = ParsedDocument(
        source_path="t.pdf",
        source_sha256="3" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=(
            *questions,
            Block(id="h", type=BlockType.HEADING, text="정답", locations=loc),
            Block(
                id="t",
                type=BlockType.TABLE,
                text="\n".join(" | ".join(row) for row in rows),
                locations=loc,
                table=TableContent(rows=rows),
            ),
        ),
    )
    result = QuestionExtractor().extract(doc, document_id="t")
    answers = [d.accepted_answers[0] if d.accepted_answers else None for d in result.drafts]
    return answers, _codes(result.warnings)


@pytest.mark.parametrize(
    "rows",
    [
        (("1", "3"), ("2", "4"), ("3", "1")),  # one question per row: number -> answer
        (("번호", "정답"), ("1", "3"), ("2", "4"), ("3", "1")),
        (("1", "2", "3"), ("3", "4", "1")),  # one question per column
        (("번호", "1", "2", "3"), ("정답", "3", "4", "1")),
        (("1", "3", "3", "1"), ("2", "4", "", "")),  # two number/answer column pairs
    ],
    ids=[
        "numeric-vertical",
        "labelled-vertical",
        "numeric-horizontal",
        "labelled-horizontal",
        "vertical-two-pairs",
    ],
)
def test_answer_table_orientation(rows: Rows) -> None:
    answers, warnings = _table_answers(rows)
    assert answers == ["3", "4", "1"]
    assert "answer_key_table_ambiguous" not in warnings


@pytest.mark.parametrize(
    "rows",
    [
        (("1", "2"), ("3", "4")),  # 1->2, 3->4 by rows or 1->3, 2->4 by columns
        (("1", "2"), ("2", "3")),
        (("번호", "정답"), ("정답", "1")),  # labels both across and down
    ],
)
def test_ambiguous_answer_table_gives_no_answers(rows: Rows) -> None:
    answers, warnings = _table_answers(rows)
    assert answers == [None, None, None]
    assert "answer_key_table_ambiguous" in warnings


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


_BANK_PAGES: tuple[tuple[tuple[str, float], ...], ...] = (
    (
        ("01 물의 순환에 관한 설명 중 옳은 것은? ( )", 13.0),
        ("① 증발은 기체가 액체로 변하는 현상이다.", 11.0),
        ("② 응결은 액체가 기체로 변하는 현상이다.", 11.0),
        ("③ 강수는 구름에서 비나 눈이 내리는 현상이다.", 11.0),
        ("④ 바다에는 물이 없다.", 11.0),
        ("정답: ③", 13.0),
        ("③ 강수는 구름에서 내리는 비와 눈이다.", 11.0),
        ("02 다음 중 응결에 관한 설명으로 옳은 것은? ( )", 13.0),
        ("① 기체가 액체로 변한다.", 11.0),
        ("② 액체가 기체로 변한다.", 11.0),
    ),
    (
        ("③ 고체가 기체로 변한다.", 11.0),
        ("④ 기체가 고체로 변한다.", 11.0),
        ("정답: ①", 13.0),
        ("01 다음 중 강수에 해당하는 것은? ( )", 13.0),
        ("① 비", 11.0),
        ("② 구름", 11.0),
        ("③ 바다", 11.0),
        ("④ 증발", 11.0),
        ("정답: ①", 13.0),
    ),
)


@pytest.mark.models
def test_question_bank_on_real_docling_output(tmp_path: Path) -> None:
    """A synthetic question bank (bare ``01`` numbers, inline ``정답:`` lines, numbering that
    restarts, options running onto the next page) through the real parser."""
    from book_core.parser.docling_adapter import DoclingParser
    from make_fixture_pdfs import REGULAR, _check_glyphs, _register_fonts
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen.canvas import Canvas

    _register_fonts()
    pdf = tmp_path / "bank.pdf"
    canvas = Canvas(str(pdf), pagesize=A4, invariant=True)
    for page in _BANK_PAGES:
        y = A4[1] - 90
        for text, size in page:
            _check_glyphs(text, REGULAR)
            canvas.setFont(REGULAR, size)
            canvas.drawString(72 if text[0].isdigit() or text.startswith("정답") else 90, y, text)
            y -= 26
        canvas.showPage()
    canvas.save()

    document = DoclingParser().parse(pdf)
    result = QuestionExtractor().extract(document, document_id="bank")
    assert [q.number for q in result.questions] == [1, 2, 1]
    assert [len(d.options) for d in result.drafts] == [4, 4, 4]
    assert [d.correct_option_ids for d in result.drafts] == [("opt-3",), ("opt-1",), ("opt-1",)]
    assert result.drafts[0].explanation == "③ 강수는 구름에서 내리는 비와 눈이다."
    # Question 2 is highlighted on both pages: its stem and options, never its answer line.
    by_id = {b.id: b for b in document.blocks}
    (evidence,) = result.drafts[1].evidence
    assert [loc.page for loc in evidence.locations] == [1, 2]
    assert not any("정답" in by_id[b].text for b in evidence.block_ids)


# ------------------------------------------------------------------------------------------
# Chapter-aware segmentation (UX6-UPLOAD-B): chapter splits never change what a paper means


def test_an_answer_appendix_with_chapter_headings_stays_an_answer_key() -> None:
    """``정답`` then ``Chapter 1`` / ``1. ①`` / ``Chapter 2`` / ``2. ②``: the chapter headings
    inside the answer section do not end it (Codex P2)."""
    result = _extract(
        [
            "1. 다음 중 옳은 것은?",
            "① 가",
            "② 나",
            "2. 다음 중 틀린 것은?",
            "① 가",
            "② 나",
            "정답",
            "# Chapter 1",
            "1. ①",
            "# Chapter 2",
            "2. ②",
        ]
    )
    assert [q.number for q in result.questions] == [1, 2]
    assert [d.correct_option_ids for d in result.drafts] == [("opt-1",), ("opt-2",)]


def test_a_back_of_book_key_with_chapter_subheadings_answers_each_chapter() -> None:
    """Numbering restarts per chapter and the key at the back repeats the chapter headings
    (``제1장`` ... ``1. ③``): each chapter's questions take their chapter's answers."""

    def chapter(n: int) -> list[str]:
        return [
            f"# 제{n}장 수신 제도 {n}",
            f"1. 제{n}장 첫 문제: 옳은 것은?",
            "① 가",
            "② 나",
            "③ 다",
            "④ 라",
            f"2. 제{n}장 둘째 문제: 틀린 것은?",
            "① 가",
            "② 나",
            "③ 다",
            "④ 라",
        ]

    result = _extract(
        chapter(1),
        chapter(2),
        [
            "# 정답 및 해설",
            "# 제1장 수신 제도 1",
            "1. ③ 2. ①",
            "# 제2장 수신 제도 2",
            "1. ② 2. ④",
        ],
    )
    assert [q.number for q in result.questions] == [1, 2, 1, 2]
    assert [d.correct_option_ids for d in result.drafts] == [
        ("opt-3",),
        ("opt-1",),
        ("opt-2",),
        ("opt-4",),
    ]


def test_a_later_chapter_keeps_its_figure_captions_in_reading_order() -> None:
    """Captions of chapters after the first get document-wide indices like the question lines,
    so the LLM sees the question before its figure caption (Codex P2)."""
    page = PageInfo(page=1, width=595.0, height=842.0)
    loc = (SourceLocation(page=1, bbox=BBox(x0=60, y0=60, x1=300, y1=200)),)

    def block(i: int, text: str, kind: BlockType = BlockType.TEXT, **kw: object) -> Block:
        return Block(id=f"b{i}", type=kind, text=text, locations=loc, **kw)  # type: ignore[arg-type]

    blocks = [
        block(0, "제1장 물의 순환", BlockType.HEADING, heading_level=1),
        *(block(i, f"본문 {i}번째 문단이다.") for i in range(1, 6)),
        block(6, "1. 증발의 뜻을 쓰시오."),
        block(7, "제2장 정수 처리", BlockType.HEADING, heading_level=1),
        block(8, "1. 아래 그림의 A 단계를 쓰시오."),
        block(9, "", BlockType.IMAGE, caption_block_id="b10"),
        block(10, "[그림 1] 정수장 배치도"),
    ]
    doc = ParsedDocument(
        source_path="f.pdf",
        source_sha256="3" * 64,
        parser_version="test",
        pages=(page,),
        blocks=tuple(blocks),
    )
    requests = dict(llm_requests(doc)[1:])
    prompt = requests[1].prompt
    assert prompt.index("1. 아래 그림의 A 단계를 쓰시오.") < prompt.index("[그림 1] 정수장 배치도")
    (_, second) = QuestionExtractor().extract(doc, document_id="f").drafts
    assert second.evidence[1].block_ids == ("b9", "b10")
