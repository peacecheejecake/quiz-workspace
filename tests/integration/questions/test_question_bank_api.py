"""M4.2a question bank API guarantees beyond the QBANK-01 contract tests.

Publication-status transitions, soft delete, Idempotency-Key replay, PATCH semantics (partial,
no-op, type change), chapter links (outline node of a document's *current* revision), sources,
filters/pagination, and answer-free activity events. Documents and chapters are seeded directly
with the `postgres` superuser (the outline/publish API is M3.4); everything else goes through
the public API. Fixtures: conftest.py.
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import uuid
from typing import Any
from urllib.parse import quote

import psycopg
import pytest

pytestmark = pytest.mark.infra

NOT_FOUND = "Not found."
# Same local superuser as conftest.py (conftest modules are not importable under importlib mode).
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _seed_document(workspace_id: str, sections: list[str], revisions: int = 2) -> dict[str, Any]:
    """A ready document with `revisions` published revisions, each with one chapter per section
    key; the last one is active. Returns {id, chapters: [{section_key: chapter_id}] per rev}."""
    doc_id = str(uuid.uuid4())
    out: dict[str, Any] = {"id": doc_id, "chapters": []}
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        key = f"workspaces/{workspace_id}/documents/{doc_id}/revisions/{uuid.uuid4()}/source.pdf"
        conn.execute(
            "insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256, "
            "source_object_key, status) values (%s, %s, 'Book', 'book.pdf', 10, %s, %s, "
            "'processing')",
            (doc_id, workspace_id, hashlib.sha256(doc_id.encode()).hexdigest(), key),
        )
        parent = None
        for n in range(1, revisions + 1):
            rev_id = str(uuid.uuid4())
            conn.execute(
                "insert into public.document_revisions (id, workspace_id, document_id, "
                "revision_number, parent_revision_id, source_object_key) "
                "values (%s, %s, %s, %s, %s, %s)",
                (rev_id, workspace_id, doc_id, n, parent, key),
            )
            chapters: dict[str, str] = {}
            for i, section in enumerate(sections):
                chapters[section] = str(
                    conn.execute(
                        "insert into public.chapters (workspace_id, document_id, "
                        "document_revision_id, section_key, level, sort_order, title) "
                        "values (%s, %s, %s, %s, 1, %s, %s) returning id",
                        (workspace_id, doc_id, rev_id, section, i, f"{i + 1}장 {section}"),
                    ).fetchone()[0]  # type: ignore[index]
                )
            conn.execute(
                "update public.document_revisions set status = 'published', "
                "published_at = now() where id = %s",
                (rev_id,),
            )
            out["chapters"].append(chapters)
            out["active_revision_id"] = rev_id
            parent = rev_id
        conn.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (parent, doc_id),
        )
    return out


def _events(question_id: str) -> list[tuple[str, dict[str, Any]]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        rows = conn.execute(
            "select event_type, metadata from public.activity_events "
            "where target_type = 'question' and target_id = %s order by created_at, id",
            (question_id,),
        ).fetchall()
    return [(str(r[0]), dict(r[1])) for r in rows]


def test_draft_confirm_archive_lifecycle_and_listing(seed: Any) -> None:
    alice = seed.client("m42a-lifecycle")
    ws = alice.create_workspace()
    body = seed.mcq(_stem("초안 문제"), ["가", "나", "다"], 0)
    draft = alice.create_question(
        ws["id"], {**body, "correct_option_ids": None, "publication_status": "DRAFT"}
    )
    assert draft["publication_status"] == "DRAFT"
    assert draft["revision"]["correct_option_ids"] is None
    # The bank lists CONFIRMED by default; other statuses on request.
    assert alice.list_questions(ws["id"]) == []
    assert [q["id"] for q in alice.list_questions(ws["id"], "publication_status=DRAFT")] == [
        draft["id"]
    ]

    path = f"/questions/{draft['id']}"
    v1 = draft["revision"]["id"]
    incomplete = alice.call(
        "PATCH", path, {"base_revision_id": v1, "publication_status": "CONFIRMED"}
    )
    problem = seed.problem(incomplete, 422)
    assert ["body", "correct_option_ids"] in [e["loc"] for e in problem["errors"]]

    confirmed = alice.ok(
        "PATCH",
        path,
        {
            "base_revision_id": v1,
            "publication_status": "CONFIRMED",
            "correct_option_ids": ["opt-3"],
        },
    )
    assert confirmed["publication_status"] == "CONFIRMED"
    assert confirmed["revision"]["version"] == 2
    v2 = confirmed["revision"]["id"]

    archived = alice.ok("PATCH", path, {"base_revision_id": v2, "publication_status": "ARCHIVED"})
    assert archived["publication_status"] == "ARCHIVED"
    assert archived["revision"] == confirmed["revision"], "a status change is not a revision"
    assert alice.list_questions(ws["id"]) == []
    listed = alice.list_questions(ws["id"], "publication_status=ARCHIVED&publication_status=DRAFT")
    assert [q["id"] for q in listed] == [draft["id"]]
    back = alice.call("PATCH", path, {"base_revision_id": v2, "publication_status": "DRAFT"})
    assert seed.problem(back, 422)["errors"][0]["loc"] == ["body", "publication_status"]

    detail = alice.get_question(draft["id"])
    assert [r["version"] for r in detail["revisions"]] == [2, 1]
    old = alice.ok("GET", f"{path}/revisions/{v1}")
    assert (old["version"], old["correct_option_ids"]) == (1, None)
    seed.problem(alice.call("GET", f"{path}/revisions/{seed.new_id()}"), 404)

    events = _events(draft["id"])
    # Events of one transaction share created_at, so compare without relying on their order.
    assert sorted(e[0] for e in events) == [
        "question.created",
        "question.status_changed",
        "question.status_changed",
        "question.updated",
    ]
    assert ("question.status_changed", {"from": "DRAFT", "to": "CONFIRMED", "version": 2}) in events
    text = repr(events)
    assert body["stem"] not in text
    assert "opt-3" not in text, "activity metadata never carries answers"


def test_patch_is_partial_noop_safe_and_keeps_the_type(seed: Any) -> None:
    alice = seed.client("m42a-patch")
    ws = alice.create_workspace()
    q = alice.create_question(
        ws["id"], seed.mcq(_stem("부분 수정"), ["a", "b"], 0, explanation="해설")
    )
    path, v1 = f"/questions/{q['id']}", q["revision"]["id"]

    same = alice.ok("PATCH", path, {"base_revision_id": v1, "stem": q["revision"]["stem"]})
    assert same["revision"] == q["revision"], "identical content appends no revision"

    for bad in (
        {"base_revision_id": v1, "question_type": "ESSAY"},
        {"base_revision_id": v1, "stem": None},
        {"base_revision_id": v1, "options": None},
        {"stem": "no base revision"},
        {"base_revision_id": v1, "unknown": 1},
    ):
        assert alice.call("PATCH", path, bad).status_code == 422, bad
    assert alice.get_question(q["id"])["revision"] == q["revision"]

    cleared = alice.ok(
        "PATCH", path, {"base_revision_id": v1, "explanation": None, "question_number": 7}
    )
    assert cleared["revision"]["version"] == 2
    assert cleared["revision"]["explanation"] is None
    assert cleared["revision"]["options"] == q["revision"]["options"]
    assert cleared["question_number"] == 7


def test_soft_delete_hides_the_question_everywhere(seed: Any) -> None:
    owner, viewer = seed.client("m42a-del-owner"), seed.client("m42a-del-viewer")
    ws = owner.create_workspace()
    keep = owner.create_question(ws["id"], seed.mcq(_stem("남김"), ["a", "b"], 0))
    gone = owner.create_question(ws["id"], seed.mcq(_stem("삭제"), ["a", "b"], 0))
    seed.membership(ws["id"], viewer.user, "viewer")
    path = f"/questions/{gone['id']}"
    seed.problem(viewer.call("DELETE", path), 403, seed.INSUFFICIENT_ROLE)

    assert owner.call("DELETE", path).status_code == 204
    missing = seed.problem(owner.call("GET", f"/questions/{seed.new_id()}"), 404)
    assert missing["detail"] == NOT_FOUND
    for method, body in (("GET", None), ("PATCH", {"base_revision_id": gone["revision"]["id"]})):
        assert seed.problem(owner.call(method, path, body), 404) == missing
    assert seed.problem(owner.call("DELETE", path), 404) == missing
    assert [q["id"] for q in owner.list_questions(ws["id"])] == [keep["id"]]
    assert _events(gone["id"])[-1] == ("question.deleted", {"publication_status": "CONFIRMED"})

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    seed.problem(owner.call("DELETE", f"/questions/{keep['id']}"), 403, seed.ARCHIVED)


def test_create_replays_with_the_same_idempotency_key(seed: Any) -> None:
    alice = seed.client("m42a-idem")
    ws = alice.create_workspace()
    body = seed.mcq(_stem("멱등"), ["a", "b"], 1)
    path, key = f"/workspaces/{ws['id']}/questions", {"Idempotency-Key": seed.new_id()}

    first = alice.call_with_headers("POST", path, body, key)
    again = alice.call_with_headers("POST", path, body, key)
    assert (first.status_code, again.status_code) == (201, 201)
    assert again.json() == first.json()
    assert again.headers["Idempotent-Replayed"] == "true"
    other = alice.call_with_headers("POST", path, {**body, "stem": _stem("다른 본문")}, key)
    seed.problem(other, 409, "urn:quiz-workspace:problem:idempotency-key-reused")
    assert len(alice.list_questions(ws["id"])) == 1


def test_chapter_links_sources_filters_and_pagination(seed: Any) -> None:
    alice, mallory = seed.client("m42a-links"), seed.client("m42a-links-mallory")
    ws, other_ws = alice.create_workspace(), mallory.create_workspace()
    doc = _seed_document(ws["id"], ["ch-1", "ch-2"])
    foreign = _seed_document(other_ws["id"], ["ch-1"], revisions=1)
    old_rev, current = doc["chapters"]
    base = seed.mcq(_stem("챕터 연결"), ["a", "b"], 0)

    def rejected(field: str, **extra: Any) -> None:
        res = alice.call("POST", f"/workspaces/{ws['id']}/questions", {**base, **extra})
        assert [field] == [e["loc"][1] for e in seed.problem(res, 422)["errors"]], extra

    rejected("chapter_id", chapter_id=old_rev["ch-1"])  # superseded revision's outline node
    rejected("chapter_id", chapter_id=foreign["chapters"][0]["ch-1"])
    rejected("chapter_id", chapter_id=seed.new_id())
    rejected("sources", sources=[{"document_id": foreign["id"], "page_start": 1}])
    rejected("sources", sources=[{"document_id": doc["id"], "page_start": 3, "page_end": 2}])
    rejected("sources", sources=[{"document_id": doc["id"], "page_end": 2}])

    q1 = alice.create_question(
        ws["id"],
        {
            **base,
            "chapter_id": current["ch-1"],
            "question_number": 2,
            "sources": [{"document_id": doc["id"], "page_start": 4}],
        },
    )
    assert q1["chapter"] == {"id": current["ch-1"], "document_id": doc["id"], "title": "1장 ch-1"}
    assert q1["sources"] == [
        {
            "document_id": doc["id"],
            "document_revision_id": doc["active_revision_id"],
            "page_start": 4,
            "page_end": 4,
        }
    ]
    q2 = alice.create_question(
        ws["id"],
        {
            **seed.mcq(_stem("두 번째 장"), ["a", "b"], 1),
            "question_number": 1,
            "chapter_id": current["ch-2"],
        },
    )
    q3 = alice.create_question(
        ws["id"], {"question_type": "ESSAY", "stem": _stem("서술 검색어XYZ")}
    )

    def ids(query: str) -> list[str]:
        return [q["id"] for q in alice.list_questions(ws["id"], query)]

    assert ids("") == [q2["id"], q1["id"], q3["id"]], "numbered first, then registration order"
    assert ids(f"chapter_id={current['ch-1']}") == [q1["id"]]
    assert ids(f"document_id={doc['id']}") == [q1["id"]]
    assert ids("question_type=ESSAY") == [q3["id"]]
    assert ids("q=검색어xyz") == [q3["id"]]
    assert ids("q=%25") == []  # LIKE wildcards are literal

    page, seen, cursor = 0, [], None
    while True:
        query = "limit=2" + (f"&cursor={cursor}" if cursor else "")
        res = alice.ok("GET", f"/workspaces/{ws['id']}/questions?{query}")
        seen += [q["id"] for q in res["items"]]
        cursor, page = res["next_cursor"], page + 1
        if cursor is None:
            break
    assert (seen, page) == (ids(""), 2)
    seed.problem(alice.call("GET", f"/workspaces/{ws['id']}/questions?cursor=bogus"), 422)

    # An unchanged chapter of a superseded revision does not block other edits; moving to one does.
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "update public.questions set chapter_id = %s where id = %s", (old_rev["ch-2"], q2["id"])
        )
    v1 = q2["revision"]["id"]
    edited = alice.ok("PATCH", f"/questions/{q2['id']}", {"base_revision_id": v1, "stem": "수정"})
    assert edited["chapter_id"] == old_rev["ch-2"]
    move = alice.call(
        "PATCH",
        f"/questions/{q1['id']}",
        {"base_revision_id": q1["revision"]["id"], "chapter_id": old_rev["ch-1"]},
    )
    assert seed.problem(move, 422)["errors"][0]["loc"] == ["body", "chapter_id"]
    moved = alice.ok(
        "PATCH",
        f"/questions/{q1['id']}",
        {"base_revision_id": q1["revision"]["id"], "chapter_id": None, "sources": []},
    )
    assert (moved["chapter_id"], moved["sources"], moved["revision"]) == (None, [], q1["revision"])


# Characters that broke or could break storage: NUL, C0/C1 controls, lone surrogates, BOM,
# zero-width/bidi format characters, private use, non-BMP, combining marks, LIKE wildcards.
_NASTY = [
    "\x00", "\x01", "\x1f", "\x7f", "\x85", "\ud800", "\udfff", "﻿", "​", "‮",
    "", "\U0001f642", "́", " ", "\t", "\n", "%", "_", "\\", "'",
]  # fmt: skip


def _nasty(rng: random.Random) -> str:
    return "".join(
        rng.choice(_NASTY) if rng.random() < 0.6 else chr(rng.randint(0x20, 0x2FFF))
        for _ in range(rng.randint(0, 6))
    )


def _raw(client: Any, method: str, path: str, body: Any = None) -> Any:
    """Send `body` as ASCII-escaped JSON so lone surrogates reach the server intact."""
    return client._http.request(
        method,
        f"/api/v1{path}",
        content=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {client.user.token}",
            "content-type": "application/json",
        },
    )


def _fuzz_body(seed: Any, field: str, value: str) -> dict[str, Any]:
    if field == "accepted":
        return {"question_type": "SHORT_ANSWER", "stem": _stem("단답"), "accepted_answers": [value]}
    body: dict[str, Any] = seed.mcq(_stem("fuzz"), ["a", "b"], 0)
    if field in {"stem", "explanation", "rubric"}:
        body[field] = value
    elif field == "option_id":
        body["options"][1]["id"] = value
    elif field == "option_text":
        body["options"][1]["text"] = value
    else:  # answer
        body["correct_option_ids"] = [value]
    return body


def test_random_unicode_and_control_strings_never_cause_a_500(seed: Any) -> None:
    alice = seed.client("m42a-fuzz")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("퍼즈"), ["a", "b"], 0))
    rng = random.Random(4242)  # noqa: S311 - deterministic test data
    fields = ("stem", "explanation", "rubric", "option_id", "option_text", "answer", "accepted")
    statuses: set[int] = set()
    for i in range(140):
        field, value = fields[i % len(fields)], _nasty(rng)
        body = _fuzz_body(seed, field, value)
        created = _raw(alice, "POST", f"/workspaces/{ws['id']}/questions", body)
        current = alice.get_question(q["id"])["revision"]["id"]
        patch = (
            {k: v for k, v in body.items() if k != "question_type"}
            if body["question_type"] == "MCQ"
            else {"stem": value}
        )
        edited = _raw(
            alice, "PATCH", f"/questions/{q['id']}", {"base_revision_id": current, **patch}
        )
        search = quote(value.encode("utf-8", "surrogatepass"))
        query = _raw(alice, "GET", f"/workspaces/{ws['id']}/questions?q={search}")
        for res in (created, edited, query):
            assert res.status_code < 500, f"{field}={value!r}: HTTP {res.status_code}"
            statuses.add(res.status_code)
    assert {200, 201, 422} <= statuses, statuses

    # Search text and cursors with NUL / junk are 422; invalid UTF-8 is replaced, never a 500.
    for params in ("q=%00", "cursor=%00", "cursor=" + "A" * 400):
        res = alice.call("GET", f"/workspaces/{ws['id']}/questions?{params}")
        assert res.status_code == 422, (params, res.status_code)
    assert alice.call("GET", f"/workspaces/{ws['id']}/questions?q=%ED%A0%80").status_code < 500
    bad = base64.urlsafe_b64encode(b'[0,0,"2026-10-17T00:00:00",123]').decode().rstrip("=")
    seed.problem(alice.call("GET", f"/workspaces/{ws['id']}/questions?cursor={bad}"), 422)
