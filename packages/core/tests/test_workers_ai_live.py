"""Real Cloudflare Workers AI round trip and parity with the local Qwen3 embedder (M7.4b).

Marked ``workers_ai``: opt-in, uses the account's daily neuron quota, excluded from ``make test``.
Run with ``make test-workers-ai`` and ``CLOUDFLARE_ACCOUNT_ID`` / ``CLOUDFLARE_API_TOKEN`` set
(docs/runbook-deploy.md §3 step 9); fails, never skips, without them. The parity check also needs
the local Qwen3-Embedding-0.6B weights (HF_HOME, downloaded on first use like ``models`` tests).

Sends only the short synthetic KO/EN sentences below, never fixture or book text.
"""

from __future__ import annotations

import math
import os

import pytest
from book_core.embedding import (
    DEFAULT_QUERY_INSTRUCTION,
    EmbeddingAuthError,
    Qwen3Embedder,
    Qwen3EmbedderConfig,
)
from book_core.embedding.workers_ai import WORKERS_AI_DIMENSION, WorkersAIConfig, WorkersAIEmbedder

pytestmark = pytest.mark.workers_ai

DOCUMENTS = [
    "물은 증발하여 수증기가 되고, 높은 곳에서 식어 구름이 된다.",
    "Water evaporates into vapour and condenses into clouds as it cools.",
    "정수장에서는 염소를 넣어 물속의 세균을 없앤다.",
    "Chlorine is added at the treatment plant to kill bacteria in the water.",
]
QUERIES = ["정수장에서 염소를 넣는 이유", "why do treatment plants add chlorine"]
# Same model and instruction on both sides; only numerics (precision, kernels) may differ.
MIN_PARITY = 0.97


def _config() -> WorkersAIConfig:
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    hint = "set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to run workers_ai-marked tests"
    assert account, hint
    assert token, hint
    return WorkersAIConfig(account_id=account, api_token=token)


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def test_real_round_trip_matches_the_adapter_contract() -> None:
    hosted = WorkersAIEmbedder(_config())
    vectors = hosted.embed_documents(DOCUMENTS)
    assert len(vectors) == len(DOCUMENTS)
    assert all(len(v) == WORKERS_AI_DIMENSION for v in vectors)
    query = hosted.embed_query(QUERIES[0])
    assert len(query) == WORKERS_AI_DIMENSION
    # Retrieval sanity: the KO chlorine query is closest to a chlorine sentence (KO or EN).
    ranked = sorted(range(len(DOCUMENTS)), key=lambda i: -_cos(query, vectors[i]))
    assert ranked[0] in (2, 3)


def test_hosted_vectors_match_the_local_qwen3_embedder() -> None:
    hosted = WorkersAIEmbedder(_config())
    local = Qwen3Embedder(Qwen3EmbedderConfig(query_instruction=DEFAULT_QUERY_INSTRUCTION))
    assert local.dimension == WORKERS_AI_DIMENSION

    documents = [
        _cos(a, b)
        for a, b in zip(
            hosted.embed_documents(DOCUMENTS), local.embed_documents(DOCUMENTS), strict=True
        )
    ]
    queries = [_cos(hosted.embed_query(q), local.embed_query(q)) for q in QUERIES]
    # A mismatch here most likely means the request format assumption (`documents`, `queries` +
    # `instruction`) is wrong; record the finding in implementation-plan §7.
    assert min(documents) >= MIN_PARITY, documents
    assert min(queries) >= MIN_PARITY, queries


def test_a_wrong_token_is_an_auth_error() -> None:
    config = _config()
    bad = WorkersAIConfig(account_id=config.account_id, api_token="invalid-" + "x" * 32)
    with pytest.raises(EmbeddingAuthError):
        WorkersAIEmbedder(bad).embed_query("hello")
