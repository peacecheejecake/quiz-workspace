"""VariantGenerator and validate_variant never raise on odd LLM output (M6.1).

A property-style sweep with fixed seeds, in the style of test_extractor_robustness.py: hundreds
of random candidate batches (schema-valid but semantically arbitrary: odd labels, blank or huge
texts, unknown answer labels, fabricated or partial citations, wrong types) plus malformed raw
output. The generator must always return; every draft must satisfy the contract and carry only
non-rejecting issues; every rejection must carry reasons from the documented set.
"""

from __future__ import annotations

import json
import random
from typing import Any

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
    REJECT_CODES,
    SourceQuestion,
    VariantGenerator,
    VariantRequest,
    validate_variant,
)
from book_core.llm import FakeLLMClient
from book_core.question import normalize_text, question_fingerprint

PASSAGES = (
    Excerpt(
        document_id="doc-1",
        revision_id="rev-1",
        text="물이 수증기로 변하는 현상을 증발이라고 한다. 응결은 열을 방출한다.",
        block_ids=("b-1",),
        locations=(SourceLocation(page=2),),
    ),
    Excerpt(
        document_id="doc-2",
        revision_id="rev-9",
        text="Melting absorbs heat. Freezing releases heat.",
        block_ids=("b-7", "b-8"),
        locations=(SourceLocation(page=5),),
    ),
)
SOURCE = SourceQuestion(
    question_id="q-1",
    revision_id="qr-1",
    question_type=QuestionType.MCQ,
    stem="옳지 않은 것은?",
    options=(
        QuestionOption(id="opt-1", text="증발"),
        QuestionOption(id="opt-2", text="응결"),
        QuestionOption(id="opt-3", text="융해"),
    ),
    correct_option_ids=("opt-2",),
    evidence=(SourceEvidence(document_id="qd", locations=(SourceLocation(page=1),)),),
)
LABELS = ["1", "2", "3", "①", "②", "A", "a)", "(B)", "가", "", " ", "1", "x y", "⑩", "10"]
TEXTS = ["증발", "응결", "융해", "", "  ", "\n", "Water", "WATER", "열을 방출", "x" * 5001, "①"]
QUOTES = [
    "응결은 열을 방출한다.",
    "응결은  열을\n방출한다",
    "Melting absorbs heat.",
    "melting ABSORBS heat",
    "증발",
    "",
    "지어낸 문장",
    "Freezing releases heat.",
    "x" * 30,
]
SAFE_QUOTES = (
    ["응결은 열을 방출한다.", "응결은  열을\n방출한다", "증발이라고 한다"],
    ["Melting absorbs heat.", "freezing RELEASES heat"],
)
TAGS = ["P1", "P2", "P3", "p1", "[P2]", "P0", "", "1", "P-1"]
STEMS = ["옳은 것은?", "옳지 않은 것은?", "", "   ", "Which is NOT true?", "가" * 20001, "증발?"]
ANSWERS = ["응결", "", " ", "x" * 1001, "Water", "water"]
KNOWN_CODES = (
    REJECT_CODES
    | ACKNOWLEDGEABLE_CODES
    | {"provenance_missing", "mcq_multi_inconsistent", "polarity_unchanged", "stem_unchanged"}
)


def _maybe_list(rng: random.Random, pool: list[str], k: int) -> list[str] | None:
    if rng.random() < 0.2:
        return None
    return [rng.choice(pool) for _ in range(rng.randint(0, k))]


def _candidate(rng: random.Random) -> dict[str, Any]:
    n_options = rng.choice([0, 0, 1, 2, 3, 4, 5, 51]) if rng.random() < 0.95 else 0
    labels = [rng.choice(LABELS) if rng.random() < 0.3 else str(i + 1) for i in range(n_options)]
    return {
        "question_type": rng.choice(["MCQ", "MCQ", "SHORT_ANSWER", "ESSAY"]),
        "multi_select": rng.random() < 0.3,
        "stem": rng.choice(STEMS),
        "options": [{"label": lb, "text": rng.choice(TEXTS)} for lb in labels],
        "correct_option_labels": _maybe_list(rng, [*labels, *LABELS] or LABELS, 3),
        "accepted_answers": _maybe_list(rng, ANSWERS, 3),
        "explanation": rng.choice([None, "", "설명", "x" * 20001]),
        "justification": rng.choice(["", " ", "근거", "because"]),
        "citations": [
            {"passage_id": rng.choice(TAGS), "quote": rng.choice(QUOTES)}
            for _ in range(rng.randint(0, 3))
        ],
    }


def _plausible(rng: random.Random, n_passages: int) -> dict[str, Any]:
    """A valid candidate with 0-2 random fields replaced by arbitrary values."""
    words = ["증발", "응결", "융해", "승화", "응고", "기화", "액화"]
    rng.shuffle(words)
    qtype = rng.choice(["MCQ", "MCQ", "SHORT_ANSWER", "ESSAY"])
    mcq = qtype == "MCQ"
    n = rng.randint(2, 5)
    citations = [
        {"passage_id": f"P{i + 1}", "quote": rng.choice(SAFE_QUOTES[i])} for i in range(n_passages)
    ][: rng.randint(1, max(1, n_passages))]
    out: dict[str, Any] = {
        "question_type": qtype,
        "multi_select": False,
        "stem": rng.choice(["옳은 것은?", "Which is NOT true?", "무엇인가?"]) + str(rng.random()),
        "options": [{"label": str(i + 1), "text": words[i]} for i in range(n)] if mcq else [],
        "correct_option_labels": [str(rng.randint(1, n))] if mcq else None,
        "accepted_answers": None if mcq else [rng.choice(["응결", "water"])],
        "explanation": rng.choice([None, "설명"]),
        "justification": "근거",
        "citations": citations if n_passages else [],
    }
    random_fields = _candidate(rng)
    for key in rng.sample(sorted(out), rng.choice([0, 0, 1, 2])):
        out[key] = random_fields[key]
    return out


def _raw(rng: random.Random, n: int, n_passages: int) -> str:
    batch = {
        "candidates": [
            _plausible(rng, n_passages) if rng.random() < 0.6 else _candidate(rng) for _ in range(n)
        ]
    }
    raw = json.dumps(batch, ensure_ascii=False)
    roll = rng.random()
    if roll < 0.05:
        return raw[: rng.randint(0, len(raw))]  # truncated JSON
    if roll < 0.1:
        return json.dumps({"candidates": [{"stem": 1}], "extra": True})
    return raw


def _check_draft(draft: QuestionDraft, passages: tuple[Excerpt, ...]) -> None:
    QuestionDraft.model_validate(draft.model_dump())
    assert draft.origin is DraftOrigin.GENERATION
    assert draft.review_status is ReviewStatus.PENDING
    assert draft.parent_question_id == SOURCE.question_id
    assert draft.source_question_revision_id == SOURCE.revision_id
    assert draft.generator is not None
    assert not {i.code for i in draft.validations} & REJECT_CODES
    assert draft.stem.strip()
    assert draft.justification
    if draft.question_type is QuestionType.MCQ:
        assert len(draft.options) >= 2
        assert draft.correct_option_ids
        assert set(draft.correct_option_ids) <= {o.id for o in draft.options}
    elif draft.question_type is QuestionType.SHORT_ANSWER:
        assert draft.accepted_answers
        assert not draft.options
    texts = {o.text.strip() for o in draft.options}
    assert len({normalize_text(t) for t in texts}) == len(draft.options)
    if passages:
        assert draft.evidence
        for evidence in draft.evidence:
            assert evidence.quote is not None
            assert any(
                p.document_id == evidence.document_id
                and normalize_text(evidence.quote) in normalize_text(p.text)
                for p in passages
            )
    else:
        assert draft.evidence == SOURCE.evidence
    # Blocking issues are exactly the error-level ones.
    blocking = [i for i in draft.validations if i.severity is ValidationSeverity.ERROR]
    assert draft.has_blocking_issues == bool(blocking)
    assert {i.code for i in blocking} <= ACKNOWLEDGEABLE_CODES


@pytest.mark.parametrize("seed", range(6))
def test_generator_never_raises_on_random_output(seed: int) -> None:
    rng = random.Random(seed)  # noqa: S311 (test data)
    drafted = 0
    seen_codes: set[str] = set()
    for _ in range(60):
        variations = tuple(
            rng.sample(
                [
                    VariationType.PARAPHRASE,
                    VariationType.INVERT_POLARITY,
                    VariationType.ANALOGOUS_CONCEPT,
                ],
                rng.randint(1, 3),
            )
        )
        passages = PASSAGES[: rng.randint(0, 2)]
        if VariationType.ANALOGOUS_CONCEPT in variations and not passages:
            passages = PASSAGES[:1]
        count = rng.randint(1, 4)
        llm = FakeLLMClient()
        returned: dict[VariationType, int] = {}
        for variation in variations:
            n = rng.randint(0, count + 1)
            returned[variation] = n
            llm.script(GENERATE_TASKS[variation], _raw(rng, n, len(passages)))

        result = VariantGenerator(llm).generate(
            VariantRequest(
                source=SOURCE,
                variation_types=variations,
                candidate_count=count,
                passages=passages,
            )
        )

        drafted += len(result.variants)
        seen_codes |= {i.code for r in result.rejected for i in r.reasons}
        seen_codes |= {i.code for v in result.variants for i in v.draft.validations}
        fingerprints = [v.fingerprint for v in result.variants]
        assert len(set(fingerprints)) == len(fingerprints)
        for variant in result.variants:
            _check_draft(variant.draft, passages)
            draft = variant.draft
            assert variant.fingerprint == question_fingerprint(
                question_type=draft.question_type,
                stem=draft.stem,
                options=draft.options,
                correct_option_ids=draft.correct_option_ids,
                accepted_answers=draft.accepted_answers,
            )
            # Re-validating the untouched draft reproduces its issues.
            others = [f for f in fingerprints if f != variant.fingerprint]
            again = validate_variant(
                draft, source=SOURCE, passages=passages, sibling_fingerprints=others
            )
            # (The LLM's multi_select flag is not part of the draft; it only adds a warning.)
            assert again == tuple(
                i for i in draft.validations if i.code != "mcq_multi_inconsistent"
            )
        for rejected in result.rejected:
            assert rejected.reasons
            assert {r.code for r in rejected.reasons} & REJECT_CODES
        # Every returned candidate is accounted for exactly once (or the call failed as a whole).
        for variation in variations:
            drafts = [v for v in result.variants if v.draft.variation_type is variation]
            per_candidate = [
                r
                for r in result.rejected
                if r.variation_type is variation and r.candidate_index is not None
            ]
            whole = [
                r
                for r in result.rejected
                if r.variation_type is variation and r.candidate_index is None
            ]
            if whole:
                assert not drafts
                assert not per_candidate
            else:
                assert len(drafts) + len(per_candidate) == returned[variation]
    # The sweep exercises both outcomes, not only rejections.
    assert drafted > 0
    assert len(seen_codes) >= 10
    assert seen_codes <= KNOWN_CODES


def _random_draft(rng: random.Random) -> QuestionDraft:
    qtype = rng.choice(list(QuestionType))
    n = rng.randint(0, 4) if qtype is QuestionType.MCQ else 0
    options = tuple(
        QuestionOption(id=f"o{i}", text=rng.choice([t for t in TEXTS if t])) for i in range(n)
    )
    correct = None
    if qtype is QuestionType.MCQ and rng.random() < 0.8:
        correct = tuple(rng.sample([o.id for o in options], rng.randint(0, n)))
    accepted = None
    if qtype is not QuestionType.MCQ and rng.random() < 0.7:
        accepted = tuple(rng.choice([a for a in ANSWERS if a]) for _ in range(rng.randint(1, 3)))
    evidence = []
    for _ in range(rng.randint(0, 2)):
        p = rng.choice(PASSAGES)
        evidence.append(
            SourceEvidence(
                document_id=rng.choice([p.document_id, "doc-x"]),
                revision_id=rng.choice([p.revision_id, None]),
                block_ids=p.block_ids[: rng.randint(0, len(p.block_ids))],
                locations=p.locations,
                quote=rng.choice([None, *[q for q in QUOTES if q]]),
            )
        )
    if rng.random() < 0.2:
        evidence.append(SOURCE.evidence[0])
    return QuestionDraft(
        id="d-1",
        origin=DraftOrigin.GENERATION,
        question_type=qtype,
        stem=rng.choice([s for s in STEMS if s]),
        options=options,
        correct_option_ids=correct,
        accepted_answers=accepted,
        justification=rng.choice([None, " ", "근거"]),
        evidence=tuple(evidence),
        variation_type=rng.choice(
            [
                VariationType.PARAPHRASE,
                VariationType.INVERT_POLARITY,
                VariationType.ANALOGOUS_CONCEPT,
            ]
        ),
        parent_question_id="q-1",
        source_question_revision_id="qr-1",
    )


@pytest.mark.parametrize("seed", range(4))
def test_validate_variant_never_raises_on_edited_drafts(seed: int) -> None:
    rng = random.Random(1000 + seed)  # noqa: S311 (test data)
    for _ in range(150):
        draft = _random_draft(rng)
        issues = validate_variant(
            draft,
            source=SOURCE,
            passages=PASSAGES[: rng.randint(0, 2)],
            acknowledged=rng.choice([(), ("answer_count_changed",), ACKNOWLEDGEABLE_CODES]),
        )
        assert {i.code for i in issues} <= KNOWN_CODES
