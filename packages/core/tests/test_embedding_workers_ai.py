"""Cloudflare Workers AI embedding adapter (M7.4b): request/response contract on a mocked HTTP
transport. No test here talks to Cloudflare; the real round trip is `test_workers_ai_live.py`
(marker `workers_ai`)."""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Callable

import httpx
import pytest
from book_core.embedding import (
    DEFAULT_QUERY_INSTRUCTION,
    Embedder,
    EmbedderMode,
    EmbeddingAuthError,
    EmbeddingQuotaExceededError,
    EmbeddingResponseError,
    EmbeddingUnavailableError,
    select_embedder,
)
from book_core.embedding.workers_ai import (
    WORKERS_AI_DIMENSION,
    WORKERS_AI_MODEL,
    WorkersAIConfig,
    WorkersAIEmbedder,
)
from book_core.indexing import embedder_model_key

ACCOUNT = "0123456789abcdef0123456789abcdef"
TOKEN = "cf-token-that-must-never-be-printed-0123456789"  # noqa: S105
BOOK_TEXT = "정수장에서는 염소를 넣어 세균을 없앤다. Chlorine disinfects the water."
URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/@cf/qwen/qwen3-embedding-0.6b"
)

Handler = Callable[[httpx.Request], httpx.Response]


def _vector(seed: int, dim: int = WORKERS_AI_DIMENSION) -> list[float]:
    # Not normalised on purpose: the adapter L2-normalises like the local Qwen3 embedder.
    return [float((seed * 31 + i) % 7 + 1) for i in range(dim)]


def _ok(vectors: list[list[float]]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "result": {"data": vectors, "shape": [len(vectors), len(vectors[0]) if vectors else 0]},
            "success": True,
            "errors": [],
            "messages": [],
        },
    )


def _error(status: int, code: int = 0, message: str = "error") -> httpx.Response:
    return httpx.Response(
        status,
        json={"result": None, "success": False, "errors": [{"code": code, "message": message}]},
    )


class Recorder:
    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)

    def bodies(self) -> list[dict[str, object]]:
        return [json.loads(r.content) for r in self.requests]


def _embedder(
    handler: Handler, *, sleeps: list[float] | None = None, **config: object
) -> tuple[WorkersAIEmbedder, Recorder]:
    recorder = Recorder(handler)
    client = httpx.Client(transport=httpx.MockTransport(recorder))
    settings = WorkersAIConfig(account_id=ACCOUNT, api_token=TOKEN, **config)  # type: ignore[arg-type]
    sink = sleeps if sleeps is not None else []
    return WorkersAIEmbedder(settings, client=client, sleep=sink.append), recorder


def _echo_documents(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    texts = body.get("documents") or body.get("queries")
    return _ok([_vector(len(t)) for t in texts])


# --- request shape ------------------------------------------------------------------------------


def test_documents_are_posted_in_batches_with_a_bearer_token_and_keep_their_order() -> None:
    texts = [f"passage {i} " + "x" * i for i in range(5)]
    embedder, recorder = _embedder(_echo_documents, batch_size=2)

    vectors = embedder.embed_documents(texts)

    assert [str(r.url) for r in recorder.requests] == [URL] * 3
    assert all(r.method == "POST" for r in recorder.requests)
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in recorder.requests)
    assert all(r.headers["content-type"] == "application/json" for r in recorder.requests)
    assert recorder.bodies() == [
        {"documents": texts[0:2]},
        {"documents": texts[2:4]},
        {"documents": texts[4:5]},
    ]
    assert len(vectors) == 5
    for text, vector in zip(texts, vectors, strict=True):
        expected = _vector(len(text))
        norm = math.sqrt(sum(v * v for v in expected))
        assert vector == pytest.approx([v / norm for v in expected])
        assert math.isclose(sum(v * v for v in vector), 1.0, rel_tol=1e-9)


def test_queries_use_the_local_qwen3_retrieval_instruction() -> None:
    embedder, recorder = _embedder(_echo_documents)

    vector = embedder.embed_query("염소를 넣는 이유")

    assert recorder.bodies() == [
        {"queries": ["염소를 넣는 이유"], "instruction": DEFAULT_QUERY_INSTRUCTION}
    ]
    assert len(vector) == WORKERS_AI_DIMENSION


def test_no_request_for_no_documents() -> None:
    embedder, recorder = _embedder(_echo_documents)
    assert embedder.embed_documents([]) == []
    assert recorder.requests == []


def test_identity_is_static_and_differs_from_the_local_model() -> None:
    embedder, recorder = _embedder(_echo_documents)
    assert isinstance(embedder, Embedder)
    assert embedder.dimension == WORKERS_AI_DIMENSION == 1024
    assert embedder.model_name == f"cloudflare-workers-ai:{WORKERS_AI_MODEL}"
    assert WORKERS_AI_MODEL == "@cf/qwen/qwen3-embedding-0.6b"
    # Reading the identity (the store's model key) never calls the API.
    assert recorder.requests == []
    local = select_embedder(EmbedderMode.QWEN3, test_env=False)
    assert embedder.model_name != local.model_name
    assert ACCOUNT not in embedder.model_name


def test_the_collection_key_never_mixes_local_and_hosted_vectors() -> None:
    hosted, _ = _embedder(_echo_documents)

    class Local:
        model_name = select_embedder(EmbedderMode.QWEN3, test_env=False).model_name
        dimension = WORKERS_AI_DIMENSION

        def embed_documents(self, texts: object) -> list[list[float]]:  # pragma: no cover
            raise AssertionError

        def embed_query(self, text: str) -> list[float]:  # pragma: no cover
            raise AssertionError

    assert embedder_model_key(hosted) != embedder_model_key(Local())


def test_config_validation_and_secret_free_repr() -> None:
    config = WorkersAIConfig(account_id=ACCOUNT, api_token=TOKEN)
    assert config.batch_size >= 1
    assert config.batch_size <= 32  # conservative default for the Free plan
    assert config.timeout_seconds > 0
    assert TOKEN not in repr(config)
    assert TOKEN not in str(config)
    for bad in (
        {"account_id": "", "api_token": TOKEN},
        {"account_id": ACCOUNT, "api_token": ""},
        {"account_id": "../x", "api_token": TOKEN},
        {"account_id": ACCOUNT, "api_token": TOKEN, "batch_size": 0},
        {"account_id": ACCOUNT, "api_token": TOKEN, "timeout_seconds": 0},
        {"account_id": ACCOUNT, "api_token": TOKEN, "max_attempts": 0},
    ):
        with pytest.raises(ValueError, match=r"must|account|token") as info:
            WorkersAIConfig(**bad)
        assert TOKEN not in str(info.value)


def test_factory_selects_workers_ai_with_its_config_only() -> None:
    config = WorkersAIConfig(account_id=ACCOUNT, api_token=TOKEN)
    embedder = select_embedder(EmbedderMode.WORKERS_AI, test_env=False, workers_ai=config)
    assert isinstance(embedder, WorkersAIEmbedder)
    assert embedder.model_name == f"cloudflare-workers-ai:{WORKERS_AI_MODEL}"
    # Even in the test environment an explicit mode is honoured (auto stays fake there).
    assert isinstance(
        select_embedder("workers_ai", test_env=True, workers_ai=config), WorkersAIEmbedder
    )
    with pytest.raises(EmbeddingAuthError) as info:
        select_embedder(EmbedderMode.WORKERS_AI, test_env=False)
    assert "CLOUDFLARE_ACCOUNT_ID" in str(info.value)


# --- response validation ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "response",
    [
        _ok([_vector(1, dim=256)]),  # wrong dimension
        _ok([]),  # wrong count
        httpx.Response(200, json={"success": True, "result": {"shape": [1, 1024]}}),
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, json={"success": False, "errors": [], "result": None}),
        _ok([[0.0] * WORKERS_AI_DIMENSION]),  # zero vector (cannot be normalised)
    ],
)
def test_malformed_responses_are_typed_errors(response: httpx.Response) -> None:
    embedder, _ = _embedder(lambda _r: response)
    with pytest.raises(EmbeddingResponseError) as info:
        embedder.embed_documents([BOOK_TEXT])
    assert isinstance(info.value, EmbeddingUnavailableError)
    assert info.value.retryable is False
    assert BOOK_TEXT not in str(info.value)


# --- failures -----------------------------------------------------------------------------------


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_retried_with_backoff_then_raise_unavailable(status: int) -> None:
    sleeps: list[float] = []
    embedder, recorder = _embedder(lambda _r: _error(status), sleeps=sleeps, max_attempts=3)

    with pytest.raises(EmbeddingUnavailableError) as info:
        embedder.embed_documents([BOOK_TEXT])

    assert type(info.value) is EmbeddingUnavailableError
    assert info.value.code == "embedding_unavailable"
    assert info.value.retryable is True
    assert len(recorder.requests) == 3
    assert len(sleeps) == 2
    assert all(0 < s <= embedder.config.max_delay_seconds for s in sleeps)
    assert sleeps[1] >= sleeps[0] * 0.5  # exponential with jitter, never collapsing to zero


def test_a_transient_error_then_success_returns_the_vectors() -> None:
    answers = iter([_error(503), _error(429), None])

    def handler(request: httpx.Request) -> httpx.Response:
        answer = next(answers)
        return answer if answer is not None else _echo_documents(request)

    embedder, recorder = _embedder(handler, max_attempts=3)
    assert len(embedder.embed_documents([BOOK_TEXT])) == 1
    assert len(recorder.requests) == 3


def test_rate_limiting_honours_retry_after_and_ends_as_quota_exceeded() -> None:
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        response = _error(429, 3040, "Capacity temporarily exceeded")
        response.headers["Retry-After"] = "2"
        return response

    embedder, recorder = _embedder(handler, sleeps=sleeps, max_attempts=2)
    with pytest.raises(EmbeddingQuotaExceededError) as info:
        embedder.embed_query(BOOK_TEXT)
    assert info.value.code == "embedding_quota_exceeded"
    assert info.value.retryable is True
    assert len(recorder.requests) == 2
    assert sleeps == [2.0]


@pytest.mark.parametrize("status", [400, 429])
def test_the_daily_free_allocation_fails_fast_as_quota_exceeded(status: int) -> None:
    # Workers Free: over 10,000 neurons/day is refused until the daily reset; retrying in-process
    # cannot help, the job's own backoff retries later.
    message = "you have used up your daily free allocation of 10,000 neurons"
    embedder, recorder = _embedder(lambda _r: _error(status, 4006, message), max_attempts=4)
    with pytest.raises(EmbeddingQuotaExceededError):
        embedder.embed_documents([BOOK_TEXT])
    assert len(recorder.requests) == 1


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failures_are_not_retried(status: int) -> None:
    embedder, recorder = _embedder(lambda _r: _error(status, 10000, "Authentication error"))
    with pytest.raises(EmbeddingAuthError) as info:
        embedder.embed_documents([BOOK_TEXT])
    assert info.value.code == "embedding_not_configured"
    assert info.value.retryable is False
    assert len(recorder.requests) == 1


def test_other_client_errors_are_not_retried() -> None:
    embedder, recorder = _embedder(lambda _r: _error(413, 0, "payload too large"))
    with pytest.raises(EmbeddingResponseError):
        embedder.embed_documents([BOOK_TEXT])
    assert len(recorder.requests) == 1


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ReadTimeout("timed out"),
        httpx.ConnectTimeout("timed out"),
        httpx.ConnectError("refused"),
        httpx.RemoteProtocolError("eof"),
    ],
)
def test_timeouts_and_transport_errors_are_retried_then_unavailable(exc: Exception) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise exc

    embedder, recorder = _embedder(handler, max_attempts=2)
    with pytest.raises(EmbeddingUnavailableError) as info:
        embedder.embed_documents([BOOK_TEXT])
    assert info.value.code == "embedding_unavailable"
    assert len(recorder.requests) == 2


def test_the_configured_timeout_reaches_the_request() -> None:
    seen: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions.get("timeout"))
        return _echo_documents(request)

    embedder, _ = _embedder(handler, timeout_seconds=7.5)
    embedder.embed_query("q")
    assert seen
    timeout = seen[0]
    assert isinstance(timeout, dict)
    assert timeout["read"] == 7.5


# --- nothing leaks ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "handler",
    [
        lambda _r: _error(500, 0, BOOK_TEXT),
        lambda _r: _error(429, 4006, BOOK_TEXT),
        lambda _r: _error(401, 10000, BOOK_TEXT),
        lambda _r: _ok([_vector(1, dim=3)]),
    ],
)
def test_errors_and_logs_never_carry_input_text_token_or_account(
    handler: Handler, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    embedder, _ = _embedder(handler, max_attempts=2)
    with pytest.raises(EmbeddingUnavailableError) as info:
        embedder.embed_documents([BOOK_TEXT])

    rendered = [str(info.value), repr(info.value), caplog.text]
    cause = info.value.__cause__ or info.value.__context__
    if cause is not None:
        rendered.append(str(cause))
    for text in rendered:
        assert BOOK_TEXT not in text
        assert "염소" not in text
        assert TOKEN not in text
        assert ACCOUNT not in text
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__ is True


# --- eval scaffolding (never runs the API here) ---------------------------------------------------


def test_the_workers_ai_eval_config_is_valid_and_needs_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pathlib import Path

    from book_core.evaluation.runner import EvalConfig, make_embedder

    path = Path(__file__).resolve().parents[3] / "eval" / "configs" / "workers-ai.json"
    config = EvalConfig.model_validate_json(path.read_text(encoding="utf-8"))
    assert config.embedder == "workers_ai"
    assert config.embedding_dimension == WORKERS_AI_DIMENSION
    assert config.reranker == "none"  # like staging/production
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    with pytest.raises(ValueError, match="CLOUDFLARE_ACCOUNT_ID"):
        make_embedder("workers_ai", config.embedding_dimension)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", TOKEN)
    assert isinstance(make_embedder("workers_ai", None), WorkersAIEmbedder)
    with pytest.raises(ValueError, match="1024"):
        make_embedder("workers_ai", 256)
