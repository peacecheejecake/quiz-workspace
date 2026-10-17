"""Restore rehearsal probe (M7.3, DEP-06): one published synthetic document that must survive
backup -> reset -> restore -> reindex.

    uv run python scripts/restore_probe.py seed   --state <file>   # before scripts/backup
    uv run python scripts/restore_probe.py verify --state <file>   # after scripts/restore --reindex

`seed` goes through the real paths on the LOCAL stack only: a confirmed synthetic user (Auth admin
API), a workspace and the book-ko fixture PDF through the public API (upload-intent -> Storage ->
complete-upload, in-process app), then the `document.parse` job in-process as the `quiz_worker`
role with the APP_ENV=test adapters (fixture parser, fake embedder) into Qdrant. The state file
holds ids, the PDF's SHA-256 and the chunk count only (no credentials).

`verify` checks, as the worker role: the document is live, `ready` and still has the same active
published revision; Storage returns the original bytes; Qdrant has exactly that revision active
with the seeded number of chunks. Exit status 1 with a reason otherwise.

Configuration: the repo-root `.env` / environment the apps use (DATABASE_URL,
WORKER_DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, keys, QDRANT_*). Refuses non-loopback hosts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text

REPO = Path(__file__).resolve().parents[1]
PDF = REPO / "tests" / "fixtures" / "pdfs" / "book-ko.pdf"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _fail(message: str) -> int:
    print(f"restore-probe: {message}", file=sys.stderr)
    return 1


def _worker_settings() -> Any:
    from quiz_worker.settings import Environment, WorkerSettings

    settings = WorkerSettings(_env_file=str(REPO / ".env"))  # type: ignore[call-arg]
    return settings.model_copy(update={"app_env": Environment.TEST})


def _local(url: str | None) -> str:
    if not url or urlsplit(url).hostname not in LOOPBACK:
        raise SystemExit("restore-probe: refusing a non-local stack")
    return url


def seed(state: Path) -> int:
    from fastapi.testclient import TestClient
    from quiz_api.main import create_app
    from quiz_api.settings import Settings
    from quiz_worker.document_job import deps_from_settings, document_parse_definition
    from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
    from quiz_worker.runner import JobRunner, RunOutcome
    from quiz_worker.storage_backup import _dotenv, storage_config

    config = storage_config(dotenv=REPO / ".env")
    supabase = _local(config.url)
    env = _dotenv(REPO / ".env")
    publishable = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") or env.get(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ""
    )
    if not publishable:
        return _fail("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set")
    issuer = f"{supabase}/auth/v1"
    email = f"restore-probe-{uuid.uuid4().hex}@example.test"
    password = secrets.token_urlsafe(24)
    admin = {"apikey": config.secret_key, "Authorization": f"Bearer {config.secret_key}"}
    created = httpx.post(
        f"{issuer}/admin/users",
        headers=admin,
        json={"email": email, "password": password, "email_confirm": True},
        timeout=15,
    )
    if created.status_code != 200:
        return _fail(f"create user: HTTP {created.status_code}")
    signed_in = httpx.post(
        f"{issuer}/token",
        params={"grant_type": "password"},
        headers={"apikey": publishable},
        json={"email": email, "password": password},
        timeout=15,
    )
    if signed_in.status_code != 200:
        return _fail(f"sign in: HTTP {signed_in.status_code}")
    bearer = {"Authorization": f"Bearer {signed_in.json()['access_token']}"}

    app_settings = Settings(
        _env_file=str(REPO / ".env"),  # type: ignore[call-arg]
        SUPABASE_JWT_ISSUER=issuer,
        SUPABASE_JWKS_URL=f"{issuer}/.well-known/jwks.json",
    )
    _local(app_settings.database_url.get_secret_value() if app_settings.database_url else None)
    pdf = PDF.read_bytes()
    sha256 = hashlib.sha256(pdf).hexdigest()
    with TestClient(create_app(app_settings, readiness_checkers=[])) as api:

        def call(method: str, path: str, body: Any, expected: int, *also: int) -> Any:
            res = api.request(method, f"/api/v1{path}", json=body, headers=bearer)
            if res.status_code not in (expected, *also):
                raise SystemExit(f"restore-probe: {method} {path.split('/')[1]}: {res.status_code}")
            return res.json()

        ws = call("POST", "/workspaces", {"name": "Restore rehearsal"}, 201)
        intent = call(
            "POST",
            f"/workspaces/{ws['id']}/documents/upload-intent",
            {
                "filename": PDF.name,
                "size_bytes": len(pdf),
                "content_type": "application/pdf",
                "sha256": sha256,
            },
            200,
            201,
        )
        put = httpx.put(
            _local(str(intent["upload_url"])),
            content=pdf,
            headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
            timeout=30,
        )
        if not put.is_success:
            return _fail(f"Storage upload: HTTP {put.status_code}")
        done = call(
            "POST",
            "/documents/complete-upload",
            {"upload_id": intent["upload_id"], "sha256": sha256},
            202,
        )

        settings = _worker_settings()
        if settings.worker_database_url is None:
            return _fail("WORKER_DATABASE_URL is not set")
        _local(settings.worker_database_url.get_secret_value())
        deps = deps_from_settings(settings)
        engine = create_job_store_engine(settings.worker_database_url, pool_size=2)
        try:
            jobs = PostgresJobStore(engine)
            record = jobs.get(uuid.UUID(done["job_id"]))
            if record is None:
                return _fail("parse job row missing")
            result = JobRunner(jobs, worker_id="restore-probe", lease_seconds=600).run(
                document_parse_definition(lambda: deps), record.to_envelope().to_message()
            )
        finally:
            engine.dispose()
        if result.outcome is not RunOutcome.SUCCEEDED:
            return _fail(f"parse job: {result.outcome.value}")
        document = call("GET", f"/documents/{done['document_id']}", None, 200)
    chunks = ((result.record.result if result.record else None) or {}).get("chunks")
    if not isinstance(chunks, int) or chunks < 1:
        return _fail("the parse job indexed no chunks")

    probe = {
        "workspace_id": ws["id"],
        "document_id": done["document_id"],
        "revision_id": document["active_revision_id"],
        "sha256": sha256,
        "chunks": chunks,
    }
    state.write_text(json.dumps(probe) + "\n", encoding="utf-8")
    print(json.dumps({"seeded": probe["document_id"], "chunks": probe["chunks"]}))
    return 0


def verify(state: Path) -> int:
    from quiz_worker.adapters import build_index_store
    from quiz_worker.pg_store import create_job_store_engine
    from quiz_worker.storage import SOURCE_BUCKET, SupabaseStorage
    from quiz_worker.storage_backup import storage_config

    probe = json.loads(state.read_text(encoding="utf-8"))
    settings = _worker_settings()
    if settings.worker_database_url is None:
        return _fail("WORKER_DATABASE_URL is not set")
    _local(settings.worker_database_url.get_secret_value())
    engine = create_job_store_engine(settings.worker_database_url, pool_size=1)
    try:
        with engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "select workspace_id, status, active_revision_id, deleted_at, "
                        "source_object_key, sha256 from public.documents where id = :d"
                    ),
                    {"d": probe["document_id"]},
                )
                .mappings()
                .first()
            )
    finally:
        engine.dispose()
    if row is None:
        return _fail("document missing after restore")
    if (
        str(row["workspace_id"]) != probe["workspace_id"]
        or row["status"] != "ready"
        or str(row["active_revision_id"]) != probe["revision_id"]
        or row["deleted_at"] is not None
        or row["sha256"] != probe["sha256"]
    ):
        return _fail("document row differs after restore")

    config = storage_config(dotenv=REPO / ".env")
    storage = SupabaseStorage(_local(config.url), config.secret_key)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            got = storage.download(
                SOURCE_BUCKET, row["source_object_key"], Path(tmp) / "s.pdf", max_bytes=1 << 26
            )
    finally:
        storage.close()
    if got.sha256 != probe["sha256"]:
        return _fail("Storage object differs after restore")

    index = build_index_store(settings)
    ws, doc, rev = probe["workspace_id"], probe["document_id"], probe["revision_id"]
    if index.active_revision(ws, doc) != rev:
        return _fail("Qdrant does not have the restored revision active")
    chunks = index.load_chunks(ws, doc, rev)
    if len(chunks) != probe["chunks"]:
        return _fail(f"Qdrant has {len(chunks)} chunks, expected {probe['chunks']}")
    print(json.dumps({"verified": doc, "chunks": len(chunks)}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scripts/restore_probe.py")
    parser.add_argument("command", choices=["seed", "verify"])
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args(argv)
    return seed(args.state) if args.command == "seed" else verify(args.state)


if __name__ == "__main__":
    sys.exit(main())
