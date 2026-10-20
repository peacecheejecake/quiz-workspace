"""Prepare a deploy of one git ref without deploying or changing anything remote (DEP-PREP).

    uv run python scripts/deploy_prepare.py --ref origin/develop --env staging --skip-images
    make deploy-prepare REF=main ENV=production ARGS="--db-url-env PROD_DB_URL"

Steps (each reported in the final summary; docs/runbook-deploy.md "배포 준비"):
  1. ref         `git fetch`, resolve the ref to a full SHA, show the commit
  2. ref rule    the TARGET/REF allow-list of .github/workflows/deploy.yml preflight (read from the
                 workflow at that SHA, not copied) — `--allow-any-ref` downgrades it to a warning
  3. ci          the latest CI push run of the SHA: every REQUIRED_CI_JOBS job (parsed from
                 deploy.yml) succeeded — read-only `gh`
  4. worktree    a clean temporary `git worktree` at the SHA (removed at the end unless `--keep`)
  5. env         scripts/check_env.py (at that SHA) over the env files in `--env-dir` (default
                 ~/.secrets/quiz-workspace/<env>/); names only, never values
  6. migrations  migrations at the SHA the target has not applied: from the database
                 (`--db-url-env/--db-url-file`, read-only transaction) or against a baseline ref
                 (`--since`, default: the last successful GitHub deployment of the environment);
                 destructive-looking statements are flagged
  7. images      disk-space guard, then `make image-{api,worker,web}` in the worktree tagged
                 quiz-<svc>:<short sha> (web: the public NEXT_PUBLIC_* values of the env)
  8. summary     table + the `gh workflow run deploy.yml …` command that would deploy it (printed,
                 never run)

Read-only by construction: every subprocess goes through `assert_read_only`, which admits only
the git/gh/docker/make/psql invocations listed there (no push, no `gh api` mutation, no workflow
dispatch). Secret values from env files or the DB URL never reach stdout/stderr: every relayed
line passes the `Redactor`.

Exit status: 0 = every required check passed (warnings allowed), 1 = a required check failed,
2 = usage error.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import yaml  # type: ignore[import-untyped]

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_WORKFLOW = ".github/workflows/deploy.yml"
MIGRATIONS_DIR = "supabase/migrations"
ENVIRONMENTS = ("staging", "production")
IMAGE_SERVICES = ("api", "worker", "web")
# Env files looked up in --env-dir, per check_env service. `<svc>.check.env` (a copy with platform
# reference variables resolved for checking) wins over `<svc>.env`.
ENV_FILE_SERVICES = ("web", "api", "worker", "supabase-config", "smoke")
REQUIRED_ENV_SERVICES = ("web", "api", "worker")
DEFAULT_ENV_DIR = Path.home() / ".secrets" / "quiz-workspace"
MIN_FREE_GB = 8.0
GIB = 1024**3

OK, FAIL, WARN, SKIP = "ok", "fail", "warn", "skip"
MARK = {OK: "✓", FAIL: "✗", WARN: "!", SKIP: "-"}


# --- read-only subprocess seam --------------------------------------------------------------------


class ReadOnlyViolationError(RuntimeError):
    """A command outside the read-only allow-list: a bug in this script, never user input."""


_GIT_READ = frozenset(
    {"fetch", "rev-parse", "show", "log", "diff", "cat-file", "ls-tree", "remote", "worktree"}
)
_GH_READ = frozenset({("run", "list"), ("run", "view"), ("repo", "view"), ("variable", "get")})
_GH_API_WRITE_FLAGS = ("-X", "--method", "-f", "-F", "--field", "--raw-field", "--input")
_MAKE_TARGETS = frozenset(f"image-{svc}" for svc in IMAGE_SERVICES)


def assert_read_only(argv: Sequence[str]) -> None:
    """Admits only the commands this script needs; everything that could change a remote is out."""
    if not argv:
        raise ReadOnlyViolationError("empty command")
    tool, rest = Path(argv[0]).name, list(argv[1:])
    if tool == "git":
        sub = rest[0] if rest else ""
        if sub not in _GIT_READ or "push" in rest:
            raise ReadOnlyViolationError(f"git {sub} is not read-only")
        if sub == "worktree" and (len(rest) < 2 or rest[1] not in ("add", "remove")):
            raise ReadOnlyViolationError("git worktree: only add/remove")
        if sub == "remote" and rest[1:2] != ["get-url"]:
            raise ReadOnlyViolationError("git remote: only get-url")
        return
    if tool == "gh":
        if rest[:1] == ["api"]:
            if any(arg.split("=", 1)[0] in _GH_API_WRITE_FLAGS for arg in rest):
                raise ReadOnlyViolationError("gh api: only plain GET requests")
            return
        if tuple(rest[:2]) not in _GH_READ:
            raise ReadOnlyViolationError(f"gh {' '.join(rest[:2])} is not read-only")
        return
    if tool == "docker":
        if rest[:1] == ["info"] or rest[:2] == ["image", "inspect"]:
            return
        raise ReadOnlyViolationError(f"docker {' '.join(rest[:1])} is not allowed")
    if tool == "make":
        targets = [arg for arg in rest if not arg.startswith("-") and "=" not in arg]
        if rest[:1] != ["-C"] or not set(targets[1:]) <= _MAKE_TARGETS or len(targets) < 2:
            raise ReadOnlyViolationError("make: only `make -C <worktree> image-<svc>`")
        return
    if tool == "psql":
        return  # read-only transaction enforced by PGOPTIONS (see pg_env)
    if argv[0] == sys.executable and len(rest) >= 1 and Path(rest[0]).name == "check_env.py":
        return
    raise ReadOnlyViolationError(f"{tool} is not on the allow-list")


@dataclass(frozen=True)
class Result:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class Runner:
    """Subprocess seam (tests substitute a fake)."""

    def run(
        self, argv: Sequence[str], *, cwd: Path | None = None, env: Mapping[str, str] | None = None
    ) -> Result:
        assert_read_only(argv)
        proc = subprocess.run(  # noqa: S603 - allow-listed argv, no shell
            list(argv),
            cwd=cwd or ROOT,
            env=None if env is None else {**os.environ, **env},
            capture_output=True,
            text=True,
            check=False,
        )
        return Result(proc.returncode, proc.stdout, proc.stderr)

    def stream(self, argv: Sequence[str], *, cwd: Path, write: Callable[[str], None]) -> int:
        """Runs a long command, relaying its combined output line by line through `write`."""
        assert_read_only(argv)
        with subprocess.Popen(  # noqa: S603 - allow-listed argv, no shell
            list(argv), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        ) as proc:
            assert proc.stdout is not None  # noqa: S101 - set by stdout=PIPE
            for line in proc.stdout:
                write(line)
            return proc.wait()


# --- redaction ------------------------------------------------------------------------------------


class Redactor:
    """Replaces every known secret value with `[redacted]` in text we relay."""

    MIN_LEN = 6

    def __init__(self) -> None:
        self._values: set[str] = set()

    def add(self, value: str) -> None:
        value = value.strip()
        if len(value) >= self.MIN_LEN:
            self._values.add(value)
            unquoted = unquote(value)
            if unquoted != value and len(unquoted) >= self.MIN_LEN:
                self._values.add(unquoted)

    def add_url(self, url: str) -> None:
        self.add(url)
        self.add_password(url)

    def add_password(self, url: str) -> None:
        try:
            password = urlsplit(url).password
        except ValueError:
            return
        if password:
            self.add(password)

    def __call__(self, text: str) -> str:
        for value in sorted(self._values, key=len, reverse=True):
            text = text.replace(value, "[redacted]")
        return text


# --- report ---------------------------------------------------------------------------------------


@dataclass
class Step:
    name: str
    status: str
    detail: str
    lines: list[str] = field(default_factory=list)


@dataclass
class Report:
    steps: list[Step] = field(default_factory=list)

    def add(self, step: Step) -> Step:
        self.steps.append(step)
        return step

    @property
    def failed(self) -> bool:
        return any(step.status == FAIL for step in self.steps)


def render_summary(report: Report) -> str:
    width = max((len(step.name) for step in report.steps), default=4)
    rows = [
        f"  {MARK[s.status]} {s.name:<{width}}  {s.status:<4}  {s.detail}" for s in report.steps
    ]
    verdict = "NOT READY (a required check failed)" if report.failed else "ready"
    return "\n".join(["Summary", *rows, f"Result: {verdict}"])


def exit_code(report: Report) -> int:
    return 1 if report.failed else 0


# --- 1. ref ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    given: str
    sha: str
    branch: str | None  # set when the ref names a branch on origin (resolved to its tip)

    @property
    def short(self) -> str:
        return self.sha[:12]


class RefError(ValueError):
    pass


def _branch_name(ref: str) -> str:
    for prefix in ("refs/heads/", "refs/remotes/origin/", "origin/"):
        if ref.startswith(prefix):
            return ref[len(prefix) :]
    return ref


def remote_branch_tip(runner: Runner, branch: str) -> str | None:
    result = runner.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}^{{commit}}"]
    )
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def resolve_ref(runner: Runner, ref: str) -> Ref:
    """A branch name resolves to origin's tip (what a dispatch deploys); anything else (tag, SHA,
    local ref) to its commit."""
    if not ref or ref.startswith("-"):
        raise RefError("REF must be a branch, tag or commit")
    name = _branch_name(ref)
    tip = remote_branch_tip(runner, name)
    if tip:
        return Ref(ref, tip, name)
    result = runner.run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    sha = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RefError(f"cannot resolve {ref!r} to a commit (after git fetch)")
    return Ref(ref, sha, None)


def describe_commit(runner: Runner, sha: str) -> list[str]:
    result = runner.run(
        ["git", "show", "--no-patch", "--date=iso", "--format=%H%n%an  %ad%n%s", sha]
    )
    return result.stdout.strip().splitlines() if result.returncode == 0 else [sha]


# --- 2. ref rule (shared with deploy.yml) ---------------------------------------------------------

_CASE = re.compile(r'case "\$TARGET/\$REF" in\n\s+(.+?)\) ;;')


def _deploy_job(workflow: Mapping[Any, Any]) -> Mapping[str, Any]:
    job = workflow["jobs"]["deploy"]
    assert isinstance(job, dict)  # noqa: S101 - workflow shape is pinned by its own tests
    return job


def allowed_refs(workflow: Mapping[Any, Any]) -> dict[str, set[str]]:
    """The preflight `case "$TARGET/$REF"` allow-list of deploy.yml as {environment: {git ref}}."""
    for step in _deploy_job(workflow)["steps"]:
        match = _CASE.search(str(step.get("run", "")))
        if match:
            out: dict[str, set[str]] = {}
            for pattern in match.group(1).split("|"):
                target, _, ref = pattern.strip().partition("/")
                out.setdefault(target, set()).add(ref)
            return out
    raise ValueError(f"{DEPLOY_WORKFLOW}: no TARGET/REF allow-list in the preflight step")


def required_ci_jobs(workflow: Mapping[Any, Any]) -> list[str]:
    """REQUIRED_CI_JOBS of deploy.yml's "CI passed" step, one display name per line."""
    for step in _deploy_job(workflow)["steps"]:
        raw = (step.get("env") or {}).get("REQUIRED_CI_JOBS")
        if raw:
            return [line.strip() for line in str(raw).splitlines() if line.strip()]
    raise ValueError(f"{DEPLOY_WORKFLOW}: no REQUIRED_CI_JOBS")


@dataclass(frozen=True)
class RefRule:
    allowed: bool
    message: str
    dispatch_branch: str | None  # the branch `gh workflow run --ref` would use


def check_ref_rule(
    env: str, ref: Ref, allowed: Mapping[str, set[str]], tips: Mapping[str, str | None]
) -> RefRule:
    """deploy.yml deploys `github.sha` = the tip of the dispatched branch, and admits only the
    env's branch: a branch ref must be that branch; a SHA/tag must be its current tip."""
    branches = sorted(r.removeprefix("refs/heads/") for r in allowed.get(env, ()))
    if not branches:
        return RefRule(False, f"deploy.yml admits no ref for {env}", None)
    want = " or ".join(branches)
    if ref.branch is not None:
        if f"refs/heads/{ref.branch}" in allowed.get(env, ()):
            return RefRule(True, f"{env} ← refs/heads/{ref.branch}", ref.branch)
        return RefRule(False, f"{env} deploys only from {want}, not {ref.branch}", None)
    for branch in branches:
        if tips.get(branch) == ref.sha:
            return RefRule(True, f"{env} ← refs/heads/{branch} (the SHA is its tip)", branch)
    return RefRule(
        False,
        f"{ref.short} is not the tip of origin/{want}: a {env} dispatch deploys that tip",
        None,
    )


def load_workflow(runner: Runner, sha: str) -> dict[Any, Any]:
    """deploy.yml as of the commit being deployed (the rules that will run), else the checkout's."""
    result = runner.run(["git", "show", f"{sha}:{DEPLOY_WORKFLOW}"])
    text = result.stdout if result.returncode == 0 else (ROOT / DEPLOY_WORKFLOW).read_text()
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError(f"{DEPLOY_WORKFLOW} is not a mapping")
    return data


# --- 3. CI ----------------------------------------------------------------------------------------


def evaluate_ci(
    required: Sequence[str], jobs: Iterable[Mapping[str, Any]], *, run_completed: bool = True
) -> tuple[str, list[str]]:
    """(verdict, problems) for one CI run, judged like deploy.yml: per required job, not by the
    run conclusion. verdict: success | in_progress (nothing failed yet) | failure. A job missing
    from a run that has not completed has not started yet."""
    by_name = {str(job.get("name")): job for job in jobs}
    problems: list[str] = []
    running = failed = False
    for name in required:
        job = by_name.get(name)
        if job is None and not run_completed:
            running = True
            problems.append(f"{name}: not started")
        elif job is None:
            problems.append(f"{name}: missing")
        elif str(job.get("status")) != "completed":
            running = True
            problems.append(f"{name}: {job.get('status') or 'pending'}")
        elif job.get("conclusion") != "success":
            failed = True
            problems.append(f"{name}: {job.get('conclusion') or 'no conclusion'}")
    if not problems:
        return "success", []
    return ("in_progress" if running and not failed else "failure"), problems


def check_ci(runner: Runner, repo: str, sha: str, required: Sequence[str]) -> Step:
    listed = runner.run(
        [
            "gh",
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            "ci.yml",
            "--commit",
            sha,
            "--event",
            "push",
            "--limit",
            "1",
            "--json",
            "databaseId,status,conclusion,url",
        ]
    )
    if listed.returncode != 0:
        return Step("ci", FAIL, "gh run list failed (gh auth status?)", [listed.stderr.strip()])
    runs = json.loads(listed.stdout or "[]")
    if not runs:
        return Step("ci", FAIL, f"no CI push run for {sha[:12]}: deploy only green commits")
    run = runs[0]
    run_id = str(run["databaseId"])
    viewed = runner.run(["gh", "run", "view", run_id, "--repo", repo, "--json", "jobs"])
    if viewed.returncode != 0:
        return Step("ci", FAIL, f"gh run view {run_id} failed", [viewed.stderr.strip()])
    jobs = json.loads(viewed.stdout or "{}").get("jobs", [])
    verdict, problems = evaluate_ci(required, jobs, run_completed=run.get("status") == "completed")
    url = str(run.get("url", ""))
    if verdict == "success":
        return Step("ci", OK, f"run {run_id}: all {len(required)} required jobs succeeded", [url])
    lead = "still in progress" if verdict == "in_progress" else "not green"
    return Step("ci", FAIL, f"run {run_id} {lead}: {'; '.join(problems)}", [url])


def repo_slug(runner: Runner) -> str | None:
    result = runner.run(["git", "remote", "get-url", "origin"])
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", result.stdout.strip())
    return match.group(1) if match else None


# --- 4. worktree ----------------------------------------------------------------------------------


def add_worktree(runner: Runner, sha: str, base: Path) -> Path:
    path = base / "src"
    result = runner.run(["git", "worktree", "add", "--detach", str(path), sha])
    if result.returncode != 0:
        raise RuntimeError(f"git worktree add failed: {result.stderr.strip()}")
    return path


def remove_worktree(runner: Runner, path: Path) -> None:
    runner.run(["git", "worktree", "remove", "--force", str(path)])
    shutil.rmtree(path.parent, ignore_errors=True)


# --- 5. env ---------------------------------------------------------------------------------------


def _load_check_env() -> ModuleType:
    if "check_env" in sys.modules:
        return sys.modules["check_env"]
    spec = importlib.util.spec_from_file_location(
        "check_env", Path(__file__).with_name("check_env.py")
    )
    if spec is None or spec.loader is None:
        raise ImportError("scripts/check_env.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_env"] = module
    spec.loader.exec_module(module)
    return module


def env_files(env_dir: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for service in ENV_FILE_SERVICES:
        for name in (f"{service}.check.env", f"{service}.env"):
            if (env_dir / name).is_file():
                found[service] = env_dir / name
                break
    return found


def read_env_files(files: Mapping[str, Path], redactor: Redactor) -> dict[str, dict[str, str]]:
    """Parsed env files. Values of `secret` variables, of names the manifest does not know, and
    any password inside a URL are registered with the redactor; `public`/`config` values (env
    names, origins, flags) stay readable."""
    check_env = _load_check_env()
    kinds = {var.name: var.kind for var in check_env.load_manifest().vars}
    out: dict[str, dict[str, str]] = {}
    for service, path in files.items():
        values: dict[str, str] = check_env.parse_dotenv(path.read_text(encoding="utf-8"))
        for name, value in values.items():
            if kinds.get(name, "secret") == "secret":
                redactor.add(value)
            if "://" in value:
                redactor.add_password(value)
        out[service] = values
    return out


def _run_check_env(
    runner: Runner, worktree: Path, env: str, files: Mapping[str, Path], redactor: Redactor
) -> tuple[int, list[str]]:
    argv = [sys.executable, str(worktree / "scripts" / "check_env.py"), "--env", env]
    for service, path in files.items():
        argv += ["--check", f"{service}={path}"]
    result = runner.run(argv, cwd=worktree)
    return result.returncode, [
        redactor(line) for line in (result.stdout + result.stderr).splitlines() if line.strip()
    ]


def check_env_step(
    runner: Runner,
    worktree: Path,
    env: str,
    env_dir: Path,
    files: Mapping[str, Path],
    redactor: Redactor,
) -> list[Step]:
    """`env`: the deployed services (web/api/worker) — required. `env ops`: supabase-config and
    smoke files when present (with web, for the Turnstile key pair) — advisory, since the deploy
    itself does not read them."""
    if not env_dir.is_dir():
        return [Step("env", SKIP, f"not checked: {env_dir} does not exist")]
    deployed = {s: files[s] for s in REQUIRED_ENV_SERVICES if s in files}
    if not deployed:
        return [Step("env", SKIP, f"not checked: no web/api/worker env files in {env_dir}")]
    code, lines = _run_check_env(runner, worktree, env, deployed, redactor)
    names = ", ".join(deployed)
    missing = [s for s in REQUIRED_ENV_SERVICES if s not in deployed]
    if code != 0:
        tail = lines[-1] if lines else f"check_env exited {code}"
        steps = [Step("env", FAIL, tail.removeprefix("check_env: "), lines)]
    elif missing:
        steps = [Step("env", WARN, f"{names} ok; no file for {', '.join(missing)}", lines)]
    else:
        steps = [Step("env", OK, f"{names} ok", lines[-1:])]
    ops = {s: files[s] for s in files if s not in REQUIRED_ENV_SERVICES}
    if ops:
        with_web = {**ops, **({"web": files["web"]} if "web" in files else {})}
        code, lines = _run_check_env(runner, worktree, env, with_web, redactor)
        own = [line for line in lines if not re.match(r"(ERROR|warning)\s+web ", line)]
        status = OK if code == 0 else WARN
        detail = ", ".join(ops) + (" ok" if code == 0 else ": see errors (not used by the deploy)")
        steps.append(Step("env ops", status, detail, own if code else own[-1:]))
    return steps


def web_build_args(web_env: Mapping[str, str]) -> list[str]:
    """`--build-arg` pairs for the web image: public NEXT_PUBLIC_* values only."""
    args: list[str] = []
    for name in sorted(web_env):
        if name.startswith("NEXT_PUBLIC_") and web_env[name].strip():
            args += ["--build-arg", f"{name}={web_env[name].strip()}"]
    return args


# --- 6. migrations --------------------------------------------------------------------------------


def migration_version(filename: str) -> str:
    return filename.split("_", 1)[0]


def list_migrations(runner: Runner, sha: str) -> list[str]:
    result = runner.run(["git", "ls-tree", "--name-only", sha, f"{MIGRATIONS_DIR}/"])
    names = [Path(line).name for line in result.stdout.splitlines()]
    return sorted(name for name in names if name.endswith(".sql"))


def pg_env(db_url: str) -> dict[str, str]:
    """libpq variables for a URL, so the password never appears in argv; every transaction is
    read-only."""
    parts = urlsplit(db_url)
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        raise ValueError("the DB URL must be a postgresql:// URL")
    env = {
        "PGHOST": parts.hostname,
        "PGPORT": str(parts.port or 5432),
        "PGDATABASE": unquote(parts.path.lstrip("/")) or "postgres",
        "PGOPTIONS": "-c default_transaction_read_only=on",
        "PGCONNECT_TIMEOUT": "15",
        "PGAPPNAME": "deploy_prepare",
    }
    if parts.username:
        env["PGUSER"] = unquote(parts.username)
    if parts.password:
        env["PGPASSWORD"] = unquote(parts.password)
    sslmode = parse_qs(parts.query).get("sslmode")
    env["PGSSLMODE"] = sslmode[0] if sslmode else "require"
    return env


APPLIED_SQL = "select version from supabase_migrations.schema_migrations order by version"


def applied_versions(runner: Runner, db_url: str) -> list[str]:
    result = runner.run(
        ["psql", "--no-psqlrc", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", APPLIED_SQL],
        env=pg_env(db_url),
    )
    if result.returncode != 0:
        raise RuntimeError("psql: could not read supabase_migrations.schema_migrations")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def last_deployed_sha(runner: Runner, repo: str, env: str) -> str | None:
    """SHA of the newest GitHub deployment of `env` whose latest status is success (deploy.yml
    binds its job to the GitHub Environment, so every run records a deployment)."""
    listed = runner.run(["gh", "api", f"repos/{repo}/deployments?environment={env}&per_page=20"])
    if listed.returncode != 0:
        return None
    for deployment in json.loads(listed.stdout or "[]"):
        statuses = runner.run(
            ["gh", "api", f"repos/{repo}/deployments/{deployment['id']}/statuses?per_page=1"]
        )
        latest = json.loads(statuses.stdout or "[]") if statuses.returncode == 0 else []
        if latest and latest[0].get("state") == "success":
            return str(deployment["sha"])
    return None


def diff_migrations(runner: Runner, base: str, sha: str) -> tuple[list[str], list[str]]:
    """(added, changed) migration files between base and sha. A changed or deleted migration
    that may already be applied is a problem in itself."""
    result = runner.run(
        ["git", "diff", "--name-status", "--no-renames", base, sha, "--", f"{MIGRATIONS_DIR}/"]
    )
    if result.returncode != 0:
        raise RuntimeError(f"git diff {base[:12]}..{sha[:12]} failed")
    added: list[str] = []
    changed: list[str] = []
    for line in result.stdout.splitlines():
        status, _, path = line.partition("\t")
        if not path.endswith(".sql"):
            continue
        if status == "A":
            added.append(Path(path).name)
        else:
            changed.append(f"{Path(path).name} ({status})")
    return sorted(added), sorted(changed)


_COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_DESTRUCTIVE = [
    (
        re.compile(
            r"\bdrop\s+(?P<what>table|schema|column|type|domain|view|materialized\s+view|sequence"
            r"|extension|database)\b(?:\s+if\s+exists)?\s+(?P<obj>[\w.\"]+)",
            re.I,
        ),
        "DROP",
    ),
    (
        re.compile(
            r"\balter\s+table\b[^;]*?\bdrop\s+(?!constraint\b|default\b|not\b|identity\b"
            r"|expression\b|column\b)(?P<obj>[\w\"]+)",
            re.I,
        ),
        "ALTER … DROP",
    ),
    (re.compile(r"\btruncate\b", re.I), "TRUNCATE"),
    (re.compile(r"\brename\s+(?:to|column|constraint|[\w\"]+\s+to)\b", re.I), "RENAME"),
    (re.compile(r"\bdelete\s+from\b", re.I), "DELETE"),
]
_SCHEMA_DROP = re.compile(
    r"\bdrop\s+(constraint|trigger|function|procedure|policy|index|default|not\s+null)\b", re.I
)


def _blank_comments(sql: str) -> str:
    """Comments replaced by spaces, newlines kept, so offsets map to the original lines."""
    return _COMMENTS.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), sql)


@dataclass(frozen=True)
class Finding:
    line: int
    kind: str
    text: str


def destructive_findings(sql: str) -> tuple[list[Finding], list[Finding]]:
    """(destructive, schema) statements. Destructive = may lose data or break the running
    (previous) code: DROP TABLE/COLUMN/…, ALTER TABLE … DROP <column>, TRUNCATE, RENAME, DELETE.
    Schema = DROP CONSTRAINT/TRIGGER/FUNCTION/POLICY/INDEX/DEFAULT/NOT NULL (usually recreated).
    Temporary tables (`on commit drop`, `drop table pg_temp.…`) are not findings."""
    code = _blank_comments(sql)
    lines = sql.splitlines()

    def finding(offset: int, kind: str) -> Finding:
        number = code.count("\n", 0, offset) + 1
        return Finding(number, kind, lines[number - 1].strip()[:100])

    destructive: list[Finding] = []
    for pattern, kind in _DESTRUCTIVE:
        for match in pattern.finditer(code):
            obj = (match.groupdict().get("obj") or "").lower()
            if obj.startswith("pg_temp."):
                continue
            label = f"{kind} {match.group('what').upper()}" if "what" in match.groupdict() else kind
            destructive.append(finding(match.start(), label))
    schema = [finding(m.start(), f"DROP {m.group(1).upper()}") for m in _SCHEMA_DROP.finditer(code)]
    return sorted(destructive, key=lambda f: f.line), schema


def migrations_step(
    runner: Runner,
    sha: str,
    db_url: str | None,
    baseline: str | None,
    baseline_label: str,
) -> Step:
    at_sha = list_migrations(runner, sha)
    lines: list[str] = []
    status = OK
    if db_url:
        try:
            applied = applied_versions(runner, db_url)
        except (RuntimeError, ValueError) as exc:
            return Step("migrations", FAIL, str(exc))
        versions = {migration_version(name) for name in at_sha}
        pending = [name for name in at_sha if migration_version(name) not in set(applied)]
        ahead = [v for v in applied if v not in versions]
        source = f"target DB has {len(applied)} applied"
        if ahead:
            status = WARN
            lines.append(
                f"! DB has {len(ahead)} migration(s) this commit lacks ({', '.join(ahead)}): "
                "`supabase db push` would fail; an older commit deploys with skip_migrations=true "
                "(runbook §5)"
            )
    elif baseline:
        try:
            pending, changed = diff_migrations(runner, baseline, sha)
        except RuntimeError as exc:
            return Step("migrations", FAIL, str(exc))
        source = f"vs {baseline_label} {baseline[:12]}"
        if changed:
            status = WARN
            lines.append(f"! existing migration(s) changed or deleted: {', '.join(changed)}")
    else:
        pending = at_sha
        source = "no baseline (first deploy?): every migration counted"
        status = WARN

    for name in pending:
        lines.append(f"+ {name}")
        sql = runner.run(["git", "show", f"{sha}:{MIGRATIONS_DIR}/{name}"]).stdout
        destructive, schema = destructive_findings(sql)
        for item in destructive:
            status = WARN
            lines.append(f"    ! {item.kind} (line {item.line}): {item.text}")
        for item in schema:
            lines.append(f"      note {item.kind} (line {item.line}): {item.text}")
    flagged = sum(line.lstrip().startswith("! ") for line in lines)
    detail = f"{len(pending)} pending ({source})"
    if flagged:
        detail += f"; {flagged} warning(s)"
    return Step("migrations", status, detail, lines)


# --- 7. images ------------------------------------------------------------------------------------


def disk_step(paths: Sequence[Path], min_free_gb: float) -> Step:
    """Free space on the fullest of `paths` (the worktree and Docker's data under $HOME share the
    host disk on Docker Desktop)."""
    free, where = min((shutil.disk_usage(p).free / GIB, p) for p in paths)
    if free < min_free_gb:
        return Step(
            "disk",
            FAIL,
            f"{free:.1f} GiB free on {where}, need {min_free_gb:g}: free space "
            "(`docker system df`, `docker builder prune`) or pass --skip-images",
        )
    return Step("disk", OK, f"{free:.1f} GiB free (min {min_free_gb:g})")


def build_images(
    runner: Runner,
    worktree: Path,
    services: Sequence[str],
    tag: str,
    web_args: list[str] | None,
    write: Callable[[str], None],
) -> list[Step]:
    if runner.run(["docker", "info", "--format", "{{.ServerVersion}}"]).returncode != 0:
        return [Step(f"image {svc}", FAIL, "docker daemon not reachable") for svc in services]
    steps = []
    for svc in services:
        argv = ["make", "-C", str(worktree), f"image-{svc}", f"IMAGE_TAG={tag}"]
        if svc == "web":
            if not web_args:
                steps.append(
                    Step("image web", FAIL, "no NEXT_PUBLIC_* values (web env file or --web-args)")
                )
                continue
            argv.append(f"WEB_ARGS={shlex.join(web_args)}")
        write(f"--- building quiz-{svc}:{tag}\n")
        code = runner.stream(argv, cwd=worktree, write=write)
        steps.append(
            Step(f"image {svc}", OK, f"quiz-{svc}:{tag}")
            if code == 0
            else Step(f"image {svc}", FAIL, f"docker build exited {code}")
        )
    return steps


# --- 8. next command ------------------------------------------------------------------------------


def dispatch_command(repo: str, branch: str, env: str) -> str:
    return shlex.join(
        [
            "gh",
            "workflow",
            "run",
            "deploy.yml",
            "--repo",
            repo,
            "--ref",
            branch,
            "-f",
            f"environment={env}",
        ]
    )


# --- main -----------------------------------------------------------------------------------------


def read_db_url(args: argparse.Namespace) -> str | None:
    if args.db_url_env:
        value = os.environ.get(args.db_url_env, "").strip()
        if not value:
            raise ValueError(f"--db-url-env: ${args.db_url_env} is not set")
        return value
    if args.db_url_file:
        text = Path(args.db_url_file).expanduser().read_text(encoding="utf-8").strip()
        if "SUPABASE_DB_URL=" in text:
            value = _load_check_env().parse_dotenv(text).get("SUPABASE_DB_URL", "").strip()
        else:
            value = text
        if not value or "\n" in value:
            raise ValueError("--db-url-file: no URL (a bare URL or a SUPABASE_DB_URL= line)")
        return str(value)
    return None


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--ref", required=True, help="branch, tag or commit to prepare")
    parser.add_argument("--env", required=True, choices=ENVIRONMENTS)
    parser.add_argument("--repo", help="owner/name (default: from the origin remote)")
    parser.add_argument("--no-fetch", action="store_true", help="skip `git fetch origin`")
    parser.add_argument(
        "--allow-any-ref",
        action="store_true",
        help="build a ref deploy.yml would refuse (local builds only; the rule becomes a warning)",
    )
    parser.add_argument("--skip-ci", action="store_true", help="do not look up the CI run")
    parser.add_argument("--env-dir", type=Path, help="default ~/.secrets/quiz-workspace/<env>")
    parser.add_argument("--db-url-env", metavar="NAME", help="env var holding the target DB URL")
    parser.add_argument("--db-url-file", metavar="FILE", help="file with the target DB URL")
    parser.add_argument("--since", metavar="REF", help="migration baseline (default: last deploy)")
    parser.add_argument("--skip-images", action="store_true")
    parser.add_argument("--only", default=",".join(IMAGE_SERVICES), help="api,worker,web")
    parser.add_argument("--web-args", help="docker build args for web (public values only)")
    parser.add_argument("--min-free-gb", type=float, default=MIN_FREE_GB)
    parser.add_argument("--work-dir", type=Path, help="parent dir of the temporary worktree")
    parser.add_argument("--keep", action="store_true", help="keep the temporary worktree")
    args = parser.parse_args(argv)
    args.only = [s.strip() for s in args.only.split(",") if s.strip()]
    unknown = set(args.only) - set(IMAGE_SERVICES)
    if unknown or not args.only:
        parser.error(f"--only takes a subset of {','.join(IMAGE_SERVICES)}")
    if args.db_url_env and args.db_url_file:
        parser.error("pass one of --db-url-env / --db-url-file")
    # Absolute now: check_env.py and git run with cwd = the temporary worktree.
    for name in ("env_dir", "db_url_file", "work_dir"):
        value = getattr(args, name)
        if value is not None:
            setattr(args, name, Path(value).expanduser().resolve())
    return args


def _print_step(step: Step, write: Callable[[str], None]) -> None:
    write(f"[{MARK[step.status]}] {step.name}: {step.detail}\n")
    for line in step.lines:
        write(f"      {line}\n")


def run(args: argparse.Namespace, runner: Runner, write: Callable[[str], None]) -> int:
    redactor = Redactor()
    report = Report()

    def out(text: str) -> None:
        write(redactor(text))

    def record(step: Step) -> Step:
        report.add(step)
        _print_step(step, out)
        return step

    try:
        db_url = read_db_url(args)
    except (OSError, ValueError) as exc:
        out(f"deploy_prepare: {exc}\n")
        return 2
    if db_url:
        redactor.add_url(db_url)

    # 1. ref
    if not args.no_fetch:
        fetched = runner.run(["git", "fetch", "--quiet", "--prune", "origin"])
        if fetched.returncode != 0:
            record(Step("fetch", FAIL, "git fetch origin failed", [fetched.stderr.strip()]))
    try:
        ref = resolve_ref(runner, args.ref)
    except RefError as exc:
        record(Step("ref", FAIL, str(exc)))
        out(render_summary(report) + "\n")
        return exit_code(report)
    record(Step("ref", OK, f"{args.ref} → {ref.sha}", describe_commit(runner, ref.sha)))

    # 2. ref rule
    workflow = load_workflow(runner, ref.sha)
    allowed = allowed_refs(workflow)
    tips = {
        r.removeprefix("refs/heads/"): remote_branch_tip(runner, r.removeprefix("refs/heads/"))
        for r in allowed.get(args.env, ())
    }
    rule = check_ref_rule(args.env, ref, allowed, tips)
    if rule.allowed:
        record(Step("ref rule", OK, rule.message))
    elif args.allow_any_ref:
        record(
            Step(
                "ref rule",
                WARN,
                f"--allow-any-ref: {rule.message}. "
                "deploy.yml WOULD REFUSE THIS REF; local build only",
            )
        )
    else:
        record(Step("ref rule", FAIL, rule.message + " (--allow-any-ref to build locally anyway)"))

    # 3. CI
    repo = args.repo or repo_slug(runner)
    if args.skip_ci:
        record(Step("ci", SKIP, "--skip-ci"))
    elif not repo:
        record(Step("ci", FAIL, "cannot tell the GitHub repo from origin; pass --repo"))
    else:
        record(check_ci(runner, repo, ref.sha, required_ci_jobs(workflow)))
    if args.env == "production" and repo:
        flag = runner.run(["gh", "variable", "get", "PRODUCTION_DEPLOY_ENABLED", "--repo", repo])
        if flag.stdout.strip() != "true":
            record(
                Step(
                    "prod switch", WARN, "PRODUCTION_DEPLOY_ENABLED is not true: preflight refuses"
                )
            )

    # 4. worktree
    base = Path(
        tempfile.mkdtemp(prefix=f"quiz-deploy-{ref.short}-", dir=args.work_dir)
    )  # created by us, removed below
    worktree: Path | None = None
    try:
        try:
            worktree = add_worktree(runner, ref.sha, base)
            record(Step("worktree", OK, str(worktree)))
        except RuntimeError as exc:
            record(Step("worktree", FAIL, redactor(str(exc))))

        # 5. env
        env_dir = (args.env_dir or DEFAULT_ENV_DIR / args.env).expanduser()
        files = env_files(env_dir) if env_dir.is_dir() else {}
        try:
            env_values = read_env_files(files, redactor)
        except (OSError, UnicodeDecodeError):
            env_values = {}
            record(Step("env", FAIL, f"cannot read the env files in {env_dir}"))
        else:
            if worktree is None:
                record(Step("env", SKIP, "no worktree"))
            else:
                for step in check_env_step(runner, worktree, args.env, env_dir, files, redactor):
                    record(step)

        # 6. migrations
        baseline, label = None, ""
        if not db_url:
            if args.since:
                try:
                    baseline, label = resolve_ref(runner, args.since).sha, f"--since {args.since}"
                except RefError as exc:
                    record(Step("migrations", FAIL, str(exc)))
                    label = "error"
            elif repo:
                baseline = last_deployed_sha(runner, repo, args.env)
                label = f"last {args.env} deploy"
                if baseline and runner.run(["git", "cat-file", "-e", baseline]).returncode != 0:
                    runner.run(["git", "fetch", "--quiet", "origin", baseline])
        if label != "error":
            record(migrations_step(runner, ref.sha, db_url, baseline, label))

        # 7. images
        if args.skip_images:
            record(Step("images", SKIP, "--skip-images"))
        elif worktree is None:
            record(Step("images", SKIP, "no worktree"))
        else:
            disk = record(disk_step([base, Path.home()], args.min_free_gb))
            if disk.status == OK:
                web_args = (
                    shlex.split(args.web_args)
                    if args.web_args
                    else web_build_args(env_values.get("web", {}))
                )
                for step in build_images(runner, worktree, args.only, ref.short, web_args, out):
                    record(step)
    finally:
        if args.keep and worktree is not None:
            out(f"kept worktree: {worktree} (remove: git worktree remove --force {worktree})\n")
        elif worktree is not None:
            remove_worktree(runner, worktree)
        else:
            shutil.rmtree(base, ignore_errors=True)

    # 8. summary
    out("\n" + render_summary(report) + "\n")
    if rule.allowed and repo:
        out(
            "\nNext (not run; deploys the tip of the branch — check it is still "
            + ref.short
            + "):\n"
        )
        out(f"  {dispatch_command(repo, rule.dispatch_branch or '', args.env)}\n")
    elif not rule.allowed:
        out("\nNo deploy command: deploy.yml would refuse this ref for " + args.env + ".\n")
    return exit_code(report)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    def write(text: str) -> None:
        sys.stdout.write(text)
        sys.stdout.flush()

    return run(args, Runner(), write)


if __name__ == "__main__":
    raise SystemExit(main())
