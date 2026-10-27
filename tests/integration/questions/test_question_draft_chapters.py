"""CHAPTER-MAP: imported drafts are registered under a book chapter (QIMPORT-01-AC08).

questions-ko.pdf has one outline node, its title heading ("제1회 합성 확인 평가 — 물의 순환과 정수
처리"); book-ko.pdf has "1장 물의 순환" / "2장 정수 처리" (+ sections). Uploading questions-ko.pdf a
second time as a *book* gives the workspace a book chapter with exactly the paper's chapter title.

Fixtures: conftest.py (jobs in-process). Needs migrations 20261023120000 and 20261023130000.
"""

from __future__ import annotations

from typing import Any

import pytest

pytestmark = pytest.mark.infra

PAPER_CHAPTER = "제1회 합성 확인 평가 — 물의 순환과 정수 처리"


def _book_chapters(client: Any, run_id: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {
        c["title"]: c for c in client.ok("GET", f"/question-imports/{run_id}/drafts")["chapters"]
    }
    return out


def _set_chapter(client: Any, draft: dict[str, Any], chapter_id: str | None) -> Any:
    return client.call(
        "PATCH",
        f"/question-drafts/{draft['id']}",
        {"base_version": draft["version"], "chapter_id": chapter_id},
    )


def test_qimport_01_ac08_no_book_chapter_with_the_title_suggests_none(seed: Any) -> None:
    alice = seed.client("cmap-none")
    ws = alice.create_workspace()
    _, _, book = alice.upload_book(ws["id"])
    alice.wait_for_job(str(book["job_id"]))
    run, drafts = alice.import_paper(ws["id"])

    assert all(d["chapter"] is None for d in drafts)
    assert {(d["chapter_choice"], d["chapter_match"]) for d in drafts} == {("auto", "no_match")}
    assert {d["source_chapter_title"] for d in drafts} == {PAPER_CHAPTER}
    assert {"1장 물의 순환", "2장 정수 처리"} <= set(_book_chapters(alice, run["id"]))


def test_qimport_01_ac08_a_unique_match_is_suggested_changed_and_registered(seed: Any) -> None:
    alice = seed.client("cmap-match")
    viewer = seed.client("cmap-match-viewer")
    ws = alice.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    _, _, book = alice.upload_book(ws["id"])
    alice.wait_for_job(str(book["job_id"]))
    titled = alice.upload_question_paper(ws["id"], "chapter-book.pdf", document_type="book")
    run, drafts = alice.import_paper(ws["id"])
    chapters = _book_chapters(alice, run["id"])
    suggested = chapters[PAPER_CHAPTER]
    assert suggested["document_id"] == titled

    for d in drafts:
        assert d["chapter"]["id"] == suggested["id"]
        assert (d["chapter_choice"], d["chapter_match"]) == ("auto", "matched")

    q1, q2, q4 = (seed.draft_for(drafts, n) for n in (1, 2, 4))
    # A viewer cannot choose; an unknown or non-book chapter is refused.
    seed.problem(
        _set_chapter(viewer, q1, chapters["1장 물의 순환"]["id"]), 403, seed.INSUFFICIENT_ROLE
    )
    seed.problem(_set_chapter(alice, q1, seed.new_id()), 422)
    # The reviewer picks another chapter for q1 and "챕터 없음" for q2.
    moved = alice.ok_response(
        _set_chapter(alice, q1, chapters["1장 물의 순환"]["id"]), "PATCH", "chapter", (200,)
    )
    assert (moved["chapter"]["title"], moved["chapter_choice"]) == ("1장 물의 순환", "manual")
    assert moved["chapter_match"] is None
    assert moved["version"] != q1["version"]
    assert moved["review_status"] == q1["review_status"]
    none = alice.ok_response(_set_chapter(alice, q2, None), "PATCH", "no chapter", (200,))
    assert (none["chapter"], none["chapter_choice"]) == (None, "manual")

    # Registration (server job) uses what the review shows.
    submitted = alice.ok_response(
        alice.register(
            run["id"],
            [{"draft_id": d["id"], "version": d["version"]} for d in (moved, none, q4)],
        ),
        "POST",
        "registrations",
        (202,),
    )
    alice.wait_for_job(submitted["job_id"])
    bank = {q["revision"]["stem"]: q for q in alice.list_questions(ws["id"])}
    by_draft = {d["id"]: d["published_question_id"] for d in alice.drafts(run["id"])}
    chapter_of = {q["id"]: q["chapter_id"] for q in bank.values()}
    assert chapter_of[by_draft[q1["id"]]] == chapters["1장 물의 순환"]["id"]
    assert chapter_of[by_draft[q2["id"]]] is None
    assert chapter_of[by_draft[q4["id"]]] == suggested["id"]
    # The bank lists them under the chapter.
    under = alice.list_questions(ws["id"], f"chapter_id={suggested['id']}")
    assert [q["id"] for q in under] == [by_draft[q4["id"]]]

    # The direct publish path registers under the suggestion too.
    q5 = seed.draft_for(drafts, 5)
    out = alice.ok_response(alice.publish(run["id"], [q5["id"]]), "POST", "publish", (200,))
    assert alice.get_question(out["items"][0]["question_id"])["chapter_id"] == suggested["id"]


def test_qimport_01_ac08_several_book_chapters_with_the_title_are_ambiguous(seed: Any) -> None:
    alice = seed.client("cmap-ambiguous")
    ws = alice.create_workspace()
    for name in ("book-a.pdf", "book-b.pdf"):
        alice.upload_question_paper(ws["id"], name, document_type="book")
    _, drafts = alice.import_paper(ws["id"])

    assert {(d["chapter"] is None, d["chapter_match"]) for d in drafts} == {(True, "ambiguous")}


CHAPTER_CHANGED = "urn:quiz-workspace:problem:chapter-changed"


def test_qimport_01_ac08_a_suggestion_that_changed_after_review_refuses_registration(
    seed: Any,
) -> None:
    """Codex P2: a suggestion can change without a new draft version (a book added). A
    selection sent with the chapter it showed is refused instead of registering elsewhere."""
    alice = seed.client("cmap-changed")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    q1 = seed.draft_for(drafts, 1)
    assert q1["chapter"] is None  # no book yet: shown as 챕터 없음
    shown = [{"draft_id": q1["id"], "version": q1["version"], "chapter_id": None}]

    alice.upload_question_paper(ws["id"], "chapter-book.pdf", document_type="book")
    after = seed.draft_for(alice.drafts(run["id"]), 1)
    assert after["version"] == q1["version"]
    assert after["chapter"] is not None

    seed.problem(alice.register(run["id"], shown), 409, CHAPTER_CHANGED)
    seed.problem(alice.approve_and_publish(run["id"], shown), 409, CHAPTER_CHANGED)
    assert alice.ok("GET", f"/question-imports/{run['id']}")["registration_job_id"] is None
    assert alice.list_questions(ws["id"]) == []

    # Reviewed again with the chapter now shown, it registers under that chapter.
    current = [
        {"draft_id": q1["id"], "version": q1["version"], "chapter_id": after["chapter"]["id"]}
    ]
    out = alice.ok_response(
        alice.approve_and_publish(run["id"], current), "POST", "publish", (200,)
    )
    question = alice.get_question(out["items"][0]["question_id"])
    assert question["chapter_id"] == after["chapter"]["id"]
