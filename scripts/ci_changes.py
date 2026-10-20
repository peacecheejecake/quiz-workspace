"""Pull-request path filter for .github/workflows/ci.yml (CI-SKIP, docs/deployment.md §5).

    git diff --name-only --no-renames BASE HEAD | python3 -I scripts/ci_changes.py

Reads changed paths (one per line) on stdin and prints the `$GITHUB_OUTPUT` lines that decide
which CI jobs a pull request runs:

    checks=true|false              lint · typecheck · unit · contracts (any change)
    images=["api","worker","web"]  image matrix entries to build (JSON array, may be empty)
    integration=true|false         db · infra · e2e · restore
    visual_ui=true|false           @quiz/ui Storybook baselines

Conservative by construction: CI/workflow files, the Makefile, scripts/, lockfiles, root configs
and any path that matches no group run everything. Only pull requests are filtered; push,
schedule and workflow_dispatch runs never call this. Stdlib only (the runner's python3).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from fnmatch import fnmatchcase

IMAGES = ("api", "worker", "web")

# First match wins. A path that matches no pattern is treated as "full".
GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # AC sources: e2e-trace (checks) and the E2E spec selection (integration) parse them.
    ("e2e", ("docs/screens/*", "docs/auth.md")),
    ("docs", ("docs/*", "README.md", "AGENTS.md", "CLAUDE.md")),
    ("api", ("apps/api/*",)),
    ("worker", ("apps/worker/*",)),
    ("core", ("packages/core/*",)),
    ("web", ("apps/web/*", "packages/api-client/*")),
    ("ui", ("packages/ui/*", "packages/design-tokens/*")),
    ("db", ("supabase/*",)),
    ("contracts", ("contracts/*",)),
    (
        "e2e",
        ("tests/e2e/*", "tests/smoke/*", "tests/fixtures/*", "playwright.config.ts"),
    ),
    ("integration", ("tests/integration/*",)),
    ("infra", ("infra/*",)),
    ("offline_eval", ("eval/*",)),
)

# Groups each image is built from (its Dockerfile COPYs, .dockerignore allowlist). The Python
# images copy both apps' pyproject.toml for the workspace lock, so either app's change rebuilds
# both; packages/core is in both.
IMAGE_GROUPS: dict[str, frozenset[str]] = {
    "api": frozenset({"api", "worker", "core"}),
    "worker": frozenset({"api", "worker", "core"}),
    "web": frozenset({"web", "ui"}),
}
INTEGRATION_GROUPS = frozenset(
    {"api", "worker", "core", "web", "ui", "db", "contracts", "e2e", "integration", "infra"}
)
VISUAL_UI_GROUPS = frozenset({"ui"})


def classify(path: str) -> str:
    for group, patterns in GROUPS:
        if any(fnmatchcase(path, pattern) for pattern in patterns):
            return group
    return "full"


def decide(paths: Iterable[str]) -> dict[str, object]:
    groups = {classify(p) for p in (line.strip() for line in paths) if p}
    full = "full" in groups
    images = [i for i in IMAGES if full or groups & IMAGE_GROUPS[i]]
    return {
        "checks": bool(groups),
        "images": images,
        "integration": full or bool(groups & INTEGRATION_GROUPS),
        "visual_ui": full or bool(groups & VISUAL_UI_GROUPS),
    }


def render(decision: dict[str, object]) -> str:
    # json.dumps renders booleans as true/false, the strings the workflow compares against.
    return "".join(
        f"{key}={json.dumps(value, separators=(',', ':'))}\n" for key, value in decision.items()
    )


def main() -> int:
    sys.stdout.write(render(decide(sys.stdin)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
