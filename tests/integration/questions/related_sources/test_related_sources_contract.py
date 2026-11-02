"""RELSRC-01 server guarantees C01-C07 (docs/screens/related-sources.md, questions.md §13,
workspace-sharing.md §10, architecture.md §5-§6).

A list is shown only after a submission (or to a reader of the answers, `view: detail` /
`view: manage`), never for a DRAFT, and every refusal computes and stores nothing (C01); the
candidates are the workspace's published books only, question-source blocks first, the query is
the stem plus the correct answer (C02); the key is (question revision, corpus fingerprint,
retrieval version) and old keys are superseded, not deleted (C03); concurrent first reads compute
once (C04); archived workspaces, degraded search and guests never store, an outage is a 503
(C05); nothing leaks into logs, practice responses and study state are unchanged, a fork copies no
rows (C06); mock exam questions have their own table, use their evidence's book blocks only and
their own submission proof (C07).

Shapes, markers and files are assumptions R1-R10 in tests/e2e/fixtures/related-sources.ts. Jobs
run in this process (conftest.py). RELSRC.0: every test is `red` until RELSRC-B.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import tempfile
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
import psycopg
import pytest

pytestmark = [pytest.mark.infra, pytest.mark.red]

REPO_ROOT = Path(__file__).resolve().parents[4]
PDFS = REPO_ROOT / "tests" / "fixtures" / "pdfs"
BOOK_KO = PDFS / "book-ko.pdf"
BOOK_EN = PDFS / "book-en.pdf"
PAPER = PDFS / "questions-ko.pdf"
TRUTH = json.loads((PDFS / "book-ko.truth.json").read_text(encoding="utf-8"))
PAPER_TRUTH = json.loads((PDFS / "questions-ko.truth.json").read_text(encoding="utf-8"))
CH1, CH2 = "1장 물의 순환", "2장 정수 처리"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
# The documented local superuser (AGENTS.md §7; loopback only).
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
P = "urn:quiz-workspace:problem:"
BEFORE_SUBMIT = P + "related-before-submit"
DRAFT_UNAVAILABLE = P + "related-draft-unavailable"
UNAVAILABLE = P + "related-unavailable"
LIMIT = 5
HOLD_MARKER = "E2E-RELSRC-HOLD"
FAIL_MARKER = "E2E-RELSRC-FAIL"
DENSE_MARKER = "E2E-FAIL-EMBEDDING"
SHARED_FORBIDDEN = {
    "score",
    "stale",
    "revision_id",
    "question_revision_id",
    "corpus_fingerprint",
    "retrieval_version",
}

ANSWER = "가나다 원리"
APPLIED = "가나다 응용"
WRONG_ONLY = "마바사 오개념"
TEXT = {
    "ch1-s1-p1": "가나다 원리: 햇빛의 에너지를 얻은 물 분자가 수증기가 되는 과정을 설명하는 합성 "
    "개념이다. 가나다 원리는 이 장의 증발 설명 전체에 쓰인다.",
    "ch1-s1-p2": "가나다 원리 보충: 같은 쪽의 두 번째 구절이며 수증기가 다시 물방울이 되는 과정을 "
    "다룬다.",
    "ch2-s1-p1": "가나다 응용: 정수장은 가나다 원리를 응집 공정에 적용해 작은 입자를 플록으로 "
    "모은다. 가나다 응용은 합성 사례이다.",
    # C02: only a wrong option names this concept; it must never be retrieved by the query.
    "ch2-s2-p1": f"{WRONG_ONLY}: 여과층이 소독을 대신한다는 잘못된 합성 설명이다. {WRONG_ONLY}.",
}
APPLIED_REMOVED = "원수에 응집제를 넣고 천천히 저으면 작은 입자들이 서로 달라붙어 덩어리가 된다."
PAPER_ONLY = "라마바 정답표"
MIXED_ONLY = "사아자 해설"


def _dir(env: str, name: str) -> Path:
    return Path(os.environ.get(env, "").strip() or Path(tempfile.gettempdir()) / name)


HOLD_DIR = _dir("RELATED_SOURCES_HOLD_DIR", "quiz-e2e-related-sources-hold")
FAULT_DIR = _dir("RELATED_SOURCES_FAULT_DIR", "quiz-e2e-related-sources-faults")
CALL_DIR = _dir("RELATED_SOURCES_CALL_LOG_DIR", "quiz-e2e-related-sources-calls")


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser only for R9 stamps, R4 reads and catalog facts)
# ---------------------------------------------------------------------------------------------


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


def blocks(client: Any, doc: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok("GET", f"/documents/{doc}/blocks?limit=500")["items"]
    return items


def block_id(client: Any, doc: str, match: Callable[[str], bool]) -> str:
    found = [b for b in blocks(client, doc) if match(str(b["text"]))]
    assert found, "block not found in the document"
    return str(found[0]["block_id"])


def _starts(truth: str) -> Callable[[str], bool]:
    head = truth[:24]
    return lambda text: text.startswith(head)


def truth_text(block: str) -> str:
    return str(next(b["text"] for b in TRUTH["blocks"] if b["id"] == block))


def publish(client: Any, doc: str, edits: dict[str, str]) -> str:
    """DOC-02 corrections + publish; drains the job; returns the new active revision id."""
    for bid, text in edits.items():
        client.ok("PATCH", f"/documents/{doc}/blocks/{bid}", {"text": text})
    accepted = client.ok("POST", f"/documents/{doc}/publish", {}, (202,))
    client.wait_for_job(str(accepted["job_id"]))
    active = client.ok("GET", f"/documents/{doc}")["active_revision_id"]
    assert active == accepted["revision_id"]
    return str(active)


class Rig:
    """A workspace with book-ko and the R10 corrections (+ a wrong-option-only passage)."""

    def __init__(self, seed: Any, label: str, workspace_id: str | None = None) -> None:
        self.seed = seed
        self.owner = seed.client(f"relsrc-{label}")
        self.ws: str = workspace_id or self.owner.create_workspace()["id"]
        self.doc = upload(self.owner, self.ws, BOOK_KO, "book")
        self.block = {key: block_id(self.owner, self.doc, _starts(truth_text(key))) for key in TEXT}
        self.revision = publish(self.owner, self.doc, {self.block[k]: v for k, v in TEXT.items()})
        outline = self.owner.ok("GET", f"/documents/{self.doc}/outline")["items"]
        by_title = {str(n["title"]).strip(): str(n["id"]) for n in outline}
        self.ch1, self.ch2 = by_title[CH1], by_title[CH2]
        self._n = 0

    def member(self, label: str, role: str = "viewer") -> Any:
        client = self.seed.client(f"relsrc-{label}")
        self.seed.membership(self.ws, client.user, role)
        return client

    def question(
        self,
        label: str,
        *,
        answer: str = ANSWER,
        wrong: tuple[str, ...] = ("하늘 법칙", "바람 규칙", "구름 이론"),
        markers: tuple[str, ...] = (),
        source: str | None = "ch1-s1-p1",
        status: str = "CONFIRMED",
        stem: str | None = None,
    ) -> dict[str, Any]:
        self._n += 1
        tail = "".join(f" [{m}]" for m in markers)
        texts = [answer, *wrong]
        options = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(texts)]
        page = 4 if source and source.startswith("ch2") else 2
        body: dict[str, Any] = {
            "question_type": "MCQ",
            "stem": stem
            or f"RELSRC {label}: 물 분자가 수증기가 되는 과정을 설명하는 개념은?{tail}",
            "options": options,
            "correct_option_ids": ["opt-1"],
            "is_multi_answer": False,
            "explanation": f"RELSRC {label} 해설",
            "chapter_id": self.ch1,
            "question_number": self._n,
            "publication_status": status,
            "sources": (
                [{"document_id": self.doc, "page_start": page, "page_end": page}] if source else []
            ),
        }
        q: dict[str, Any] = self.owner.ok("POST", f"/workspaces/{self.ws}/questions", body, (201,))
        if source:
            stamp(q["id"], self.doc, [self.block[source]])
        return q


def stamp(question_id: str, doc: str, ids: list[str]) -> None:
    """R9: the question's source row of `doc` cites `ids`."""
    rows = _admin(
        "update public.question_sources set block_ids = %s "
        "where question_id = %s and document_id = %s returning id",
        (ids, question_id, doc),
    )
    assert len(rows) == 1, "question source row not found"


def add_imported_source(question_id: str, doc: str, run: str, page: int, ids: list[str]) -> None:
    """R9: an imported question-PDF source row (import_run_id set)."""
    _admin(
        "insert into public.question_sources (workspace_id, question_id, document_id, "
        "document_revision_id, page_start, page_end, block_ids, import_run_id) "
        "select q.workspace_id, q.id, d.id, d.active_revision_id, %s, %s, %s, %s "
        "from public.questions q join public.documents d on d.id = %s where q.id = %s",
        (page, page, ids, run, doc, question_id),
    )


def _admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


def stamp_quote(mock_revision_id: str, quote: str) -> None:
    with psycopg.connect(DB_ADMIN_URL, autocommit=False) as conn:
        conn.execute("set local session_replication_role = replica")
        conn.execute(
            "update public.mock_exam_question_revisions set evidence = (select "
            "coalesce(jsonb_agg(e || jsonb_build_object('quote', %s::text)), '[]'::jsonb) "
            "from jsonb_array_elements(evidence) e) where id = %s",
            (quote, mock_revision_id),
        )
        conn.commit()


def _require(table: str) -> None:
    [(found,)] = _admin("select to_regclass(%s) is not null", (f"public.{table}",))
    if not found:
        pytest.fail(f"table public.{table} does not exist (RELSRC-B migration not applied)")


def rows(question_id: str) -> list[tuple[str, str, bool]]:
    """(row id, question revision id, superseded) of every stored list of the question (R4)."""
    _require("question_related_sources")
    return [
        (str(r[0]), str(r[1]), bool(r[2]))
        for r in _admin(
            "select s.id, s.question_revision_id, s.superseded_at is not null "
            "from public.question_related_sources s join public.question_revisions r "
            "on r.id = s.question_revision_id where r.question_id = %s order by s.created_at, s.id",
            (question_id,),
        )
    ]


def mock_rows(mock_question_id: str) -> list[tuple[str, str, bool]]:
    _require("mock_exam_question_related_sources")
    return [
        (str(r[0]), str(r[1]), bool(r[2]))
        for r in _admin(
            "select s.id, s.mock_exam_question_revision_id, s.superseded_at is not null "
            "from public.mock_exam_question_related_sources s "
            "join public.mock_exam_question_revisions r on r.id = s.mock_exam_question_revision_id "
            "where r.mock_exam_question_id = %s order by s.created_at, s.id",
            (mock_question_id,),
        )
    ]


def calls(revision_id: str) -> int:
    """R8: searches the computation ran for a (question or mock question) revision."""
    file = CALL_DIR / f"{revision_id}.calls"
    if not file.exists():
        return 0
    return len([line for line in file.read_text(encoding="utf-8").splitlines() if line.strip()])


def read(client: Any, question_id: str, **query: str) -> httpx.Response:
    suffix = f"?{urlencode(query)}" if query else ""
    res: httpx.Response = client.call("GET", f"/questions/{question_id}/related-sources{suffix}")
    return res


def read_mock(client: Any, mock_question_id: str, **query: str) -> httpx.Response:
    suffix = f"?{urlencode(query)}" if query else ""
    res: httpx.Response = client.call(
        "GET", f"/mock-exam-questions/{mock_question_id}/related-sources{suffix}"
    )
    return res


def ok(res: httpx.Response) -> dict[str, Any]:
    route = f"GET {urlsplit(str(res.request.url)).path}"
    if res.status_code == 404 and not _detail(res):
        pytest.fail(f"{route} not implemented (404)")
    assert res.status_code == 200, f"{route}: HTTP {res.status_code}: {res.text[:300]}"
    body: dict[str, Any] = res.json()
    return body


def _detail(res: httpx.Response) -> str:
    try:
        return str(res.json().get("detail") or "")
    except ValueError:
        return ""


def refused(res: httpx.Response, status: int, problem_type: str | None = None) -> dict[str, Any]:
    if res.status_code in {404, 405} and not _detail(res):
        pytest.fail(f"GET {urlsplit(str(res.request.url)).path} not implemented")
    assert res.status_code == status, f"expected {status}, got {res.status_code}: {res.text[:300]}"
    body: dict[str, Any] = res.json()
    if problem_type:
        assert body.get("type") == problem_type, body
    return body


def session(client: Any, question_id: str) -> str:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return str(out["id"])


def submit(client: Any, question: dict[str, Any], session_id: str | None = None) -> str:
    sid = session_id or session(client, question["id"])
    client.ok(
        "POST",
        f"/practice-sessions/{sid}/submit",
        {"selected_option_ids": question["revision"]["correct_option_ids"]},
    )
    return sid


def first_read(client: Any, question: dict[str, Any]) -> dict[str, Any]:
    return ok(read(client, question["id"], practice_session_id=submit(client, question)))


def keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys(v)}
    return set()


class Hold:
    """R5 hold barrier for one token."""

    def __init__(self) -> None:
        self.token = uuid.uuid4().hex[:16]
        self.marker = f"{HOLD_MARKER}-{self.token}"

    def held(self, pending: list[Any] | None = None, timeout: float = 30) -> None:
        """Waits for the barrier; a request that already answered is checked instead (a 404 of
        a missing route fails as "not implemented", not as a timeout)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (HOLD_DIR / f"{self.token}.held").exists():
                return
            for future in pending or []:
                if future.done():
                    ok(future.result())
            time.sleep(0.05)
        pytest.fail("the related-sources computation never reached the hold barrier (R5)")

    def release(self) -> None:
        HOLD_DIR.mkdir(parents=True, exist_ok=True)
        (HOLD_DIR / f"{self.token}.release").touch()

    def cleanup(self) -> None:
        for ext in ("held", "release"):
            (HOLD_DIR / f"{self.token}.{ext}").unlink(missing_ok=True)


def paper(client: Any, ws: str, document_type: str = "question_paper") -> str:
    return upload(client, ws, PAPER, document_type)


def paper_stem(number: int) -> str:
    return str(next(q["stem"] for q in PAPER_TRUTH["questions"] if q["number"] == number))


def prefix_block(client: Any, doc: str, contains: str, prefix: str) -> str:
    """Corrects the block printing `contains` to start it with `prefix:`; returns its id."""
    found = next(b for b in blocks(client, doc) if contains in str(b["text"]))
    publish(
        client,
        doc,
        {found["block_id"]: str(found["text"]).replace(contains, f"{prefix}: {contains}")},
    )
    return str(found["block_id"])


def shuffle_exam(client: Any, ws: str, question_ids: list[str]) -> tuple[str, list[dict[str, Any]]]:
    """A `보기 섞기` mock exam of the questions (MOCK-B), drained; returns (exam id, questions)."""
    created = client.ok(
        "POST",
        f"/workspaces/{ws}/mock-exams",
        {
            "title": f"관련 본문 모의 {uuid.uuid4().hex[:6]}",
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
    return str(created["id"]), sorted(items, key=lambda q: int(q["position"]))


def mock_submit(client: Any, mq: dict[str, Any]) -> str:
    s = client.ok("POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,))
    out = client.ok(
        "POST",
        f"/mock-practice-sessions/{s['id']}/submit",
        {"selected_option_ids": mq["correct_option_ids"]},
    )
    assert not {k for k in keys(out) if "related" in k}, "mock submit carries no related field"
    return str(s["id"])


# ---------------------------------------------------------------------------------------------
# C01 submission proof and authorization
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c01_submission_proof_authorization_and_drafts(seed: Any) -> None:
    rig = Rig(seed, "c01")
    q = rig.question("c01")
    draft = rig.question("c01-draft", status="DRAFT")
    archived = rig.question("c01-archived")
    archived = rig.owner.ok(
        "PATCH",
        f"/questions/{archived['id']}",
        {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    member = rig.member("c01-viewer")
    other = rig.member("c01-other")
    stranger = seed.client("relsrc-c01-stranger")
    other_session = submit(other, q)
    open_session = session(member, q["id"])
    rev = q["revision"]["id"]
    neighbour = rig.question("c01-neighbour")
    own_elsewhere = submit(member, neighbour)

    # Before a submission, without proof, with a client workspace_id: 409; nothing computed.
    body = refused(read(member, q["id"], practice_session_id=open_session), 409, BEFORE_SUBMIT)
    assert ANSWER not in json.dumps(body, ensure_ascii=False)
    refused(read(member, q["id"]), 409, BEFORE_SUBMIT)
    refused(read(member, q["id"], workspace_id=str(uuid.uuid4())), 409, BEFORE_SUBMIT)
    # Another user's session, an unknown session, another workspace, a deleted question: one 404.
    unknown = refused(read(member, q["id"], practice_session_id=str(uuid.uuid4())), 404)
    foreign = refused(read(member, q["id"], practice_session_id=other_session), 404)
    outsider = refused(read(stranger, q["id"], view="detail"), 404)
    # The caller's own submitted session of ANOTHER question proves nothing for this one.
    elsewhere = refused(read(member, q["id"], practice_session_id=own_elsewhere), 404)
    assert calls(neighbour["revision"]["id"]) == 0
    assert rows(neighbour["id"]) == []
    assert {k: v for k, v in foreign.items() if k not in {"instance", "request_id"}} == {
        k: v for k, v in unknown.items() if k not in {"instance", "request_id"}
    }
    for problem in (unknown, foreign, outsider, elsewhere):
        text = json.dumps(problem, ensure_ascii=False)
        assert rig.doc not in text
        assert ANSWER not in text
    # A DRAFT's details: 409 related-draft-unavailable, no search, no row (ASK-SYNC (b)).
    refused(read(rig.owner, draft["id"], view="detail"), 409, DRAFT_UNAVAILABLE)
    assert calls(rev) == 0
    assert calls(draft["revision"]["id"]) == 0
    assert rows(q["id"]) == []
    assert rows(draft["id"]) == []

    # A pending-grade essay submission counts as submitted (채점 대기 포함).
    essay = rig.owner.ok(
        "POST",
        f"/workspaces/{rig.ws}/questions",
        {
            "question_type": "ESSAY",
            "stem": "RELSRC c01 서술형: 가나다 원리를 설명하시오.",
            "rubric": f"{ANSWER}를 증발과 연결해 설명한다.",
            "question_number": 90,
        },
        (201,),
    )
    essay_session = session(member, essay["id"])
    member.ok("POST", f"/practice-sessions/{essay_session}/submit", {"answer_text": "증발"})
    ok(read(member, essay["id"], practice_session_id=essay_session))

    # After the submission: 200 with the list (DB decides; the client's ids are ignored).
    submit(member, q, open_session)
    listed = ok(read(member, q["id"], practice_session_id=open_session))
    assert listed["question_revision_id"] == rev
    assert listed["items"]
    assert listed["stored"] is True
    # Readers of the answers: view=detail for any member, ARCHIVED questions included.
    assert ok(read(member, q["id"], view="detail"))["id"] == listed["id"]
    ok(read(member, archived["id"], view="detail"))
    # Deleted question: 404.
    rig.owner.ok("DELETE", f"/questions/{q['id']}", None, (200, 204))
    refused(read(member, q["id"], view="detail"), 404)


def test_relsrc_01_c01_settings_have_limits_and_no_off_switch() -> None:
    from quiz_api.settings import Settings

    fields = set(Settings.model_fields)
    assert {"related_sources_limit", "related_sources_min_relevance"} <= fields, (
        "RELATED_SOURCES_LIMIT / RELATED_SOURCES_MIN_RELEVANCE settings (RELSRC-B)"
    )
    assert not [f for f in fields if f.startswith("related_sources") and "enabled" in f], (
        "always on: no RELATED_SOURCES_ENABLED switch (user decision 2026-11-01)"
    )


def test_relsrc_01_c01_shared_api_reads_stored_lists_only(seed: Any) -> None:
    rig = Rig(seed, "c01-share")
    stored = rig.question("c01-share-stored")
    unstored = rig.question("c01-share-unstored")
    draft = rig.question("c01-share-draft", status="DRAFT")
    first_read(rig.owner, stored)
    link = rig.owner.create_link(rig.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    res = guest.read(link["id"], cookie, f"/questions/{stored['id']}/related-sources")
    body = ok(res)
    assert body["items"]
    assert not keys(body) & SHARED_FORBIDDEN, keys(body) & SHARED_FORBIDDEN
    for path_q in (unstored, draft):
        res = guest.read(link["id"], cookie, f"/questions/{path_q['id']}/related-sources")
        assert res.status_code == 404
    assert calls(unstored["revision"]["id"]) == 0, "a guest request never computes"
    assert rows(unstored["id"]) == []

    def guest_status(question_id: str) -> int:
        path = f"/questions/{question_id}/related-sources"
        return int(guest.read(link["id"], cookie, path).status_code)

    # (a) A book correction changes the corpus fingerprint: the stored list is stale, guests get
    # 404 (no compute) until a member reads it again.
    rev = stored["revision"]["id"]
    before = calls(rev)
    publish(rig.owner, rig.doc, {rig.block["ch2-s1-p1"]: APPLIED_REMOVED})
    assert guest_status(stored["id"]) == 404, "a stale list is not served to guests"
    assert calls(rev) == before, "a guest request never recomputes a stale list"
    ok(read(rig.owner, stored["id"], view="detail"))
    assert calls(rev) == before + 1
    assert guest_status(stored["id"]) == 200
    # (b) A question edit makes a new active revision: 404 for guests until a member reads it.
    edited = rig.owner.ok(
        "PATCH",
        f"/questions/{stored['id']}",
        {"base_revision_id": rev, "stem": "RELSRC c01-share 수정: 수증기가 되는 과정의 개념은?"},
    )
    new_rev = edited["revision"]["id"]
    assert guest_status(stored["id"]) == 404, "the old revision's list is not served"
    assert calls(new_rev) == 0
    assert calls(rev) == before + 1
    ok(read(rig.owner, stored["id"], view="detail"))
    assert calls(new_rev) == 1
    assert guest_status(stored["id"]) == 200
    # The link is re-validated on every request.
    seed.assert_status(rig.owner.revoke(rig.ws, link["id"]), {200, 204}, "revoke")
    res = guest.read(link["id"], cookie, f"/questions/{stored['id']}/related-sources")
    assert res.status_code in {401, 403, 404}
    assert ANSWER not in res.text


# ---------------------------------------------------------------------------------------------
# C02 scope and ranking
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c02_book_revisions_only_sources_first_answer_query_dedup_and_limit(
    seed: Any,
) -> None:
    rig = Rig(seed, "c02")
    paper_doc = paper(rig.owner, rig.ws)
    paper_block = prefix_block(rig.owner, paper_doc, paper_stem(2), PAPER_ONLY)
    mixed_doc = paper(rig.owner, rig.ws, "book")
    rig.owner.ok("PATCH", f"/documents/{mixed_doc}", {"kind": "mixed", "extract": False})
    mixed_block = prefix_block(rig.owner, mixed_doc, paper_stem(1), MIXED_ONLY)

    q = rig.question("c02", wrong=(WRONG_ONLY, "바람 규칙", "구름 이론"))
    listed = first_read(rig.owner, q)
    items = listed["items"]
    assert 1 <= len(items) <= LIMIT
    assert [i["rank"] for i in items] == list(range(1, len(items) + 1))
    # The question's own source block first, flagged; then search hits.
    assert items[0]["block_id"] == rig.block["ch1-s1-p1"]
    assert items[0]["from_question_source"]
    assert [i["from_question_source"] for i in items[1:]] == [False] * (len(items) - 1)
    # One row per block and per page: the second p.2 block is dropped.
    assert len({i["block_id"] for i in items}) == len(items)
    assert len({(i["document_id"], i["page_start"]) for i in items}) == len(items)
    assert rig.block["ch1-s1-p2"] not in {i["block_id"] for i in items}
    # The query is stem + correct answer: the wrong option's passage is not retrieved.
    assert rig.block["ch2-s2-p1"] not in {i["block_id"] for i in items}
    assert any(i["block_id"] == rig.block["ch2-s1-p1"] for i in items)
    # Books only: no question paper, no mixed question segment.
    for answer, block, doc in (
        (PAPER_ONLY, paper_block, paper_doc),
        (MIXED_ONLY, mixed_block, mixed_doc),
    ):
        other = first_read(rig.owner, rig.question(f"c02-{block[:6]}", answer=answer))
        assert block not in {i["block_id"] for i in other["items"]}
        assert answer not in "\n".join(i["excerpt"] for i in other["items"])
        if doc == paper_doc:
            assert paper_doc not in {i["document_id"] for i in other["items"]}
    # Excerpts are at most 300 characters; highlights point into them.
    for i in items:
        assert len(i["excerpt"]) <= 300
        for h in i.get("highlights", []):
            assert 0 <= h["start"] < h["end"] <= len(i["excerpt"])

    # An imported question-PDF source is not a 문제 출처 row; only the book block is.
    run = rig.owner.ok("GET", f"/workspaces/{rig.ws}/question-imports")["items"][0]
    with_import = rig.question("c02-import")
    page1 = [b["block_id"] for b in blocks(rig.owner, paper_doc) if b["page"] == 1][:1]
    add_imported_source(with_import["id"], paper_doc, run["id"], 1, page1)
    imported = first_read(rig.owner, with_import)
    sourced = [i["block_id"] for i in imported["items"] if i["from_question_source"]]
    assert sourced == [rig.block["ch1-s1-p1"]]
    assert paper_doc not in {i["document_id"] for i in imported["items"]}


def test_relsrc_01_c02_a_merged_keeper_uses_only_its_own_sources(seed: Any) -> None:
    rig = Rig(seed, "c02-merge")
    stem = "RELSRC c02-merge: 물 분자가 수증기가 되는 과정을 설명하는 개념은?"
    keep = rig.question("keep", stem=stem)
    dup = rig.question("dup", stem=stem, source="ch2-s1-p1")
    merged = rig.owner.ok(
        "POST",
        f"/workspaces/{rig.ws}/question-duplicates/merge",
        {"groups": [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}]},
    )
    assert merged["groups"][0]["archived_question_ids"] == [dup["id"]]
    kept = first_read(rig.owner, keep)
    assert [i["block_id"] for i in kept["items"] if i["from_question_source"]] == [
        rig.block["ch1-s1-p1"]
    ]
    # The archived duplicate keeps its own list (its own source first).
    own = ok(read(rig.owner, dup["id"], view="detail"))
    assert own["items"][0]["block_id"] == rig.block["ch2-s1-p1"]
    assert own["id"] != kept["id"]


# ---------------------------------------------------------------------------------------------
# C03 key and invalidation
# ---------------------------------------------------------------------------------------------


def _reindex(worker: Any, ws: str) -> None:
    from quiz_worker import reindex
    from quiz_worker.settings import Environment, WorkerSettings

    base = WorkerSettings(_env_file=str(REPO_ROOT / ".env"))  # type: ignore[call-arg]
    settings = base.model_copy(
        update={
            "app_env": Environment.TEST,
            "qdrant_url": base.qdrant_url or "http://127.0.0.1:6333",
            "qdrant_collection_prefix": worker._names.prefix,
        }
    )
    code = reindex.main(["--workspace", ws], settings=settings, out=io.StringIO())
    assert code == 0


def test_relsrc_01_c03_fingerprint_key_supersedes_and_stores_references_only(
    seed: Any, job_worker: Any
) -> None:
    rig = Rig(seed, "c03")
    q = rig.question("c03")
    rev = q["revision"]["id"]
    first = first_read(rig.owner, q)
    assert ok(read(rig.owner, q["id"], view="detail"))["id"] == first["id"]
    assert calls(rev) == 1

    # Reindexing the same revision keeps the key.
    _reindex(job_worker, rig.ws)
    assert ok(read(rig.owner, q["id"], view="detail"))["id"] == first["id"]
    assert calls(rev) == 1

    seen = [first["id"]]

    def changed(what: str) -> None:
        now = ok(read(rig.owner, q["id"], view="detail"))
        assert now["id"] not in seen, f"{what} must change the corpus fingerprint"
        seen.append(now["id"])

    # A correction publish, a restore (published), a new book, a deleted book: new keys.
    publish(rig.owner, rig.doc, {rig.block["ch2-s1-p1"]: APPLIED_REMOVED})
    changed("a correction publish")
    assert APPLIED not in "\n".join(
        i["excerpt"] for i in ok(read(rig.owner, q["id"], view="detail"))["items"]
    )
    history = rig.owner.ok("GET", f"/documents/{rig.doc}/revisions")["items"]
    rig.owner.ok(
        "POST", f"/documents/{rig.doc}/revisions/{rig.revision}/restore", {}, (200, 201, 202)
    )
    accepted = rig.owner.ok("POST", f"/documents/{rig.doc}/publish", {}, (202,))
    rig.owner.wait_for_job(str(accepted["job_id"]))
    assert len(rig.owner.ok("GET", f"/documents/{rig.doc}/revisions")["items"]) > len(history)
    changed("a restored revision")
    extra = upload(rig.owner, rig.ws, BOOK_EN, "book")
    changed("an added book")
    rig.owner.ok("DELETE", f"/documents/{extra}", None, (200, 202, 204))
    changed("a deleted book")
    # A question edit: a new question revision, a new key.
    edited = rig.owner.ok(
        "PATCH",
        f"/questions/{q['id']}",
        {"base_revision_id": rev, "stem": "RELSRC c03 수정: 수증기가 되는 과정의 개념은?"},
    )
    after_edit = ok(read(rig.owner, q["id"], view="detail"))
    assert after_edit["question_revision_id"] == edited["revision"]["id"]
    assert after_edit["id"] not in seen
    seen.append(after_edit["id"])

    # Old keys stay as superseded rows; the current one is not superseded.
    stored = rows(q["id"])
    assert [r[0] for r in stored] == seen
    assert [r[2] for r in stored] == [True] * (len(seen) - 1) + [False]
    # References only: no passage text, stem or answer in the stored rows.
    [(dump,)] = _admin(
        "select coalesce(json_agg(row_to_json(s))::text, '') "
        "from public.question_related_sources s where s.id = any(%s::uuid[])",
        (seen,),
    )
    for text in (*TEXT.values(), q["revision"]["stem"]):
        assert text not in dump
    # The unique key (question_revision_id, corpus_fingerprint, retrieval_version).
    indexes = [
        str(r[0])
        for r in _admin(
            "select indexdef from pg_indexes where schemaname = 'public' "
            "and tablename = 'question_related_sources'"
        )
    ]
    assert any(
        "UNIQUE" in d
        and "question_revision_id" in d
        and "corpus_fingerprint" in d
        and "retrieval_version" in d
        for d in indexes
    ), indexes
    # The embedder switch (a new collection with another model) is pinned by RELSRC-B's
    # packages/core unit test of the fingerprint (model name is one of its inputs).


# ---------------------------------------------------------------------------------------------
# C04 concurrency
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c04_twenty_concurrent_first_reads_compute_once(seed: Any) -> None:
    rig = Rig(seed, "c04")
    hold = Hold()
    try:
        q = rig.question("c04", markers=(hold.marker,))
        with ThreadPoolExecutor(max_workers=20) as pool:
            futures = [pool.submit(read, rig.owner, q["id"], view="detail") for _ in range(20)]
            hold.held(futures)
            time.sleep(0.5)  # let every request queue on the advisory lock
            hold.release()
            results = [f.result(timeout=60) for f in futures]
        bodies = [ok(r) for r in results]
        assert {b["id"] for b in bodies} == {bodies[0]["id"]}
        assert all(b["items"] == bodies[0]["items"] for b in bodies)
        assert calls(q["revision"]["id"]) == 1
        assert len(rows(q["id"])) == 1
    finally:
        hold.release()
        hold.cleanup()


# ---------------------------------------------------------------------------------------------
# C05 not stored: archived, degraded, guests; outage
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c05_archived_degraded_and_outage_store_nothing(seed: Any) -> None:
    rig = Rig(seed, "c05")
    degraded = rig.question("c05-dense", markers=(DENSE_MARKER,))
    failing = rig.question("c05-fail", markers=(FAIL_MARKER,))
    archived_q = rig.question("c05-archived")
    earlier = submit(rig.owner, archived_q)

    # Degraded search: BM25 rows, flagged, not stored.
    weak = first_read(rig.owner, degraded)
    assert weak["degraded"] == ["dense_unavailable"]
    assert weak["stored"] is False
    assert weak["id"] is None
    assert weak["items"]
    assert rows(degraded["id"]) == []
    # Outage (R6): 503 related-unavailable, no row; the next computation succeeds.
    sid = submit(rig.owner, failing)
    refused(read(rig.owner, failing["id"], practice_session_id=sid), 503, UNAVAILABLE)
    assert rows(failing["id"]) == []
    assert ok(read(rig.owner, failing["id"], practice_session_id=sid))["stored"] is True
    (FAULT_DIR / f"{failing['revision']['id']}.failed").unlink(missing_ok=True)

    # Archived workspace: computed and shown, never written.
    rig.owner.ok("POST", f"/workspaces/{rig.ws}/archive", None, (200,))
    before = calls(archived_q["revision"]["id"])
    shown = ok(read(rig.owner, archived_q["id"], practice_session_id=earlier))
    assert shown["items"]
    assert shown["stored"] is False
    assert shown["id"] is None
    assert calls(archived_q["revision"]["id"]) == before + 1
    assert rows(archived_q["id"]) == []


# ---------------------------------------------------------------------------------------------
# C06 no leaks, no side effects, forks copy nothing
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c06_no_text_in_logs_and_practice_and_study_state_unchanged(
    seed: Any, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(seed, "c06")
    q = rig.question("c06")
    member = rig.member("c06-viewer")
    sid = session(member, q["id"])
    opened = member.ok("GET", f"/practice-sessions/{sid}")
    assert not {k for k in keys(opened) if "related" in k}
    graded = member.ok(
        "POST",
        f"/practice-sessions/{sid}/submit",
        {"selected_option_ids": q["revision"]["correct_option_ids"]},
    )
    assert not {k for k in keys(graded) if "related" in k}
    state = _admin(
        "select row_to_json(s)::text from public.question_user_states s "
        "where s.question_id = %s and s.user_id = %s",
        (q["id"], member.user.id),
    )
    attempts = _admin(
        "select count(*) from public.question_attempts where question_id = %s", (q["id"],)
    )
    sessions = _admin(
        "select count(*) from public.practice_sessions where question_id = %s", (q["id"],)
    )

    with caplog.at_level(logging.DEBUG):
        listed = ok(read(member, q["id"], practice_session_id=sid))
        ok(read(member, q["id"], view="detail"))
    logged = "\n".join(f"{r.getMessage()} {r.args!r} {r.__dict__!r}" for r in caplog.records)
    for text in (
        q["revision"]["stem"],
        ANSWER,
        *TEXT.values(),
        *(i["excerpt"] for i in listed["items"]),
    ):
        assert text not in logged, "related-sources logs carry no stem, answer or passage text"

    assert (
        _admin(
            "select row_to_json(s)::text from public.question_user_states s "
            "where s.question_id = %s and s.user_id = %s",
            (q["id"], member.user.id),
        )
        == state
    )
    assert (
        _admin("select count(*) from public.question_attempts where question_id = %s", (q["id"],))
        == attempts
    )
    assert (
        _admin("select count(*) from public.practice_sessions where question_id = %s", (q["id"],))
        == sessions
    )


def test_relsrc_01_c06_a_fork_copies_no_related_rows(seed: Any) -> None:
    rig = Rig(seed, "c06-fork")
    q = rig.question("c06-fork")
    first_read(rig.owner, q)
    assert len(rows(q["id"])) == 1
    link = rig.owner.create_link(rig.ws, allow_fork=True)
    recipient = seed.client("relsrc-c06-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, "관련 본문 fork")
    seed.assert_status(res, 202, "fork start")
    fork = recipient.wait_fork(res.json()["id"], "COMPLETED")
    seed.worker.join()
    target = str(fork["target_workspace_id"])
    _require("question_related_sources")
    [(copied,)] = _admin(
        "select count(*) from public.question_related_sources s join public.question_revisions r "
        "on r.id = s.question_revision_id join public.questions q on q.id = r.question_id "
        "where q.workspace_id = %s",
        (target,),
    )
    assert copied == 0


# ---------------------------------------------------------------------------------------------
# C07 mock exam questions
# ---------------------------------------------------------------------------------------------


def test_relsrc_01_c07_mock_questions_proof_evidence_own_table_and_concurrency(
    seed: Any,
) -> None:
    rig = Rig(seed, "c07")
    hold = Hold()
    try:
        paper_doc = paper(rig.owner, rig.ws)
        run = rig.owner.ok("GET", f"/workspaces/{rig.ws}/question-imports")["items"][0]
        q = rig.question("c07")
        page1 = [b["block_id"] for b in blocks(rig.owner, paper_doc) if b["page"] == 1][:1]
        add_imported_source(q["id"], paper_doc, run["id"], 1, page1)
        held_q = rig.question("c07-hold", markers=(hold.marker,))
        exam_id, mqs = shuffle_exam(rig.owner, rig.ws, [q["id"], held_q["id"]])
        mq = next(m for m in mqs if m["source"]["question_id"] == q["id"])
        mq_held = next(m for m in mqs if m["source"]["question_id"] == held_q["id"])
        # `evidence.quote` is never used: stamp one the passage list must not show (an AI variation
        # stores quotes; `보기 섞기` copies none, so the superuser writes it past the append-only
        # trigger — state no shuffle path produces, fixtures/db.ts use 4).
        stamp_quote(mq["revision"]["id"], "E2E-RELSRC-QUOTE-UNUSED")
        member = rig.member("c07-viewer")
        other = rig.member("c07-other")
        stranger = seed.client("relsrc-c07-stranger")

        # Proof: an open session or none → 409; another user's session, a stranger → 404.
        s = member.ok("POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,))
        refused(read_mock(member, mq["id"], mock_practice_session_id=s["id"]), 409, BEFORE_SUBMIT)
        refused(read_mock(member, mq["id"]), 409, BEFORE_SUBMIT)
        other_session = mock_submit(other, mq)
        refused(read_mock(member, mq["id"], mock_practice_session_id=other_session), 404)
        # The caller's own submitted session of ANOTHER mock question: 404, nothing computed.
        own_elsewhere = mock_submit(member, mq_held)
        refused(read_mock(member, mq["id"], mock_practice_session_id=own_elsewhere), 404)
        assert calls(mq_held["revision"]["id"]) == 0
        assert mock_rows(mq_held["id"]) == []
        refused(read_mock(stranger, mq["id"], view="manage"), 404)
        viewer_manage = read_mock(member, mq["id"], view="manage")
        assert viewer_manage.status_code in {403, 404, 409}, "view: manage needs the edit right"
        assert calls(mq["revision"]["id"]) == 0
        assert mock_rows(mq["id"]) == []

        # Submitted: evidence book blocks first, no imported PDF, no quote text, own table.
        member.ok(
            "POST",
            f"/mock-practice-sessions/{s['id']}/submit",
            {"selected_option_ids": mq["correct_option_ids"]},
        )
        listed = ok(read_mock(member, mq["id"], mock_practice_session_id=s["id"]))
        assert listed["mock_exam_question_revision_id"] == mq["revision"]["id"]
        assert listed["items"][0]["block_id"] == rig.block["ch1-s1-p1"]
        assert listed["items"][0]["from_question_source"] is True
        assert paper_doc not in {i["document_id"] for i in listed["items"]}
        assert "E2E-RELSRC-QUOTE-UNUSED" not in json.dumps(listed, ensure_ascii=False)
        assert calls(mq["revision"]["id"]) == 1
        assert [r[0] for r in mock_rows(mq["id"])] == [listed["id"]]
        registered = first_read(rig.owner, q)
        assert registered["id"] != listed["id"], "mock lists are not the registered question's"
        # Editors read it without a submission (view: manage, ASK-SYNC (a)).
        assert ok(read_mock(rig.owner, mq["id"], view="manage"))["id"] == listed["id"]
        assert calls(mq["revision"]["id"]) == 1

        # Concurrent first reads of another mock question compute once.
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = [
                pool.submit(read_mock, rig.owner, mq_held["id"], view="manage") for _ in range(5)
            ]
            hold.held(futures)
            time.sleep(0.3)
            hold.release()
            bodies = [ok(f.result(timeout=60)) for f in futures]
        assert {b["id"] for b in bodies} == {bodies[0]["id"]}
        assert calls(mq_held["revision"]["id"]) == 1

        # A book publish changes the key; the old row is superseded.
        publish(rig.owner, rig.doc, {rig.block["ch2-s1-p1"]: APPLIED_REMOVED})
        fresh = ok(read_mock(rig.owner, mq["id"], view="manage"))
        assert fresh["id"] != listed["id"]
        assert [(r[0], r[2]) for r in mock_rows(mq["id"])] == [
            (listed["id"], True),
            (fresh["id"], False),
        ]
        # No shared API for mock exam questions.
        link = rig.owner.create_link(rig.ws)
        guest = seed.guest()
        cookie = guest.session(link["id"], link["secret"])
        res = guest.read(link["id"], cookie, f"/mock-exam-questions/{mq['id']}/related-sources")
        assert res.status_code == 404

        # A removed question and a deleted mock exam: 404, nothing computed.
        rig.owner.ok("DELETE", f"/mock-exam-questions/{mq_held['id']}", None, (200, 204))
        refused(read_mock(rig.owner, mq_held["id"], view="manage"), 404)
        rig.owner.ok("DELETE", f"/mock-exams/{exam_id}", None, (200, 204))
        refused(read_mock(member, mq["id"], mock_practice_session_id=s["id"]), 404)
    finally:
        hold.release()
        hold.cleanup()


def test_relsrc_01_c07_archived_workspace_computes_mock_lists_without_storing(seed: Any) -> None:
    rig = Rig(seed, "c07-archived")
    q = rig.question("c07-archived")
    _, mqs = shuffle_exam(rig.owner, rig.ws, [q["id"]])
    mq = mqs[0]
    sid = mock_submit(rig.owner, mq)
    rig.owner.ok("POST", f"/workspaces/{rig.ws}/archive", None, (200,))
    shown = ok(read_mock(rig.owner, mq["id"], mock_practice_session_id=sid))
    assert shown["items"]
    assert shown["stored"] is False
    assert shown["id"] is None
    assert mock_rows(mq["id"]) == []
    # view: manage needs an active workspace.
    res = read_mock(rig.owner, mq["id"], view="manage")
    assert res.status_code in {403, 409}
