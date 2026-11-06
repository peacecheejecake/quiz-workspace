"""UX12-CHAPTERADD server guarantees C01-C05 (docs/screens/ux12-chapter-add.md, questions.md §14.6).

Authorization of the new route is classified in tests/integration/security/test_authz_matrix.py; the
constraints, fork copy and registration SQL are supabase/tests/35_workspace_chapters.test.sql. Here
are the routes and the readers a Workspace chapter must reach.
"""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.infra

_NOTES = Path(__file__).resolve().parents[1] / "chapter_notes" / "test_chapter_notes_contract.py"
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_chadd", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

CH1 = notes.CH1
OK = notes.OK
P = "urn:quiz-workspace:problem:"
TREE_CHANGED = P + "chapter-tree-changed"
TREE_INVALID = P + "chapter-tree-invalid"
TARGET_REQUIRED = P + "chapter-target-required"
INSUFFICIENT_ROLE = P + "insufficient-role"
ARCHIVED = P + "workspace-archived"
KEY_REUSED = P + "idempotency-key-reused"


def tree(client: Any, ws: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/workspaces/{ws}/chapter-tree")
    return out


def group(client: Any, ws: str) -> dict[str, Any]:
    out: dict[str, Any] = tree(client, ws)["workspace"]
    return out


def create(client: Any, ws: str, title: str, **body: Any) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/workspaces/{ws}/chapters", {"title": title, **body}, (201,)
    )
    return out


def move(client: Any, ws: str, version: int, *moves: tuple[str, str | None, int]) -> Any:
    return client.call(
        "POST",
        f"/workspaces/{ws}/chapters/tree",
        {
            "expected_version": version,
            "moves": [{"chapter_id": c, "parent_id": p, "position": at} for c, p, at in moves],
        },
    )


def empty_workspace(seed: Any, label: str) -> tuple[Any, str]:
    owner = seed.client(label)
    return owner, str(owner.create_workspace()["id"])


def test_ux12_chapteradd_c02_c03_a_workspace_without_a_book_gets_chapters(
    seed: Any, db: Any
) -> None:
    owner, ws = empty_workspace(seed, "chadd-c03")
    start = tree(owner, ws)
    assert start["documents"] == []
    assert start["workspace"]["chapters"] == []
    assert start["workspace"]["version"] == 0

    made = create(owner, ws, "  시험 범위  ")
    chapter = made["chapter"]
    assert chapter["title"] == "시험 범위"
    assert chapter["section_key"] == f"user-{chapter['id']}"
    assert chapter["user_created"] is True
    assert chapter["level"] == 1
    assert made["document_id"] is None
    assert made["version"] == 1

    child = create(owner, ws, "세부", parent_id=chapter["id"])["chapter"]
    assert child["parent_id"] == chapter["id"]
    assert child["level"] == 2

    read = group(owner, ws)
    assert read["version"] == 2
    assert [c["id"] for c in read["chapters"]] == [chapter["id"], child["id"]]
    assert all(c["has_note"] is False and c["page"] is None for c in read["chapters"])
    [(events,)] = db(
        "select count(*) from public.activity_events "
        "where workspace_id = %s and event_type = 'workspace.chapter_created'",
        (ws,),
    )
    assert events == 2

    res = owner.call("POST", f"/workspaces/{ws}/chapters", {"title": "   "})
    assert res.status_code == 422, res.text
    same = create(owner, ws, "시험 범위")
    assert same["chapter"]["id"] != chapter["id"], "a repeated name is allowed, as in CHMAN-01"


def test_ux12_chapteradd_c03_near_chapter_decides_the_place(seed: Any) -> None:
    owner = seed.client("chadd-near")
    ws = str(owner.create_workspace()["id"])
    doc = notes.upload(owner, ws)
    ch = notes.chapters(owner, doc)

    in_book = create(owner, ws, "교재 쪽", near_chapter_id=ch[CH1])
    assert in_book["document_id"] == doc
    assert in_book["document_title"]
    assert in_book["chapter"]["parent_id"] is None
    book = tree(owner, ws)["documents"][0]
    assert book["chapters"][-1]["id"] == in_book["chapter"]["id"], "the book's last top chapter"

    no_chapter = create(owner, ws, "교재 밖", near_chapter_id=None)
    assert no_chapter["document_id"] is None
    near_workspace = create(owner, ws, "또 밖", near_chapter_id=no_chapter["chapter"]["id"])
    assert near_workspace["document_id"] is None

    paper = notes.upload(owner, ws, notes.PAPER, document_type="question_paper")
    [paper_chapter, *_] = notes.chapters(owner, paper).values()
    near_paper = create(owner, ws, "문제지 쪽", near_chapter_id=paper_chapter)
    assert near_paper["document_id"] is None, "a question paper has no editable tree"

    res = owner.call(
        "POST",
        f"/workspaces/{ws}/chapters",
        {"title": "x", "near_chapter_id": ch[CH1], "document_id": doc},
    )
    assert res.status_code == 422, res.text


def test_ux12_chapteradd_c01_roles_and_foreign_ids(seed: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-c01")
    chapter = create(owner, ws, "장")["chapter"]
    viewer = notes.member(seed, ws, "chadd-c01-viewer", "viewer")
    version = group(owner, ws)["version"]
    calls = [
        lambda c: c.call("POST", f"/workspaces/{ws}/chapters", {"title": "x"}),
        lambda c: c.call("PATCH", f"/chapters/{chapter['id']}", {"title": "x"}),
        lambda c: move(c, ws, version, (chapter["id"], None, 0)),
        lambda c: c.call("DELETE", f"/chapters/{chapter['id']}"),
    ]
    for call in calls:
        res = call(viewer)
        assert res.status_code == 403, res.text
        assert res.json()["type"] == INSUFFICIENT_ROLE
    stranger = seed.client("chadd-c01-stranger")
    assert {call(stranger).status_code for call in calls} == {404}

    other, other_ws = empty_workspace(seed, "chadd-c01-other")
    foreign = create(other, other_ws, "남의 장")["chapter"]["id"]
    for body in ({"parent_id": foreign}, {"near_chapter_id": foreign}):
        res = owner.call("POST", f"/workspaces/{ws}/chapters", {"title": "x", **body})
        assert res.status_code == 404, res.text
    assert move(owner, ws, version, (foreign, None, 0)).status_code == 404

    owner.ok("POST", f"/workspaces/{ws}/archive")
    for call in calls:
        res = call(owner)
        assert res.status_code == 403, res.text
        assert res.json()["type"] == ARCHIVED


def test_ux12_chapteradd_c03_idempotency_key_replays_the_first_response(seed: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-idem")
    key = str(uuid.uuid4())
    path = f"/workspaces/{ws}/chapters"
    body = {"title": "한 번만"}
    first = owner.send("POST", path, body, headers={"Idempotency-Key": key})
    second = owner.send("POST", path, body, headers={"Idempotency-Key": key})
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert [c["title"] for c in group(owner, ws)["chapters"]] == ["한 번만"]
    other = owner.send("POST", path, {"title": "다른"}, headers={"Idempotency-Key": key})
    assert other.status_code == 409, other.text
    assert other.json()["type"] == KEY_REUSED


def test_ux12_chapteradd_c04_move_rename_and_delete(seed: Any, db: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-c04")
    a = create(owner, ws, "가")["chapter"]["id"]
    b = create(owner, ws, "나")["chapter"]["id"]
    c = create(owner, ws, "다", parent_id=a)["chapter"]["id"]

    version = group(owner, ws)["version"]
    stale = move(owner, ws, version - 1, (b, a, 0))
    assert stale.status_code == 409, stale.text
    assert stale.json()["type"] == TREE_CHANGED
    cycle = move(owner, ws, version, (a, c, 0))
    assert cycle.status_code == 422, cycle.text
    assert cycle.json()["type"] == TREE_INVALID

    moved = move(owner, ws, version, (b, a, 0))
    assert moved.status_code == 200, moved.text
    assert [(n["id"], n["level"]) for n in moved.json()["chapters"]] == [(a, 1), (b, 2), (c, 2)]

    renamed = owner.ok("PATCH", f"/chapters/{a}", {"title": "새 이름"})
    assert renamed["chapter"]["title"] == "새 이름"
    assert renamed["document_id"] is None

    q = notes.question(owner, ws, notes.token(), 1, a, OK)
    assert group(owner, ws)["chapters"][0]["question_count"] == 1
    required = owner.call("DELETE", f"/chapters/{a}")
    assert required.status_code == 422, required.text
    assert required.json()["type"] == TARGET_REQUIRED
    res = owner.call("DELETE", f"/chapters/{a}?move_questions_to={c}")
    assert res.status_code == 200, res.text
    assert res.json()["moved_questions"] == 1

    left = group(owner, ws)["chapters"]
    assert {n["id"]: n["parent_id"] for n in left} == {b: None, c: None}, "children go up"
    after = owner.ok("GET", f"/questions/{q['id']}")
    assert after["chapter_id"] == c
    assert after["chapter"]["document_id"] is None
    [(source,)] = db("select chapter_source from public.questions where id = %s", (q["id"],))
    assert source == "manual"
    [(changes,)] = db(
        "select count(*) from public.question_chapter_changes "
        "where question_id = %s and source = 'chapter_edit'",
        (q["id"],),
    )
    assert changes == 1


def test_ux12_chapteradd_c04_chapters_of_a_book_and_the_workspace_take_each_others_questions(
    seed: Any,
) -> None:
    owner = seed.client("chadd-cross")
    ws = str(owner.create_workspace()["id"])
    doc = notes.upload(owner, ws)
    ch = notes.chapters(owner, doc)
    outside = create(owner, ws, "밖")["chapter"]["id"]
    book_chapter = create(owner, ws, "안", document_id=doc)["chapter"]["id"]
    q = notes.question(owner, ws, notes.token(), 1, book_chapter, OK)

    res = owner.call("DELETE", f"/chapters/{book_chapter}?move_questions_to={outside}")
    assert res.status_code == 200, res.text
    assert owner.ok("GET", f"/questions/{q['id']}")["chapter_id"] == outside

    res = owner.call("DELETE", f"/chapters/{outside}?move_questions_to={ch[CH1]}")
    assert res.status_code == 200, res.text
    assert owner.ok("GET", f"/questions/{q['id']}")["chapter_id"] == ch[CH1]


def test_ux12_chapteradd_readers_see_a_workspace_chapter_as_a_chapter(seed: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-readers")
    chapter = create(owner, ws, "범위")["chapter"]["id"]
    empty = create(owner, ws, "빈 장")["chapter"]["id"]
    q = notes.question(owner, ws, notes.token(), 1, chapter, OK)
    none = notes.question(owner, ws, notes.token(), 2, None, OK)

    overview = owner.ok("GET", f"/workspaces/{ws}/questions/overview")
    assert [(c["id"], c["title"], c["document_id"]) for c in overview["chapters"]] == [
        (chapter, "범위", None),
        (None, "챕터 없음", None),
    ], "the Workspace chapter before 챕터 없음"

    listed = owner.ok("GET", f"/workspaces/{ws}/chapter-redistribution/questions")
    [targets] = listed["targets"]
    assert targets["document_id"] is None
    assert [c["id"] for c in targets["chapters"]] == [chapter, empty]

    res = owner.call(
        "POST",
        f"/workspaces/{ws}/questions/chapter-assignments",
        {
            "source": "manual",
            "items": [
                {"question_id": none["id"], "chapter_id": empty, "expected_chapter_id": None}
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert owner.ok("GET", f"/questions/{none['id']}")["chapter_id"] == empty

    moved = notes.patch_question(owner, q, chapter_id=empty)
    assert moved["chapter_id"] == empty

    assert owner.call("GET", f"/chapters/{chapter}/note").status_code == 404, "no text, no note"
    run = owner.call(
        "POST",
        f"/workspaces/{ws}/practice-runs",
        {"source": "bank", "range": {"chapter_ids": [empty]}},
    )
    assert run.status_code in (200, 201), run.text


def test_ux12_chapteradd_import_drafts_register_under_a_workspace_chapter(seed: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-import")
    chapter = create(owner, ws, "범위")["chapter"]["id"]
    draft = notes.draft_in(owner, ws, chapter)
    assert draft["chapter"]["id"] == chapter
    assert draft["chapter"]["document_id"] is None
    assert draft["chapter_choice"] == "manual"


def test_ux12_chapteradd_share_shows_and_fork_carries_workspace_chapters(seed: Any) -> None:
    owner, ws = empty_workspace(seed, "chadd-share")
    chapter = create(owner, ws, "범위")["chapter"]["id"]
    q = notes.question(owner, ws, notes.token(), 1, chapter, OK)
    recipient = seed.client("chadd-share-recipient")

    link = owner.create_link(ws, allow_fork=True)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    listed = guest.read(link["id"], cookie, "/questions")
    seed.assert_status(listed, 200, "shared questions")
    [shared] = listed.json()["items"]
    assert shared["id"] == q["id"]
    assert shared["chapter"] == {"id": chapter, "document_id": None, "title": "범위"}

    res = recipient.fork(link["id"], cookie, f"chadd fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(res, 202, "fork")
    target = str(recipient.wait_fork(str(res.json()["id"]), "COMPLETED")["target_workspace_id"])
    copied = group(recipient, target)
    assert [c["title"] for c in copied["chapters"]] == ["범위"]
    assert copied["chapters"][0]["id"] != chapter
    assert copied["chapters"][0]["question_count"] == 1
    assert copied["version"] == 0

    owner.ok("PATCH", f"/chapters/{chapter}", {"title": "원본만"})
    assert group(recipient, target)["chapters"][0]["title"] == "범위"
