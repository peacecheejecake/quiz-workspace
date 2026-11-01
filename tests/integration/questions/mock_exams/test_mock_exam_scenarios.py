"""The `mock_exam` block of tests/fixtures/llm/generation-scenarios.json says what MOCK-01 tests
rely on (offline, no stack; GREEN from MOCK.0 on).

Every scripted item is run through the real approval-blocking validation that MOCK-01-C02 reuses
unchanged (`book_core.generation.validation`) against passages built from book-ko.pdf's truth the
way the generation worker builds them (one passage per section of the source's page, in reading
order). Items meant to be stored pass; the three meant to fail are blocked for the stated reason.
"Blocked" is what blocks approval in QGEN: any `error` issue. That is wider than `is_rejection`
(REJECT_CODES only): MOCK-01-C02 lists 정오 반전 정답 불일치 (`inverted_answer_mismatch`, an `error`
that is not a rejection code) among the checks a stored item must pass, and AC08 drops that item.
Assumptions K4-K7 in tests/e2e/fixtures/mock-exams.ts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from book_core.contracts import Excerpt, QuestionOption, QuestionType, SourceLocation, VariationType
from book_core.generation import LLMVariantBatch, SourceQuestion, source_fingerprint
from book_core.generation.validation import content_from_llm, content_issues

REPO_ROOT = Path(__file__).resolve().parents[4]
LLM_DIR = REPO_ROOT / "tests" / "fixtures" / "llm"
GENERATION = LLM_DIR / "generation-scenarios.json"
NOTES = LLM_DIR / "chapter-note-scenarios.json"
TRUTH = REPO_ROOT / "tests" / "fixtures" / "pdfs" / "book-ko.truth.json"

REJECTED = {
    "inv-multi": "inverted_answer_mismatch",
    "fail-quote": "citation_not_in_passage",
    "fail-answer": "answer_not_in_options",
}
FAULTS = {"malformed", "truncated", "unavailable"}


def _block() -> dict[str, Any]:
    block: dict[str, Any] = json.loads(GENERATION.read_text(encoding="utf-8"))["mock_exam"]
    return block


def _passages(page: int) -> list[Excerpt]:
    """One passage per section of `page` (blocks whose id starts with the section id)."""
    truth = json.loads(TRUTH.read_text(encoding="utf-8"))
    blocks = [
        b
        for b in truth["blocks"]
        if b["text"].strip() and any(p["page"] == page for p in b.get("parts", []))
    ]
    sections = [s["id"] for s in truth["sections"]]
    out: list[Excerpt] = []
    for sid in sections:
        own = [
            b
            for b in blocks
            if b["id"].startswith(f"{sid}-")
            and not any(
                b["id"].startswith(f"{o}-") for o in sections if o != sid and o.startswith(sid)
            )
        ]
        if own:
            out.append(
                Excerpt(
                    document_id="doc-book-ko",
                    revision_id="rev-1",
                    text="\n\n".join(b["text"] for b in own),
                    block_ids=tuple(b["id"] for b in own),
                    locations=(SourceLocation(page=page),),
                )
            )
    assert out, f"no passages on page {page}"
    return out


def _fill(value: Any, n: str) -> Any:
    if isinstance(value, str):
        return value.replace("{n}", n)
    if isinstance(value, list):
        return [_fill(v, n) for v in value]
    if isinstance(value, dict):
        return {k: _fill(v, n) for k, v in value.items()}
    return value


def _sources() -> dict[str, dict[str, Any]]:
    """Named sources plus a few instances of the templates (bulk n=001/002, crash)."""
    block = _block()
    out: dict[str, dict[str, Any]] = dict(block["sources"])
    for n in ("001", "002"):
        bulk = _fill(block["templates"]["bulk"], n)
        out[f"bulk-{n}"] = {**bulk, "marker": f"E2E-MOCK-BULK-{n}"}
    crash = block["templates"]["crash"]
    out["crash"] = {**crash, "marker": "E2E-MOCK-CRASH-0123456789abcdef"}
    return out


def _source_question(key: str, src: dict[str, Any]) -> SourceQuestion:
    return SourceQuestion(
        question_id=f"q-{key}",
        revision_id=f"qr-{key}",
        question_type=QuestionType.MCQ,
        stem=f"{src['stem']} [{src['marker']}]",
        options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in src["options"]),
        correct_option_ids=tuple(src["correct_option_ids"]),
        is_multi_answer=src["is_multi_answer"],
        explanation=src["explanation"],
    )


def _answered(item: dict[str, Any], passages: list[Excerpt]) -> dict[str, Any]:
    """What the fake sends for `item` (K5): passage tags filled in by quote."""
    citations = []
    for c in item["citations"]:
        tags = [f"P{i + 1}" for i, p in enumerate(passages) if c["quote"] in p.text]
        citations.append({"passage_id": tags[0] if tags else "P1", "quote": c["quote"]})
    return {**item, "citations": citations}


def _issues(key: str, src: dict[str, Any], vt: str, item: dict[str, Any]) -> list[Any]:
    passages = _passages(int(src["source_page"]))
    source = _source_question(key, src)
    batch = LLMVariantBatch.model_validate({"candidates": [_answered(item, passages)]})
    content, issues = content_from_llm(batch.candidates[0], source, passages)
    if content is None:
        return issues
    return issues + content_issues(
        content, variation_type=VariationType(vt), source=source, passages=passages
    )


def _blocked(issues: list[Any]) -> bool:
    return any(i.severity.value == "error" for i in issues)


def _all_items() -> list[tuple[str, str]]:
    return [(key, vt) for key, src in _sources().items() for vt in src["items"]]


@pytest.mark.parametrize(("key", "variation_type"), _all_items())
def test_scripted_items_pass_or_fail_the_reused_validation_as_stated(
    key: str, variation_type: str
) -> None:
    src = _sources()[key]
    issues = _issues(key, src, variation_type, src["items"][variation_type])
    codes = {i.code for i in issues if i.severity.value == "error"}
    if key in REJECTED:
        assert _blocked(issues), key
        assert REJECTED[key] in codes, (key, codes)
    else:
        assert not _blocked(issues), (key, variation_type, codes)


def test_items_meant_to_be_stored_quote_their_source_page_verbatim() -> None:
    for key, src in _sources().items():
        page = "\n".join(p.text for p in _passages(int(src["source_page"])))
        for vt, item in src["items"].items():
            for c in item["citations"]:
                if key != "fail-quote":
                    assert c["quote"] in page, (key, vt)
                else:
                    assert c["quote"] not in page


def test_every_ai_type_used_by_the_normal_range_is_scripted() -> None:
    """AC02 picks any 4 of the 6 normal sources and assigns 문구 변형 / 정오 반전 by seed."""
    normal: tuple[str, ...] = ("evaporation", "condensation", "precipitation", "infiltration")
    normal += ("flocculation", "disinfection")
    sources = _block()["sources"]
    assert [sources[k]["chapter"] for k in normal] == [1, 1, 1, 1, 2, 2]
    for key in normal:
        assert set(sources[key]["items"]) == {"PARAPHRASE", "INVERT_POLARITY"}, key
        assert "fault" not in sources[key]


def test_generated_items_differ_from_each_other_and_from_their_sources() -> None:
    seen: dict[str, str] = {}
    for key, src in _sources().items():
        own = source_fingerprint(_source_question(key, src))
        for vt, item in src["items"].items():
            stem = re.sub(r"\s+", " ", item["stem"]).strip()
            assert stem not in seen, (key, vt, seen.get(stem))
            seen[stem] = key
            assert stem != src["stem"], key
        assert own


def test_markers_are_unique_well_formed_and_never_collide() -> None:
    block = _block()
    pattern = re.compile(block["marker_pattern"])
    markers = [s["marker"] for s in block["sources"].values()]
    assert len(set(markers)) == len(markers)
    for m in markers:
        assert pattern.fullmatch(f"[{m}]"), m
        assert not re.fullmatch(block["templates"]["bulk"]["marker_pattern"], m)
        assert not re.fullmatch(block["templates"]["crash"]["marker_pattern"], m)
        assert not re.fullmatch(block["hold"]["marker_pattern"], m)
    generation = json.loads(GENERATION.read_text(encoding="utf-8"))
    notes = json.loads(NOTES.read_text(encoding="utf-8"))
    others = [s["marker"] for s in generation["scenarios"] + notes["scenarios"]]
    for m in [*markers, "E2E-MOCK-BULK-001", "E2E-MOCK-HOLD-0123456789abcdef"]:
        assert not [o for o in others if m in o or o in m], m
    for template in block["templates"].values():
        assert re.fullmatch(template["marker_pattern"], "E2E-MOCK-BULK-042") or re.fullmatch(
            template["marker_pattern"], "E2E-MOCK-CRASH-0123456789abcdef"
        )


def test_faults_and_chapters_are_declared() -> None:
    block = _block()
    assert set(block["faults"]) == FAULTS
    assert (block["task"], block["prompt_version"]) == (
        "mock_exam.generate",
        "mock_exam.generate/v1",
    )
    for key, src in block["sources"].items():
        assert src["chapter"] in (1, 2, None), key
        assert src["source_page"] in (2, 4), key
        ids = [o["id"] for o in src["options"]]
        assert set(src["correct_option_ids"]) <= set(ids), key
        fault = src.get("fault")
        if fault is not None:
            assert fault["kind"] in FAULTS, key
            if fault["kind"] == "unavailable":
                assert src["items"] == {}, key
            else:
                assert fault["sources_over"] >= 1, key
                assert src["items"], key
        else:
            assert src["items"], key


def test_the_one_bad_item_of_the_inversion_range_keeps_the_original_options() -> None:
    """AC08 / C09-3: three statements become correct while the model declares one."""
    src = _block()["sources"]["inv-multi"]
    item = src["items"]["INVERT_POLARITY"]
    assert [o["text"] for o in item["options"]] == [o["text"] for o in src["options"]]
    assert len(item["correct_option_labels"]) == 1
    assert item["multi_select"] is False
    keep = {o["text"] for o in src["options"] if o["id"] in src["correct_option_ids"]}
    assert len([o for o in item["options"] if o["text"] not in keep]) == 3
