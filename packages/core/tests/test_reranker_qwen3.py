"""Real Qwen3-Reranker-0.6B (M2.4). Marked ``models``.

Needs the pinned weights (~1.2 GB) in the Hugging Face cache (``HF_HOME``); downloads them on
first use unless ``HF_HUB_OFFLINE=1``. Excluded from ``make test``; run with ``make test-models``.

KO<->EN sanity on ``retrieval-seed.json``: each seed query reranks the eight leaf sections of both
books (heading + body; the search service passes chunk ``content``, no breadcrumb). Measured at
the pinned revision (fp32, CPU): the relevant section in the query's own language is rank 1 for
all six queries; the other language's relevant section is rank 2 (four queries) or 3 (q-ko-01,
q-en-01, behind a sibling section of the same chapter in the query's language). Asserted: own
language rank 1, both within ``MAX_CROSS_RANK``.
Scores of a pair do not depend on the batch beyond float rounding from left padding (measured
max |batch - single| 5e-5; asserted below ``BATCH_TOLERANCE``); identical calls are
bit-identical.
"""

from __future__ import annotations

import json

import pytest
from book_core.reranker import Qwen3Reranker, Qwen3RerankerConfig
from fixture_truth import BookTruth
from make_fixture_pdfs import OUT_DIR

pytestmark = pytest.mark.models

BOOKS = ("book-ko", "book-en")
SEED = json.loads((OUT_DIR / "retrieval-seed.json").read_text(encoding="utf-8"))["queries"]
BATCH_TOLERANCE = 1e-3
MAX_CROSS_RANK = 3


def _leaf_sections() -> dict[tuple[str, str], str]:
    """(book, leaf section id) -> heading and body text."""
    out: dict[tuple[str, str], str] = {}
    for book in BOOKS:
        truth = BookTruth.model_validate_json((OUT_DIR / f"{book}.truth.json").read_bytes())
        for section in truth.sections:
            if section.level != 2:
                continue
            body = [b.text for b in truth.blocks if b.section_id == section.id and b.text]
            out[(book, section.id)] = "\n".join([section.title, *body])
    return out


@pytest.fixture(scope="module")
def reranker() -> Qwen3Reranker:
    return Qwen3Reranker()


def test_model_card_example(reranker: Qwen3Reranker) -> None:
    scores = reranker.score(
        "What is the capital of China?",
        [
            "The capital of China is Beijing.",
            "Gravity is a force that attracts two bodies towards each other. It gives weight to "
            "physical objects and is responsible for the movement of planets around the sun.",
        ],
    )
    # The card reports [7.625, -11.375] (sentence-transformers, logit difference).
    assert scores[0] > 5.0
    assert scores[1] < -5.0


def test_seed_queries_rank_relevant_sections_first_across_languages(
    reranker: Qwen3Reranker,
) -> None:
    sections = _leaf_sections()
    keys = sorted(sections)
    for query in SEED:
        scores = reranker.score(query["query"], [sections[k] for k in keys])
        ranked = [k for _, k in sorted(zip(scores, keys, strict=True), reverse=True)]
        ranks = {
            r["fixture_id"]: ranked.index((r["fixture_id"], r["section_id"])) + 1
            for r in query["relevant"]
        }
        print(query["id"], ranks)
        own = "book-ko" if query["language"] == "ko" else "book-en"
        assert ranks[own] == 1, (query["id"], ranks)
        assert max(ranks.values()) <= MAX_CROSS_RANK, (query["id"], ranks)


def test_deterministic_and_batch_independent(reranker: Qwen3Reranker) -> None:
    sections = _leaf_sections()
    passages = [sections[k] for k in sorted(sections)]
    query = SEED[0]["query"]
    batched = reranker.score(query, passages)
    assert reranker.score(query, passages) == batched
    single = Qwen3Reranker(Qwen3RerankerConfig(batch_size=1))
    one_by_one = single.score(query, passages)
    diff = max(abs(a - b) for a, b in zip(batched, one_by_one, strict=True))
    print(f"max |batch - single| = {diff:.2e}")
    assert diff < BATCH_TOLERANCE
    assert single.score(query, passages[:1]) == one_by_one[:1]


def test_long_passages_are_truncated_to_max_length() -> None:
    short = Qwen3Reranker(Qwen3RerankerConfig(max_length=128))
    passage = "The capital of China is Beijing. " + "Filler sentence about nothing. " * 400
    [score] = short.score("What is the capital of China?", [passage])
    assert score > 0.0
