"""AIEXPL-01 without a database: the routes are in the contract, the practice responses carry no
AI explanation, the switch and the cache key's model, and the SSE layout of the explanation stream
(the Postgres paths are covered by tests/integration/questions/ai_explanations)."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from quiz_api.ask_stream import AskStreamReader
from quiz_api.main import create_app
from quiz_api.settings import Settings


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    found: dict[str, Any] = create_app(Settings(), readiness_checkers=[]).openapi()
    return found


def _schema_keys(spec: dict[str, Any], name: str, seen: set[str] | None = None) -> set[str]:
    seen = seen if seen is not None else set()
    if name in seen:
        return set()
    seen.add(name)
    schema = spec["components"]["schemas"][name]
    keys = set(schema.get("properties", {}))
    for ref in re.findall(r'"\$ref": "#/components/schemas/([^"]+)"', json.dumps(schema)):
        keys |= _schema_keys(spec, ref, seen)
    return keys


def test_aiexpl_01_routes_are_in_the_contract(spec: dict[str, Any]) -> None:
    ops = {op["operationId"] for methods in spec["paths"].values() for op in methods.values()}
    assert {
        "getQuestionAiExplanation",
        "createQuestionAiExplanation",
        "regenerateQuestionAiExplanation",
        "streamQuestionAiExplanation",
        "getMockExamQuestionAiExplanation",
        "createMockExamQuestionAiExplanation",
        "regenerateMockExamQuestionAiExplanation",
        "streamMockExamQuestionAiExplanation",
        "getSharedQuestionAiExplanation",
    } <= ops


def test_aiexpl_01_c01_practice_responses_carry_no_ai_explanation(spec: dict[str, Any]) -> None:
    for path, methods in spec["paths"].items():
        if "practice-sessions" not in path:
            continue
        for op in methods.values():
            for response in op.get("responses", {}).values():
                refs = re.findall(r'"\$ref": "#/components/schemas/([^"]+)"', json.dumps(response))
                for ref in refs:
                    keys = _schema_keys(spec, ref)
                    assert not [k for k in keys if re.search("ai_explanation", k)], path


def test_aiexpl_01_c02_the_shared_explanation_has_no_state_or_ids(spec: dict[str, Any]) -> None:
    keys = set(spec["components"]["schemas"]["SharedExplanation"]["properties"])
    assert keys == {"body", "sources", "created_at"}


@pytest.mark.parametrize(
    ("app_env", "switch", "model", "available", "key_model"),
    [
        ("test", False, None, False, "fake-ai-explanation"),
        ("test", True, None, True, "fake-ai-explanation"),
        ("local", True, None, False, None),
        ("local", True, "model-a", True, "model-a"),
        ("local", False, "model-a", False, "model-a"),
    ],
)
def test_aiexpl_01_ac05_the_switch_and_the_cache_key_model(
    app_env: str, switch: bool, model: str | None, available: bool, key_model: str | None
) -> None:
    settings = Settings(
        APP_ENV=app_env,
        WORKER_AI_EXPLANATIONS=switch,
        LLM_MODEL=model,
        _env_file=None,  # type: ignore[call-arg]
    )
    assert settings.ai_explanations_available is available
    assert settings.ai_explanation_model == key_model


class _Redis:
    def __init__(self) -> None:
        self.keys: list[str] = []

    def xrange(self, name: str, min: str = "-", max: str = "+") -> Any:
        self.keys.append(name)
        return [(b"1-0", {b"event": b"delta", b"seq": b"1", b"data": b'{"seq":0,"text":"a"}'})]

    def xread(
        self, streams: dict[str, str], count: int | None = None, block: int | None = None
    ) -> Any:
        self.keys.extend(streams)
        return []


def test_aiexpl_01_c05_the_explanation_stream_has_its_own_key_prefix() -> None:
    client = _Redis()
    reader = AskStreamReader(client, key_prefix="explain:")
    import uuid

    explanation_id = uuid.UUID(int=5)
    assert reader.text_so_far(explanation_id) == "a"
    reader.read_after(explanation_id, "0-0", block_ms=0)
    assert client.keys == [f"explain:{explanation_id}"] * 2
