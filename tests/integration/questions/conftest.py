"""Fixtures for the M4 question contract tests (QBANK-01, QIMPORT-01).

Reuses the M3 contract stack (in-process production app, local Auth users, `quiz_api` DB role)
from tests/integration/workspaces/conftest.py, loaded by path because conftest modules are not
importable under `--import-mode=importlib`. Adds question/import helpers whose request and
response shapes mirror tests/e2e/fixtures/questions.ts (its header lists every assumption; keep
both in sync). The `postgres` superuser is used for teardown and two documented cases only: a
`viewer` membership (no membership API before S1/S2) and seeding/reading a graded attempt on a
question revision (practice API arrives in M5).

Jobs (`document.parse` for the uploaded paper, `question.import`, `question.generate` with the
APP_ENV=test ScenarioLLMClient) run in this process (`JobWorker`, M4.4a): `wait_for_job` drives
the job with the worker's `JobRunner` and real dependencies (Postgres as the least-privilege
`quiz_worker` role from WORKER_DATABASE_URL, Supabase Storage, Qdrant under a per-module
collection prefix, APP_ENV=test adapters: fixture-truth parser, fake embedder, the import fault
injection of A7), then reads the outcome through `GET /jobs/{id}` like any client. No Celery worker
has to be running; one that is running is harmless (job claims are idempotent).
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
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from book_core.search import SearchService
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_worker.adapters import FailureInjectingEmbedder, build_parser
from quiz_worker.document_job import (
    DocumentJobDeps,
    Limits,
    document_parse_definition,
    index_sync_definition,
)
from quiz_worker.document_store import PostgresDocumentStore
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.question_generation_job import (
    GenerationJobDeps,
    build_generation_llm,
    question_generate_definition,
)
from quiz_worker.question_generation_store import PostgresGenerationStore
from quiz_worker.question_import_job import ImportJobDeps, question_import_definition
from quiz_worker.question_import_store import PostgresImportStore
from quiz_worker.runner import JobDefinition, JobRunner
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import SupabaseStorage
from quiz_worker.store import TERMINAL_STATUSES

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
# A7: file-name marker that makes the APP_ENV=test fake extractor fail a run's first job after
# persisting part of the drafts (implementation-plan §7 fault-injection decision).
IMPORT_FAILURE_MARKER = "E2E-FAIL-IMPORT-ONCE"
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


class JobWorker:
    """Runs this suite's jobs in-process (see the module docstring); built on first use."""

    def __init__(self) -> None:
        self._built: tuple[PostgresJobStore, JobRunner, dict[str, JobDefinition[Any]]] | None = None
        self._closers: list[Any] = []
        self._names = CollectionNames(prefix=f"it_m44a_{uuid.uuid4().hex[:8]}_")
        self._qdrant: QdrantClient | None = None
        self.generation_deps: GenerationJobDeps | None = None

    def _build(self) -> tuple[PostgresJobStore, JobRunner, dict[str, JobDefinition[Any]]]:
        if self._built is not None:
            return self._built
        env = WorkerSettings(_env_file=str(_m3.REPO_ROOT / ".env"))  # type: ignore[call-arg]
        env = env.model_copy(update={"app_env": Environment.TEST})
        secret = env.supabase_secret_key
        url = env.worker_database_url
        if url is None or secret is None or not env.supabase_url:
            pytest.fail("WORKER_DATABASE_URL / SUPABASE_URL / SUPABASE_SECRET_KEY missing (.env)")
        for value in (url.get_secret_value(), env.supabase_url):
            host = urlsplit(value).hostname
            assert host in LOOPBACK, f"refusing non-local {host}"
        engine = create_job_store_engine(url, pool_size=4)
        storage = SupabaseStorage(env.supabase_url, secret.get_secret_value())
        self._qdrant = QdrantClient(url=env.qdrant_url or "http://127.0.0.1:6333", timeout=30)
        self._closers += [engine.dispose, storage.close]
        documents = PostgresDocumentStore(engine)
        document_deps = DocumentJobDeps(
            documents=documents,
            storage=storage,
            index=QdrantIndexStore(
                self._qdrant, FailureInjectingEmbedder(FakeEmbedder()), names=self._names
            ),
            parser=build_parser(env),
            limits=Limits(lock_wait_seconds=30),
        )
        import_deps = ImportJobDeps(
            imports=PostgresImportStore(engine),
            documents=documents,
            storage=storage,
            inject_failures=True,
            lock_wait_seconds=30,
        )
        # APP_ENV=test: the ScenarioLLMClient over tests/fixtures/llm/generation-scenarios.json
        # (tests/e2e/fixtures/generation.ts G1).
        generation_deps = GenerationJobDeps(
            generations=PostgresGenerationStore(engine),
            documents=documents,
            llm=build_generation_llm(env),
            lock_wait_seconds=30,
            # ANALOGOUS_CONCEPT related passages from this suite's index (fake embedder).
            search=SearchService(document_deps.index),
        )
        self.generation_deps = generation_deps
        definitions: list[JobDefinition[Any]] = [
            document_parse_definition(lambda: document_deps),
            index_sync_definition(lambda: document_deps),
            question_import_definition(lambda: import_deps),
            question_generate_definition(lambda: generation_deps),
        ]
        jobs = PostgresJobStore(engine)
        runner = JobRunner(jobs, worker_id="it-m44a", lease_seconds=600)
        self._built = (jobs, runner, {d.job_type: d for d in definitions})
        return self._built

    def drain(self, job_id: str, max_runs: int = 10) -> None:
        """Run the job (retries included) until it is terminal."""
        jobs, runner, definitions = self._build()
        for _ in range(max_runs):
            record = jobs.get(uuid.UUID(job_id))
            assert record is not None, "job row missing"
            if record.status in TERMINAL_STATUSES:
                return
            definition = definitions.get(record.job_type)
            if definition is None:
                pytest.fail(f"JobWorker has no in-process handler for job type {record.job_type}")
            runner.run(definition, record.to_envelope().to_message())

    def close(self) -> None:
        for close in self._closers:
            close()
        if self._qdrant is not None:
            client = self._qdrant
            for alias in client.get_aliases().aliases:
                if alias.alias_name == self._names.alias:
                    client.update_collection_aliases(
                        change_aliases_operations=[
                            qm.DeleteAliasOperation(
                                delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                            )
                        ]
                    )
            for collection in client.get_collections().collections:
                if self._names.owns(collection.name):
                    client.delete_collection(collection.name)
            client.close()


@pytest.fixture(scope="module")
def job_worker(stack: Any) -> Iterator[JobWorker]:
    worker = JobWorker()
    try:
        yield worker
    finally:
        worker.close()


class QuestionClient(_m3.Client):
    """`Client` plus the question bank and import endpoints."""

    worker: JobWorker | None = None

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

    def upload_question_paper(self, workspace_id: str, filename: str = QUESTION_PAPER.name) -> str:
        """Upload flow for questions-ko.pdf as a `question_paper` document (A4); returns its id.

        `filename` may carry IMPORT_FAILURE_MARKER (A7); the bytes are always questions-ko.pdf.
        """
        pdf = QUESTION_PAPER.read_bytes()
        sha256 = hashlib.sha256(pdf).hexdigest()
        intent: dict[str, Any] = self.ok(
            "POST",
            f"/workspaces/{workspace_id}/documents/upload-intent",
            {
                "filename": filename,
                "size_bytes": len(pdf),
                "content_type": "application/pdf",
                "sha256": sha256,
                "document_type": "question_paper",
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

    def wait_for_job(self, job_id: str, expected: str = "succeeded") -> None:
        if self.worker is not None:
            self.worker.drain(job_id)
        deadline = time.monotonic() + JOB_TIMEOUT_S
        status = ""
        while time.monotonic() < deadline:
            status = str(self.ok("GET", f"/jobs/{job_id}")["status"])
            if status in TERMINAL:
                break
            time.sleep(0.5)
        assert status == expected, f"job ended as {status or 'timeout'}, expected {expected}"

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

    def retry_import(self, import_id: str) -> dict[str, Any]:
        """Retries a failed run (A4): same run id, new job id."""
        run: dict[str, Any] = self.ok("POST", f"/question-imports/{import_id}/retry", {}, (202,))
        return run

    def drafts(self, import_id: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.ok("GET", f"/question-imports/{import_id}/drafts")[
            "items"
        ]
        return sorted(items, key=lambda d: int(d["position"]))

    def approve(self, draft: dict[str, Any]) -> httpx.Response:
        """PATCH the draft to `approved` at its current version (A4)."""
        return self.call(
            "PATCH",
            f"/question-drafts/{draft['id']}",
            {"base_version": draft["version"], "review_status": "approved"},
        )

    def publish_reviewed(self, import_id: str, items: list[dict[str, str]]) -> httpx.Response:
        """POST publish with explicit `{draft_id, version}` items (A4)."""
        return self.call("POST", f"/question-imports/{import_id}/publish", {"drafts": items})

    def approve_and_publish(self, import_id: str, items: list[dict[str, str]]) -> httpx.Response:
        """POST publish with `approve: true` (QIMP-BULK): the selection is the approval."""
        return self.call(
            "POST", f"/question-imports/{import_id}/publish", {"drafts": items, "approve": True}
        )

    def publish(self, import_id: str, draft_ids: list[str]) -> httpx.Response:
        """Review, then register, as the import screen did before QIMP-BULK (A4; the screen now
        uses `approve_and_publish`): approve each listed draft that
        is neither approved nor published at its current version, then publish them at the
        approved versions. Returns the first refused approval (e.g. 422 for an MCQ without an
        answer, nothing published) or the publish response. Ids that are not drafts of the
        import are sent as they are (the server answers 404)."""
        current = {d["id"]: d for d in self.drafts(import_id)}
        items: list[dict[str, str]] = []
        for draft_id in draft_ids:
            draft = current.get(draft_id)
            if draft is None:
                items.append({"draft_id": draft_id, "version": "0"})
                continue
            if draft["published_question_id"] is None and draft["review_status"] != "approved":
                res = self.approve(draft)
                if res.status_code != 200:
                    return res
                draft = res.json()
            items.append({"draft_id": draft_id, "version": str(draft["version"])})
        return self.publish_reviewed(import_id, items)


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
    IMPORT_FAILURE_MARKER = IMPORT_FAILURE_MARKER
    DB_ADMIN_URL = DB_ADMIN_URL

    worker: JobWorker | None = None

    def client(self, label: str) -> QuestionClient:
        base = super().client(f"m4-{label}")
        client = QuestionClient(self._http, base.user)
        client.worker = self.worker
        return client

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
    def worker_database_url() -> str:
        """The `quiz_worker` role's URL (grant checks)."""
        env = WorkerSettings(_env_file=str(_m3.REPO_ROOT / ".env"))  # type: ignore[call-arg]
        if env.worker_database_url is None:
            pytest.fail("WORKER_DATABASE_URL missing (.env)")
        url = env.worker_database_url.get_secret_value()
        assert urlsplit(url).hostname in LOOPBACK, "refusing a non-local database"
        return url

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@pytest.fixture
def seed(stack: Any, app_client: TestClient, job_worker: JobWorker) -> Iterator[QuestionSeed]:
    s = QuestionSeed(stack, app_client)
    s.worker = job_worker
    try:
        yield s
    finally:
        s.cleanup()
