"""Fixtures for the M4 question contract tests (QBANK-01, QIMPORT-01).

Reuses the M3 contract stack (in-process production app, local Auth users, `quiz_api` DB role)
from tests/integration/workspaces/conftest.py, loaded by path because conftest modules are not
importable under `--import-mode=importlib`. Adds question/import helpers whose request and
response shapes mirror tests/e2e/fixtures/questions.ts (its header lists every assumption; keep
both in sync). The `postgres` superuser is used for teardown and two documented cases only: a
`viewer` membership (no membership API before S1/S2) and seeding/reading a graded attempt on a
question revision (practice API arrives in M5).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

_M3_CONFTEST = Path(__file__).resolve().parents[1] / "workspaces" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_m3_contract_conftest", _M3_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_m3 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _m3  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_m3)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _m3.stack
app_client = _m3.app_client

PDF_DIR: Path = _m3.PDF_DIR
DB_ADMIN_URL: str = _m3.DB_ADMIN_URL
LOOPBACK: set[str] = _m3.LOOPBACK
QUESTION_PAPER = PDF_DIR / "questions-ko.pdf"
QUESTION_TRUTH: dict[str, Any] = json.loads(
    (PDF_DIR / "questions-ko.truth.json").read_text(encoding="utf-8")
)
JOB_TIMEOUT_S = 120.0
TERMINAL = {"succeeded", "failed", "cancelled"}


def mcq(stem: str, texts: list[str], answer: int = 0, **extra: Any) -> dict[str, Any]:
    """Single-answer MCQ input with client-chosen option ids (assumption A2)."""
    options = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(texts)]
    return {
        "question_type": "MCQ",
        "stem": stem,
        "options": options,
        "correct_option_ids": [options[answer]["id"]],
        "is_multi_answer": False,
        **extra,
    }


class QuestionClient(_m3.Client):
    """`Client` plus the question bank and import endpoints."""

    def create_question(self, workspace_id: str, body: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = self.ok("POST", f"/workspaces/{workspace_id}/questions", body, (201,))
        return out

    def list_questions(self, workspace_id: str, query: str = "") -> list[dict[str, Any]]:
        path = f"/workspaces/{workspace_id}/questions" + (f"?{query}" if query else "")
        items: list[dict[str, Any]] = self.ok("GET", path)["items"]
        return items

    def get_question(self, question_id: str) -> dict[str, Any]:
        out: dict[str, Any] = self.ok("GET", f"/questions/{question_id}")
        return out

    def call_with_headers(
        self, method: str, path: str, body: Any, headers: dict[str, str]
    ) -> httpx.Response:
        return self._http.request(
            method,
            f"{_m3.API}{path}",
            json=body,
            headers={"Authorization": f"Bearer {self.user.token}", **headers},
        )

    def upload_question_paper(self, workspace_id: str) -> str:
        """Upload flow for questions-ko.pdf (assumption A4); returns the ready document id."""
        pdf = QUESTION_PAPER.read_bytes()
        sha256 = hashlib.sha256(pdf).hexdigest()
        intent: dict[str, Any] = self.ok(
            "POST",
            f"/workspaces/{workspace_id}/documents/upload-intent",
            {
                "filename": QUESTION_PAPER.name,
                "size_bytes": len(pdf),
                "content_type": "application/pdf",
                "sha256": sha256,
            },
            (200, 201),
        )
        url = str(intent["upload_url"])
        assert urlsplit(url).hostname in LOOPBACK, "upload URL must stay on the local stack"
        put = httpx.put(
            url,
            content=pdf,
            headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
            timeout=30,
        )
        assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
        done: dict[str, Any] = self.ok(
            "POST",
            "/documents/complete-upload",
            {"upload_id": intent["upload_id"], "sha256": sha256},
            (202,),
        )
        self.wait_for_job(str(done["job_id"]))
        return str(done["document_id"])

    def wait_for_job(self, job_id: str) -> None:
        deadline = time.monotonic() + JOB_TIMEOUT_S
        status = ""
        while time.monotonic() < deadline:
            status = str(self.ok("GET", f"/jobs/{job_id}")["status"])
            if status in TERMINAL:
                break
            time.sleep(0.5)
        assert status == "succeeded", f"job ended as {status or 'timeout'}"

    def start_import(
        self, workspace_id: str, document_id: str, idempotency_key: str | None = None
    ) -> httpx.Response:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        return self.call_with_headers(
            "POST",
            f"/workspaces/{workspace_id}/question-imports",
            {"document_id": document_id},
            headers,
        )

    def import_paper(self, workspace_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Uploads questions-ko.pdf, imports it, waits for the job; returns (run, drafts)."""
        document_id = self.upload_question_paper(workspace_id)
        run: dict[str, Any] = self.ok_response(
            self.start_import(workspace_id, document_id), "POST", "question-imports", (202,)
        )
        self.wait_for_job(str(run["job_id"]))
        return run, self.drafts(str(run["id"]))

    def drafts(self, import_id: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok("GET", f"/question-imports/{import_id}/drafts")[
            "items"
        ]
        return sorted(items, key=lambda d: int(d["position"]))

    def publish(self, import_id: str, draft_ids: list[str]) -> httpx.Response:
        return self.call("POST", f"/question-imports/{import_id}/publish", {"draft_ids": draft_ids})


def truth_question(number: int) -> dict[str, Any]:
    for q in QUESTION_TRUTH["questions"]:
        if q["number"] == number:
            return dict(q)
    raise KeyError(number)


def draft_for(drafts: list[dict[str, Any]], number: int) -> dict[str, Any]:
    stem = truth_question(number)["stem"]
    found = [d for d in drafts if stem in d["payload"]["stem"]]
    assert len(found) == 1, f"expected one draft for question {number}, got {len(found)}"
    return found[0]


class QuestionSeed(_m3.Seed):
    """`Seed` whose clients speak the question API, plus the M4 superuser seeds."""

    mcq = staticmethod(mcq)
    truth_question = staticmethod(truth_question)
    draft_for = staticmethod(draft_for)
    QUESTION_TRUTH = QUESTION_TRUTH

    def client(self, label: str) -> QuestionClient:
        base = super().client(f"m4-{label}")
        return QuestionClient(self._http, base.user)

    def graded_attempt(
        self, workspace_id: str, question_id: str, revision_id: str, user_id: str
    ) -> str:
        """Direct seed: the practice API that records attempts arrives in M5."""
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            row = conn.execute(
                "with s as (insert into public.practice_sessions (workspace_id, question_id, "
                "question_revision_id, user_id, state, submitted_at, graded_at) "
                "values (%s, %s, %s, %s, 'graded', now(), now()) "
                "returning id, workspace_id, question_id, question_revision_id, user_id) "
                "insert into public.question_attempts (workspace_id, question_id, "
                "question_revision_id, practice_session_id, user_id, submitted_answer, result, "
                "grading_method, graded_at) select workspace_id, question_id, "
                "question_revision_id, id, user_id, '{}'::jsonb, 'correct', 'auto', now() "
                "from s returning id",
                (workspace_id, question_id, revision_id, user_id),
            ).fetchone()
        assert row is not None
        return str(row[0])

    def attempt_revision(self, attempt_id: str) -> tuple[str, int, str]:
        """(revision id, version, stem) the attempt was graded against."""
        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            row = conn.execute(
                "select r.id, r.version, r.stem from public.question_attempts a "
                "join public.question_revisions r on r.id = a.question_revision_id "
                "where a.id = %s",
                (attempt_id,),
            ).fetchone()
        assert row is not None
        return str(row[0]), int(row[1]), str(row[2])

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@pytest.fixture
def seed(stack: Any, app_client: TestClient) -> Iterator[QuestionSeed]:
    s = QuestionSeed(stack, app_client)
    try:
        yield s
    finally:
        s.cleanup()
