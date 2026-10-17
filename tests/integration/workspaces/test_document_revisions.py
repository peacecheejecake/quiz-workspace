"""M3.4 end to end: outline/blocks reads, corrections into a draft revision, publish through the
worker (reindex, then the DB switch), failure/retry, rollback, and the concurrency guarantees.

The API runs in-process (conftest.py); the worker runs `document.parse` in-process like the M3.2b
test (JobRunner, `quiz_worker` role, Supabase Storage, Qdrant under a per-module prefix, the
APP_ENV=test fixture parser and fake embedder with the `E2E-FAIL-INDEXING` marker).

Search consistency (architecture §4: a stale revision is never searchable) is asserted on its two
inputs: the DB's active revision (search scopes Qdrant to DB-active revision ids, M3.6a) and the
Qdrant `active` flags mirrored by the publish.

Needs `make infra-up`, the quiz_api / quiz_worker login steps (AGENTS.md §7), SUPABASE_SECRET_KEY
in `.env`, and migration 20261018003400 (question chapter remap) for
`test_m34_publish_reindexes_switches_and_remaps_question_chapters`.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
from book_core.embedding import FakeEmbedder
from book_core.indexing import CollectionNames, QdrantIndexStore
from psycopg.rows import dict_row
from qdrant_client import QdrantClient
from qdrant_client import models as qm
from quiz_api.document_content import revision_from_rows
from quiz_worker.adapters import INDEX_FAILURE_MARKER, FailureInjectingEmbedder, build_parser
from quiz_worker.document_job import DocumentJobDeps, Limits, document_parse_definition
from quiz_worker.document_store import PostgresDocumentStore
from quiz_worker.pg_store import PostgresJobStore, create_job_store_engine
from quiz_worker.runner import JobRunner, RunOutcome, RunResult
from quiz_worker.settings import Environment, WorkerSettings
from quiz_worker.storage import PARSED_BUCKET, SupabaseStorage

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[3]
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
WORKER_DATABASE_URL = os.environ.get(
    "WORKER_DATABASE_URL", "postgresql://quiz_worker:change-me-local@127.0.0.1:54322/postgres"
)
EDIT_CONFLICT = "urn:quiz-workspace:problem:edit-conflict"
PUBLISH_IN_PROGRESS = "urn:quiz-workspace:problem:publish-in-progress"
NOTHING_TO_PUBLISH = "urn:quiz-workspace:problem:nothing-to-publish"
CHLORINE = "마지막으로 염소와 같은 소독제를"  # book-ko ch2-s2-p2 (page 4)
RAIN = "구름 속 물방울이"  # book-ko ch1-s2-p1 (page 2)


class HookedIndex:
    """The real index store; `after_index` runs once right after a complete index write."""

    def __init__(self, inner: QdrantIndexStore) -> None:
        self.inner = inner
        self.after_index: Callable[[], None] | None = None

    def index_revision(self, *args: Any, **kwargs: Any) -> Any:
        report = self.inner.index_revision(*args, **kwargs)
        hook, self.after_index = self.after_index, None
        if hook is not None:
            hook()
        return report

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class CountingParser:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = 0

    @property
    def parser_version(self) -> str:
        return str(self.inner.parser_version)

    def parse(self, path: Any, *, source_path: str | None = None) -> Any:
        self.calls += 1
        return self.inner.parse(path, source_path=source_path)


@dataclass
class Worker:
    jobs: PostgresJobStore
    runner: JobRunner
    deps: DocumentJobDeps
    index: HookedIndex
    parser: CountingParser
    qdrant: QdrantClient
    storage: SupabaseStorage

    def run(self, job_id: str) -> RunResult:
        record = self.jobs.get(uuid.UUID(job_id))
        assert record is not None, "job row missing"
        definition = document_parse_definition(lambda: self.deps)
        return self.runner.run(definition, record.to_envelope().to_message())

    def points(self, document_id: str) -> list[dict[str, Any]]:
        collection = self.index.inner.ensure_collection()
        flt = qm.Filter(
            must=[qm.FieldCondition(key="document_id", match=qm.MatchValue(value=document_id))]
        )
        records, _ = self.qdrant.scroll(
            collection, scroll_filter=flt, limit=10_000, with_payload=True
        )
        return [dict(r.payload or {}) for r in records]


@pytest.fixture(scope="module")
def env() -> WorkerSettings:
    settings = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    if not settings.supabase_secret_key or not settings.supabase_url:
        pytest.fail("SUPABASE_SECRET_KEY / SUPABASE_URL missing from .env (Storage access)")
    return settings.model_copy(update={"app_env": Environment.TEST})


@pytest.fixture(scope="module")
def qdrant(env: WorkerSettings) -> Iterator[tuple[QdrantClient, CollectionNames]]:
    client = QdrantClient(url=env.qdrant_url or "http://127.0.0.1:6333", timeout=30)
    names = CollectionNames(prefix=f"it_m34_{uuid.uuid4().hex[:8]}_")
    try:
        yield client, names
    finally:
        for alias in client.get_aliases().aliases:
            if alias.alias_name == names.alias:
                client.update_collection_aliases(
                    change_aliases_operations=[
                        qm.DeleteAliasOperation(
                            delete_alias=qm.DeleteAlias(alias_name=alias.alias_name)
                        )
                    ]
                )
        for collection in client.get_collections().collections:
            if names.owns(collection.name):
                client.delete_collection(collection.name)
        client.close()


@pytest.fixture
def worker(
    env: WorkerSettings, qdrant: tuple[QdrantClient, CollectionNames], seed: Any
) -> Iterator[Worker]:
    client, names = qdrant
    engine = create_job_store_engine(WORKER_DATABASE_URL, pool_size=4)
    secret = env.supabase_secret_key
    assert secret is not None
    assert env.supabase_url
    storage = SupabaseStorage(env.supabase_url, secret.get_secret_value())
    index = HookedIndex(
        QdrantIndexStore(client, FailureInjectingEmbedder(FakeEmbedder()), names=names)
    )
    parser = CountingParser(build_parser(env))
    deps = DocumentJobDeps(
        documents=PostgresDocumentStore(engine),
        storage=storage,
        index=index,  # type: ignore[arg-type]
        parser=parser,
        limits=Limits(lock_wait_seconds=10),
    )
    jobs = PostgresJobStore(engine)
    try:
        yield Worker(
            jobs=jobs,
            runner=JobRunner(jobs, worker_id="it-m34", lease_seconds=600),
            deps=deps,
            index=index,
            parser=parser,
            qdrant=client,
            storage=storage,
        )
    finally:
        storage.close()
        engine.dispose()


# --- helpers --------------------------------------------------------------------------------------


def _admin(sql: str, *params: Any) -> list[dict[str, Any]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True, row_factory=dict_row) as conn:
        cur = conn.execute(sql, params)
        return list(cur.fetchall()) if cur.description else []


@dataclass
class Ready:
    owner: Any
    workspace_id: str
    document_id: str
    revision_id: str


def _ready_document(seed: Any, worker: Worker, label: str) -> Ready:
    owner = seed.client(label)
    ws = owner.create_workspace()
    _, _, done = owner.upload_book(ws["id"])
    result = worker.run(done["job_id"])
    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    document = owner.ok("GET", f"/documents/{done['document_id']}")
    return Ready(owner, ws["id"], done["document_id"], document["active_revision_id"])


def _blocks(client: Any, document_id: str, revision: str = "active") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    after: int | None = None
    while True:
        query = f"revision={revision}&limit=10" + (f"&after={after}" if after is not None else "")
        page = client.ok("GET", f"/documents/{document_id}/blocks?{query}")
        items.extend(page["items"])
        after = page["next_after"]
        if after is None:
            return items


def _block_with(client: Any, document_id: str, snippet: str, revision: str = "active") -> Any:
    found = [b for b in _blocks(client, document_id, revision) if snippet in b["text"]]
    assert len(found) == 1, f"one block containing {snippet!r}"
    return found[0]


def _patch(client: Any, document_id: str, block: dict[str, Any], text: str) -> Any:
    return client.call(
        "PATCH",
        f"/documents/{document_id}/blocks/{block['block_id']}",
        {"text": text, "base_version": block["version"]},
    )


def _flatten(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for item in items:
        out.append(item)
        out.extend(_flatten(item["children"]))
    return out


def _cleanup_artifact(worker: Worker, ready: Ready) -> None:
    key = (
        f"workspaces/{ready.workspace_id}/documents/{ready.document_id}/revisions/"
        f"{ready.revision_id}/parsed_document.json"
    )
    worker.storage.delete(PARSED_BUCKET, key)


# --- reads and corrections ----------------------------------------------------------------------


def test_m34_outline_blocks_and_corrections_go_to_one_draft(seed: Any, worker: Worker) -> None:
    ready = _ready_document(seed, worker, "m34-draft")
    owner, doc = ready.owner, ready.document_id

    outline = owner.ok("GET", f"/documents/{doc}/outline")
    assert outline["revision"]["id"] == ready.revision_id
    assert outline["revision"]["is_active"] is True
    assert [(n["title"], n["level"], n["page"]) for n in outline["items"]] == [
        ("1장 물의 순환", 1, 2),
        ("2장 정수 처리", 1, 4),
    ]
    assert [c["title"] for c in outline["items"][1]["children"]] == [
        "2.1 응집과 침전",
        "2.2 여과와 소독",
    ]
    nodes = _flatten(outline["items"])
    chapter_ids = {
        r["id"]
        for r in _admin(
            "select id::text from public.chapters where document_revision_id = %s",
            ready.revision_id,
        )
    }
    assert {n["id"] for n in nodes} == chapter_ids, "outline ids are the active chapters"

    # Paged reads cover every block once, in reading order.
    blocks = _blocks(owner, doc)
    assert len(blocks) == 23
    assert [b["ordinal"] for b in blocks] == sorted(b["ordinal"] for b in blocks)
    assert len({b["block_id"] for b in blocks}) == 23
    ch2 = outline["items"][1]
    in_ch2 = owner.ok("GET", f"/documents/{doc}/blocks?chapter={ch2['id']}")["items"]
    assert in_ch2[0]["block_id"] == ch2["block_id"]
    assert any(CHLORINE in b["text"] for b in in_ch2), "sub-sections are included"
    assert not any(RAIN in b["text"] for b in in_ch2)
    on_page_4 = owner.ok("GET", f"/documents/{doc}/blocks?page=4")["items"]
    assert on_page_4
    assert {b["page"] for b in on_page_4} == {4}
    rain = _block_with(owner, doc, RAIN)
    assert rain["locations"][0]["page"] == 2
    assert rain["locations"][0]["bbox"]
    one = owner.ok("GET", f"/documents/{doc}/blocks/{rain['block_id']}")
    assert one["block"] == rain
    seed.problem(owner.call("GET", f"/documents/{doc}/blocks/no-such-block"), 404)

    # First correction: draft revision 2, the published revision and the PDF are untouched.
    before_doc = _admin("select sha256, source_object_key from public.documents where id = %s", doc)
    corrected = f"{rain['text']} 교정됨"
    res = _patch(owner, doc, rain, corrected)
    assert res.status_code == 200, res.text
    first = res.json()
    draft_id = first["revision"]["id"]
    assert (first["revision"]["revision_number"], first["revision"]["status"]) == (2, "draft")
    assert first["revision"]["is_active"] is False
    assert first["revision"]["parent_revision_id"] == ready.revision_id
    assert (first["block"]["text"], first["block"]["edited"]) == (corrected, True)
    assert first["block"]["version"] != rain["version"]
    assert owner.ok("GET", f"/documents/{doc}/blocks/{rain['block_id']}")["block"] == rain
    latest = owner.ok("GET", f"/documents/{doc}/blocks/{rain['block_id']}?revision=latest")
    assert latest["revision"]["id"] == draft_id
    assert latest["block"]["text"] == corrected
    after_doc = _admin("select sha256, source_object_key from public.documents where id = %s", doc)
    assert after_doc == before_doc, "the original PDF is never touched"
    draft_row = _admin(
        "select source_object_key, content_hash, status from public.document_revisions "
        "where id = %s",
        draft_id,
    )[0]
    assert draft_row["source_object_key"] == before_doc[0]["source_object_key"]
    assert (draft_row["status"], draft_row["content_hash"]) == ("draft", None)
    assert len(_blocks(owner, doc, "latest")) == 23, "the draft is a full copy"

    # A stale base version conflicts; a second block lands in the same draft.
    stale = _patch(owner, doc, rain, "다른 교정")
    assert seed.problem(stale, 409, EDIT_CONFLICT)
    heading = next(b for b in blocks if b["type"] == "heading" and b["text"] == "2장 정수 처리")
    renamed = _patch(owner, doc, heading, "2장 정수 처리 과정")
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["revision"]["id"] == draft_id
    draft_outline = owner.ok("GET", f"/documents/{doc}/outline?revision=latest")
    assert draft_outline["items"][1]["title"] == "2장 정수 처리 과정"
    assert draft_outline["items"][1]["section_key"] == ch2["section_key"]
    assert draft_outline["items"][1]["id"] != ch2["id"]
    assert owner.ok("GET", f"/documents/{doc}/outline")["items"][1]["title"] == "2장 정수 처리"

    # Same text again: a no-op. Invalid edits: 422 and nothing changes.
    current = _block_with(owner, doc, "교정됨", "latest")
    same = _patch(owner, doc, current, corrected)
    assert same.status_code == 200
    assert same.json()["block"] == current
    seed.problem(_patch(owner, doc, current, "   "), 422)
    image = next(b for b in blocks if b["type"] == "image")
    seed.problem(_patch(owner, doc, image, "그림 설명"), 422)
    table = next(b for b in blocks if b["type"] == "table")
    seed.problem(_patch(owner, doc, table, "a | b\nc"), 422)
    grid = _patch(owner, doc, table, "단계 | 작용\n응집 | 결합")
    assert grid.status_code == 200, grid.text
    assert grid.json()["block"]["table"]["rows"] == [["단계", "작용"], ["응집", "결합"]]

    history = owner.ok("GET", f"/documents/{doc}/revisions")["items"]
    assert [(r["revision_number"], r["status"], r["is_active"]) for r in history] == [
        (2, "draft", False),
        (1, "published", True),
    ]
    assert history[1]["job"]["status"] == "succeeded"
    assert history[0]["job"] is None

    # Activity: ids only, never the corrected text.
    events = _admin(
        "select event_type, metadata from public.activity_events where target_id = %s "
        "and event_type = 'document.block_corrected'",
        doc,
    )
    assert len(events) == 3
    assert all("교정" not in str(e["metadata"]) for e in events)

    # Viewers read the published revision only.
    viewer = seed.client("m34-viewer")
    seed.membership(ready.workspace_id, viewer.user, "viewer")
    assert viewer.ok("GET", f"/documents/{doc}/outline")["revision"]["id"] == ready.revision_id
    for path in (
        f"/documents/{doc}/outline?revision=latest",
        f"/documents/{doc}/blocks?revision={draft_id}",
        f"/documents/{doc}/blocks/{rain['block_id']}?revision=latest",
    ):
        seed.problem(viewer.call("GET", path), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(_patch(viewer, doc, rain, "viewer edit"), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(
        viewer.call("POST", f"/documents/{doc}/revisions/{ready.revision_id}/restore"),
        403,
        seed.INSUFFICIENT_ROLE,
    )
    _cleanup_artifact(worker, ready)


# --- publish ------------------------------------------------------------------------------------


def test_m34_publish_reindexes_switches_and_remaps_question_chapters(
    seed: Any, worker: Worker
) -> None:
    ready = _ready_document(seed, worker, "m34-publish")
    owner, doc, ws = ready.owner, ready.document_id, ready.workspace_id
    old_points = worker.points(doc)
    seed.problem(owner.call("POST", f"/documents/{doc}/publish", {}), 409, NOTHING_TO_PUBLISH)

    # A question linked to "2.2 여과와 소독" of revision 1, citing the document.
    outline = owner.ok("GET", f"/documents/{doc}/outline")
    section = _flatten(outline["items"])[-1]
    assert section["title"] == "2.2 여과와 소독"
    question = owner.ok(
        "POST",
        f"/workspaces/{ws}/questions",
        {
            "question_type": "ESSAY",
            "stem": "소독 단계의 목적을 설명하시오.",
            "chapter_id": section["id"],
            "sources": [{"document_id": doc, "page_start": 4, "page_end": 4}],
        },
        (201,),
    )
    sources_before = _admin(
        "select document_id, document_revision_id, page_start, page_end "
        "from public.question_sources where question_id = %s",
        question["id"],
    )
    assert sources_before[0]["document_revision_id"] == uuid.UUID(ready.revision_id)

    token = f"소독어휘{uuid.uuid4().hex[:8]}"
    chlorine = _block_with(owner, doc, CHLORINE)
    res = _patch(owner, doc, chlorine, f"마지막으로 {token} 처리를 하여 남은 미생물을 줄인다.")
    assert res.status_code == 200, res.text
    draft_id = res.json()["revision"]["id"]

    key = f"publish-{uuid.uuid4()}"
    first = owner._http.request(
        "POST",
        f"/api/v1/documents/{doc}/publish",
        json={"revision_id": draft_id},
        headers={"Authorization": f"Bearer {owner.user.token}", "Idempotency-Key": key},
    )
    assert first.status_code == 202, first.text
    job_id = first.json()["job_id"]
    assert first.json()["revision_id"] == draft_id
    replayed = owner._http.request(
        "POST",
        f"/api/v1/documents/{doc}/publish",
        json={"revision_id": draft_id},
        headers={"Authorization": f"Bearer {owner.user.token}", "Idempotency-Key": key},
    )
    assert replayed.headers.get("Idempotent-Replayed") == "true"
    assert replayed.json() == first.json()
    # Without a key the in-flight job is returned instead of a second one.
    assert owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))["job_id"] == job_id
    # The draft is frozen while it is being published.
    seed.problem(_patch(owner, doc, _block_with(owner, doc, RAIN), "x"), 409, PUBLISH_IN_PROGRESS)
    hashed = _admin("select content_hash from public.document_revisions where id = %s", draft_id)
    assert hashed[0]["content_hash"], "the publish request stores the draft's content hash"
    # Still the old revision everywhere until the job publishes.
    assert owner.ok("GET", f"/documents/{doc}")["active_revision_id"] == ready.revision_id

    parses = worker.parser.calls
    result = worker.run(job_id)

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    assert worker.parser.calls == parses, (
        "the corrected draft is indexed from the DB, not re-parsed"
    )
    job = owner.ok("GET", f"/jobs/{job_id}")
    assert (job["status"], job["job_type"]) == ("succeeded", "document.parse")
    document = owner.ok("GET", f"/documents/{doc}")
    assert (document["status"], document["active_revision_id"]) == ("ready", draft_id)
    assert document["last_error"] is None
    history = owner.ok("GET", f"/documents/{doc}/revisions")["items"]
    assert [(r["revision_number"], r["status"], r["is_active"]) for r in history] == [
        (2, "published", True),
        (1, "published", False),
    ]

    # Search inputs: DB-active revision = the new one; in Qdrant only its points are active, the
    # old revision is kept inactive for a quick rollback, unchanged chunks kept their ids.
    points = worker.points(doc)
    active = [p for p in points if p["active"]]
    assert {p["revision_id"] for p in active} == {draft_id}
    assert {p["revision_id"] for p in points if not p["active"]} == {ready.revision_id}
    assert any(token in p["content"] for p in active)
    assert not any(CHLORINE in p["content"] for p in active)
    assert {p["chunk_id"] for p in active} & {p["chunk_id"] for p in old_points}
    assert owner.ok("GET", f"/documents/{doc}/outline")["revision"]["id"] == draft_id

    # Question chapter followed the section into the new revision; sources still cite revision 1.
    new_section = _flatten(owner.ok("GET", f"/documents/{doc}/outline")["items"])[-1]
    assert new_section["section_key"] == section["section_key"]
    assert new_section["id"] != section["id"]
    assert owner.ok("GET", f"/questions/{question['id']}")["chapter_id"] == new_section["id"]
    assert (
        _admin(
            "select document_id, document_revision_id, page_start, page_end "
            "from public.question_sources where question_id = %s",
            question["id"],
        )
        == sources_before
    )

    seed.problem(owner.call("POST", f"/documents/{doc}/publish", {}), 409, NOTHING_TO_PUBLISH)
    events = _admin(
        "select metadata from public.activity_events where target_id = %s "
        "and event_type = 'document.publish_requested'",
        doc,
    )
    assert [e["metadata"]["job_id"] for e in events] == [job_id]
    _cleanup_artifact(worker, ready)


def test_m34_failed_reindex_keeps_the_published_revision_and_can_be_retried(
    seed: Any, worker: Worker
) -> None:
    ready = _ready_document(seed, worker, "m34-fail")
    owner, doc = ready.owner, ready.document_id
    chlorine = _block_with(owner, doc, CHLORINE)
    res = _patch(owner, doc, chlorine, f"{INDEX_FAILURE_MARKER} 교정된 문단")
    assert res.status_code == 200, res.text
    draft_id = res.json()["revision"]["id"]
    job_id = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))["job_id"]

    result = worker.run(job_id)

    assert result.outcome is RunOutcome.FAILED
    job = owner.ok("GET", f"/jobs/{job_id}")
    assert (job["status"], job["error_code"]) == ("failed", "indexing_failed")
    document = owner.ok("GET", f"/documents/{doc}")
    assert (document["status"], document["active_revision_id"]) == ("ready", ready.revision_id)
    assert document["last_error"].startswith("indexing_failed")
    points = worker.points(doc)
    assert {(p["revision_id"], p["active"]) for p in points} == {(ready.revision_id, True)}
    assert any(CHLORINE in p["content"] for p in points)

    # Retry: fix the draft (editable again) and publish once more.
    marked = _block_with(owner, doc, INDEX_FAILURE_MARKER, "latest")
    fixed = _patch(owner, doc, marked, "마지막으로 소독제를 넣어 남은 미생물을 줄인다. 재시도")
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["revision"]["id"] == draft_id
    retry = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))["job_id"]
    assert retry != job_id
    assert worker.run(retry).outcome is RunOutcome.SUCCEEDED
    document = owner.ok("GET", f"/documents/{doc}")
    assert (document["active_revision_id"], document["last_error"]) == (draft_id, None)
    assert any("재시도" in p["content"] for p in worker.points(doc) if p["active"])
    _cleanup_artifact(worker, ready)


def test_m34_restore_rolls_back_through_a_new_published_revision(seed: Any, worker: Worker) -> None:
    ready = _ready_document(seed, worker, "m34-restore")
    owner, doc = ready.owner, ready.document_id
    rain = _block_with(owner, doc, RAIN)
    assert _patch(owner, doc, rain, f"{rain['text']} 잘못된 교정").status_code == 200
    second = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))
    assert worker.run(second["job_id"]).outcome is RunOutcome.SUCCEEDED
    assert "잘못된 교정" in _block_with(owner, doc, RAIN)["text"]

    seed.problem(owner.call("POST", f"/documents/{doc}/revisions/{uuid.uuid4()}/restore"), 404)
    restored = owner.ok("POST", f"/documents/{doc}/revisions/{ready.revision_id}/restore")
    draft = restored["revision"]
    assert (draft["revision_number"], draft["status"]) == (3, "draft")
    assert draft["parent_revision_id"] == ready.revision_id
    assert _block_with(owner, doc, RAIN, "latest")["text"] == rain["text"]
    third = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))
    assert third["revision_id"] == draft["id"]
    assert worker.run(third["job_id"]).outcome is RunOutcome.SUCCEEDED

    document = owner.ok("GET", f"/documents/{doc}")
    assert document["active_revision_id"] == draft["id"]
    assert _block_with(owner, doc, RAIN)["text"] == rain["text"]
    active = [p for p in worker.points(doc) if p["active"]]
    assert {p["revision_id"] for p in active} == {draft["id"]}
    assert not any("잘못된 교정" in p["content"] for p in active)
    _cleanup_artifact(worker, ready)


def test_m34_a_correction_racing_the_index_is_never_published_stale(
    seed: Any, worker: Worker
) -> None:
    """A correction that commits while the job indexes (it passed the API's in-flight check just
    before the job was created) refreshes the draft hash; the job's publish sees the change,
    retries, and publishes the corrected content, never the stale index."""
    ready = _ready_document(seed, worker, "m34-race")
    owner, doc = ready.owner, ready.document_id
    rain = _block_with(owner, doc, RAIN)
    assert _patch(owner, doc, rain, f"{rain['text']} 첫 교정").status_code == 200
    job_id = owner.ok("POST", f"/documents/{doc}/publish", {}, (202,))["job_id"]
    draft_id = owner.ok("GET", f"/documents/{doc}")["latest_revision"]["id"]

    def late_correction() -> None:
        # What correct_block writes for a hashed draft, in one transaction.
        with psycopg.connect(DB_ADMIN_URL, row_factory=dict_row) as conn:
            conn.execute(
                "update public.content_blocks set text = text || ' 늦은 교정', edited = true "
                "where document_revision_id = %s and block_id = %s",
                (draft_id, rain["block_id"]),
            )
            chapters = conn.execute(
                "select id, parent_id, section_key, level, sort_order, title, heading_block_id "
                "from public.chapters where document_revision_id = %s",
                (draft_id,),
            ).fetchall()
            blocks = conn.execute(
                "select block_id, ordinal, chapter_id, block_type, text, provenance, attributes, "
                "edited from public.content_blocks where document_revision_id = %s",
                (draft_id,),
            ).fetchall()
            source = conn.execute(
                "select sha256 from public.documents where id = %s", (doc,)
            ).fetchone()
            assert source is not None
            content = revision_from_rows(
                document_id=doc,
                revision_id=draft_id,
                revision_number=2,
                parent_revision_id=ready.revision_id,
                source_sha256=source["sha256"],
                chapters=chapters,
                blocks=blocks,
            )
            conn.execute(
                "update public.document_revisions set content_hash = %s where id = %s",
                (content.content_hash, draft_id),
            )

    worker.index.after_index = late_correction
    first = worker.run(job_id)
    assert first.outcome is RunOutcome.RETRY, first.error
    assert owner.ok("GET", f"/documents/{doc}")["active_revision_id"] == ready.revision_id
    assert not any(p["revision_id"] == draft_id and p["active"] for p in worker.points(doc))

    second = worker.run(job_id)

    assert second.outcome is RunOutcome.SUCCEEDED, second.error
    assert owner.ok("GET", f"/documents/{doc}")["active_revision_id"] == draft_id
    active = [p for p in worker.points(doc) if p["active"]]
    assert any("늦은 교정" in p["content"] for p in active)
    assert _block_with(owner, doc, RAIN)["text"].endswith("첫 교정 늦은 교정")
    _cleanup_artifact(worker, ready)
