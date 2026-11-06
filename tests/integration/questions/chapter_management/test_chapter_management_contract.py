"""CHMAN-01 server guarantees C01-C07 (docs/screens/chapter-management.md, questions.md §14.5).

Authorization of each route is classified in tests/integration/security/test_authz_matrix.py; here
are the role and archive answers of the screen's own flows. The guard, the draft sync SQL and
the grants are supabase/tests/32_chapter_edit.test.sql; races with publish and fork are
test_chapter_management_races.py. Superuser reads are only for rows no API exposes.
"""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.infra

_NOTES = Path(__file__).resolve().parents[1] / "chapter_notes" / "test_chapter_notes_contract.py"
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_chman", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

CH1, CH2 = notes.CH1, notes.CH2
OK = notes.OK
RANDOM_ID = notes.RANDOM_ID
P = "urn:quiz-workspace:problem:"
TREE_CHANGED = P + "chapter-tree-changed"
TREE_INVALID = P + "chapter-tree-invalid"
TARGET_REQUIRED = P + "chapter-target-required"
CHAPTER_INVALID = P + "chapter-invalid"
INSUFFICIENT_ROLE = P + "insufficient-role"
ARCHIVED = P + "workspace-archived"
KEY_REUSED = P + "idempotency-key-reused"
PUBLISH_IN_PROGRESS = P + "publish-in-progress"
UNCHANGED_TABLES = ("question_revisions", "question_attempts", "practice_runs")


def tree_path(ws: str) -> str:
    return f"/workspaces/{ws}/chapter-tree"


def book_of(client: Any, ws: str, document_id: str | None = None) -> dict[str, Any]:
    documents: list[dict[str, Any]] = client.ok("GET", tree_path(ws))["documents"]
    if document_id is None:
        return documents[0]
    return next(d for d in documents if d["document_id"] == document_id)


def node(client: Any, ws: str, chapter_id: str) -> dict[str, Any]:
    return next(c for c in book_of(client, ws)["chapters"] if c["id"] == chapter_id)


def create(client: Any, ws: str, doc: str, title: str, parent: str | None = None) -> dict[str, Any]:
    body = {"document_id": doc, "parent_id": parent, "title": title}
    out: dict[str, Any] = client.ok("POST", f"/workspaces/{ws}/chapters", body, (201,))
    return out


def move(client: Any, doc: str, version: int, *moves: tuple[str, str | None, int]) -> Any:
    return client.call(
        "POST",
        f"/documents/{doc}/chapters/tree",
        {
            "expected_version": version,
            "moves": [{"chapter_id": c, "parent_id": p, "position": at} for c, p, at in moves],
        },
    )


def delete(client: Any, chapter: str, target: str | None = None) -> Any:
    query = f"?move_questions_to={target}" if target else ""
    return client.call("DELETE", f"/chapters/{chapter}{query}")


def stored_hash(db: Any, revision: str) -> str:
    [(value,)] = db("select content_hash from public.document_revisions where id = %s", (revision,))
    return str(value)


class Space:
    """book-ko with one question on 1장 and one on 2장."""

    def __init__(self, seed: Any, label: str) -> None:
        self.owner = seed.client(f"{label}-owner")
        self.ws = str(self.owner.create_workspace()["id"])
        self.doc = notes.upload(self.owner, self.ws)
        self.ch = notes.chapters(self.owner, self.doc)
        token = notes.token()
        self.q1 = notes.question(self.owner, self.ws, f"{token}-1", 1, self.ch[CH1], OK)
        self.q2 = notes.question(self.owner, self.ws, f"{token}-2", 2, self.ch[CH2], OK)


def test_chman_01_c01_only_editors_of_an_active_workspace_reach_the_routes(seed: Any) -> None:
    s = Space(seed, "chman-c01")
    viewer = notes.member(seed, s.ws, "chman-c01-viewer", "viewer")
    version = book_of(s.owner, s.ws)["version"]
    calls = [
        lambda c: c.call("GET", tree_path(s.ws)),
        lambda c: c.call(
            "POST",
            f"/workspaces/{s.ws}/chapters",
            {"document_id": s.doc, "parent_id": None, "title": "x"},
        ),
        lambda c: c.call("PATCH", f"/chapters/{s.ch[CH1]}", {"title": "x"}),
        lambda c: move(c, s.doc, version, (s.ch[CH1], None, 0)),
        lambda c: delete(c, s.ch[CH1], "none"),
    ]
    for call in calls:
        res = call(viewer)
        assert res.status_code == 403, res.text
        assert res.json()["type"] == INSUFFICIENT_ROLE
    stranger = seed.client("chman-c01-stranger")
    bodies = [call(stranger) for call in calls]
    assert {b.status_code for b in bodies} == {404}
    assert len({b.text for b in bodies}) <= 2, "one not-found body per kind of id"

    s.owner.ok("POST", f"/workspaces/{s.ws}/archive")
    for call in calls:
        res = call(s.owner)
        assert res.status_code == 403, res.text
        assert res.json()["type"] == ARCHIVED


def test_chman_01_c03_the_tree_lists_live_books_with_counts_and_no_book_text(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chman-c03")
    notes.upload(s.owner, s.ws, notes.PAPER, document_type="question_paper")
    docs = s.owner.ok("GET", tree_path(s.ws))["documents"]
    assert [d["document_id"] for d in docs] == [s.doc], "a question paper has no tree here"
    doc = docs[0]
    order = [c["sort_order"] for c in doc["chapters"]]
    assert order == sorted(order)
    first = next(c for c in doc["chapters"] if c["id"] == s.ch[CH1])
    assert first["question_count"] == 1
    assert first["has_note"] is False
    assert first["user_created"] is False
    assert set(first) == {
        "id",
        "parent_id",
        "section_key",
        "title",
        "level",
        "sort_order",
        "page",
        "question_count",
        "attached_question_count",
        "has_note",
        "user_created",
    }
    notes.generate(s.owner, s.ch[CH1])
    assert node(s.owner, s.ws, s.ch[CH1])["has_note"] is True
    [(n,)] = db("select chapter_tree_version from public.documents where id = %s", (s.doc,))
    assert doc["version"] == n


def test_chman_01_c04_create_and_rename_change_the_active_revision_without_a_draft(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chman-c04")
    before = book_of(s.owner, s.ws)
    made = create(s.owner, s.ws, s.doc, "  추가한 장  ", s.ch[CH1])
    chapter = made["chapter"]
    assert chapter["title"] == "추가한 장"
    assert chapter["section_key"] == f"user-{chapter['id']}"
    assert chapter["user_created"] is True
    assert chapter["parent_id"] == s.ch[CH1]
    assert made["version"] == before["version"] + 1

    after = book_of(s.owner, s.ws)
    assert after["revision_id"] == before["revision_id"], "no new revision"
    assert [c["sort_order"] for c in after["chapters"]] == list(range(len(after["chapters"])))
    children = [c for c in after["chapters"] if c["parent_id"] == s.ch[CH1]]
    assert children[-1]["id"] == chapter["id"], "the last child of its parent"
    assert chapter["level"] == node(s.owner, s.ws, s.ch[CH1])["level"] + 1

    renamed = s.owner.ok("PATCH", f"/chapters/{chapter['id']}", {"title": "새 이름"})
    assert renamed["chapter"]["title"] == "새 이름"
    assert renamed["chapter"]["section_key"] == chapter["section_key"]
    assert (
        s.owner.ok("GET", f"/documents/{s.doc}/outline")["revision"]["id"] == after["revision_id"]
    )
    [(drafts,)] = db(
        "select count(*) from public.document_revisions "
        "where document_id = %s and status = 'draft'",
        (s.doc,),
    )
    assert drafts == 0

    assert (
        s.owner.call(
            "POST",
            f"/workspaces/{s.ws}/chapters",
            {
                "document_id": s.doc,
                "parent_id": None,
                "title": "   ",
            },
        ).status_code
        == 422
    )
    foreign = seed.client("chman-c04-other")
    other = str(foreign.create_workspace()["id"])
    other_doc = notes.upload(foreign, other)
    res = s.owner.call(
        "POST",
        f"/workspaces/{s.ws}/chapters",
        {"document_id": other_doc, "parent_id": None, "title": "x"},
    )
    assert res.status_code == 404, res.text
    paper = notes.upload(s.owner, s.ws, notes.PAPER, document_type="question_paper")
    res = s.owner.call(
        "POST",
        f"/workspaces/{s.ws}/chapters",
        {"document_id": paper, "parent_id": None, "title": "x"},
    )
    assert res.status_code == 422, res.text
    assert res.json()["type"] == CHAPTER_INVALID


def test_chman_01_c05_moves_need_the_current_version_and_keep_the_tree_valid(seed: Any) -> None:
    s = Space(seed, "chman-c05")
    book = book_of(s.owner, s.ws)
    a, b = s.ch[CH1], s.ch[CH2]

    res = move(s.owner, s.doc, book["version"], (b, a, 0))
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["version"] == book["version"] + 1
    assert [c["sort_order"] for c in out["chapters"]] == list(range(len(out["chapters"])))
    moved = next(c for c in out["chapters"] if c["id"] == b)
    assert moved["parent_id"] == a
    assert moved["level"] == 2

    stale = move(s.owner, s.doc, book["version"], (b, None, 0))
    assert stale.status_code == 409, stale.text
    assert stale.json()["type"] == TREE_CHANGED
    assert node(s.owner, s.ws, b)["parent_id"] == a, "nothing moved"

    cycle = move(s.owner, s.doc, out["version"], (a, b, 0))
    assert cycle.status_code == 422, cycle.text
    assert cycle.json()["type"] == TREE_INVALID

    parent = b
    for n in range(17):
        parent = create(s.owner, s.ws, s.doc, f"깊이 {n}", parent)["chapter"]["id"]
    deepest = create(s.owner, s.ws, s.doc, "스물째", parent)["chapter"]
    assert deepest["level"] == 20
    res = s.owner.call(
        "POST",
        f"/workspaces/{s.ws}/chapters",
        {"document_id": s.doc, "parent_id": deepest["id"], "title": "x"},
    )
    assert res.status_code == 422, res.text
    assert res.json()["type"] == TREE_INVALID

    unknown = move(s.owner, s.doc, book_of(s.owner, s.ws)["version"], (RANDOM_ID, None, 0))
    assert unknown.status_code == 404, unknown.text


def test_chman_01_c01_idempotency_key_replays_the_first_response(seed: Any) -> None:
    s = Space(seed, "chman-idem")
    key = str(uuid.uuid4())
    path = f"/workspaces/{s.ws}/chapters"
    body = {"document_id": s.doc, "parent_id": None, "title": "한 번만"}
    first = s.owner.send("POST", path, body, headers={"Idempotency-Key": key})
    second = s.owner.send("POST", path, body, headers={"Idempotency-Key": key})
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    titles = [c["title"] for c in book_of(s.owner, s.ws)["chapters"]]
    assert titles.count("한 번만") == 1
    other = s.owner.send("POST", path, {**body, "title": "다른"}, headers={"Idempotency-Key": key})
    assert other.status_code == 409, other.text
    assert other.json()["type"] == KEY_REUSED


def test_chman_01_c06_delete_moves_questions_and_keeps_records(seed: Any, db: Any) -> None:
    s = Space(seed, "chman-c06")
    child = create(s.owner, s.ws, s.doc, "하위", s.ch[CH1])["chapter"]
    book = book_of(s.owner, s.ws)
    hash_before = stored_hash(db, book["revision_id"])
    [(blocks_before,)] = db(
        "select count(*) from public.content_blocks where chapter_id = %s", (s.ch[CH1],)
    )
    counted = {
        t: db(f"select count(*) from public.{t} where workspace_id = %s", (s.ws,))  # noqa: S608
        for t in UNCHANGED_TABLES
    }

    res = delete(s.owner, s.ch[CH1])
    assert res.status_code == 422, res.text
    assert res.json()["type"] == TARGET_REQUIRED
    res = delete(s.owner, s.ch[CH1], s.ch[CH1])
    assert res.status_code == 422, res.text
    assert res.json()["type"] == CHAPTER_INVALID
    res = delete(s.owner, s.ch[CH1], RANDOM_ID)
    assert res.status_code == 404, res.text

    res = delete(s.owner, s.ch[CH1], s.ch[CH2])
    assert res.status_code == 200, res.text
    assert res.json()["moved_questions"] == 1
    moved = s.owner.ok("GET", f"/questions/{s.q1['id']}")
    assert moved["chapter_id"] == s.ch[CH2]
    assert moved["chapter_source"] == "manual"
    [(source, frm, to)] = db(
        "select source, from_chapter_id, to_chapter_id from public.question_chapter_changes "
        "where question_id = %s",
        (s.q1["id"],),
    )
    assert source == "chapter_edit"
    assert frm is None, "the deleted chapter's id is gone with it"
    assert str(to) == s.ch[CH2]
    for table, value in counted.items():
        assert (
            db(
                f"select count(*) from public.{table} where workspace_id = %s",  # noqa: S608
                (s.ws,),
            )
            == value
        )

    survivor = node(s.owner, s.ws, child["id"])
    assert survivor["parent_id"] is None, "the sub-chapter goes to the deleted chapter's parent"
    assert survivor["level"] == 1
    [(orphans,)] = db(
        "select count(*) from public.content_blocks b where b.document_revision_id = %s "
        "and b.chapter_id = %s",
        (book["revision_id"], s.ch[CH1]),
    )
    assert orphans == 0
    assert blocks_before > 0, "the fixture has blocks to move"
    assert stored_hash(db, book["revision_id"]) != hash_before, "load_content verifies this hash"
    [(meta,)] = db(
        "select metadata from public.activity_events where workspace_id = %s "
        "and event_type = 'document.chapter_deleted'",
        (s.ws,),
    )
    assert set(meta) == {"chapter_id", "moved_questions", "target_chapter_id"}, "ids and counts"

    # `none` moves to 챕터 없음; an empty chapter needs no target.
    res = delete(s.owner, s.ch[CH2], "none")
    assert res.status_code == 200, res.text
    assert res.json()["moved_questions"] == 2
    assert s.owner.ok("GET", f"/questions/{s.q2['id']}")["chapter_id"] is None
    res = delete(s.owner, child["id"])
    assert res.status_code == 200, res.text


def test_chman_01_c06_a_delete_retry_replays_for_the_caller_alone(seed: Any) -> None:
    s = Space(seed, "chman-retry")
    editor = notes.member(seed, s.ws, "chman-retry-editor", "editor")
    key = {"Idempotency-Key": str(uuid.uuid4())}
    path = f"/chapters/{s.ch[CH1]}?move_questions_to=none"
    first = editor.send("DELETE", path, None, headers=key)
    assert first.status_code == 200, first.text
    again = editor.send("DELETE", path, None, headers=key)
    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert again.headers["Idempotent-Replayed"] == "true"

    other = editor.send("DELETE", f"/chapters/{s.ch[CH1]}", None, headers=key)
    assert other.status_code == 409, other.text
    assert other.json()["type"] == KEY_REUSED
    assert editor.call("DELETE", path).status_code == 404, "without the key it is simply gone"

    # Another caller with the same key has no saved response.
    stranger = seed.client("chman-retry-stranger")
    assert stranger.send("DELETE", path, None, headers=key).status_code == 404
    assert s.owner.send("DELETE", path, None, headers=key).status_code == 404

    # The caller's own saved response follows the workspace's authorization.
    s.owner.ok("POST", f"/workspaces/{s.ws}/archive")
    res = editor.send("DELETE", path, None, headers=key)
    assert res.status_code == 403, res.text
    assert res.json()["type"] == ARCHIVED


def test_chman_01_c06_a_chapter_with_only_inactive_questions_reports_them(seed: Any) -> None:
    s = Space(seed, "chman-inactive")
    notes.delete_question(s.owner, s.q1)
    row = node(s.owner, s.ws, s.ch[CH1])
    assert row["question_count"] == 0, "not on the Heatmap"
    assert row["attached_question_count"] == 1, "but the delete has to move it"
    res = delete(s.owner, s.ch[CH1])
    assert res.status_code == 422, res.text
    assert res.json()["type"] == TARGET_REQUIRED
    assert delete(s.owner, s.ch[CH1], "none").status_code == 200


def test_chman_01_c07_the_correction_draft_follows_and_restore_carries_the_tree(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chman-draft")
    active = book_of(s.owner, s.ws)["revision_id"]
    block = s.owner.ok("GET", f"/documents/{s.doc}/blocks")["items"][0]
    s.owner.ok("PATCH", f"/documents/{s.doc}/blocks/{block['block_id']}", {"text": "교정한 글"})
    added = create(s.owner, s.ws, s.doc, "교정 뒤 추가")["chapter"]
    assert delete(s.owner, s.ch[CH2], "none").status_code == 200

    draft = s.owner.ok("GET", f"/documents/{s.doc}/outline?revision=latest")
    keys = {c["section_key"] for c in _walk(draft["items"])}
    assert added["section_key"] in keys, "a draft takes a chapter added on the active revision"
    [(gone,)] = db("select section_key from public.chapters where id = %s", (s.ch[CH1],))
    assert gone in keys

    restored = s.owner.ok("POST", f"/documents/{s.doc}/revisions/{active}/restore")
    outline = s.owner.ok("GET", f"/documents/{s.doc}/outline?revision={restored['revision']['id']}")
    titles = [c["title"] for c in _walk(outline["items"])]
    assert "교정 뒤 추가" in titles, "restore carries user chapters"
    [(blocks,)] = db(
        "select count(*) from public.content_blocks b "
        "left join public.chapters c on c.id = b.chapter_id "
        "where b.document_revision_id = %s and b.chapter_id is not null and c.id is null",
        (restored["revision"]["id"],),
    )
    assert blocks == 0


def test_chman_01_c02_a_running_publish_refuses_edits(seed: Any, db: Any) -> None:
    s = Space(seed, "chman-publishing")
    block = s.owner.ok("GET", f"/documents/{s.doc}/blocks")["items"][0]
    s.owner.ok("PATCH", f"/documents/{s.doc}/blocks/{block['block_id']}", {"text": "교정한 글"})
    [(draft_id,)] = db(
        "select id from public.document_revisions where document_id = %s and status = 'draft'",
        (s.doc,),
    )
    db(
        "insert into public.async_jobs (workspace_id, job_type, schema_version, idempotency_key, "
        "payload, status) values (%s, 'document.parse', 1, %s, %s, 'queued') returning id",
        (
            s.ws,
            f"chman-{uuid.uuid4()}",
            f'{{"document_id": "{s.doc}", "revision_id": "{draft_id}"}}',
        ),
    )
    res = s.owner.call("PATCH", f"/chapters/{s.ch[CH1]}", {"title": "발행 중"})
    assert res.status_code == 409, res.text
    assert res.json()["type"] == PUBLISH_IN_PROGRESS


def _walk(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in items:
        out.append(item)
        out.extend(_walk(item.get("children", [])))
    return out
