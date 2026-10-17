"""Variant generation and validation (Task M6.1, questions.md §5, QGEN-01-AC02..AC04)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from book_core.contracts import (
    DraftOrigin,
    Excerpt,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    SourceEvidence,
    SourceLocation,
    ValidationSeverity,
    VariationType,
)
from book_core.generation import (
    ACKNOWLEDGEABLE_CODES,
    GENERATE_TASKS,
    PROMPT_VERSIONS,
    REJECT_CODES,
    Difficulty,
    LLMVariantBatch,
    SourceQuestion,
    VariantGenerationResult,
    VariantGenerator,
    VariantRequest,
    build_request,
    source_fingerprint,
    validate_variant,
)
from book_core.llm import FakeLLMClient, LLMConfig, LLMProviderError
from book_core.llm.anthropic_client import AnthropicLLMClient, strict_json_schema
from book_core.question import question_fingerprint
from pydantic import SecretStr, ValidationError

PASSAGE_TEXT = (
    "물이 수증기로 변하는 현상을 증발이라고 한다.\n\n"
    "수증기가 물방울로 변하는 현상을 응결이라고 한다. 응결은 열을 방출한다."
)
PASSAGE = Excerpt(
    document_id="doc-1",
    revision_id="rev-1",
    text=PASSAGE_TEXT,
    block_ids=("b-1", "b-2"),
    matched_block_ids=("b-2",),
    locations=(SourceLocation(page=3), SourceLocation(page=4)),
    breadcrumb=("과학", "2장 물의 순환"),
)
OTHER_PASSAGE = Excerpt(
    document_id="doc-1",
    revision_id="rev-1",
    text="얼음이 물로 변하는 현상을 융해라고 한다. 융해는 열을 흡수한다.",
    block_ids=("b-9",),
    locations=(SourceLocation(page=7),),
)
SOURCE_EVIDENCE = SourceEvidence(
    document_id="qdoc-1", revision_id="qrev-1", locations=(SourceLocation(page=1),)
)
SOURCE = SourceQuestion(
    question_id="q-1",
    revision_id="qr-1",
    question_type=QuestionType.MCQ,
    stem="물의 상태 변화에 대한 설명으로 옳지 않은 것은?",
    options=(
        QuestionOption(id="opt-1", text="증발은 물이 수증기로 변하는 현상이다."),
        QuestionOption(id="opt-2", text="응결은 수증기가 물방울로 변하는 현상이다."),
        QuestionOption(id="opt-3", text="응결은 열을 흡수한다."),
        QuestionOption(id="opt-4", text="증발은 액체에서 기체로의 변화이다."),
    ),
    correct_option_ids=("opt-3",),
    evidence=(SOURCE_EVIDENCE,),
)
CITATION = {"passage_id": "P1", "quote": "응결은 열을 방출한다."}
BOOK_MARKER = "PRIVATE-BOOK-TEXT-4711"


def candidate(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "question_type": "MCQ",
        "multi_select": False,
        "stem": "물의 상태 변화를 설명한 것 중 잘못된 것을 고르시오.",
        "options": [
            {"label": "1", "text": "물이 수증기가 되는 것을 증발이라 한다."},
            {"label": "2", "text": "수증기가 물방울이 되는 것을 응결이라 한다."},
            {"label": "3", "text": "응결이 일어날 때 열을 흡수한다."},
            {"label": "4", "text": "증발은 액체가 기체로 바뀌는 변화이다."},
        ],
        "correct_option_labels": ["3"],
        "accepted_answers": None,
        "explanation": "응결은 열을 방출한다.",
        "justification": "지문에 응결은 열을 방출한다고 되어 있다.",
        "citations": [CITATION],
    }
    base.update(overrides)
    return base


def run(
    *candidates: dict[str, Any],
    variation: VariationType = VariationType.PARAPHRASE,
    passages: tuple[Excerpt, ...] = (PASSAGE,),
    **request: Any,
) -> tuple[VariantGenerationResult, FakeLLMClient]:
    llm = FakeLLMClient(model_name="fake-claude")
    llm.script(GENERATE_TASKS[variation], {"candidates": list(candidates)})
    req = VariantRequest(
        source=request.pop("source", SOURCE),
        variation_types=(variation,),
        candidate_count=request.pop("candidate_count", max(1, len(candidates))),
        passages=passages,
        **request,
    )
    return VariantGenerator(llm).generate(req), llm


def codes(issues: Any) -> set[str]:
    return {i.code for i in issues}


def rejected_codes(result: VariantGenerationResult) -> list[set[str]]:
    return [codes(r.reasons) for r in result.rejected]


# ------------------------------------------------------------------------------------------
# Happy paths


def test_paraphrase_becomes_pending_generated_draft_with_lineage_and_evidence() -> None:
    result, llm = run(candidate())

    assert result.rejected == ()
    (variant,) = result.variants
    draft = variant.draft
    assert draft.origin is DraftOrigin.GENERATION
    assert draft.review_status is ReviewStatus.PENDING
    assert draft.variation_type is VariationType.PARAPHRASE
    assert draft.parent_question_id == "q-1"
    assert draft.source_question_revision_id == "qr-1"
    assert draft.id == "qr-1-paraphrase-00"
    assert draft.generator is not None
    assert draft.generator.model == "fake-claude"
    assert draft.generator.prompt_version == "questions.generate.paraphrase/v1"
    assert [o.id for o in draft.options] == ["opt-1", "opt-2", "opt-3", "opt-4"]
    assert draft.correct_option_ids == ("opt-3",)
    assert draft.justification
    (evidence,) = draft.evidence
    assert evidence.document_id == "doc-1"
    assert evidence.revision_id == "rev-1"
    assert evidence.block_ids == ("b-1", "b-2")
    assert evidence.locations == PASSAGE.locations
    assert evidence.quote == "응결은 열을 방출한다."
    assert not draft.has_blocking_issues
    assert draft.validations == ()
    assert variant.fingerprint == question_fingerprint(
        question_type=draft.question_type,
        stem=draft.stem,
        options=draft.options,
        correct_option_ids=draft.correct_option_ids,
    )
    assert len(result.llm_calls) == 1
    assert result.llm_calls[0].task == "questions.generate.paraphrase"
    assert result.llm_usage.input_tokens > 0
    assert len(llm.calls) == 1


def test_request_is_versioned_deterministic_and_carries_source_and_passages() -> None:
    req = build_request(
        VariationType.INVERT_POLARITY,
        SOURCE,
        (PASSAGE, OTHER_PASSAGE),
        candidate_count=3,
        difficulty=Difficulty.HARDER,
    )
    again = build_request(
        VariationType.INVERT_POLARITY,
        SOURCE,
        (PASSAGE, OTHER_PASSAGE),
        candidate_count=3,
        difficulty=Difficulty.HARDER,
    )
    assert req.fingerprint() == again.fingerprint()
    assert req.task == "questions.generate.invert_polarity"
    assert req.prompt_version == PROMPT_VERSIONS[VariationType.INVERT_POLARITY]
    assert "INVERT_POLARITY" in (req.system or "")
    assert "harder" in (req.system or "")
    assert "Write 3 distinct candidate(s)." in req.prompt
    assert "[P1] 과학 > 2장 물의 순환\n" in req.prompt
    assert "[P2]\n얼음이" in req.prompt
    assert SOURCE.stem in req.prompt
    assert "correct options: 3" in req.prompt
    no_passages = build_request(VariationType.PARAPHRASE, SOURCE, (), candidate_count=1)
    assert "PASSAGES: (none" in no_passages.prompt
    assert no_passages.fingerprint() != req.fingerprint()


def test_short_answer_and_essay_variants() -> None:
    source = SourceQuestion(
        question_id="q-2",
        revision_id="qr-2",
        question_type=QuestionType.SHORT_ANSWER,
        stem="수증기가 물방울로 변하는 현상은?",
        accepted_answers=("응결",),
    )
    result, _ = run(
        candidate(
            question_type="SHORT_ANSWER",
            stem="수증기가 냉각되어 물방울이 맺히는 현상의 이름은?",
            options=[],
            correct_option_labels=[],
            accepted_answers=[" 응결 ", "응축"],
        ),
        source=source,
    )
    (draft,) = result.drafts
    assert draft.accepted_answers == ("응결", "응축")
    assert draft.correct_option_ids is None
    assert draft.options == ()

    essay = source.model_copy(
        update={"question_type": QuestionType.ESSAY, "accepted_answers": None}
    )
    result, _ = run(
        candidate(
            question_type="ESSAY",
            stem="응결이 일어날 때 열의 출입을 설명하시오.",
            options=[],
            correct_option_labels=None,
            accepted_answers=None,
        ),
        source=essay,
    )
    (draft,) = result.drafts
    assert "answer_missing" not in codes(draft.validations)


def test_option_labels_map_to_stable_ids_in_display_order() -> None:
    result, _ = run(
        candidate(
            options=[
                {"label": "①", "text": "가"},
                {"label": "②", "text": "나"},
                {"label": "③", "text": "다"},
            ],
            correct_option_labels=["③"],
        )
    )
    (draft,) = result.drafts
    assert [(o.id, o.text) for o in draft.options] == [
        ("opt-1", "가"),
        ("opt-2", "나"),
        ("opt-3", "다"),
    ]
    assert draft.correct_option_ids == ("opt-3",)


# ------------------------------------------------------------------------------------------
# INVERT_POLARITY (QGEN-01-AC03) and answer count


def test_inversion_with_multiple_answers_warns_and_blocks_approval() -> None:
    inverted = candidate(
        stem="물의 상태 변화에 대한 설명으로 옳은 것을 모두 고르시오.",
        multi_select=True,
        correct_option_labels=["1", "2", "4"],
    )
    result, _ = run(inverted, variation=VariationType.INVERT_POLARITY)

    (draft,) = result.drafts
    (count,) = [v for v in draft.validations if v.code == "answer_count_changed"]
    assert count.severity is ValidationSeverity.ERROR
    assert "1 to 3" in count.message
    assert draft.has_blocking_issues
    assert "polarity_unchanged" not in codes(draft.validations)
    with pytest.raises(ValidationError, match="cannot be approved"):
        QuestionDraft.model_validate({**draft.model_dump(), "review_status": "approved"})

    # The reviewer confirms the multi-select question: the issue stays visible as a warning.
    confirmed = validate_variant(
        draft, source=SOURCE, passages=(PASSAGE,), acknowledged={"answer_count_changed"}
    )
    (count,) = [v for v in confirmed if v.code == "answer_count_changed"]
    assert count.severity is ValidationSeverity.WARNING
    assert not any(v.severity is ValidationSeverity.ERROR for v in confirmed)
    approved = draft.model_copy(update={"validations": confirmed})
    QuestionDraft.model_validate({**approved.model_dump(), "review_status": "approved"})


def test_inversion_that_keeps_the_polarity_gets_a_warning() -> None:
    result, _ = run(candidate(), variation=VariationType.INVERT_POLARITY)
    (draft,) = result.drafts
    (warning,) = [v for v in draft.validations if v.code == "polarity_unchanged"]
    assert warning.severity is ValidationSeverity.WARNING


def test_paraphrase_that_changes_answer_count_or_type_is_blocking() -> None:
    result, _ = run(candidate(correct_option_labels=["1", "3"], multi_select=True))
    (draft,) = result.drafts
    assert "answer_count_changed" in codes(draft.validations)
    assert draft.has_blocking_issues

    result, _ = run(
        candidate(
            question_type="SHORT_ANSWER",
            options=[],
            correct_option_labels=None,
            accepted_answers=["응결은 열을 흡수한다"],
        )
    )
    (draft,) = result.drafts
    assert "question_type_changed" in codes(draft.validations)
    assert draft.has_blocking_issues
    assert {"answer_count_changed", "question_type_changed"} == ACKNOWLEDGEABLE_CODES


def test_multi_flag_inconsistent_with_answer_is_flagged() -> None:
    result, _ = run(candidate(multi_select=True))
    (draft,) = result.drafts
    assert "mcq_multi_inconsistent" in codes(draft.validations)


def test_paraphrase_with_unchanged_stem_is_flagged() -> None:
    result, _ = run(candidate(stem=" 물의 상태 변화에 대한  설명으로 옳지 않은 것은? "))
    (draft,) = result.drafts
    assert "stem_unchanged" in codes(draft.validations)


# ------------------------------------------------------------------------------------------
# ANALOGOUS_CONCEPT (QGEN-01-AC04) and sources


def test_analogous_concept_needs_passages_and_cites_them() -> None:
    with pytest.raises(ValidationError, match="ANALOGOUS_CONCEPT needs source passages"):
        VariantRequest(source=SOURCE, variation_types=(VariationType.ANALOGOUS_CONCEPT,))

    result, _ = run(
        candidate(
            stem="융해에 대한 설명으로 옳지 않은 것은?",
            options=[
                {"label": "1", "text": "얼음이 물로 변하는 현상이다."},
                {"label": "2", "text": "융해는 열을 방출한다."},
            ],
            correct_option_labels=["2"],
            citations=[{"passage_id": "[p2]", "quote": "융해는  열을\n흡수한다."}],
        ),
        variation=VariationType.ANALOGOUS_CONCEPT,
        passages=(PASSAGE, OTHER_PASSAGE),
    )
    (draft,) = result.drafts
    (evidence,) = draft.evidence
    assert evidence.block_ids == ("b-9",)
    assert evidence.locations == (SourceLocation(page=7),)
    assert not draft.has_blocking_issues


def test_citing_a_passage_already_in_the_source_evidence_counts_as_cited() -> None:
    # The source was itself generated: its evidence is the very passage+quote cited again.
    first, _ = run(candidate())
    cited = first.drafts[0].evidence
    source = SOURCE.model_copy(update={"evidence": cited})

    result, _ = run(candidate(), source=source)
    assert result.rejected == ()
    (draft,) = result.drafts
    assert draft.evidence == cited
    assert "source_not_cited" not in codes(draft.validations)
    assert validate_variant(draft, source=source, passages=(PASSAGE,)) == draft.validations

    # Inherited provenance alone still does not cite a supplied passage.
    other = SOURCE.model_copy(update={"evidence": (*SOURCE.evidence, *cited)})
    issues = validate_variant(
        draft.model_copy(update={"evidence": SOURCE.evidence}),
        source=other,
        passages=(PASSAGE,),
    )
    assert "source_not_cited" in codes(issues)


def test_without_passages_the_draft_inherits_the_source_provenance() -> None:
    result, _ = run(candidate(citations=[]), passages=())
    (draft,) = result.drafts
    assert draft.evidence == (SOURCE_EVIDENCE,)
    assert draft.validations == ()

    bare = SOURCE.model_copy(update={"evidence": ()})
    result, _ = run(candidate(citations=[]), passages=(), source=bare)
    (draft,) = result.drafts
    (missing,) = draft.validations
    assert missing.code == "provenance_missing"
    assert missing.severity is ValidationSeverity.WARNING


@pytest.mark.parametrize(
    ("citations", "code"),
    [
        ([], "source_not_cited"),
        ([{"passage_id": "P3", "quote": "응결은 열을 방출한다."}], "citation_unknown_passage"),
        ([{"passage_id": "P1", "quote": "응결은 열을 흡수한다."}], "citation_not_in_passage"),
        ([{"passage_id": "P1", "quote": "응결"}], "citation_too_short"),
        ([CITATION, {"passage_id": "P1", "quote": "지어낸 문장이다."}], "citation_not_in_passage"),
    ],
)
def test_invalid_citations_reject_the_candidate(citations: list[Any], code: str) -> None:
    result, _ = run(candidate(citations=citations))
    assert result.variants == ()
    assert rejected_codes(result) == [{code}]
    (rejected,) = result.rejected
    assert rejected.candidate_index == 0
    assert rejected.variation_type is VariationType.PARAPHRASE


def test_citations_without_passages_are_rejected() -> None:
    result, _ = run(candidate(), passages=())
    assert rejected_codes(result) == [{"citation_unknown_passage"}]


# ------------------------------------------------------------------------------------------
# Schema / answer rejections


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"stem": "   "}, "empty_stem"),
        ({"stem": "가" * 20001}, "stem_too_long"),
        ({"correct_option_labels": ["9"]}, "answer_not_in_options"),
        ({"correct_option_labels": None}, "answer_missing"),
        ({"correct_option_labels": []}, "empty_answer"),
        ({"correct_option_labels": ["3", "③"]}, "duplicate_answer_option"),
        ({"accepted_answers": ["응결"]}, "mcq_text_answer"),
        ({"options": [{"label": "1", "text": "하나"}], "correct_option_labels": ["1"]}, None),
        (
            {
                "options": [{"label": "1", "text": "가"}, {"label": "1", "text": "나"}],
                "correct_option_labels": ["1"],
            },
            "invalid_option_labels",
        ),
        (
            {
                "options": [{"label": "", "text": "가"}, {"label": "2", "text": "나"}],
                "correct_option_labels": ["2"],
            },
            "invalid_option_labels",
        ),
        (
            {
                "options": [{"label": "1", "text": " "}, {"label": "2", "text": "나"}],
                "correct_option_labels": ["2"],
            },
            "option_text_empty",
        ),
        (
            {
                "options": [{"label": "1", "text": "나 "}, {"label": "2", "text": "나"}],
                "correct_option_labels": ["2"],
            },
            "duplicate_option_text",
        ),
        (
            {
                "options": [{"label": "1", "text": "x" * 5001}, {"label": "2", "text": "나"}],
                "correct_option_labels": ["2"],
            },
            "option_text_too_long",
        ),
        (
            {
                "options": [{"label": str(i), "text": f"t{i}"} for i in range(51)],
                "correct_option_labels": ["1"],
            },
            "too_many_options",
        ),
        ({"justification": "  "}, "justification_missing"),
        ({"explanation": "x" * 20001}, "text_too_long"),
    ],
)
def test_invalid_mcq_candidates_are_rejected(overrides: dict[str, Any], code: str | None) -> None:
    result, _ = run(candidate(**overrides))
    assert result.variants == ()
    (reasons,) = rejected_codes(result)
    assert reasons <= REJECT_CODES
    if code is None:  # a one-option MCQ
        code = "mcq_too_few_options"
    assert code in reasons


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"accepted_answers": None}, "answer_missing"),
        ({"accepted_answers": []}, "answer_text_invalid"),
        ({"accepted_answers": ["  "]}, "answer_text_invalid"),
        ({"accepted_answers": ["x" * 1001]}, "answer_text_invalid"),
        ({"options": [{"label": "1", "text": "가"}]}, "options_not_allowed"),
        ({"correct_option_labels": ["1"]}, "answer_not_in_options"),
    ],
)
def test_invalid_short_answer_candidates_are_rejected(overrides: dict[str, Any], code: str) -> None:
    base = candidate(
        question_type="SHORT_ANSWER",
        options=[],
        correct_option_labels=None,
        accepted_answers=["응결"],
        stem="수증기가 물방울로 변하는 현상은?",
    )
    result, _ = run({**base, **overrides})
    assert result.variants == ()
    (reasons,) = rejected_codes(result)
    assert code in reasons


def test_schema_invalid_output_is_rejected_with_a_log_safe_reason() -> None:
    llm = FakeLLMClient()
    secret = BOOK_MARKER
    llm.script(
        GENERATE_TASKS[VariationType.PARAPHRASE],
        '{"candidates": [{"stem": "' + secret + '", "' + secret + '": 1}]}',
    )
    req = VariantRequest(source=SOURCE, variation_types=(VariationType.PARAPHRASE,))
    result = VariantGenerator(llm).generate(req)

    assert result.variants == ()
    (rejected,) = result.rejected
    assert rejected.candidate_index is None
    (reason,) = rejected.reasons
    assert reason.code == "llm_output_invalid"
    assert reason.severity is ValidationSeverity.ERROR
    assert secret not in rejected.model_dump_json()
    assert "<key>" in reason.message

    llm.script(GENERATE_TASKS[VariationType.PARAPHRASE], "not json at all")
    result = VariantGenerator(llm).generate(req)
    assert rejected_codes(result) == [{"llm_output_invalid"}]


def test_rejection_reasons_never_quote_the_candidate() -> None:
    secret = BOOK_MARKER
    result, _ = run(
        candidate(
            stem=secret,
            correct_option_labels=[secret],
            citations=[{"passage_id": secret, "quote": secret}],
        )
    )
    assert result.variants == ()
    assert secret not in result.model_dump_json()


def test_provider_failure_is_a_rejection_and_other_variations_still_run() -> None:
    llm = FakeLLMClient()
    llm.script(
        GENERATE_TASKS[VariationType.PARAPHRASE],
        LLMProviderError("provider returned 529", kind="http_status", status_code=529),
    )
    llm.script(
        GENERATE_TASKS[VariationType.INVERT_POLARITY],
        {"candidates": [candidate(stem="물의 상태 변화에 대한 설명으로 옳은 것은?")]},
    )
    req = VariantRequest(
        source=SOURCE,
        variation_types=(VariationType.PARAPHRASE, VariationType.INVERT_POLARITY),
        passages=(PASSAGE,),
    )
    result = VariantGenerator(llm).generate(req)

    assert [r.variation_type for r in result.rejected] == [VariationType.PARAPHRASE]
    (reason,) = result.rejected[0].reasons
    assert reason.code == "llm_unavailable"
    assert "http_status" in reason.message
    (draft,) = result.drafts
    assert draft.variation_type is VariationType.INVERT_POLARITY
    assert [c.task for c in llm.calls] == [
        "questions.generate.paraphrase",
        "questions.generate.invert_polarity",
    ]


def test_too_many_and_no_candidates() -> None:
    other = candidate(stem="상태 변화에 관한 진술 중 틀린 것은 무엇인가?")
    result, _ = run(candidate(), other, candidate_count=1)
    assert len(result.variants) == 1
    (over,) = result.rejected
    assert over.candidate_index == 1
    assert codes(over.reasons) == {"candidate_over_limit"}

    result, _ = run()
    assert result.variants == ()
    (none,) = result.rejected
    assert none.candidate_index is None
    assert codes(none.reasons) == {"no_candidates"}


# ------------------------------------------------------------------------------------------
# Duplicates (fingerprint)


def test_option_shuffle_of_the_source_is_a_duplicate() -> None:
    shuffled = candidate(
        stem=SOURCE.stem,
        options=[
            {"label": "A", "text": SOURCE.options[3].text},
            {"label": "B", "text": SOURCE.options[2].text},
            {"label": "C", "text": SOURCE.options[1].text},
            {"label": "D", "text": SOURCE.options[0].text},
        ],
        correct_option_labels=["B"],
    )
    result, _ = run(shuffled)
    assert rejected_codes(result) == [{"duplicate_of_source"}]


def test_duplicates_of_existing_questions_and_of_siblings_are_rejected() -> None:
    first, _ = run(candidate())
    existing = first.variants[0].fingerprint

    result, _ = run(candidate(), existing_fingerprints=frozenset({existing}))
    assert rejected_codes(result) == [{"duplicate_of_existing"}]

    # The second copy differs only in spacing, case and option order.
    copy = candidate(
        stem=candidate()["stem"].replace(" ", "  "),
        options=list(reversed(candidate()["options"])),
    )
    result, _ = run(candidate(), copy)
    assert len(result.variants) == 1
    (dup,) = result.rejected
    assert dup.candidate_index == 1
    assert codes(dup.reasons) == {"duplicate_candidate"}


def test_siblings_are_deduplicated_across_variation_types() -> None:
    llm = FakeLLMClient()
    for variation in (VariationType.PARAPHRASE, VariationType.ANALOGOUS_CONCEPT):
        llm.script(GENERATE_TASKS[variation], {"candidates": [candidate()]})
    req = VariantRequest(
        source=SOURCE,
        variation_types=(VariationType.PARAPHRASE, VariationType.ANALOGOUS_CONCEPT),
        passages=(PASSAGE,),
    )
    result = VariantGenerator(llm).generate(req)
    assert [d.variation_type for d in result.drafts] == [VariationType.PARAPHRASE]
    assert rejected_codes(result) == [{"duplicate_candidate"}]
    assert len(result.llm_calls) == 2


# ------------------------------------------------------------------------------------------
# Request validation


def test_option_shuffle_is_not_a_generation() -> None:
    with pytest.raises(ValidationError, match="OPTION_SHUFFLE does not generate questions"):
        VariantRequest(source=SOURCE, variation_types=(VariationType.OPTION_SHUFFLE,))


@pytest.mark.parametrize(
    "update",
    [
        {"variation_types": ()},
        {"variation_types": (VariationType.PARAPHRASE, VariationType.PARAPHRASE)},
        {"candidate_count": 0},
        {"candidate_count": 21},
        {"passages": (PASSAGE,) * 9},
        {"existing_fingerprints": frozenset({"not-a-digest"})},
    ],
)
def test_request_bounds(update: dict[str, Any]) -> None:
    base: dict[str, Any] = {"source": SOURCE, "variation_types": (VariationType.PARAPHRASE,)}
    with pytest.raises(ValidationError):
        VariantRequest.model_validate({**base, **update})


def test_source_question_answer_must_reference_its_options() -> None:
    with pytest.raises(ValidationError, match="correct_option_ids not among options"):
        SourceQuestion.model_validate({**SOURCE.model_dump(), "correct_option_ids": ("opt-9",)})


def test_draft_id_prefix() -> None:
    result, _ = run(candidate(), draft_id_prefix="run-7")
    assert result.drafts[0].id == "run-7-paraphrase-00"


# ------------------------------------------------------------------------------------------
# Re-validation after a human edit (M6.2 uses validate_variant)


def _draft() -> QuestionDraft:
    result, _ = run(
        candidate(
            stem="물의 상태 변화에 대한 설명으로 옳은 것을 모두 고르시오.",
            multi_select=True,
            correct_option_labels=["1", "2", "4"],
        ),
        variation=VariationType.INVERT_POLARITY,
    )
    return result.drafts[0]


def test_revalidation_after_rebuilding_the_options_clears_the_count_error() -> None:
    draft = _draft()
    edited = draft.model_copy(
        update={
            "stem": "물의 상태 변화에 대한 설명으로 옳은 것은?",
            "options": (
                QuestionOption(id="opt-1", text="응결은 열을 방출한다."),
                QuestionOption(id="opt-2", text="증발은 기체가 액체로 변하는 현상이다."),
                QuestionOption(id="opt-3", text="응결은 열을 흡수한다."),
            ),
            "correct_option_ids": ("opt-1",),
        }
    )
    issues = validate_variant(edited, source=SOURCE, passages=(PASSAGE,))
    assert issues == ()


def test_revalidation_catches_edits_that_break_rules() -> None:
    draft = _draft()
    fabricated = draft.evidence[0].model_copy(update={"quote": "책에 없는 문장입니다."})
    issues = validate_variant(
        draft.model_copy(update={"evidence": (fabricated,)}), source=SOURCE, passages=(PASSAGE,)
    )
    assert "citation_not_in_passage" in codes(issues)

    foreign = fabricated.model_copy(update={"document_id": "doc-other", "quote": None})
    issues = validate_variant(
        draft.model_copy(update={"evidence": (foreign,)}), source=SOURCE, passages=(PASSAGE,)
    )
    assert "evidence_not_in_passages" in codes(issues)

    issues = validate_variant(
        draft.model_copy(update={"evidence": ()}), source=SOURCE, passages=(PASSAGE,)
    )
    assert "source_not_cited" in codes(issues)

    as_source = draft.model_copy(
        update={
            "stem": SOURCE.stem,
            "options": SOURCE.options,
            "correct_option_ids": SOURCE.correct_option_ids,
        }
    )
    issues = validate_variant(as_source, source=SOURCE, passages=(PASSAGE,))
    assert "duplicate_of_source" in codes(issues)

    issues = validate_variant(
        draft.model_copy(update={"justification": None}), source=SOURCE, passages=(PASSAGE,)
    )
    assert "justification_missing" in codes(issues)

    # Acknowledging a non-acknowledgeable code changes nothing.
    issues = validate_variant(
        draft, source=SOURCE, passages=(PASSAGE,), acknowledged={"duplicate_of_source"}
    )
    assert any(
        i.code == "answer_count_changed" and i.severity is ValidationSeverity.ERROR for i in issues
    )


def test_revalidation_rejects_non_generated_drafts() -> None:
    draft = QuestionDraft(
        id="imp-1",
        origin=DraftOrigin.PDF_IMPORT,
        question_type=QuestionType.SHORT_ANSWER,
        stem="질문",
    )
    (found,) = validate_variant(draft, source=SOURCE)
    assert found.code == "draft_invalid"


def test_source_fingerprint_matches_question_fingerprint() -> None:
    assert source_fingerprint(SOURCE) == question_fingerprint(
        question_type=SOURCE.question_type,
        stem=SOURCE.stem,
        options=SOURCE.options,
        correct_option_ids=SOURCE.correct_option_ids,
    )


def test_batch_schema_forbids_extra_fields() -> None:
    schema = LLMVariantBatch.model_json_schema()
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["LLMVariant"]["additionalProperties"] is False


def test_strict_schema_requires_every_field() -> None:
    schema = strict_json_schema(LLMVariantBatch)
    for definition in (schema, *schema["$defs"].values()):
        assert definition["additionalProperties"] is False
        assert set(definition["required"]) == set(definition["properties"])


def test_reviewer_multi_select_flag_is_checked_on_revalidation() -> None:
    issues = validate_variant(
        _draft(),
        source=SOURCE,
        passages=(PASSAGE,),
        acknowledged={"answer_count_changed"},
        multi_select=False,
    )
    assert "mcq_multi_inconsistent" in codes(issues)


# ------------------------------------------------------------------------------------------
# Through the real provider client (httpx mock transport, no network)


def test_generation_through_the_anthropic_client_over_a_mock_transport() -> None:
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        text = json.dumps({"candidates": [candidate()]}, ensure_ascii=False)
        return httpx.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-test",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 900, "output_tokens": 250},
            },
        )

    client = AnthropicLLMClient(
        LLMConfig(api_key=SecretStr("sk-test"), model="claude-test", max_retries=0),
        transport=httpx.MockTransport(handler),
    )
    req = VariantRequest(
        source=SOURCE, variation_types=(VariationType.PARAPHRASE,), passages=(PASSAGE,)
    )
    result = VariantGenerator(client).generate(req)

    (draft,) = result.drafts
    assert draft.generator is not None
    assert draft.generator.model == "claude-test"
    assert result.llm_usage.input_tokens == 900
    (body,) = sent
    assert body["model"] == "claude-test"
    assert body["output_config"]["format"]["schema"] == strict_json_schema(LLMVariantBatch)
    assert "PASSAGES" in body["messages"][0]["content"]
