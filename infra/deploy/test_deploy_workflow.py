"""Structural invariants of .github/workflows/deploy.yml and its CI caller (M7.4a, M7.4p;
actionlint checks the syntax)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
CI = ROOT / ".github/workflows/ci.yml"


def _load(path: Path) -> dict[Any, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _workflow() -> dict[Any, Any]:
    return _load(WORKFLOW)


def _steps() -> list[dict[str, Any]]:
    steps = _workflow()["jobs"]["deploy"]["steps"]
    assert isinstance(steps, list)
    return steps


def _index(predicate: str) -> int:
    for i, step in enumerate(_steps()):
        if predicate in str(step.get("run", "")) or predicate in str(step.get("name", "")):
            return i
    raise AssertionError(f"no step matching {predicate!r}")


def test_dispatch_and_ci_call_are_the_only_triggers() -> None:
    # PyYAML reads the bare `on` key as boolean True.
    triggers = _workflow()[True]
    assert set(triggers) == {"workflow_dispatch", "workflow_call"}
    environment = triggers["workflow_dispatch"]["inputs"]["environment"]
    assert environment["options"] == ["staging", "production"]


def test_workflow_call_mirrors_the_dispatch_inputs() -> None:
    triggers = _workflow()[True]
    dispatch = triggers["workflow_dispatch"]["inputs"]
    call = triggers["workflow_call"]["inputs"]
    assert set(call) == set(dispatch)
    assert call["environment"] == {**call["environment"], "type": "string", "required": True}
    for name in ("bootstrap", "skip_migrations"):
        assert call[name]["type"] == dispatch[name]["type"] == "boolean"
        assert call[name]["default"] is dispatch[name]["default"] is False


def test_single_job_bound_to_the_github_environment() -> None:
    jobs = _workflow()["jobs"]
    assert set(jobs) == {"deploy"}
    assert jobs["deploy"]["environment"]["name"] == "${{ inputs.environment }}"


def test_concurrency_is_per_environment_and_never_cancels_a_running_deploy() -> None:
    # Job level: a workflow-level group of a called workflow is not where the caller queues.
    assert "concurrency" not in _workflow()
    concurrency = _workflow()["jobs"]["deploy"]["concurrency"]
    assert concurrency == {"group": "deploy-${{ inputs.environment }}", "cancel-in-progress": False}


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


def _preflight_case(target: str, ref: str) -> bool:
    """Evaluates the preflight `case "$TARGET/$REF"` allow-list for one target/ref pair."""
    preflight = str(_steps()[_index("Preflight")]["run"])
    match = re.search(r'case "\$TARGET/\$REF" in\n\s+(.+?)\) ;;', preflight)
    assert match, "preflight has no TARGET/REF allow-list"
    allowed = {pattern.strip() for pattern in match.group(1).split("|")}
    return f"{target}/{ref}" in allowed


@pytest.mark.parametrize(
    ("target", "ref", "allowed"),
    [
        ("staging", "refs/heads/develop", True),
        ("production", "refs/heads/main", True),
        ("staging", "refs/heads/main", False),
        ("production", "refs/heads/develop", False),
        ("staging", "refs/heads/feature", False),
        ("production", "refs/tags/v1.0.0", False),
        ("staging", "refs/pull/1/merge", False),
    ],
)
def test_ref_matrix(target: str, ref: str, allowed: bool) -> None:
    assert _preflight_case(target, ref) is allowed


def test_push_events_are_admitted_only_from_ci_to_staging() -> None:
    step = _steps()[_index("Preflight")]
    assert step["env"]["EVENT"] == "${{ github.event_name }}"
    assert step["env"]["CALLER"] == "${{ github.workflow_ref }}"
    run = str(step["run"])
    assert '$CALLER != "$REPO/.github/workflows/ci.yml@"*' in run
    assert "$TARGET != staging" in run
    # Any other event (pull_request, schedule, workflow_run, …) is refused.
    assert re.search(r"\*\)\n\s+echo \"::error::deploys run from workflow_dispatch", run)


def test_ci_lookup_runs_only_on_dispatch() -> None:
    # Called from CI the caller run is still in progress: the lookup would never find it green.
    step = _steps()[_index("CI passed")]
    assert step["if"] == "${{ github.event_name == 'workflow_dispatch' }}"
    assert "--status success" in str(step["run"])


def _ci_deploy_job() -> dict[str, Any]:
    job = _load(CI)["jobs"]["deploy-staging"]
    assert isinstance(job, dict)
    return job


def test_ci_deploys_staging_only_on_develop_pushes() -> None:
    job = _ci_deploy_job()
    assert job["if"] == "github.event_name == 'push' && github.ref == 'refs/heads/develop'"
    assert job["uses"] == "./.github/workflows/deploy.yml"
    assert job["with"] == {"environment": "staging"}
    assert job["secrets"] == "inherit"


def test_ci_deploy_needs_every_required_ci_job() -> None:
    jobs = _load(CI)["jobs"]
    required = {name for name, job in jobs.items() if "if" not in job}
    assert required == {"checks", "images", "integration", "visual-ui"}
    assert set(_ci_deploy_job()["needs"]) == required


def test_ci_grants_the_callee_permissions() -> None:
    callee = _workflow()["jobs"]["deploy"]["permissions"]
    assert _ci_deploy_job()["permissions"] == callee
    assert callee == {"contents": "read", "packages": "write", "actions": "read"}


def test_ci_never_cancels_a_develop_run_that_may_be_deploying() -> None:
    concurrency = _load(CI)["concurrency"]
    assert concurrency["cancel-in-progress"] == (
        "${{ !(github.event_name == 'push' && github.ref == 'refs/heads/develop') }}"
    )
    assert _load(CI)[True]["push"]["branches"] == ["develop", "main"]


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


def test_production_needs_the_operator_switch() -> None:
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
