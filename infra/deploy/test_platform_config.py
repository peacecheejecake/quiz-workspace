"""Platform config as code (M7.4a): offline invariants of the Vercel, Railway and Supabase deltas.

No platform offers an offline validator for these files, so this test pins what the docs require
(docs/deployment.md §1, §6, §6.1, §7; implementation-plan §7 M7.3) against the files that ship.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
RAILWAY = ROOT / "infra/deploy/railway-services.toml"
VERCEL = ROOT / "apps/web/vercel.json"
SUPABASE = ROOT / "supabase/config.toml"
OPENAPI = ROOT / "contracts/openapi.json"

SERVE_MODULES = {"api": "quiz_api.serve", "worker": "quiz_worker.serve"}
ENV_REF = re.compile(r"^env\([A-Z][A-Z0-9_]*\)$")


def _railway() -> dict[str, Any]:
    return tomllib.loads(RAILWAY.read_text(encoding="utf-8"))


def _final_stage(dockerfile: Path) -> list[str]:
    lines = dockerfile.read_text(encoding="utf-8").splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith("FROM ")]
    return lines[starts[-1] :]


def _instruction(stage: list[str], name: str) -> list[str]:
    return [line[len(name) + 1 :].strip() for line in stage if line.startswith(f"{name} ")]


@pytest.mark.parametrize("service", ["api", "worker"])
def test_railway_service_runs_its_non_root_image_via_the_serve_module(service: str) -> None:
    spec = _railway()["services"][service]
    dockerfile = ROOT / spec["dockerfile"]
    stage = _final_stage(dockerfile)

    users = _instruction(stage, "USER")
    assert users, f"{dockerfile} final stage sets no USER"
    assert users[-1].split(":")[0] not in {"root", "0"}

    # "" keeps the image CMD; anything else would bypass the redacting launcher.
    assert spec["start_command"] == ""
    cmd = _instruction(stage, "CMD")[-1]
    assert f"python -m {SERVE_MODULES[service]}" in " ".join(json.loads(cmd))
    assert "uvicorn" not in cmd
    assert "celery" not in cmd


@pytest.mark.parametrize("service", ["api", "worker"])
def test_hf_home_volume_matches_the_image(service: str) -> None:
    spec = _railway()["services"][service]
    stage = _final_stage(ROOT / spec["dockerfile"])
    assert re.search(rf"\bHF_HOME={re.escape(spec['volume_mount_path'])}\b", "\n".join(stage))
    assert f'VOLUME ["{spec["volume_mount_path"]}"]' in stage


def test_api_healthcheck_paths_exist_in_the_app() -> None:
    paths = json.loads(OPENAPI.read_text(encoding="utf-8"))["paths"]
    api = _railway()["services"]["api"]
    assert api["healthcheck_path"] == "/health/ready"
    assert "get" in paths[api["healthcheck_path"]]
    assert 0 < api["healthcheck_timeout_seconds"] <= 300
    # The image's own HEALTHCHECK (liveness) also targets a real route.
    stage = _final_stage(ROOT / api["dockerfile"])
    assert "/health/live" in " ".join(_instruction(stage, "HEALTHCHECK") + stage)
    assert "get" in paths["/health/live"]


def test_worker_is_private_single_replica_and_always_restarted() -> None:
    worker = _railway()["services"]["worker"]
    assert worker["public_domain"] is False
    assert worker["healthcheck_path"] == ""
    assert worker["restart_policy"] == "ALWAYS"
    assert worker["replicas"] == 1


def test_railway_images_come_from_the_registry_by_name_only() -> None:
    config = _railway()
    assert config["registry"]["host"] == "ghcr.io"
    for spec in config["services"].values():
        # Bare names: the workflow appends owner and the pushed digest, never a mutable tag.
        assert re.fullmatch(r"quiz-[a-z]+", spec["image"])
        assert spec["restart_policy"] in {"ON_FAILURE", "ALWAYS", "NEVER"}


def test_vercel_deploys_only_through_the_workflow_and_holds_no_values() -> None:
    config = json.loads(VERCEL.read_text(encoding="utf-8"))
    assert config["framework"] == "nextjs"
    # Pushes never deploy: migrations must run first (docs/deployment.md §5 order).
    assert config["git"]["deploymentEnabled"] is False
    # Environment values live in the Vercel project / GitHub Environment, never in the repo.
    assert not {"env", "build"} & config.keys()
    assert "--frozen-lockfile" in config["installCommand"]
    assert "@quiz/web" in config["buildCommand"]


def test_web_image_build_arguments_are_public_only() -> None:
    stage_text = (ROOT / "apps/web/Dockerfile").read_text(encoding="utf-8")
    args = re.findall(r"^ARG ([A-Z_]+)", stage_text, flags=re.MULTILINE)
    build_args = [a for a in args if a != "NODE_IMAGE"]
    assert build_args
    assert all(a.startswith("NEXT_PUBLIC_") for a in build_args)


def _remotes() -> dict[str, Any]:
    return tomllib.loads(SUPABASE.read_text(encoding="utf-8"))["remotes"]


@pytest.mark.parametrize("name", ["staging", "production"])
def test_supabase_remote_auth_deltas(name: str) -> None:
    config = tomllib.loads(SUPABASE.read_text(encoding="utf-8"))
    remote = config["remotes"][name]
    assert re.fullmatch(r"[a-z]{20}", remote["project_id"])
    assert remote["db"]["seed"]["enabled"] is False

    auth = remote["auth"]
    assert ENV_REF.match(auth["site_url"])
    redirects = auth["additional_redirect_urls"]
    assert len(redirects) == 1
    assert ENV_REF.match(redirects[0])
    assert "*" not in json.dumps(auth)

    smtp = auth["email"]["smtp"]
    assert smtp["enabled"] is True
    for key in ("host", "user", "pass", "admin_email"):
        assert ENV_REF.match(smtp[key]), f"remotes.{name}.auth.email.smtp.{key} must be env(...)"

    # Inherited from [auth]: confirmations on, short-lived access tokens, rotation on.
    assert config["auth"]["email"]["enable_confirmations"] is True
    assert config["auth"]["jwt_expiry"] <= 3600
    assert config["auth"]["enable_refresh_token_rotation"] is True
    assert "jwt_expiry" not in auth


def test_supabase_remotes_target_distinct_projects() -> None:
    remotes = _remotes()
    assert set(remotes) == {"staging", "production"}
    assert remotes["staging"]["project_id"] != remotes["production"]["project_id"]


def test_supabase_local_auth_is_untouched() -> None:
    auth = tomllib.loads(SUPABASE.read_text(encoding="utf-8"))["auth"]
    assert auth["site_url"] == "http://127.0.0.1:3000"
    assert auth["additional_redirect_urls"] == ["http://127.0.0.1:3000/auth/callback"]
    assert "smtp" not in auth["email"]
