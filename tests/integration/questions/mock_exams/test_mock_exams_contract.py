"""MOCK-01 server guarantees C01-C10 (docs/screens/mock-exams.md, questions.md §11,
architecture.md §5-§6).

Mock exam questions never touch the question bank (C01); the reused approval-blocking validation
is the storage condition, failed items are re-requested once together (C02); the range resolves
to this workspace's live CONFIRMED questions and seeds reproduce the plan (C03); 다시 만들기 is a
new round, history rows are append-only (C04); the authorization matrix and the feature switch
(C05); cost limits and idempotency (C06); no question, explanation, book text, prompt or output in
logs, job results or activities (C07); later source edits, deletes, archives and duplicate merges
leave made questions alone (C08); LLM calls are batched by token budget, re-requested together,
halved on unreadable output, checkpointed per batch and capped in concurrency (C09); each
question names its source chapter in the plan's chapter rank, without answer fields (C10).

Shapes are assumptions K1-K9 in tests/e2e/fixtures/mock-exams.ts; the batched scenario LLM is the
`mock_exam` block of tests/fixtures/llm/generation-scenarios.json. Jobs run in this process
(conftest.py). The append-only guarantees (C04) are checked here as the superuser; MOCK-B adds the
matching pgTAP file under supabase/tests.
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
import psycopg
import pytest

pytestmark = [pytest.mark.infra]

REPO_ROOT = Path(__file__).resolve().parents[4]
BOOK_KO = REPO_ROOT / "tests" / "fixtures" / "pdfs" / "book-ko.pdf"
SCENARIOS = REPO_ROOT / "tests" / "fixtures" / "llm" / "generation-scenarios.json"
MOCK = json.loads(SCENARIOS.read_text(encoding="utf-8"))["mock_exam"]
CH1, CH2 = "1장 물의 순환", "2장 정수 처리"
NORMAL: tuple[str, ...] = ("evaporation", "condensation", "precipitation", "infiltration")
NORMAL += ("flocculation", "disinfection")
INVERSION = ("inv-runoff", "inv-filtration", "inv-multi")
ALL_FAIL = ("fail-quote", "fail-answer")
JOB_TYPE = "mock_exam.generate"
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
P = "urn:quiz-workspace:problem:"
NO_MATCHING = P + "no-matching-questions"
RANGE_INVALID = P + "range-invalid"
RUNNING = P + "mock-generation-running"
BUSY = P + "generation-busy"
LLM_DISABLED = P + "mock-llm-disabled"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
MARKER = re.compile(MOCK["marker_pattern"])
BANK_TABLES = (
    "questions",
    "question_revisions",
    "question_drafts",
    "question_lineage",
    "question_user_states",
    "question_attempts",
)
ALL: dict[str, Any] = {
    "all": True,
    "chapter_ids": [],
    "question_ids": [],
    "excluded_question_ids": [],
    "filters": {},
}


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser reads only where no API exposes the guarantee)
# ---------------------------------------------------------------------------------------------


def upload(client: Any, workspace_id: str) -> str:
    """upload-intent -> PUT -> complete-upload of book-ko.pdf, then drains the parse job."""
    data = BOOK_KO.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": BOOK_KO.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": "book",
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


class Book:
    """A workspace with book-ko.pdf and its two chapter ids."""

    def __init__(self, client: Any, workspace_id: str | None = None) -> None:
        self.client = client
        self.ws: str = workspace_id or client.create_workspace()["id"]
        self.doc = upload(client, self.ws)
        items = client.ok("GET", f"/documents/{self.doc}/outline")["items"]
        by_title = {str(n["title"]).strip(): str(n["id"]) for n in items}
        self.ch1, self.ch2 = by_title[CH1], by_title[CH2]
        self._n = 0

    def chapter(self, number: int | None) -> str | None:
        return {1: self.ch1, 2: self.ch2}.get(number) if number else None

    def _create(self, body: dict[str, Any]) -> dict[str, Any]:
        self._n += 1
        out: dict[str, Any] = self.client.ok(
            "POST",
            f"/workspaces/{self.ws}/questions",
            {**body, "question_number": self._n},
            (201,),
        )
        return out

    def source(self, key: str, chapter: int | str | None = "scenario") -> dict[str, Any]:
        """CONFIRMED question of scenario source `key` (stem ends with its marker, K5)."""
        s = MOCK["sources"][key]
        number = s["chapter"] if isinstance(chapter, str) else chapter
        return self._create(
            {
                "question_type": "MCQ",
                "stem": f"{s['stem']} [{s['marker']}]",
                "options": s["options"],
                "correct_option_ids": s["correct_option_ids"],
                "is_multi_answer": s["is_multi_answer"],
                "explanation": s["explanation"],
                "chapter_id": self.chapter(number),
                "sources": [self._page(s["source_page"])],
            }
        )

    def sources(self, keys: tuple[str, ...]) -> list[dict[str, Any]]:
        return [self.source(k) for k in keys]

    def bulk(self, numbers: range, template: str = "bulk", tail: str = "") -> list[dict[str, Any]]:
        """Template sources (K5): E2E-MOCK-BULK-<nnn> in chapter 1 (crash: chapter 2)."""
        t = MOCK["templates"][template]
        out = []
        for n in numbers:
            nnn = f"{n:03d}"
            marker = f"E2E-MOCK-BULK-{nnn}" if template == "bulk" else tail
            fill = json.loads(json.dumps(t).replace("{n}", nnn))
            out.append(
                self._create(
                    {
                        "question_type": "MCQ",
                        "stem": f"{fill['stem']} [{marker}]",
                        "options": fill["options"],
                        "correct_option_ids": fill["correct_option_ids"],
                        "is_multi_answer": fill["is_multi_answer"],
                        "explanation": fill["explanation"],
                        "chapter_id": self.chapter(t["chapter"]),
                        "sources": [self._page(t["source_page"])],
                    }
                )
            )
        return out

    def _page(self, page: int) -> dict[str, Any]:
        return {"document_id": self.doc, "page_start": page, "page_end": page}


def config(types: tuple[str, ...], count: int | None) -> dict[str, Any]:
    return {"variation_types": list(types), "question_count": count, "difficulty": None}


def chapters(*ids: str) -> dict[str, Any]:
    return {**ALL, "all": False, "chapter_ids": list(ids)}


def picked(*ids: str) -> dict[str, Any]:
    return {**ALL, "all": False, "question_ids": list(ids)}


def post_exam(
    client: Any,
    ws: str,
    cfg: dict[str, Any],
    rng: dict[str, Any] = ALL,
    *,
    title: str | None = None,
    key: str | None = None,
    seed_value: int | None = None,
    http: Any = None,
) -> httpx.Response:
    body: dict[str, Any] = {"title": title or f"모의고사 {uuid.uuid4().hex[:6]}", "config": cfg}
    body["range"] = rng
    if seed_value is not None:
        body["seed"] = seed_value
    headers = {"Idempotency-Key": key} if key else {}
    if http is not None:
        res: httpx.Response = http.request(
            "POST",
            f"/api/v1/workspaces/{ws}/mock-exams",
            json=body,
            headers={"Authorization": f"Bearer {client.user.token}", **headers},
        )
        return res
    out: httpx.Response = client.send("POST", f"/workspaces/{ws}/mock-exams", body, headers=headers)
    return out


def start(client: Any, ws: str, cfg: dict[str, Any], rng: dict[str, Any] = ALL, **kw: Any) -> Any:
    out: dict[str, Any] = client.ok_response(
        post_exam(client, ws, cfg, rng, **kw), "POST", "mock exam", (202,)
    )
    assert out["latest_generation"]["status"] in {"queued", "running"}
    return out


def exam(client: Any, exam_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/mock-exams/{exam_id}")
    return out


def finish(
    client: Any, body: dict[str, Any], expected: str = "succeeded", worker: Any = None
) -> dict[str, Any]:
    """Drains the newest generation's job (K1 `latest_generation.job_id`); returns the exam."""
    gen = body["latest_generation"]
    (worker or client.worker).drain(str(gen["job_id"]))
    after = exam(client, body["id"])
    assert after["latest_generation"]["id"] == gen["id"]
    assert after["latest_generation"]["status"] == expected, after["latest_generation"]
    return after


def make(client: Any, ws: str, cfg: dict[str, Any], rng: dict[str, Any] = ALL, **kw: Any) -> Any:
    expected = kw.pop("expected", "succeeded")
    return finish(client, start(client, ws, cfg, rng, **kw), expected)


def regenerate(client: Any, exam_id: str, body: dict[str, Any] | None = None, **kw: Any) -> Any:
    headers = {"Idempotency-Key": kw["key"]} if kw.get("key") else {}
    res: httpx.Response = client.send(
        "POST", f"/mock-exams/{exam_id}/generations", body or {}, headers=headers
    )
    return res


def questions(client: Any, exam_id: str, answers: bool = False) -> list[dict[str, Any]]:
    suffix = "?include=answers" if answers else ""
    items: list[dict[str, Any]] = client.ok("GET", f"/mock-exams/{exam_id}/questions{suffix}")[
        "items"
    ]
    return sorted(items, key=lambda q: int(q["position"]))


def practise(client: Any, question: dict[str, Any]) -> dict[str, Any]:
    """MOCK-P: open and answer a mock exam question with its correct options."""
    session = client.ok(
        "POST", f"/mock-exam-questions/{question['id']}/practice-sessions", {}, (201,)
    )
    assert not ANSWER_KEYS & set(session), "a practice session leaks answers"
    out: dict[str, Any] = client.ok(
        "POST",
        f"/mock-practice-sessions/{session['id']}/submit",
        {"selected_option_ids": question["correct_option_ids"]},
    )
    return out


def member(seed: Any, workspace_id: str, label: str, role: str) -> Any:
    client = seed.client(label)
    seed.membership(workspace_id, client.user, role)
    return client


def answer_keys(value: Any, path: str = "$") -> list[str]:
    if isinstance(value, list):
        return [k for i, v in enumerate(value) for k in answer_keys(v, f"{path}[{i}]")]
    if not isinstance(value, dict):
        return []
    found = [f"{path}.{k}" for k in value if k in ANSWER_KEYS]
    return found + [k for key, v in value.items() for k in answer_keys(v, f"{path}.{key}")]


def markers(prompt: str) -> set[str]:
    return set(MARKER.findall(prompt))


def item_stems(*keys: str) -> set[str]:
    return {i["stem"] for k in keys for i in MOCK["sources"][k]["items"].values()}


def bank_snapshot(db: Any, ws: str) -> dict[str, tuple[Any, ...]]:
    """Row count and newest write per bank table of the workspace (C01)."""
    out: dict[str, tuple[Any, ...]] = {}
    for table in BANK_TABLES:
        cols = {
            r[0]
            for r in db(
                "select column_name from information_schema.columns "
                "where table_schema = 'public' and table_name = %s",
                (table,),
            )
        }
        stamps = [c for c in ("updated_at", "created_at", "submitted_at", "graded_at") if c in cols]
        newest = ", ".join(f"max({c})" for c in stamps) or "null"
        [row] = db(
            f"select count(*), {newest} from public.{table} where workspace_id = %s",  # noqa: S608
            (ws,),
        )
        out[table] = row
    return out


# ---------------------------------------------------------------------------------------------
# C01 bank isolation
# ---------------------------------------------------------------------------------------------


def test_mock_01_c01_making_editing_and_practising_never_touch_the_bank(
    seed: Any, db: Any, app_client: Any, job_worker: Any
) -> None:
    owner = seed.client("mock-c01")
    book = Book(owner)
    sources = book.sources(NORMAL)
    owner.ok("PATCH", f"/questions/{sources[0]['id']}/my-state", {"is_favorite": True})
    session = owner.ok("POST", f"/questions/{sources[1]['id']}/practice-sessions", {}, (201,))
    owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": sources[1]["revision"]["correct_option_ids"]},
    )
    before = bank_snapshot(db, book.ws)
    for table in ("questions", "question_revisions", "question_user_states", "question_attempts"):
        assert before[table][0] >= 1, f"{table} has rows to compare"
    overview = owner.ok("GET", f"/workspaces/{book.ws}/questions/overview")
    note_count = owner.ok("GET", f"/chapters/{book.ch1}/note")["confirmed_question_count"]

    made = make(owner, book.ws, config(("PARAPHRASE", "INVERT_POLARITY"), 4))
    items = questions(owner, made["id"], answers=True)
    assert len(items) == 4
    first, second = items[0], items[1]
    owner.ok(
        "PATCH",
        f"/mock-exam-questions/{first['id']}",
        {"base_revision_id": first["revision"]["id"], "stem": f"{first['stem']} (편집)"},
    )
    assert owner.call("DELETE", f"/mock-exam-questions/{second['id']}").status_code == 204
    practise(owner, items[2])

    assert bank_snapshot(db, book.ws) == before, "a bank table changed"
    assert owner.ok("GET", f"/workspaces/{book.ws}/questions/overview") == overview
    after = owner.ok("GET", f"/chapters/{book.ch1}/note")["confirmed_question_count"]
    assert after == note_count, "mock exam questions are no chapter note input"
    mock_ids = {q["id"] for q in items}
    listed = {q["id"] for q in owner.list_questions(book.ws)}
    assert not mock_ids & listed

    # No search index point carries a mock exam question.
    qdrant = job_worker._qdrant
    stems = {q["stem"] for q in items}
    scanned = 0
    for collection in qdrant.get_collections().collections:
        if not collection.name.startswith(job_worker._names.prefix):
            continue
        points, _ = qdrant.scroll(collection.name, limit=10_000, with_payload=True)
        scanned += len(points)
        dumped = json.dumps([p.payload for p in points], ensure_ascii=False)
        assert not [i for i in mock_ids if i in dumped], collection.name
        assert not [s for s in stems if s in dumped], collection.name
    assert scanned >= 1, "the book's index points were read"

    # A fork copies the bank, never the mock exams.
    recipient = seed.client("mock-c01-recipient")
    link = owner.create_link(book.ws, allow_fork=True)
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, f"mock fork {uuid.uuid4().hex[:6]}")
    seed.assert_status(res, 202, "fork")
    target = str(recipient.wait_fork(str(res.json()["id"]), "COMPLETED")["target_workspace_id"])
    assert recipient.ok("GET", f"/workspaces/{target}/mock-exams")["items"] == []
    assert db("select count(*) from public.mock_exams where workspace_id = %s", (target,)) == [(0,)]

    # No route registers a mock exam question into the bank.
    paths = app_client.app.openapi()["paths"]
    mock_question_paths = [p for p in paths if "mock-exam-questions" in p]
    assert mock_question_paths, "the mock exam question routes exist"
    assert not [p for p in mock_question_paths if re.search(r"publish|register|approve|bank", p)]
    for suffix in ("publish", "register", "approve"):
        status = owner.call("POST", f"/mock-exam-questions/{first['id']}/{suffix}", {}).status_code
        assert status in {404, 405}, suffix


# ---------------------------------------------------------------------------------------------
# C02 validation is the storage condition
# ---------------------------------------------------------------------------------------------


def test_mock_01_c02_only_items_passing_validation_are_stored_failures_retried_once(
    seed: Any, db: Any, llm_calls: Any, job_worker: Any
) -> None:
    owner = seed.client("mock-c02")
    book = Book(owner)
    inv = book.sources(INVERSION)
    fail = book.sources(ALL_FAIL)
    seen = len(llm_calls(job_worker))

    partial = make(
        owner,
        book.ws,
        config(("INVERT_POLARITY",), 3),
        picked(*[q["id"] for q in inv]),
        expected="partial",
    )
    gen = partial["latest_generation"]
    assert (gen["created_count"], gen["skipped_count"]) == (2, 1)
    stored = questions(owner, partial["id"], answers=True)
    assert {q["stem"] for q in stored} == item_stems("inv-runoff", "inv-filtration")
    multi = item_stems("inv-multi")
    rows = db(
        "select r.stem from public.mock_exam_question_revisions r "
        "join public.mock_exam_questions q on q.id = r.mock_exam_question_id "
        "where q.mock_exam_id = %s",
        (partial["id"],),
    )
    assert len(rows) == 2, "the two valid items are stored"
    assert not [r for (r,) in rows if r in multi], "the blocked item was stored"
    # The declared answer is used only after validation: label 4 = the false statement.
    for q in stored:
        texts = {o["id"]: o["text"] for o in q["options"]}
        [answer] = q["correct_option_ids"]
        scripted = next(
            i
            for k in ("inv-runoff", "inv-filtration")
            for i in MOCK["sources"][k]["items"].values()
            if i["stem"] == q["stem"]
        )
        assert texts[answer] == scripted["options"][3]["text"]
    prompts = llm_calls(job_worker)[seen:]
    assert len(prompts) == 2, "one batch + one re-request of the failed item"
    assert markers(prompts[1]) == {MOCK["sources"]["inv-multi"]["marker"]}

    failed = make(
        owner,
        book.ws,
        config(("PARAPHRASE",), 2),
        picked(*[q["id"] for q in fail]),
        expected="failed",
    )
    gen = failed["latest_generation"]
    assert gen["error_code"] == "no_valid_questions"
    assert (gen["created_count"], gen["skipped_count"]) == (0, 2)
    assert failed["current_generation"] is None
    assert questions(owner, failed["id"]) == []


# ---------------------------------------------------------------------------------------------
# C03 range resolution and seeded plan
# ---------------------------------------------------------------------------------------------


def test_mock_01_c03_the_range_is_this_workspaces_live_confirmed_questions_and_seeds_reproduce(
    seed: Any, db: Any
) -> None:
    owner = seed.client("mock-c03")
    other = seed.client("mock-c03-other")
    book = Book(owner)
    sources = book.sources(NORMAL)
    foreign_ws = other.create_workspace()["id"]
    foreign = other.create_question(foreign_ws, "다른 Workspace 문제")
    draft = owner.ok(
        "POST",
        f"/workspaces/{book.ws}/questions",
        {
            "question_type": "MCQ",
            "stem": "초안 문제",
            "options": [{"id": "opt-1", "text": "가"}, {"id": "opt-2", "text": "나"}],
            "correct_option_ids": ["opt-1"],
            "publication_status": "DRAFT",
        },
        (201,),
    )
    archived = book.source("evaporation", chapter=None)
    owner.ok(
        "PATCH",
        f"/questions/{archived['id']}",
        {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    shuffle = config(("OPTION_SHUFFLE",), 1)
    for bad in (foreign["id"], draft["id"], archived["id"], RANDOM_ID):
        seed.problem(post_exam(owner, book.ws, shuffle, picked(bad)), 422, RANGE_INVALID)
    empty = owner.create_workspace()["id"]
    seed.problem(post_exam(owner, empty, shuffle), 409, NO_MATCHING)
    assert db("select count(*) from public.mock_exams where workspace_id = %s", (empty,)) == [(0,)]

    # Same seed + same candidates -> same sources and variation types; the plan pins revisions.
    cfg = config(("PARAPHRASE", "INVERT_POLARITY"), 3)
    a = make(owner, book.ws, cfg, seed_value=4711)
    b = make(owner, book.ws, cfg, seed_value=4711)
    plan_a = [(q["source"]["question_id"], q["variation_type"]) for q in questions(owner, a["id"])]
    plan_b = [(q["source"]["question_id"], q["variation_type"]) for q in questions(owner, b["id"])]
    assert plan_a == plan_b
    assert len({sid for sid, _ in plan_a}) == 3
    assert {sid for sid, _ in plan_a} <= {q["id"] for q in sources}
    [(plan,)] = db(
        "select plan from public.mock_exam_generations where id = %s",
        (a["latest_generation"]["id"],),
    )
    assert len(plan) == 3
    revisions = {q["id"]: q["revision"]["id"] for q in sources}
    assert {str(p["question_revision_id"]) for p in plan} == {
        revisions[str(p["question_id"])] for p in plan
    }

    # A client-supplied workspace id is ignored.
    res = owner.send(
        "POST",
        f"/workspaces/{book.ws}/mock-exams",
        {"title": "x", "config": shuffle, "range": ALL, "workspace_id": foreign_ws},
    )
    assert res.status_code in {202, 422}
    if res.status_code == 202:
        assert res.json()["workspace_id"] == book.ws


# ---------------------------------------------------------------------------------------------
# C04 rounds and history
# ---------------------------------------------------------------------------------------------


def test_mock_01_c04_remaking_is_a_new_round_and_history_rows_are_append_only(
    seed: Any, db: Any
) -> None:
    owner = seed.client("mock-c04")
    book = Book(owner)
    book.sources(NORMAL)
    down = book.sources(("down-chlorine", "down-raw"))
    first = make(owner, book.ws, config(("OPTION_SHUFFLE",), 2))
    round1 = first["current_generation"]
    assert round1["version"] == 1
    old = questions(owner, first["id"], answers=True)
    attempt = practise(owner, old[0])

    key = str(uuid.uuid4())
    res = regenerate(owner, first["id"], key=key)
    assert res.status_code == 202, res.text[:200]
    queued = res.json()["latest_generation"]
    again = regenerate(owner, first["id"], key=key)
    assert again.status_code == 202
    assert again.json()["latest_generation"]["id"] == queued["id"]
    seed.problem(regenerate(owner, first["id"]), 409, RUNNING)
    second = finish(owner, res.json())
    assert second["current_generation"]["version"] == 2
    new = questions(owner, first["id"])
    assert len(new) == 2
    assert {q["id"] for q in new}.isdisjoint({q["id"] for q in old})
    kept = db(
        "select count(*) from public.mock_exam_questions where generation_id = %s",
        (round1["id"],),
    )
    assert kept == [(2,)], "the earlier round's questions stay"
    assert db(
        "select count(*) from public.mock_exam_attempts where id = %s", (attempt["attempt_id"],)
    ) == [(1,)]

    # A failed round keeps the current one.
    failing = regenerate(
        owner,
        first["id"],
        {"config": config(("PARAPHRASE",), 2), "range": picked(*[q["id"] for q in down])},
    )
    assert failing.status_code == 202, failing.text[:200]
    failed = finish(owner, failing.json(), expected="failed")
    assert failed["latest_generation"]["error_code"] == "llm_unavailable"
    assert failed["current_generation"]["id"] == second["current_generation"]["id"]

    # Edit = new revision, remove = soft, rename/settings = revision rows.
    current = questions(owner, first["id"], answers=True)
    owner.ok(
        "PATCH",
        f"/mock-exam-questions/{current[0]['id']}",
        {"base_revision_id": current[0]["revision"]["id"], "explanation": "고친 해설"},
    )
    assert db(
        "select count(*) from public.mock_exam_question_revisions where mock_exam_question_id = %s",
        (current[0]["id"],),
    ) == [(2,)]
    assert owner.call("DELETE", f"/mock-exam-questions/{current[1]['id']}").status_code == 204
    [(removed_at,)] = db(
        "select removed_at from public.mock_exam_questions where id = %s", (current[1]["id"],)
    )
    assert removed_at is not None
    revisions_before = db(
        "select count(*) from public.mock_exam_revisions where mock_exam_id = %s", (first["id"],)
    )[0][0]
    owner.ok("PATCH", f"/mock-exams/{first['id']}", {"title": "새 이름"})
    after = db(
        "select count(*) from public.mock_exam_revisions where mock_exam_id = %s", (first["id"],)
    )[0][0]
    assert after == revisions_before + 1

    # Append-only (pgTAP in MOCK-B): attempts and revisions refuse UPDATE and DELETE.
    for table, row_id in (
        ("mock_exam_attempts", attempt["attempt_id"]),
        ("mock_exam_question_revisions", current[0]["revision"]["id"]),
    ):
        for sql in (
            f"update public.{table} set created_at = created_at where id = %s",  # noqa: S608
            f"delete from public.{table} where id = %s",  # noqa: S608
        ):
            with pytest.raises(psycopg.Error):
                db(sql, (row_id,))


# ---------------------------------------------------------------------------------------------
# C05 authorization matrix and feature switch
# ---------------------------------------------------------------------------------------------


def test_mock_01_c05_roles_archived_deleted_guests_and_the_feature_switch(
    seed: Any, off_app: Any
) -> None:
    owner = seed.client("mock-c05-owner")
    book = Book(owner)
    book.sources(NORMAL)
    editor = member(seed, book.ws, "mock-c05-editor", "editor")
    viewer = member(seed, book.ws, "mock-c05-viewer", "viewer")
    outsider = seed.client("mock-c05-outsider")
    made = make(editor, book.ws, config(("PARAPHRASE",), 2))
    exam_id = made["id"]
    q = questions(owner, exam_id, answers=True)[0]
    assert {"correct_option_ids", "explanation"} <= set(q)

    for m in (owner, editor, viewer):
        listed = m.ok("GET", f"/workspaces/{book.ws}/mock-exams")
        assert exam_id in {e["id"] for e in listed["items"]}
        assert listed["llm_available"] is True
        m.ok("GET", f"/mock-exams/{exam_id}")
    viewer_items = viewer.ok("GET", f"/mock-exams/{exam_id}/questions")
    assert len(viewer_items["items"]) == 2
    assert answer_keys(viewer_items) == []
    with_answers = viewer.call("GET", f"/mock-exams/{exam_id}/questions?include=answers")
    assert with_answers.status_code in {200, 403}
    if with_answers.status_code == 200:
        assert len(with_answers.json()["items"]) == 2
        assert answer_keys(with_answers.json()) == []

    unknown = seed.problem(outsider.call("GET", f"/mock-exams/{RANDOM_ID}"), 404)
    for method, path in (
        ("GET", f"/mock-exams/{exam_id}"),
        ("GET", f"/mock-exams/{exam_id}/questions"),
        ("PATCH", f"/mock-exams/{exam_id}"),
        ("DELETE", f"/mock-exams/{exam_id}"),
        ("PATCH", f"/mock-exam-questions/{q['id']}"),
    ):
        assert seed.problem(outsider.call(method, path, {"title": "x"}), 404) == unknown, path
    seed.problem(outsider.call("GET", f"/workspaces/{book.ws}/mock-exams"), 404)

    shuffle = config(("OPTION_SHUFFLE",), 1)
    seed.problem(post_exam(viewer, book.ws, shuffle), 403, seed.INSUFFICIENT_ROLE)
    for method, path, body in (
        ("PATCH", f"/mock-exams/{exam_id}", {"title": "x"}),
        ("DELETE", f"/mock-exams/{exam_id}", None),
        ("POST", f"/mock-exams/{exam_id}/generations", {}),
        ("PATCH", f"/mock-exam-questions/{q['id']}", {"base_revision_id": q["revision"]["id"]}),
        ("DELETE", f"/mock-exam-questions/{q['id']}", None),
    ):
        seed.problem(viewer.call(method, path, body), 403, seed.INSUFFICIENT_ROLE)

    # The feature switch: AI types refused, 보기 섞기 still made, the list says so.
    off = off_app.request(
        "GET",
        f"/api/v1/workspaces/{book.ws}/mock-exams",
        headers={"Authorization": f"Bearer {owner.user.token}"},
    )
    assert off.status_code == 200
    assert off.json()["llm_available"] is False
    refused = post_exam(owner, book.ws, config(("PARAPHRASE",), 1), http=off_app)
    seed.problem(refused, 409, LLM_DISABLED)
    allowed = post_exam(owner, book.ws, shuffle, http=off_app)
    assert allowed.status_code == 202, allowed.text[:200]

    # Share guests: no mock exam API at all.
    link = owner.create_link(book.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    assert guest.read(link["id"], cookie, "/mock-exams").status_code == 404
    assert guest.send("GET", f"/mock-exams/{exam_id}", cookie=cookie).status_code in {401, 404}

    # Archived: reads stay, writes 403 workspace-archived.
    owner.ok("POST", f"/workspaces/{book.ws}/archive")
    viewer.ok("GET", f"/mock-exams/{exam_id}")
    seed.problem(post_exam(owner, book.ws, shuffle), 403, seed.ARCHIVED)
    seed.problem(regenerate(editor, exam_id), 403, seed.ARCHIVED)
    seed.problem(owner.call("PATCH", f"/mock-exams/{exam_id}", {"title": "x"}), 403, seed.ARCHIVED)
    seed.problem(owner.call("DELETE", f"/mock-exam-questions/{q['id']}"), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{book.ws}/restore")

    # Deleted mock exam / deleted workspace: 404.
    assert owner.call("DELETE", f"/mock-exams/{exam_id}").status_code == 204
    seed.problem(viewer.call("GET", f"/mock-exams/{exam_id}"), 404)
    assert exam_id not in {
        e["id"] for e in owner.ok("GET", f"/workspaces/{book.ws}/mock-exams")["items"]
    }
    other = make(owner, book.ws, shuffle)
    assert owner.call("DELETE", f"/workspaces/{book.ws}").status_code in {200, 202, 204}
    seed.problem(owner.call("GET", f"/mock-exams/{other['id']}"), 404)


# ---------------------------------------------------------------------------------------------
# C06 limits, rate limit, idempotency
# ---------------------------------------------------------------------------------------------


def test_mock_01_c06_question_count_bounds_running_limit_rate_limit_and_idempotency(
    seed: Any, db: Any
) -> None:
    owner = seed.client("mock-c06")
    book = Book(owner)
    book.sources(NORMAL)
    start(owner, book.ws, config(("OPTION_SHUFFLE",), None))
    for cfg in (
        config(("PARAPHRASE",), 101),
        config(("PARAPHRASE",), 0),
        config(("PARAPHRASE",), None),
        config(("OPTION_SHUFFLE",), 7),  # more than the six in range
        config((), 1),
    ):
        res = post_exam(owner, book.ws, cfg)
        assert res.status_code == 422, (cfg, res.status_code)
    for count in (100, 1):
        res = post_exam(owner, book.ws, config(("PARAPHRASE",), count))
        assert res.status_code == 202, (count, res.text[:200])
    assert post_exam(owner, book.ws, config(("OPTION_SHUFFLE",), 6)).status_code == 202

    # Five queued/running rounds per workspace (different users, so no rate limit applies).
    editors = [member(seed, book.ws, f"mock-c06-editor{i}", "editor") for i in range(2)]
    res = post_exam(editors[0], book.ws, config(("OPTION_SHUFFLE",), 1))
    assert res.status_code == 202
    seed.problem(post_exam(editors[1], book.ws, config(("OPTION_SHUFFLE",), 1)), 409, BUSY)

    # Idempotency-Key: the same mock exam and round, one row.
    fresh = Book(seed.client("mock-c06-idem"))
    fresh.sources(NORMAL[:2])
    key = str(uuid.uuid4())
    one = post_exam(
        fresh.client, fresh.ws, config(("OPTION_SHUFFLE",), 1), title="같은 키", key=key
    )
    two = post_exam(
        fresh.client, fresh.ws, config(("OPTION_SHUFFLE",), 1), title="같은 키", key=key
    )
    assert one.status_code == two.status_code == 202
    assert one.json()["id"] == two.json()["id"]
    assert one.json()["latest_generation"]["id"] == two.json()["latest_generation"]["id"]
    assert db("select count(*) from public.mock_exams where workspace_id = %s", (fresh.ws,)) == [
        (1,)
    ]

    # Per-user starts per minute (default 6): each drained, so only the rate limit can refuse.
    for _ in range(5):
        finish(fresh.client, start(fresh.client, fresh.ws, config(("OPTION_SHUFFLE",), 1)))
    limited = post_exam(fresh.client, fresh.ws, config(("OPTION_SHUFFLE",), 1))
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1


def bulk_confirmed(db: Any, workspace_id: str, n: int, start: int) -> None:
    """`n` CONFIRMED short-answer questions without a chapter, inserted as the superuser (as the
    QVIEW-01-C01 cap test does: 5,000 API calls would take minutes)."""
    db(
        "with q as (insert into public.questions (workspace_id, question_type, "
        "question_number, sort_order) select %s, 'SHORT_ANSWER', g, g "
        "from generate_series(%s::int, %s::int) g returning id, question_number) "
        "insert into public.question_revisions (workspace_id, question_id, version, stem) "
        "select %s, q.id, 1, 'bulk question ' || q.question_number from q",
        (workspace_id, start, start + n - 1, workspace_id),
    )
    db(
        "update public.questions q set active_revision_id = r.id, "
        "publication_status = 'CONFIRMED' from public.question_revisions r "
        "where q.workspace_id = %s and q.active_revision_id is null "
        "and r.question_id = q.id and r.version = 1",
        (workspace_id,),
    )


def test_mock_01_c06_a_whole_range_over_five_thousand_questions_is_refused(
    seed: Any, db: Any
) -> None:
    owner = seed.client("mock-c06-cap")
    ws = owner.create_workspace()["id"]
    owner.create_question(ws, "모의고사 한도 원본")
    whole = config(("OPTION_SHUFFLE",), None)
    made = make(owner, ws, whole)  # the saved range: the whole (then one-question) workspace

    def generations() -> list[tuple[Any, ...]]:
        return db(
            "select count(*) from public.mock_exam_generations where workspace_id = %s", (ws,)
        )

    def exams() -> list[tuple[Any, ...]]:
        return db("select count(*) from public.mock_exams where workspace_id = %s", (ws,))

    bulk_confirmed(db, ws, 5_000, start=2)  # 5,001 confirmed questions
    rounds, saved = generations(), exams()
    for res in (
        post_exam(owner, ws, whole),  # create
        regenerate(owner, made["id"], {"config": whole, "range": ALL}),  # 설정 바꾸기
        regenerate(owner, made["id"]),  # 다시 만들기 of the saved range, grown since
    ):
        assert res.status_code == 422, (res.status_code, res.text[:300])
        assert "5,000" in res.text
    assert generations() == rounds, "a refused start wrote a generation"
    assert exams() == saved, "a refused create wrote a mock exam"
    assert exam(owner, made["id"])["latest_generation"]["id"] == made["latest_generation"]["id"]
    # A count within the cap still samples the large range.
    res = regenerate(owner, made["id"], {"config": config(("OPTION_SHUFFLE",), 5_000)})
    assert res.status_code == 202, res.text[:300]


# ---------------------------------------------------------------------------------------------
# C07 no leaks
# ---------------------------------------------------------------------------------------------


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


def test_mock_01_c07_no_question_explanation_book_or_prompt_text_in_logs_results_or_activities(
    seed: Any, db: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    owner = seed.client("mock-c07")
    book = Book(owner)
    inv = book.sources(INVERSION)
    fail = book.sources(ALL_FAIL)
    partial = make(
        owner,
        book.ws,
        config(("INVERT_POLARITY",), 3),
        picked(*[q["id"] for q in inv]),
        expected="partial",
    )
    failed = make(
        owner,
        book.ws,
        config(("PARAPHRASE",), 2),
        picked(*[q["id"] for q in fail]),
        expected="failed",
    )
    keys = (*INVERSION, *ALL_FAIL)
    forbidden = [
        *[MOCK["sources"][k]["stem"][:24] for k in keys],
        *[str(MOCK["sources"][k]["explanation"])[:24] for k in keys],
        *[s[:24] for s in item_stems(*keys)],
        "포장된 도로가 많은 도시에서는",  # a quote (book text)
        "침전물은 매일 아침",  # the invented quote
        "variation_type:",  # prompt text
    ]
    for body in (partial, failed):
        gen = body["latest_generation"]
        job = owner.ok("GET", f"/jobs/{gen['job_id']}")
        assert job["job_type"] == JOB_TYPE
        dumped = json.dumps(job, ensure_ascii=False)
        assert not [f for f in forbidden if f in dumped], "the job holds question or book text"
        assert all(len(s) <= 64 and "\n" not in s for s in strings(job.get("result"))), job
        assert isinstance(job["result"]["usage"]["llm_calls"], int)
        rows = db(
            "select coalesce(usage::text, ''), coalesce(error_code, '') "
            "from public.mock_exam_generations where id = %s",
            (gen["id"],),
        )
        assert rows
        assert not [f for f in forbidden for row in rows for v in row if f in v]
    events = db(
        "select event_type, metadata::text from public.activity_events "
        "where workspace_id = %s and event_type like 'mock_exam.%%'",
        (book.ws,),
    )
    assert events, "mock_exam.* activities are recorded"
    assert not [f for f in forbidden for _, payload in events if f in payload]
    assert caplog.records, "the generation logged something to check"
    assert not [f for f in forbidden if f in caplog.text], "logs hold question or book text"


# ---------------------------------------------------------------------------------------------
# C08 source edits, deletes, archives, merges
# ---------------------------------------------------------------------------------------------


def test_mock_01_c08_later_source_changes_leave_made_questions_alone(seed: Any, db: Any) -> None:
    owner = seed.client("mock-c08")
    book = Book(owner)
    edited, deleted, archived, kept = book.sources(NORMAL[:4])
    made = make(owner, book.ws, config(("OPTION_SHUFFLE",), 4), chapters(book.ch1))
    before = questions(owner, made["id"], answers=True)
    by_source = {q["source"]["question_id"]: q for q in before}
    practise(owner, by_source[deleted["id"]])

    owner.ok(
        "PATCH",
        f"/questions/{edited['id']}",
        {"base_revision_id": edited["revision"]["id"], "stem": "원본을 고쳤다"},
    )
    assert owner.call("DELETE", f"/questions/{deleted['id']}").status_code == 204
    owner.ok(
        "PATCH",
        f"/questions/{archived['id']}",
        {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    after = questions(owner, made["id"], answers=True)
    assert [(q["id"], q["stem"], q["revision"]["id"]) for q in after] == [
        (q["id"], q["stem"], q["revision"]["id"]) for q in before
    ]
    gone = next(q for q in after if q["id"] == by_source[deleted["id"]]["id"])
    assert gone["source"]["question_id"] is None
    assert gone["source"]["label"] == "원본 삭제됨"
    practise(owner, gone)  # still practisable

    # Remaking resolves the range again: deleted and archived sources drop out.
    res = regenerate(owner, made["id"])
    assert res.status_code == 202, res.text[:200]
    remade = finish(owner, res.json())
    sources = {q["source"]["question_id"] for q in questions(owner, remade["id"])}
    assert sources == {edited["id"], kept["id"]}

    # A duplicate merge archiving the source changes nothing; a picked duplicate drops out
    # without being replaced by the kept question.
    twin = book.source("flocculation", chapter=2)
    original = book.source("flocculation", chapter=2)
    pinned = make(owner, book.ws, config(("OPTION_SHUFFLE",), 1), picked(original["id"]))
    [copy] = questions(owner, pinned["id"], answers=True)
    practise(owner, copy)

    def pinned_attempts() -> list[tuple[Any, ...]]:
        return db(
            "select row_to_json(a)::text from public.mock_exam_attempts a "
            "join public.mock_exam_questions q on q.id = a.mock_exam_question_id "
            "where q.mock_exam_id = %s order by a.id",
            (pinned["id"],),
        )

    attempts = pinned_attempts()
    assert len(attempts) >= 1, "the pinned copy has an attempt to preserve"
    bank_attempts = db(
        "select count(*) from public.question_attempts where question_id = any(%s::uuid[])",
        ([twin["id"], original["id"]],),
    )
    owner.ok(
        "POST",
        f"/workspaces/{book.ws}/question-duplicates/merge",
        {"groups": [{"keep_question_id": twin["id"], "duplicate_question_ids": [original["id"]]}]},
    )
    [same] = questions(owner, pinned["id"], answers=True)
    assert (same["id"], same["revision"]["id"], same["source"]) == (
        copy["id"],
        copy["revision"]["id"],
        copy["source"],
    )
    assert pinned_attempts() == attempts, "the merge moved or changed mock exam attempts"
    assert (
        db(
            "select count(*) from public.question_attempts where question_id = any(%s::uuid[])",
            ([twin["id"], original["id"]],),
        )
        == bank_attempts
    ), "mock exam attempts never become bank attempts"
    seed.problem(regenerate(owner, pinned["id"]), 409, NO_MATCHING)

    # Mock exam questions are never duplicate candidates (a shuffle copy equals its source).
    pair = [book.source("disinfection", chapter=2) for _ in range(2)]
    groups = owner.ok("GET", f"/workspaces/{book.ws}/question-duplicates")["groups"]
    grouped = [q["question_id"] for g in groups for q in g["questions"]]
    assert {q["id"] for q in pair} <= set(grouped), "the scan finds the bank duplicates"
    mock_ids = {q["id"] for q in after} | {copy["id"]}
    assert not [i for i in grouped if i in mock_ids]

    # Workspace deletion: the mock exam API answers 404.
    assert owner.call("DELETE", f"/workspaces/{book.ws}").status_code in {200, 202, 204}
    seed.problem(owner.call("GET", f"/mock-exams/{made['id']}"), 404)


# ---------------------------------------------------------------------------------------------
# C10 source chapters (the range step's 출처 장별 묶음)
# ---------------------------------------------------------------------------------------------


def test_mock_01_c10_each_question_names_its_source_chapter_in_plan_rank_without_answers(
    seed: Any, db: Any
) -> None:
    owner = seed.client("mock-c10")
    book = Book(owner)
    viewer = member(seed, book.ws, "mock-c10-viewer", "viewer")
    ch2_a = book.source("flocculation")
    ch1_a = book.source("evaporation")
    loose = book.source("condensation", chapter=None)
    ch1_b = book.source("precipitation")
    ch2_b = book.source("disinfection")
    gone = book.source("infiltration")
    picks = [ch2_a, ch1_a, loose, ch1_b, ch2_b, gone]
    made = make(
        owner, book.ws, config(("OPTION_SHUFFLE",), None), picked(*(q["id"] for q in picks))
    )
    assert owner.call("DELETE", f"/questions/{gone['id']}").status_code == 204

    [(plan,)] = db(
        "select plan from public.mock_exam_generations where id = %s",
        (made["latest_generation"]["id"],),
    )
    plan_rank = {str(p["question_id"]): int(p["chapter_rank"]) for p in plan}
    ch1 = {"id": book.ch1, "number": 1, "title": CH1, "rank": plan_rank[ch1_a["id"]]}
    ch2 = {"id": book.ch2, "number": 2, "title": CH2, "rank": plan_rank[ch2_a["id"]]}
    assert ch1["rank"] < ch2["rank"], "Heatmap order: 1장 before 2장"
    expected = {
        ch1_a["id"]: ch1,
        ch1_b["id"]: ch1,
        ch2_a["id"]: ch2,
        ch2_b["id"]: ch2,
        loose["id"]: None,  # no chapter: the 'none' group, after every chapter
    }

    for client, answers in ((owner, True), (owner, False), (viewer, False)):
        items = questions(client, made["id"], answers=answers)
        assert len(items) == len(picks)
        by_source = {q["source"]["question_id"]: q["source"] for q in items}
        assert {k: by_source[k]["chapter"] for k in expected} == expected
        # A deleted source keeps no chapter: it goes to the 'none' group too.
        deleted = [q["source"] for q in items if q["source"]["question_id"] is None]
        assert deleted == [{"question_id": None, "label": "원본 삭제됨", "chapter": None}]
        # The chapter adds no answer field; viewers still get none at all.
        for q in items:
            chapter = q["source"]["chapter"]
            assert chapter is None or set(chapter) == {"id", "number", "title", "rank"}
        if client is viewer or not answers:
            assert answer_keys(items) == []

    # One question's read (an edit's answer) carries the same chapter.
    one = next(
        q
        for q in questions(owner, made["id"], answers=True)
        if q["source"]["question_id"] == ch2_b["id"]
    )
    edited = owner.ok(
        "PATCH",
        f"/mock-exam-questions/{one['id']}",
        {"base_revision_id": one["revision"]["id"], "stem": "고친 발문"},
    )
    assert edited["source"]["chapter"] == ch2


# ---------------------------------------------------------------------------------------------
# C09 batching (the fake counts calls)
# ---------------------------------------------------------------------------------------------


def calls_with(prompts: list[str], marker: str) -> int:
    return sum(1 for p in prompts if marker in markers(p))


def test_mock_01_c09_one_call_for_twenty_sources_with_each_passage_once(
    seed: Any, llm_calls: Any, job_worker: Any
) -> None:
    owner = seed.client("mock-c09-20")
    book = Book(owner)
    book.bulk(range(1, 21))
    seen = len(llm_calls(job_worker))
    made = make(owner, book.ws, config(("PARAPHRASE",), 20))
    assert made["latest_generation"]["created_count"] == 20
    [prompt] = llm_calls(job_worker)[seen:]
    assert len({m for m in markers(prompt) if m.startswith("E2E-MOCK-BULK-")}) == 20
    for sentence in ("이 과정을 응결이라고 하며", "이를 강수라고 한다"):
        assert prompt.count(sentence) == 1, "a passage is sent once per call"


def test_mock_01_c09_a_hundred_sources_take_three_deterministic_calls_within_the_caps(
    seed: Any, llm_calls: Any, max_in_flight: Any, job_worker: Any
) -> None:
    owner = seed.client("mock-c09-100")
    book = Book(owner)
    book.bulk(range(1, 101))

    seen = len(llm_calls(job_worker))
    made = make(owner, book.ws, config(("PARAPHRASE",), 100))
    first = [frozenset(markers(p)) for p in llm_calls(job_worker)[seen:]]
    assert len(first) == 3, "default budgets: 100 sources in three calls"
    assert all(len(batch) <= 40 for batch in first), "MOCK_EXAM_SOURCES_PER_CALL"
    assert made["latest_generation"]["created_count"] == 100

    seen = len(llm_calls(job_worker))
    res = regenerate(owner, made["id"])
    assert res.status_code == 202, res.text[:200]
    finish(owner, res.json())
    second = [frozenset(markers(p)) for p in llm_calls(job_worker)[seen:]]
    assert sorted(map(sorted, second)) == sorted(map(sorted, first)), "deterministic batches"
    assert max_in_flight(job_worker) <= 2, "MOCK_EXAM_GENERATION_CONCURRENCY"


def test_mock_01_c09_an_unreadable_or_cut_batch_is_halved_and_other_batches_are_not_redone(
    seed: Any, llm_calls: Any, job_worker: Any
) -> None:
    for fault in ("brk-sediment", "trn-raw-water"):
        owner = seed.client(f"mock-c09-{fault}")
        book = Book(owner)
        bulk = book.bulk(range(1, 41))
        book.sources((fault, "brk-backwash", "brk-cloud"))
        seen = len(llm_calls(job_worker))
        made = make(owner, book.ws, config(("PARAPHRASE",), 43))
        assert made["latest_generation"]["created_count"] == 43, fault
        prompts = llm_calls(job_worker)[seen:]
        for q in bulk:
            assert calls_with(prompts, MARKER.findall(q["revision"]["stem"])[0]) == 1
        assert calls_with(prompts, MOCK["sources"][fault]["marker"]) == 2, fault
        assert len(prompts) == 4, "bulk batch + broken batch + its two halves"


def test_mock_01_c09_an_oversized_source_is_skipped_as_source_too_large(
    seed: Any, db: Any, llm_calls: Any, tight_worker: Any
) -> None:
    owner = seed.client("mock-c09-large")
    book = Book(owner)
    [small] = book.bulk(range(1, 2))
    huge = book._create(
        {
            "question_type": "MCQ",
            "stem": "아주 긴 원본 " + "가나다라마바사아자차" * 1_900 + " [E2E-MOCK-BULK-999]",
            "options": [{"id": "opt-1", "text": "가"}, {"id": "opt-2", "text": "나"}],
            "correct_option_ids": ["opt-1"],
            "is_multi_answer": False,
            "chapter_id": book.ch1,
            "sources": [book._page(2)],
        }
    )
    body = start(owner, book.ws, config(("PARAPHRASE",), 2), picked(small["id"], huge["id"]))
    made = finish(owner, body, expected="partial", worker=tight_worker)
    assert (
        made["latest_generation"]["created_count"],
        made["latest_generation"]["skipped_count"],
    ) == (1, 1)
    prompts = llm_calls(tight_worker)
    assert [p for p in prompts if "E2E-MOCK-BULK-001" in p], "the small source was requested"
    assert not [p for p in prompts if "E2E-MOCK-BULK-999" in p]
    assert db(
        "select skip_reason from public.mock_exam_generation_items "
        "where generation_id = %s and source_question_id = %s",
        (made["latest_generation"]["id"], huge["id"]),
    ) == [("source_too_large",)]


def test_mock_01_c09_a_restarted_job_does_not_call_finished_batches_again(
    seed: Any, db: Any, llm_calls: Any, max_in_flight: Any, serial_worker: Any
) -> None:
    owner = seed.client("mock-c09-checkpoint")
    book = Book(owner)
    bulk = book.bulk(range(1, 41))
    crash = f"E2E-MOCK-CRASH-{uuid.uuid4().hex[:16]}"
    book.bulk(range(1, 2), template="crash", tail=crash)
    body = start(owner, book.ws, config(("PARAPHRASE",), 41))
    job_id = str(body["latest_generation"]["job_id"])
    crashed = ""
    try:
        serial_worker.drain(job_id)
    except KeyboardInterrupt:
        raise
    except BaseException as exc:  # K7: the simulated crash is a BaseException, like a kill
        crashed = type(exc).__name__
    assert crashed == "MockExamSimulatedCrash", crashed or "the job did not crash"
    # A killed worker's lease runs out; the next delivery resumes from the checkpoint.
    db(
        "update public.async_jobs set lease_expires_at = now() - interval '1 second' where id = %s",
        (job_id,),
    )
    made = finish(owner, body, worker=serial_worker)
    assert made["latest_generation"]["created_count"] == 41
    prompts = llm_calls(serial_worker)
    for q in bulk:
        assert calls_with(prompts, MARKER.findall(q["revision"]["stem"])[0]) == 1
    assert calls_with(prompts, crash) == 2
    assert max_in_flight(serial_worker) <= 1


def test_ux10_qview_ac01_mock_options_default_to_revision_order(seed: Any, db: Any) -> None:
    from quiz_api.practice_grading import shuffled_option_ids

    owner = seed.client("ux10-mock-order")
    book = Book(owner)
    book.sources(NORMAL)
    made = make(owner, book.ws, config(("OPTION_SHUFFLE",), 1))
    [question] = questions(owner, made["id"], answers=True)
    authored = [o["id"] for o in question["options"]]
    path = f"/mock-exam-questions/{question['id']}/practice-sessions"
    session = owner.ok("POST", path, {}, (201,))
    assert session["displayed_option_ids"] == authored
    assert not ANSWER_KEYS & set(session)
    shuffled = owner.ok("POST", path, {"shuffle_options": True}, (201,))
    assert sorted(shuffled["displayed_option_ids"]) == sorted(authored)
    [(stored_seed,)] = db(
        "select shuffle_seed from public.mock_exam_practice_sessions where id = %s",
        (shuffled["id"],),
    )
    assert stored_seed is not None
    assert shuffled["displayed_option_ids"] == shuffled_option_ids(authored, stored_seed)
    graded = owner.ok(
        "POST",
        f"/mock-practice-sessions/{shuffled['id']}/submit",
        {"selected_option_ids": question["correct_option_ids"]},
    )
    assert graded["result"] == "correct"
