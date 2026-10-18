"""Roll a Railway service onto an image digest (M7.4a, .github/workflows/deploy.yml).

    uv run python scripts/deploy/railway_deploy.py --service api \\
        --image ghcr.io/<owner>/quiz-api@sha256:<64 hex> [--timeout 900] [--dry-run]

Applies the service's deploy settings from infra/deploy/railway-services.toml (start command =
image CMD, health check, restart policy, replicas) together with the image through Railway's
public GraphQL API, triggers a deployment and waits until Railway reports SUCCESS (for the API
that means /health/ready answered). Any other terminal status, a GraphQL error or the timeout
exits 1.

Environment (GitHub Environment of the deploy workflow; infra/deploy/env-manifest.toml):
    RAILWAY_TOKEN              project token of that Railway environment (header
                               `Project-Access-Token`)
    RAILWAY_ENVIRONMENT_ID     Railway environment id
    RAILWAY_API_SERVICE_ID / RAILWAY_WORKER_SERVICE_ID

Output names the service, the digest and Railway's statuses; never the token. `--dry-run` prints
the planned update and needs no environment.

The mutation names (`serviceInstanceUpdate`, `serviceInstanceDeployV2`, `deployment`) follow
Railway's public API as of 2026-10; the first staging deploy confirms them (runbook).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import tomllib
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "infra/deploy/railway-services.toml"
ENDPOINT = "https://backboard.railway.com/graphql/v2"
IMAGE_REF = re.compile(r"^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")
SERVICE_ID_ENV = {"api": "RAILWAY_API_SERVICE_ID", "worker": "RAILWAY_WORKER_SERVICE_ID"}
SUCCESS = "SUCCESS"
FAILED = frozenset({"FAILED", "CRASHED", "REMOVED", "SKIPPED"})

UPDATE = """
mutation Update($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}
"""
DEPLOY = """
mutation Deploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}
"""
STATUS = """
query Status($id: String!) { deployment(id: $id) { status } }
"""


class DeployError(RuntimeError):
    """Message names the step and Railway's reason; never a credential."""


def instance_input(service: str, image: str, manifest: Path = MANIFEST) -> dict[str, Any]:
    if not IMAGE_REF.fullmatch(image):
        raise DeployError("--image must be ghcr.io/<owner>/<name>@sha256:<64 hex> (a digest)")
    services = tomllib.loads(manifest.read_text(encoding="utf-8"))["services"]
    if service not in services:
        raise DeployError(f"unknown service {service}")
    spec = services[service]
    if f"/{spec['image']}@" not in image:
        raise DeployError(f"--image is not the {spec['image']} image")
    return {
        "source": {"image": image},
        # null clears a dashboard override: the image CMD (python -m quiz_*.serve) runs.
        "startCommand": spec["start_command"] or None,
        "healthcheckPath": spec["healthcheck_path"] or None,
        "healthcheckTimeout": spec["healthcheck_timeout_seconds"] or None,
        "restartPolicyType": spec["restart_policy"],
        "restartPolicyMaxRetries": spec["restart_policy_max_retries"],
        "numReplicas": spec["replicas"],
    }


class Railway:
    def __init__(self, token: str, client: httpx.Client | None = None) -> None:
        self._client = client or httpx.Client(timeout=30)
        self._headers = {"Project-Access-Token": token, "content-type": "application/json"}

    def call(self, query: str, variables: Mapping[str, Any], step: str) -> dict[str, Any]:
        try:
            res = self._client.post(
                ENDPOINT, headers=self._headers, json={"query": query, "variables": variables}
            )
        except httpx.HTTPError as exc:
            raise DeployError(f"{step}: Railway API unreachable ({type(exc).__name__})") from None
        try:
            body = res.json()
        except ValueError:
            body = {}
        errors = body.get("errors") if isinstance(body, dict) else None
        if res.status_code != 200 or errors:
            reasons = "; ".join(str(e.get("message", ""))[:200] for e in errors or [])
            raise DeployError(f"{step}: HTTP {res.status_code} {reasons}".rstrip())
        data = body.get("data")
        if not isinstance(data, dict):
            raise DeployError(f"{step}: response has no data")
        return data


def deploy(
    railway: Railway,
    *,
    service_id: str,
    environment_id: str,
    payload: Mapping[str, Any],
    timeout: float,
    poll_seconds: float = 10.0,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    log: Callable[[str], None] = print,
) -> str:
    ids = {"serviceId": service_id, "environmentId": environment_id}
    if (
        railway.call(UPDATE, {**ids, "input": dict(payload)}, "update").get("serviceInstanceUpdate")
        is not True
    ):
        raise DeployError("update: Railway did not accept the service settings")
    deployment_id = railway.call(DEPLOY, ids, "deploy").get("serviceInstanceDeployV2")
    if not isinstance(deployment_id, str) or not deployment_id:
        raise DeployError("deploy: Railway returned no deployment id")
    log(f"railway: deployment {deployment_id} started")
    deadline = clock() + timeout
    last = ""
    while True:
        status = railway.call(STATUS, {"id": deployment_id}, "status").get("deployment") or {}
        current = str(status.get("status", ""))
        if current != last:
            log(f"railway: deployment {deployment_id} {current}")
            last = current
        if current == SUCCESS:
            return deployment_id
        if current in FAILED:
            raise DeployError(f"deployment {deployment_id} ended {current}")
        if clock() >= deadline:
            raise DeployError(f"deployment {deployment_id} still {current} after {timeout:.0f}s")
        sleep(poll_seconds)


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--service", required=True, choices=sorted(SERVICE_ID_ENV))
    parser.add_argument("--image", required=True)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        payload = instance_input(args.service, args.image, args.manifest)
        if args.dry_run:
            print(json.dumps({"service": args.service, "input": payload}, indent=2))
            return 0
        names = ("RAILWAY_TOKEN", "RAILWAY_ENVIRONMENT_ID", SERVICE_ID_ENV[args.service])
        missing = [n for n in names if not env.get(n, "").strip()]
        if missing:
            raise DeployError(f"missing {', '.join(missing)}")
        deployment = deploy(
            Railway(env["RAILWAY_TOKEN"].strip()),
            service_id=env[SERVICE_ID_ENV[args.service]].strip(),
            environment_id=env["RAILWAY_ENVIRONMENT_ID"].strip(),
            payload=payload,
            timeout=args.timeout,
        )
    except DeployError as exc:
        print(f"railway_deploy ({args.service}): {exc}", file=sys.stderr)
        return 1
    print(f"railway: {args.service} runs {args.image.split('@', 1)[1]} ({deployment})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
