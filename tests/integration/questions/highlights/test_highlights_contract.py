"""HILITE-01 server guarantees C01-C08 (docs/screens/highlights.md, questions.md §15,
workspace-sharing.md §11, architecture.md §5-§6).

Highlights are personal rows of the JWT `sub`, writable by every member and in archived workspaces
(C01); never in shared responses or fork copies (C02); targets and anchors are validated and the
quote is cut by the server (C03); merging, optimistic locking, idempotent delete and the 10-minute
restore (C04); explanation highlights are found again in a new revision or reported missing
(C05); chapter grouping follows the question's current chapter (C06); practice responses carry no
highlight and the question read shows only the user's quotes (C07); no quote in logs or
activities (C08).

Shapes are assumptions H1-H5 in tests/e2e/fixtures/highlights.ts (implemented as written by
UX9-HL-B). Jobs run in this process (conftest.py). The grant/RLS checks of C01 read the catalog as
the superuser here; supabase/tests/24_user_highlights.test.sql holds the pgTAP side. The
HighlightableText/HighlightMenu component contract (C09) is Vitest, written by UX9-HL-UI.
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
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_hilite", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

CH1, CH2 = notes.CH1, notes.CH2
OK, FAIL = notes.OK, notes.FAIL
RANDOM_ID = notes.RANDOM_ID
P = "urn:quiz-workspace:problem:"
ARCHIVED = P + "workspace-archived"
TARGET_UNAVAILABLE = P + "highlight-target-unavailable"
ANCHOR_INVALID = P + "highlight-anchor-invalid"
LIMIT = P + "highlight-limit"
CHANGED = P + "highlight-changed"
NOT_RESTORABLE = P + "highlight-not-restorable"
OVERLAP = P + "highlight-overlap"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "options"}


# ---------------------------------------------------------------------------------------------
# Helpers (H1-H4)
# ---------------------------------------------------------------------------------------------


def note_target(note_id: str) -> dict[str, Any]:
    return {"kind": "note", "chapter_note_id": note_id}


def explanation_target(question_id: str) -> dict[str, Any]:
    return {"kind": "explanation", "question_id": question_id}


def anchor(block: str, text: str, quote: str) -> dict[str, Any]:
    start = text.index(quote)
    return {"block": block, "start": start, "end": start + len(quote)}


def create(
    client: Any,
    target: dict[str, Any],
    anc: dict[str, Any],
    color: str = "yellow",
    key: str | None = None,
    **extra: Any,
) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    body = {"target": target, "anchor": anc, "color": color, **extra}
    return client.send("POST", "/my-highlights", body, headers=headers)


def created(client: Any, target: dict[str, Any], anc: dict[str, Any], **kw: Any) -> dict[str, Any]:
    out: dict[str, Any] = client.ok_response(
        create(client, target, anc, **kw), "POST", "highlight", (201,)
    )
    return out


def chapter_items(client: Any, chapter_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok("GET", f"/chapters/{chapter_id}/my-highlights")["items"]
    return items


def problem_type(res: Any) -> str | None:
    try:
        value = res.json().get("type")
    except ValueError:
        return None
    return None if value is None else str(value)


class Space:
    """book-ko, two CONFIRMED MCQs in 1장 (explanations below) and one note version of 1장."""

    EXPLANATION = "가나다 라마바 사아자"

    def __init__(self, seed: Any, label: str, *, note: bool = True) -> None:
        self.owner = seed.client(f"{label}-owner")
        self.ws = str(self.owner.create_workspace()["id"])
        self.ch = notes.book(self.owner, self.ws)
        self.token = notes.token()
        self.q1 = notes.question(
            self.owner, self.ws, f"{self.token}-q1", 1, self.ch[CH1], OK, self.EXPLANATION
        )
        self.q2 = notes.question(self.owner, self.ws, f"{self.token}-q2", 2, self.ch[CH1], OK)
        self.note = notes.generate(self.owner, self.ch[CH1])["note"] if note else None

    def item(self, s: int = 0, i: int = 0) -> str:
        assert self.note is not None
        return str(self.note["sections"][s]["items"][i]["text"])

    def note_highlight(self, client: Any, quote: str, s: int = 0, i: int = 0, **kw: Any) -> Any:
        assert self.note is not None
        return create(
            client,
            note_target(str(self.note["id"])),
            anchor(f"s{s}.i{i}", self.item(s, i), quote),
            **kw,
        )


# ---------------------------------------------------------------------------------------------
# C01 isolation and authorization
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c01_rows_of_the_caller_only_every_role_and_archived_workspaces(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "hilite-c01")
    viewer = notes.member(seed, s.ws, "hilite-c01-viewer", "viewer")
    editor = notes.member(seed, s.ws, "hilite-c01-editor", "editor")
    stranger = seed.client("hilite-c01-stranger")

    own = s.owner.ok_response(s.note_highlight(s.owner, "핵심 용어"), "POST", "owner", (201,))
    for client in (viewer, editor):
        res = s.note_highlight(client, "핵심 용어", color="blue")
        seed.assert_status(res, 201, "every member highlights")
    viewer_rows = chapter_items(viewer, s.ch[CH1])
    assert [h["color"] for h in viewer_rows] == ["blue"], "the viewer's own row only"
    assert own["id"] not in {h["id"] for h in viewer_rows}

    unknown_patch = viewer.call(
        "PATCH", f"/my-highlights/{RANDOM_ID}", {"color": "pink", "version": 1}
    )
    assert unknown_patch.status_code == 404
    for method, path, body in (
        ("PATCH", f"/my-highlights/{own['id']}", {"color": "pink", "version": own["version"]}),
        ("DELETE", f"/my-highlights/{own['id']}", None),
        ("POST", f"/my-highlights/{own['id']}/restore", {}),
    ):
        res = viewer.call(method, path, body)
        assert res.status_code == 404, method
        assert seed.stable(res) == seed.stable(unknown_patch), "another user's id = unknown id"
        assert "핵심" not in res.text
    assert [h["color"] for h in chapter_items(s.owner, s.ch[CH1])] == ["yellow"]

    # A target in a workspace the caller is not a member of: 404.
    res = s.note_highlight(stranger, "핵심 용어")
    assert res.status_code == 404
    assert stranger.call("GET", f"/chapters/{s.ch[CH1]}/my-highlights").status_code == 404

    # Archived: highlight writes still work; other writes stay 403.
    s.owner.ok("POST", f"/workspaces/{s.ws}/archive")
    made = s.owner.ok_response(
        s.note_highlight(s.owner, "묻는다", s=0, i=1, color="pink"), "POST", "archived", (201,)
    )
    patched = s.owner.ok(
        "PATCH", f"/my-highlights/{made['id']}", {"color": "blue", "version": made["version"]}
    )
    assert patched["color"] == "blue"
    assert s.owner.call("DELETE", f"/my-highlights/{made['id']}").status_code == 204
    restored = s.owner.ok("POST", f"/my-highlights/{made['id']}/restore", {})
    assert restored["id"] == made["id"]
    favourite = s.owner.call("PATCH", f"/questions/{s.q1['id']}/my-state", {"is_favorite": True})
    assert favourite.status_code == 403
    assert problem_type(favourite) == ARCHIVED

    # Deleted workspace: 404.
    assert s.owner.call("DELETE", f"/workspaces/{s.ws}").status_code in (200, 202, 204)
    assert s.owner.call("GET", f"/chapters/{s.ch[CH1]}/my-highlights").status_code == 404

    # Catalog (also pgTAP): quiz_api may not DELETE, browser roles nothing, RLS on.
    [(rls,)] = db(
        "select relrowsecurity from pg_class where oid = 'public.user_highlights'::regclass"
    )
    assert rls is True
    privileges = {
        (role, priv): has
        for role in ("quiz_api", "anon", "authenticated")
        for priv in ("SELECT", "INSERT", "UPDATE", "DELETE")
        for [(has,)] in [
            db("select has_table_privilege(%s, 'public.user_highlights', %s)", (role, priv))
        ]
    }
    assert privileges[("quiz_api", "SELECT")]
    assert privileges[("quiz_api", "INSERT")]
    assert privileges[("quiz_api", "DELETE")] is False
    assert not any(v for (role, _), v in privileges.items() if role in ("anon", "authenticated"))


# ---------------------------------------------------------------------------------------------
# C02 shared reads and forks
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c02_no_highlight_in_shared_responses_or_fork_copies(seed: Any, db: Any) -> None:
    s = Space(seed, "hilite-c02")
    s.owner.ok_response(s.note_highlight(s.owner, "핵심 용어"), "POST", "note", (201,))
    text = str(s.q1["revision"]["explanation"])
    created(s.owner, explanation_target(str(s.q1["id"])), anchor("p0", text, "라마바"))
    link = s.owner.create_link(s.ws, allow_fork=True)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    for path in ("", "/questions", "/chapter-notes", f"/chapters/{s.ch[CH1]}/note"):
        res = guest.read(link["id"], cookie, path)
        seed.assert_status(res, 200, f"shared {path or '/'}")
        assert not [k for k in notes.keys(res.json()) if "highlight" in k.lower()], path
        assert "라마바" not in res.text or path == "/questions"
    assert guest.read(link["id"], cookie, f"/chapters/{s.ch[CH1]}/my-highlights").status_code == 404

    recipient = seed.client("hilite-c02-recipient")
    forked = recipient.fork(link["id"], cookie, f"hilite fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(forked, 202, "fork")
    target = str(recipient.wait_fork(str(forked.json()["id"]), "COMPLETED")["target_workspace_id"])
    [(rows,)] = db("select count(*) from public.user_highlights where workspace_id = %s", (target,))
    assert rows == 0


# ---------------------------------------------------------------------------------------------
# C03 targets and anchors
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c03_targets_and_anchors_are_validated_and_the_quote_is_cut_by_the_server(
    seed: Any,
) -> None:
    s = Space(seed, "hilite-c03")
    text = str(s.q1["revision"]["explanation"])
    target = explanation_target(str(s.q1["id"]))

    out = created(s.owner, target, anchor("p0", text, "라마바"), quote="위조된 인용")
    assert out["quote"] == "라마바", "the server cuts the quote from the stored text"
    assert out["target"]["question_revision_id"] == s.q1["revision"]["id"]
    assert "prefix" not in out
    assert "suffix" not in out
    note_out = s.owner.ok_response(s.note_highlight(s.owner, "핵심 용어"), "POST", "note", (201,))
    assert note_out["quote"] == "핵심 용어"

    for name, anc in (
        ("empty", {"block": "p0", "start": 3, "end": 3}),
        ("reversed", {"block": "p0", "start": 5, "end": 2}),
        ("out of range", {"block": "p0", "start": 0, "end": len(text) + 1}),
        ("unknown block", {"block": "p9", "start": 0, "end": 1}),
    ):
        res = create(s.owner, target, anc)
        assert res.status_code == 422, name
        assert problem_type(res) == ANCHOR_INVALID, name
    assert create(s.owner, target, anchor("p0", text, "라마바"), color="green").status_code == 422

    # Unavailable targets: a failed note version, a draft question; archived questions are fine.
    t = notes.token()
    notes.questions(s.owner, s.ws, s.ch[CH2], FAIL, t, range(3, 5))
    notes.start(s.owner, s.ch[CH2])
    failed = notes.finish(s.owner, s.ch[CH2], "failed")
    res = create(
        s.owner,
        note_target(str(failed["generation"]["id"])),
        {"block": "s0.i0", "start": 0, "end": 1},
    )
    assert res.status_code == 409
    assert problem_type(res) == TARGET_UNAVAILABLE
    draft = s.owner.ok(
        "POST",
        f"/workspaces/{s.ws}/questions",
        {
            "question_type": "MCQ",
            "stem": f"{t} 초안",
            "options": [{"id": "opt-1", "text": "가"}],
            "correct_option_ids": ["opt-1"],
            "explanation": "초안 해설 글",
            "chapter_id": s.ch[CH1],
            "publication_status": "DRAFT",
        },
        (201,),
    )
    res = create(
        s.owner, explanation_target(str(draft["id"])), {"block": "p0", "start": 0, "end": 2}
    )
    assert res.status_code == 409
    assert problem_type(res) == TARGET_UNAVAILABLE
    archived = notes.patch_question(s.owner, s.q2, publication_status="ARCHIVED")
    q2_text = str(archived["revision"]["explanation"])
    created(s.owner, explanation_target(str(s.q2["id"])), anchor("p0", q2_text, q2_text[:3]))

    # Limits: quotes of at most 2,000 characters; 500 per user and target.
    long_text = "가" * 2100
    big = notes.question(s.owner, s.ws, f"{t}-big", 5, s.ch[CH1], OK, long_text)
    big_target = explanation_target(str(big["id"]))
    res = create(s.owner, big_target, {"block": "p0", "start": 0, "end": 2001})
    assert res.status_code == 422
    for k in range(500):
        res = create(s.owner, big_target, {"block": "p0", "start": 2 * k, "end": 2 * k + 1})
        assert res.status_code == 201, k
    res = create(s.owner, big_target, {"block": "p0", "start": 1001 * 2, "end": 1001 * 2 + 1})
    assert res.status_code == 409
    assert problem_type(res) == LIMIT


# ---------------------------------------------------------------------------------------------
# C04 merging, locking, delete and restore
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c04_merge_lock_delete_and_restore(seed: Any, db: Any) -> None:
    s = Space(seed, "hilite-c04", note=False)
    other = seed.client("hilite-c04-other")
    seed.membership(s.ws, other.user, "viewer")
    text = str(s.q1["revision"]["explanation"])
    target = explanation_target(str(s.q1["id"]))
    first = created(s.owner, target, anchor("p0", text, "라마바"))

    # replace_ids: overlapping, same user and target; else 422 and nothing changes.
    far = created(s.owner, target, anchor("p0", text, "가나다"))
    res = create(s.owner, target, anchor("p0", text, "바 사아"), replace_ids=[far["id"]])
    assert res.status_code == 422, "not overlapping"
    theirs = created(other, target, anchor("p0", text, "라마"))
    res = create(s.owner, target, anchor("p0", text, "마바 사"), replace_ids=[theirs["id"]])
    assert res.status_code == 422, "another user's highlight"
    key = str(uuid.uuid4())
    merged = create(
        s.owner,
        target,
        anchor("p0", text, "라마바 사아"),
        color="blue",
        key=key,
        replace_ids=[first["id"]],
    )
    seed.assert_status(merged, 201, "merge")
    again = create(
        s.owner,
        target,
        anchor("p0", text, "라마바 사아"),
        color="blue",
        key=key,
        replace_ids=[first["id"]],
    )
    assert again.json()["id"] == merged.json()["id"], "the same key replays"
    live = {h["id"]: h for h in chapter_items(s.owner, s.ch[CH1])}
    assert first["id"] not in live
    assert merged.json()["id"] in live
    assert far["id"] in live
    [(deleted_at,)] = db(
        "select deleted_at from public.user_highlights where id = %s", (first["id"],)
    )
    assert deleted_at is not None

    # PATCH with a stale version → 409; DELETE is idempotent.
    m = merged.json()
    res = s.owner.call(
        "PATCH", f"/my-highlights/{m['id']}", {"color": "pink", "version": m["version"] + 7}
    )
    assert res.status_code == 409
    assert problem_type(res) == CHANGED
    assert s.owner.call("DELETE", f"/my-highlights/{far['id']}").status_code == 204
    assert s.owner.call("DELETE", f"/my-highlights/{far['id']}").status_code == 204

    # Restore: same id, anchor, color, version + 1.
    restored = s.owner.ok("POST", f"/my-highlights/{far['id']}/restore", {})
    assert (restored["id"], restored["anchor"], restored["color"]) == (
        far["id"],
        far["anchor"],
        far["color"],
    )
    assert restored["version"] == far["version"] + 1
    res = s.owner.call("POST", f"/my-highlights/{far['id']}/restore", {})
    assert problem_type(res) == NOT_RESTORABLE, "not deleted"
    res = s.owner.call("POST", f"/my-highlights/{first['id']}/restore", {})
    assert problem_type(res) == NOT_RESTORABLE, "replaced rows are not restorable"
    # Older than 10 minutes.
    assert s.owner.call("DELETE", f"/my-highlights/{far['id']}").status_code == 204
    db(
        "update public.user_highlights set deleted_at = now() - interval '11 minutes' "
        "where id = %s",
        (far["id"],),
    )
    res = s.owner.call("POST", f"/my-highlights/{far['id']}/restore", {})
    assert res.status_code == 409
    assert problem_type(res) == NOT_RESTORABLE
    # Overlap with a live highlight made meanwhile.
    m2 = s.owner.ok(
        "PATCH", f"/my-highlights/{m['id']}", {"color": "pink", "version": m["version"]}
    )
    assert s.owner.call("DELETE", f"/my-highlights/{m2['id']}").status_code == 204
    created(s.owner, target, anchor("p0", text, "바 사"))
    res = s.owner.call("POST", f"/my-highlights/{m2['id']}/restore", {})
    assert res.status_code == 409
    assert problem_type(res) == OVERLAP


# ---------------------------------------------------------------------------------------------
# C05 re-anchoring
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c05_explanation_highlights_relocate_or_go_missing_note_ones_stay_exact(
    seed: Any,
) -> None:
    s = Space(seed, "hilite-c05")
    text = str(s.q1["revision"]["explanation"])
    target = explanation_target(str(s.q1["id"]))
    h = created(s.owner, target, anchor("p0", text, "라마바"))
    s.owner.ok_response(s.note_highlight(s.owner, "핵심 용어"), "POST", "note", (201,))

    def mine() -> dict[str, dict[str, Any]]:
        return {x["quote"]: x for x in chapter_items(s.owner, s.ch[CH1])}

    assert mine()["라마바"]["anchor_status"] == "exact"
    notes.patch_question(s.owner, s.q1, explanation="가나다 (보충) 라마바 사아자")
    moved = mine()["라마바"]
    assert moved["anchor_status"] == "relocated"
    assert moved["anchor_current"] == {"block": "p0", "start": 9, "end": 12}
    assert moved["anchor"] == h["anchor"], "the stored anchor is kept"
    # The same quote twice: prefix/suffix pick the right one.
    notes.patch_question(s.owner, s.q1, explanation="라마바 앞 가나다 (보충) 라마바 사아자")
    assert mine()["라마바"]["anchor_current"]["start"] == 15
    notes.patch_question(s.owner, s.q1, explanation="가나다 사아자")
    gone = mine()["라마바"]
    assert gone["anchor_status"] == "missing"
    assert gone.get("anchor_current") is None
    notes.generate(s.owner, s.ch[CH1])
    assert mine()["핵심 용어"]["anchor_status"] == "exact", "note versions never change"
    question_rows = s.owner.ok("GET", f"/questions/{s.q1['id']}/my-highlights")["items"]
    assert [x["anchor_status"] for x in question_rows] == ["missing"]


# ---------------------------------------------------------------------------------------------
# C06 chapter grouping
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c06_a_chapter_lists_its_note_versions_and_its_live_questions(seed: Any) -> None:
    s = Space(seed, "hilite-c06")
    s.owner.ok_response(s.note_highlight(s.owner, "핵심 용어"), "POST", "v1", (201,))
    v2 = notes.generate(s.owner, s.ch[CH1])["note"]
    created(
        s.owner,
        note_target(str(v2["id"])),
        anchor("s0.i1", str(v2["sections"][0]["items"][1]["text"]), "묻는다"),
    )
    q1_text = str(s.q1["revision"]["explanation"])
    created(s.owner, explanation_target(str(s.q1["id"])), anchor("p0", q1_text, "라마바"))
    q2_text = str(s.q2["revision"]["explanation"])
    created(s.owner, explanation_target(str(s.q2["id"])), anchor("p0", q2_text, q2_text[:4]))
    loose = notes.question(s.owner, s.ws, f"{s.token}-loose", 3, None, OK, "챕터 없는 해설")
    created(s.owner, explanation_target(str(loose["id"])), anchor("p0", "챕터 없는 해설", "없는"))
    other = notes.question(s.owner, s.ws, f"{s.token}-ch2", 4, s.ch[CH2], OK, "다른 장 해설")
    created(s.owner, explanation_target(str(other["id"])), anchor("p0", "다른 장 해설", "다른"))

    items = chapter_items(s.owner, s.ch[CH1])
    assert [x["target"]["kind"] for x in items] == ["note", "note", "explanation", "explanation"]
    assert [x["target"].get("note_version") for x in items[:2]] == [2, 1]
    assert [x["quote"] for x in items[2:]] == ["라마바", q2_text[:4]]
    for x in items[2:]:
        assert set(x["question"]) >= {"question_id", "number_label", "stem_preview"}
        assert len(x["question"]["stem_preview"]) <= 40
        assert not ANSWER_KEYS & set(notes.keys(x))
    none = s.owner.ok("GET", f"/workspaces/{s.ws}/my-highlights?chapter=none")["items"]
    assert [x["quote"] for x in none] == ["없는"]
    assert s.owner.call("GET", f"/workspaces/{s.ws}/my-highlights").status_code in (404, 422)

    # Archived or deleted questions leave the chapter; unarchived they come back.
    archived = notes.patch_question(s.owner, s.q2, publication_status="ARCHIVED")
    assert [x["quote"] for x in chapter_items(s.owner, s.ch[CH1])][2:] == ["라마바"]
    notes.patch_question(s.owner, archived, publication_status="CONFIRMED")
    assert len(chapter_items(s.owner, s.ch[CH1])) == 4
    notes.delete_question(s.owner, s.q1)
    assert [x["quote"] for x in chapter_items(s.owner, s.ch[CH1])][2:] == [q2_text[:4]]
    assert "다른" not in {x["quote"] for x in chapter_items(s.owner, s.ch[CH1])}


# ---------------------------------------------------------------------------------------------
# C07 no highlight in practice responses
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c07_practice_responses_carry_no_highlights(seed: Any) -> None:
    s = Space(seed, "hilite-c07", note=False)
    viewer = notes.member(seed, s.ws, "hilite-c07-viewer", "viewer")
    text = str(s.q1["revision"]["explanation"])
    created(s.owner, explanation_target(str(s.q1["id"])), anchor("p0", text, "라마바"))

    session = s.owner.ok("POST", f"/questions/{s.q1['id']}/practice-sessions", {}, (201,))
    submitted = s.owner.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    run = s.owner.ok_response(
        s.owner.send(
            "POST",
            f"/workspaces/{s.ws}/practice-runs",
            {"source": "bank", "range": {"question_ids": [s.q1["id"]]}, "random_order": False},
        ),
        "POST",
        "practice-runs",
        (201,),
    )
    run_item = s.owner.ok("GET", f"/practice-runs/{run['id']}/items/1")
    for name, body in (("session", session), ("submit", submitted), ("run item", run_item)):
        assert not [k for k in notes.keys(body) if "highlight" in k.lower()], name
        assert "라마바" not in str(body) or name == "submit"

    # GET /questions/{id}/my-highlights: any member, own quotes only, never the explanation.
    mine = s.owner.ok("GET", f"/questions/{s.q1['id']}/my-highlights")["items"]
    assert [x["quote"] for x in mine] == ["라마바"]
    assert "explanation" not in notes.keys(mine)
    assert text not in str(mine)
    assert viewer.ok("GET", f"/questions/{s.q1['id']}/my-highlights")["items"] == []


# ---------------------------------------------------------------------------------------------
# C08 no quotes in logs, no activity
# ---------------------------------------------------------------------------------------------


def test_hilite_01_c08_no_quote_in_logs_and_no_activity(
    seed: Any, db: Any, caplog: pytest.LogCaptureFixture
) -> None:
    s = Space(seed, "hilite-c08", note=False)
    secret = f"인용비밀{uuid.uuid4().hex[:6]}"
    q = notes.question(s.owner, s.ws, f"{s.token}-q9", 9, s.ch[CH1], OK, f"앞 {secret} 뒤")
    [(before,)] = db("select count(*) from public.activity_events where workspace_id = %s", (s.ws,))
    caplog.set_level(logging.DEBUG)
    h = created(s.owner, explanation_target(str(q["id"])), anchor("p0", f"앞 {secret} 뒤", secret))
    patched = s.owner.ok(
        "PATCH", f"/my-highlights/{h['id']}", {"color": "pink", "version": h["version"]}
    )
    assert s.owner.call("DELETE", f"/my-highlights/{patched['id']}").status_code == 204
    s.owner.ok("POST", f"/my-highlights/{patched['id']}/restore", {})
    chapter_items(s.owner, s.ch[CH1])
    assert secret not in caplog.text
    [(after,)] = db("select count(*) from public.activity_events where workspace_id = %s", (s.ws,))
    assert after == before, "highlights write no workspace activity"
