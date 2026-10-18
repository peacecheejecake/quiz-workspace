"""Real Qwen3-Embedding-0.6B and its tokenizer (M2.1). Marked ``models``.

Needs the pinned weights (~1.2 GB) in the Hugging Face cache (``HF_HOME``); downloads them on
first use unless ``HF_HUB_OFFLINE=1``. Excluded from ``make test``; run with ``make test-models``.

KO<->EN sanity on ``retrieval-seed.json``: each seed query is scored against the four leaf
sections of each book (heading + body text from the fixture truth). Measured at the pinned
revision (fp32, CPU): the relevant section is rank 1 in all 12 (query, book) pairs, cross-lingual
pairs included, and beats the best section of the other chapter by >= 0.12. Asserted: rank 1 and
a ``MIN_MARGIN`` lead over the other chapter.

Token budget: Qwen3's byte-level BPE gives every digit its own token and splits less frequent
Hangul syllables into 2-3 byte tokens, which ``ApproxTokenizer`` does not model. On the fixtures
it over-counts in total (book-en 1.40x, book-ko 1.04x, questions-ko 1.03x) but under-counts
single short Korean texts (headings and options with numbers, a table with durations) by up to
3 tokens / 33%. Documented margin: real <= ``APPROX_MARGIN`` x approx + ``APPROX_SLACK`` per
text, and real <= ``APPROX_MARGIN`` x ``max_tokens`` per budgeted child, which stays far below the
embedder's ``max_length`` (2048).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from book_core.chunker import ApproxTokenizer, ChunkerConfig, chunk_revision
from book_core.contracts import DocumentRevision
from book_core.embedding import (
    DEFAULT_REVISION,
    Qwen3Embedder,
    Qwen3EmbedderConfig,
    Qwen3Tokenizer,
)
from book_core.parser import FakeParser
from book_core.structure import build_revision, publish
from fixture_truth import BookTruth, QuestionsTruth
from make_fixture_pdfs import OUT_DIR

pytestmark = pytest.mark.models

BOOKS = ("book-ko", "book-en")
MIN_MARGIN = 0.05
APPROX_MARGIN = 1.25
APPROX_SLACK = 3
SEED = Path(OUT_DIR) / "retrieval-seed.json"


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def _book(fixture_id: str) -> BookTruth:
    return BookTruth.model_validate_json((OUT_DIR / f"{fixture_id}.truth.json").read_bytes())


def _leaf_sections(fixture_id: str) -> dict[str, str]:
    """Leaf (level-2) section id -> heading and body text."""
    truth = _book(fixture_id)
    leaves = {s.id for s in truth.sections if s.level == 2}
    texts: dict[str, list[str]] = {sid: [] for sid in sorted(leaves)}
    for block in truth.blocks:
        if block.section_id in leaves and block.text:
            texts[block.section_id].append(block.text)
    return {sid: "\n".join(parts) for sid, parts in texts.items()}


@pytest.fixture(scope="module")
def embedder() -> Qwen3Embedder:
    return Qwen3Embedder()


@pytest.fixture(scope="module")
def tokenizer() -> Qwen3Tokenizer:
    return Qwen3Tokenizer()


def test_dimension_unit_norm_and_end_of_text_token(embedder: Qwen3Embedder) -> None:
    assert embedder.dimension == 1024
    assert embedder.config.revision == DEFAULT_REVISION
    vectors = embedder.embed_documents(["물의 순환", "The water cycle"])
    vectors.append(embedder.embed_query("x"))
    for vector in vectors:
        assert len(vector) == 1024
        assert _norm(vector) == pytest.approx(1.0, abs=1e-5)
    # Last-token pooling relies on the tokenizer appending <|endoftext|> at this revision.
    hf_tokenizer = embedder._load()._tokenizer  # type: ignore[attr-defined]
    ids = hf_tokenizer(["물의 순환"])["input_ids"][0]
    assert hf_tokenizer.convert_ids_to_tokens(ids[-1]) == "<|endoftext|>"


def test_deterministic_across_calls(embedder: Qwen3Embedder) -> None:
    texts = ["증발과 응결", "Coagulation and sedimentation", "2.1 응집과 침전"]
    assert embedder.embed_documents(texts) == embedder.embed_documents(texts)
    assert embedder.embed_query("구름") == embedder.embed_query("구름")


def test_batch_matches_single(embedder: Qwen3Embedder) -> None:
    texts = [text for fixture_id in BOOKS for text in _leaf_sections(fixture_id).values()]
    texts += ["짧은 문장", "short"]
    batched = embedder.embed_documents(texts)
    for text, vector in zip(texts, batched, strict=True):
        [single] = embedder.embed_documents([text])
        assert _cos(vector, single) >= 0.999


def test_query_instruction_changes_query_side(embedder: Qwen3Embedder) -> None:
    query = "how do paved cities change surface runoff"
    [as_document] = embedder.embed_documents([query])
    assert _cos(embedder.embed_query(query), as_document) < 0.99


def test_mrl_truncation_matches_prefix_of_full_vector(embedder: Qwen3Embedder) -> None:
    short = Qwen3Embedder(Qwen3EmbedderConfig(dimension=256), loader=lambda _: embedder._load())
    [full] = embedder.embed_documents(["정수 처리 과정"])
    [vector] = short.embed_documents(["정수 처리 과정"])
    head = full[:256]
    assert vector == pytest.approx([x / _norm(head) for x in head], abs=1e-5)


def test_ko_en_seed_queries_rank_relevant_sections(embedder: Qwen3Embedder) -> None:
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    sections = {fid: _leaf_sections(fid) for fid in BOOKS}
    vectors = {
        fid: dict(zip(secs, embedder.embed_documents(list(secs.values())), strict=True))
        for fid, secs in sections.items()
    }
    report: list[str] = []
    for query in seed["queries"]:
        qv = embedder.embed_query(query["query"])
        for relevant in query["relevant"]:
            fid, sid = relevant["fixture_id"], relevant["section_id"]
            scores = {s: _cos(qv, v) for s, v in vectors[fid].items()}
            ranked = sorted(scores, key=lambda s: -scores[s])
            chapter = sid.split("-")[0]
            unrelated = max(v for s, v in scores.items() if not s.startswith(f"{chapter}-"))
            report.append(
                f"{query['id']} {fid}: rank {ranked.index(sid) + 1} "
                f"rel={scores[sid]:.3f} best-unrelated={unrelated:.3f}"
            )
            assert ranked[0] == sid, report[-1]
            assert scores[sid] >= unrelated + MIN_MARGIN, report[-1]
    print("\n".join(report))


def _truth_revision(fixture_id: str) -> DocumentRevision:
    parser = FakeParser.from_truth_files([OUT_DIR / f"{fixture_id}.truth.json"])
    parsed = parser.parse(OUT_DIR / f"{fixture_id}.pdf")
    return publish(build_revision(parsed, document_id="doc-1", revision_id="rev-1").revision)


def _fixture_texts() -> dict[str, list[str]]:
    texts = {fid: [b.text for b in _book(fid).blocks if b.text] for fid in BOOKS}
    questions = QuestionsTruth.model_validate_json(
        (OUT_DIR / "questions-ko.truth.json").read_bytes()
    )
    texts["questions-ko"] = [
        text for q in questions.questions for text in (q.stem, *(o.text for o in q.options))
    ]
    return texts


def test_approx_tokenizer_vs_qwen3_tokenizer(tokenizer: Qwen3Tokenizer) -> None:
    approx = ApproxTokenizer()
    report = []
    for fixture_id, texts in _fixture_texts().items():
        a = sum(approx.count(t) for t in texts)
        r = sum(tokenizer.count(t) for t in texts)
        worst = max(tokenizer.count(t) / approx.count(t) for t in texts)
        report.append(f"{fixture_id}: approx={a} real={r} ratio={a / r:.2f} worst={worst:.2f}")
        assert a >= r, report[-1]  # over-counts in total
        for text in texts:
            assert tokenizer.count(text) <= APPROX_MARGIN * approx.count(text) + APPROX_SLACK, text
    print("\n".join(report))


@pytest.mark.parametrize("fixture_id", BOOKS)
def test_chunker_budgets_hold_under_real_tokenizer(
    fixture_id: str, tokenizer: Qwen3Tokenizer
) -> None:
    revision = _truth_revision(fixture_id)
    small = ChunkerConfig(target_tokens=64, max_tokens=96, overlap_tokens=24, parent_max_tokens=208)
    for config in (ChunkerConfig(), small):
        # Budgeted with the approximation: the real count stays within the documented margin.
        approx = chunk_revision(revision, config=config)
        for child in approx.children:
            assert tokenizer.count(child.search_text) <= APPROX_MARGIN * config.max_tokens
        # The real tokenizer plugs into the chunker directly.
        real = chunk_revision(revision, config=config, tokenizer=tokenizer)
        assert real.tokenizer == tokenizer.name
        for child in real.children:
            assert tokenizer.count(child.search_text) <= config.max_tokens
