"""Deterministic fake adapters for embedding, reranker and LLM (P0.8)."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import traceback

import pytest
from book_core.embedding import Embedder, FakeEmbedder
from book_core.llm import (
    FakeLLMClient,
    FakeLLMNotScriptedError,
    LLMClient,
    LLMOutputError,
    LLMRequest,
    parse_structured_output,
)
from book_core.reranker import FakeReranker, Reranker
from pydantic import BaseModel, ConfigDict


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_fakes_satisfy_protocols() -> None:
    assert isinstance(FakeEmbedder(), Embedder)
    assert isinstance(FakeReranker(), Reranker)
    assert isinstance(FakeLLMClient(), LLMClient)


def test_fake_embedder_is_unit_length_and_deterministic() -> None:
    embedder = FakeEmbedder(dimension=32)
    texts = ["광합성은 빛 에너지를 화학 에너지로 바꾼다.", "Photosynthesis", "!!!", ""]
    vectors = embedder.embed_documents(texts)
    assert vectors == embedder.embed_documents(texts)
    for vector in vectors:
        assert len(vector) == 32
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0)
    assert embedder.embed_query(texts[0]) == vectors[0]


def test_fake_embedder_ranks_overlapping_text_higher() -> None:
    embedder = FakeEmbedder()
    query = embedder.embed_query("photosynthesis light energy")
    related, unrelated = embedder.embed_documents(
        ["Photosynthesis converts light energy.", "The French revolution began in 1789."]
    )
    assert _cosine(query, related) > _cosine(query, unrelated)


def test_fake_embedder_is_stable_across_hash_seeds() -> None:
    code = "from book_core.embedding import FakeEmbedder; print(FakeEmbedder(8).embed_query('a b'))"
    outputs = {
        subprocess.run(  # noqa: S603
            [sys.executable, "-c", code],
            env={**os.environ, "PYTHONHASHSEED": seed},
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        for seed in ("1", "2")
    }
    assert len(outputs) == 1


def test_fake_embedder_rejects_bad_dimension() -> None:
    with pytest.raises(ValueError, match="dimension"):
        FakeEmbedder(dimension=0)


def test_fake_reranker_scores_by_query_coverage() -> None:
    reranker = FakeReranker()
    scores = reranker.score("세포 호흡", ["세포 호흡 과정은 에너지를 만든다", "세포 분열", ""])
    assert scores[0] == 1.0
    assert scores[1] < scores[0]
    assert scores[2] == 0.0
    assert all(0.0 <= s <= 1.0 for s in scores)
    assert reranker.score("", ["anything"]) == [0.0]


class _Answer(BaseModel):
    stem: str
    option_count: int


REQUEST = LLMRequest(task="questions.extract", prompt_version="v1", prompt="Extract page 1")


def test_fake_llm_returns_scripted_structured_output() -> None:
    client = FakeLLMClient()
    client.script("questions.extract", {"stem": "Q?", "option_count": 4})
    exact = REQUEST.model_copy(update={"prompt": "Extract page 2"})
    client.script(exact, _Answer(stem="exact", option_count=2))

    assert client.generate(REQUEST, _Answer) == _Answer(stem="Q?", option_count=4)
    assert client.generate(exact, _Answer).stem == "exact"
    assert client.calls == [REQUEST, exact]


def test_fake_llm_raises_on_unscripted_request() -> None:
    with pytest.raises(FakeLLMNotScriptedError, match=r"questions\.extract"):
        FakeLLMClient().generate(REQUEST, _Answer)


@pytest.mark.parametrize("raw", ["not json", '{"stem": "Q?"}'])
def test_fake_llm_surfaces_schema_violations(raw: str) -> None:
    client = FakeLLMClient()
    client.script("questions.extract", raw)
    with pytest.raises(LLMOutputError) as info:
        client.generate(REQUEST, _Answer)
    assert info.value.raw_output == raw
    assert info.value.schema is _Answer


def test_llm_request_fingerprint_is_stable() -> None:
    same = LLMRequest(task="questions.extract", prompt_version="v1", prompt="Extract page 1")
    assert REQUEST.fingerprint() == same.fingerprint()
    assert REQUEST.fingerprint() != REQUEST.model_copy(update={"system": "s"}).fingerprint()


BOOK_TEXT = "PRIVATE BOOK PASSAGE 비공개 본문"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stem: str
    option_count: int


@pytest.mark.parametrize(
    "raw",
    [
        json.dumps({"stem": "Q?", "option_count": BOOK_TEXT}, ensure_ascii=False),
        json.dumps({"stem": ["not", BOOK_TEXT], "option_count": 1}, ensure_ascii=False),
        json.dumps({"stem": "Q?", "option_count": 1, BOOK_TEXT: "extra"}, ensure_ascii=False),
        f"{BOOK_TEXT} is not JSON",
    ],
    ids=["wrong-type", "nested-input", "extra-key", "invalid-json"],
)
def test_llm_output_error_never_exposes_raw_output(raw: str) -> None:
    with pytest.raises(LLMOutputError) as info:
        parse_structured_output(raw, _Strict)
    err = info.value
    rendered = "".join(traceback.format_exception(err))

    assert err.raw_output == raw
    assert err.__cause__ is None
    assert err.__suppress_context__
    for text in (str(err), repr(err), repr(err.args), err.detail, rendered):
        assert "PRIVATE" not in text
        assert "비공개" not in text
    assert "_Strict" in str(err)
