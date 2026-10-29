"""CHNOTE-01 server guarantees C01-C08 (docs/screens/chapter-notes.md, questions.md §9,
workspace-sharing.md §8).

The input is the chapter's live CONFIRMED questions, pinned on the note row at request time (C01);
citations are validated, rejected once and dropped (C02); stale is computed on read and every
generation is a new version, one running per chapter (C03); large chapters are batched and merged
(C04); the authorization matrix, feature switch and source-matched shared reads (C05); no question,
explanation, note or prompt text in logs, job results or activities (C06); fork copies only
source-matched latest notes with remapped ids (C07); shared reads stop at once when a cited question
changes (C08). Shapes are assumptions N1-N9 in tests/e2e/fixtures/chapter-notes.ts; the scenario
LLM is tests/fixtures/llm/chapter-note-scenarios.json. Jobs run in this process (conftest.py).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[4]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
BOOK_KO = PDF_DIR / "book-ko.pdf"
BOOK_EN = PDF_DIR / "book-en.pdf"
PAPER = PDF_DIR / "questions-ko.pdf"
CH1, CH2 = "1장 물의 순환", "2장 정수 처리"
EN_CH1, EN_CH2 = "Chapter 1. The Water Cycle", "Chapter 2. Water Treatment"
OK, MIXED, INVALID, FAIL = "E2E-NOTE-OK", "E2E-NOTE-MIXED", "E2E-NOTE-INVALID", "E2E-NOTE-FAIL"
MIXED_VALID = ("NOTE-MIX-A", "NOTE-MIX-B", "NOTE-MIX-C", "NOTE-MIX-D")
MIXED_INVALID = ("NOTE-MIX-Q99", "NOTE-MIX-NOTAG", "NOTE-MIX-BADQUOTE")
JOB_TYPE = "chapter_note.generate"
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
P = "urn:quiz-workspace:problem:"
NO_QUESTIONS = P + "no-chapter-questions"
RUNNING = P + "note-generation-running"
DISABLED = P + "note-generation-disabled"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
LABEL = re.compile(r"^\d+장 \d+번$")
MEMBER_ONLY = ("versions", "generation", "usage", "input_fingerprint", "question_refs")


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser reads only where no API exposes the guarantee)
# ---------------------------------------------------------------------------------------------


def upload(
    client: Any,
    workspace_id: str,
    pdf: Path = BOOK_KO,
    filename: str | None = None,
    document_type: str = "book",
) -> str:
    """upload-intent -> PUT -> complete-upload, then drains the parse job."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": filename or pdf.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": document_type,
        },
        (200, 201),
    )
    url = str(intent["upload_url"])
    assert urlsplit(url).hostname in LOOPBACK, "upload URL must stay on the local stack"
    put = httpx.put(
        url,
        content=data,
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
    client.wait_for_job(str(done["job_id"]))
    return str(done["document_id"])


def chapters(client: Any, document_id: str) -> dict[str, str]:
    """Top-level outline nodes of the document by title (the questions' `chapter_id`)."""
    items = client.ok("GET", f"/documents/{document_id}/outline")["items"]
    return {str(node["title"]).strip(): str(node["id"]) for node in items}


def book(client: Any, workspace_id: str, pdf: Path = BOOK_KO, **kw: Any) -> dict[str, str]:
    return chapters(client, upload(client, workspace_id, pdf, **kw))


def question(
    client: Any,
    workspace_id: str,
    stem: str,
    n: int,
    chapter_id: str | None,
    marker: str,
    explanation: str | None = None,
) -> dict[str, Any]:
    """CONFIRMED MCQ numbered `n` whose stem ends with the scenario marker (N6)."""
    options = [{"id": f"opt-{i + 1}", "text": f"{stem} 보기 {i + 1}"} for i in range(4)]
    body = {
        "question_type": "MCQ",
        "stem": f"{stem} [{marker}]",
        "options": options,
        "correct_option_ids": ["opt-1"],
        "is_multi_answer": False,
        "explanation": explanation or f"{stem} 해설",
        "chapter_id": chapter_id,
        "question_number": n,
    }
    out: dict[str, Any] = client.ok("POST", f"/workspaces/{workspace_id}/questions", body, (201,))
    return out


def questions(
    client: Any, workspace_id: str, chapter_id: str, marker: str, label: str, numbers: range
) -> list[dict[str, Any]]:
    return [question(client, workspace_id, f"{label}-q{n}", n, chapter_id, marker) for n in numbers]


def patch_question(client: Any, q: dict[str, Any], **changes: Any) -> dict[str, Any]:
    current = client.ok("GET", f"/questions/{q['id']}")
    out: dict[str, Any] = client.ok(
        "PATCH",
        f"/questions/{q['id']}",
        {"base_revision_id": current["revision"]["id"], **changes},
    )
    return out


def delete_question(client: Any, q: dict[str, Any]) -> None:
    assert client.call("DELETE", f"/questions/{q['id']}").status_code == 204


def draft_in(client: Any, workspace_id: str, chapter_id: str) -> dict[str, Any]:
    """An import draft of questions-ko.pdf registered under `chapter_id` but never published."""
    paper = upload(client, workspace_id, PAPER, document_type="question_paper")
    run = client.ok(
        "POST", f"/workspaces/{workspace_id}/question-imports", {"document_id": paper}, (202,)
    )
    client.wait_for_job(str(run["job_id"]))
    draft = client.ok("GET", f"/question-imports/{run['id']}/drafts")["items"][0]
    out: dict[str, Any] = client.ok(
        "PATCH",
        f"/question-drafts/{draft['id']}",
        {"base_version": draft["version"], "chapter_id": chapter_id},
    )
    return out


def state(client: Any, chapter_id: str, version: int | None = None) -> dict[str, Any]:
    suffix = f"?version={version}" if version else ""
    out: dict[str, Any] = client.ok("GET", f"/chapters/{chapter_id}/note{suffix}")
    return out


def post_note(client: Any, chapter_id: str, key: str | None = None) -> httpx.Response:
    headers = {"Idempotency-Key": key} if key else {}
    res: httpx.Response = client.send("POST", f"/chapters/{chapter_id}/note", {}, headers=headers)
    return res


def start(client: Any, chapter_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok_response(
        post_note(client, chapter_id), "POST", "chapter note", (202,)
    )
    return out


def finish(client: Any, chapter_id: str, expected: str = "succeeded") -> dict[str, Any]:
    """Drains the chapter's newest generation (N1 `generation.job_id`); returns the state after."""
    gen = state(client, chapter_id)["generation"]
    assert gen is not None, "the chapter has no generation"
    client.worker.drain(str(gen["job_id"]))
    after = state(client, chapter_id)
    assert after["generation"]["id"] == gen["id"]
    assert after["generation"]["status"] == expected, after["generation"]["status"]
    return after


def generate(client: Any, chapter_id: str) -> dict[str, Any]:
    start(client, chapter_id)
    return finish(client, chapter_id)


def ref_ids(st: dict[str, Any]) -> set[str]:
    return {str(r["question_id"]) for r in st["note"]["question_refs"]}


def item_texts(note: dict[str, Any]) -> list[str]:
    return [i["text"] for s in note["sections"] for i in s["items"]]


def assert_citations_valid(note: dict[str, Any]) -> None:
    """Every item has a footnote; every footnote exists and cites an input question (C02)."""
    refs = {str(r["question_id"]) for r in note["question_refs"]}
    numbers = {f["number"] for f in note["footnotes"]}
    for section in note["sections"]:
        for item in section["items"]:
            assert item["footnotes"], "an item without a footnote was stored"
            assert set(item["footnotes"]) <= numbers, "an item cites a missing footnote"
    for footnote in note["footnotes"]:
        assert footnote["question_id"] in refs, "a footnote cites a question outside the input"
        assert LABEL.match(footnote["label"]), footnote["label"]


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


def keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [*value, *(k for v in value.values() for k in keys(v))]
    if isinstance(value, list):
        return [k for v in value for k in keys(v)]
    return []


def member(seed: Any, workspace_id: str, label: str, role: str) -> Any:
    client = seed.client(label)
    seed.membership(workspace_id, client.user, role)
    return client


def token() -> str:
    return f"cn{uuid.uuid4().hex[:10]}"


# ---------------------------------------------------------------------------------------------
# C01 input scope, pinned at request time
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c01_input_is_the_chapters_live_confirmed_questions_pinned_at_request(
    seed: Any, note_prompts: Any
) -> None:
    owner = seed.client("chnote-c01")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    t = token()
    q1 = question(owner, ws, f"{t}-in1", 1, ch[CH1], MIXED)
    q2 = question(owner, ws, f"{t}-in2", 2, ch[CH1], MIXED, explanation=f"{t}-old-explanation")
    q3 = question(owner, ws, f"{t}-in3", 3, ch[CH1], MIXED)
    archived = question(owner, ws, f"{t}-archived", 4, ch[CH1], MIXED)
    patch_question(owner, archived, publication_status="ARCHIVED")
    deleted = question(owner, ws, f"{t}-deleted", 5, ch[CH1], MIXED)
    delete_question(owner, deleted)
    question(owner, ws, f"{t}-otherchapter", 6, ch[CH2], OK)
    draft = draft_in(owner, ws, ch[CH1])
    draft_stem = str(draft["payload"]["stem"])[:20]

    requested = start(owner, ch[CH1])
    assert requested["generation"]["status"] == "queued"
    # Changes after the request do not reach this generation's input.
    question(owner, ws, f"{t}-late", 7, ch[CH1], MIXED)
    revised = patch_question(owner, q2, explanation=f"{t}-new-explanation")
    done = finish(owner, ch[CH1])

    note = done["note"]
    assert ref_ids(done) == {q1["id"], q2["id"], q3["id"]}
    refs = {r["question_id"]: r for r in note["question_refs"]}
    assert refs[q2["id"]]["question_revision_id"] == q2["revision"]["id"], "pinned revision"
    assert refs[q2["id"]]["question_revision_id"] != revised["revision"]["id"]
    assert [refs[q["id"]]["tag"] for q in (q1, q2, q3)] == ["Q1", "Q2", "Q3"]
    assert all(LABEL.match(r["label"]) for r in note["question_refs"])
    assert re.fullmatch(r"[0-9a-f]{64}", note["input_fingerprint"])
    assert note["question_count"] == 3
    assert_citations_valid(note)
    assert done["stale"] is True, "a question was added and another revised after the request"

    prompts = note_prompts(t)
    assert prompts, "the chapter's prompts carry its questions"
    for prompt in prompts:
        for included in (f"{t}-in1", f"{t}-in2", f"{t}-in3", f"{t}-old-explanation"):
            assert included in prompt, included
        for excluded in (
            f"{t}-archived",
            f"{t}-deleted",
            f"{t}-otherchapter",
            f"{t}-late",
            f"{t}-new-explanation",
            draft_stem,
        ):
            assert excluded not in prompt, excluded

    again = generate(owner, ch[CH1])
    assert again["note"]["input_fingerprint"] != note["input_fingerprint"]
    assert len(again["note"]["question_refs"]) == 4, "q1, the revised q2, q3 and the late one"
    refs = {r["question_id"]: r for r in again["note"]["question_refs"]}
    assert refs[q2["id"]]["question_revision_id"] == revised["revision"]["id"]
    assert again["stale"] is False


# ---------------------------------------------------------------------------------------------
# C02 citation validation
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c02_citations_are_rejected_once_then_invalid_items_are_dropped(
    seed: Any, note_prompts: Any
) -> None:
    owner = seed.client("chnote-c02")
    ws = owner.create_workspace()["id"]
    ko = book(owner, ws)
    en = book(owner, ws, BOOK_EN)
    mixed_t, ok_t, invalid_t = token(), token(), token()
    questions(owner, ws, ko[CH1], MIXED, mixed_t, range(1, 4))
    questions(owner, ws, ko[CH2], OK, ok_t, range(4, 6))
    questions(owner, ws, en[EN_CH1], INVALID, invalid_t, range(6, 8))

    mixed = generate(owner, ko[CH1])["note"]
    texts = " ".join(item_texts(mixed))
    assert all(t in texts for t in MIXED_VALID)
    assert not [t for t in MIXED_INVALID if t in texts], "invalid items were stored"
    assert_citations_valid(mixed)
    assert mixed["usage"]["llm_calls"] == 2, "an unknown tag / bad quote is re-requested once"
    assert (mixed["usage"]["items"], mixed["usage"]["dropped_items"]) == (4, 3)
    assert len(note_prompts(mixed_t)) == 2

    ok = generate(owner, ko[CH2])["note"]
    assert_citations_valid(ok)
    assert (ok["usage"]["llm_calls"], ok["usage"]["dropped_items"]) == (1, 0)
    assert len(note_prompts(ok_t)) == 1

    start(owner, en[EN_CH1])
    failed = finish(owner, en[EN_CH1], expected="failed")
    assert failed["generation"]["error_code"] == "note_citation_invalid"
    assert (failed["note"], failed["versions"]) == (None, [])
    assert len(note_prompts(invalid_t)) == 2

    # Property over every stored version of the chapter: footnotes only cite input questions.
    for version in state(owner, ko[CH1])["versions"]:
        assert_citations_valid(state(owner, ko[CH1], int(version["version"]))["note"])


# ---------------------------------------------------------------------------------------------
# C03 stale on read, versions, one running generation
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c03_stale_is_computed_on_read_and_versions_are_kept(seed: Any, db: Any) -> None:
    owner = seed.client("chnote-c03")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    t = token()
    q1, q2, q3 = questions(owner, ws, ch[CH1], OK, t, range(1, 4))
    other = question(owner, ws, f"{t}-other", 9, ch[CH2], OK)
    assert generate(owner, ch[CH1])["stale"] is False

    # Not inputs: a draft placed in the chapter, a question of another chapter.
    draft_in(owner, ws, ch[CH1])
    patch_question(owner, other, explanation=f"{t} 다른 장 해설")
    assert state(owner, ch[CH1])["stale"] is False

    added: dict[str, Any] = {}

    def add() -> None:
        added.update(question(owner, ws, f"{t}-added", 4, ch[CH1], OK))

    cases = [
        ("added", add),
        ("revised", lambda: patch_question(owner, q1, explanation=f"{t} 고친 해설")),
        ("deleted", lambda: delete_question(owner, q2)),
        ("archived", lambda: patch_question(owner, q3, publication_status="ARCHIVED")),
        ("moved", lambda: patch_question(owner, added, chapter_id=ch[CH2])),
    ]
    for name, mutate in cases:
        assert state(owner, ch[CH1])["stale"] is False, f"fresh before {name}"
        mutate()
        assert state(owner, ch[CH1])["stale"] is True, f"{name} makes the note stale"
        regenerated = generate(owner, ch[CH1])
        assert regenerated["stale"] is False

    versions = state(owner, ch[CH1])["versions"]
    assert [v["version"] for v in versions] == list(range(len(cases) + 1, 0, -1))
    note_ids = [str(v["note_id"]) for v in versions]
    rows = dict(
        db(
            "select id::text, superseded_at is not null from public.chapter_notes "
            "where id = any(%s::uuid[])",
            (note_ids,),
        )
    )
    assert len(rows) == len(note_ids), "no version is deleted"
    assert rows[note_ids[0]] is False, "the newest version is current"
    assert all(rows[i] for i in note_ids[1:]), "older versions are superseded"
    # Reading an older version returns it unchanged.
    assert state(owner, ch[CH1], 1)["note"]["id"] == note_ids[-1]

    # One queued/running generation per chapter; the same key replays it.
    key = str(uuid.uuid4())
    queued = owner.ok_response(post_note(owner, ch[CH1], key), "POST", "note", (202,))
    replay = owner.ok_response(post_note(owner, ch[CH1], key), "POST", "note", (200, 202))
    assert replay["generation"]["id"] == queued["generation"]["id"]
    seed.problem(post_note(owner, ch[CH1]), 409, RUNNING)
    seed.problem(post_note(owner, ch[CH1], str(uuid.uuid4())), 409, RUNNING)
    finish(owner, ch[CH1])
    assert len(state(owner, ch[CH1])["versions"]) == len(cases) + 2


# ---------------------------------------------------------------------------------------------
# C04 large chapters
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c04_large_chapters_are_batched_and_merged_with_chapter_wide_tags(
    seed: Any,
) -> None:
    owner = seed.client("chnote-c04")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    t = token()
    # 240 > 120 questions: two batches of 120 under any order-preserving partition (N10), so
    # every batch has the Q1/Q2 the OK scenario cites.
    many = questions(owner, ws, ch[CH1], OK, t, range(1, 241))

    note = generate(owner, ch[CH1])["note"]
    assert note["usage"]["batches"] == 2
    for key in ("cost_usd", "input_tokens", "output_tokens", "llm_calls"):
        assert key in note["usage"], key
    tags = [r["tag"] for r in note["question_refs"]]
    assert sorted(tags, key=lambda x: int(x[1:])) == [f"Q{n}" for n in range(1, 241)]
    assert ref_ids({"note": note}) == {q["id"] for q in many}
    assert_citations_valid(note)
    cited = {f["question_id"] for f in note["footnotes"]}
    assert len(cited) == 4, "each batch's Q1/Q2 are different questions after renumbering"
    assert {many[0]["id"], many[1]["id"]} < cited, "the first batch contributed"
    assert cited - {many[0]["id"], many[1]["id"]} <= {q["id"] for q in many[2:]}
    headings = [s["heading"] for s in note["sections"]]
    assert sorted(headings) == sorted(set(headings)), "sections are merged by heading"

    # Over 60,000 input characters with few questions is batched too: 10 x ~7,000 characters
    # split into batches of at least two questions under a greedy or a balanced partition (N10).
    long_ex = "가" * 7_000
    longs = [
        question(owner, ws, f"{t}-long{n}", 300 + n, ch[CH2], OK, explanation=long_ex)
        for n in range(1, 11)
    ]
    long_note = generate(owner, ch[CH2])["note"]
    assert long_note["usage"]["batches"] == 2
    assert_citations_valid(long_note)
    long_cited = {f["question_id"] for f in long_note["footnotes"]}
    assert len(long_cited) == 4, "both batches contributed their own Q1/Q2"
    assert long_cited <= {q["id"] for q in longs}


# ---------------------------------------------------------------------------------------------
# C05 authorization matrix, feature switch, shared reads, practice API
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c05_roles_chapters_and_workspace_states(seed: Any) -> None:
    owner = seed.client("chnote-c05-owner")
    outsider = seed.client("chnote-c05-outsider")
    ws = owner.create_workspace()["id"]
    editor = member(seed, ws, "chnote-c05-editor", "editor")
    viewer = member(seed, ws, "chnote-c05-viewer", "viewer")
    doc = upload(owner, ws)
    ch = chapters(owner, doc)
    questions(owner, ws, ch[CH1], OK, token(), range(1, 3))

    for m in (owner, editor, viewer):
        assert state(m, ch[CH1])["note"] is None
        listed = m.ok("GET", f"/workspaces/{ws}/chapter-notes")["items"]
        assert ch[CH1] in {i["chapter_id"] for i in listed}
    unknown = seed.problem(outsider.call("GET", f"/chapters/{RANDOM_ID}/note"), 404)
    assert seed.problem(outsider.call("GET", f"/chapters/{ch[CH1]}/note"), 404) == unknown
    seed.problem(outsider.call("GET", f"/workspaces/{ws}/chapter-notes"), 404)

    seed.problem(post_note(viewer, ch[CH1]), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(post_note(outsider, ch[CH1]), 404)
    seed.problem(post_note(owner, RANDOM_ID), 404)
    empty = state(owner, ch[CH2])
    assert (empty["confirmed_question_count"], empty["note"]) == (0, None)
    seed.problem(post_note(owner, ch[CH2]), 409, NO_QUESTIONS)

    first = generate(editor, ch[CH1])
    generate(owner, ch[CH1])
    assert state(viewer, ch[CH1], 1)["note"]["id"] == first["note"]["id"]
    seed.problem(viewer.call("GET", f"/chapters/{ch[CH1]}/note?version=9"), 404)

    owner.ok("POST", f"/workspaces/{ws}/archive")
    assert state(viewer, ch[CH1])["note"] is not None, "archived: still readable"
    seed.problem(post_note(owner, ch[CH1]), 403, seed.ARCHIVED)
    seed.problem(post_note(editor, ch[CH1]), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{ws}/restore")

    assert owner.call("DELETE", f"/documents/{doc}").status_code == 204
    seed.problem(owner.call("GET", f"/chapters/{ch[CH1]}/note"), 404)
    seed.problem(post_note(owner, ch[CH1]), 404)


def test_chnote_01_c05_feature_off_refuses_create_but_serves_stored_notes(
    seed: Any, off_app: Any
) -> None:
    owner = seed.client("chnote-c05-off")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    questions(owner, ws, ch[CH1], OK, token(), range(1, 3))
    questions(owner, ws, ch[CH2], OK, token(), range(3, 5))
    generate(owner, ch[CH1])
    off_owner = type(owner)(off_app, owner.user)
    without = off_owner.ok("GET", f"/chapters/{ch[CH2]}/note")
    assert (without["available"], without["note"]) == (False, None)
    seed.problem(post_note(off_owner, ch[CH2]), 409, DISABLED)
    stored = off_owner.ok("GET", f"/chapters/{ch[CH1]}/note")
    assert stored["available"] is False
    assert stored["note"] is not None
    assert state(owner, ch[CH2])["available"] is True


def test_chnote_01_c05_shared_api_serves_only_source_matched_latest_notes(seed: Any) -> None:
    owner = seed.client("chnote-c05-share")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    t = token()
    cited = questions(owner, ws, ch[CH1], OK, t, range(1, 3))
    generate(owner, ch[CH1])
    latest = generate(owner, ch[CH1])
    link = owner.create_link(ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    listed = guest.read(link["id"], cookie, "/chapter-notes")
    seed.assert_status(listed, 200, "shared chapter notes")
    seed.assert_privacy_headers(listed, "shared chapter notes")
    assert [i["chapter_id"] for i in listed.json()["items"]] == [ch[CH1]]
    res = guest.read(link["id"], cookie, f"/chapters/{ch[CH1]}/note")
    seed.assert_status(res, 200, "shared chapter note")
    seed.assert_privacy_headers(res, "shared chapter note")
    body = res.json()
    for key in (*MEMBER_ONLY, "error_code", "job_id", "question_revision_id"):
        assert key not in keys(body), key
    assert "cost_usd" not in res.text
    assert body["sections"] == latest["note"]["sections"], "the latest version only"
    assert {f["question_id"] for f in body["footnotes"]} <= {q["id"] for q in cited}

    # A chapter without a note, an unknown id, another workspace's note: one 404 body.
    unknown = guest.read(link["id"], cookie, f"/chapters/{RANDOM_ID}/note")
    seed.assert_status(unknown, 404, "unknown chapter")
    empty = guest.read(link["id"], cookie, f"/chapters/{ch[CH2]}/note")
    assert seed.stable(empty) == seed.stable(unknown)
    other_ws = owner.create_workspace()["id"]
    other = book(owner, other_ws)
    questions(owner, other_ws, other[CH1], OK, token(), range(1, 3))
    generate(owner, other[CH1])
    foreign = guest.read(link["id"], cookie, f"/chapters/{other[CH1]}/note")
    assert seed.stable(foreign) == seed.stable(unknown)

    seed.assert_status(owner.revoke(ws, link["id"]), 200, "revoke")
    revoked = guest.read(link["id"], cookie, f"/chapters/{ch[CH1]}/note")
    seed.assert_status(revoked, 404, "revoked link")


def test_chnote_01_c05_practice_responses_carry_no_note_fields(seed: Any) -> None:
    owner = seed.client("chnote-c05-practice")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    first, _ = questions(owner, ws, ch[CH1], MIXED, token(), range(1, 3))
    note = generate(owner, ch[CH1])["note"]
    note_texts = [t for t in item_texts(note) if len(t) >= 8]

    session = owner.ok("POST", f"/questions/{first['id']}/practice-sessions", {}, (201,))
    graded = owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": ["opt-1"]},
    )
    for body in (session, graded):
        assert not [k for k in keys(body) if re.search("note|footnote", k, re.I)]
        dumped = json.dumps(body, ensure_ascii=False)
        assert not [t for t in [*note_texts, *MIXED_VALID] if t in dumped]


# ---------------------------------------------------------------------------------------------
# C06 no text in logs, job results, activities
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c06_no_question_or_note_text_in_logs_job_results_or_activities(
    seed: Any, db: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    owner = seed.client("chnote-c06")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    t = token()
    for n in range(1, 4):
        question(owner, ws, f"{t}-stem{n}", n, ch[CH1], MIXED, explanation=f"{t}-explain{n}")
    for n in range(4, 6):
        question(owner, ws, f"{t}-stem{n}", n, ch[CH2], FAIL, explanation=f"{t}-explain{n}")
    done = generate(owner, ch[CH1])
    start(owner, ch[CH2])
    failed = finish(owner, ch[CH2], expected="failed")
    assert failed["generation"]["error_code"] == "llm_invalid_output"

    forbidden = [
        t,
        *MIXED_VALID,
        *MIXED_INVALID,
        *[x[:24] for x in item_texts(done["note"])],
        "이 과정을 증발이라고 한다",  # the scenario's quote (book text)
    ]
    for gen in (done["generation"], failed["generation"]):
        job = owner.ok("GET", f"/jobs/{gen['job_id']}")
        assert job["job_type"] == JOB_TYPE
        dumped = json.dumps(job, ensure_ascii=False)
        assert not [f for f in forbidden if f in dumped], "the job holds question or note text"
        # Counts, usage and error codes only: every string in the result is a short code.
        assert all(len(s) <= 64 and "\n" not in s for s in strings(job.get("result"))), job
    rows = db(
        "select coalesce(usage::text, ''), coalesce(error_code, '') from public.chapter_notes "
        "where id = %s",
        (done["note"]["id"],),
    )
    assert rows, "the note row exists"
    assert not [f for f in forbidden for row in rows for v in row if f in v]
    events = db(
        "select event_type, metadata::text from public.activity_events "
        "where workspace_id = %s and event_type like 'chapter_note.%%'",
        (ws,),
    )
    assert "chapter_note.generated" in {e for e, _ in events}
    assert not [f for f in forbidden for _, payload in events if f in payload]
    assert not [f for f in forbidden if f in caplog.text], "logs hold question or note text"


# ---------------------------------------------------------------------------------------------
# C07 fork
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c07_fork_copies_only_source_matched_latest_notes_with_remapped_ids(
    seed: Any,
) -> None:
    owner = seed.client("chnote-c07-owner")
    recipient = seed.client("chnote-c07-recipient")
    ws = owner.create_workspace()["id"]
    ch = book(owner, ws)
    matched = questions(owner, ws, ch[CH1], OK, token(), range(1, 3))
    older = generate(owner, ch[CH1])
    # Version 2 has a different input (a third question), so the copy can only match one of them.
    matched.append(question(owner, ws, f"{token()}-v2only", 3, ch[CH1], OK))
    source_latest = generate(owner, ch[CH1])
    assert len(older["note"]["question_refs"]) == 2
    assert len(source_latest["note"]["question_refs"]) == 3
    changed = questions(owner, ws, ch[CH2], OK, token(), range(4, 6))
    generate(owner, ch[CH2])
    patch_question(owner, changed[0], explanation="포크 전에 고친 해설")  # not source-matched

    link = owner.create_link(ws, allow_fork=True)
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, f"chnote fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(res, 202, "fork")
    target = str(recipient.wait_fork(str(res.json()["id"]), "COMPLETED")["target_workspace_id"])
    [doc] = recipient.ok("GET", f"/workspaces/{target}/documents")["items"]
    forked = chapters(recipient, str(doc["id"]))
    target_list = recipient.list_questions(target)
    target_questions = {q["id"]: q["revision"]["id"] for q in target_list}
    target_stems = {q["id"]: q["revision"]["stem"] for q in target_list}
    source_ids = {q["id"] for q in [*matched, *changed]}
    source_stems = {q["id"]: q["revision"]["stem"] for q in matched}

    copy = state(recipient, forked[CH1])
    assert [v["version"] for v in copy["versions"]] == [1], "only the latest version is copied"
    note = copy["note"]
    assert note["id"] != source_latest["note"]["id"]
    assert note["sections"] == source_latest["note"]["sections"]
    assert note["question_count"] == 3, "version 2 (three questions), not version 1"
    assert note["input_fingerprint"] != older["note"]["input_fingerprint"]
    assert note["usage"] in (None, {}), "usage is not copied"
    refs = note["question_refs"]
    # The copy's refs are version 2's refs, remapped one-to-one (same tags, same questions).
    latest_refs = {
        r["tag"]: source_stems[r["question_id"]] for r in source_latest["note"]["question_refs"]
    }
    assert {r["tag"]: target_stems[r["question_id"]] for r in refs} == latest_refs
    assert source_stems[matched[2]["id"]] in latest_refs.values()
    assert {r["question_id"] for r in refs} <= set(target_questions)
    assert not {r["question_id"] for r in refs} & source_ids
    assert all(target_questions[r["question_id"]] == r["question_revision_id"] for r in refs)
    assert {f["question_id"] for f in note["footnotes"]} <= set(target_questions)
    assert copy["stale"] is False

    # Not source-matched at the snapshot: no note at all (no older version instead).
    missing = state(recipient, forked[CH2])
    assert (missing["note"], missing["versions"]) == (None, [])
    assert len(state(owner, ch[CH1])["versions"]) == 2, "the source is untouched"


# ---------------------------------------------------------------------------------------------
# C08 shared reads stop when a cited question changes
# ---------------------------------------------------------------------------------------------


def test_chnote_01_c08_shared_notes_disappear_when_a_cited_question_changes(seed: Any) -> None:
    owner = seed.client("chnote-c08")
    ws = owner.create_workspace()["id"]
    ko = book(owner, ws)
    en = book(owner, ws, BOOK_EN)
    cases = {
        "deleted": ko[CH1],
        "archived": ko[CH2],
        "revised": en[EN_CH1],
        "added": en[EN_CH2],
    }
    cited: dict[str, list[dict[str, Any]]] = {}
    for i, (name, chapter_id) in enumerate(cases.items()):
        cited[name] = questions(
            owner, ws, chapter_id, OK, f"{token()}-{name}", range(i * 2 + 1, i * 2 + 3)
        )
        generate(owner, chapter_id)
    link = owner.create_link(ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    for chapter_id in cases.values():
        seed.assert_status(
            guest.read(link["id"], cookie, f"/chapters/{chapter_id}/note"), 200, "before"
        )

    delete_question(owner, cited["deleted"][0])
    patch_question(owner, cited["archived"][0], publication_status="ARCHIVED")
    patch_question(owner, cited["revised"][0], explanation="공유 뒤에 고친 해설")
    question(owner, ws, f"{token()}-added-late", 99, cases["added"], OK)

    unknown = guest.read(link["id"], cookie, f"/chapters/{RANDOM_ID}/note")
    listed = guest.read(link["id"], cookie, "/chapter-notes")
    seed.assert_status(listed, 200, "shared list")
    ids = {i["chapter_id"] for i in listed.json()["items"]}
    for name in ("deleted", "archived", "revised"):
        res = guest.read(link["id"], cookie, f"/chapters/{cases[name]}/note")
        seed.assert_status(res, 404, f"{name}: withheld")
        assert seed.stable(res) == seed.stable(unknown)
        assert not [
            q["revision"]["stem"][:20]
            for q in cited[name]
            if q["revision"]["stem"][:20] in res.text
        ]
        assert cases[name] not in ids, f"{name}: not listed"
    added = guest.read(link["id"], cookie, f"/chapters/{cases['added']}/note")
    seed.assert_status(added, 200, "added only: still shared")
    assert added.json()["stale"] is True
    assert cases["added"] in ids
