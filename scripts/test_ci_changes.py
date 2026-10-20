"""scripts/ci_changes.py: pull-request path groups → CI jobs (CI-SKIP)."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).with_name("ci_changes.py")
ALL = {"checks": True, "images": ["api", "worker", "web"], "integration": True, "visual_ui": True}
NOTHING = {"checks": False, "images": [], "integration": False, "visual_ui": False}


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ci_changes", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ci_changes = _load()


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/ci.yml",
        ".github/workflows/deploy.yml",
        "Makefile",
        "scripts/e2e-trace.ts",
        "scripts/visual-run.sh",
        "scripts/ci_changes.py",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "pyproject.toml",
        "uv.lock",
        "tsconfig.base.json",
        "eslint.config.mjs",
        ".prettierrc.json",
        ".prettierignore",
        ".dockerignore",
        ".nvmrc",
        ".python-version",
        ".env.example",
        ".npmrc",
        "brand-new-top-level/file.txt",
    ],
)
def test_ci_and_shared_root_files_run_everything(path: str) -> None:
    assert ci_changes.decide([path]) == ALL
    assert ci_changes.decide(["docs/architecture.md", path]) == ALL


@pytest.mark.parametrize(
    "paths",
    [
        ["docs/architecture.md"],
        ["README.md", "AGENTS.md", "CLAUDE.md", "docs/implementation-plan.md"],
        ["docs/deployment.md", "docs/runbook-deploy.md"],
    ],
)
def test_docs_only_runs_checks_alone(paths: list[str]) -> None:
    assert ci_changes.decide(paths) == {**NOTHING, "checks": True}


@pytest.mark.parametrize("path", ["docs/screens/qov-01.md", "docs/auth.md"])
def test_ac_sources_run_integration(path: str) -> None:
    # e2e-trace and the E2E spec selection read the screen specs and auth.md §7.
    assert ci_changes.decide([path]) == {**NOTHING, "checks": True, "integration": True}


@pytest.mark.parametrize(
    ("path", "images", "visual_ui"),
    [
        ("apps/api/src/quiz_api/app.py", ["api", "worker"], False),
        ("apps/api/Dockerfile", ["api", "worker"], False),
        ("apps/worker/pyproject.toml", ["api", "worker"], False),
        ("packages/core/src/book_core/x.py", ["api", "worker"], False),
        ("apps/web/src/app/page.tsx", ["web"], False),
        ("apps/web/Dockerfile", ["web"], False),
        ("packages/api-client/src/schema.ts", ["web"], False),
        ("packages/ui/src/button.tsx", ["web"], True),
        ("packages/design-tokens/tokens.json", ["web"], True),
        ("supabase/migrations/0001_x.sql", [], False),
        ("contracts/openapi.json", [], False),
        ("tests/e2e/screens/qov-01.spec.ts", [], False),
        ("tests/fixtures/pdfs/a.pdf", [], False),
        ("tests/smoke/dep.smoke.ts", [], False),
        ("playwright.config.ts", [], False),
        ("tests/integration/test_x.py", [], False),
        ("infra/compose.yaml", [], False),
        ("infra/deploy/test_deploy_workflow.py", [], False),
    ],
)
def test_code_paths(path: str, images: list[str], visual_ui: bool) -> None:
    assert ci_changes.decide([path]) == {
        "checks": True,
        "images": images,
        "integration": True,
        "visual_ui": visual_ui,
    }


def test_offline_eval_harness_runs_checks_alone() -> None:
    assert ci_changes.decide(["eval/run.py"]) == {**NOTHING, "checks": True}


def test_union_of_groups() -> None:
    decision = ci_changes.decide(["apps/web/src/a.ts", "apps/worker/src/b.py", "docs/x.md"])
    assert decision == {**ALL, "visual_ui": False}


def test_empty_diff_runs_nothing() -> None:
    assert ci_changes.decide(["", "  "]) == NOTHING


def test_cli_prints_github_output_lines() -> None:
    result = subprocess.run(  # noqa: S603 - the script under test
        [sys.executable, "-I", str(SCRIPT)],
        input="packages/ui/src/a.tsx\ndocs/a.md\n",
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.splitlines() == [
        "checks=true",
        'images=["web"]',
        "integration=true",
        "visual_ui=true",
    ]
