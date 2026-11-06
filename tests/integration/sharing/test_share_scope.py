"""UX12-SHARE: link scope flags against every shared route, and the owner's records.

docs/workspace-sharing.md §12, docs/screens/ux12-share-scope.md. Runs the real API and SQL against
the local stack. Content that needs the LLM pipelines is seeded directly: these tests are about
who may read it, not how it is made.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from book_core.explain import FAKE_MODEL, PROMPT_VERSION
from quiz_api.settings import Settings

pytestmark = pytest.mark.infra

RANDOM_ID = "00000000-0000-4000-8000-000000000000"
OPTIONS = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(["A", "B", "C", "D"])]
UNIT_BODY = {"title": "요약", "summary_md": "요약 본문", "key_points": []}
EXPLANATION = {
    "correct_option_ids": ["opt-1"],
    "summary_md": "AI 요약",
    "options": [{"option_id": o["id"], "why_md": "why"} for o in OPTIONS],
    "concepts_md": "개념",
}


@dataclass
class World:
    owner: Any
    ws: str
    doc: str
    revision: str
    chapter: str
    section_key: str
    question: dict[str, Any]
    note: str


def _question(owner: Any, ws: str, chapter: str, stem: str) -> dict[str, Any]:
    out: dict[str, Any] = owner.ok(
        "POST",
        f"/workspaces/{ws}/questions",
        {
            "question_type": "MCQ",
            "stem": stem,
            "chapter_id": chapter,
            "options": OPTIONS,
            "correct_option_ids": ["opt-1"],
            "is_multi_answer": False,
            "explanation": f"공개 해설 {stem}",
        },
        (201,),
    )
    return out


def _seed_note(seed: Any, w: World, question: dict[str, Any], text: str = "노트 문장 공개") -> str:
    body = {"sections": [{"heading": "h", "items": [{"text": text, "tags": ["Q1"]}]}]}
    refs = json.dumps(
        [
            {
                "tag": "Q1",
                "question_id": question["id"],
                "question_revision_id": question["revision"]["id"],
                "label": "1장 1번",
            }
        ]
    )
    rows = seed._admin(
        "insert into public.chapter_notes (workspace_id, document_id, document_revision_id, "
        "section_key, input_fingerprint, body_hash, question_refs) "
        "values (%s, %s, %s, %s, repeat('0', 64), repeat('b', 64), %s::jsonb) returning id",
        (w.ws, w.doc, w.revision, w.section_key, refs),
    )
    note = str(rows[0][0])
    next_version = seed._admin(
        "select coalesce(max(version), 0) + 1 from public.chapter_notes "
        "where document_id = %s and section_key = %s",
        (w.doc, w.section_key),
    )[0][0]
    seed._admin(
        "update public.chapter_notes set superseded_at = now() "
        "where document_id = %s and section_key = %s and status = 'succeeded'",
        (w.doc, w.section_key),
    )
    seed._admin(
        "update public.chapter_notes set status = 'succeeded', version = %s, finished_at = now(), "
        "body = %s::jsonb where id = %s",
        (next_version, json.dumps(body), note),
    )
    return note


def _world(seed: Any, label: str) -> World:
    owner = seed.client(f"scope-{label}")
    ws = owner.create_workspace()["id"]
    _, _, done = owner.upload_book(ws)
    owner.wait_for_job(str(done["job_id"]))
    doc = str(done["document_id"])
    outline = owner.ok("GET", f"/documents/{doc}/outline")["items"][0]
    chapter = outline["id"]
    revision, section_key = seed._admin(
        "select document_revision_id::text, section_key from public.chapters where id = %s",
        (chapter,),
    )[0]
    question = _question(owner, ws, chapter, "범위 문제 하나")
    w = World(owner, ws, doc, revision, chapter, section_key, question, "")
    w.note = _seed_note(seed, w, question)
    run = seed._admin(
        "insert into public.document_summary_runs (workspace_id, document_id, "
        "document_revision_id, status, trigger, finished_at) "
        "values (%s, %s, %s, 'succeeded', 'manual', now()) returning id",
        (ws, doc, revision),
    )[0][0]
    unit = seed._admin(
        "insert into public.document_summary_units (workspace_id, document_id, scope, "
        "section_key, input_hash, prompt_version, model, body) "
        "values (%s, %s, 'document', 'document', repeat('c', 64), 'p', 'm', %s::jsonb) "
        "returning id",
        (ws, doc, json.dumps(UNIT_BODY)),
    )[0][0]
    seed._admin(
        "insert into public.document_summary_run_units (workspace_id, run_id, unit_id, position) "
        "values (%s, %s, %s, 0)",
        (ws, run, unit),
    )
    seed._admin(
        "insert into public.question_ai_explanations (workspace_id, question_id, "
        "question_revision_id, status, prompt_version, model, body, finished_at) "
        "values (%s, %s, %s, 'succeeded', %s, %s, %s::jsonb, now())",
        (
            ws,
            question["id"],
            question["revision"]["id"],
            PROMPT_VERSION,
            Settings().ai_explanation_model or FAKE_MODEL,
            json.dumps(EXPLANATION),
        ),
    )
    return w


def _session(seed: Any, w: World, **scope: Any) -> tuple[dict[str, Any], str]:
    link = w.owner.create_link(w.ws, **scope)
    return link, seed.guest().session(link["id"], link["secret"])


def _routes(w: World) -> dict[str, list[str]]:
    return {
        "include_notes": ["/chapter-notes", f"/chapters/{w.chapter}/note"],
        "include_ai_explanations": [f"/questions/{w.question['id']}/ai-explanation"],
        "include_summary": [f"/documents/{w.doc}/summary"],
    }


def test_scope_flag_matrix_over_every_shared_route(seed: Any) -> None:
    """Each flag closes its own routes, with the body of a missing id, and no other route."""
    w = _world(seed, "matrix")
    link, cookie = _session(seed, w)
    guest = seed.guest()
    q = w.question["id"]
    always = [
        "",
        f"/documents/{w.doc}",
        "/questions",
        f"/questions/{q}",
        f"/questions/{q}/preview",
    ]
    routes = _routes(w)
    misses = {
        "include_notes": f"/chapters/{RANDOM_ID}/note",
        "include_ai_explanations": f"/questions/{RANDOM_ID}/ai-explanation",
        "include_summary": f"/documents/{RANDOM_ID}/summary",
    }
    for paths in routes.values():
        for path in paths:
            seed.assert_status(guest.read(link["id"], cookie, path), 200, f"on: {path}")

    for flag, closed in routes.items():
        seed.assert_status(w.owner.patch_link(w.ws, link["id"], **{flag: False}), 200, flag)
        missing = guest.read(link["id"], cookie, misses[flag])
        for path in closed:
            res = guest.read(link["id"], cookie, path)
            seed.assert_status(res, 404, f"{flag} off: {path}")
            assert seed.stable(res) == seed.stable(missing), path
            seed.assert_privacy_headers(res, path)
        for path in always:
            seed.assert_status(guest.read(link["id"], cookie, path), 200, f"{flag} off: {path}")
        for other, paths in routes.items():
            if other != flag:
                for path in paths:
                    seed.assert_status(guest.read(link["id"], cookie, path), 200, path)
        shared = guest.read(link["id"], cookie).json()
        assert shared[flag] is False
        seed.assert_status(w.owner.patch_link(w.ws, link["id"], **{flag: True}), 200, flag)


def _highlight(owner: Any, question: dict[str, Any], quote: str, color: str = "yellow") -> str:
    text = question["revision"]["explanation"]
    start = text.index(quote)
    out: dict[str, Any] = owner.ok(
        "POST",
        "/my-highlights",
        {
            "target": {"kind": "explanation", "question_id": question["id"]},
            "anchor": {"block": "p0", "start": start, "end": start + len(quote)},
            "color": color,
        },
        (201,),
    )
    return str(out["id"])


def _note_highlight(owner: Any, note: str, text: str, quote: str) -> str:
    start = text.index(quote)
    out: dict[str, Any] = owner.ok(
        "POST",
        "/my-highlights",
        {
            "target": {"kind": "note", "chapter_note_id": note},
            "anchor": {"block": "s0.i0", "start": start, "end": start + len(quote)},
            "color": "pink",
        },
        (201,),
    )
    return str(out["id"])


def test_owner_records_are_off_by_default_and_only_the_owners(seed: Any) -> None:
    w = _world(seed, "owner")
    member = seed.client("scope-member")
    seed.membership(w.ws, member.user, "editor")
    q, rev = w.question["id"], w.question["revision"]["id"]
    seed.graded_attempt(w.ws, q, rev, w.owner.user.id)
    seed.graded_attempt(w.ws, q, rev, member.user.id)
    seed.study_state(w.owner.user.id, w.ws, q)
    mine = _highlight(w.owner, w.question, "공개 해설")
    theirs = _highlight(member, w.question, "범위 문제", "blue")

    link, cookie = _session(seed, w)
    guest = seed.guest()
    missing = guest.read(link["id"], cookie, f"/questions/{RANDOM_ID}")
    for path in ("/owner-attempts", "/owner-highlights"):
        res = guest.read(link["id"], cookie, path)
        seed.assert_status(res, 404, f"off: {path}")
        assert seed.stable(res) == seed.stable(missing), path

    seed.assert_status(
        w.owner.patch_link(w.ws, link["id"], include_owner_records=True), 200, "turn on"
    )
    attempts = guest.read(link["id"], cookie, "/owner-attempts?user_id=" + str(member.user.id))
    seed.assert_status(attempts, 200, "attempts")
    seed.assert_privacy_headers(attempts, "attempts")
    items = attempts.json()["items"]
    assert len(items) == 1, "the owner's attempt only: no parameter selects another user"
    assert set(items[0]) == {"id", "question", "question_type", "result", "submitted_at"}
    assert set(items[0]["question"]) == {"question_id", "number_label", "stem_preview"}
    assert items[0]["result"] == "correct"

    highlights = guest.read(link["id"], cookie, "/owner-highlights")
    seed.assert_status(highlights, 200, "highlights")
    rows = highlights.json()["items"]
    assert [r["id"] for r in rows] == [mine]
    assert theirs not in highlights.text
    assert rows[0]["quote"] == "공개 해설"
    assert rows[0]["kind"] == "explanation"
    assert set(rows[0]) == {
        "id",
        "kind",
        "color",
        "quote",
        "question",
        "chapter_title",
        "created_at",
    }
    for res in (attempts, highlights):
        for private in (str(w.owner.user.id), str(member.user.id), "user_id", "email"):
            assert private not in res.text, private
        for key in seed.PERSONAL_KEYS:
            assert key not in res.json()["items"][0], key

    before = seed.private_counts(w.ws)
    for method, path in (
        ("POST", f"/shared/{link['id']}/owner-attempts"),
        ("POST", f"/shared/{link['id']}/owner-highlights"),
        ("DELETE", f"/shared/{link['id']}/owner-highlights"),
        ("PATCH", f"/shared/{link['id']}/owner-attempts"),
    ):
        res = guest.send(method, path, {}, cookie=cookie)
        seed.assert_status(res, 405, f"{method} {path}")
    assert seed.private_counts(w.ws) == before

    seed.assert_status(
        w.owner.patch_link(w.ws, link["id"], include_owner_records=False), 200, "turn off"
    )
    seed.assert_status(guest.read(link["id"], cookie, "/owner-attempts"), 404, "off again")

    # Rotate carries the option; a session of the old link is over anyway.
    seed.assert_status(w.owner.patch_link(w.ws, link["id"], include_owner_records=True), 200, "on")
    rotated = w.owner.rotate(w.ws, link["id"]).json()
    assert rotated["include_owner_records"] is True
    fresh = seed.guest().session(rotated["id"], rotated["secret"])
    seed.assert_status(guest.read(rotated["id"], fresh, "/owner-attempts"), 200, "rotated")


def test_owner_records_follow_the_owner_not_the_link_creator(seed: Any) -> None:
    w = _world(seed, "creator")
    other = seed.client("scope-other-owner")
    link, cookie = _session(seed, w, include_owner_records=True)
    # Whoever the row says created the link, the records stay `workspaces.owner_id`'s.
    seed.membership(w.ws, other.user, "editor")
    seed._admin(
        "update public.workspace_share_links set created_by = %s where id = %s",
        (other.user.id, link["id"]),
    )
    q, rev = w.question["id"], w.question["revision"]["id"]
    seed.graded_attempt(w.ws, q, rev, other.user.id)
    assert seed.guest().read(link["id"], cookie, "/owner-attempts").json()["items"] == []


def test_records_outside_the_share_stay_hidden(seed: Any) -> None:
    w = _world(seed, "outside")
    link, cookie = _session(seed, w, include_owner_records=True)
    guest = seed.guest()
    q, rev = w.question["id"], w.question["revision"]["id"]

    def attempts() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = guest.read(link["id"], cookie, "/owner-attempts").json()[
            "items"
        ]
        return out

    def quotes() -> list[str]:
        return [
            i["quote"] for i in guest.read(link["id"], cookie, "/owner-highlights").json()["items"]
        ]

    # An edit that drops the quote hides it (older text is outside the share); the words that are
    # still in the current explanation stay.
    seed.graded_attempt(w.ws, q, rev, w.owner.user.id)
    _highlight(w.owner, w.question, "공개 해설")
    _highlight(w.owner, w.question, "문제 하나", "blue")
    assert sorted(quotes()) == ["공개 해설", "문제 하나"]
    edited = w.owner.ok(
        "PATCH",
        f"/questions/{q}",
        {"explanation": "문제 하나 다음에 새로 쓴 설명", "base_revision_id": rev},
        (200,),
    )
    assert edited["revision"]["id"] != rev
    assert quotes() == ["문제 하나"]
    assert "공개 해설" not in guest.read(link["id"], cookie, "/owner-highlights").text

    # Note highlights: only the version the guest reads now, and only while notes are included.
    old = _note_highlight(w.owner, w.note, "노트 문장 공개", "노트 문장")
    current = _seed_note(seed, w, edited, "새 버전 노트")
    new = _note_highlight(w.owner, current, "새 버전 노트", "새 버전")
    rows = guest.read(link["id"], cookie, "/owner-highlights").json()["items"]
    assert old not in [r["id"] for r in rows], "an older note version is not what a guest reads"
    note_rows = [r for r in rows if r["kind"] == "note"]
    assert [r["id"] for r in note_rows] == [new]
    assert note_rows[0]["chapter_title"]
    seed.assert_status(w.owner.patch_link(w.ws, link["id"], include_notes=False), 200, "notes off")
    assert quotes() == ["문제 하나"]
    seed.assert_status(w.owner.patch_link(w.ws, link["id"], include_notes=True), 200, "notes on")

    # A question that stops being published takes its records out.
    seed._admin("update public.questions set publication_status = 'ARCHIVED' where id = %s", (q,))
    assert attempts() == []
    assert [i for i in quotes() if i == "문제 하나"] == []


def test_a_graded_pending_attempt_is_listed_once(seed: Any) -> None:
    w = _world(seed, "pending")
    link, cookie = _session(seed, w, include_owner_records=True)
    q, rev = w.question["id"], w.question["revision"]["id"]
    owner_id = str(w.owner.user.id)
    session = seed._admin(
        "insert into public.practice_sessions (workspace_id, question_id, question_revision_id, "
        "user_id, state, submitted_at) values (%s, %s, %s, %s, 'pending_grade', now()) "
        "returning id",
        (w.ws, q, rev, owner_id),
    )[0][0]
    pending = seed._admin(
        "insert into public.question_attempts (workspace_id, question_id, question_revision_id, "
        "practice_session_id, user_id, submitted_answer, result) "
        "values (%s, %s, %s, %s, %s, '{}'::jsonb, 'pending') returning id",
        (w.ws, q, rev, session, owner_id),
    )[0][0]
    guest = seed.guest()
    assert [
        i["result"] for i in guest.read(link["id"], cookie, "/owner-attempts").json()["items"]
    ] == ["pending"]
    seed._admin(
        "insert into public.question_attempts (workspace_id, question_id, question_revision_id, "
        "practice_session_id, user_id, submitted_answer, result, grading_method, graded_at, "
        "grades_attempt_id) values (%s, %s, %s, %s, %s, '{}'::jsonb, 'correct', 'self', now(), %s)",
        (w.ws, q, rev, session, owner_id, pending),
    )
    assert [
        i["result"] for i in guest.read(link["id"], cookie, "/owner-attempts").json()["items"]
    ] == ["correct"]


def test_owner_attempts_page_with_a_cursor(seed: Any) -> None:
    w = _world(seed, "cursor")
    link, cookie = _session(seed, w, include_owner_records=True)
    q, rev = w.question["id"], w.question["revision"]["id"]
    for _ in range(3):
        seed.graded_attempt(w.ws, q, rev, w.owner.user.id)
    guest = seed.guest()
    first = guest.read(link["id"], cookie, "/owner-attempts?limit=2").json()
    assert len(first["items"]) == 2
    assert first["next_cursor"]
    second = guest.read(
        link["id"], cookie, f"/owner-attempts?limit=2&cursor={first['next_cursor']}"
    ).json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None
    assert not {i["id"] for i in first["items"]} & {i["id"] for i in second["items"]}


def test_fork_contract_pins_flags_and_copies_no_personal_record(seed: Any) -> None:
    w = _world(seed, "fork")
    recipient = seed.client("scope-recipient")
    q, rev = w.question["id"], w.question["revision"]["id"]
    seed.graded_attempt(w.ws, q, rev, w.owner.user.id)
    seed.study_state(w.owner.user.id, w.ws, q)
    _highlight(w.owner, w.question, "공개 해설")
    link, cookie = _session(
        seed,
        w,
        allow_fork=True,
        include_notes=False,
        include_summary=False,
        include_owner_records=True,
    )
    res = recipient.fork(link["id"], cookie, "범위 fork")
    seed.assert_status(res, 202, "fork")
    fork = recipient.wait_fork(res.json()["id"], "COMPLETED")
    manifest = seed._admin(
        "select source_snapshot_manifest from public.workspace_forks where id = %s", (fork["id"],)
    )[0][0]
    assert manifest["version"] == 3
    assert manifest["include"] == {"notes": False, "ai_explanations": True, "summary": False}

    target = fork["target_workspace_id"]
    counts = seed._admin(
        "select (select count(*) from public.chapter_notes where workspace_id = %(t)s), "
        "(select count(*) from public.document_summary_runs where workspace_id = %(t)s), "
        "(select count(*) from public.question_ai_explanations where workspace_id = %(t)s), "
        "(select count(*) from public.question_attempts where workspace_id = %(t)s), "
        "(select count(*) from public.question_user_states where workspace_id = %(t)s), "
        "(select count(*) from public.user_highlights where workspace_id = %(t)s)",
        {"t": target},
    )[0]
    assert counts == (0, 0, 1, 0, 0, 0)
