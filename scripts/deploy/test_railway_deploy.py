"""scripts/deploy/railway_deploy.py against a mocked Railway GraphQL API (M7.4a, offline)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "railway_deploy", Path(__file__).with_name("railway_deploy.py")
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["railway_deploy"] = module
    spec.loader.exec_module(module)
    return module


rd = _load()
TOKEN = "railway-project-token-never-printed"  # noqa: S105
DIGEST = "sha256:" + "ab" * 32
API_IMAGE = f"ghcr.io/owner/quiz-api@{DIGEST}"
WORKER_IMAGE = f"ghcr.io/owner/quiz-worker@{DIGEST}"


class FakeRailway:
    def __init__(self, statuses: list[str], errors: dict[str, Any] | None = None) -> None:
        self.statuses = statuses
        self.errors = errors or {}
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url == rd.ENDPOINT
        assert request.headers["Project-Access-Token"] == TOKEN
        body = json.loads(request.content)
        self.calls.append(body)
        query = body["query"]
        for marker, error in self.errors.items():
            if marker in query:
                return httpx.Response(200, json={"errors": [{"message": error}]})
        if "serviceInstanceUpdate" in query:
            return httpx.Response(200, json={"data": {"serviceInstanceUpdate": True}})
        if "serviceInstanceDeployV2" in query:
            return httpx.Response(200, json={"data": {"serviceInstanceDeployV2": "dep-1"}})
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return httpx.Response(200, json={"data": {"deployment": {"status": status}}})


def _run(fake: FakeRailway, payload: dict[str, Any], timeout: float = 60) -> str:
    railway = rd.Railway(TOKEN, httpx.Client(transport=httpx.MockTransport(fake)))
    now = [0.0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    return str(
        rd.deploy(
            railway,
            service_id="svc",
            environment_id="env",
            payload=payload,
            timeout=timeout,
            sleep=sleep,
            clock=lambda: now[0],
            log=lambda _line: None,
        )
    )


def test_api_input_uses_the_manifest_and_the_image_cmd() -> None:
    payload = rd.instance_input("api", API_IMAGE)
    assert payload == {
        "source": {"image": API_IMAGE},
        "startCommand": None,
        "healthcheckPath": "/health/ready",
        "healthcheckTimeout": 120,
        "restartPolicyType": "ON_FAILURE",
        "restartPolicyMaxRetries": 5,
        "numReplicas": 1,
    }


def test_worker_has_no_http_healthcheck() -> None:
    payload = rd.instance_input("worker", WORKER_IMAGE)
    assert payload["healthcheckPath"] is None
    assert payload["healthcheckTimeout"] is None
    assert payload["restartPolicyType"] == "ALWAYS"


@pytest.mark.parametrize(
    "image",
    [
        "ghcr.io/owner/quiz-api:latest",
        "ghcr.io/owner/quiz-api:" + "ab" * 32,
        "docker.io/owner/quiz-api@" + DIGEST,
        WORKER_IMAGE,  # wrong image for the api service
    ],
)
def test_only_the_service_image_by_digest_is_accepted(image: str) -> None:
    with pytest.raises(rd.DeployError):
        rd.instance_input("api", image)


def test_successful_rollout_sends_update_then_deploy_then_polls() -> None:
    fake = FakeRailway(["INITIALIZING", "DEPLOYING", "SUCCESS"])
    assert _run(fake, rd.instance_input("api", API_IMAGE)) == "dep-1"
    queries = [c["query"] for c in fake.calls]
    assert "serviceInstanceUpdate" in queries[0]
    assert fake.calls[0]["variables"]["input"]["source"] == {"image": API_IMAGE}
    assert fake.calls[0]["variables"]["serviceId"] == "svc"
    assert "serviceInstanceDeployV2" in queries[1]
    assert all("deployment(id" in q for q in queries[2:])
    assert len(queries) == 5


@pytest.mark.parametrize("status", ["FAILED", "CRASHED", "REMOVED"])
def test_failed_rollout_exits_with_the_status(status: str) -> None:
    with pytest.raises(rd.DeployError, match=f"ended {status}"):
        _run(FakeRailway(["DEPLOYING", status]), rd.instance_input("api", API_IMAGE))


def test_timeout() -> None:
    with pytest.raises(rd.DeployError, match="still DEPLOYING after 30s"):
        _run(FakeRailway(["DEPLOYING"]), rd.instance_input("api", API_IMAGE), timeout=30)


def test_graphql_errors_name_the_step() -> None:
    fake = FakeRailway(["SUCCESS"], errors={"serviceInstanceUpdate": "Not Authorized"})
    with pytest.raises(rd.DeployError, match="update: HTTP 200 Not Authorized"):
        _run(fake, rd.instance_input("api", API_IMAGE))


def test_missing_environment_fails_clearly_without_values(
    capsys: pytest.CaptureFixture[str],
) -> None:
    status = rd.main(["--service", "worker", "--image", WORKER_IMAGE], env={"RAILWAY_TOKEN": TOKEN})
    err = capsys.readouterr().err
    assert status == 1
    assert "missing RAILWAY_ENVIRONMENT_ID, RAILWAY_WORKER_SERVICE_ID" in err
    assert TOKEN not in err


def test_dry_run_needs_no_environment(capsys: pytest.CaptureFixture[str]) -> None:
    assert rd.main(["--service", "api", "--image", API_IMAGE, "--dry-run"], env={}) == 0
    assert json.loads(capsys.readouterr().out)["input"]["source"]["image"] == API_IMAGE
