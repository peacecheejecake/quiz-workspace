"""Delete the Vercel deployments of one PR preview (PR-PREVIEW, .github/workflows/preview.yml).

    python3 -I scripts/deploy/vercel_preview.py prune --pr 42 [--keep https://<deployment host>]

Lists the deployments of the preview Vercel project and deletes every one whose `meta.previewPr`
equals `--pr` (set by `vercel deploy --meta previewPr=<n>` in the workflow), except the one whose
URL is `--keep`. The workflow runs it after each preview deploy (keep the new one) and when the
pull request closes (keep none). Deployments without that meta (staging, production, manual
ones) are never touched: the filter is on the PR meta value, never on age or URL patterns.

Environment (GitHub Environment `pr-preview`; docs/deployment.md "PR preview"):
    VERCEL_TOKEN        team-scoped token (header `Authorization: Bearer`)
    VERCEL_ORG_ID       team id
    VERCEL_PROJECT_ID   the preview project's id

Output: the number of deleted deployments and their ids; never the token. Stdlib only (the
runner's python3, no checkout-wide install).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import Any

API = "https://api.vercel.com"
META_KEY = "previewPr"
PAGE_LIMIT = 100
MAX_PAGES = 20
DEPLOYMENT_URL = re.compile(r"^https://[a-z0-9][a-z0-9.-]*$")

# (method, url, headers) -> (status, parsed JSON body or None)
Fetch = Callable[[str, str, Mapping[str, str]], tuple[int, Any]]


class PreviewError(RuntimeError):
    """Message names the step and the HTTP status; never a credential."""


def _urllib_fetch(method: str, url: str, headers: Mapping[str, str]) -> tuple[int, Any]:
    request = urllib.request.Request(url, method=method, headers=dict(headers))  # noqa: S310 - https only
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        endpoint = url.split("?", 1)[0]
        raise PreviewError(f"{method} {endpoint}: unreachable ({type(exc).__name__})") from None
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


class Vercel:
    def __init__(
        self, token: str, team_id: str, project_id: str, fetch: Fetch = _urllib_fetch
    ) -> None:
        self._headers = {"Authorization": f"Bearer {token}", "User-Agent": "quiz-pr-preview"}
        self._team = team_id
        self._project = project_id
        self._fetch = fetch

    def _url(self, path: str, **query: str) -> str:
        return f"{API}{path}?{urllib.parse.urlencode({**query, 'teamId': self._team})}"

    def deployments(self, pr: int) -> list[dict[str, Any]]:
        """Deployments of the project tagged with this PR (all pages, newest first)."""
        found: list[dict[str, Any]] = []
        until: str | None = None
        for _ in range(MAX_PAGES):
            query = {
                "projectId": self._project,
                "limit": str(PAGE_LIMIT),
                # Server-side filter where supported; the meta check below is what decides.
                f"meta-{META_KEY}": str(pr),
            }
            if until:
                query["until"] = until
            status, body = self._fetch("GET", self._url("/v6/deployments", **query), self._headers)
            if status != 200 or not isinstance(body, dict):
                raise PreviewError(f"list deployments: HTTP {status}")
            for item in body.get("deployments") or []:
                meta = item.get("meta") if isinstance(item, dict) else None
                if isinstance(meta, dict) and str(meta.get(META_KEY, "")) == str(pr):
                    found.append(item)
            nxt = (body.get("pagination") or {}).get("next")
            if not nxt:
                return found
            until = str(nxt)
        raise PreviewError(f"list deployments: more than {MAX_PAGES} pages")

    def delete(self, uid: str) -> None:
        path = f"/v13/deployments/{urllib.parse.quote(uid, safe='')}"
        status, _ = self._fetch("DELETE", self._url(path), self._headers)
        # 404: already gone (a parallel cleanup or a manual delete).
        if status not in (200, 204, 404):
            raise PreviewError(f"delete {uid}: HTTP {status}")


def _host(url: str) -> str:
    return url.removeprefix("https://").rstrip("/").lower()


def prune(
    vercel: Vercel, pr: int, keep: str | None, log: Callable[[str], None] = print
) -> list[str]:
    keep_host = _host(keep) if keep else None
    deleted: list[str] = []
    for item in vercel.deployments(pr):
        uid = str(item.get("uid") or item.get("id") or "")
        if not uid:
            continue
        if keep_host and _host(str(item.get("url", ""))) == keep_host:
            continue
        vercel.delete(uid)
        deleted.append(uid)
    ids = " ".join(deleted)
    log(f"vercel_preview: PR #{pr}: deleted {len(deleted)} deployment(s) {ids}".rstrip())
    return deleted


def main(
    argv: Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
    fetch: Fetch | None = None,
) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    prune_cmd = sub.add_parser("prune", help="delete this PR's preview deployments")
    prune_cmd.add_argument("--pr", required=True, type=int)
    prune_cmd.add_argument("--keep", help="deployment URL to keep (https://<host>)")
    args = parser.parse_args(argv)
    try:
        if args.pr <= 0:
            raise PreviewError("--pr must be a positive pull request number")
        if args.keep is not None and not DEPLOYMENT_URL.fullmatch(args.keep):
            raise PreviewError("--keep must be https://<deployment host>")
        names = ("VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID")
        missing = [n for n in names if not env.get(n, "").strip()]
        if missing:
            raise PreviewError(f"missing {', '.join(missing)}")
        vercel = Vercel(
            env["VERCEL_TOKEN"].strip(),
            env["VERCEL_ORG_ID"].strip(),
            env["VERCEL_PROJECT_ID"].strip(),
            fetch or _urllib_fetch,
        )
        prune(vercel, args.pr, args.keep)
    except PreviewError as exc:
        print(f"vercel_preview: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
