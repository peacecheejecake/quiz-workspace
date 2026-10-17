"""Embedding adapters without model weights (M2.1).

- ``FakeEmbedder``: the deterministic contract E2E/CI rely on.
- ``Qwen3Embedder``: config validation, query instruction, pooling, MRL truncation,
  normalisation and batching, with the transformer forward pass replaced by a scripted backend.
- Missing weights fail with ``ModelUnavailableError`` (offline, empty cache).

Real-model tests live in ``test_embedding_qwen3.py`` (marker ``models``).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pytest
import torch
from book_core.chunker import Tokenizer
from book_core.embedding import (
    DEFAULT_MODEL_ID,
    DEFAULT_QUERY_INSTRUCTION,
    DEFAULT_REVISION,
    Embedder,
    FakeEmbedder,
    ModelUnavailableError,
    Qwen3Embedder,
    Qwen3EmbedderConfig,
    Qwen3Tokenizer,
)
from book_core.embedding.qwen3 import last_token_pool

TEXTS = ["정수장에서 염소를 넣는 이유", "Chlorine disinfects water.", "", "구름 a b c", "x"]


def _norm(vector: list[float]) -> float:
    return math.sqrt(sum(x * x for x in vector))


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True)) / (_norm(a) * _norm(b))


# --- FakeEmbedder contract -------------------------------------------------------------------


@pytest.mark.parametrize("dimension", [1, 8, 64, 1024])
def test_fake_embedder_dims_and_unit_norm(dimension: int) -> None:
    embedder = FakeEmbedder(dimension=dimension)
    assert embedder.dimension == dimension
    vectors = [*embedder.embed_documents(TEXTS), embedder.embed_query(TEXTS[0])]
    for vector in vectors:
        assert len(vector) == dimension
        assert _norm(vector) == pytest.approx(1.0)


def test_fake_embedder_is_deterministic_across_instances_and_batches() -> None:
    first = FakeEmbedder().embed_documents(TEXTS)
    assert FakeEmbedder().embed_documents(TEXTS) == first
    # Batch composition and order never change a text's vector.
    assert [FakeEmbedder().embed_documents([t])[0] for t in TEXTS] == first
    assert FakeEmbedder().embed_documents(list(reversed(TEXTS))) == list(reversed(first))
    assert FakeEmbedder().embed_documents([]) == []


def test_fake_embedder_query_and_document_sides() -> None:
    """Queries and documents go through separate methods; the fake maps both the same way.

    Unlike Qwen3 (instruction-prefixed queries) the fake is symmetric, so a query equal to a
    document text is its nearest neighbour: fixture rankings stay explainable by word overlap.
    """
    embedder = FakeEmbedder()
    query = embedder.embed_query("염소 소독")
    assert isinstance(query, list)
    assert all(isinstance(x, float) for x in query)
    assert query == embedder.embed_documents(["염소 소독"])[0]
    docs = embedder.embed_documents(["염소 소독은 미생물을 억제한다", "구름이 만들어진다"])
    assert _cos(query, docs[0]) > _cos(query, docs[1])


def test_adapters_satisfy_protocols() -> None:
    assert isinstance(FakeEmbedder(), Embedder)
    assert isinstance(Qwen3Embedder(), Embedder)
    assert isinstance(Qwen3Tokenizer(), Tokenizer)


# --- Qwen3Embedder config ----------------------------------------------------------------------


def test_qwen3_defaults_follow_model_card() -> None:
    config = Qwen3EmbedderConfig()
    assert config.model_id == DEFAULT_MODEL_ID == "Qwen/Qwen3-Embedding-0.6B"
    assert len(config.revision) == 40
    assert int(config.revision, 16) >= 0  # a full commit hash, not a branch name
    assert config.revision == DEFAULT_REVISION
    assert config.device == "cpu"
    assert config.dtype == "float32"
    assert config.dimension is None
    assert config.query_instruction == DEFAULT_QUERY_INSTRUCTION


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"model_id": " "}, "model_id"),
        ({"revision": ""}, "revision"),
        ({"dtype": "int8"}, "dtype"),
        ({"batch_size": 0}, "batch_size"),
        ({"max_length": 4}, "max_length"),
        ({"dimension": 16}, "dimension"),
        ({"num_threads": 0}, "num_threads"),
    ],
)
def test_qwen3_config_rejects_invalid_values(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        Qwen3EmbedderConfig(**kwargs)


def test_qwen3_tokenizer_requires_pinned_revision() -> None:
    with pytest.raises(ValueError, match="revision"):
        Qwen3Tokenizer(revision=" ")
    assert Qwen3Tokenizer().name == f"hf:{DEFAULT_MODEL_ID}@{DEFAULT_REVISION[:12]}"


# --- Qwen3Embedder with a scripted backend -----------------------------------------------------


class ScriptedBackend:
    """Stands in for tokenizer + transformer: one token per character, left padding.

    The hidden state of a token is a deterministic function of (character, position from the
    end), so the last token's state depends on the whole text's tail and on nothing else.
    """

    def __init__(self, hidden_size: int = 48, padding_side: str = "left") -> None:
        self.hidden_size = hidden_size
        self.padding_side = padding_side
        self.batches: list[list[str]] = []

    def _token_state(self, char: str, pos: int) -> torch.Tensor:
        seed = (ord(char) * 31 + pos * 7) % 9973
        generator = torch.Generator().manual_seed(seed)
        return torch.randn(self.hidden_size, generator=generator)

    def forward(self, texts: list[str]) -> tuple[torch.Tensor, torch.Tensor]:
        self.batches.append(list(texts))
        seqs = [[*t, "<eos>"] for t in texts]
        width = max(len(s) for s in seqs)
        hidden = torch.zeros(len(seqs), width, self.hidden_size)
        mask = torch.zeros(len(seqs), width, dtype=torch.long)
        for row, seq in enumerate(seqs):
            offset = width - len(seq) if self.padding_side == "left" else 0
            for pos, char in enumerate(seq):
                state = self._token_state(char[0], len(seq) - pos)
                hidden[row, offset + pos] = state + (0.01 * len(seq))
                mask[row, offset + pos] = 1
        return hidden, mask


def _embedder(
    backend: ScriptedBackend | None = None, **kwargs: Any
) -> tuple[Qwen3Embedder, ScriptedBackend, list[Qwen3EmbedderConfig]]:
    backend = backend or ScriptedBackend()
    loads: list[Qwen3EmbedderConfig] = []

    def loader(config: Qwen3EmbedderConfig) -> ScriptedBackend:
        loads.append(config)
        return backend

    return Qwen3Embedder(Qwen3EmbedderConfig(**kwargs), loader=loader), backend, loads


def test_qwen3_loads_lazily_and_once() -> None:
    embedder, _, loads = _embedder()
    assert embedder.embed_documents([]) == []
    assert loads == []
    assert embedder.dimension == 48
    embedder.embed_documents(["a"])
    embedder.embed_query("b")
    assert len(loads) == 1


def test_qwen3_query_instruction_only_on_queries() -> None:
    embedder, backend, _ = _embedder()
    embedder.embed_documents(["빗물의 침투"])
    embedder.embed_query("빗물이 땅속으로 스며드는 과정")
    assert backend.batches == [
        ["빗물의 침투"],
        [f"Instruct: {DEFAULT_QUERY_INSTRUCTION}\nQuery:빗물이 땅속으로 스며드는 과정"],
    ]
    plain, plain_backend, _ = _embedder(query_instruction="")
    assert plain.embed_query("q") == plain.embed_documents(["q"])[0]
    assert plain_backend.batches == [["q"], ["q"]]


def test_qwen3_custom_instruction_changes_query_vector() -> None:
    default, _, _ = _embedder()
    custom, backend, _ = _embedder(query_instruction="Retrieve book passages")
    assert custom.query_text("q") == "Instruct: Retrieve book passages\nQuery:q"
    assert custom.embed_query("q") != default.embed_query("q")
    assert backend.batches == [["Instruct: Retrieve book passages\nQuery:q"]]


def test_qwen3_vectors_are_unit_length_last_token_pooled() -> None:
    embedder, backend, _ = _embedder()
    vectors = embedder.embed_documents(TEXTS)
    for text, vector in zip(TEXTS, vectors, strict=True):
        assert len(vector) == 48
        assert _norm(vector) == pytest.approx(1.0, abs=1e-6)
        hidden, _ = backend.forward([text])
        expected = torch.nn.functional.normalize(hidden[:, -1], dim=1)[0].tolist()
        assert vector == pytest.approx(expected, abs=1e-6)


def test_last_token_pool_handles_right_padding() -> None:
    left = ScriptedBackend(padding_side="left")
    right = ScriptedBackend(padding_side="right")
    texts = ["long text here", "ab"]
    pooled_left = last_token_pool(*left.forward(texts))
    pooled_right = last_token_pool(*right.forward(texts))
    assert torch.allclose(pooled_left, pooled_right)


def test_qwen3_batching_preserves_input_order() -> None:
    texts = [f"text {'x' * (i * 3 % 7)} {i}" for i in range(11)]
    batched, backend, _ = _embedder(batch_size=4)
    single, _, _ = _embedder(batch_size=1)
    result = batched.embed_documents(texts)
    assert [len(b) for b in backend.batches] == [4, 4, 3]
    # Longest first, so each batch pads little; results come back in input order.
    lengths = [len(t) for b in backend.batches for t in b]
    assert lengths == sorted(lengths, reverse=True)
    for got, want in zip(result, single.embed_documents(texts), strict=True):
        assert got == pytest.approx(want, abs=1e-6)
    assert result == batched.embed_documents(texts)


def test_qwen3_mrl_truncates_then_renormalises() -> None:
    full, _, _ = _embedder()
    short, _, loads = _embedder(dimension=32)
    assert short.dimension == 32
    assert loads == []  # the configured MRL size needs no model load
    assert short.model_name == f"{DEFAULT_MODEL_ID}@{DEFAULT_REVISION}/mrl-32"
    assert full.model_name == f"{DEFAULT_MODEL_ID}@{DEFAULT_REVISION}"
    [vector] = short.embed_documents(["water"])
    [reference] = full.embed_documents(["water"])
    assert len(vector) == 32
    assert _norm(vector) == pytest.approx(1.0, abs=1e-6)
    head = reference[:32]
    assert vector == pytest.approx([x / _norm(head) for x in head], abs=1e-6)


def test_qwen3_mrl_dimension_above_hidden_size_is_rejected_on_load() -> None:
    embedder, _, _ = _embedder(dimension=64)
    with pytest.raises(ValueError, match="exceeds the model's hidden size 48"):
        embedder.embed_query("q")


# --- Missing weights -------------------------------------------------------------------------


def test_missing_weights_raise_model_unavailable(tmp_path: Path) -> None:
    config = Qwen3EmbedderConfig(cache_dir=tmp_path, local_files_only=True)
    with pytest.raises(ModelUnavailableError, match=r"hf download Qwen/Qwen3-Embedding-0\.6B"):
        Qwen3Embedder(config).embed_query("q")
    tokenizer = Qwen3Tokenizer(cache_dir=tmp_path, local_files_only=True)
    with pytest.raises(ModelUnavailableError, match="HF_HUB_OFFLINE"):
        tokenizer.count("q")
