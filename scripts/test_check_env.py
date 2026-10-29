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
    "http_url": "http://api:8000",
    "origin_list": "https://quiz.example",
    "postgres_url": "postgresql://quiz_api.ref:pw@aws-0-x.pooler.supabase.com:5432/postgres",
    "redis_url": "redis://default:pw@redis.railway.internal:6379",
    "min12": SECRET_MARK,
    "password": SECRET_MARK,
    "min32": SECRET_MARK,
    "nonempty": SECRET_MARK,
    "number": "5",
    "bool": "false",
    "not_fake": "auto",
    "log_level": "INFO",
    "header_name": "x-real-ip",
    "collection_prefix": "prod_",
    "publishable_key": "sb_publishable_example",
    "secret_key": "sb_secret_" + SECRET_MARK,
    "email": "smoke-a@quiz.example",
    "hostname": "smtp.example.org",
    "uuid": "123e4567-e89b-12d3-a456-426614174000",
    "semver": "1.2.3",
    "smoke_target": "staging",
    "auth_callback": "https://quiz.example/auth/callback",
    "turnstile_site_key": "0x4AAAAAAAexampleSiteKey0",
    "turnstile_secret": "0x" + SECRET_MARK,
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
        "WORKER_CHAPTER_NOTE_SCENARIO_FILE",
        "WORKER_CHAPTER_NOTE_HOLD_DIR",
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


def test_docsum_b_document_summaries_need_the_llm_on_worker_and_api() -> None:
    worker = valid_env("worker", "production")
    api = valid_env("api", "production")
    for env in (worker, api):
        env["WORKER_DOCUMENT_SUMMARY"] = "true"
    report = check_env.run_checks(MANIFEST, "production", {"worker": worker, "api": api})
    assert "worker LLM_API_KEY: missing (required when WORKER_DOCUMENT_SUMMARY=true)" in (
        report.errors
    )
    assert "api LLM_MODEL: missing (required when WORKER_DOCUMENT_SUMMARY=true)" in report.errors
    worker |= {"LLM_API_KEY": SECRET_MARK, "LLM_MODEL": "model-a"}
    api["LLM_MODEL"] = "model-b"
    report = check_env.run_checks(MANIFEST, "production", {"worker": worker, "api": api})
    assert report.errors == ["LLM_MODEL: differs between api and worker (must be identical)"]
    assert "LLM_API_KEY" not in {v.name for v in MANIFEST.for_service("api")}


def test_production_needs_its_own_qdrant_prefix_on_the_shared_cluster() -> None:
    # Staging uses the unprefixed namespace of the shared cluster (user decision 2026-10-19), so a
    # production deployment without a prefix would read and write staging's collections.
    for service in ("api", "worker"):
        production = valid_env(service, "production")
        assert production["QDRANT_COLLECTION_PREFIX"] == "prod_"
        del production["QDRANT_COLLECTION_PREFIX"]
        errors = check_env.run_checks(MANIFEST, "production", {service: production}).errors
        assert errors == [f"{service} QDRANT_COLLECTION_PREFIX: missing (required in production)"]
        production["QDRANT_COLLECTION_PREFIX"] = ""
        errors = check_env.run_checks(MANIFEST, "production", {service: production}).errors
        assert errors == [f"{service} QDRANT_COLLECTION_PREFIX: missing (required in production)"]

        staging = valid_env(service, "staging")
        assert "QDRANT_COLLECTION_PREFIX" not in staging
        assert check_env.run_checks(MANIFEST, "staging", {service: staging}).errors == []


def test_production_env_matches_the_deploy_decisions() -> None:
    api = valid_env("api", "production")
    assert api["APP_ENV"] == "production"
    api["APP_ENV"] = "preview"
    errors = check_env.run_checks(MANIFEST, "production", {"api": api}).errors
    assert errors == ["api APP_ENV: must be production in production"]
    deploy = {v.name for v in MANIFEST.for_service("deploy") if "production" in v.required}
    assert "PRODUCTION_DEPLOY_ENABLED" in deploy
    # Production smoke is @readonly: no smoke account is required there.
    smoke = {v.name for v in MANIFEST.for_service("smoke") if "production" in v.required}
    assert not {n for n in smoke if n.startswith("SMOKE_USER_")}


def test_keys_are_not_swapped() -> None:
    web = valid_env("web", "staging")
    web["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] = "sb_secret_" + SECRET_MARK
    report = check_env.run_checks(MANIFEST, "staging", {"web": web})
    assert report.errors == [
        "web NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: is a SECRET key; use the publishable key "
        "(sb_publishable_…)"
    ]


def test_masked_secret_key_is_an_error_without_the_value() -> None:
    api = valid_env("api", "staging")
    api["SUPABASE_SECRET_KEY"] = "sb_secret_ab12" + "•" * 27
    report = check_env.run_checks(MANIFEST, "staging", {"api": api})
    assert report.errors == [
        "api SUPABASE_SECRET_KEY: contains non-ASCII characters (a masked or mis-copied value?)"
    ]
    assert "ab12" not in "".join(report.errors)


def test_unicode_password_passes_the_smoke_password_rule() -> None:
    smoke = valid_env("smoke", "staging")
    smoke["SMOKE_USER_A_PASSWORD"] = "비밀번호-Pässwörd-🔑-2026"  # noqa: S105 - synthetic
    smoke["SMOKE_USER_B_PASSWORD"] = "パスワード" + SECRET_MARK
    report = check_env.run_checks(MANIFEST, "staging", {"smoke": smoke})
    assert report.errors == []


@pytest.mark.parametrize("control", ["\x00", "\n", "\x1b", "\u200b"])
def test_control_character_in_a_password_is_an_error_without_the_value(control: str) -> None:
    smoke = valid_env("smoke", "staging")
    smoke["SMOKE_USER_A_PASSWORD"] = SECRET_MARK + control + "비밀번호"
    report = check_env.run_checks(MANIFEST, "staging", {"smoke": smoke})
    assert report.errors == [
        "smoke SMOKE_USER_A_PASSWORD: contains control characters (a mis-copied value?)"
    ]
    assert SECRET_MARK not in "".join(report.errors)


def test_auth_callback_must_follow_the_site_url() -> None:
    env = valid_env("supabase-config", "production")
    env["SUPABASE_AUTH_REDIRECT_URL"] = "https://evil.example/auth/callback"
    report = check_env.run_checks(MANIFEST, "production", {"supabase-config": env})
    assert report.errors == [
        "supabase-config SUPABASE_AUTH_REDIRECT_URL: must be exactly "
        "<SUPABASE_AUTH_SITE_URL>/auth/callback"
    ]


TEST_SITE_KEY = "1x00000000000000000000AA"
TEST_SECRET = "1x0000000000000000000000000000000AA"  # noqa: S105 - Cloudflare's public test key


def _captcha_sources(environment: str, site: str, secret: str) -> dict[str, dict[str, str]]:
    web = valid_env("web", environment) | {"NEXT_PUBLIC_TURNSTILE_SITE_KEY": site}
    config = valid_env("supabase-config", environment) | {"SUPABASE_AUTH_CAPTCHA_SECRET": secret}
    return {"web": web, "supabase-config": config}


def test_captcha_keys_are_required_and_paired() -> None:
    # docs/auth.md 5.1: CAPTCHA is on in every deployment; the web sitekey and the Supabase
    # secret come from the same widget (or are both Cloudflare's always-passes test keys).
    required = {v.name for v in MANIFEST.vars if v.required == MANIFEST.environments}
    assert {"NEXT_PUBLIC_TURNSTILE_SITE_KEY", "SUPABASE_AUTH_CAPTCHA_SECRET"} <= required
    (secret,) = [v for v in MANIFEST.vars if v.name == "SUPABASE_AUTH_CAPTCHA_SECRET"]
    assert secret.kind == "secret"
    assert secret.services == ("supabase-config",)

    staging = check_env.run_checks(
        MANIFEST, "staging", _captcha_sources("staging", TEST_SITE_KEY, TEST_SECRET)
    )
    assert staging.errors == []

    mixed = check_env.run_checks(
        MANIFEST, "staging", _captcha_sources("staging", TEST_SITE_KEY, "0x" + SECRET_MARK)
    )
    assert len(mixed.errors) == 1
    assert "one is a Cloudflare test key and the other is not" in mixed.errors[0]
    assert SECRET_MARK not in "".join(mixed.errors)


def test_production_refuses_turnstile_test_keys() -> None:
    report = check_env.run_checks(
        MANIFEST, "production", _captcha_sources("production", TEST_SITE_KEY, TEST_SECRET)
    )
    assert report.errors == [
        "web NEXT_PUBLIC_TURNSTILE_SITE_KEY: Cloudflare Turnstile test keys are not allowed in "
        "production",
        "supabase-config SUPABASE_AUTH_CAPTCHA_SECRET: Cloudflare Turnstile test keys are not "
        "allowed in production",
    ]


def test_never_passing_or_malformed_turnstile_keys_are_errors() -> None:
    report = check_env.run_checks(
        MANIFEST,
        "staging",
        _captcha_sources("staging", "2x00000000000000000000AB", "not-a-" + SECRET_MARK),
    )
    assert report.errors == [
        "web NEXT_PUBLIC_TURNSTILE_SITE_KEY: is a Cloudflare test key that never passes; use a "
        "real key or the 1x test key",
        "supabase-config SUPABASE_AUTH_CAPTCHA_SECRET: must be a Cloudflare Turnstile secret key "
        "(0x…)",
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
    assert (
        "api DATABASE_URL: could not be parsed" in text
        or "api DATABASE_URL: contains non-ASCII" in text
    )
    assert "sensitive-password" not in text
    assert "quiz_api:" not in text


# --- M7.4b: Cloudflare Workers AI embedder --------------------------------------------------------


def test_workers_ai_credentials_are_required_only_in_workers_ai_mode() -> None:
    for service in ("api", "worker"):
        env = valid_env(service, "staging")
        env["WORKER_EMBEDDER"] = "workers_ai"
        report = check_env.run_checks(MANIFEST, "staging", {service: env})
        assert (
            f"{service} CLOUDFLARE_ACCOUNT_ID: missing (required when WORKER_EMBEDDER=workers_ai)"
            in report.errors
        )
        assert (
            f"{service} CLOUDFLARE_API_TOKEN: missing (required when WORKER_EMBEDDER=workers_ai)"
            in report.errors
        )
        env["CLOUDFLARE_ACCOUNT_ID"] = "0123456789abcdef0123456789abcdef"
        env["CLOUDFLARE_API_TOKEN"] = SECRET_MARK
        assert check_env.run_checks(MANIFEST, "staging", {service: env}).errors == []
        env["WORKER_EMBEDDER"] = "auto"
        del env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"]
        assert check_env.run_checks(MANIFEST, "staging", {service: env}).errors == []


def test_workers_ai_token_is_a_server_secret_never_on_web() -> None:
    (token,) = [v for v in MANIFEST.vars if v.name == "CLOUDFLARE_API_TOKEN"]
    assert token.kind == "secret"
    assert set(token.services) == {"api", "worker"}
    assert token.same
    web = valid_env("web", "staging")
    web["CLOUDFLARE_API_TOKEN"] = SECRET_MARK
    web["CLOUDFLARE_ACCOUNT_ID"] = "0123456789abcdef0123456789abcdef"
    report = check_env.run_checks(MANIFEST, "staging", {"web": web})
    assert "web CLOUDFLARE_API_TOKEN: must not be set on web (server-only)" in report.errors
    assert "web CLOUDFLARE_ACCOUNT_ID: must not be set on web (server-only)" in report.errors
    assert all(SECRET_MARK not in line for line in report.errors + report.warnings)


def test_embedder_mode_values_are_checked() -> None:
    env = valid_env("api", "production")
    for value, ok in (("auto", True), ("qwen3", True), ("workers_ai", None), ("fake", False)):
        env["WORKER_EMBEDDER"] = value
        errors = check_env.run_checks(MANIFEST, "production", {"api": env}).errors
        if ok is None:  # valid mode; only its credentials are missing
            assert all(not e.startswith("api WORKER_EMBEDDER") for e in errors)
        else:
            assert any(e.startswith("api WORKER_EMBEDDER") for e in errors) is not ok
    env["WORKER_EMBEDDER"] = "workers-ai"
    errors = check_env.run_checks(MANIFEST, "production", {"api": env}).errors
    assert "api WORKER_EMBEDDER: must be auto, qwen3 or workers_ai" in errors


def test_internal_api_url_is_optional_and_checked_without_echoing_values() -> None:
    """PERF-1: API_INTERNAL_BASE_URL (web, server-only) may be http on a private network."""
    var = next(v for v in MANIFEST.vars if v.name == "API_INTERNAL_BASE_URL")
    assert list(var.services) == ["web"]
    assert var.kind == "config"
    assert not var.name.startswith("NEXT_PUBLIC_")
    env = valid_env("web", "staging")
    env.pop("API_INTERNAL_BASE_URL", None)
    assert check_env.run_checks(MANIFEST, "staging", {"web": env}).errors == []
    for good in ("http://api:8000", "https://api.internal.example/base"):
        env["API_INTERNAL_BASE_URL"] = good
        assert check_env.run_checks(MANIFEST, "staging", {"web": env}).errors == []
    for bad in (
        "api:8000",
        "ftp://api.example",
        f"http://user:{SECRET_MARK}@api:8000",
        f"http://api:8000/?k={SECRET_MARK}",
    ):
        env["API_INTERNAL_BASE_URL"] = bad
        errors = check_env.run_checks(MANIFEST, "staging", {"web": env}).errors
        assert errors, bad
        assert all("API_INTERNAL_BASE_URL" in e for e in errors)
        assert not any(SECRET_MARK in e for e in errors)
