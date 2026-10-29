"""S4 attacks on the guest share capability (docs/workspace-sharing.md §1-§6).

Every operation under `/api/v1/shared/{share_id}` is taken from contracts/openapi.json, so a new
shared route is attacked here automatically: without a session, with a forged one, with the
session of another link, with ids of another workspace, and after the link was revoked, expired,
rotated or its workspace deleted. A guest session never reaches the member API, and shared
answers never carry drafts, unpublished revisions, personal data or secrets.
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
SHARED_PREFIX = "/api/v1/shared/{share_id}"
SESSION_REQUIRED = "urn:quiz-workspace:problem:share-session-required"
UNAVAILABLE = "urn:quiz-workspace:problem:share-unavailable"
FORK_NOT_ALLOWED = "urn:quiz-workspace:problem:fork-not-allowed"
DRAFT_MARKER = "S4-UNPUBLISHED-DRAFT-MARKER"


@dataclass(frozen=True)
class SharedOp:
    operation_id: str
    method: str
    path: str


def _shared_ops() -> list[SharedOp]:
    spec = json.loads(OPENAPI.read_text())
    ops = [
        SharedOp(op["operationId"], method.upper(), path)
        for path, methods in spec["paths"].items()
        for method, op in methods.items()
        if path.startswith(SHARED_PREFIX)
    ]
    return [o for o in ops if not o.path.endswith("/sessions")]


SHARED_OPS = _shared_ops()
FORK = "startWorkspaceFork"


def _body(op: SharedOp) -> Any:
    if op.operation_id == FORK:
        return {"name": "S4 fork"}
    if op.method == "POST":
        return {"query": "물"}
    return None


@dataclass
class Shared:
    seed: Any
    owner: Any
    forker: Any
    ws: str
    doc: str
    question: str
    other_ws: str
    other_doc: str
    other_question: str
    other_link: dict[str, Any]
    chapter: str

    def link(self, **policy: Any) -> tuple[dict[str, Any], str]:
        link = self.owner.create_link(self.ws, **{"allow_fork": True, **policy})
        cookie = self.seed.guest().session(link["id"], link["secret"])
        return link, cookie

    def send(
        self,
        op: SharedOp,
        share_id: str,
        cookie: str | None,
        *,
        doc: str | None = None,
        question: str | None = None,
    ) -> httpx.Response:
        url = (
            op.path.removeprefix(self.seed_api())
            .replace("{share_id}", share_id)
            .replace("{document_id}", doc or self.doc)
            .replace("{question_id}", question or self.question)
            .replace("{chapter_id}", self.chapter)
        )
        if op.operation_id == FORK:
            # Fork needs the user JWT and the web Origin as well; the session is what is attacked.
            return self.forker.send(
                op.method,
                url,
                _body(op),
                cookie=cookie,
                origin=self.seed.web_origin(),
                headers={"Idempotency-Key": str(uuid.uuid4())},
            )
        return self.seed.guest().send(op.method, url, _body(op), cookie=cookie)

    @staticmethod
    def seed_api() -> str:
        return "/api/v1"


# DOCSUM-B: the shared summary route serves only a succeeded summary of the current revision, so
# the positive controls need one. Seeded directly (the summary job is covered by
# tests/integration/documents/summary); synthetic text only.
_SEED_SUMMARY = """
with d as (
  select id, workspace_id, active_revision_id from public.documents where id = %s
), r as (
  insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                            status, trigger, finished_at)
  select workspace_id, id, active_revision_id, 'succeeded', 'manual', now() from d
  returning id, workspace_id
), u as (
  insert into public.document_summary_units (workspace_id, document_id, scope, section_key,
                                             input_hash, prompt_version, model, body)
  select workspace_id, id, 'document', 'document', repeat('5', 64), 's4', 's4',
         '{"title": "S4", "summary_md": "S4 요약", "key_points": []}'::jsonb from d
  returning id, workspace_id
)
insert into public.document_summary_run_units (workspace_id, run_id, unit_id, position)
select r.workspace_id, r.id, u.id, 0 from r, u
"""


@pytest.fixture(scope="module")
def shared(module_seed: Any) -> Shared:
    seed = module_seed
    owner = seed.client("s4-share-owner")
    forker = seed.client("s4-share-forker")
    forker.worker = None  # accepted forks are only recorded, never copied
    ws = owner.create_workspace("S4 shared")
    _, _, done = owner.upload_book(ws["id"])
    owner.wait_for_job(str(done["job_id"]))
    question = owner.create_question(ws["id"], "S4 공유 문제", answer=2)
    other = owner.create_workspace("S4 shared other")
    _, _, other_done = owner.upload_book(other["id"])
    owner.wait_for_job(str(other_done["job_id"]))
    other_question = owner.create_question(other["id"], "S4 다른 공유 문제")
    other_link = owner.create_link(other["id"], allow_fork=True)
    for document_id in (done["document_id"], other_done["document_id"]):
        seed._admin(_SEED_SUMMARY, (str(document_id),))
    chapter = _seed_chapter_note(seed, owner, str(done["document_id"]), question)
    return Shared(
        seed,
        owner,
        forker,
        str(ws["id"]),
        str(done["document_id"]),
        str(question["id"]),
        str(other["id"]),
        str(other_done["document_id"]),
        str(other_question["id"]),
        other_link,
        chapter,
    )


def _seed_chapter_note(seed: Any, owner: Any, document_id: str, question: dict[str, Any]) -> str:
    """A succeeded, source-matched chapter note (CHNOTE-01) on the book's first chapter citing the
    shared question, written as the superuser (no LLM job needed for the share checks)."""
    chapter = owner.ok("GET", f"/documents/{document_id}/outline")["items"][0]
    refs = [
        {
            "tag": "Q1",
            "question_id": str(question["id"]),
            "question_revision_id": str(question["revision"]["id"]),
            "label": "1장 1번",
        }
    ]
    body = {"sections": [{"heading": "S4", "items": [{"text": "S4 정리 노트", "tags": ["Q1"]}]}]}
    seed._admin(
        "insert into public.chapter_notes (workspace_id, document_id, document_revision_id, "
        "section_key, version, status, input_fingerprint, body_hash, question_refs, body, "
        "created_by, finished_at) "
        "select c.workspace_id, c.document_id, c.document_revision_id, c.section_key, 1, "
        "'succeeded', %s, %s, %s::jsonb, %s::jsonb, %s, now() "
        "from public.chapters c where c.id = %s",
        ("0" * 64, "0" * 64, json.dumps(refs), json.dumps(body), owner.user.id, chapter["id"]),
    )
    return str(chapter["id"])


def _type(res: httpx.Response) -> str | None:
    try:
        body = res.json()
    except ValueError:
        return None
    return body.get("type") if isinstance(body, dict) else None


def _privacy(res: httpx.Response, what: str) -> None:
    if res.request.url.path.endswith("/forks"):
        return  # the fork start is a member write: plain no-store
    assert "private" in res.headers.get("cache-control", ""), f"{what}: cache-control"
    assert "no-store" in res.headers.get("cache-control", ""), f"{what}: cache-control"
    assert "noindex" in res.headers.get("x-robots-tag", ""), f"{what}: x-robots-tag"
    assert res.headers.get("referrer-policy") == "no-referrer", f"{what}: referrer-policy"


def test_shared_operations_are_enumerated_from_the_contract() -> None:
    names = {o.operation_id for o in SHARED_OPS}
    assert {"getSharedWorkspace", "getSharedDocumentPdf", "searchSharedWorkspace", FORK} <= names


@pytest.mark.parametrize("op", SHARED_OPS, ids=lambda o: o.operation_id)
def test_a_live_session_reads_and_nothing_else_does(op: SharedOp, shared: Shared) -> None:
    link, cookie = shared.link()
    ok = shared.send(op, link["id"], cookie)
    assert ok.status_code in {200, 202}, f"positive control: {ok.status_code} {ok.text[:200]}"
    _privacy(ok, op.operation_id)

    missing = 403 if op.operation_id == FORK else 401
    for label, bad in (
        ("none", None),
        ("garbage", f"{shared.seed.SHARE_COOKIE}=garbage"),
        ("forged mac", cookie[:-3] + ("AAA" if not cookie.endswith("AAA") else "BBB")),
        ("forged expiry", _bump_expiry(cookie)),
        ("unsigned link swap", cookie.replace(link["id"].replace("-", ""), uuid.uuid4().hex)),
    ):
        res = shared.send(op, link["id"], bad)
        assert (res.status_code, _type(res)) == (missing, SESSION_REQUIRED), (
            f"{label}: {res.status_code}"
        )
        _privacy(res, f"{op.operation_id} {label}")

    # The session of another live link (another workspace) never opens this one, and this
    # session never opens the other link either.
    other_cookie = shared.seed.guest().session(shared.other_link["id"], shared.other_link["secret"])
    for share_id, session in ((link["id"], other_cookie), (shared.other_link["id"], cookie)):
        res = shared.send(op, share_id, session)
        assert (res.status_code, _type(res)) == (404, UNAVAILABLE), f"cross-link: {res.status_code}"


def _bump_expiry(cookie: str) -> str:
    name, value = cookie.split("=", 1)
    version, link, expiry, mac = value.split(".")
    return f"{name}={version}.{link}.{int(expiry) + 3600}.{mac}"


@pytest.mark.parametrize(
    "op",
    [o for o in SHARED_OPS if "{document_id}" in o.path or "{question_id}" in o.path],
    ids=lambda o: o.operation_id,
)
def test_ids_of_another_workspace_are_404_through_a_valid_session(
    op: SharedOp, shared: Shared
) -> None:
    link, cookie = shared.link()
    foreign = shared.send(
        op, link["id"], cookie, doc=shared.other_doc, question=shared.other_question
    )
    unknown = shared.send(op, link["id"], cookie, doc=str(uuid.uuid4()), question=str(uuid.uuid4()))
    assert foreign.status_code == 404, f"{op.operation_id}: {foreign.status_code}"
    assert _strip(foreign) == _strip(unknown), "foreign id answers differently from an unknown id"


def _strip(res: httpx.Response) -> dict[str, Any]:
    body: dict[str, Any] = res.json()
    return {k: v for k, v in body.items() if k not in {"instance", "request_id"}}


def test_search_and_filters_never_widen_to_another_workspace(shared: Shared) -> None:
    link, cookie = shared.link()
    guest = shared.seed.guest()
    for body in (
        {"query": "물", "document_ids": [shared.other_doc]},
        {"query": "물", "workspace_id": shared.other_ws},
    ):
        res = guest.send("POST", f"/shared/{link['id']}/search", body, cookie=cookie)
        assert res.status_code in {404, 422}, f"search {sorted(body)}: {res.status_code}"
    listed = guest.send(
        "GET", f"/shared/{link['id']}/questions?document_id={shared.other_doc}", cookie=cookie
    )
    assert listed.status_code == 200
    assert listed.json()["items"] == []
    hits = guest.send("POST", f"/shared/{link['id']}/search", {"query": "물"}, cookie=cookie).json()
    assert {h["document_id"] for h in hits["items"]} <= {shared.doc}


@pytest.mark.parametrize("kill", ["revoke", "expire", "rotate"])
def test_revoke_expire_and_rotate_end_live_sessions_on_every_route(
    kill: str, shared: Shared
) -> None:
    link, cookie = shared.link()
    assert shared.send(SHARED_OPS[0], link["id"], cookie).status_code == 200
    if kill == "revoke":
        shared.seed.assert_status(shared.owner.revoke(shared.ws, link["id"]), 200, "revoke")
    elif kill == "expire":
        shared.seed.expire_now(link["id"])
    else:
        rotated = shared.owner.rotate(shared.ws, link["id"])
        shared.seed.assert_status(rotated, {200, 201}, "rotate")
        new = rotated.json()
        # The old secret no longer exchanges; the new link does not accept the old session.
        old = shared.seed.guest().exchange(link["id"], link["secret"])
        assert (old.status_code, _type(old)) == (404, UNAVAILABLE)
        res = shared.send(SHARED_OPS[0], new["id"], cookie)
        assert (res.status_code, _type(res)) == (404, UNAVAILABLE)
    for op in SHARED_OPS:
        res = shared.send(op, link["id"], cookie)
        assert (res.status_code, _type(res)) == (404, UNAVAILABLE), (
            f"{kill}: {op.operation_id} answered {res.status_code}"
        )
        assert b"%PDF" not in res.content


def test_fork_off_blocks_forks_but_keeps_reading(shared: Shared) -> None:
    link, cookie = shared.link()
    patched = shared.owner.patch_link(shared.ws, link["id"], allow_fork=False)
    shared.seed.assert_status(patched, 200, "fork OFF")
    for op in SHARED_OPS:
        res = shared.send(op, link["id"], cookie)
        if op.operation_id == FORK:
            assert (res.status_code, _type(res)) == (403, FORK_NOT_ALLOWED)
        else:
            assert res.status_code == 200, f"{op.operation_id}: {res.status_code}"


def test_a_guest_session_is_not_a_login_on_any_member_route(shared: Shared) -> None:
    """The share cookie, also sent with the member path layout, never authenticates."""
    link, cookie = shared.link()
    guest = shared.seed.guest()
    spec = json.loads(OPENAPI.read_text())
    ids = {
        "workspace_id": shared.ws,
        "document_id": shared.doc,
        "question_id": shared.question,
        "link_id": link["id"],
    }
    for path, methods in spec["paths"].items():
        if path.startswith(SHARED_PREFIX) or path.startswith("/health"):
            continue
        url = path.removeprefix("/api/v1")
        for name, value in ids.items():
            url = url.replace(f"{{{name}}}", value)
        url = url.replace("{", "").replace("}", "")  # remaining ids: any value
        for method in methods:
            res = guest.send(method.upper(), url, {}, cookie=cookie)
            assert res.status_code == 401, f"{method.upper()} {path}: {res.status_code}"
    assert shared.seed.memberships(shared.ws) == [(shared.owner.user.id, "owner")]


def test_unpublished_corrections_and_private_data_never_reach_the_share(shared: Shared) -> None:
    owner = shared.owner
    link, cookie = shared.link()
    block = owner.ok("GET", f"/documents/{shared.doc}/blocks?limit=1")["items"][0]
    owner.ok(
        "PATCH",
        f"/documents/{shared.doc}/blocks/{block['block_id']}",
        {"text": f"{DRAFT_MARKER} 교정 초안"},
        (200,),
    )
    shared.seed.study_state(owner.user.id, shared.ws, shared.question)
    secret_digest = shared.seed.link_row(link["id"])[1].hex()
    forbidden = {
        "draft text": DRAFT_MARKER,
        "owner id": owner.user.id,
        "owner email": owner.user.email,
        "secret": link["secret"],
        "digest": secret_digest,
        "storage key": f"workspaces/{shared.ws}/",
        "signed url": "token=",
        "favourite": "is_favorite",
        "retry": "needs_retry",
    }
    guest = shared.seed.guest()
    responses: list[httpx.Response] = [shared.send(op, link["id"], cookie) for op in SHARED_OPS]
    responses.append(
        guest.send("POST", f"/shared/{link['id']}/search", {"query": DRAFT_MARKER}, cookie=cookie)
    )
    responses.append(
        guest.send("GET", f"/shared/{link['id']}/documents/{shared.doc}?limit=500", cookie=cookie)
    )
    for res in responses:
        if res.headers.get("content-type", "").startswith("application/pdf"):
            continue
        text = res.text
        for what, value in forbidden.items():
            assert (value in text) is False, f"{res.request.url.path} leaks the {what}"
