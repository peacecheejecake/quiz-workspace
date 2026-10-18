"""Environment manifest + scripts/check_env.py (M7.4a).

The manifest must name every variable the code reads (API/worker settings, the LLM config, the
web server) and everything .env.example documents; the checker validates values without ever
printing them.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest
from pydantic import AliasChoices
from quiz_api.settings import Settings
from quiz_worker.settings import WorkerSettings

ROOT = Path(__file__).resolve().parents[1]


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "check_env", Path(__file__).with_name("check_env.py")
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_env"] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


check_env = _load()
MANIFEST = check_env.load_manifest()

SECRET_MARK = "s3cr3t-value-that-must-never-be-printed-0123456789"  # noqa: S105

SAMPLES = {
    "https_url": "https://abcdefghijklmnopqrst.supabase.co",
    "https_origin": "https://quiz.example",
    "origin_list": "https://quiz.example",
    "postgres_url": "postgresql://quiz_api.ref:pw@aws-0-x.pooler.supabase.com:5432/postgres",
    "redis_url": "redis://default:pw@redis.railway.internal:6379",
    "min12": SECRET_MARK,
    "min32": SECRET_MARK,
    "nonempty": SECRET_MARK,
    "number": "5",
    "bool": "false",
    "not_fake": "auto",
    "log_level": "INFO",
    "header_name": "x-real-ip",
    "collection_prefix": "",
    "publishable_key": "sb_publishable_example",
    "secret_key": "sb_secret_" + SECRET_MARK,
    "email": "smoke-a@quiz.example",
    "hostname": "smtp.example.org",
    "uuid": "123e4567-e89b-12d3-a456-426614174000",
    "semver": "1.2.3",
    "smoke_target": "staging",
    "auth_callback": "https://quiz.example/auth/callback",
}


def valid_env(service: str, environment: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for var in MANIFEST.for_service(service):
        if environment not in var.required:
            continue
        if var.check == "app_env":
            env[var.name] = MANIFEST.app_env[environment]
        else:
            env[var.name] = SAMPLES.get(var.check or "nonempty", "value")
    if service == "supabase-config":
        env["SUPABASE_AUTH_SITE_URL"] = "https://quiz.example"
    return env


def names(service: str) -> set[str]:
    return {v.name for v in MANIFEST.for_service(service)}


# --- the manifest is complete ---------------------------------------------------------------------


def _aliases(model: type[Settings] | type[WorkerSettings]) -> list[tuple[str, ...]]:
    out: list[tuple[str, ...]] = []
    for info in model.model_fields.values():
        alias = info.validation_alias
        if isinstance(alias, str):
            out.append((alias,))
        elif isinstance(alias, AliasChoices):
            out.append(tuple(str(c) for c in alias.choices))
    return out


@pytest.mark.parametrize(("service", "model"), [("api", Settings), ("worker", WorkerSettings)])
def test_every_settings_variable_is_in_the_manifest(service: str, model: type) -> None:
    listed = names(service)
    missing = [group for group in _aliases(model) if not set(group) & listed]
    assert not missing, f"{service}: not in env-manifest.toml: {missing}"


def test_every_llm_variable_is_in_the_manifest() -> None:
    source = (ROOT / "packages/core/src/book_core/llm/config.py").read_text(encoding="utf-8")
    llm = set(re.findall(r'"(LLM_[A-Z_]+)"', source))
    assert {"LLM_API_KEY", "LLM_MODEL"} <= llm
    assert llm <= names("worker")


def test_every_web_server_variable_is_in_the_manifest() -> None:
    found: set[str] = set()
    for path in (ROOT / "apps/web/src").rglob("*.ts*"):
        if ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        found |= set(re.findall(r"\benv\.([A-Z][A-Z0-9_]+)", text))
        found |= set(re.findall(r"\benv\[['\"]([A-Z][A-Z0-9_]+)['\"]\]", text))
        found |= set(re.findall(r"_ENV = ['\"]([A-Z][A-Z0-9_]+)['\"]", text))
    found -= {"NODE_ENV", "NEXT_PUBLIC_X"}  # framework / doc comment
    assert {"AUTH_RECOVERY_MARKER_SECRET", "RELAY_CLIENT_SECRET", "APP_ENV"} <= found
    assert found <= names("web"), sorted(found - names("web"))


def test_every_env_example_variable_is_in_the_manifest() -> None:
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    documented = set(re.findall(r"^#?\s?([A-Z][A-Z0-9_]+)=", text, flags=re.MULTILINE))
    documented = {n for n in documented if not n.startswith("E2E_")}  # local test harness
    listed = {v.name for v in MANIFEST.vars}
    assert documented
    assert documented <= listed, sorted(documented - listed)


def test_public_and_secret_kinds_are_consistent() -> None:
    for var in MANIFEST.vars:
        if var.name.startswith("NEXT_PUBLIC_"):
            assert var.kind == "public", var.name
            assert var.services == ("web",), var.name
        if var.kind == "secret":
            assert not var.name.startswith("NEXT_PUBLIC_"), var.name
    web_secrets = {v.name for v in MANIFEST.for_service("web") if v.kind == "secret"}
    # docs/deployment.md §6: the only web server secrets; Storage/DB keys never reach Vercel.
    assert web_secrets == {"AUTH_RECOVERY_MARKER_SECRET", "RELAY_CLIENT_SECRET"}
    assert not {"SUPABASE_SECRET_KEY", "DATABASE_URL", "QDRANT_API_KEY"} & names("web")


def test_deployment_doc_secrets_are_server_only() -> None:
    for name in (
        "DATABASE_URL",
        "SUPABASE_SECRET_KEY",
        "QDRANT_API_KEY",
        "REDIS_URL",
        "LLM_API_KEY",
        "AUTH_RECOVERY_MARKER_SECRET",
        "SHARE_SESSION_SECRET",
        "RELAY_CLIENT_SECRET",
    ):
        (var,) = [v for v in MANIFEST.vars if v.name == name]
        assert var.kind == "secret", name


def test_guarded_variables_are_required() -> None:
    # Values whose absence the services turn into a startup refusal or a 503 in deployments.
    required = {v.name for v in MANIFEST.vars if v.required == MANIFEST.environments}
    assert {
        "SUPABASE_JWT_ISSUER",
        "SUPABASE_JWKS_URL",
        "CORS_ALLOWED_ORIGINS",
        "SHARE_SESSION_SECRET",
        "RELAY_CLIENT_SECRET",
        "AUTH_RECOVERY_MARKER_SECRET",
        "WORKER_DATABASE_URL",
        "DATABASE_URL",
    } <= required


def test_test_only_switches_are_forbidden() -> None:
    forbidden = {v.name for v in MANIFEST.vars if v.forbidden}
    assert {
        "WORKER_TASK_ALWAYS_EAGER",
        "WORKER_JOB_STORE_PATH",
        "WORKER_FIXTURE_PDF_DIR",
        "WORKER_LLM_SCENARIO_FILE",
        "FORWARDED_ALLOW_IPS",
        "RAILWAY_RUN_UID",
    } <= forbidden


# --- the checker ----------------------------------------------------------------------------------


@pytest.mark.parametrize("environment", ["staging", "production"])
@pytest.mark.parametrize("service", sorted(MANIFEST.services))
def test_a_complete_env_passes(service: str, environment: str) -> None:
    report = check_env.run_checks(MANIFEST, environment, {service: valid_env(service, environment)})
    assert report.errors == []


def test_missing_and_invalid_values_are_errors_without_values(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    env = valid_env("api", "staging")
    del env["SHARE_SESSION_SECRET"]
    env["CORS_ALLOWED_ORIGINS"] = "https://*.quiz.example," + SECRET_MARK
    env["SUPABASE_JWKS_URL"] = "http://" + SECRET_MARK + ".example/jwks"
    env["RELAY_CLIENT_SECRET"] = "short-" + SECRET_MARK[:10]
    env["APP_ENV"] = "production"
    env["WORKER_TASK_ALWAYS_EAGER"] = "true"
    env["NEXT_PUBLIC_DATABASE_URL"] = SECRET_MARK
    path = tmp_path / "api.env"
    path.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")

    status = check_env.main(["--env", "staging", "--check", f"api={path}"])
    out = capsys.readouterr()
    assert status == 1
    text = out.out + out.err
    assert "SHARE_SESSION_SECRET: missing (required in staging)" in text
    assert "CORS_ALLOWED_ORIGINS: every entry must be" in text
    assert "SUPABASE_JWKS_URL: must be an https:// URL" in text
    assert "RELAY_CLIENT_SECRET: must have at least 32 characters" in text
    assert "APP_ENV: must be preview in staging" in text
    assert "WORKER_TASK_ALWAYS_EAGER: must not be set in staging" in text
    assert "NEXT_PUBLIC_DATABASE_URL: NEXT_PUBLIC_ variable not in the manifest" in text
    assert SECRET_MARK not in text
    assert SECRET_MARK[:10] not in text


def test_shared_values_must_match_across_services() -> None:
    web = valid_env("web", "production")
    api = valid_env("api", "production")
    api["RELAY_CLIENT_SECRET"] = "x" * 40
    report = check_env.run_checks(MANIFEST, "production", {"web": web, "api": api})
    assert report.errors == ["RELAY_CLIENT_SECRET: differs between api and web (must be identical)"]


def test_conditional_requirement_and_fake_adapters() -> None:
    env = valid_env("worker", "production")
    env["LLM_API_KEY"] = SECRET_MARK
    env["WORKER_PARSER"] = "fake"
    report = check_env.run_checks(MANIFEST, "production", {"worker": env})
    assert "worker LLM_MODEL: missing (required when LLM_API_KEY is set)" in report.errors
    assert "worker WORKER_PARSER: fake adapters are for local/test only" in report.errors


def test_keys_are_not_swapped() -> None:
    web = valid_env("web", "staging")
    web["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] = "sb_secret_" + SECRET_MARK
    report = check_env.run_checks(MANIFEST, "staging", {"web": web})
    assert report.errors == [
        "web NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: is a SECRET key; use the publishable key "
        "(sb_publishable_…)"
    ]


def test_auth_callback_must_follow_the_site_url() -> None:
    env = valid_env("supabase-config", "production")
    env["SUPABASE_AUTH_REDIRECT_URL"] = "https://evil.example/auth/callback"
    report = check_env.run_checks(MANIFEST, "production", {"supabase-config": env})
    assert report.errors == [
        "supabase-config SUPABASE_AUTH_REDIRECT_URL: must be exactly "
        "<SUPABASE_AUTH_SITE_URL>/auth/callback"
    ]


def test_platform_variables_are_ignored_and_unknown_ones_warn() -> None:
    env = valid_env("api", "staging") | {"RAILWAY_ENVIRONMENT": "staging", "PORT": "8080"}
    env["SOMETHING_ELSE"] = SECRET_MARK
    report = check_env.run_checks(MANIFEST, "staging", {"api": env})
    assert report.errors == []
    assert report.warnings == ["api SOMETHING_ELSE: not in the manifest (ignored by the app?)"]


def test_process_environment_source(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for key, value in valid_env("worker", "production").items():
        monkeypatch.setenv(key, value)
    assert check_env.main(["--env", "production", "--check", "worker=-"]) == 0
    assert SECRET_MARK not in capsys.readouterr().out


def test_template_round_trips(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert check_env.main(["--env", "staging", "--template", "api"]) == 0
    text = capsys.readouterr().out
    parsed = check_env.parse_dotenv(text)
    required = {v.name for v in MANIFEST.for_service("api") if "staging" in v.required}
    assert set(parsed) == required
    assert parsed["APP_ENV"] == "preview"
    assert all(parsed[n] == "" for n in required - {"APP_ENV"})
    assert "WORKER_TASK_ALWAYS_EAGER" not in text


def test_dotenv_parsing() -> None:
    parsed = check_env.parse_dotenv(
        "# comment\nexport A=1\nB='two words'\nC=\"x # y\"\n"
        "D=plain # trailing\nE= # hint\nnot a line\n"
    )
    assert parsed == {"A": "1", "B": "two words", "C": "x # y", "D": "plain", "E": ""}


def test_usage_errors_exit_2(capsys: pytest.CaptureFixture[str]) -> None:
    assert check_env.main(["--env", "staging", "--check", "nope=-"]) == 2
    assert "unknown service nope" in capsys.readouterr().err
    with pytest.raises(SystemExit) as exc:
        check_env.main(["--env", "qa", "--check", "api=-"])
    assert exc.value.code == 2


def test_listing_names_every_variable(capsys: pytest.CaptureFixture[str]) -> None:
    assert check_env.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert all(v.name in out for v in MANIFEST.vars)


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://quiz_api:sensitive-password\uff20host/db",  # fullwidth @: NFKC error
        "postgresql://quiz_api:sensitive-password@[::1/db",  # unbalanced IPv6 bracket
    ],
)
def test_malformed_credential_urls_never_reach_the_output(
    url: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    env = valid_env("api", "staging") | {"DATABASE_URL": url}
    path = tmp_path / "api.env"
    path.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
    assert check_env.main(["--env", "staging", "--check", f"api={path}"]) == 1
    out = capsys.readouterr()
    text = out.out + out.err
    assert "api DATABASE_URL: could not be parsed" in text
    assert "sensitive-password" not in text
    assert "quiz_api:" not in text
