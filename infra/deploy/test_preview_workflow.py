"""Structural and behavioural invariants of .github/workflows/preview.yml (PR-PREVIEW; actionlint
checks the syntax). Steps run against fake `npx` / `gh` binaries; nothing remote is called."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/preview.yml"
DEPLOY = ROOT / ".github/workflows/deploy.yml"
BASH = shutil.which("bash")
SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository"
NOT_DEPENDABOT = "github.event.pull_request.user.login != 'dependabot[bot]'"
ENABLED = "vars.PR_PREVIEW_ENABLED == 'true'"


def _workflow() -> dict[Any, Any]:
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _jobs() -> dict[str, dict[str, Any]]:
    jobs = _workflow()["jobs"]
    assert isinstance(jobs, dict)
    return jobs


def _step(job: str, name: str) -> dict[str, Any]:
    for step in _jobs()[job]["steps"]:
        if step.get("name") == name or step.get("id") == name:
            assert isinstance(step, dict)
            return step
    raise AssertionError(f"{job}: no step {name!r}")


def test_only_same_repo_pull_requests_into_develop_trigger_it() -> None:
    # PyYAML reads the bare `on` key as boolean True.
    triggers = _workflow()[True]
    assert set(triggers) == {"pull_request"}  # never pull_request_target / workflow_run
    assert triggers["pull_request"]["branches"] == ["develop"]
    assert set(triggers["pull_request"]["types"]) == {"opened", "synchronize", "reopened", "closed"}
    for name in ("changes", "cleanup"):
        condition = " ".join(str(_jobs()[name]["if"]).split())
        assert ENABLED in condition, name
        assert SAME_REPO in condition, name
        assert NOT_DEPENDABOT in condition, name
    assert "github.event.action != 'closed'" in str(_jobs()["changes"]["if"])
    assert "github.event.action == 'closed'" in str(_jobs()["cleanup"]["if"])
    # deploy is reachable only through `changes` (and so through its guards).
    assert _jobs()["deploy"]["needs"] == "changes"


def test_permissions_are_minimal_and_secrets_stay_out_of_the_comment_job() -> None:
    assert _workflow()["permissions"] == {}
    jobs = _jobs()
    for name in ("changes", "deploy", "cleanup"):
        assert jobs[name]["permissions"] == {"contents": "read"}, name
    assert jobs["comment"]["permissions"] == {"pull-requests": "write"}
    comment = str(jobs["comment"])
    assert "secrets." not in comment
    assert "actions/checkout" not in comment
    assert "secrets." not in str(jobs["changes"])
    # Only the pr-preview environment, never staging/production.
    for name in ("deploy", "cleanup"):
        assert jobs[name]["environment"]["name"] == "pr-preview", name
    text = WORKFLOW.read_text(encoding="utf-8")
    assert not re.search(r"name:\s*(staging|production)\b", text)
    scripts = " ".join(
        str(step.get("run", "")) for job in jobs.values() for step in job.get("steps", [])
    )
    assert "--prod" not in scripts
    assert "alias" not in scripts


def test_concurrency_is_per_pr_and_cancels_older_runs() -> None:
    assert _workflow()["concurrency"] == {
        "group": "preview-${{ github.event.pull_request.number }}",
        "cancel-in-progress": True,
    }


def test_deploy_yml_still_refuses_pull_requests() -> None:
    deploy = yaml.safe_load(DEPLOY.read_text(encoding="utf-8"))
    assert set(deploy[True]) == {"workflow_dispatch", "workflow_call"}
    assert "workflow_call" not in _workflow()[True]


def test_actions_are_pinned_by_sha_and_checkouts_drop_credentials() -> None:
    for job in _jobs().values():
        for step in job.get("steps", []):
            uses = step.get("uses")
            if not uses:
                continue
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", uses), uses
            if uses.startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] is False


def test_no_secret_is_echoed() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert not re.search(r"echo[^\n]*\$\{?VERCEL_TOKEN\b", text)
    assert not re.search(r"echo[^\n]*\$\{?GH_TOKEN\b", text)


def _fake_bin(tmp_path: Path, name: str, body: str) -> None:
    path = tmp_path / "bin" / name
    path.parent.mkdir(exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)


def _run(
    tmp_path: Path, job: str, step: str, env: dict[str, str]
) -> tuple[subprocess.CompletedProcess[str], dict[str, str]]:
    assert BASH, "bash is required"
    spec = _step(job, step)
    script = tmp_path / "step.sh"
    script.write_text(str(spec["run"]), encoding="utf-8")
    output = tmp_path / "github_output"
    output.write_text("", encoding="utf-8")
    result = subprocess.run(  # noqa: S603 - a test-local script and fakes only
        [BASH, "-e", str(script)],
        env={
            "PATH": f"{tmp_path / 'bin'}:{os.environ['PATH']}",
            "LC_ALL": "C.UTF-8",
            "RUNNER_TEMP": str(tmp_path),
            "GITHUB_OUTPUT": str(output),
            **{k: str(v) for k, v in spec.get("env", {}).items()},
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    outputs = dict(
        line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines() if line
    )
    return result, outputs


@pytest.mark.parametrize(
    ("changed", "web"),
    [
        ("apps/web/src/app/page.tsx", "true"),
        ("packages/ui/src/button.tsx", "true"),
        (".github/workflows/preview.yml", "true"),  # conservative: run everything
        ("apps/api/src/quiz_api/app.py", "false"),
        ("docs/deployment.md", "false"),
    ],
)
def test_path_filter_deploys_only_web_relevant_changes(
    tmp_path: Path, changed: str, web: str
) -> None:
    assert shutil.which("jq"), "jq is required (preinstalled on the ubuntu runner)"
    _fake_bin(tmp_path, "git", f'echo "{changed}"')
    # The step runs `python3 -I scripts/ci_changes.py` relative to the checkout.
    result, outputs = _run_in_root(tmp_path, "changes", "filter")
    assert result.returncode == 0, result.stdout + result.stderr
    assert outputs == {"web": web}


def _run_in_root(
    tmp_path: Path, job: str, step: str
) -> tuple[subprocess.CompletedProcess[str], dict[str, str]]:
    cwd = Path.cwd()
    os.chdir(ROOT)
    try:
        return _run(tmp_path, job, step, {})
    finally:
        os.chdir(cwd)


DEPLOY_ENV = {
    "VERCEL_CLI_VERSION": "1.2.3",
    "VERCEL_TOKEN": "tok-secret",
    "PR": "42",
    "HEAD_SHA": "0123456789abcdef",
}


def test_deploy_is_a_tagged_preview_never_prod_never_aliased(tmp_path: Path) -> None:
    calls = tmp_path / "calls.log"
    _fake_bin(
        tmp_path,
        "npx",
        f'echo "npx $*" >> "{calls}"\n'
        'case " $* " in *" deploy "*) echo https://quiz-preview-abc-team.vercel.app ;; esac',
    )
    result, outputs = _run(tmp_path, "deploy", "web", DEPLOY_ENV)
    assert result.returncode == 0, result.stdout + result.stderr
    assert outputs == {"url": "https://quiz-preview-abc-team.vercel.app"}
    log = calls.read_text(encoding="utf-8").splitlines()
    assert [line.split()[3] for line in log] == ["pull", "build", "deploy"]
    assert all(line.split()[2] == "vercel@1.2.3" for line in log)
    assert "--environment=preview" in log[0]
    assert "--meta previewPr=42" in log[2]
    assert "--meta previewSha=0123456789abcdef" in log[2]
    assert not [line for line in log if "--prod" in line]
    assert "tok-secret" not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "printed", ["", "Error: something", "http://x.vercel.app", "https://x.vercel.app/[a](b)"]
)
def test_deploy_fails_without_a_clean_deployment_url(tmp_path: Path, printed: str) -> None:
    _fake_bin(tmp_path, "npx", f'case " $* " in *" deploy "*) echo "{printed}" ;; esac')
    result, outputs = _run(tmp_path, "deploy", "web", DEPLOY_ENV)
    assert result.returncode == 1
    assert "no deployment URL" in result.stdout + result.stderr
    assert "url" not in outputs


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"VERCEL_TOKEN": ""}, "lacks: VERCEL_TOKEN"),
        ({"VERCEL_PROJECT_ID": ""}, "lacks: VERCEL_PROJECT_ID"),
        ({"VERCEL_CLI_VERSION": "latest"}, "exact x.y.z"),
        ({"PR": ""}, "no pull request number"),
    ],
)
def test_preflight_names_what_is_missing(tmp_path: Path, env: dict[str, str], message: str) -> None:
    base = {
        **DEPLOY_ENV,
        "VERCEL_ORG_ID": "team_1",
        "VERCEL_PROJECT_ID": "prj_1",
    }
    result, _ = _run(tmp_path, "deploy", "Preflight (preview environment values)", {**base, **env})
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert message in out
    assert "tok-secret" not in out


def test_prune_runs_after_deploy_and_cleanup_deletes_everything() -> None:
    names = [step.get("name", step.get("uses", "")) for step in _jobs()["deploy"]["steps"]]
    assert names.index("Deploy web preview (Vercel)") < names.index(
        "Delete older previews of this PR"
    )
    prune = _step("deploy", "Delete older previews of this PR")
    assert prune["continue-on-error"] is True
    assert '--keep "$URL"' in prune["run"]
    cleanup = _step("cleanup", "Delete every preview of this PR")
    assert cleanup["run"].strip() == 'python3 -I scripts/deploy/vercel_preview.py prune --pr "$PR"'
    checkout = _jobs()["cleanup"]["steps"][0]
    assert checkout["with"]["ref"] == "${{ github.event.pull_request.base.ref }}"


# --- sticky comment ---------------------------------------------------------------------------


def _fake_gh(tmp_path: Path, existing: str) -> Path:
    calls = tmp_path / "gh.log"
    _fake_bin(
        tmp_path,
        "gh",
        f'printf "%s\\n" "gh $*" >> "{calls}"\n'
        f'case "$*" in *"--paginate"*) [ -n "{existing}" ] && echo "{existing}" ;; esac\n'
        "exit 0",
    )
    return calls


COMMENT_ENV = {
    "REPO": "o/r",
    "PR": "42",
    "HEAD_SHA": "0123456789abcdef",
    "RUN_URL": "https://github.com/o/r/actions/runs/1",
    "GH_TOKEN": "gh-secret",
}


def _comment(tmp_path: Path, existing: str, **env: str) -> tuple[int, str, str]:
    calls = _fake_gh(tmp_path, existing)
    result, _ = _run(
        tmp_path,
        "comment",
        "Upsert the preview comment",
        {**COMMENT_ENV, "URL": "", "DEPLOY": "skipped", "CLEANUP": "skipped", **env},
    )
    log = calls.read_text(encoding="utf-8") if calls.exists() else ""
    return result.returncode, result.stdout + result.stderr, log


def test_comment_is_created_once_with_the_url(tmp_path: Path) -> None:
    status, out, log = _comment(
        tmp_path, "", DEPLOY="success", URL="https://quiz-preview-abc.vercel.app"
    )
    assert status == 0, out
    assert "repos/o/r/issues/42/comments" in log
    assert "--method POST" in log
    assert (
        "body=<!-- quiz-pr-preview -->\n**PR preview** (0123456): https://quiz-preview-abc.vercel.app"
        in log
    )
    assert "staging" in log
    assert "gh-secret" not in out + log


def test_comment_is_edited_in_place(tmp_path: Path) -> None:
    status, out, log = _comment(
        tmp_path, "777", DEPLOY="success", URL="https://quiz-preview-abc.vercel.app"
    )
    assert status == 0, out
    assert "--method PATCH repos/o/r/issues/comments/777" in log
    assert "--method POST" not in log


def test_failed_or_odd_url_reports_failure_not_the_url(tmp_path: Path) -> None:
    status, out, log = _comment(tmp_path, "", DEPLOY="success", URL="https://x.app/[a](b)")
    assert status == 0, out
    assert "deploy failed — https://github.com/o/r/actions/runs/1" in log
    assert "[a](b)" not in log
    status, out, log = _comment(tmp_path, "", DEPLOY="failure")
    assert "deploy failed" in log


def test_close_updates_only_an_existing_comment(tmp_path: Path) -> None:
    status, out, log = _comment(tmp_path, "777", CLEANUP="success")
    assert status == 0, out
    assert "--method PATCH repos/o/r/issues/comments/777" in log
    assert "removed" in log
    (tmp_path / "gh.log").unlink()
    status, out, log = _comment(tmp_path, "", CLEANUP="success")
    assert status == 0, out
    assert "--method" not in log
    assert "no preview comment to update" in out


def test_comment_runs_after_deploy_or_cleanup_only() -> None:
    job = _jobs()["comment"]
    assert job["needs"] == ["deploy", "cleanup"]
    condition = " ".join(str(job["if"]).split())
    assert condition.startswith("always()")
    for clause in (
        "needs.deploy.result == 'success'",
        "needs.deploy.result == 'failure'",
        "needs.cleanup.result == 'success'",
    ):
        assert clause in condition
    marker_filter = str(_step("comment", "Upsert the preview comment")["run"])
    assert "github-actions[bot]" in marker_filter
