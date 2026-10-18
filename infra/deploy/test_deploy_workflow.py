"""Structural invariants of .github/workflows/deploy.yml (M7.4a; actionlint checks the syntax)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"


def _workflow() -> dict[Any, Any]:
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _steps() -> list[dict[str, Any]]:
    steps = _workflow()["jobs"]["deploy"]["steps"]
    assert isinstance(steps, list)
    return steps


def _index(predicate: str) -> int:
    for i, step in enumerate(_steps()):
        if predicate in str(step.get("run", "")) or predicate in str(step.get("name", "")):
            return i
    raise AssertionError(f"no step matching {predicate!r}")


def test_manual_trigger_only() -> None:
    # PyYAML reads the bare `on` key as boolean True.
    triggers = _workflow()[True]
    assert set(triggers) == {"workflow_dispatch"}
    environment = triggers["workflow_dispatch"]["inputs"]["environment"]
    assert environment["options"] == ["staging", "production"]


def test_single_job_bound_to_the_github_environment() -> None:
    jobs = _workflow()["jobs"]
    assert set(jobs) == {"deploy"}
    assert jobs["deploy"]["environment"]["name"] == "${{ inputs.environment }}"
    assert _workflow()["concurrency"]["cancel-in-progress"] is False


def test_order_preflight_images_migrations_rollout_web_smoke() -> None:
    order = [
        _index("Preflight"),
        _index("CI passed"),
        _index("Build + push api"),
        _index("Build + push worker"),
        _index("supabase db push"),
        _index("--service api"),
        _index("--service worker"),
        _index("Deploy web (Vercel)"),
        _index("smoke-staging"),
    ]
    assert order == sorted(order)


def test_preflight_names_every_deploy_and_smoke_secret() -> None:
    preflight = str(_steps()[_index("Preflight")]["run"])
    for name in (
        "SUPABASE_DB_URL",
        "VERCEL_TOKEN",
        "RAILWAY_TOKEN",
        "RAILWAY_ENVIRONMENT_ID",
        "WEB_ORIGIN",
        "SMOKE_USER_A_PASSWORD",
        "SMOKE_USER_B_PASSWORD",
    ):
        assert name in preflight
    assert "refs/heads/main" in preflight


def test_images_are_rolled_out_by_digest() -> None:
    for service in ("api", "worker"):
        step = _steps()[_index(f"--service {service}")]
        assert step["env"]["IMAGE"] == f"${{{{ steps.images.outputs.{service} }}}}"
    pinned = str(_steps()[_index("Pinned image references")]["run"])
    assert "sha256:[0-9a-f]{64}" in pinned


def test_third_party_actions_are_pinned_by_sha() -> None:
    for step in _steps():
        uses = step.get("uses")
        if uses:
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", uses), uses


def test_no_secret_is_echoed() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    for name in ("SUPABASE_DB_URL", "VERCEL_TOKEN", "RAILWAY_TOKEN", "SMOKE_USER_A_PASSWORD"):
        assert not re.search(rf"echo[^\n]*\${name}\b", text), name


def test_production_is_gated_until_the_cost_gate() -> None:
    step = _steps()[_index("Preflight")]
    assert step["env"]["PRODUCTION_DEPLOY_ENABLED"] == "${{ vars.PRODUCTION_DEPLOY_ENABLED }}"
    assert "PRODUCTION_DEPLOY_ENABLED:-} != true" in str(step["run"])


def test_bootstrap_skips_only_account_smoke_and_only_on_staging() -> None:
    inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    assert inputs["bootstrap"]["default"] is False
    preflight = str(_steps()[_index("Preflight")]["run"])
    assert "bootstrap is for the first staging deploy only" in preflight
    # Accounts are required on staging unless bootstrapping.
    assert re.search(
        r"elif \[\[ \$TARGET == staging \]\]; then\n\s+required\+=\(SMOKE_USER_A_EMAIL", preflight
    )
    smoke = _steps()[_index("smoke-staging")]
    run = str(smoke["run"])
    assert (
        run.index("BOOTSTRAP == true")
        < run.index("pnpm smoke --grep @readonly")
        < run.index("make smoke-staging")
    )
    assert "::warning::" in run
