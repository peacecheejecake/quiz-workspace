"""Draft review rules (quiz_api.question_drafts): what blocks approval/publishing, how edits
recompute validations, and the provenance a published question gets."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from quiz_api.api.question_imports import draft_version
from quiz_api.question_drafts import (
    answer_missing,
    content_of,
    pages,
    parse_payload,
    publish_issues,
    recompute_validations,
    source_pages,
    with_review,
)
from quiz_api.question_rules import QuestionContent


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schema_version": 1,
        "id": "doc-q003",
        "origin": "pdf_import",
        "question_type": "MCQ",
        "stem": "바다 표면의 물이 대기로 이동하는 과정은?",
        "options": [
            {"id": "opt-1", "text": "유출"},
            {"id": "opt-2", "text": "응결"},
            {"id": "opt-3", "text": "증발"},
        ],
        "correct_option_ids": None,
        "accepted_answers": None,
        "evidence": [
            {
                "document_id": "doc",
                "revision_id": "rev",
                "block_ids": ["cb-1"],
                "locations": [{"page": 1, "block_id": "cb-1"}],
            },
            {
                "document_id": "doc",
                "revision_id": "rev",
                "block_ids": ["cb-2", "cb-1"],
                "locations": [{"page": 2}],
                "quote": "[그림 1]",
            },
        ],
        "validations": [
            {
                "code": "answer_missing",
                "severity": "warning",
                "message": "No answer in the source.",
                "field": "correct_option_ids",
            }
        ],
    }
    return {**base, **overrides}


def test_an_mcq_without_an_answer_cannot_be_confirmed_and_none_is_made_up() -> None:
    draft = parse_payload(payload())
    content = content_of(draft, is_multi_answer=False)
    blockers = publish_issues(content, [v.model_dump() for v in draft.validations])
    assert [i["loc"] for i in blockers.items] == [("body", "correct_option_ids")]
    assert content.correct_option_ids is None
    assert answer_missing(content)


def test_short_answer_and_essay_without_answers_can_be_confirmed() -> None:
    for kind in ("SHORT_ANSWER", "ESSAY"):
        draft = parse_payload(payload(question_type=kind, options=[]))
        content = content_of(draft, is_multi_answer=False)
        assert publish_issues(content, []).items == [], kind
        assert answer_missing(content)


def test_error_level_validations_block_publishing() -> None:
    draft = parse_payload(payload(correct_option_ids=["opt-3"]))
    content = content_of(draft, is_multi_answer=False)
    assert publish_issues(content, []).items == []
    errors = [{"code": "provenance_missing", "severity": "error", "message": "No page."}]
    assert [i["msg"] for i in publish_issues(content, errors).items] == ["No page."]


def test_an_edit_recomputes_the_shared_structural_validations() -> None:
    draft = parse_payload(payload())
    edited = QuestionContent(
        question_type="MCQ",
        stem=draft.stem,
        options=tuple((o.id, o.text) for o in draft.options),
        correct_option_ids=("opt-3",),
        is_multi_answer=False,
        accepted_answers=None,
        explanation=None,
        rubric=None,
    )
    assert recompute_validations(edited, draft) == ()
    multi = QuestionContent(**{**edited.__dict__, "correct_option_ids": ("opt-1", "opt-3")})
    codes = {v.code for v in recompute_validations(multi, draft)}
    assert codes == {"mcq_multi_inconsistent"}
    approved = with_review(draft, edited, (), "approved")
    assert approved.review_status.value == "approved"
    assert approved.correct_option_ids == ("opt-3",)
    assert approved.evidence == draft.evidence  # provenance never changes on review


def test_provenance_becomes_one_source_row_with_the_page_range() -> None:
    draft = parse_payload(payload())
    assert pages(draft) == [1, 2]
    found = source_pages(draft)
    assert (found.page_start, found.page_end) == (1, 2)
    assert found.block_ids == ("cb-1", "cb-2")
    assert [loc["page"] for loc in found.locations] == [1, 2]


def test_draft_version_changes_with_every_write() -> None:
    now = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)
    assert draft_version(now) != draft_version(now + timedelta(microseconds=1))
    assert draft_version(now) == draft_version(now.astimezone())


def test_a_printed_essay_answer_is_the_rubric_never_an_accepted_answer() -> None:
    # A draft written before the rule (payload accepted_answers on an ESSAY) reads the same way.
    legacy = parse_payload(
        payload(question_type="ESSAY", options=[], accepted_answers=["침투가 줄어 유출 증가"])
    )
    content = content_of(legacy, is_multi_answer=False)
    assert content.accepted_answers is None
    assert content.rubric == "침투가 줄어 유출 증가"
    assert not answer_missing(content)
    assert publish_issues(content, []).items == []
    assert "answer_missing" not in {v.code for v in recompute_validations(content, legacy)}
    # The rubric column wins; the rewritten payload no longer carries accepted answers.
    stored = content_of(legacy, is_multi_answer=False, rubric="모범 답안")
    assert stored.rubric == "모범 답안"
    assert with_review(legacy, stored, (), "approved").accepted_answers is None
