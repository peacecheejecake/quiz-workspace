"""scripts/deploy_prepare.py (DEP-PREP), offline: git/gh/docker/psql behind a fake runner."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_TEXT = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "deploy_prepare", Path(__file__).with_name("deploy_prepare.py")
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["deploy_prepare"] = module
    spec.loader.exec_module(module)
    return module


dp = _load()
WORKFLOW = yaml.safe_load(WORKFLOW_TEXT)
SHA = "a" * 40
DEVELOP_TIP = SHA
MAIN_TIP = "b" * 40
OLD = "c" * 40
SECRET = "s3cr3t-value-that-must-never-be-printed-0123456789"  # noqa: S105
DB_PASSWORD = "db-pass-never-printed-4242"  # noqa: S105


# --- fake runner ----------------------------------------------------------------------------------


class Call(NamedTuple):
    argv: list[str]
    env: dict[str, str] | None


Responder = Callable[[list[str]], "dp.Result | None"]


class FakeRunner:
    """Answers each command from `respond`; every command still passes assert_read_only."""

    def __init__(self, respond: Responder) -> None:
        self.respond = respond
        self.calls: list[Call] = []

    def _answer(self, argv: Sequence[str], env: Any = None) -> Any:
        dp.assert_read_only(argv)
        self.calls.append(Call(list(argv), dict(env) if env else None))
        result = self.respond(list(argv))
        return result if result is not None else dp.Result(1, "", "unexpected command")

    def run(self, argv: Sequence[str], *, cwd: Any = None, env: Any = None) -> Any:
        return self._answer(argv, env)

    def stream(self, argv: Sequence[str], *, cwd: Any, write: Callable[[str], None]) -> int:
        result = self._answer(argv)
        write(result.stdout)
        return int(result.returncode)


def ok(stdout: str = "") -> Any:
    return dp.Result(0, stdout, "")


def jobs_json(conclusions: dict[str, str], status: str = "completed") -> str:
    return json.dumps(
        {
            "jobs": [
                {"name": name, "status": status, "conclusion": conclusion}
                for name, conclusion in conclusions.items()
            ]
        }
    )


REQUIRED = dp.required_ci_jobs(WORKFLOW)
MIGRATIONS = {
    "20261017120000_baseline.sql": "create table public.a (id int);\n",
    "20261020120000_new.sql": (
        "-- drop table public.a (comment only)\nalter table public.a drop id;\n"
    ),
}


def default_responder(
    *,
    ci_jobs: dict[str, str] | None = None,
    ci_runs: list[dict[str, Any]] | None = None,
    check_env_out: str = "check_env: staging: 3 ok, 0 warning(s), 0 error(s) [web, api, worker]\n",
    check_env_code: int = 0,
    applied: list[str] | None = None,
    deployments: list[dict[str, Any]] | None = None,
    build_code: int = 0,
) -> Responder:
    jobs = ci_jobs if ci_jobs is not None else dict.fromkeys(REQUIRED, "success")
    runs = (
        ci_runs
        if ci_runs is not None
        else [{"databaseId": 7, "status": "completed", "conclusion": "success", "url": "u"}]
    )

    def respond(argv: list[str]) -> Any:
        joined = " ".join(argv)
        if argv[:2] == ["git", "fetch"]:
            return ok()
        if argv[:2] == ["git", "rev-parse"]:
            target = argv[-1]
            tips = {"develop": DEVELOP_TIP, "main": MAIN_TIP}
            match = re.fullmatch(r"refs/remotes/origin/(.+)\^\{commit\}", target)
            if match:
                tip = tips.get(match.group(1))
                return ok(tip + "\n") if tip else dp.Result(1)
            if target.startswith(("deadbeef", OLD)):
                return ok(OLD + "\n")
            return dp.Result(128)
        if argv[:2] == ["git", "show"] and argv[-1].endswith(dp.DEPLOY_WORKFLOW):
            return ok(WORKFLOW_TEXT)
        if argv[:2] == ["git", "show"] and ":supabase/migrations/" in argv[-1]:
            return ok(MIGRATIONS[argv[-1].rsplit("/", 1)[1]])
        if argv[:2] == ["git", "show"]:
            return ok(f"{SHA}\nTester  2026-10-20\nsubject\n")
        if argv[:2] == ["git", "remote"]:
            return ok("https://github.com/owner/repo.git\n")
        if argv[:2] == ["git", "ls-tree"]:
            return ok("".join(f"supabase/migrations/{name}\n" for name in MIGRATIONS))
        if argv[:2] == ["git", "diff"]:
            return ok("A\tsupabase/migrations/20261020120000_new.sql\n")
        if argv[:2] == ["git", "worktree"] or argv[:2] == ["git", "cat-file"]:
            return ok()
        if argv[:3] == ["gh", "run", "list"]:
            return ok(json.dumps(runs))
        if argv[:3] == ["gh", "run", "view"]:
            return ok(jobs_json(jobs))
        if argv[:2] == ["gh", "variable"]:
            return ok("true\n")
        if argv[:2] == ["gh", "api"] and "/statuses" in joined:
            return ok(json.dumps([{"state": "success"}]))
        if argv[:2] == ["gh", "api"]:
            return ok(json.dumps(deployments or [{"id": 1, "sha": OLD}]))
        if argv[0] == sys.executable:
            return dp.Result(check_env_code, check_env_out, "")
        if argv[0] == "psql":
            return ok("".join(f"{v}\n" for v in applied or []))
        if argv[:2] == ["docker", "info"]:
            return ok("29.0.0\n")
        if argv[0] == "make":
            return dp.Result(build_code, "building\n", "")
        return None

    return respond


def run_prepare(
    tmp_path: Path, argv: list[str], respond: Responder | None = None
) -> tuple[int, str, FakeRunner]:
    runner = FakeRunner(respond or default_responder())
    args = dp.parse_args([*argv, "--work-dir", str(tmp_path / "work")])
    (tmp_path / "work").mkdir(exist_ok=True)
    out: list[str] = []
    code = dp.run(args, runner, out.append)
    return code, "".join(out), runner


def env_dir(tmp_path: Path, web_extra: str = "") -> Path:
    directory = tmp_path / "secrets"
    directory.mkdir()
    (directory / "api.env").write_text(
        f"APP_ENV=preview\nSHARE_SESSION_SECRET={SECRET}\n"
        f"DATABASE_URL=postgresql://quiz_api.ref:{DB_PASSWORD}@pooler.example:5432/postgres\n",
        encoding="utf-8",
    )
    (directory / "worker.env").write_text("APP_ENV=preview\n", encoding="utf-8")
    (directory / "web.env").write_text(
        "APP_ENV=preview\nNEXT_PUBLIC_SUPABASE_URL=https://ref.supabase.co\n"
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_x\n"
        "NEXT_PUBLIC_API_BASE_URL=https://api.example\n" + web_extra,
        encoding="utf-8",
    )
    return directory


# --- ref rule: parity with deploy.yml -------------------------------------------------------------


def test_allowed_refs_are_read_from_the_workflow() -> None:
    assert dp.allowed_refs(WORKFLOW) == {
        "staging": {"refs/heads/develop"},
        "production": {"refs/heads/main"},
    }


def _bash_case(target: str, ref: str) -> bool:
    """Runs deploy.yml's own `case "$TARGET/$REF"` block in bash."""
    preflight = next(
        str(step["run"])
        for step in WORKFLOW["jobs"]["deploy"]["steps"]
        if 'case "$TARGET/$REF"' in str(step.get("run", ""))
    )
    block = re.search(r'case "\$TARGET/\$REF" in.*?esac', preflight, re.S)
    assert block
    bash = shutil.which("bash")
    assert bash
    result = subprocess.run(  # noqa: S603 - the workflow's own case block, fixed inputs
        [bash, "-c", block.group(0).replace("exit 1", "exit 3")],
        env={"TARGET": target, "REF": ref, "PATH": "/usr/bin:/bin"},
        capture_output=True,
        check=False,
    )
    assert result.returncode in (0, 3)
    return result.returncode == 0


@pytest.mark.parametrize("target", ["staging", "production"])
@pytest.mark.parametrize("branch", ["develop", "main", "feature/x", "release"])
def test_branch_rule_matches_the_workflow_case_block(target: str, branch: str) -> None:
    ref = dp.Ref(branch, SHA, branch)
    rule = dp.check_ref_rule(target, ref, dp.allowed_refs(WORKFLOW), {})
    assert rule.allowed is _bash_case(target, f"refs/heads/{branch}")
    assert rule.dispatch_branch == (branch if rule.allowed else None)


def test_a_sha_is_allowed_only_as_the_tip_of_the_env_branch() -> None:
    allowed = dp.allowed_refs(WORKFLOW)
    tips = {"develop": DEVELOP_TIP}
    tip = dp.check_ref_rule("staging", dp.Ref(DEVELOP_TIP[:8], DEVELOP_TIP, None), allowed, tips)
    assert tip.allowed
    assert tip.dispatch_branch == "develop"
    old = dp.check_ref_rule("staging", dp.Ref("deadbeef", OLD, None), allowed, tips)
    assert not old.allowed
    assert "dispatch deploys that tip" in old.message
    # the develop tip is not a production ref
    prod = dp.check_ref_rule(
        "production", dp.Ref("x", DEVELOP_TIP, None), allowed, {"main": MAIN_TIP}
    )
    assert not prod.allowed


def test_resolve_ref_prefers_the_origin_branch_tip() -> None:
    runner = FakeRunner(default_responder())
    for given in ("develop", "origin/develop", "refs/heads/develop", "refs/remotes/origin/develop"):
        ref = dp.resolve_ref(runner, given)
        assert (ref.sha, ref.branch) == (DEVELOP_TIP, "develop")
    sha_ref = dp.resolve_ref(runner, "deadbeef")
    assert (sha_ref.sha, sha_ref.branch) == (OLD, None)
    with pytest.raises(dp.RefError):
        dp.resolve_ref(runner, "no-such-ref")
    with pytest.raises(dp.RefError):
        dp.resolve_ref(runner, "--upload-pack=x")


def test_allow_any_ref_downgrades_the_rule_to_a_loud_warning(tmp_path: Path) -> None:
    code, out, _ = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "production", "--skip-images", "--env-dir", "/nope"],
    )
    assert code == 1
    assert "production deploys only from main" in out
    code, out, _ = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "production", "--skip-images", "--allow-any-ref",
         "--env-dir", "/nope"],
    )  # fmt: skip
    assert code == 0
    assert "WOULD REFUSE THIS REF" in out
    assert "gh workflow run" not in out


# --- CI -------------------------------------------------------------------------------------------


def test_required_ci_jobs_are_parsed_from_the_workflow() -> None:
    raw = next(
        step["env"]["REQUIRED_CI_JOBS"]
        for step in WORKFLOW["jobs"]["deploy"]["steps"]
        if "REQUIRED_CI_JOBS" in (step.get("env") or {})
    )
    assert [line for line in raw.splitlines() if line.strip()] == REQUIRED
    assert "image · web" in REQUIRED
    assert "deploy · staging" not in REQUIRED


def test_ci_success_ignores_jobs_outside_the_required_list() -> None:
    jobs = [{"name": n, "status": "completed", "conclusion": "success"} for n in REQUIRED]
    jobs.append({"name": "deploy · staging", "status": "completed", "conclusion": "failure"})
    assert dp.evaluate_ci(REQUIRED, jobs) == ("success", [])


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "skipped", None])
def test_ci_failure_names_the_job(conclusion: str | None) -> None:
    jobs = [{"name": n, "status": "completed", "conclusion": "success"} for n in REQUIRED]
    jobs[1]["conclusion"] = conclusion
    verdict, problems = dp.evaluate_ci(REQUIRED, jobs)
    assert verdict == "failure"
    assert problems == [f"{REQUIRED[1]}: {conclusion or 'no conclusion'}"]


def test_ci_in_progress_and_missing_jobs() -> None:
    jobs = [{"name": n, "status": "completed", "conclusion": "success"} for n in REQUIRED[1:]]
    assert dp.evaluate_ci(REQUIRED, jobs) == ("failure", [f"{REQUIRED[0]}: missing"])
    assert dp.evaluate_ci(REQUIRED, jobs, run_completed=False) == (
        "in_progress",
        [f"{REQUIRED[0]}: not started"],
    )
    running = [*jobs, {"name": REQUIRED[0], "status": "in_progress", "conclusion": None}]
    assert dp.evaluate_ci(REQUIRED, running, run_completed=False)[0] == "in_progress"
    jobs[0]["conclusion"] = "failure"
    assert dp.evaluate_ci(REQUIRED, jobs, run_completed=False)[0] == "failure"


def test_check_ci_queries_the_push_run_of_the_sha() -> None:
    runner = FakeRunner(default_responder())
    step = dp.check_ci(runner, "owner/repo", SHA, REQUIRED)
    assert step.status == dp.OK
    listing = runner.calls[0].argv
    assert listing[:3] == ["gh", "run", "list"]
    assert listing[listing.index("--commit") : listing.index("--commit") + 2] == ["--commit", SHA]
    assert "--event" in listing
    assert listing[listing.index("--event") + 1] == "push"


def test_check_ci_without_a_run_or_with_a_red_job_fails() -> None:
    step = dp.check_ci(FakeRunner(default_responder(ci_runs=[])), "o/r", SHA, REQUIRED)
    assert step.status == dp.FAIL
    assert "no CI push run" in step.detail
    red = dict.fromkeys(REQUIRED, "success") | {"image · api": "failure"}
    step = dp.check_ci(FakeRunner(default_responder(ci_jobs=red)), "o/r", SHA, REQUIRED)
    assert step.status == dp.FAIL
    assert "image · api: failure" in step.detail


# --- migrations -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sql", "kind"),
    [
        ("drop table public.questions;", "DROP TABLE"),
        ("DROP TABLE IF EXISTS public.questions CASCADE;", "DROP TABLE"),
        ("alter table public.q drop column body;", "DROP COLUMN"),
        ("alter table public.q\n  drop body;", "ALTER … DROP"),
        ("truncate public.q;", "TRUNCATE"),
        ("alter table public.q rename column a to b;", "RENAME"),
        ("alter table public.q rename to r;", "RENAME"),
        ("drop schema legacy cascade;", "DROP SCHEMA"),
        ("delete from public.q where true;", "DELETE"),
    ],
)
def test_destructive_statements_are_flagged(sql: str, kind: str) -> None:
    destructive, _ = dp.destructive_findings("create table x (id int);\n" + sql)
    assert [f.kind for f in destructive][:1] == [kind]
    assert destructive[0].line == 2


@pytest.mark.parametrize(
    "sql",
    [
        "create temporary table t on commit drop as select 1;",
        "drop table pg_temp.fork_docs;",
        "-- drop table public.questions\nselect 1;",
        "/* truncate public.q; */ select 1;",
        "alter table public.q alter column a drop not null;",
        "alter table public.q alter column a drop default;",
        "alter table public.q drop constraint q_check;",
        "drop policy if exists p on public.q;",
        "create function f() returns void language sql as $$ select 1 $$;",
    ],
)
def test_harmless_statements_are_not_destructive(sql: str) -> None:
    destructive, _ = dp.destructive_findings(sql)
    assert destructive == []


def test_replaceable_drops_are_notes() -> None:
    _, schema = dp.destructive_findings(
        "drop trigger t on public.q;\nalter table q drop constraint c;\ndrop policy p on q;"
    )
    assert [f.kind for f in schema] == ["DROP TRIGGER", "DROP CONSTRAINT", "DROP POLICY"]


def test_existing_migrations_flag_no_destructive_statements() -> None:
    for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        destructive, _ = dp.destructive_findings(path.read_text(encoding="utf-8"))
        assert destructive == [], path.name


def test_diff_migrations_splits_added_and_changed() -> None:
    def respond(argv: list[str]) -> Any:
        return ok(
            "A\tsupabase/migrations/2_new.sql\nM\tsupabase/migrations/1_old.sql\n"
            "D\tsupabase/migrations/0_gone.sql\nA\tsupabase/migrations/README.md\n"
        )

    added, changed = dp.diff_migrations(FakeRunner(respond), OLD, SHA)
    assert added == ["2_new.sql"]
    assert changed == ["0_gone.sql (D)", "1_old.sql (M)"]


def test_migrations_against_the_baseline_flag_destructive_sql() -> None:
    step = dp.migrations_step(FakeRunner(default_responder()), SHA, None, OLD, "last deploy")
    assert step.status == dp.WARN
    assert step.detail.startswith("1 pending (vs last deploy")
    assert "+ 20261020120000_new.sql" in step.lines
    assert any("ALTER … DROP (line 2)" in line for line in step.lines)


def test_migrations_against_the_database_are_read_only_and_never_expose_the_password() -> None:
    url = f"postgresql://postgres.ref:{DB_PASSWORD}@pooler.example:6543/postgres"
    runner = FakeRunner(default_responder(applied=["20261017120000", "20261019000000"]))
    step = dp.migrations_step(runner, SHA, url, None, "")
    assert step.detail.startswith("1 pending (target DB has 2 applied)")
    assert any("20261019000000" in line and "skip_migrations" in line for line in step.lines)
    psql = next(call for call in runner.calls if call.argv[0] == "psql")
    assert DB_PASSWORD not in " ".join(psql.argv)
    assert psql.env is not None
    assert psql.env["PGPASSWORD"] == DB_PASSWORD
    assert psql.env["PGOPTIONS"] == "-c default_transaction_read_only=on"
    assert psql.env["PGPORT"] == "6543"
    assert psql.env["PGSSLMODE"] == "require"


def test_no_baseline_counts_every_migration_as_pending() -> None:
    step = dp.migrations_step(FakeRunner(default_responder()), SHA, None, None, "")
    assert step.status == dp.WARN
    assert step.detail.startswith("2 pending (no baseline")


def test_last_deploy_baseline_is_the_newest_successful_deployment() -> None:
    def respond(argv: list[str]) -> Any:
        if "/statuses" in argv[-1]:
            state = "failure" if "/deployments/1/" in argv[-1] else "success"
            return ok(json.dumps([{"state": state}]))
        return ok(json.dumps([{"id": 1, "sha": "1" * 40}, {"id": 2, "sha": "2" * 40}]))

    runner = FakeRunner(respond)
    assert dp.last_deployed_sha(runner, "o/r", "staging") == "2" * 40
    assert "environment=staging" in runner.calls[0].argv[-1]


# --- secrets --------------------------------------------------------------------------------------


def test_secrets_never_reach_the_output(tmp_path: Path) -> None:
    secrets = env_dir(tmp_path)
    leak = (
        f"ERROR    api SHARE_SESSION_SECRET: {SECRET} {DB_PASSWORD}\n"
        "check_env: staging: 1 error(s)\n"
    )
    respond = default_responder(check_env_out=leak, check_env_code=1)
    code, out, runner = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "staging", "--skip-images", "--env-dir", str(secrets)],
        respond,
    )
    assert code == 1
    assert SECRET not in out
    assert DB_PASSWORD not in out
    assert "[redacted]" in out
    # public and config values stay readable
    assert "staging" in out
    for call in runner.calls:
        assert SECRET not in " ".join(call.argv)


def test_redactor_covers_urls_and_their_passwords() -> None:
    redact = dp.Redactor()
    redact.add_url(f"postgresql://u:{DB_PASSWORD}@h/db")
    assert DB_PASSWORD not in redact(f"password {DB_PASSWORD} in a message")
    redact.add("short")  # below MIN_LEN: never blanks common words
    assert redact("short") == "short"


def test_db_url_file_accepts_a_bare_url_or_a_dotenv_line(tmp_path: Path) -> None:
    bare = tmp_path / "bare"
    bare.write_text(f"postgresql://u:{DB_PASSWORD}@h/db\n", encoding="utf-8")
    dotenv = tmp_path / "dotenv"
    dotenv.write_text(f"# x\nSUPABASE_DB_URL='postgresql://u:{DB_PASSWORD}@h/db'\n", "utf-8")
    for path in (bare, dotenv):
        args = dp.parse_args(["--ref", "x", "--env", "staging", "--db-url-file", str(path)])
        assert dp.read_db_url(args) == f"postgresql://u:{DB_PASSWORD}@h/db"


def test_relative_path_flags_become_absolute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secrets = env_dir(tmp_path)
    monkeypatch.chdir(tmp_path)
    args = dp.parse_args(
        ["--ref", "x", "--env", "staging", "--env-dir", "secrets", "--db-url-file", "u.txt",
         "--work-dir", "work"]
    )  # fmt: skip
    assert args.env_dir == secrets.resolve()
    assert args.db_url_file == (tmp_path / "u.txt").resolve()
    assert args.work_dir == (tmp_path / "work").resolve()
    # the checker (cwd = temporary worktree) receives absolute file paths
    (tmp_path / "work").mkdir()
    runner = FakeRunner(default_responder())
    args = dp.parse_args(["--ref", "develop", "--env", "staging", "--skip-images",
                          "--env-dir", "secrets", "--work-dir", "work"])  # fmt: skip
    dp.run(args, runner, lambda _text: None)
    check = next(call.argv for call in runner.calls if call.argv[0] == sys.executable)
    assert f"api={secrets.resolve() / 'api.env'}" in check


def test_env_step_skips_without_the_directory(tmp_path: Path) -> None:
    code, out, runner = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "staging", "--skip-images", "--env-dir", str(tmp_path / "x")],
    )
    assert code == 0
    assert re.search(r"- env\s+skip\s+not checked", out)
    assert not any(call.argv[0] == sys.executable for call in runner.calls)


def test_env_check_prefers_check_files_and_runs_the_checker_at_the_sha(tmp_path: Path) -> None:
    secrets = env_dir(tmp_path)
    (secrets / "api.check.env").write_text("APP_ENV=preview\n", encoding="utf-8")
    (secrets / "smoke.env").write_text("SMOKE_TARGET=staging\n", encoding="utf-8")
    _, _, runner = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "staging", "--skip-images", "--env-dir", str(secrets)],
    )
    checks = [call.argv for call in runner.calls if call.argv[0] == sys.executable]
    assert len(checks) == 2  # deployed services, then the advisory ops files
    assert checks[0][1].endswith("src/scripts/check_env.py")
    assert f"api={secrets / 'api.check.env'}" in checks[0]
    assert not any(arg.startswith("smoke=") for arg in checks[0])
    assert f"smoke={secrets / 'smoke.env'}" in checks[1]


# --- images ---------------------------------------------------------------------------------------


def test_disk_guard_stops_the_builds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dp.shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(1, 1, dp.GIB))
    code, out, runner = run_prepare(
        tmp_path, ["--ref", "develop", "--env", "staging", "--env-dir", str(env_dir(tmp_path))]
    )
    assert code == 1
    assert "1.0 GiB free" in out
    assert "--skip-images" in out
    assert not any(call.argv[0] in ("make", "docker") for call in runner.calls)


def test_images_are_tagged_with_the_short_sha_and_web_gets_public_args_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        dp.shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(1, 1, 100 * dp.GIB)
    )
    code, out, runner = run_prepare(
        tmp_path, ["--ref", "develop", "--env", "staging", "--env-dir", str(env_dir(tmp_path))]
    )
    assert code == 0, out
    builds = [call.argv for call in runner.calls if call.argv[0] == "make"]
    assert [b[3] for b in builds] == ["image-api", "image-worker", "image-web"]
    assert all(f"IMAGE_TAG={SHA[:12]}" in b for b in builds)
    web_args = next(arg for arg in builds[2] if arg.startswith("WEB_ARGS="))
    assert "NEXT_PUBLIC_API_BASE_URL=https://api.example" in web_args
    assert "APP_ENV" not in web_args
    assert SECRET not in web_args


def test_only_and_missing_web_values(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        dp.shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(1, 1, 100 * dp.GIB)
    )
    code, out, runner = run_prepare(
        tmp_path, ["--ref", "develop", "--env", "staging", "--only", "web", "--env-dir", "/nope"]
    )
    assert code == 1
    assert "no NEXT_PUBLIC_* values" in out
    assert not any(call.argv[0] == "make" for call in runner.calls)
    with pytest.raises(SystemExit):
        dp.parse_args(["--ref", "x", "--env", "staging", "--only", "db"])


def test_a_failed_build_fails_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        dp.shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(1, 1, 100 * dp.GIB)
    )
    code, out, _ = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "staging", "--only", "api", "--env-dir", "/nope"],
        default_responder(build_code=2),
    )
    assert code == 1
    assert "docker build exited 2" in out


# --- summary, exit codes, read-only ---------------------------------------------------------------


def test_green_run_prints_the_dispatch_command_and_exits_zero(tmp_path: Path) -> None:
    code, out, runner = run_prepare(
        tmp_path, ["--ref", "develop", "--env", "staging", "--skip-images", "--env-dir", "/nope"]
    )
    assert code == 0, out
    assert "Result: ready" in out
    assert (
        "gh workflow run deploy.yml --repo owner/repo --ref develop -f environment=staging" in out
    )
    assert not any(call.argv[:3] == ["gh", "workflow", "run"] for call in runner.calls)
    # the temporary worktree is removed and its directory is gone
    assert any(call.argv[:3] == ["git", "worktree", "remove"] for call in runner.calls)
    assert list((tmp_path / "work").iterdir()) == []


def test_keep_leaves_the_worktree(tmp_path: Path) -> None:
    _, out, runner = run_prepare(
        tmp_path,
        ["--ref", "develop", "--env", "staging", "--skip-images", "--env-dir", "/nope", "--keep"],
    )
    assert "kept worktree" in out
    assert not any(call.argv[:3] == ["git", "worktree", "remove"] for call in runner.calls)


def test_summary_and_exit_code() -> None:
    report = dp.Report()
    report.add(dp.Step("ref", dp.OK, "x"))
    report.add(dp.Step("env", dp.SKIP, "not checked"))
    report.add(dp.Step("migrations", dp.WARN, "1 warning"))
    assert dp.exit_code(report) == 0
    assert "Result: ready" in dp.render_summary(report)
    report.add(dp.Step("ci", dp.FAIL, "red"))
    assert dp.exit_code(report) == 1
    summary = dp.render_summary(report)
    assert "✗ ci" in summary
    assert "NOT READY" in summary


@pytest.mark.parametrize(
    "argv",
    [
        ["git", "push", "origin", "develop"],
        ["git", "fetch", "origin", "--", "push"],
        ["git", "worktree", "prune"],
        ["git", "remote", "set-url", "origin", "x"],
        ["git", "commit", "-m", "x"],
        ["gh", "workflow", "run", "deploy.yml"],
        ["gh", "api", "-X", "POST", "repos/o/r/deployments"],
        ["gh", "api", "repos/o/r/dispatches", "-f", "event_type=x"],
        ["gh", "api", "--method=DELETE", "repos/o/r"],
        ["gh", "variable", "set", "X"],
        ["docker", "push", "quiz-api:x"],
        ["docker", "build", "."],
        ["make", "-C", "/work", "deploy-prepare"],
        ["make", "image-api"],
        ["curl", "https://example"],
        ["vercel", "deploy"],
    ],
)
def test_read_only_guard_refuses_mutations(argv: list[str]) -> None:
    with pytest.raises(dp.ReadOnlyViolationError):
        dp.assert_read_only(argv)


@pytest.mark.parametrize(
    "argv",
    [
        ["git", "fetch", "--quiet", "--prune", "origin"],
        ["git", "worktree", "add", "--detach", "/work/src", SHA],
        ["gh", "api", "repos/o/r/deployments?environment=staging&per_page=20"],
        ["gh", "run", "view", "1", "--repo", "o/r", "--json", "jobs"],
        ["make", "-C", "/work/src", "image-web", "IMAGE_TAG=abc", "WEB_ARGS=--build-arg A=b"],
        ["docker", "info", "--format", "{{.ServerVersion}}"],
    ],
)
def test_read_only_guard_admits_what_the_script_uses(argv: list[str]) -> None:
    dp.assert_read_only(argv)
