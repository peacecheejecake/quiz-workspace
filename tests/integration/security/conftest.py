"""Fixtures for the S4 security verification bundle (bypass, privilege escalation, CSRF, rate
limits, leakage).

Reuses the sharing contract stack (tests/integration/sharing/conftest.py: in-process production
app with APP_ENV=test, local Auth users, the `quiz_api` DB role and the in-process job worker),
loaded by path because conftest modules are not importable under `--import-mode=importlib`.

`World` is one fully populated workspace (a parsed and published book with revisions and blocks,
a CONFIRMED question, a generation run, an import run with a draft, a practice session, a share
link with Fork ON, a pending upload intent, a fork request of another user) plus an editor, a
viewer and an outsider. Its ids feed the operation table of `test_authz_matrix.py`, which is
generated from `contracts/openapi.json` so a new route cannot be left out.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import re
import sys
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
from book_core.contracts import DraftOrigin, QuestionDraft, QuestionType

_SHARING = Path(__file__).resolve().parents[1] / "sharing" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_s4_sharing_conftest", _SHARING)
assert _spec is not None
assert _spec.loader is not None
_s = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _s
_spec.loader.exec_module(_s)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _s.stack
job_worker = _s.job_worker
app_client = _s.app_client
seed = _s.seed

REPO_ROOT: Path = _s._m3.REPO_ROOT
OPENAPI = REPO_ROOT / "contracts" / "openapi.json"
API: str = _s.API
SHARE_COOKIE: str = _s.SHARE_COOKIE
NOT_FOUND_PROBLEM = "about:blank"
ARCHIVED: str = _s._m3.ARCHIVED
INSUFFICIENT_ROLE: str = _s._m3.INSUFFICIENT_ROLE
_PARAM = re.compile(r"\{([a-z_]+)\}")


@dataclass(frozen=True)
class Operation:
    operation_id: str
    method: str
    path: str  # OpenAPI template, e.g. /api/v1/documents/{document_id}
    secured: bool  # declares the Supabase bearer scheme

    @property
    def params(self) -> list[str]:
        return _PARAM.findall(self.path)

    def param_keys(self) -> list[str]:
        """Path params qualified by their collection (`revision_id` is ambiguous)."""
        top = self.path.removeprefix(API).split("/")[1]
        return [f"{name}@{top}" if name == "revision_id" else name for name in self.params]

    def url(self, ids: dict[str, str]) -> str:
        out = self.path.removeprefix(API)
        for name, key in zip(self.params, self.param_keys(), strict=True):
            out = out.replace(f"{{{name}}}", ids[key], 1)
        return out


def load_operations() -> list[Operation]:
    spec = json.loads(OPENAPI.read_text())
    ops: list[Operation] = []
    for path, methods in spec["paths"].items():
        for method, op in methods.items():
            ops.append(
                Operation(
                    op["operationId"],
                    method.upper(),
                    path,
                    any("SupabaseAccessToken" in s for s in op.get("security", [])),
                )
            )
    return ops


def random_ids() -> dict[str, str]:
    """A fresh, never-issued value for every id the operation table can need."""
    keys = (
        "workspace_id",
        "document_id",
        "revision_id@documents",
        "revision_id@questions",
        "job_id",
        "fork_id",
        "session_id",
        "draft_id",
        "generation_id",
        "batch_id",
        "import_id",
        "question_id",
        "link_id",
        "share_id",
        "upload_id",
        "draft_version",
        "question_revision",
    )
    out = {k: str(uuid.uuid4()) for k in keys}
    out["block_id"] = f"b-{uuid.uuid4().hex[:12]}"
    return out


@dataclass
class World:
    owner: Any
    editor: Any
    viewer: Any
    outsider: Any
    forker: Any
    ids: dict[str, str]
    twin_ids: dict[str, str]
    secret: str = field(repr=False)


def problem_key(res: httpx.Response) -> tuple[Any, ...]:
    """What an attacker can compare between two error responses (no per-request fields)."""
    try:
        body = res.json()
    except ValueError:
        return (res.status_code, res.text)
    if not isinstance(body, dict):
        return (res.status_code, "non-object")
    return (res.status_code, body.get("type"), body.get("title"), body.get("detail"))


def upload_pdf(client: Any, workspace_id: str, name: str) -> dict[str, Any]:
    """`Client.upload_book` for another fixture PDF: intent → direct PUT → complete-upload."""
    pdf = (_s._m3.PDF_DIR / name).read_bytes()
    sha256 = hashlib.sha256(pdf).hexdigest()
    res = client.upload_intent(workspace_id, filename=name, size_bytes=len(pdf), sha256=sha256)
    intent = client.ok_response(res, "POST", "/upload-intent", (200, 201))
    put = httpx.put(
        str(intent["upload_url"]),
        content=pdf,
        headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
        timeout=30,
    )
    assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
    done: dict[str, Any] = client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )
    return done


def build_world(seed: Any, label: str) -> World:
    owner = seed.client(f"s4-{label}-owner")
    editor = seed.client(f"s4-{label}-editor")
    viewer = seed.client(f"s4-{label}-viewer")
    outsider = seed.client(f"s4-{label}-outsider")
    forker = seed.client(f"s4-{label}-forker")
    outsider.create_workspace()  # an ordinary user with a workspace of their own

    ws = owner.create_workspace(f"S4 {label}")
    wid = str(ws["id"])
    seed.membership(wid, editor.user, "editor")
    seed.membership(wid, viewer.user, "viewer")

    _, _, done = owner.upload_book(wid)
    owner.wait_for_job(str(done["job_id"]))
    doc_id = str(done["document_id"])
    revisions = owner.ok("GET", f"/documents/{doc_id}/revisions")["items"]
    blocks = owner.ok("GET", f"/documents/{doc_id}/blocks?limit=5")["items"]
    question = owner.create_question(wid, f"S4 {label} 문제", answer=1)
    qid = str(question["id"])
    generation = owner.ok(
        "POST", f"/questions/{qid}/generations", {"variation_types": ["PARAPHRASE"]}, (202,)
    )
    batch = owner.ok(
        "POST",
        f"/workspaces/{wid}/question-generation-batches",
        {
            "selection": {"mode": "selected", "question_ids": [qid]},
            "variation_types": ["PARAPHRASE"],
        },
        (202,),
    )
    unpublished = seed.unpublished_questions(owner, wid)
    draft_id = unpublished["importDraft"]
    rows = seed._admin(
        "select import_run_id::text from public.question_drafts where id = %s", (draft_id,)
    )
    import_id = str(rows[0][0])
    # The shared S0 seed stores a bare payload; give the draft a complete QuestionDraft so the
    # draft routes can render it.
    payload = QuestionDraft(
        id=draft_id, origin=DraftOrigin.PDF_IMPORT, question_type=QuestionType.ESSAY, stem="S4 초안"
    ).model_dump(mode="json")
    seed._admin(
        "update public.question_drafts set payload = %s::jsonb where id = %s",
        (json.dumps(payload), draft_id),
    )
    session = owner.ok("POST", f"/questions/{qid}/practice-sessions", None, (200, 201))
    link = owner.create_link(wid, allow_fork=True)
    intent = owner.upload_intent(wid)
    assert intent.status_code in (200, 201), f"upload-intent: HTTP {intent.status_code}"

    forker.worker = None  # the fork request only has to exist; it is never copied
    cookie = seed.guest().session(link["id"], link["secret"])
    fork = forker.fork(str(link["id"]), cookie, f"S4 {label} fork")
    assert fork.status_code == 202, f"fork start: HTTP {fork.status_code}"

    # A second workspace of the same owner, for requests that mix ids of two workspaces.
    twin = owner.create_workspace(f"S4 {label} twin")
    tid = str(twin["id"])
    twin_done = upload_pdf(owner, tid, "book-en.pdf")  # other block ids than book-ko
    owner.wait_for_job(str(twin_done["job_id"]))
    twin_doc = str(twin_done["document_id"])
    twin_question = owner.create_question(tid, f"S4 {label} twin 문제")
    twin_link = owner.create_link(tid)
    twin_batch = owner.ok(
        "POST",
        f"/workspaces/{tid}/question-generation-batches",
        {
            "selection": {"mode": "selected", "question_ids": [str(twin_question["id"])]},
            "variation_types": ["PARAPHRASE"],
        },
        (202,),
    )

    ids = {
        "workspace_id": wid,
        "document_id": doc_id,
        "revision_id@documents": str(revisions[0]["id"]),
        "block_id": str(blocks[0]["block_id"]),
        "job_id": str(done["job_id"]),
        "fork_id": str(fork.json()["id"]),
        "session_id": str(session["id"]),
        "draft_id": draft_id,
        "generation_id": str(generation["id"]),
        "batch_id": str(batch["id"]),
        "import_id": import_id,
        "question_id": qid,
        "revision_id@questions": str(question["revision"]["id"]),
        "link_id": str(link["id"]),
        "share_id": str(link["id"]),
        "upload_id": str(intent.json()["upload_id"]),
        "draft_version": "1",
        "question_revision": str(question["revision"]["id"]),
    }
    twin_ids = {
        "workspace_id": tid,
        "document_id": twin_doc,
        "revision_id@documents": str(
            owner.ok("GET", f"/documents/{twin_doc}/revisions")["items"][0]["id"]
        ),
        "job_id": str(twin_done["job_id"]),
        "question_id": str(twin_question["id"]),
        "revision_id@questions": str(twin_question["revision"]["id"]),
        "link_id": str(twin_link["id"]),
        "share_id": str(twin_link["id"]),
        "batch_id": str(twin_batch["id"]),
    }
    return World(owner, editor, viewer, outsider, forker, ids, twin_ids, str(link["secret"]))


class LogCapture(logging.Handler):
    """Every record of every logger, formatted with the app's own redacting formatter (what the
    service would print) and raw (what a misconfigured handler would print)."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []
        self.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:  # pragma: no cover - a broken record is itself worth seeing
            self.lines.append(f"<unformattable record from {record.name}>")


@pytest.fixture
def logs() -> Iterator[LogCapture]:
    handler = LogCapture()
    root = logging.getLogger()
    previous = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


ShareSeed = _s.ShareSeed


class S4:
    """Helpers handed to the test modules (conftest is not importable under importlib mode)."""

    API = API
    ARCHIVED = ARCHIVED
    INSUFFICIENT_ROLE = INSUFFICIENT_ROLE
    SHARE_COOKIE = SHARE_COOKIE
    Operation = Operation
    World = World
    load_operations = staticmethod(load_operations)
    random_ids = staticmethod(random_ids)
    build_world = staticmethod(build_world)
    problem_key = staticmethod(problem_key)


@pytest.fixture(scope="session")
def s4() -> type[S4]:
    return S4


@pytest.fixture(scope="module")
def module_seed(stack: Any, app_client: Any, job_worker: Any) -> Iterator[Any]:
    """A `ShareSeed` that lives for the whole module (worlds are expensive to build)."""
    s = ShareSeed(stack, app_client)
    s.worker = job_worker
    try:
        yield s
    finally:
        job_worker.join()
        s.cleanup()
