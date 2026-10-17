from __future__ import annotations

import json
from pathlib import Path

import pytest
from quiz_api.openapi_export import main, render_openapi

REPO_ROOT = Path(__file__).resolve().parents[3]
COMMITTED = REPO_ROOT / "contracts" / "openapi.json"


def test_render_is_deterministic() -> None:
    assert render_openapi() == render_openapi()


def test_schema_exposes_health_and_problem_contract() -> None:
    schema = json.loads(render_openapi())

    assert {"/health/live", "/health/ready"} <= set(schema["paths"])
    assert "Problem" in schema["components"]["schemas"]
    ready_responses = schema["paths"]["/health/ready"]["get"]["responses"]
    assert {"200", "503"} <= set(ready_responses)


def test_committed_contract_is_current() -> None:
    assert COMMITTED.read_text(encoding="utf-8") == render_openapi(), (
        "contracts/openapi.json is stale; run `make contracts`"
    )


def test_check_mode_detects_stale_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    target = tmp_path / "openapi.json"

    assert main(["--output", str(target), "--check"]) == 1
    assert main(["--output", str(target)]) == 0
    assert main(["--output", str(target), "--check"]) == 0

    target.write_text(target.read_text(encoding="utf-8").replace("Quiz", "Stale"), "utf-8")
    assert main(["--output", str(target), "--check"]) == 1
    assert "stale" in capsys.readouterr().err
