"""Qwen3-Reranker adapter without weights (M2.4): config, prompt format, batching, scoring.

A scripted backend stands in for tokenizer + causal LM, so these run in ``make test``. The real
model is exercised in ``test_reranker_qwen3.py`` (``models``).
"""

from __future__ import annotations

import zlib
from pathlib import Path
from typing import Any

import pytest
from book_core.embedding import ModelUnavailableError
from book_core.reranker import (
    DEFAULT_RERANK_INSTRUCTION,
    DEFAULT_RERANKER_MODEL_ID,
    DEFAULT_RERANKER_REVISION,
    FakeReranker,
    Qwen3Reranker,
    Qwen3RerankerConfig,
    Reranker,
)
from book_core.reranker.qwen3 import PROMPT_PREFIX, PROMPT_SUFFIX, format_pair


def test_adapters_satisfy_the_protocol() -> None:
    assert isinstance(Qwen3Reranker(), Reranker)
    assert isinstance(FakeReranker(), Reranker)


def test_defaults_follow_the_model_card() -> None:
    config = Qwen3RerankerConfig()
    assert config.model_id == DEFAULT_RERANKER_MODEL_ID == "Qwen/Qwen3-Reranker-0.6B"
    assert config.revision == DEFAULT_RERANKER_REVISION
    assert len(config.revision) == 40
    assert int(config.revision, 16) >= 0  # a full commit hash, not a branch name
    assert config.device == "cpu"
    assert config.dtype == "float32"
    assert config.instruction == DEFAULT_RERANK_INSTRUCTION
    assert Qwen3Reranker().model_name == f"{DEFAULT_RERANKER_MODEL_ID}@{DEFAULT_RERANKER_REVISION}"
    assert PROMPT_PREFIX.startswith("<|im_start|>system\nJudge whether the Document")
    assert PROMPT_SUFFIX == "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"model_id": " "}, "model_id"),
        ({"revision": ""}, "revision"),
        ({"dtype": "int8"}, "dtype"),
        ({"batch_size": 0}, "batch_size"),
        ({"max_length": 64}, "max_length"),
        ({"num_threads": 0}, "num_threads"),
    ],
)
def test_config_rejects_invalid_values(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        Qwen3RerankerConfig(**kwargs)


class ScriptedBackend:
    """Deterministic (yes, no) logits from a checksum of each prompt; records batches."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    @staticmethod
    def logits(prompt: str) -> tuple[float, float]:
        digest = zlib.crc32(prompt.encode())
        return (digest % 1000) / 100.0, (digest // 1000 % 1000) / 100.0

    def yes_no_logits(self, prompts: list[str]) -> list[tuple[float, float]]:
        self.batches.append(list(prompts))
        return [self.logits(p) for p in prompts]


def _reranker(
    backend: Any = None, **kwargs: Any
) -> tuple[Qwen3Reranker, Any, list[Qwen3RerankerConfig]]:
    backend = backend or ScriptedBackend()
    loads: list[Qwen3RerankerConfig] = []

    def loader(config: Qwen3RerankerConfig) -> Any:
        loads.append(config)
        return backend

    return Qwen3Reranker(Qwen3RerankerConfig(**kwargs), loader=loader), backend, loads


def test_loads_lazily_and_once() -> None:
    reranker, _, loads = _reranker()
    assert reranker.score("q", []) == []
    assert loads == []
    reranker.score("q", ["a"])
    reranker.score("q", ["b", "c"])
    assert len(loads) == 1


def test_prompt_follows_the_card_template_and_instruction_is_configurable() -> None:
    reranker, backend, _ = _reranker()
    reranker.score("빗물이 스며드는 과정", ["1장 > 1.2 강수와 유출\n지하수"])
    assert backend.batches == [
        [
            f"<Instruct>: {DEFAULT_RERANK_INSTRUCTION}\n<Query>: 빗물이 스며드는 과정\n"
            "<Document>: 1장 > 1.2 강수와 유출\n지하수"
        ]
    ]
    custom, custom_backend, _ = _reranker(instruction="Find the textbook section")
    custom.score("q", ["p"])
    assert custom_backend.batches == [[format_pair("Find the textbook section", "q", "p")]]
    empty, empty_backend, _ = _reranker(instruction="")
    empty.score("q", ["p"])
    assert empty_backend.batches == [[format_pair(DEFAULT_RERANK_INSTRUCTION, "q", "p")]]


def test_score_is_the_yes_minus_no_logit_in_input_order() -> None:
    reranker, _, _ = _reranker()
    passages = ["short", "a much longer passage", "mid length"]
    scores = reranker.score("q", passages)
    expected = [
        ScriptedBackend.logits(reranker.prompt("q", p))[0]
        - ScriptedBackend.logits(reranker.prompt("q", p))[1]
        for p in passages
    ]
    assert scores == pytest.approx(expected)


def test_batching_is_longest_first_and_matches_single_pair_scoring() -> None:
    passages = [f"passage {'x' * (i * 5 % 9)} {i}" for i in range(11)]
    batched, backend, _ = _reranker(batch_size=4)
    single, _, _ = _reranker(batch_size=1)
    result = batched.score("query", passages)
    assert [len(b) for b in backend.batches] == [4, 4, 3]
    lengths = [len(p) for b in backend.batches for p in b]
    assert lengths == sorted(lengths, reverse=True)
    assert result == single.score("query", passages)
    assert result == batched.score("query", passages)


def test_backend_returning_the_wrong_count_is_an_error() -> None:
    class Short(ScriptedBackend):
        def yes_no_logits(self, prompts: list[str]) -> list[tuple[float, float]]:
            return super().yes_no_logits(prompts)[:-1]

    reranker, _, _ = _reranker(Short())
    with pytest.raises(RuntimeError, match="wrong number"):
        reranker.score("q", ["a", "b"])


def test_missing_weights_raise_model_unavailable(tmp_path: Path) -> None:
    config = Qwen3RerankerConfig(cache_dir=tmp_path, local_files_only=True)
    with pytest.raises(ModelUnavailableError, match=r"hf download Qwen/Qwen3-Reranker-0\.6B"):
        Qwen3Reranker(config).score("q", ["p"])
