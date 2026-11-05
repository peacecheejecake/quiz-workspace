"""CHREDIST-01 server guarantees C01-C08 (docs/screens/chapter-redistribution.md, questions.md §14,
architecture.md §5-§6).

The list, preview and assignment APIs are editor-only on active workspaces (C01); an assignment is
validated whole and applied atomically (C02); idempotency only through the same Idempotency-Key
(C03); what an assignment writes and never touches (C04); recommendations reuse the CHAPTER-MAP
function on the question's first source block (C05); the preview is read-only (C06);
`chapter_source` rules and fork copies (C07); overview, note staleness and logs after a move (C08).

Shapes are assumptions R1-R5 in tests/e2e/fixtures/chapter-redistribution.ts (confirmed by
UX9-REDIST-B). Jobs run in this process (conftest.py). The lock order (documents before questions)
is unit-tested in apps/api/tests/test_chapter_redistribution.py and raced against a correction
publish in test_chapter_redistribution_lock_order.py; the `chapter_source` trigger, the
append-only trigger and the grants of `question_chapter_changes` are
supabase/tests/24_question_chapter_source.test.sql. Superuser reads are only for rows no API
exposes.
"""

from __future__ import annotations

import importlib.util
import logging
import uuid
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.infra

_NOTES = Path(__file__).resolve().parents[1] / "chapter_notes" / "test_chapter_notes_contract.py"
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_redist", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

CH1, CH2 = notes.CH1, notes.CH2
PAPER = notes.PAPER
OK = notes.OK
RANDOM_ID = notes.RANDOM_ID
P = "urn:quiz-workspace:problem:"
INSUFFICIENT_ROLE = P + "insufficient-role"
ARCHIVED = P + "workspace-archived"
CHAPTER_CHANGED = P + "chapter-changed"
NOT_CONFIRMED = P + "question-not-confirmed"
CHAPTER_INVALID = P + "chapter-invalid"
KEY_REUSED = P + "idempotency-key-reused"
PAPER_CHAPTER = "제1회 합성 확인 평가 — 물의 순환과 정수 처리"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "options"}
UNCHANGED_TABLES = (
    "question_revisions",
    "question_attempts",
    "question_user_states",
    "practice_runs",
    "practice_sessions",
)


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------


def list_path(ws: str) -> str:
    return f"/workspaces/{ws}/chapter-redistribution/questions"


def preview_path(ws: str) -> str:
    return f"/workspaces/{ws}/chapter-redistribution/preview"


def assign_path(ws: str) -> str:
    return f"/workspaces/{ws}/questions/chapter-assignments"


def assign(
    client: Any,
    ws: str,
    items: list[dict[str, Any]],
    source: str = "manual",
    key: str | None = None,
) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    return client.send("POST", assign_path(ws), {"source": source, "items": items}, headers=headers)


def item(q: dict[str, Any], to: str | None, expected: str | None) -> dict[str, Any]:
    return {"question_id": q["id"], "chapter_id": to, "expected_chapter_id": expected}


def preview(client: Any, ws: str, **body: Any) -> Any:
    return client.call("POST", preview_path(ws), {"include_manual": False, **body})


def chapter_of(client: Any, q: dict[str, Any]) -> str | None:
    value = client.ok("GET", f"/questions/{q['id']}")["chapter_id"]
    return None if value is None else str(value)


def problem_type(res: Any) -> str | None:
    try:
        value = res.json().get("type")
    except ValueError:
        return None
    return None if value is None else str(value)


def counts(db: Any, ws: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for table in (*UNCHANGED_TABLES, "question_chapter_changes", "activity_events", "async_jobs"):
        [(n,)] = db(
            f"select count(*) from public.{table} where workspace_id = %s",  # noqa: S608
            (ws,),
        )
        out[table] = int(n)
    return out


class Space:
    """book-ko with 1장 three, 2장 one and "챕터 없음" one CONFIRMED MCQ (direct, `manual`)."""

    def __init__(self, seed: Any, label: str) -> None:
        self.owner = seed.client(f"{label}-owner")
        self.ws = str(self.owner.create_workspace()["id"])
        self.book = notes.upload(self.owner, self.ws)
        self.ch = notes.chapters(self.owner, self.book)
        t = notes.token()
        self.q = [
            notes.question(self.owner, self.ws, f"{t}-q{n}", n, chapter, OK)
            for n, chapter in (
                (1, self.ch[CH1]),
                (2, self.ch[CH1]),
                (3, self.ch[CH1]),
                (4, self.ch[CH2]),
                (5, None),
            )
        ]
        self.token = t


def import_space(seed: Any, label: str, db: Any) -> dict[str, Any]:
    """R5: A, B auto under 챕터 없음; C manual (reviewer picked 1장); D auto under the titled book's
    chapter; E direct with no source (manual)."""
    owner = seed.client(f"{label}-owner")
    ws = str(owner.create_workspace()["id"])
    book_id = notes.upload(owner, ws)
    ch = notes.chapters(owner, book_id)
    paper = notes.upload(owner, ws, PAPER, document_type="question_paper")
    run = owner.ok("POST", f"/workspaces/{ws}/question-imports", {"document_id": paper}, (202,))
    owner.wait_for_job(str(run["job_id"]))

    def drafts() -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = owner.ok("GET", f"/question-imports/{run['id']}/drafts")[
            "items"
        ]
        return sorted(items, key=lambda d: int(d["position"]))

    def by_number(n: int) -> dict[str, Any]:
        stem = seed_truth(n)
        return next(d for d in drafts() if stem in d["payload"]["stem"])

    def publish(d: dict[str, Any]) -> str:
        approved = owner.ok(
            "PATCH",
            f"/question-drafts/{d['id']}",
            {"base_version": d["version"], "review_status": "approved"},
        )
        out = owner.ok(
            "POST",
            f"/question-imports/{run['id']}/publish",
            {"drafts": [{"draft_id": d["id"], "version": approved["version"]}]},
        )
        return str(out["items"][0]["question_id"])

    a = publish(by_number(1))
    b = publish(by_number(2))
    c_draft = by_number(4)
    owner.ok(
        "PATCH",
        f"/question-drafts/{c_draft['id']}",
        {"base_version": c_draft["version"], "chapter_id": ch[CH1]},
    )
    c = publish(by_number(4))
    titled = notes.upload(owner, ws, PAPER, filename="chapter-book.pdf", document_type="book")
    titled_chapter = notes.chapters(owner, titled)[PAPER_CHAPTER]
    # CHAP-MATCH: the new book's parse job already re-matched A and B (auto, no chapter) to the
    # titled chapter. Put them back under "챕터 없음" so these tests start from the state a
    # preview recommends from (the automatic re-match has its own test below).
    db(
        "update public.questions set chapter_id = null where id = any(%s::uuid[])",
        ([a, b],),
    )
    d_draft = by_number(5)
    d = publish(d_draft)
    e = notes.question(owner, ws, f"{notes.token()}-direct", 9, ch[CH2], OK)
    return {
        "owner": owner,
        "ws": ws,
        "ch": ch,
        "book": book_id,
        "paper": paper,
        "titled": titled,
        "titled_chapter": titled_chapter,
        "ids": {"A": a, "B": b, "C": c, "D": d, "E": str(e["id"])},
        "d_suggestion": d_draft["chapter"],
    }


def seed_truth(n: int) -> str:
    import json

    truth = json.loads((PAPER.parent / "questions-ko.truth.json").read_text(encoding="utf-8"))
    return str(next(q["stem"] for q in truth["questions"] if q["number"] == n))


# ---------------------------------------------------------------------------------------------
# C01 authorization matrix
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c01_editors_of_active_workspaces_only(seed: Any) -> None:
    s = Space(seed, "chredist-c01")
    editor = notes.member(seed, s.ws, "chredist-c01-editor", "editor")
    viewer = notes.member(seed, s.ws, "chredist-c01-viewer", "viewer")
    stranger = seed.client("chredist-c01-stranger")

    for client in (s.owner, editor):
        listed = client.call("GET", list_path(s.ws))
        seed.assert_status(listed, 200, "list")
        body = listed.json()
        assert {i["question_id"] for i in body["items"]} == {q["id"] for q in s.q}
        assert not ANSWER_KEYS & set(notes.keys(body))
        seed.assert_status(preview(client, s.ws, all=True), 200, "preview")
    moved = assign(editor, s.ws, [item(s.q[0], s.ch[CH2], s.ch[CH1])])
    seed.assert_status(moved, 200, "editor move")
    assert chapter_of(s.owner, s.q[0]) == s.ch[CH2]

    for res in (
        viewer.call("GET", list_path(s.ws)),
        preview(viewer, s.ws, all=True),
        assign(viewer, s.ws, [item(s.q[1], s.ch[CH2], s.ch[CH1])]),
    ):
        assert res.status_code == 403
        assert problem_type(res) == INSUFFICIENT_ROLE

    unknown = stranger.call("GET", list_path(RANDOM_ID))
    seed.assert_status(unknown, 404, "unknown workspace")
    for res in (
        stranger.call("GET", list_path(s.ws)),
        preview(stranger, s.ws, all=True),
        assign(stranger, s.ws, [item(s.q[1], s.ch[CH2], s.ch[CH1])]),
    ):
        assert seed.stable(res) == seed.stable(unknown), "non-member = unknown"

    # The path decides the workspace: a question of another workspace is 404 there.
    other = Space(seed, "chredist-c01-other")
    res = assign(s.owner, s.ws, [item(other.q[0], s.ch[CH2], other.ch[CH1])])
    assert res.status_code == 404
    assert chapter_of(other.owner, other.q[0]) == other.ch[CH1]

    # Share sessions have no such API.
    link = s.owner.create_link(s.ws, allow_fork=True)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    for path in ("/chapter-redistribution/questions", "/questions/chapter-assignments"):
        assert guest.read(link["id"], cookie, path).status_code == 404

    archived = Space(seed, "chredist-c01-archived")
    archived.owner.ok("POST", f"/workspaces/{archived.ws}/archive")
    for res in (
        archived.owner.call("GET", list_path(archived.ws)),
        preview(archived.owner, archived.ws, all=True),
        assign(
            archived.owner, archived.ws, [item(archived.q[0], archived.ch[CH2], archived.ch[CH1])]
        ),
    ):
        assert res.status_code == 403
        assert problem_type(res) == ARCHIVED

    deleted = Space(seed, "chredist-c01-deleted")
    assert deleted.owner.call("DELETE", f"/workspaces/{deleted.ws}").status_code in (200, 202, 204)
    res = deleted.owner.call("GET", list_path(deleted.ws))
    assert seed.stable(res) == seed.stable(unknown)


# ---------------------------------------------------------------------------------------------
# C02 validation and atomicity
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c02_one_bad_item_refuses_the_whole_request(seed: Any, db: Any) -> None:
    s = Space(seed, "chredist-c02")
    other = Space(seed, "chredist-c02-other")
    draft = s.owner.ok(
        "POST",
        f"/workspaces/{s.ws}/questions",
        {**notes_question_body(f"{s.token}-draft", 7, s.ch[CH1]), "publication_status": "DRAFT"},
        (201,),
    )
    before = {q["id"]: chapter_of(s.owner, q) for q in s.q}
    good = item(s.q[0], s.ch[CH2], s.ch[CH1])

    cases: list[tuple[str, list[dict[str, Any]], int, str | None]] = [
        ("empty", [], 422, None),
        ("duplicate", [good, good], 422, None),
        ("foreign question", [good, item(other.q[0], s.ch[CH2], other.ch[CH1])], 404, None),
        ("unknown question", [good, {**good, "question_id": RANDOM_ID}], 404, None),
        ("draft", [good, item(draft, s.ch[CH2], s.ch[CH1])], 409, NOT_CONFIRMED),
        ("stale expected", [good, item(s.q[1], s.ch[CH2], s.ch[CH2])], 409, CHAPTER_CHANGED),
        ("foreign chapter", [item(s.q[0], other.ch[CH1], s.ch[CH1])], 404, None),
    ]
    for name, items, status, ptype in cases:
        res = assign(s.owner, s.ws, items)
        seed.assert_status(res, status, name)
        if ptype:
            assert problem_type(res) == ptype, name
        assert {q["id"]: chapter_of(s.owner, q) for q in s.q} == before, f"{name}: nothing moved"
    conflict = assign(s.owner, s.ws, [good, item(s.q[1], s.ch[CH2], s.ch[CH2])])
    assert conflict.json()["question_ids"] == [s.q[1]["id"]]
    too_many = [{**good, "question_id": str(uuid.uuid4())} for _ in range(5001)]
    assert assign(s.owner, s.ws, too_many).status_code == 422
    [(changes,)] = db(
        "select count(*) from public.question_chapter_changes where workspace_id = %s", (s.ws,)
    )
    assert changes == 0

    # Already in the target and seen as such: unchanged, not moved.
    res = assign(
        s.owner,
        s.ws,
        [item(s.q[0], s.ch[CH2], s.ch[CH1]), item(s.q[3], s.ch[CH2], s.ch[CH2])],
    )
    seed.assert_status(res, 200, "move")
    assert res.json() == {"moved": 1, "unchanged": 1}
    # To "챕터 없음".
    res = assign(s.owner, s.ws, [item(s.q[1], None, s.ch[CH1])])
    seed.assert_status(res, 200, "to no chapter")
    assert chapter_of(s.owner, s.q[1]) is None


def notes_question_body(stem: str, n: int, chapter_id: str | None) -> dict[str, Any]:
    options = [{"id": f"opt-{i + 1}", "text": f"{stem} 보기 {i + 1}"} for i in range(4)]
    return {
        "question_type": "MCQ",
        "stem": stem,
        "options": options,
        "correct_option_ids": ["opt-1"],
        "is_multi_answer": False,
        "explanation": f"{stem} 해설",
        "chapter_id": chapter_id,
        "question_number": n,
    }


# ---------------------------------------------------------------------------------------------
# C03 idempotency only through the key
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c03_same_key_replays_keyless_replay_conflicts(seed: Any, db: Any) -> None:
    s = Space(seed, "chredist-c03")
    body = [item(s.q[0], s.ch[CH2], s.ch[CH1]), item(s.q[1], s.ch[CH2], s.ch[CH1])]
    key = str(uuid.uuid4())
    first = assign(s.owner, s.ws, body, key=key)
    seed.assert_status(first, 200, "first")
    again = assign(s.owner, s.ws, body, key=key)
    seed.assert_status(again, 200, "replay")
    assert again.json() == first.json()
    [(changes,)] = db(
        "select count(*) from public.question_chapter_changes where workspace_id = %s", (s.ws,)
    )
    [(activities,)] = db(
        "select count(*) from public.activity_events where workspace_id = %s "
        "and event_type = 'questions.chapters_reassigned'",
        (s.ws,),
    )
    assert (changes, activities) == (2, 1)

    keyless = assign(s.owner, s.ws, body)
    assert keyless.status_code == 409
    assert problem_type(keyless) == CHAPTER_CHANGED
    reused = assign(s.owner, s.ws, [item(s.q[2], s.ch[CH2], s.ch[CH1])], key=key)
    assert reused.status_code == 422
    assert problem_type(reused) == KEY_REUSED
    assert chapter_of(s.owner, s.q[2]) == s.ch[CH1]


# ---------------------------------------------------------------------------------------------
# C04 what an assignment writes
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c04_writes_source_history_activity_and_nothing_else(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chredist-c04")
    seed.assert_status(s.owner.call("GET", list_path(s.ws)), 200, "list")
    session = s.owner.ok("POST", f"/questions/{s.q[0]['id']}/practice-sessions", {}, (201,))
    s.owner.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    s.owner.ok("PATCH", f"/questions/{s.q[0]['id']}/my-state", {"is_favorite": True})
    before = counts(db, s.ws)
    [(updated_before,)] = db(
        "select updated_at from public.questions where id = %s", (s.q[0]["id"],)
    )

    res = assign(s.owner, s.ws, [item(s.q[0], s.ch[CH2], s.ch[CH1])])
    seed.assert_status(res, 200, "move")
    after = counts(db, s.ws)
    for table in UNCHANGED_TABLES:
        assert after[table] == before[table], table
    assert after["question_chapter_changes"] == before["question_chapter_changes"] + 1
    assert after["activity_events"] == before["activity_events"] + 1

    [(source, set_by, set_at, updated_at)] = db(
        "select chapter_source, chapter_set_by::text, chapter_set_at, updated_at "
        "from public.questions where id = %s",
        (s.q[0]["id"],),
    )
    assert (source, set_by) == ("manual", s.owner.user.id)
    assert set_at is not None
    assert updated_at > updated_before
    [(from_id, to_id, change_source, changed_by)] = db(
        "select from_chapter_id::text, to_chapter_id::text, source, changed_by::text "
        "from public.question_chapter_changes where question_id = %s",
        (s.q[0]["id"],),
    )
    assert (from_id, to_id, change_source, changed_by) == (
        s.ch[CH1],
        s.ch[CH2],
        "manual",
        s.owner.user.id,
    )
    [(payload,)] = db(
        "select metadata::text from public.activity_events where workspace_id = %s "
        "and event_type = 'questions.chapters_reassigned'",
        (s.ws,),
    )
    for text in (CH1, CH2, s.token):
        assert text not in payload, "no titles or stems in the activity"
    revision = s.owner.ok("GET", f"/questions/{s.q[0]['id']}")["revision"]
    assert revision["id"] == s.q[0]["revision"]["id"], "no new revision"


# ---------------------------------------------------------------------------------------------
# C05 recommendations reuse CHAPTER-MAP on the first source block
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c05_recommendation_rule_matches_the_draft_suggestion(
    seed: Any, db: Any
) -> None:
    x = import_space(seed, "chredist-c05", db)
    owner, ws, ids = x["owner"], x["ws"], x["ids"]
    # Direct questions filed under 1장 by hand: one whose first source is the paper (page 1),
    # one whose first source is page 4 of the book (2장).
    in_paper = owner.ok(
        "POST",
        f"/workspaces/{ws}/questions",
        {
            **notes_question_body(f"{notes.token()}-inpaper", 10, x["ch"][CH1]),
            "sources": [{"document_id": x["paper"], "page_start": 1, "page_end": 1}],
        },
        (201,),
    )
    book_q = owner.ok(
        "POST",
        f"/workspaces/{ws}/questions",
        {
            **notes_question_body(f"{notes.token()}-bookq", 11, x["ch"][CH1]),
            "sources": [{"document_id": x["book"], "page_start": 4, "page_end": 4}],
        },
        (201,),
    )

    res = preview(owner, ws, all=True, include_manual=True)
    seed.assert_status(res, 200, "preview")
    body = res.json()
    rows = {r["question_id"]: r for r in body["items"]}
    for key in ("A", "B", "C"):
        row = rows[ids[key]]
        assert row["recommended_chapter"]["id"] == x["titled_chapter"], key
        assert row["reason"] == "matched", key
        assert set(row) >= {"number_label", "stem_preview", "current_chapter"}
        assert len(row["stem_preview"]) <= 40
        assert not ANSWER_KEYS & set(notes.keys(row))
    # D was suggested this chapter as a draft: the same function, the same result (unchanged).
    assert x["d_suggestion"]["id"] == x["titled_chapter"]
    assert ids["D"] not in rows
    assert rows[str(book_q["id"])]["reason"] == "source_in_book"
    assert rows[str(book_q["id"])]["recommended_chapter"]["id"] == x["ch"][CH2]
    assert ids["E"] not in rows
    assert body["no_recommendation"].get("no_source", 0) >= 1
    assert rows[str(in_paper["id"])]["reason"] == "matched"
    assert rows[str(in_paper["id"])]["recommended_chapter"]["id"] == x["titled_chapter"]


# ---------------------------------------------------------------------------------------------
# C06 the preview is read-only
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c06_preview_writes_nothing_and_is_repeatable(seed: Any, db: Any) -> None:
    x = import_space(seed, "chredist-c06", db)
    owner, ws, ids = x["owner"], x["ws"], x["ids"]
    seed.assert_status(preview(owner, ws, all=True), 200, "preview")
    before = counts(db, ws)
    stamps = db(
        "select id::text, chapter_id::text, updated_at from public.questions "
        "where workspace_id = %s order by id",
        (ws,),
    )
    first = preview(owner, ws, all=True)
    second = preview(owner, ws, all=True)
    seed.assert_status(first, 200, "preview")
    assert first.json() == second.json()
    assert counts(db, ws) == before
    assert (
        db(
            "select id::text, chapter_id::text, updated_at from public.questions "
            "where workspace_id = %s order by id",
            (ws,),
        )
        == stamps
    )
    body = first.json()
    assert {r["question_id"] for r in body["items"]} == {ids["A"], ids["B"]}
    assert body["skipped_manual"] == 2
    assert body["unchanged"] == 1
    assert not ANSWER_KEYS & set(notes.keys(body))
    selected = preview(owner, ws, question_ids=[ids["A"], ids["D"]])
    seed.assert_status(selected, 200, "selected")
    assert [r["question_id"] for r in selected.json()["items"]] == [ids["A"]]
    assert selected.json()["unchanged"] == 1


# ---------------------------------------------------------------------------------------------
# C07 chapter_source rules
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c07_chapter_source_by_path_and_fork_copy(seed: Any, db: Any) -> None:
    x = import_space(seed, "chredist-c07", db)
    owner, ws, ids = x["owner"], x["ws"], x["ids"]

    def source(question_id: str) -> str:
        return str(owner.ok("GET", f"/questions/{question_id}")["chapter_source"])

    assert [source(ids[k]) for k in ("A", "B", "C", "D", "E")] == [
        "auto",
        "auto",
        "manual",
        "auto",
        "manual",
    ]
    # Editing the chapter makes it manual; applying a recommendation makes it auto.
    current = owner.ok("GET", f"/questions/{ids['A']}")
    owner.ok(
        "PATCH",
        f"/questions/{ids['A']}",
        {"base_revision_id": current["revision"]["id"], "chapter_id": x["ch"][CH2]},
    )
    assert source(ids["A"]) == "manual"
    res = assign(
        owner,
        ws,
        [
            {
                "question_id": ids["C"],
                "chapter_id": x["titled_chapter"],
                "expected_chapter_id": x["ch"][CH1],
            }
        ],
        source="recommendation",
    )
    seed.assert_status(res, 200, "apply")
    assert source(ids["C"]) == "auto"
    [(change_source,)] = db(
        "select source from public.question_chapter_changes where question_id = %s "
        "order by changed_at desc limit 1",
        (ids["C"],),
    )
    assert change_source == "recommendation"

    # Fork: chapter_source copied, chapter_set_by and history not.
    recipient = seed.client("chredist-c07-recipient")
    link = owner.create_link(ws, allow_fork=True)
    cookie = seed.guest().session(link["id"], link["secret"])
    forked = recipient.fork(link["id"], cookie, f"redist fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(forked, 202, "fork")
    target = str(recipient.wait_fork(str(forked.json()["id"]), "COMPLETED")["target_workspace_id"])
    rows = db(
        "select chapter_source, chapter_set_by from public.questions where workspace_id = %s",
        (target,),
    )
    assert sorted(r[0] for r in rows) == sorted(source(i) for i in ids.values())
    assert all(r[1] is None for r in rows)
    [(history,)] = db(
        "select count(*) from public.question_chapter_changes where workspace_id = %s", (target,)
    )
    assert history == 0


# ---------------------------------------------------------------------------------------------
# C08 consistency after a move
# ---------------------------------------------------------------------------------------------


def test_chredist_01_c08_overview_notes_and_logs_after_a_move(
    seed: Any, caplog: pytest.LogCaptureFixture
) -> None:
    s = Space(seed, "chredist-c08")
    notes.generate(s.owner, s.ch[CH1])
    notes.question(s.owner, s.ws, f"{s.token}-q6", 6, s.ch[CH2], OK)
    notes.generate(s.owner, s.ch[CH2])
    link = s.owner.create_link(s.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    shared_before = guest.read(link["id"], cookie, f"/chapters/{s.ch[CH1]}/note")
    seed.assert_status(shared_before, 200, "shared note before")

    caplog.set_level(logging.DEBUG)
    res = assign(s.owner, s.ws, [item(s.q[0], s.ch[CH2], s.ch[CH1])])
    seed.assert_status(res, 200, "move")
    overview = s.owner.ok("GET", f"/workspaces/{s.ws}/questions/overview")
    moved = next(i for i in overview["items"] if i["question_id"] == s.q[0]["id"])
    assert moved["chapter_id"] == s.ch[CH2]
    listed = {
        i["chapter_id"]: i for i in s.owner.ok("GET", f"/workspaces/{s.ws}/chapter-notes")["items"]
    }
    assert listed[s.ch[CH1]]["stale"] is True
    assert listed[s.ch[CH2]]["stale"] is True
    assert notes.state(s.owner, s.ch[CH1])["stale"] is True
    assert notes.state(s.owner, s.ch[CH2])["stale"] is True
    shared_after = guest.read(link["id"], cookie, f"/chapters/{s.ch[CH1]}/note")
    seed.assert_status(shared_after, 200, "shared note after: still source-matched")
    for text in (s.token, CH1, CH2):
        assert text not in caplog.text, "no stems or chapter titles in logs"


def test_chap_match_a_question_paper_level_one_chapter_is_a_valid_target(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chredist-paper-target")
    paper = notes.upload(s.owner, s.ws, PAPER, document_type="question_paper")
    top = notes.chapters(s.owner, paper)[PAPER_CHAPTER]
    res = assign(s.owner, s.ws, [item(s.q[0], top, s.ch[CH1])])
    seed.assert_status(res, 200, "paper level-1 target")
    assert chapter_of(s.owner, s.q[0]) == top
