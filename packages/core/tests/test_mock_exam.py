"""book_core.mock_exam (MOCK-B): seeded plan, OPTION_SHUFFLE order, token-budget packing,
per-item validation (every error blocks) and the batched scenario fake (MOCK-01-C02/C03/C09)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from book_core.contracts import Excerpt, QuestionOption, QuestionType, SourceLocation, VariationType
from book_core.generation import SourceQuestion
from book_core.llm import LLMOutputError, LLMProviderError
from book_core.llm.mock_exam_scenarios import MockExamScenarioLLM, MockExamSimulatedCrash
from book_core.mock_exam import (
    BatchSource,
    Budget,
    LLMMockBatch,
    PackSource,
    PlanCandidate,
    base_prompt_text,
    build_batch_request,
    check_batch,
    estimate_tokens,
    halves,
    make_plan,
    pack_batches,
    shuffled_options,
)

REPO = Path(__file__).resolve().parents[3]
SCENARIOS = REPO / "tests" / "fixtures" / "llm" / "generation-scenarios.json"
BLOCK = json.loads(SCENARIOS.read_text(encoding="utf-8"))["mock_exam"]
PT, PV = VariationType.PARAPHRASE, VariationType.INVERT_POLARITY


def candidates(n: int, chapters: int = 1) -> list[PlanCandidate]:
    return [PlanCandidate(f"q{i}", f"r{i}", i * chapters // n) for i in range(n)]


# --- plan ---------------------------------------------------------------------------------------


def test_the_same_seed_and_candidates_give_the_same_plan() -> None:
    a = make_plan(candidates(10), 4, [PT, PV], seed=4711)
    b = make_plan(candidates(10), 4, [PT, PV], seed=4711)
    assert a == b
    assert [p.position for p in a] == [0, 1, 2, 3]
    ids = [int(p.question_id[1:]) for p in a]
    assert ids == sorted(ids), "plan items keep Heatmap order"
    assert sorted(p.variation_type for p in a) == [PV, PV, PT, PT], "types rotate evenly"
    assert make_plan(candidates(10), 4, [PT, PV], seed=4712) != a


def test_a_count_over_the_range_takes_every_candidate_and_none_means_all() -> None:
    assert len(make_plan(candidates(3), 20, [PT], seed=1)) == 3
    assert len(make_plan(candidates(7), None, [VariationType.OPTION_SHUFFLE], seed=1)) == 7
    with pytest.raises(ValueError, match="variation type"):
        make_plan(candidates(3), 1, [], seed=1)


def test_shuffled_options_are_deterministic_and_never_the_source_order() -> None:
    opts = ["a", "b", "c", "d"]
    assert shuffled_options(opts, 7, 0) == shuffled_options(opts, 7, 0)
    for position in range(20):
        out = shuffled_options(opts, 7, position)
        assert sorted(out) == opts
        assert out != opts
    assert shuffled_options(["x"], 1, 0) == ["x"]


# --- packing ------------------------------------------------------------------------------------


def bulk(n: int, rank: int = 0, passages: tuple[str, ...] = ("p1", "p2")) -> list[PackSource]:
    return [PackSource(i, rank, 200, passages) for i in range(n)]


def test_twenty_sources_sharing_passages_take_one_call_with_each_passage_once() -> None:
    result = pack_batches(bulk(20), {"p1": 500, "p2": 500}, Budget(base_prompt_tokens=800))
    assert len(result.batches) == 1
    assert result.batches[0].passages == ("p1", "p2")


def test_a_hundred_sources_take_three_calls_within_the_caps_deterministically() -> None:
    budget = Budget(base_prompt_tokens=800)
    first = pack_batches(bulk(100), {"p1": 500, "p2": 500}, budget)
    assert [len(b.positions) for b in first.batches] == [40, 40, 20]
    assert first == pack_batches(list(reversed(bulk(100))), {"p1": 500, "p2": 500}, budget)


def test_the_input_budget_splits_large_passages_and_chapters_stay_together() -> None:
    sources = [PackSource(i, i % 2, 300, (f"c{i % 2}-{i}",)) for i in range(40)]
    result = pack_batches(sources, {s.passages[0]: 3000 for s in sources}, Budget())
    assert all(b.prompt_tokens <= 60_000 for b in result.batches)
    assert len(result.batches) == 3
    ranks = [{p % 2 for p in b.positions} for b in result.batches]
    assert ranks[0] == {0}, "chapter 1 first"


def test_an_oversized_source_is_narrowed_then_skipped() -> None:
    budget = Budget(max_prompt_tokens=4000, base_prompt_tokens=1000)
    sources = [
        PackSource(0, 0, 200, ("small",)),
        PackSource(1, 0, 200, ("small", "huge")),
        PackSource(2, 0, 19_000, ("small",)),
        PackSource(3, 0, 200, ("huge",), requires_passage=True),
    ]
    result = pack_batches(sources, {"small": 1000, "huge": 5000}, budget)
    assert result.too_large == (2, 3)
    assert result.narrowed == {1: ("small",)}
    assert [b.positions for b in result.batches] == [(0, 1)]


def test_halves_and_token_estimate() -> None:
    assert halves([5, 6, 7]) == ((5,), (6, 7))
    assert estimate_tokens("가나다") == 3
    assert estimate_tokens("abcdef") == 2


# --- prompt, fake and validation -----------------------------------------------------------------


def passage(text: str) -> Excerpt:
    return Excerpt(
        document_id="d",
        revision_id="r",
        text=text,
        block_ids=("b1",),
        locations=(SourceLocation(page=2),),
    )


TRUTH = json.loads((REPO / "tests/fixtures/pdfs/book-ko.truth.json").read_text(encoding="utf-8"))
PAGE2 = passage(
    "\n\n".join(
        b["text"] for b in TRUTH["blocks"] if any(p["page"] == 2 for p in b.get("parts", []))
    )
)
PAGE4 = passage(
    "\n\n".join(
        b["text"] for b in TRUTH["blocks"] if any(p["page"] == 4 for p in b.get("parts", []))
    )
)


def named(key: str, tag: str, position: int, vt: VariationType) -> BatchSource:
    s = BLOCK["sources"][key]
    return BatchSource(
        tag=tag,
        position=position,
        source=SourceQuestion(
            question_id=f"q-{key}",
            revision_id=f"r-{key}",
            question_type=QuestionType.MCQ,
            stem=f"{s['stem']} [{s['marker']}]",
            options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in s["options"]),
            correct_option_ids=tuple(s["correct_option_ids"]),
            is_multi_answer=s["is_multi_answer"],
            explanation=s["explanation"],
        ),
        variation_type=vt,
        passage_tags=("P1", "P2"),
    )


def test_one_bad_inversion_is_dropped_while_its_batch_mates_are_kept() -> None:
    llm = MockExamScenarioLLM(BLOCK)
    sources = [
        named("inv-runoff", "S1", 0, PV),
        named("inv-filtration", "S2", 1, PV),
        named("inv-multi", "S3", 2, PV),
    ]
    request = build_batch_request(sources, [PAGE2, PAGE4])
    assert request.prompt.count(PAGE2.text) == 1
    out = llm.complete(request, LLMMockBatch).output
    outcomes = check_batch(out, sources, [PAGE2, PAGE4])
    assert [o.accepted for o in outcomes] == [True, True, False]
    assert "inverted_answer_mismatch" in outcomes[2].codes, "an error blocks, not only rejects"
    assert len(llm.calls) == 1
    assert llm.max_in_flight == 1


def own(passage_text: str, block: str) -> Excerpt:
    return Excerpt(
        document_id="d",
        revision_id="r",
        text=passage_text,
        block_ids=(block,),
        locations=(SourceLocation(page=2),),
    )


def item(key: str, tag: str, citations: list[dict[str, str]]) -> dict[str, object]:
    scripted = BLOCK["sources"][key]["items"]["PARAPHRASE"]
    return {**scripted, "source_tag": tag, "variation_type": "PARAPHRASE", "citations": citations}


def with_tags(source: BatchSource, tags: tuple[str, ...]) -> BatchSource:
    return BatchSource(source.tag, source.position, source.source, source.variation_type, tags)


EVAP_QUOTE = "이 과정을 증발이라고 한다."


def test_a_source_without_passages_needs_no_citation_in_a_mixed_batch() -> None:
    """Codex P2: citations are required and checked against the source's own passages only."""
    a = with_tags(named("evaporation", "S1", 0, PT), ("P1",))
    b = with_tags(named("flocculation", "S2", 1, PT), ())
    output = LLMMockBatch.model_validate(
        {
            "items": [
                item("evaporation", "S1", [{"passage_id": "P1", "quote": EVAP_QUOTE}]),
                item("flocculation", "S2", []),
            ]
        }
    )
    outcomes = check_batch(output, [a, b], [own(PAGE2.text, "p2")])
    assert [o.accepted for o in outcomes] == [True, True], [o.codes for o in outcomes]


def test_an_item_citing_another_sources_passage_is_rejected() -> None:
    a = with_tags(named("evaporation", "S1", 0, PT), ("P1",))
    b = with_tags(named("flocculation", "S2", 1, PT), ("P2",))
    output = LLMMockBatch.model_validate(
        {
            "items": [
                item("evaporation", "S1", [{"passage_id": "P1", "quote": EVAP_QUOTE}]),
                item("flocculation", "S2", [{"passage_id": "P1", "quote": EVAP_QUOTE}]),
            ]
        }
    )
    outcomes = check_batch(output, [a, b], [own(PAGE2.text, "p2"), own(PAGE4.text, "p4")])
    assert outcomes[0].accepted
    assert not outcomes[1].accepted
    assert "citation_unknown_passage" in outcomes[1].codes


def test_missing_and_unknown_items_fail() -> None:
    sources = [named("evaporation", "S1", 0, PT)]
    outcomes = check_batch(LLMMockBatch(items=[]), sources, [PAGE2])
    assert outcomes[0].codes == ("item_missing",)


def test_faults_of_the_scripted_fake() -> None:
    llm = MockExamScenarioLLM(BLOCK, max_output_tokens=16_000)
    three = [
        named("brk-sediment", "S1", 0, PT),
        named("brk-backwash", "S2", 1, PT),
        named("brk-cloud", "S3", 2, PT),
    ]
    with pytest.raises(LLMOutputError):
        llm.complete(build_batch_request(three, [PAGE4, PAGE2]), LLMMockBatch)
    ok = llm.complete(build_batch_request(three[:2], [PAGE4]), LLMMockBatch).output
    assert len(ok.items) == 2
    cut = [named("trn-raw-water", "S1", 0, PT), *three[1:]]
    with pytest.raises(LLMOutputError) as info:
        llm.complete(build_batch_request(cut, [PAGE4, PAGE2]), LLMMockBatch)
    assert info.value.call_info is not None
    assert info.value.call_info.stop_reason == "max_tokens"
    with pytest.raises(LLMProviderError):
        llm.complete(build_batch_request([named("down-raw", "S1", 0, PT)], [PAGE4]), LLMMockBatch)


def test_the_crash_fault_fires_once_per_token(tmp_path: Path) -> None:
    llm = MockExamScenarioLLM(BLOCK, fault_dir=tmp_path)
    crash = named("evaporation", "S1", 0, PT)
    stem = crash.source.stem + " [E2E-MOCK-CRASH-0123456789abcdef]"
    crash = BatchSource(
        "S1", 0, crash.source.model_copy(update={"stem": stem}), PT, crash.passage_tags
    )
    request = build_batch_request([crash], [PAGE2])
    with pytest.raises(MockExamSimulatedCrash):
        llm.complete(request, LLMMockBatch)
    assert len(llm.complete(request, LLMMockBatch).output.items) == 1


def test_the_base_prompt_estimate_is_small() -> None:
    assert estimate_tokens(base_prompt_text(None)) < 2000
