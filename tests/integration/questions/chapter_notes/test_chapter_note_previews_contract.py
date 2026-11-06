"""CHNOTE-02 server guarantees C01-C03 (docs/screens/chapter-note-tools.md).

The member preview API serves only the stem and options of a live CONFIRMED question and records
nothing (C01); the shared preview serves the same DTO for questions in the share's published scope
only (C02); the note APIs and the practice responses are unchanged by UX9 (C03, a regression guard
that is GREEN before UX9-NOTE-B, so it carries no `red` marker).

Shapes are assumption P1 in tests/e2e/fixtures/highlights.ts; the note shapes are N1-N5 in
tests/e2e/fixtures/chapter-notes.ts. Jobs run in this process (conftest.py). C01 and C02
lost their `red` marker in UX9-NOTE-B. The search function and the stacking rule
(C04, C05) are Vitest contracts written by UX9-NOTE-W.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.infra

_NOTES = Path(__file__).resolve().parent / "test_chapter_notes_contract.py"
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_previews", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

CH1 = notes.CH1
OK = notes.OK
RANDOM_ID = notes.RANDOM_ID
DTO_KEYS = {
    "question_id",
    "number_label",
    "chapter_title",
    "question_type",
    "stem",
    "stem_tables",
    "options",
}
FORBIDDEN = {
    "correct_option_ids",
    "correct",
    "is_correct",
    "answer",
    "accepted_answers",
    "rubric",
    "explanation",
    "ai_explanation",
    "highlights",
}
# N1 ChapterNoteState (CHNOTE-01, unchanged by UX9).
NOTE_STATE_KEYS = {
    "chapter_id",
    "chapter_title",
    "available",
    "confirmed_question_count",
    "generation",
    "note",
    "versions",
    "stale",
}


def counts(db: Any, ws: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for table in (
        "question_user_states",
        "practice_sessions",
        "question_attempts",
        "activity_events",
    ):
        [(n,)] = db(f"select count(*) from public.{table} where workspace_id = %s", (ws,))  # noqa: S608
        out[table] = int(n)
    return out


class Space:
    def __init__(self, seed: Any, label: str) -> None:
        self.owner = seed.client(f"{label}-owner")
        self.ws = str(self.owner.create_workspace()["id"])
        self.ch = notes.book(self.owner, self.ws)
        t = notes.token()
        self.qs = notes.questions(self.owner, self.ws, self.ch[CH1], OK, t, range(1, 4))
        self.token = t


def test_chnote_02_c01_member_preview_is_stem_and_options_only_and_records_nothing(
    seed: Any, db: Any
) -> None:
    s = Space(seed, "chnote02-c01")
    viewer = notes.member(seed, s.ws, "chnote02-c01-viewer", "viewer")
    q = s.qs[1]
    before = counts(db, s.ws)
    for client in (s.owner, viewer):
        res = client.call("GET", f"/questions/{q['id']}/preview")
        seed.assert_status(res, 200, "preview")
        body = res.json()
        assert set(body) == DTO_KEYS
        assert not FORBIDDEN & set(notes.keys(body))
        assert body["question_id"] == q["id"]
        assert body["stem"] == q["revision"]["stem"]
        assert body["options"] == q["revision"]["options"], "original order, {id, text} only"
        assert body["number_label"] == "2번"
        assert body["chapter_title"] == CH1
        assert str(q["revision"]["explanation"]) not in res.text
    assert counts(db, s.ws) == before, "no view, session, attempt or activity"

    # Archived workspaces keep it; drafts, archived, deleted, foreign and unknown are 404.
    unknown = s.owner.call("GET", f"/questions/{RANDOM_ID}/preview")
    assert unknown.status_code == 404
    draft = s.owner.ok(
        "POST",
        f"/workspaces/{s.ws}/questions",
        {
            "question_type": "MCQ",
            "stem": f"{s.token} 초안",
            "options": [{"id": "opt-1", "text": "가"}],
            "correct_option_ids": ["opt-1"],
            "publication_status": "DRAFT",
        },
        (201,),
    )
    archived = notes.patch_question(s.owner, s.qs[2], publication_status="ARCHIVED")
    notes.delete_question(s.owner, s.qs[0])
    other = Space(seed, "chnote02-c01-other")
    for qid in (draft["id"], archived["id"], s.qs[0]["id"], other.qs[0]["id"]):
        res = s.owner.call("GET", f"/questions/{qid}/preview")
        assert seed.stable(res) == seed.stable(unknown)
    s.owner.ok("POST", f"/workspaces/{s.ws}/archive")
    seed.assert_status(viewer.call("GET", f"/questions/{q['id']}/preview"), 200, "archived")


def test_chnote_02_c02_shared_preview_serves_published_questions_only(seed: Any) -> None:
    s = Space(seed, "chnote02-c02")
    link = s.owner.create_link(s.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    q = s.qs[0]
    res = guest.read(link["id"], cookie, f"/questions/{q['id']}/preview")
    seed.assert_status(res, 200, "shared preview")
    seed.assert_privacy_headers(res, "shared preview")
    assert set(res.json()) == DTO_KEYS
    assert not FORBIDDEN & set(notes.keys(res.json()))
    unknown = guest.read(link["id"], cookie, f"/questions/{RANDOM_ID}/preview")
    assert unknown.status_code == 404
    other = Space(seed, "chnote02-c02-other")
    archived = notes.patch_question(s.owner, s.qs[1], publication_status="ARCHIVED")
    for qid in (other.qs[0]["id"], archived["id"]):
        res = guest.read(link["id"], cookie, f"/questions/{qid}/preview")
        assert seed.stable(res) == seed.stable(unknown)
    seed.assert_status(s.owner.revoke(s.ws, link["id"]), 200, "revoke")
    assert guest.read(link["id"], cookie, f"/questions/{q['id']}/preview").status_code == 404


def test_chnote_02_c03_note_apis_and_practice_responses_are_unchanged(seed: Any) -> None:
    s = Space(seed, "chnote02-c03")
    notes.generate(s.owner, s.ch[CH1])
    member = notes.state(s.owner, s.ch[CH1])
    assert set(member) == NOTE_STATE_KEYS
    link = s.owner.create_link(s.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    shared = guest.read(link["id"], cookie, f"/chapters/{s.ch[CH1]}/note")
    seed.assert_status(shared, 200, "shared note")
    assert set(shared.json()) == {
        "chapter_id",
        "chapter_title",
        "created_at",
        "question_count",
        "stale",
        "sections",
        "footnotes",
    }
    session = s.owner.ok("POST", f"/questions/{s.qs[0]['id']}/practice-sessions", {}, (201,))
    submitted = s.owner.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    for name, body in (("session", session), ("submit", submitted)):
        leaked = [
            k
            for k in notes.keys(body)
            if any(w in k.lower() for w in ("note", "preview", "highlight"))
        ]
        assert leaked == [], name
