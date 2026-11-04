"""Fixtures for the S4 security verification bundle (bypass, privilege escalation, CSRF, rate
limits, leakage).

Reuses the sharing contract stack (tests/integration/sharing/conftest.py: in-process production
app with APP_ENV=test, local Auth users, the `quiz_api` DB role and the in-process job worker),
loaded by path because conftest modules are not importable under `--import-mode=importlib`.

`World` is one fully populated workspace (a parsed and published book with revisions and blocks,
a CONFIRMED question, an import run with a draft, a practice session, a share
link with Fork ON, a pending upload intent, a fork request of another user, a made mock exam)
plus an editor, a viewer and an outsider. Its ids feed the operation table of
`test_authz_matrix.py`, which is generated from `contracts/openapi.json` so a new route cannot be
left out.
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
        "run_id",
        "draft_id",
        "import_id",
        "registration_id",
        "question_id",
        "link_id",
        "share_id",
        "upload_id",
        "draft_version",
        "question_revision",
        "chapter_id",
        "mock_exam_id",
        "mock_exam_question_id",
        "mock_practice_session_id",
        "highlight_id",
        "conversation_id",
        "message_id",
        "explanation_id",
        "mock_explanation_id",
    )
    out = {k: str(uuid.uuid4()) for k in keys}
    out["block_id"] = f"b-{uuid.uuid4().hex[:12]}"
    out["position"] = "1"  # a run position, not an id (the run id is the random part)
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
    chapter_id = str(owner.ok("GET", f"/documents/{doc_id}/outline")["items"][0]["id"])
    question = owner.create_question(wid, f"S4 {label} 문제", answer=1)
    qid = str(question["id"])
    unpublished = seed.unpublished_questions(owner, wid)
    draft_id = unpublished["importDraft"]
    rows = seed._admin(
        "select import_run_id::text from public.question_drafts where id = %s", (draft_id,)
    )
    import_id = str(rows[0][0])
    # QSRC-API: an import-provenance region on the question (and so on its 보기 섞기 mock
    # question), so the source-region reads have a 2xx to protect.
    seed._admin(
        "insert into public.question_sources (workspace_id, question_id, document_id, "
        "document_revision_id, page_start, page_end, locations, import_run_id) "
        "select q.workspace_id, q.id, d.id, d.active_revision_id, 1, 1, %s::jsonb, %s "
        "from public.questions q join public.documents d on d.id = %s where q.id = %s",
        (
            json.dumps([{"page": 1, "bbox": {"x0": 10.0, "y0": 20.0, "x1": 200.0, "y1": 80.0}}]),
            import_id,
            doc_id,
            qid,
        ),
    )
    # The shared S0 seed stores a bare payload; give the draft a complete QuestionDraft so the
    # draft routes can render it.
    payload = QuestionDraft(
        id=draft_id, origin=DraftOrigin.PDF_IMPORT, question_type=QuestionType.ESSAY, stem="S4 초안"
    ).model_dump(mode="json")
    seed._admin(
        "update public.question_drafts set payload = %s::jsonb where id = %s",
        (json.dumps(payload), draft_id),
    )
    # QIMP-JOB: a registration of the import (its job stays queued: nothing drains it here).
    seeded = next(
        d
        for d in owner.ok("GET", f"/question-imports/{import_id}/drafts")["items"]
        if d["id"] == draft_id
    )
    registration = owner.ok(
        "POST",
        f"/question-imports/{import_id}/registrations",
        {"drafts": [{"draft_id": draft_id, "version": seeded["version"]}]},
        (202,),
    )
    session = owner.ok("POST", f"/questions/{qid}/practice-sessions", None, (200, 201))
    run = owner.ok(
        "POST",
        f"/workspaces/{wid}/practice-runs",
        {"source": "bank", "range": {"all": True}},
        (201,),
    )
    link = owner.create_link(wid, allow_fork=True)
    intent = owner.upload_intent(wid)
    assert intent.status_code in (200, 201), f"upload-intent: HTTP {intent.status_code}"

    forker.worker = None  # the fork request only has to exist; it is never copied
    cookie = seed.guest().session(link["id"], link["secret"])
    fork = forker.fork(str(link["id"]), cookie, f"S4 {label} fork")
    assert fork.status_code == 202, f"fork start: HTTP {fork.status_code}"

    # MOCK-B: a made mock exam with one question (보기 섞기, no LLM).
    mock_exam_id, mock_question_id = make_mock_exam(owner, wid, qid)
    # MOCK-P: the owner's open practice session of that mock exam question.
    mock_session = owner.ok(
        "POST", f"/mock-exam-questions/{mock_question_id}/practice-sessions", None, (201,)
    )

    # UX9-HL-B: the owner's highlight of the question's explanation (personal: other
    # members get the unknown-id 404).
    highlight = owner.ok(
        "POST",
        "/my-highlights",
        {
            "target": {"kind": "explanation", "question_id": qid},
            "anchor": {"block": "p0", "start": 0, "end": 1},
            "color": "yellow",
        },
        (201,),
    )

    # ASK-B: the owner's conversation with one finished answer (direct seed: asking needs the
    # feature on, which this stack leaves off; the routes check ownership before the switch).
    conversation = owner.ok("POST", f"/workspaces/{wid}/ask/conversations", {}, (201,))
    question_message, answer_message = (str(uuid.uuid4()) for _ in range(2))
    seed._admin(
        "insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, "
        "status, text) values (%s, %s, %s, %s, 'user', 'succeeded', 'S4 질문')",
        (question_message, conversation["id"], wid, owner.user.id),
    )
    seed._admin(
        "insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, "
        "status, question_message_id, text, finished_at) values (%s, %s, %s, %s, 'assistant', "
        "'succeeded', %s, 'S4 답', now())",
        (answer_message, conversation["id"], wid, owner.user.id, question_message),
    )

    # EXPL-B: a finished AI explanation of the question and of the mock exam question (direct
    # seed: making one needs the feature on, which this stack leaves off).
    explanation_id, mock_explanation_id = (str(uuid.uuid4()) for _ in range(2))
    body = json.dumps(
        {"correct_option_ids": [], "summary_md": "S4 AI 해설", "options": [], "concepts_md": ""}
    )
    seed._admin(
        "insert into public.question_ai_explanations (id, workspace_id, question_id, "
        "question_revision_id, status, prompt_version, model, body, finished_at) values "
        "(%s, %s, %s, %s, 'succeeded', 's4/v1', 's4', %s::jsonb, now())",
        (explanation_id, wid, qid, question["revision"]["id"], body),
    )
    seed._admin(
        "insert into public.mock_exam_question_ai_explanations (id, workspace_id, "
        "mock_exam_question_id, mock_exam_question_revision_id, status, prompt_version, model, "
        "body, finished_at) select %s, workspace_id, id, active_revision_id, 'succeeded', "
        "'s4/v1', 's4', %s::jsonb, now() from public.mock_exam_questions where id = %s",
        (mock_explanation_id, body, mock_question_id),
    )

    # A second workspace of the same owner, for requests that mix ids of two workspaces.
    twin = owner.create_workspace(f"S4 {label} twin")
    tid = str(twin["id"])
    twin_done = upload_pdf(owner, tid, "book-en.pdf")  # other block ids than book-ko
    owner.wait_for_job(str(twin_done["job_id"]))
    twin_doc = str(twin_done["document_id"])
    twin_question = owner.create_question(tid, f"S4 {label} twin 문제")
    twin_link = owner.create_link(tid)

    ids = {
        "workspace_id": wid,
        "document_id": doc_id,
        "revision_id@documents": str(revisions[0]["id"]),
        "block_id": str(blocks[0]["block_id"]),
        "job_id": str(done["job_id"]),
        "fork_id": str(fork.json()["id"]),
        "session_id": str(session["id"]),
        "run_id": str(run["id"]),
        "position": "1",
        "draft_id": draft_id,
        "import_id": import_id,
        "registration_id": str(registration["job_id"]),
        "question_id": qid,
        "revision_id@questions": str(question["revision"]["id"]),
        "link_id": str(link["id"]),
        "share_id": str(link["id"]),
        "upload_id": str(intent.json()["upload_id"]),
        "draft_version": "1",
        "question_revision": str(question["revision"]["id"]),
        "chapter_id": chapter_id,
        "mock_exam_id": mock_exam_id,
        "mock_exam_question_id": mock_question_id,
        "mock_practice_session_id": str(mock_session["id"]),
        "highlight_id": str(highlight["id"]),
        "conversation_id": str(conversation["id"]),
        "message_id": answer_message,
        "explanation_id": explanation_id,
        "mock_explanation_id": mock_explanation_id,
    }
    twin_ids = {
        "workspace_id": tid,
        "document_id": twin_doc,
        "revision_id@documents": str(
            owner.ok("GET", f"/documents/{twin_doc}/revisions")["items"][0]["id"]
        ),
        "job_id": str(twin_done["job_id"]),
        # A real job of the other workspace stands in for its registration (child id).
        "registration_id": str(twin_done["job_id"]),
        "question_id": str(twin_question["id"]),
        "revision_id@questions": str(twin_question["revision"]["id"]),
        "link_id": str(twin_link["id"]),
        "share_id": str(twin_link["id"]),
        "chapter_id": str(owner.ok("GET", f"/documents/{twin_doc}/outline")["items"][0]["id"]),
    }
    return World(owner, editor, viewer, outsider, forker, ids, twin_ids, str(link["secret"]))


def make_mock_exam(owner: Any, workspace_id: str, question_id: str) -> tuple[str, str]:
    """A succeeded OPTION_SHUFFLE mock exam of one question, made through the API."""
    made = owner.ok(
        "POST",
        f"/workspaces/{workspace_id}/mock-exams",
        {
            "title": "S4 모의고사",
            "config": {"variation_types": ["OPTION_SHUFFLE"], "question_count": 1},
            "range": {"question_ids": [question_id]},
        },
        (202,),
    )
    exam_id = str(made["id"])
    owner.wait_for_job(str(made["latest_generation"]["job_id"]))
    after = owner.ok("GET", f"/mock-exams/{exam_id}")
    assert after["status"] == "ready", after["latest_generation"]
    [item] = owner.ok("GET", f"/mock-exams/{exam_id}/questions")["items"]
    return exam_id, str(item["id"])


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
