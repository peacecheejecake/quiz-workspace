"""QSRC-01 server guarantees C01-C05 (docs/screens/question-source-preview.md, questions.md §16).

The source-region API tells a viewer where a question sits in its import PDF and nothing else:
documents, pages and bbox unions, no text and no answers (C01); only import-provenance sources
with a bbox count, never a book source or evidence (C02); any member may read it, strangers,
guests, deleted and draft questions get the one 404 (C03); a mock exam question follows its
origin question (C04); nothing else changes (C05).

Shapes and files are assumptions S1-S7 in tests/e2e/fixtures/question-source.ts. Jobs run in this
process (conftest.py). Every test first proves the route exists with a positive read, so a missing
route fails as "not implemented" and never passes a 404 assertion. RED: `red` marker, removed by
QSRC-API.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest

pytestmark = [pytest.mark.infra, pytest.mark.red]

REPO_ROOT = Path(__file__).resolve().parents[4]
PDFS = REPO_ROOT / "tests" / "fixtures" / "pdfs"
PAPER = PDFS / "questions-ko.pdf"
PAPER_TRUTH = json.loads((PDFS / "questions-ko.truth.json").read_text(encoding="utf-8"))
BOOK_KO = PDFS / "book-ko.pdf"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
# The documented local superuser (AGENTS.md §7; loopback only).
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
ANSWER_KEY_PAGE = 3
REGION_KEYS = {
    "question_id",
    "mock_exam_question_id",
    "regions",
    "document_id",
    "document_revision_id",
    "page",
    "bbox",
    "x0",
    "y0",
    "x1",
    "y1",
}
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
TEXT_KEYS = {"stem", "options", "text", "block_ids", "import_run_id", "quote", "locations"}


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser only for S4 stamps and rows no API exposes)
# ---------------------------------------------------------------------------------------------


def _admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


def upload(client: Any, ws: str, pdf: Path, document_type: str) -> str:
    """upload-intent -> PUT -> complete-upload, then drains the parse job; returns the id."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{ws}/documents/upload-intent",
        {
            "filename": pdf.name,
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


def truth_stem(number: int) -> str:
    return str(next(q["stem"] for q in PAPER_TRUTH["questions"] if q["number"] == number))


def truth_bbox(number: int) -> dict[str, float]:
    box: dict[str, float] = next(
        q["bbox"] for q in PAPER_TRUTH["questions"] if q["number"] == number
    )
    return box


class Rig:
    """A workspace with questions-ko.pdf imported and questions 1 and 5 registered (S3)."""

    def __init__(self, seed: Any, label: str) -> None:
        self.seed = seed
        self.owner = seed.client(f"qsrc-{label}")
        self.ws: str = self.owner.create_workspace()["id"]
        self.paper = upload(self.owner, self.ws, PAPER, "question_paper")
        run = self.owner.ok(
            "POST", f"/workspaces/{self.ws}/question-imports", {"document_id": self.paper}, (202,)
        )
        self.owner.wait_for_job(str(run["job_id"]))
        drafts = sorted(
            self.owner.ok("GET", f"/question-imports/{run['id']}/drafts")["items"],
            key=lambda d: int(d["position"]),
        )
        picked = [next(d for d in drafts if truth_stem(n) in d["payload"]["stem"]) for n in (1, 5)]
        self.owner.ok(
            "POST",
            f"/question-imports/{run['id']}/publish",
            {
                "drafts": [{"draft_id": d["id"], "version": d["version"]} for d in picked],
                "approve": True,
            },
            (200,),
        )
        published = {
            d["id"]: d["published_question_id"]
            for d in self.owner.ok("GET", f"/question-imports/{run['id']}/drafts")["items"]
        }
        self.run: str = str(run["id"])
        self.q1: str = str(published[picked[0]["id"]])
        self.q5: str = str(published[picked[1]["id"]])
        assert self.q1, "draft 1 was not registered"
        assert self.q5, "draft 5 was not registered"
        self._n = 100

    def member(self, label: str, role: str = "viewer") -> Any:
        client = self.seed.client(f"qsrc-{label}")
        self.seed.membership(self.ws, client.user, role)
        return client

    def manual(
        self, label: str, *, status: str = "CONFIRMED", sources: list[Any] | None = None
    ) -> Any:
        self._n += 1
        body: dict[str, Any] = {
            "question_type": "MCQ",
            "stem": f"QSRC {label}: 물이 수증기가 되는 과정은?",
            "options": [
                {"id": f"opt-{i + 1}", "text": t}
                for i, t in enumerate(["증발", "응결", "강수", "침전"])
            ],
            "correct_option_ids": ["opt-1"],
            "is_multi_answer": False,
            "explanation": f"QSRC {label} 해설",
            "question_number": self._n,
            "publication_status": status,
            "sources": sources or [],
        }
        q: dict[str, Any] = self.owner.ok("POST", f"/workspaces/{self.ws}/questions", body, (201,))
        return q

    def import_source_row(
        self, question_id: str, locations: list[dict[str, Any]], *, imported: bool = True
    ) -> None:
        """Adds a `question_sources` row of the paper (S4/S5): imported -> with the import run."""
        pages = [int(loc["page"]) for loc in locations] or [1]
        _admin(
            "insert into public.question_sources (workspace_id, question_id, document_id, "
            "document_revision_id, page_start, page_end, locations, import_run_id) "
            "select q.workspace_id, q.id, d.id, d.active_revision_id, %s, %s, %s::jsonb, %s "
            "from public.questions q join public.documents d on d.id = %s where q.id = %s",
            (
                min(pages),
                max(pages),
                json.dumps(locations),
                self.run if imported else None,
                self.paper,
                question_id,
            ),
        )

    def set_locations(self, question_id: str, locations: list[dict[str, Any]]) -> None:
        """Replaces the locations of the question's import source row."""
        rows = _admin(
            "update public.question_sources set locations = %s::jsonb "
            "where question_id = %s and import_run_id is not null returning id",
            (json.dumps(locations), question_id),
        )
        assert rows, "the question has no import source row"


def set_variation(mock_question_id: str, variation: str) -> None:
    """Marks a mock question as AI-varied past the append-only trigger (no LLM in this suite)."""
    with psycopg.connect(DB_ADMIN_URL, autocommit=False) as conn:
        conn.execute("set local session_replication_role = replica")
        conn.execute(
            "update public.mock_exam_questions set variation_type = %s where id = %s",
            (variation, mock_question_id),
        )
        conn.commit()


def stamp_mock_evidence(mock_question_id: str, evidence: list[Any]) -> None:
    """Writes `evidence` onto a mock question's revisions past the append-only trigger (state no
    shuffle path produces: a variation's evidence can cite any page)."""
    with psycopg.connect(DB_ADMIN_URL, autocommit=False) as conn:
        conn.execute("set local session_replication_role = replica")
        conn.execute(
            "update public.mock_exam_question_revisions set evidence = %s::jsonb "
            "where mock_exam_question_id = %s",
            (json.dumps(evidence), mock_question_id),
        )
        conn.commit()


def region(client: Any, question_id: str) -> httpx.Response:
    res: httpx.Response = client.call("GET", f"/questions/{question_id}/source-region")
    return res


def mock_region(client: Any, mock_question_id: str) -> httpx.Response:
    res: httpx.Response = client.call(
        "GET", f"/mock-exam-questions/{mock_question_id}/source-region"
    )
    return res


def _detail(res: httpx.Response) -> str:
    try:
        return str(res.json().get("detail") or "")
    except ValueError:
        return ""


def ok(res: httpx.Response) -> dict[str, Any]:
    route = f"GET {urlsplit(str(res.request.url)).path}"
    if res.status_code in {404, 405} and not _detail(res):
        pytest.fail(f"{route} not implemented ({res.status_code})")
    assert res.status_code == 200, f"{route}: HTTP {res.status_code}: {res.text[:300]}"
    body: dict[str, Any] = res.json()
    return body


def not_found(res: httpx.Response) -> None:
    """The API's one 404 (a missing route has no `detail`, so it never passes here)."""
    assert res.status_code == 404, f"expected 404, got {res.status_code}: {res.text[:300]}"
    assert _detail(res), "the 404 must be an application 404, not a missing route"


def keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys(v)}
    return set()


def shuffle_exam(client: Any, ws: str, question_ids: list[str]) -> list[dict[str, Any]]:
    """A `보기 섞기` mock exam of the questions (MOCK-B), drained; returns its questions."""
    created = client.ok(
        "POST",
        f"/workspaces/{ws}/mock-exams",
        {
            "title": f"원문 모의 {uuid.uuid4().hex[:6]}",
            "config": {
                "variation_types": ["OPTION_SHUFFLE"],
                "question_count": len(question_ids),
                "difficulty": None,
            },
            "range": {"question_ids": question_ids},
        },
        (202,),
    )
    client.wait_for_job(str(created["latest_generation"]["job_id"]))
    items: list[dict[str, Any]] = client.ok(
        "GET", f"/mock-exams/{created['id']}/questions?include=answers"
    )["items"]
    return sorted(items, key=lambda q: int(q["position"]))


def count(sql: str, params: tuple[Any, ...]) -> int:
    [(n,)] = _admin(sql, params)
    return int(n)


# ---------------------------------------------------------------------------------------------
# C01 non-disclosing response
# ---------------------------------------------------------------------------------------------


def test_qsrc_01_c01_response_names_documents_pages_and_boxes_only(seed: Any) -> None:
    rig = Rig(seed, "c01")
    res = region(rig.owner, rig.q1)
    body = ok(res)
    assert set(body) == {"question_id", "regions"}, body
    assert body["question_id"] == rig.q1
    assert not keys(body) - REGION_KEYS, keys(body) - REGION_KEYS
    assert not keys(body) & (ANSWER_KEYS | TEXT_KEYS)
    [only] = body["regions"]
    assert set(only) == {"document_id", "document_revision_id", "page", "bbox"}
    assert only["document_id"] == rig.paper
    assert only["page"] == 1
    box = only["bbox"]
    assert set(box) == {"x0", "y0", "x1", "y1"}
    assert box["x0"] < box["x1"]
    assert box["y0"] < box["y1"]
    cache = res.headers.get("cache-control", "").lower()
    assert "private" in cache, cache
    assert "no-store" in cache, cache
    expected = truth_bbox(1)
    for edge in ("x0", "y0", "x1", "y1"):
        assert abs(float(box[edge]) - float(expected[edge])) < 6.0, (edge, box, expected)


def test_qsrc_01_c01_same_response_before_and_after_submitting_and_nothing_recorded(
    seed: Any,
) -> None:
    rig = Rig(seed, "c01-submit")
    before = ok(region(rig.owner, rig.q1))
    sessions = count(
        "select count(*) from public.practice_sessions where question_id = %s", (rig.q1,)
    )
    attempts = count(
        "select count(*) from public.question_attempts where question_id = %s", (rig.q1,)
    )
    states = count(
        "select count(*) from public.question_user_states where question_id = %s", (rig.q1,)
    )
    again = ok(region(rig.owner, rig.q1))
    assert again == before
    assert (
        count("select count(*) from public.practice_sessions where question_id = %s", (rig.q1,))
        == sessions
    )
    assert (
        count("select count(*) from public.question_attempts where question_id = %s", (rig.q1,))
        == attempts
    )
    assert (
        count("select count(*) from public.question_user_states where question_id = %s", (rig.q1,))
        == states
    )
    # Submitting (the practice session needs no region proof) leaves the same region.
    session = rig.owner.ok("POST", f"/questions/{rig.q1}/practice-sessions", {}, (201,))
    detail = rig.owner.ok("GET", f"/questions/{rig.q1}")
    rig.owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": detail["revision"]["correct_option_ids"]},
    )
    assert ok(region(rig.owner, rig.q1)) == before
    # The practice DTO is unchanged: it carries no region field.
    started = rig.owner.ok("POST", f"/questions/{rig.q1}/practice-sessions", {}, (201,))
    assert not [k for k in keys(started) if "region" in k or k == "bbox"]


def test_qsrc_01_c01_regions_are_page_unions_in_page_order(seed: Any) -> None:
    rig = Rig(seed, "c01-union")
    ok(region(rig.owner, rig.q1))
    own = truth_bbox(1)
    # A second location on page 1 widens the union; a page-2 one adds a second region.
    rig.set_locations(
        rig.q1,
        [
            {"page": 2, "bbox": {"x0": 70.0, "y0": 90.0, "x1": 300.0, "y1": 150.0}},
            {"page": 1, "bbox": own},
            {"page": 1, "bbox": {"x0": 10.0, "y0": 300.0, "x1": 400.0, "y1": 360.0}},
        ],
    )
    body = ok(region(rig.owner, rig.q1))
    assert [r["page"] for r in body["regions"]] == [1, 2], "one region per page, ascending"
    p1, p2 = body["regions"]
    assert float(p1["bbox"]["x0"]) == pytest.approx(10.0, abs=0.01)
    assert float(p1["bbox"]["y0"]) == pytest.approx(float(own["y0"]), abs=0.01)
    assert float(p1["bbox"]["x1"]) == pytest.approx(400.0, abs=0.01)
    assert float(p1["bbox"]["y1"]) == pytest.approx(360.0, abs=0.01)
    assert float(p2["bbox"]["x1"]) == pytest.approx(300.0, abs=0.01)
    assert all(r["document_id"] == rig.paper for r in body["regions"])


# ---------------------------------------------------------------------------------------------
# C02 import provenance only
# ---------------------------------------------------------------------------------------------


def test_qsrc_01_c02_only_import_sources_with_a_bbox_count(seed: Any) -> None:
    rig = Rig(seed, "c02")
    ok(region(rig.owner, rig.q1))  # the route exists and an imported question has a region

    # A manual question and a question whose only source cites the paper's answer-key page
    # without an import run: both 404 (the answer-key page must never be reachable).
    manual = rig.manual("c02-manual")
    keyed = rig.manual(
        "c02-keyed",
        sources=[
            {"document_id": rig.paper, "page_start": ANSWER_KEY_PAGE, "page_end": ANSWER_KEY_PAGE}
        ],
    )
    not_found(region(rig.owner, manual["id"]))
    not_found(region(rig.owner, keyed["id"]))

    # A book source is no import provenance either.
    book = upload(rig.owner, rig.ws, BOOK_KO, "book")
    booked = rig.manual("c02-book", sources=[{"document_id": book, "page_start": 2, "page_end": 2}])
    not_found(region(rig.owner, booked["id"]))

    # Import locations without a bbox are skipped; with nothing left the question has no region.
    unboxed = rig.manual("c02-unboxed")
    rig.import_source_row(unboxed["id"], [{"page": 1}, {"page": 2, "block_id": "b-1"}])
    not_found(region(rig.owner, unboxed["id"]))

    # Import and non-import sources together: only the import locations are in the response.
    mixed = rig.manual(
        "c02-mixed",
        sources=[
            {"document_id": rig.paper, "page_start": ANSWER_KEY_PAGE, "page_end": ANSWER_KEY_PAGE}
        ],
    )
    rig.import_source_row(mixed["id"], [{"page": 1, "bbox": truth_bbox(1)}])
    body = ok(region(rig.owner, mixed["id"]))
    assert [r["page"] for r in body["regions"]] == [1]
    assert ANSWER_KEY_PAGE not in [r["page"] for r in body["regions"]]

    # The question PDF is deleted (soft): the questions stay but have no source any more, and the
    # document itself answers 404 (the original is immutable, so no revision check exists).
    rig.owner.ok("DELETE", f"/documents/{rig.paper}", None, (200, 202, 204))
    assert rig.owner.call("GET", f"/documents/{rig.paper}/source-url").status_code == 404
    for q in (rig.q1, rig.q5, mixed["id"]):
        not_found(region(rig.owner, q))
    assert rig.owner.ok("GET", f"/questions/{rig.q1}")["id"] == rig.q1, "the question stays"


# ---------------------------------------------------------------------------------------------
# C03 authorization
# ---------------------------------------------------------------------------------------------


def test_qsrc_01_c03_any_member_reads_and_everyone_else_gets_the_one_404(seed: Any) -> None:
    rig = Rig(seed, "c03")
    expected = ok(region(rig.owner, rig.q1))
    viewer = rig.member("c03-viewer")
    assert ok(region(viewer, rig.q1)) == expected, "a viewer reads it (no edit right needed)"

    stranger = seed.client("qsrc-c03-stranger")
    other = Rig(seed, "c03-other")
    for who in (stranger, other.owner):
        not_found(region(who, rig.q1))
    unknown = region(rig.owner, str(uuid.uuid4()))
    not_found(unknown)

    # A draft question with import provenance and a deleted question: 404.
    draft = rig.manual("c03-draft", status="DRAFT")
    rig.import_source_row(draft["id"], [{"page": 1, "bbox": truth_bbox(1)}])
    not_found(region(rig.owner, draft["id"]))
    gone = rig.manual("c03-gone")
    rig.import_source_row(gone["id"], [{"page": 1, "bbox": truth_bbox(1)}])
    ok(region(rig.owner, gone["id"]))
    rig.owner.ok("DELETE", f"/questions/{gone['id']}", None, (200, 204))
    not_found(region(rig.owner, gone["id"]))

    # Archived question and archived workspace stay readable.
    detail = rig.owner.ok("GET", f"/questions/{rig.q5}")
    rig.owner.ok(
        "PATCH",
        f"/questions/{rig.q5}",
        {"base_revision_id": detail["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    ok(region(viewer, rig.q5))
    rig.owner.ok("POST", f"/workspaces/{rig.ws}/archive", None, (200,))
    assert ok(region(viewer, rig.q1)) == expected

    # Share guests (cookie) and anonymous requests cannot use the member API.
    guest_rig = Rig(seed, "c03-guest")
    link = guest_rig.owner.create_link(guest_rig.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    ok(region(guest_rig.owner, guest_rig.q1))
    for res in (
        guest.send("GET", f"/questions/{guest_rig.q1}/source-region", cookie=cookie),
        guest.send("GET", f"/questions/{guest_rig.q1}/source-region"),
    ):
        assert res.status_code in {401, 403, 404}, res.status_code
        assert not keys(res.json() if res.content else {}) & {"regions", "bbox"}


# ---------------------------------------------------------------------------------------------
# C04 mock exam variant
# ---------------------------------------------------------------------------------------------


def test_qsrc_01_c04_mock_question_follows_its_origin_question(seed: Any) -> None:
    rig = Rig(seed, "c04")
    manual = rig.manual("c04-manual")
    origin = ok(region(rig.owner, rig.q1))
    mocks = shuffle_exam(rig.owner, rig.ws, [rig.q1, rig.q5, manual["id"]])
    by_origin = {m["source"]["question_id"]: m for m in mocks}
    imported, second, plain = by_origin[rig.q1], by_origin[rig.q5], by_origin[manual["id"]]

    body = ok(mock_region(rig.owner, imported["id"]))
    assert set(body) == {"mock_exam_question_id", "regions"}, body
    assert body["mock_exam_question_id"] == imported["id"]
    assert body["regions"] == origin["regions"], "the origin question's regions"
    assert not keys(body) - REGION_KEYS
    assert not keys(body) & (ANSWER_KEYS | TEXT_KEYS)
    not_found(mock_region(rig.owner, plain["id"]))

    viewer = rig.member("c04-viewer")
    assert ok(mock_region(viewer, imported["id"])) == body
    not_found(mock_region(seed.client("qsrc-c04-stranger"), imported["id"]))

    attempts = count(
        "select count(*) from public.mock_exam_attempts a "
        "join public.mock_exam_question_revisions r "
        "on r.id = a.mock_exam_question_revision_id where r.mock_exam_question_id = %s",
        (imported["id"],),
    )
    assert attempts == 0, "reading a region records nothing"

    # The origin is gone (deleted) or a draft again: the mock question has no region.
    rig.owner.ok("DELETE", f"/questions/{rig.q5}", None, (200, 204))
    not_found(mock_region(rig.owner, second["id"]))
    # The mock revision's evidence is never used: stamp an import-looking location on the manual
    # origin's mock evidence and it still has no region.
    stamp_mock_evidence(
        plain["id"],
        [{"document_id": rig.paper, "locations": [{"page": 1, "bbox": truth_bbox(1)}]}],
    )
    not_found(mock_region(rig.owner, plain["id"]))

    # Only `보기 섞기` mock questions: an AI-varied one has no region although its origin has one.
    [varied] = shuffle_exam(rig.owner, rig.ws, [rig.q1])
    assert ok(mock_region(rig.owner, varied["id"]))["regions"] == origin["regions"]
    set_variation(varied["id"], "PARAPHRASE")
    not_found(mock_region(rig.owner, varied["id"]))
    ok(mock_region(rig.owner, imported["id"]))

    # The origin's source PDF is deleted: the shuffle mock question has no region either.
    rig.owner.ok("DELETE", f"/documents/{rig.paper}", None, (200, 202, 204))
    not_found(mock_region(rig.owner, imported["id"]))


# ---------------------------------------------------------------------------------------------
# C05 existing paths unchanged
# ---------------------------------------------------------------------------------------------


def test_qsrc_01_c05_no_new_table_and_the_pdf_relay_keeps_its_permissions(seed: Any) -> None:
    rig = Rig(seed, "c05")
    ok(region(rig.owner, rig.q1))
    assert (
        count(
            "select count(*) from information_schema.tables where table_schema = 'public' "
            "and table_name like %s",
            ("%source_region%",),
        )
        == 0
    ), "the feature stores nothing"
    viewer = rig.member("c05-viewer")
    relay = viewer.call("GET", f"/documents/{rig.paper}/source-url")
    assert relay.status_code == 200, "any member keeps reading the PDF relay"
    stranger = seed.client("qsrc-c05-stranger")
    assert stranger.call("GET", f"/documents/{rig.paper}/source-url").status_code == 404
    # The practice DTO never carries a source or region field (QPLAY-01-AC01).
    started = rig.owner.ok("POST", f"/questions/{rig.q1}/practice-sessions", {}, (201,))
    assert not [k for k in keys(started) if k in {"sources", "regions", "bbox", "locations"}]
