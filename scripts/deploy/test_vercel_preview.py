"""scripts/deploy/vercel_preview.py against a fake Vercel REST API (PR-PREVIEW, offline)."""

from __future__ import annotations

import importlib.util
import sys
import urllib.parse
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "vercel_preview", Path(__file__).with_name("vercel_preview.py")
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["vercel_preview"] = module
    spec.loader.exec_module(module)
    return module


vp = _load()
TOKEN = "vercel-token-never-printed"  # noqa: S105
ENV = {"VERCEL_TOKEN": TOKEN, "VERCEL_ORG_ID": "team_1", "VERCEL_PROJECT_ID": "prj_preview"}


def _dep(uid: str, pr: object | None, url: str | None = None) -> dict[str, Any]:
    meta = {} if pr is None else {"previewPr": pr}
    return {"uid": uid, "url": url or f"quiz-preview-{uid}.vercel.app", "meta": meta}


class FakeVercel:
    def __init__(self, pages: list[list[Any]], delete_status: int = 200) -> None:
        self.pages = pages
        self.delete_status = delete_status
        self.calls: list[tuple[str, str, dict[str, list[str]]]] = []

    def __call__(self, method: str, url: str, headers: Mapping[str, str]) -> tuple[int, Any]:
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        parsed = urllib.parse.urlsplit(url)
        assert f"{parsed.scheme}://{parsed.netloc}" == vp.API
        query = urllib.parse.parse_qs(parsed.query)
        assert query["teamId"] == ["team_1"]
        self.calls.append((method, parsed.path, query))
        if method == "GET":
            assert parsed.path == "/v6/deployments"
            assert query["projectId"] == ["prj_preview"]
            index = int(query.get("until", ["0"])[0])
            nxt = index + 1 if index + 1 < len(self.pages) else None
            return 200, {"deployments": self.pages[index], "pagination": {"next": nxt}}
        assert method == "DELETE"
        assert parsed.path.startswith("/v13/deployments/")
        return self.delete_status, {}

    def deleted(self) -> list[str]:
        return [path.rsplit("/", 1)[1] for method, path, _ in self.calls if method == "DELETE"]


def _main(fake: FakeVercel, *args: str, env: Mapping[str, str] = ENV) -> int:
    return int(vp.main(["prune", *args], env=env, fetch=fake))


def test_prune_deletes_only_this_prs_deployments_except_the_kept_one(
    capsys: pytest.CaptureFixture[str],
) -> None:
    fake = FakeVercel(
        [
            [_dep("new", 7, "quiz-preview-new.vercel.app"), _dep("old", "7"), _dep("other", 8)],
            [_dep("staging", None), _dep("older", 7), {"uid": "nometa"}, "junk"],
        ]
    )
    assert _main(fake, "--pr", "7", "--keep", "https://quiz-preview-new.vercel.app") == 0
    assert fake.deleted() == ["old", "older"]
    out = capsys.readouterr()
    assert "deleted 2 deployment(s) old older" in out.out
    assert TOKEN not in out.out + out.err
    # Server-side filter requested, client-side filter decides.
    assert fake.calls[0][2]["meta-previewPr"] == ["7"]


def test_prune_without_keep_deletes_every_deployment_of_the_pr() -> None:
    fake = FakeVercel([[_dep("a", 7), _dep("b", 7), _dep("c", 70)]])
    assert _main(fake, "--pr", "7") == 0
    assert fake.deleted() == ["a", "b"]


def test_already_deleted_deployments_are_fine() -> None:
    fake = FakeVercel([[_dep("a", 7)]], delete_status=404)
    assert _main(fake, "--pr", "7") == 0


@pytest.mark.parametrize("status", [401, 403, 500])
def test_api_errors_fail_without_leaking_the_token(
    capsys: pytest.CaptureFixture[str], status: int
) -> None:
    fake = FakeVercel([[_dep("a", 7)]], delete_status=status)
    assert _main(fake, "--pr", "7") == 1
    err = capsys.readouterr().err
    assert f"HTTP {status}" in err
    assert TOKEN not in err


def test_list_error_fails() -> None:
    def fetch(method: str, url: str, headers: Mapping[str, str]) -> tuple[int, Any]:
        return 403, {"error": {"message": "forbidden"}}

    assert vp.main(["prune", "--pr", "7"], env=ENV, fetch=fetch) == 1


def test_missing_environment_is_named(capsys: pytest.CaptureFixture[str]) -> None:
    fake = FakeVercel([[]])
    assert _main(fake, "--pr", "7", env={"VERCEL_TOKEN": TOKEN}) == 1
    assert "missing VERCEL_ORG_ID, VERCEL_PROJECT_ID" in capsys.readouterr().err
    assert not fake.calls


@pytest.mark.parametrize(
    "args",
    [
        ["--pr", "0"],
        ["--pr", "7", "--keep", "http://quiz.vercel.app"],
        ["--pr", "7", "--keep", "https://quiz.vercel.app/path"],
        ["--pr", "7", "--keep", "https://quiz.vercel.app\n[x](y)"],
    ],
)
def test_bad_arguments_are_refused_before_any_call(args: list[str]) -> None:
    fake = FakeVercel([[]])
    assert _main(fake, *args) == 1
    assert not fake.calls


def test_runaway_pagination_stops() -> None:
    def fetch(method: str, url: str, headers: Mapping[str, str]) -> tuple[int, Any]:
        return 200, {"deployments": [], "pagination": {"next": 1}}

    assert vp.main(["prune", "--pr", "7"], env=ENV, fetch=fetch) == 1
