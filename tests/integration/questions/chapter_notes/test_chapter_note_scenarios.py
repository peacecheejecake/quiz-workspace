"""The chapter note scenario fixture (tests/fixtures/llm/chapter-note-scenarios.json) is usable by
the APP_ENV=test ScenarioLLMClient and says what CHNOTE-01 tests rely on (offline, no stack).

Assumptions N6-N8 in tests/e2e/fixtures/chapter-notes.ts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from book_core.llm import LLMOutputError, LLMRequest
from book_core.llm.scenarios import ScenarioLLMClient
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[4]
SCENARIOS = REPO_ROOT / "tests" / "fixtures" / "llm" / "chapter-note-scenarios.json"
GENERATION = REPO_ROOT / "tests" / "fixtures" / "llm" / "generation-scenarios.json"
TRUTH = REPO_ROOT / "tests" / "fixtures" / "pdfs" / "book-ko.truth.json"
TASK = "chapter_notes.generate"
TAG = re.compile(r"^Q\d+$")


class _Item(BaseModel):
    text: str
    tags: list[str]
    quote: str | None


class _Section(BaseModel):
    heading: str
    items: list[_Item]


class _Note(BaseModel):
    """Shape of N7; CHNOTE-B's book_core.notes output model must accept the same JSON."""

    sections: list[_Section]


def _scenarios() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    return {s["marker"]: s for s in data["scenarios"]}


def _request(marker: str) -> LLMRequest:
    prompt = f"Q1: 문제 하나 [{marker}]\nQ2: 문제 둘 [{marker}]"
    return LLMRequest(task=TASK, prompt_version=f"{TASK}/v1", prompt=prompt)


def _chapter_text(prefix: str) -> str:
    truth = json.loads(TRUTH.read_text(encoding="utf-8"))
    return " ".join(b["text"] for b in truth["blocks"] if str(b["id"]).startswith(prefix))


def test_scenarios_load_and_answer_by_marker() -> None:
    client = ScenarioLLMClient.from_file(SCENARIOS)
    assert set(client.markers) == {
        "E2E-NOTE-OK",
        "E2E-NOTE-MIXED",
        "E2E-NOTE-INVALID",
        "E2E-NOTE-FAIL",
    }
    for marker in ("E2E-NOTE-OK", "E2E-NOTE-MIXED", "E2E-NOTE-INVALID"):
        out = client.complete(_request(marker), _Note).output
        assert out.sections
        assert all(TAG.match(t) for s in out.sections for i in s.items for t in i.tags)
    try:
        client.complete(_request("E2E-NOTE-FAIL"), _Note)
    except LLMOutputError:
        pass
    else:
        raise AssertionError("E2E-NOTE-FAIL must be malformed output")


def test_markers_never_collide_with_hold_tokens_or_generation_markers() -> None:
    generation = json.loads(GENERATION.read_text(encoding="utf-8"))
    others = [s["marker"] for s in generation["scenarios"]]
    hold = "E2E-HOLD-NOTE-0123456789abcdef"
    for marker in _scenarios():
        assert marker not in hold
        assert not [o for o in others if marker in o or o in marker]


def test_mixed_scenario_has_the_items_the_citation_rules_need() -> None:
    items = [
        i for s in _scenarios()["E2E-NOTE-MIXED"]["responses"][TASK]["sections"] for i in s["items"]
    ]
    by_token = {str(i["text"]).split()[-1]: i for i in items}
    chapter1 = _chapter_text("ch1-")
    book = _chapter_text("")
    assert by_token["NOTE-MIX-Q99"]["tags"] == ["Q99"]
    assert by_token["NOTE-MIX-NOTAG"]["tags"] == []
    assert by_token["NOTE-MIX-BADQUOTE"]["quote"] not in book
    assert by_token["NOTE-MIX-A"]["quote"] in chapter1
    for token in ("NOTE-MIX-A", "NOTE-MIX-B", "NOTE-MIX-C", "NOTE-MIX-D"):
        assert set(by_token[token]["tags"]) <= {"Q1", "Q2", "Q3"}
        assert by_token[token]["tags"]
    assert "Q3" in by_token["NOTE-MIX-C"]["tags"]
    assert {t for i in items for t in i["tags"]} >= {"Q1", "Q2", "Q3"}
