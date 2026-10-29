"""DOC-03 full-text export contract (docs/screens/documents-text-export.md), DOCTXT.

DOC-03-C01 authorization matrix and DOC-03-C03 response headers, file names and "no body in
logs/activity/jobs". Request shape: tests/integration/documents/conftest.py and
tests/e2e/fixtures/export.ts. DOC-03-C02 (the pure renderer `book_core.export.render_revision`
and its golden files) lives in packages/core/tests/test_export.py.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.infra

RANDOM_ID = "00000000-0000-4000-8000-000000000000"
RAIN = "구름 속 물방울이"  # book-ko ch1-s2-p1 (page 2)
CHLORINE = "마지막으로 염소와 같은 소독제를"  # book-ko ch2-s2-p2 (page 4)


def _fail_route(res: httpx.Response, what: str) -> None:
    if res.status_code in {404, 405}:
        try:
            missing = not res.json().get("detail")
        except ValueError:
            missing = True
        if missing:
            pytest.fail(f"GET /api/v1/documents/{{id}}/text not implemented ({res.status_code})")
    pytest.fail(f"{what}: unexpected HTTP {res.status_code}")


def ok_text(res: httpx.Response, what: str) -> str:
    if res.status_code != 200:
        _fail_route(res, what)
    return res.content.decode("utf-8")


def expect_status(
    res: httpx.Response, status: int, what: str, problem_type: str | None = None
) -> None:
    if res.status_code != status:
        _fail_route(res, f"{what}: expected {status}")
    if problem_type is not None:
        assert res.json().get("type") == problem_type, f"{what}: problem type"


def lines(text: str) -> list[str]:
    return text.split("\n")


# ---------------------------------------------------------------------------------------------
# DOC-03-C01 authorization matrix
# ---------------------------------------------------------------------------------------------


def test_doc_03_c01_members_export_the_published_revision_and_only_editors_the_draft(
    seed: Any,
) -> None:
    owner = seed.client("c01-owner")
    editor = seed.client("c01-editor")
    viewer = seed.client("c01-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], editor.user, "editor")
    seed.membership(ws["id"], viewer.user, "viewer")
    doc = owner.upload_ready_book(ws["id"])

    for member, label in ((owner, "owner"), (editor, "editor"), (viewer, "viewer")):
        for fmt in ("md", "txt"):
            body = ok_text(member.export(doc, fmt), f"{label} published {fmt}")
            assert RAIN in body, f"{label} {fmt}: published text exported"

    # No draft yet: revision=draft is 404 draft-not-found (for an editor; a viewer is refused).
    expect_status(owner.export(doc, "md", "draft"), 404, "draft absent", seed.DRAFT_NOT_FOUND)

    token = f"교정표지{uuid.uuid4().hex[:8]}"
    editor.correct(doc, RAIN, f"E2E 교정 문장 {token}.")
    for member, label in ((owner, "owner"), (editor, "editor")):
        draft = ok_text(member.export(doc, "md", "draft"), f"{label} draft md")
        assert token in draft, f"{label}: the draft holds the correction"
        assert RAIN not in draft, f"{label}: the corrected sentence is replaced in the draft"
    published = ok_text(viewer.export(doc, "md"), "viewer published after correction")
    assert RAIN in published, "the published revision keeps the text before the correction"
    assert token not in published, "the draft never leaks into the published export"

    for fmt in ("md", "txt"):
        res = viewer.export(doc, fmt, "draft")
        expect_status(res, 403, f"viewer draft {fmt}", seed.INSUFFICIENT_ROLE)
        assert token not in res.text, "a refused draft export carries no draft text"


def test_doc_03_c01_not_ready_archived_and_deleted(seed: Any) -> None:
    owner = seed.client("c01s-owner")
    viewer = seed.client("c01s-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    doc = owner.upload_ready_book(ws["id"])
    ok_text(owner.export(doc), "ready document")

    for status in ("processing", "failed"):
        seed.set_document_status(doc, status)
        for member in (owner, viewer):
            res = member.export(doc, "txt")
            expect_status(res, 409, f"{status} document", seed.DOCUMENT_NOT_READY)
            assert RAIN not in res.text
    seed.set_document_status(doc, "ready")

    # Archived workspace: reading (and so exporting) stays allowed for every member.
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    for member, label in ((owner, "owner"), (viewer, "viewer")):
        assert RAIN in ok_text(member.export(doc), f"{label} archived workspace")

    # Soft-deleted document → 404 with a detail (not a missing route).
    owner.ok("POST", f"/workspaces/{ws['id']}/restore")
    other = owner.upload_ready_book(ws["id"], title=f"second {uuid.uuid4().hex[:6]}")
    owner.ok("DELETE", f"/documents/{other}", expected=(204,))
    expect_status(owner.export(other), 404, "deleted document")

    # Soft-deleted workspace → 404 for its documents.
    owner.ok("DELETE", f"/workspaces/{ws['id']}", expected=(204,))
    for member, label in ((owner, "owner"), (viewer, "viewer")):
        expect_status(member.export(doc), 404, f"{label} deleted workspace")


def test_doc_03_c01_outsiders_and_share_sessions_are_refused(seed: Any) -> None:
    owner = seed.client("c01o-owner")
    outsider = seed.client("c01o-outsider")
    ws = owner.create_workspace()
    own = outsider.create_workspace()
    doc = owner.upload_ready_book(ws["id"])
    ok_text(owner.export(doc), "owner export")

    # Another workspace's user: 404 (one body), also when pointing at their own workspace.
    for path in (
        seed.text_path(doc),
        seed.text_path(doc, "txt"),
        seed.text_path(doc, "md", "draft"),
        f"{seed.text_path(doc)}&workspace_id={own['id']}",
    ):
        res = outsider.call("GET", path)
        expect_status(res, 404, "outsider")
        assert RAIN not in res.text
    expect_status(owner.export(RANDOM_ID), 404, "unknown document")
    # The document's workspace is resolved in the DB: a foreign workspace_id changes nothing.
    assert RAIN in ok_text(
        owner.call("GET", f"{seed.text_path(doc)}&workspace_id={own['id']}"), "owner + foreign id"
    )

    # A share session is a separate read-only capability without an export API: 401.
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    cookie = guest.session(link["id"], str(link["secret"]))
    for fmt in ("md", "txt"):
        res = guest.send("GET", seed.text_path(doc, fmt), cookie=cookie)
        expect_status(res, 401, f"share session only ({fmt})")
        assert RAIN not in res.text


def test_doc_03_c01_a_revision_by_id_exports_the_revision_on_screen(seed: Any) -> None:
    """DOC-02 shows a search hit's (older) published revision by id; 전체 복사 copies that one."""
    owner = seed.client("c01r-owner")
    viewer = seed.client("c01r-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    doc = owner.upload_ready_book(ws["id"])
    first = str(owner.ok("GET", f"/documents/{doc}")["active_revision_id"])

    token = f"발행표지{uuid.uuid4().hex[:8]}"
    owner.correct(doc, RAIN, f"E2E 발행 문장 {token}.")
    draft_id = str(owner.ok("GET", f"/documents/{doc}/outline?revision=latest")["revision"]["id"])
    # A draft by id: owners and editors only, named as a draft.
    for fmt in ("md", "txt"):
        res = viewer.export(doc, fmt, draft_id)
        expect_status(res, 403, f"viewer draft id {fmt}", seed.INSUFFICIENT_ROLE)
        assert token not in res.text
    by_id = owner.export(doc, "md", draft_id)
    assert token in ok_text(by_id, "owner draft id")
    assert seed.attachment_filename(by_id) == "book-ko (초안).md"

    accepted = owner.ok("POST", f"/documents/{doc}/publish", {"revision_id": draft_id}, (202,))
    owner.wait_for_job(str(accepted["job_id"]))
    assert str(owner.ok("GET", f"/documents/{doc}")["active_revision_id"]) == draft_id

    # The older published revision by id: its own text, for every member; published = the new one.
    for member, label in ((owner, "owner"), (viewer, "viewer")):
        old = member.export(doc, "md", first)
        body = ok_text(old, f"{label} old revision")
        assert RAIN in body, f"{label}: the old revision keeps its text"
        assert token not in body, f"{label}: the newer publish is not in the old revision"
        assert seed.attachment_filename(old) == "book-ko.md"
        assert token in ok_text(member.export(doc, "md"), f"{label} published")
        assert token in ok_text(member.export(doc, "txt", draft_id), f"{label} new revision id")

    # A revision of another document (even the same owner's) or an unknown id: 404.
    other_ws = owner.create_workspace()
    other = owner.upload_ready_book(other_ws["id"])
    other_rev = str(owner.ok("GET", f"/documents/{other}")["active_revision_id"])
    for revision in (other_rev, RANDOM_ID):
        res = owner.export(doc, "md", revision)
        expect_status(res, 404, "foreign or unknown revision id")
        assert RAIN not in res.text
    expect_status(owner.export(other, "md", first), 404, "revision of another document")


# ---------------------------------------------------------------------------------------------
# DOC-03-C03 headers, file names, nothing recorded
# ---------------------------------------------------------------------------------------------


def test_doc_03_c03_response_headers_and_determinism(seed: Any) -> None:
    owner = seed.client("c03-owner")
    ws = owner.create_workspace()
    doc = owner.upload_ready_book(ws["id"])

    for fmt, mime, ext in (("md", "text/markdown", ".md"), ("txt", "text/plain", ".txt")):
        res = owner.export(doc, fmt)
        body = ok_text(res, f"export {fmt}")
        assert res.headers.get("content-type", "").replace(" ", "").lower() == (
            f"{mime};charset=utf-8"
        ), f"{fmt}: Content-Type"
        cache = res.headers.get("cache-control", "")
        assert "no-store" in cache, f"{fmt}: Cache-Control {cache!r}"
        assert "private" in cache, f"{fmt}: Cache-Control {cache!r}"
        assert res.headers.get("x-content-type-options") == "nosniff", f"{fmt}: nosniff"
        assert seed.attachment_filename(res) == f"book-ko{ext}", f"{fmt}: attachment filename*"
        assert not res.content.startswith(b"\xef\xbb\xbf"), f"{fmt}: no BOM"
        assert b"\r" not in res.content, f"{fmt}: LF only"
        again = owner.export(doc, fmt)
        assert again.content == res.content, f"{fmt}: the same revision exports the same bytes"
        assert RAIN in body

    owner.correct(doc, CHLORINE, "E2E 교정 소독 문장.")
    draft = owner.export(doc, "md", "draft")
    ok_text(draft, "draft export")
    assert seed.attachment_filename(draft) == "book-ko (초안).md", "draft file name"


def test_doc_03_c03_file_names_drop_path_characters_and_stay_short(seed: Any) -> None:
    owner = seed.client("c03n-owner")
    ws = owner.create_workspace()
    title = "../교재/물:순환\\정수 " + "가" * 200
    doc = owner.upload_ready_book(ws["id"], title=title)

    for fmt in ("md", "txt"):
        res = owner.export(doc, fmt)
        ok_text(res, f"export {fmt}")
        name = seed.attachment_filename(res)
        assert name is not None, f"{fmt}: attachment with filename*"
        assert name.endswith(f".{fmt}")
        stem = name[: -len(f".{fmt}")]
        assert "/" not in name, f"{fmt}: no path separators"
        assert "\\" not in name, f"{fmt}: no path separators"
        assert not re.search(r"[\x00-\x1f\x7f]", name), f"{fmt}: no control characters"
        assert 0 < len(stem) <= 120, f"{fmt}: the title part is at most 120 characters"
        assert "교재" in stem, f"{fmt}: the title stays recognisable"
        assert "가" in stem, f"{fmt}: the title stays recognisable"


def test_doc_03_c03_the_body_never_reaches_logs_activity_or_jobs(
    seed: Any, caplog: pytest.LogCaptureFixture
) -> None:
    owner = seed.client("c03l-owner")
    ws = owner.create_workspace()
    doc = owner.upload_ready_book(ws["id"])
    before = seed.counts(ws["id"])

    caplog.set_level(logging.DEBUG)
    caplog.clear()
    for fmt in ("md", "txt"):
        ok_text(owner.export(doc, fmt), f"export {fmt}")
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for snippet in (RAIN, CHLORINE, "단계 | 주요 작용", "[그림 p."):
        assert (snippet in logged) is False, "exported text must not be logged"
    assert seed.counts(ws["id"]) == before, "an export records no activity and starts no job"
