"""S4 authorization matrix: every operation of contracts/openapi.json, every kind of caller.

docs/auth.md §4-§5, implementation-plan §7 (authorization responses): unknown, foreign,
soft-deleted and mismatched ids answer one identical 404; a member whose role lacks the action
gets 403 `insufficient-role`; a write to an archived workspace 403 `workspace-archived`; no JWT
401. A share session is never a login or a membership.

The operation list is read from the committed OpenAPI contract and `RULES` must classify every
operation (`test_every_operation_is_classified`), so a new route fails here until its expected
authorization is written down. Denials are executed for every caller; allowed writes are only
executed where they are personal and harmless (practice), so one module-scoped world serves all
parametrized cases. The `doomed` world is archived, then loses resources, then is deleted.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.infra

OPENAPI = Path(__file__).resolve().parents[3] / "contracts" / "openapi.json"
OWNER, EDITOR, VIEWER = "owner", "editor", "viewer"
ALL = frozenset({OWNER, EDITOR, VIEWER})
EDITORS = frozenset({OWNER, EDITOR})
OWNERS = frozenset({OWNER})


@dataclass(frozen=True)
class Rule:
    """Expected authorization of a workspace-scoped operation."""

    roles: frozenset[str]
    writes: bool
    archived_ok: bool = False
    # The resource belongs to one user (the world's owner): other members get the 404 too.
    personal: bool = False


READ = Rule(ALL, writes=False)
PRACTICE = Rule(ALL, writes=True)
OWN_READ = Rule(ALL, writes=False, personal=True)
OWN_WRITE = Rule(ALL, writes=True, personal=True)
EDIT = Rule(EDITORS, writes=True)
UPLOADER = Rule(EDITORS, writes=True, personal=True)
OWNER_WRITE = Rule(OWNERS, writes=True)
OWNER_LIFECYCLE = Rule(OWNERS, writes=True, archived_ok=True)
OWNER_READ = Rule(OWNERS, writes=False)

# Not workspace-scoped: the caller's own account data, the guest share API, health probes.
ME = "me"  # any signed-in user, own data only
MINE = "mine"  # a resource of one user (fork requests): everyone else 404
SHARED = "shared"  # guest share session (tests/integration/security/test_share_attacks.py)
PUBLIC = "public"

RULES: dict[str, Rule | str] = {
    # documents
    "completeDocumentUpload": UPLOADER,
    "deleteDocument": EDIT,
    "getDocument": READ,
    "listDocumentBlocks": READ,
    "getDocumentBlock": READ,
    "correctDocumentBlock": EDIT,
    "getDocumentOutline": READ,
    "publishDocumentDraft": EDIT,
    "listDocumentRevisions": READ,
    "restoreDocumentRevision": EDIT,
    "getDocumentSourceUrl": READ,
    "createDocumentUploadIntent": EDIT,
    "listDocuments": READ,
    # jobs
    "getJob": READ,
    "streamJobEvents": READ,
    "listWorkspaceJobs": READ,
    # practice (personal)
    "getPracticeSession": OWN_READ,
    "selfGradePracticeSession": OWN_WRITE,
    "submitPracticeSession": OWN_WRITE,
    "listMyQuestionAttempts": READ,
    "updateMyQuestionState": PRACTICE,
    "startPracticeSession": PRACTICE,
    "listMyWorkspaceAttempts": READ,
    # questions, drafts, generation, import
    "updateQuestionDraft": EDIT,
    "getQuestionGeneration": READ,
    "listQuestionGenerationDrafts": READ,
    "publishQuestionGenerationDrafts": EDIT,
    "getQuestionImport": READ,
    "listQuestionImportDrafts": READ,
    "publishQuestionImportDrafts": EDIT,
    "retryQuestionImport": EDIT,
    "deleteQuestion": EDIT,
    "getQuestion": READ,
    "updateQuestion": EDIT,
    "createQuestionGeneration": EDIT,
    "getQuestionRevision": READ,
    "listQuestionGenerations": READ,
    "listQuestionImports": READ,
    "createQuestionImport": EDIT,
    "listQuestions": READ,
    "createQuestion": EDIT,
    "getQuestionOverview": READ,
    "searchWorkspace": READ,
    # workspace lifecycle and sharing
    "getWorkspace": READ,
    "listWorkspaceActivities": READ,
    "deleteWorkspace": OWNER_LIFECYCLE,
    "updateWorkspace": OWNER_WRITE,
    "archiveWorkspace": OWNER_LIFECYCLE,
    "restoreWorkspace": OWNER_LIFECYCLE,
    "listShareLinks": OWNER_READ,
    "createShareLink": OWNER_WRITE,
    "updateShareLink": OWNER_LIFECYCLE,
    "revokeShareLink": OWNER_LIFECYCLE,
    "rotateShareLink": OWNER_WRITE,
    # account
    "getMe": ME,
    "listMyWorkspaces": ME,
    "listWorkspaces": ME,
    "createWorkspace": ME,
    "getMyFork": MINE,
    # guest share API
    "getSharedWorkspace": SHARED,
    "getSharedDocument": SHARED,
    "getSharedDocumentPdf": SHARED,
    "startWorkspaceFork": SHARED,
    "listSharedQuestions": SHARED,
    "getSharedQuestion": SHARED,
    "searchSharedWorkspace": SHARED,
    "createSharedSession": SHARED,
    # health
    "getLiveness": PUBLIC,
    "getReadiness": PUBLIC,
}


def _operation_ids() -> list[str]:
    spec = json.loads(OPENAPI.read_text())
    return [op["operationId"] for methods in spec["paths"].values() for op in methods.values()]


ALL_OPS = _operation_ids()
WORKSPACE_OPS = [o for o in ALL_OPS if isinstance(RULES.get(o), Rule)]
SECURED_OPS = [o for o in ALL_OPS if RULES.get(o) not in (PUBLIC, SHARED)] + ["startWorkspaceFork"]


def body_for(op_id: str, ids: dict[str, str]) -> Any:
    """A request body that passes validation, so authorization (not 422) decides."""
    mcq = {
        "question_type": "MCQ",
        "stem": "S4 문제",
        "options": [{"id": "opt-1", "text": "A"}, {"id": "opt-2", "text": "B"}],
        "correct_option_ids": ["opt-1"],
        "is_multi_answer": False,
    }
    reviewed = {"drafts": [{"draft_id": ids["draft_id"], "version": ids["draft_version"]}]}
    bodies: dict[str, Any] = {
        "completeDocumentUpload": {"upload_id": ids["upload_id"], "sha256": "0" * 64},
        "correctDocumentBlock": {"text": "S4 교정 시도"},
        "publishDocumentDraft": {},
        "selfGradePracticeSession": {"result": "correct"},
        "submitPracticeSession": {"selected_option_ids": ["opt-1"]},
        "updateQuestionDraft": {"base_version": ids["draft_version"], "stem": "S4 초안 변경"},
        "publishQuestionGenerationDrafts": reviewed,
        "publishQuestionImportDrafts": reviewed,
        "updateQuestion": {"base_revision_id": ids["question_revision"], "stem": "S4 변경"},
        "createQuestionGeneration": {"variation_types": ["PARAPHRASE"]},
        "updateMyQuestionState": {"is_favorite": True},
        "startWorkspaceFork": {"name": "S4 fork"},
        "searchSharedWorkspace": {"query": "S4"},
        "searchWorkspace": {"query": "S4"},
        "createSharedSession": {"secret": "x" * 43},
        "createWorkspace": {"name": "S4"},
        "updateWorkspace": {"name": "S4 renamed"},
        "createDocumentUploadIntent": {
            "filename": "s4.pdf",
            "size_bytes": 1024,
            "content_type": "application/pdf",
            "sha256": "0" * 64,
        },
        "createQuestionImport": {"document_id": ids["document_id"]},
        "createQuestion": mcq,
        "createShareLink": {},
        "updateShareLink": {"allow_fork": False},
    }
    return bodies.get(op_id)


def _op(s4: Any, op_id: str) -> Any:
    return next(o for o in s4.load_operations() if o.operation_id == op_id)


def call(
    s4: Any,
    http: Any,
    op: Any,
    ids: dict[str, str],
    *,
    token: str | None = None,
    cookie: str | None = None,
) -> httpx.Response:
    headers = {"Idempotency-Key": str(uuid.uuid4())}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if cookie:
        headers["Cookie"] = cookie
    body = body_for(op.operation_id, ids)
    res: httpx.Response = http.request(
        op.method, f"{s4.API}{op.url(ids)}", json=body, headers=headers
    )
    http.cookies.clear()
    return res


def _no_store(res: httpx.Response, what: str) -> None:
    assert "no-store" in res.headers.get("cache-control", ""), f"{what}: cacheable response"


@pytest.fixture(scope="module")
def world(module_seed: Any, s4: Any) -> Any:
    return s4.build_world(module_seed, "m")


@pytest.fixture(scope="module")
def share_cookie(module_seed: Any, world: Any) -> str:
    cookie: str = module_seed.guest().session(world.ids["share_id"], world.secret)
    return cookie


def test_every_operation_is_classified() -> None:
    unknown = sorted(set(ALL_OPS) - set(RULES))
    assert not unknown, f"classify the authorization of new operations in RULES: {unknown}"
    stale = sorted(set(RULES) - set(ALL_OPS))
    assert not stale, f"RULES lists operations the contract no longer has: {stale}"


def test_only_shared_and_health_operations_skip_the_bearer_scheme(s4: Any) -> None:
    for op in s4.load_operations():
        rule = RULES[op.operation_id]
        if rule in (PUBLIC, SHARED) and op.operation_id != "startWorkspaceFork":
            assert not op.secured, f"{op.operation_id} unexpectedly declares bearer auth"
        else:
            assert op.secured, f"{op.operation_id} must declare the bearer scheme"


@pytest.mark.parametrize("op_id", SECURED_OPS)
def test_no_jwt_is_401_even_with_a_share_session(
    op_id: str, s4: Any, world: Any, share_cookie: str, app_client: Any
) -> None:
    op = _op(s4, op_id)
    for cookie in (None, share_cookie):
        res = call(s4, app_client, op, world.ids, cookie=cookie)
        assert res.status_code == 401, f"{op_id} (cookie={bool(cookie)}): {res.status_code}"
        assert res.headers.get("www-authenticate", "").lower().startswith("bearer")
        _no_store(res, op_id)
    forged = call(s4, app_client, op, world.ids, token=f"{world.owner.user.token}x")
    assert forged.status_code == 401, f"{op_id} with a forged signature: {forged.status_code}"


@pytest.mark.parametrize("op_id", WORKSPACE_OPS)
def test_outsider_gets_the_same_404_as_an_unknown_id(
    op_id: str, s4: Any, world: Any, share_cookie: str, app_client: Any
) -> None:
    """Also with a valid share session of the workspace: a link is never a membership."""
    op = _op(s4, op_id)
    unknown = call(s4, app_client, op, s4.random_ids(), token=world.outsider.user.token)
    real = call(s4, app_client, op, world.ids, token=world.outsider.user.token, cookie=share_cookie)
    assert unknown.status_code == 404, f"{op_id} unknown id: {unknown.status_code}"
    assert s4.problem_key(real) == s4.problem_key(unknown), (
        f"{op_id}: outsider on a real id differs from an unknown id"
    )
    owner_unknown = call(s4, app_client, op, s4.random_ids(), token=world.owner.user.token)
    assert s4.problem_key(owner_unknown) == s4.problem_key(unknown), (
        f"{op_id}: unknown ids answer differently per caller"
    )
    _no_store(real, op_id)


@pytest.mark.parametrize("role", [VIEWER, EDITOR])
@pytest.mark.parametrize("op_id", WORKSPACE_OPS)
def test_member_role_matrix(op_id: str, role: str, s4: Any, world: Any, app_client: Any) -> None:
    rule = RULES[op_id]
    assert isinstance(rule, Rule)
    op = _op(s4, op_id)
    member = world.viewer if role == VIEWER else world.editor
    allowed = role in rule.roles
    if allowed and rule.writes and not rule.personal and rule is not PRACTICE:
        return  # allowed and not harmless: never executed, so the world stays intact
    res = call(s4, app_client, op, world.ids, token=member.user.token)
    _no_store(res, op_id)
    if not allowed:
        assert res.status_code == 403, f"{op_id} as {role}: {res.status_code} {res.text[:200]}"
        assert res.json()["type"] == s4.INSUFFICIENT_ROLE, f"{op_id} as {role}"
        return
    if rule.personal:
        unknown = call(s4, app_client, op, s4.random_ids(), token=member.user.token)
        assert s4.problem_key(res) == s4.problem_key(unknown), (
            f"{op_id}: another member reached the owner's personal resource ({res.status_code})"
        )
        return
    assert res.status_code < 400, f"{op_id} as {role}: {res.status_code} {res.text[:200]}"


def _multi_id_ops() -> list[str]:
    """Operations whose path names a parent and a child id. Block ids are structural and local to
    a document revision (`p1-b0` exists in every book), so they cannot belong to "another
    workspace" and are left out."""
    spec = json.loads(OPENAPI.read_text())
    out = []
    for path, methods in spec["paths"].items():
        params = [p for p in path.split("/") if p.startswith("{")]
        if len(params) >= 2 and params[-1] != "{block_id}":
            out += [op["operationId"] for op in methods.values()]
    return [o for o in out if isinstance(RULES.get(o), Rule)]


MULTI_ID_OPS = _multi_id_ops()


@pytest.mark.parametrize("op_id", MULTI_ID_OPS)
def test_ids_of_two_workspaces_never_combine(
    op_id: str, s4: Any, world: Any, app_client: Any
) -> None:
    """The owner of both workspaces still gets 404 for a child id of the other workspace."""
    op = _op(s4, op_id)
    child = op.param_keys()[-1]
    ids = {**world.ids, child: world.twin_ids[child]}
    res = call(s4, app_client, op, ids, token=world.owner.user.token)
    unknown = call(
        s4,
        app_client,
        op,
        {**world.ids, child: s4.random_ids()[child]},
        token=world.owner.user.token,
    )
    assert res.status_code == 404, f"{op_id} with a {child} of another workspace: {res.status_code}"
    assert s4.problem_key(res) == s4.problem_key(unknown)


def test_body_ids_of_another_workspace_answer_like_unknown_ids(
    s4: Any, world: Any, app_client: Any
) -> None:
    """Ids in bodies and query strings are resolved inside the path's workspace only: one of
    another workspace (even of the same owner) gets exactly the unknown-id answer."""
    owner = world.owner
    wid = world.ids["workspace_id"]
    foreign_doc = world.twin_ids["document_id"]
    unknown_doc = str(uuid.uuid4())
    cases = [
        ("POST", f"/workspaces/{wid}/question-imports", lambda d: {"document_id": d}),
        ("POST", f"/workspaces/{wid}/search", lambda d: {"query": "S4", "document_ids": [d]}),
    ]
    for method, path, body in cases:
        foreign = owner.call(method, path, body(foreign_doc))
        unknown = owner.call(method, path, body(unknown_doc))
        assert foreign.status_code >= 400, f"{path} accepted a foreign document"
        assert s4.problem_key(foreign) == s4.problem_key(unknown), f"{path}: existence oracle"
    patched = owner.call(
        "PATCH",
        f"/questions/{world.ids['question_id']}",
        {"base_revision_id": world.twin_ids["revision_id@questions"], "stem": "S4"},
    )
    assert patched.status_code == 409, f"foreign base revision: {patched.status_code}"
    listed = owner.ok("GET", f"/workspaces/{wid}/questions?document_id={foreign_doc}")
    assert listed["items"] == [], "a foreign document filter returned questions"
    assert owner.ok("GET", f"/questions/{world.ids['question_id']}")["revision"]["stem"] != "S4"


def test_my_fork_is_only_visible_to_its_requester(s4: Any, world: Any, app_client: Any) -> None:
    op = _op(s4, "getMyFork")
    mine = call(s4, app_client, op, world.ids, token=world.forker.user.token)
    assert mine.status_code == 200
    unknown = call(s4, app_client, op, s4.random_ids(), token=world.forker.user.token)
    for other in (world.owner, world.editor, world.viewer, world.outsider):
        res = call(s4, app_client, op, world.ids, token=other.user.token)
        assert s4.problem_key(res) == s4.problem_key(unknown), "someone else's fork is visible"


def test_a_fork_request_grants_nothing_on_the_source(s4: Any, world: Any, module_seed: Any) -> None:
    wid = world.ids["workspace_id"]
    assert (world.forker.user.id, "owner") not in module_seed.memberships(wid)
    assert world.forker.user.id not in {u for u, _ in module_seed.memberships(wid)}
    res = world.forker.call("GET", f"/workspaces/{wid}")
    assert res.status_code == 404
    listed = world.forker.ok("GET", "/me/workspaces")
    assert wid not in json.dumps(listed)


def test_denied_callers_left_no_trace(world: Any, module_seed: Any) -> None:
    """Runs after the matrix above: nothing the outsider sent was stored anywhere."""
    wid = world.ids["workspace_id"]
    outsider = world.outsider.user.id
    checks = {
        "activity_events": "actor_id",
        "async_jobs": "created_by",
        "questions": "created_by",
        "practice_sessions": "user_id",
        "question_user_states": "user_id",
        "documents": "created_by",
    }
    for table, column in checks.items():
        rows = module_seed._admin(
            f"select count(*) from public.{table} where workspace_id = %s and {column} = %s",  # noqa: S608
            (wid, outsider),
        )
        assert rows[0][0] == 0, f"{table} has rows written by an outsider"
    # Nothing a viewer or editor was refused changed the world either.
    owner = world.owner
    assert owner.ok("GET", f"/workspaces/{wid}")["name"] == "S4 m"
    assert owner.call("GET", f"/questions/{world.ids['question_id']}").status_code == 200
    assert owner.call("GET", f"/documents/{world.ids['document_id']}").status_code == 200
    links = owner.ok("GET", f"/workspaces/{wid}/share-links")["items"]
    assert [link["revoked_at"] for link in links] == [None]
    assert sorted(r for _, r in module_seed.memberships(wid)) == ["editor", "owner", "viewer"]


# --- archived → deleted resources → deleted workspace -------------------------------------------


@pytest.fixture(scope="module")
def doomed(module_seed: Any, s4: Any) -> Any:
    return s4.build_world(module_seed, "d")


def _expect(failures: list[str], ok: bool, message: str) -> None:
    if not ok:
        failures.append(message)


def test_archived_workspace_refuses_every_write_and_keeps_reads(
    s4: Any, doomed: Any, app_client: Any
) -> None:
    owner = doomed.owner
    wid = doomed.ids["workspace_id"]
    owner.ok("POST", f"/workspaces/{wid}/archive", None, (200,))
    failures: list[str] = []
    for op_id in WORKSPACE_OPS:
        rule = RULES[op_id]
        assert isinstance(rule, Rule)
        if rule.archived_ok:
            continue  # lifecycle / link revocation: allowed, and not executed here
        op = _op(s4, op_id)
        res = call(s4, app_client, op, doomed.ids, token=owner.user.token)
        if rule.writes:
            _expect(
                failures,
                res.status_code == 403 and res.json().get("type") == s4.ARCHIVED,
                f"{op_id}: {res.status_code} {res.text[:160]}",
            )
            for member in (doomed.editor, doomed.viewer):
                if rule.personal or rule.roles == OWNERS:
                    break  # someone else's session (404) / owner-only (403 role) are covered above
                again = call(s4, app_client, op, doomed.ids, token=member.user.token)
                _expect(failures, again.status_code == 403, f"{op_id} member: {again.status_code}")
        else:
            _expect(failures, res.status_code < 400, f"{op_id} read: {res.status_code}")
    owner.ok("POST", f"/workspaces/{wid}/restore", None, (200,))
    assert not failures, "archived workspace:\n" + "\n".join(failures)


def test_deleted_resources_answer_the_unknown_id_404(s4: Any, doomed: Any, app_client: Any) -> None:
    owner = doomed.owner
    owner.ok("DELETE", f"/questions/{doomed.ids['question_id']}", None, (200, 204))
    owner.ok("DELETE", f"/documents/{doomed.ids['document_id']}", None, (200, 202, 204))
    failures: list[str] = []
    for op_id in WORKSPACE_OPS:
        op = _op(s4, op_id)
        params = set(op.params)
        if not params & {"question_id", "document_id"}:
            continue
        res = call(s4, app_client, op, doomed.ids, token=owner.user.token)
        unknown = call(s4, app_client, op, s4.random_ids(), token=owner.user.token)
        _expect(
            failures,
            s4.problem_key(res) == s4.problem_key(unknown),
            f"{op_id}: {res.status_code} vs unknown {unknown.status_code}",
        )
    assert not failures, "deleted resources:\n" + "\n".join(failures)


def test_soft_deleted_workspace_is_404_for_every_route_and_caller(
    s4: Any, doomed: Any, app_client: Any, module_seed: Any
) -> None:
    owner = doomed.owner
    wid = doomed.ids["workspace_id"]
    cookie = module_seed.guest().session(doomed.ids["share_id"], doomed.secret)
    owner.ok("DELETE", f"/workspaces/{wid}", None, (200, 202, 204))
    failures: list[str] = []
    for op_id in WORKSPACE_OPS:
        op = _op(s4, op_id)
        unknown = call(s4, app_client, op, s4.random_ids(), token=owner.user.token)
        for role, member in ((OWNER, owner), (EDITOR, doomed.editor), (VIEWER, doomed.viewer)):
            res = call(s4, app_client, op, doomed.ids, token=member.user.token)
            _expect(
                failures,
                s4.problem_key(res) == s4.problem_key(unknown),
                f"{op_id} ({role}): {res.status_code}",
            )
    # The guest session of the deleted workspace is over too.
    shared = module_seed.guest().read(doomed.ids["share_id"], cookie)
    _expect(failures, shared.status_code == 404, f"shared read after delete: {shared.status_code}")
    assert not failures, "soft-deleted workspace:\n" + "\n".join(failures)


ANSWER_KEYS = ("correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer")


def test_practice_routes_never_reveal_answers_before_submission(world: Any) -> None:
    """Every route a learner touches before submitting (open/resume a session, the overview with
    its preview, personal history and state) carries neither answer fields nor the explanation."""
    wid = world.ids["workspace_id"]
    qid = world.ids["question_id"]
    explanation = world.owner.ok("GET", f"/questions/{qid}")["revision"]["explanation"]
    assert explanation, "the world's question needs an explanation for this check"
    for learner in (world.viewer, world.owner):
        opened = learner.call("POST", f"/questions/{qid}/practice-sessions", None)
        assert opened.status_code in (200, 201)
        session = opened.json()["id"]
        responses = [
            opened,
            learner.call("GET", f"/practice-sessions/{session}"),
            learner.call("GET", f"/workspaces/{wid}/questions/overview"),
            learner.call("GET", f"/workspaces/{wid}/attempts"),
            learner.call("GET", f"/questions/{qid}/attempts"),
            learner.call("GET", f"/workspaces/{wid}/activities"),
            learner.call("PATCH", f"/questions/{qid}/my-state", {"needs_retry": True}),
        ]
        for res in responses:
            path = res.request.url.path
            assert res.status_code < 400, f"{path}: {res.status_code}"
            assert explanation not in res.text, f"{path} reveals the explanation"
            for key in ANSWER_KEYS:
                assert f'"{key}"' not in res.text, f"{path} carries {key}"
