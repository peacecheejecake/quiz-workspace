"""Marker-selected scripted LLM outputs for E2E and contract tests (M6.0, QGEN-01).

A scenario file (``tests/fixtures/llm/generation-scenarios.json``) lists scenarios, each with a
``marker`` and one scripted response per LLM ``task``. :class:`ScenarioLLMClient` answers a
request with the response of the single scenario whose marker occurs in the request's prompt or
system text. Tests put the marker into the data the prompt is built from (for generation, the
source question's stem), so the API/worker code path stays the production one and only the
client differs. The worker installs it only in ``APP_ENV=test``.

A request that matches no scenario, more than one, or a task the scenario does not script raises
:class:`~book_core.llm.FakeLLMNotScriptedError`, so a test can never pass on an accidental
default. Responses behave like :class:`~book_core.llm.FakeLLMClient`'s: a JSON object is
validated against the requested schema, a string is returned verbatim as raw output (malformed
output → :class:`~book_core.llm.LLMOutputError`).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from book_core.llm.base import LLMRequest, LLMResult
from book_core.llm.fake import FakeLLMClient, FakeLLMNotScriptedError

SCENARIO_MODEL_NAME = "fake-scenario-llm"


class LLMScenario(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    marker: str = Field(min_length=1, pattern=r"^\S+$")
    description: str = ""
    responses: dict[str, dict[str, Any] | str]


class LLMScenarioFile(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    schema_version: int = Field(ge=1, le=1)
    scenarios: tuple[LLMScenario, ...]


class ScenarioLLMClient:
    """`LLMClient` that answers from the scenario whose marker is in the request."""

    def __init__(
        self, scenarios: Sequence[LLMScenario], model_name: str = SCENARIO_MODEL_NAME
    ) -> None:
        markers = [s.marker for s in scenarios]
        if len(set(markers)) != len(markers):
            raise ValueError("scenario markers must be unique")
        for a in markers:
            for b in markers:
                if a != b and a in b:
                    raise ValueError(f"scenario marker {a!r} is part of {b!r}")
        self._model_name = model_name
        self._clients: dict[str, FakeLLMClient] = {}
        for scenario in scenarios:
            client = FakeLLMClient(model_name)
            for task, response in scenario.responses.items():
                client.script(task, response)
            self._clients[scenario.marker] = client
        self.calls: list[tuple[str, LLMRequest]] = []

    @classmethod
    def from_file(cls, path: Path, model_name: str = SCENARIO_MODEL_NAME) -> ScenarioLLMClient:
        data = LLMScenarioFile.model_validate_json(path.read_bytes())
        return cls(data.scenarios, model_name)

    @classmethod
    def from_mapping(
        cls, data: Mapping[str, object], model_name: str = SCENARIO_MODEL_NAME
    ) -> ScenarioLLMClient:
        return cls(LLMScenarioFile.model_validate(data).scenarios, model_name)

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def markers(self) -> tuple[str, ...]:
        return tuple(self._clients)

    def _select(self, request: LLMRequest) -> tuple[str, FakeLLMClient]:
        text = f"{request.system or ''}\n{request.prompt}"
        found = [(m, c) for m, c in self._clients.items() if m in text]
        if len(found) != 1:
            # Marker names only: the prompt may quote book text and is never echoed.
            names = ", ".join(sorted(m for m, _ in found)) or "none"
            raise FakeLLMNotScriptedError(
                f"expected exactly one scenario marker in the {request.task!r} request, "
                f"found: {names}"
            )
        return found[0]

    def complete[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> LLMResult[T]:
        marker, client = self._select(request)
        self.calls.append((marker, request))
        return client.complete(request, schema)

    def generate[T: BaseModel](self, request: LLMRequest, schema: type[T]) -> T:
        return self.complete(request, schema).output
