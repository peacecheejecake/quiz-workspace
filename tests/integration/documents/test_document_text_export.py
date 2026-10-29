"""DOCTXT.0 RED contract: DOC-03 full-text export (docs/screens/documents-text-export.md).

DOC-03-C01 authorization matrix, DOC-03-C02 the pure renderer `book_core.export.render_revision`
and DOC-03-C03 response headers, file names and "no body in logs/activity/jobs". Request shape and
assumptions: tests/integration/documents/conftest.py and tests/e2e/fixtures/export.ts (D1-D6).

Every stack test starts with an export call, so the missing feature fails first with
"GET /api/v1/documents/{id}/text not implemented (404)"; the C02 tests fail on the missing
`book_core.export` module. The C02 tests need no stack; they carry the module's `infra` marker only
so that `make test` (which does not exclude `red`) stays green until DOCTXT moves them to
packages/core/tests and drops both markers.
"""

from __future__ import annotations

import importlib
import logging
import re
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from book_core.contracts.common import SourceLocation
from book_core.contracts.document import (
    Block,
    BlockType,
    DocumentRevision,
    Section,
    TableContent,
)
from book_core.parser.fake import load_truth_document
from book_core.structure import build_revision

pytestmark = [pytest.mark.infra, pytest.mark.red]

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
# Golden files of DOC-03-C02, written (and reviewed against the spec) by DOCTXT.
GOLDEN_DIR = REPO_ROOT / "packages" / "core" / "tests" / "golden" / "export"
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
TITLES = {"book-ko": "물의 순환과 정수 처리", "book-en": "The Water Cycle and Water Treatment"}
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


# ---------------------------------------------------------------------------------------------
# DOC-03-C02 book_core.export.render_revision (pure)
# ---------------------------------------------------------------------------------------------


def _render() -> Callable[..., str]:
    """`book_core.export.render_revision` (assumption D5: `render_revision(revision, format, *,
    title)`, format "md" | "txt" (a str-valued enum is fine), returns the file text)."""
    module = importlib.import_module("book_core.export")
    render: Callable[..., str] = module.render_revision
    return render


def _fixture_revision(book: str) -> DocumentRevision:
    parsed = load_truth_document(PDF_DIR / f"{book}.truth.json")
    return build_revision(parsed, document_id=f"doc-{book}", revision_id="rev-1").revision


def _loc(page: int) -> tuple[SourceLocation, ...]:
    return (SourceLocation(page=page),)


def _deep_revision() -> DocumentRevision:
    """Seven nested section levels (heading cap) and a table whose cells hold `|` and newlines."""
    sections: list[Section] = []
    blocks: list[Block] = []
    parent: str | None = None
    for level in range(1, 8):
        sid, bid = f"s{level}", f"h{level}"
        sections.append(
            Section(
                id=sid, title=f"Level {level}", level=level, parent_id=parent, heading_block_id=bid
            )
        )
        blocks.append(
            Block(
                id=bid,
                type=BlockType.HEADING,
                text=f"Level {level}",
                section_id=sid,
                locations=_loc(1 if level < 7 else 2),
                heading_level=level,
            )
        )
        parent = sid
    blocks.append(
        Block(
            id="t1",
            type=BlockType.TABLE,
            text="a|b | head\nline1\nline2 | x",
            section_id="s7",
            locations=_loc(2),
            table=TableContent(rows=(("a|b", "head"), ("line1\nline2", "x")), header_rows=1),
        )
    )
    blocks.append(Block(id="p1", type=BlockType.TEXT, text="Closing paragraph.", locations=_loc(3)))
    for i, b in enumerate(blocks):
        blocks[i] = b.model_copy(update={"ordinal": i})
    return DocumentRevision(
        document_id="doc-deep",
        revision_id="rev-deep",
        revision_number=1,
        source_sha256="0" * 64,
        sections=tuple(sections),
        blocks=tuple(blocks),
    )


def _index_of_line(text: str, line: str) -> int:
    found = lines(text).index(line) if line in lines(text) else -1
    assert found >= 0, f"missing line {line!r}"
    return found


def _previous_nonblank(text: str, index: int) -> str:
    rows = lines(text)
    i = index - 1
    while i >= 0 and rows[i].strip() == "":
        i -= 1
    return rows[i] if i >= 0 else ""


@pytest.mark.parametrize("book", ["book-ko", "book-en"])
@pytest.mark.parametrize("fmt", ["md", "txt"])
def test_doc_03_c02_render_matches_the_golden_file_byte_for_byte(book: str, fmt: str) -> None:
    render = _render()
    revision = _fixture_revision(book)
    out = render(revision, fmt, title=TITLES[book])
    assert out == render(revision, fmt, title=TITLES[book]), "rendering is deterministic"
    golden = GOLDEN_DIR / f"{book}.{fmt}"
    assert golden.is_file(), f"golden file {golden.relative_to(REPO_ROOT)} missing"
    assert out.encode("utf-8") == golden.read_bytes(), f"{book}.{fmt} differs from its golden file"


def test_doc_03_c02_markdown_structure_of_book_ko() -> None:
    md = _render()(_fixture_revision("book-ko"), "md", title=TITLES["book-ko"])
    assert not md.startswith("﻿"), "UTF-8 without BOM"
    assert "\r" not in md, "LF line endings only"
    assert lines(md)[0] == "# 물의 순환과 정수 처리", "document title is the only `#` heading"
    assert [line for line in lines(md) if re.match(r"^# ", line)] == ["# 물의 순환과 정수 처리"]
    # Chapters `##`, sections `###` (outline depth), in outline order.
    headings = [line for line in lines(md) if re.match(r"^#{2,6} ", line)]
    assert headings == [
        "## 1장 물의 순환",
        "### 1.1 증발과 응결",
        "### 1.2 강수와 유출",
        "## 2장 정수 처리",
        "### 2.1 응집과 침전",
        "### 2.2 여과와 소독",
    ]
    # GFM table: header row, delimiter row, body rows.
    header = _index_of_line(md, "| 단계 | 주요 작용 | 예시 체류 시간 |")
    assert re.fullmatch(r"\|(\s*:?-{3,}:?\s*\|){3}", lines(md)[header + 1]), "delimiter row"
    assert lines(md)[header + 2] == "| 응집 | 미세 입자 결합 | 약 30분 |"
    assert lines(md)[header + 5] == "| 소독 | 미생물 억제 | 약 30분 |"
    # The figure is a placeholder, followed by its caption text.
    figure = _index_of_line(md, "[그림 p.2]")
    assert figure < md.split("\n").index("그림 1. 물 순환 모식도 (자리표시자)")
    # Page markers sit right before the first block of their page.
    assert _previous_nonblank(md, _index_of_line(md, "## 1장 물의 순환")) == "<!-- p.2 -->"
    assert _previous_nonblank(md, _index_of_line(md, "## 2장 정수 처리")) == "<!-- p.4 -->"
    assert md.index("<!-- p.2 -->") < md.index("<!-- p.4 -->")
    assert "<!-- p.1 -->" not in md, "page 1 (table of contents) has no canonical block"
    # Paragraphs are separated by blank lines; block order is the reading order.
    texts = [b.text for b in _fixture_revision("book-ko").blocks if b.type is BlockType.TEXT]
    positions = [md.index(t[:20]) for t in texts]
    assert positions == sorted(positions), "text blocks keep their reading order"
    assert "\n\n" + texts[0] + "\n\n" in md, "a paragraph is its own block between blank lines"


def test_doc_03_c02_markdown_page_marker_of_a_page_starting_mid_document() -> None:
    md = _render()(_fixture_revision("book-en"), "md", title=TITLES["book-en"])
    # book-en: "Rivers and groundwater …" is the first block that starts on page 3.
    rivers = next(
        i for i, line in enumerate(lines(md)) if line.startswith("Rivers and groundwater")
    )
    assert _previous_nonblank(md, rivers) == "<!-- p.3 -->"
    assert _previous_nonblank(md, _index_of_line(md, "## Chapter 2. Water Treatment")) == (
        "<!-- p.4 -->"
    )
    assert "[그림 p.2]" in lines(md)


def test_doc_03_c02_plain_text_structure_of_book_ko() -> None:
    txt = _render()(_fixture_revision("book-ko"), "txt", title=TITLES["book-ko"])
    assert not txt.startswith("﻿")
    assert "\r" not in txt
    assert "<!--" not in txt, "no Markdown page comments in the text file"
    assert not [line for line in lines(txt) if line.startswith("#")], "no Markdown headings"
    assert not [line for line in lines(txt) if line.startswith("|")], "no Markdown tables"
    for heading in ("1장 물의 순환", "1.1 증발과 응결", "2.2 여과와 소독"):
        assert heading in lines(txt), f"heading {heading!r} is one line as is"
    assert "단계\t주요 작용\t예시 체류 시간" in lines(txt), "table rows are tab-separated"
    assert "응집\t미세 입자 결합\t약 30분" in lines(txt)
    assert "[그림 p.2]" in lines(txt)
    assert _previous_nonblank(txt, _index_of_line(txt, "1장 물의 순환")) == "[p.2]"
    assert _previous_nonblank(txt, _index_of_line(txt, "2장 정수 처리")) == "[p.4]"
    md = _render()(_fixture_revision("book-ko"), "md", title=TITLES["book-ko"])
    texts = [b.text[:20] for b in _fixture_revision("book-ko").blocks if b.type is BlockType.TEXT]
    assert [txt.index(t) for t in texts] == sorted(txt.index(t) for t in texts)
    assert [md.index(t) for t in texts] == sorted(md.index(t) for t in texts), "same order as md"


def test_doc_03_c02_heading_depth_cap_and_table_cell_escapes() -> None:
    revision = _deep_revision()
    md = _render()(revision, "md", title="Deep")
    headings = [line for line in lines(md) if line.startswith("#")]
    assert headings == [
        "# Deep",
        "## Level 1",
        "### Level 2",
        "#### Level 3",
        "##### Level 4",
        "###### Level 5",
        "###### Level 6",
        "###### Level 7",
    ], "outline depth n gives n+1 `#`, capped at `######`"
    rows = [line for line in lines(md) if line.startswith("|")]
    assert len(rows) == 3, "header, delimiter and one body row: a cell newline never splits a row"
    assert rows[0].startswith("| a\\|b |"), "a `|` inside a cell is escaped"
    assert "line1" in rows[2], "a newline inside a cell stays in its row"
    assert "line2" in rows[2], "a newline inside a cell stays in its row"
    # Page markers: before the first block of pages 1, 2 and 3.
    assert _previous_nonblank(md, _index_of_line(md, "## Level 1")) == "<!-- p.1 -->"
    assert _previous_nonblank(md, _index_of_line(md, "###### Level 7")) == "<!-- p.2 -->"
    assert _previous_nonblank(md, _index_of_line(md, "Closing paragraph.")) == "<!-- p.3 -->"
    txt = _render()(revision, "txt", title="Deep")
    assert "Level 7" in lines(txt)
    tab_rows = [line for line in lines(txt) if "\t" in line]
    assert len(tab_rows) == 2, "one text line per table row"


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
