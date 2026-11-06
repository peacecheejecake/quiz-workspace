"""AIEXPL-01 server guarantees C01-C09 (docs/screens/ai-explanations.md, questions.md §13,
architecture.md §5).

The submission gate is decided in the database, never from client values, and leaves no row, job
or LLM call behind (C01); the authorization matrix, the share API and the feature switch (C02);
one shared explanation per (question revision, prompt version, model), generated once under
concurrent POSTs, cache hits outside the limits, failed rows not blocking, versions on regenerate
(C03); the explainer's input (no user answer, no question paper) and its validation (answer
mismatch, option coverage with one re-request) (C04); the SSE stream replayed from seq 0 to a
second reader and re-authorized per connection (C05); no content in logs, job results or
activities, one usage row per generation (C06); fork copies only the latest succeeded one (C07);
the deterministic fake and its markers (C08); mock exam questions with their own rows, gate and
`view: manage` (C09).

Shapes are assumptions E1-E9 in tests/e2e/fixtures/ai-explanations.ts. Jobs run in this process
(conftest.py). EXPL.0 marked every test `red`; EXPL-B removed the marker.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
import pytest
from book_core.explain import PROMPT_VERSION

pytestmark = pytest.mark.infra

REPO_ROOT = Path(__file__).resolve().parents[4]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
BOOK_KO = PDF_DIR / "book-ko.pdf"
QUESTION_PAPER = PDF_DIR / "questions-ko.pdf"
PAPER_TRUTH = json.loads((PDF_DIR / "questions-ko.truth.json").read_text(encoding="utf-8"))
CH1 = "1장 물의 순환"
SOURCE_PAGE = 2
TERMS = ("증발", "응결", "강수", "유출")
STEM = "햇빛이 물 표면을 데워 물 분자가 수증기가 되는 과정은?"
P = "urn:quiz-workspace:problem:"
BEFORE_SUBMIT = P + "explanation-before-submit"
UNAVAILABLE = P + "explanation-unavailable"
DISABLED = P + "explanation-disabled"
REGENERATE_LIMIT = P + "explanation-regenerate-limit"
ARCHIVED = P + "workspace-archived"
INSUFFICIENT_ROLE = P + "insufficient-role"
FAIL, MISMATCH, MISSING_OPTION = "E2E-EXPL-FAIL", "E2E-EXPL-MISMATCH", "E2E-EXPL-MISSING-OPTION"
RAW_SENTINEL = "E2E-EXPL-RAW-OUTPUT"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
LIVE = ("queued", "running")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser reads only where no API exposes the guarantee)
# ---------------------------------------------------------------------------------------------


def upload(client: Any, workspace_id: str, pdf: Path = BOOK_KO, kind: str = "book") -> str:
    """upload-intent -> PUT -> complete-upload, then drains the parse job."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": pdf.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": kind,
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
    """A workspace with book-ko.pdf, its chapter 1 and evaporation MCQs citing page 2."""

    def __init__(self, client: Any) -> None:
        self.client = client
        self.ws: str = client.create_workspace()["id"]
        self.doc = upload(client, self.ws)
        items = client.ok("GET", f"/documents/{self.doc}/outline")["items"]
        self.ch1 = next(str(n["id"]) for n in items if str(n["title"]).strip() == CH1)
        self.label = uuid.uuid4().hex[:8]
        self._n = 0

    def mcq(self, *markers: str, status: str = "CONFIRMED") -> dict[str, Any]:
        self._n += 1
        n = self._n
        tail = "".join(f" [{m}]" for m in markers)
        options = [
            {"id": f"opt-{i + 1}", "text": f"{self.label}-{n} {t}"} for i, t in enumerate(TERMS)
        ]
        out: dict[str, Any] = self.client.ok(
            "POST",
            f"/workspaces/{self.ws}/questions",
            {
                "question_type": "MCQ",
                "stem": f"{self.label}-{n} {STEM}{tail}",
                "options": options,
                "correct_option_ids": ["opt-1"],
                "is_multi_answer": False,
                "explanation": f"{self.label}-{n} 사람이 쓴 해설: 액체가 기체로 변하는 현상이다.",
                "chapter_id": self.ch1,
                "question_number": n,
                "publication_status": status,
                "sources": [
                    {"document_id": self.doc, "page_start": SOURCE_PAGE, "page_end": SOURCE_PAGE}
                ],
            },
            (201,),
        )
        return out


def member(seed: Any, workspace_id: str, label: str, role: str) -> Any:
    client = seed.client(label)
    seed.membership(workspace_id, client.user, role)
    return client


def start(client: Any, question_id: str, **body: Any) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", body, (201,)
    )
    return out


def submit(client: Any, session_id: str, answer: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("POST", f"/practice-sessions/{session_id}/submit", answer)
    return out


def submitted(client: Any, question: dict[str, Any], correct: bool = True) -> str:
    """A practice session of `client` on `question` with a graded MCQ attempt."""
    session = start(client, question["id"])
    ids = question["revision"]["correct_option_ids"]
    option = (
        ids[0]
        if correct
        else next(o["id"] for o in question["revision"]["options"] if o["id"] not in ids)
    )
    submit(client, session["id"], {"selected_option_ids": [option]})
    return str(session["id"])


def base(kind: str, target_id: str) -> str:
    if kind == "question":
        return f"/questions/{target_id}/ai-explanation"
    return f"/mock-exam-questions/{target_id}/ai-explanation"


def get(client: Any, target_id: str, kind: str = "question", **gate: str) -> httpx.Response:
    query = f"?{urlencode(gate)}" if gate else ""
    res: httpx.Response = client.call("GET", f"{base(kind, target_id)}{query}")
    return res


def post(client: Any, target_id: str, kind: str = "question", **gate: str) -> httpx.Response:
    res: httpx.Response = client.call("POST", base(kind, target_id), gate)
    return res


def regenerate(client: Any, target_id: str, kind: str = "question", **gate: str) -> httpx.Response:
    res: httpx.Response = client.call("POST", f"{base(kind, target_id)}/regenerate", gate)
    return res


def implemented(res: httpx.Response) -> httpx.Response:
    route = UUID.sub("{id}", res.request.url.path.split("/api/v1")[-1])
    assert not (res.status_code in {404, 405} and not _detail(res)), (
        f"{res.request.method} {route} not implemented ({res.status_code})"
    )
    return res


def _detail(res: httpx.Response) -> Any:
    try:
        return res.json().get("detail")
    except ValueError:
        return None


def problem(res: httpx.Response, status: int, kind: str) -> dict[str, Any]:
    implemented(res)
    assert res.status_code == status, f"expected {status}, got {res.status_code}: {res.text[:300]}"
    body: dict[str, Any] = res.json()
    assert body["type"] == kind
    return body


def state(res: httpx.Response, expected: tuple[int, ...] = (200, 202)) -> dict[str, Any]:
    implemented(res)
    assert res.status_code in expected, f"HTTP {res.status_code}: {res.text[:300]}"
    out: dict[str, Any] = res.json()
    return out


def drain(client: Any, explanation: dict[str, Any]) -> None:
    """Runs the explanation's job in this process (C03 one job per key)."""
    job_id = explanation.get("job_id")
    assert job_id, "a queued explanation names its job (E1)"
    assert client.worker is not None
    client.worker.drain(str(job_id))


def make(client: Any, target_id: str, kind: str = "question", **gate: str) -> dict[str, Any]:
    """POST, drain the job if one started, return the terminal explanation."""
    first = state(post(client, target_id, kind, **gate))
    explanation = first["explanation"]
    assert explanation is not None
    if explanation["status"] in LIVE:
        drain(client, explanation)
    done = state(get(client, target_id, kind, **gate), (200,))["explanation"]
    assert done is not None
    assert done["status"] in {"succeeded", "failed"}
    out: dict[str, Any] = done
    return out


def keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys(v)}
    return set()


def rows(db: Callable[..., list[tuple[Any, ...]]], question_id: str) -> list[tuple[Any, ...]]:
    return db(
        "select id::text, status, version, superseded_at is not null, question_revision_id::text "
        "from public.question_ai_explanations where question_id = %s order by created_at",
        (question_id,),
    )


def explain_jobs(db: Callable[..., list[tuple[Any, ...]]], target_id: str) -> int:
    return int(
        db(
            "select count(*) from public.async_jobs where job_type = 'question.ai_explain' "
            "and payload::text like %s",
            (f"%{target_id}%",),
        )[0][0]
    )


def race(calls: list[Callable[[], httpx.Response]]) -> list[httpx.Response]:
    barrier = threading.Barrier(len(calls))
    results: list[httpx.Response] = []
    errors: list[BaseException] = []

    def run(call: Callable[[], httpx.Response]) -> None:
        try:
            barrier.wait(timeout=10)
            results.append(call())
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(c,)) for c in calls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert errors == []
    return results


def shuffle_exam(owner: Any, ws: str, question_ids: list[str]) -> list[dict[str, Any]]:
    """A `보기 섞기` mock exam of `question_ids` (no LLM); its questions with answers."""
    made: dict[str, Any] = owner.ok(
        "POST",
        f"/workspaces/{ws}/mock-exams",
        {
            "title": f"모의고사 {uuid.uuid4().hex[:6]}",
            "config": {
                "variation_types": ["OPTION_SHUFFLE"],
                "question_count": len(question_ids),
                "difficulty": None,
            },
            "range": {
                "all": False,
                "chapter_ids": [],
                "question_ids": question_ids,
                "excluded_question_ids": [],
                "filters": {},
            },
        },
        (202,),
    )
    owner.wait_for_job(str(made["latest_generation"]["job_id"]))
    items: list[dict[str, Any]] = owner.ok(
        "GET", f"/mock-exams/{made['id']}/questions?include=answers"
    )["items"]
    for item in items:
        item["mock_exam_id"] = made["id"]
    return sorted(items, key=lambda q: int(q["position"]))


def mock_submitted(client: Any, item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    session: dict[str, Any] = client.ok(
        "POST", f"/mock-exam-questions/{item['id']}/practice-sessions", {}, (201,)
    )
    graded: dict[str, Any] = client.ok(
        "POST",
        f"/mock-practice-sessions/{session['id']}/submit",
        {"selected_option_ids": item["correct_option_ids"]},
    )
    return str(session["id"]), {"session": session, "submit": graded}


# ---------------------------------------------------------------------------------------------
# C01 submission gate
# ---------------------------------------------------------------------------------------------


def test_c01_submission_gate_is_decided_in_the_database(
    seed: Any, db: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c01-owner")
    book = Book(owner)
    q = book.mcq()
    learner = member(seed, book.ws, "expl-c01-learner", "viewer")
    other = member(seed, book.ws, "expl-c01-other", "viewer")
    open_session = start(learner, q["id"])
    others = submitted(other, q)

    # No session, an unsubmitted session, a bogus id: 409; someone else's session: 404.
    for res in (
        post(learner, q["id"]),
        get(learner, q["id"]),
        post(learner, q["id"], practice_session_id=open_session["id"]),
        get(learner, q["id"], practice_session_id=open_session["id"]),
    ):
        body = problem(res, 409, BEFORE_SUBMIT)
        assert not ANSWER_KEYS & keys(body)
    for res in (
        post(learner, q["id"], practice_session_id=others),
        get(learner, q["id"], practice_session_id=others),
    ):
        implemented(res)
        assert res.status_code == 404
    assert rows(db, q["id"]) == []
    assert explain_jobs(db, q["id"]) == 0
    assert calls(q["id"]) == 0

    # The practice API is unchanged: no answer or AI explanation field before or after.
    assert not ANSWER_KEYS & keys(open_session)
    assert not {"ai_explanation", "ai_explanation_id"} & keys(open_session)
    graded = submit(learner, open_session["id"], {"selected_option_ids": ["opt-2"]})
    assert not {"ai_explanation", "ai_explanation_id"} & keys(graded)

    # A submitted session (pending grading included) and `view: detail` open the gate.
    done = make(learner, q["id"], practice_session_id=open_session["id"])
    assert done["status"] == "succeeded"
    detail = state(get(other, q["id"], view="detail"), (200,))
    assert detail["explanation"]["id"] == done["id"]

    # A range-run position's session counts like the panel's (sequence(bank)).
    run = owner.ok(
        "POST",
        f"/workspaces/{book.ws}/practice-runs",
        {"source": "bank", "range": {"question_ids": [q["id"]]}, "random_order": False},
        (201,),
    )
    run_session = start(owner, q["id"], practice_run_id=run["id"], run_position=1)
    problem(get(owner, q["id"], practice_session_id=run_session["id"]), 409, BEFORE_SUBMIT)
    submit(owner, run_session["id"], {"selected_option_ids": ["opt-1"]})
    via_run = state(get(owner, q["id"], practice_session_id=run_session["id"]), (200,))
    assert via_run["explanation"]["id"] == done["id"]


def test_c01_draft_detail_is_unavailable_archived_keeps_its_own(
    seed: Any, db: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c01b-owner")
    book = Book(owner)
    draft = book.mcq(status="DRAFT")
    for res in (post(owner, draft["id"], view="detail"), get(owner, draft["id"], view="detail")):
        problem(res, 409, UNAVAILABLE)
    assert rows(db, draft["id"]) == []
    assert calls(draft["id"]) == 0

    kept = book.mcq()
    done = make(owner, kept["id"], view="detail")
    owner.ok(
        "PATCH",
        f"/questions/{kept['id']}",
        {"base_revision_id": kept["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    archived = state(get(owner, kept["id"], view="detail"), (200,))
    assert archived["explanation"]["id"] == done["id"]


# ---------------------------------------------------------------------------------------------
# C02 authorization matrix, share API, feature switch
# ---------------------------------------------------------------------------------------------


def test_c02_authorization_matrix(seed: Any, calls: Callable[[str], int]) -> None:
    owner = seed.client("expl-c02-owner")
    book = Book(owner)
    q = book.mcq()
    viewer = member(seed, book.ws, "expl-c02-viewer", "viewer")
    editor = member(seed, book.ws, "expl-c02-editor", "editor")
    outsider = seed.client("expl-c02-outsider")

    session = submitted(viewer, q)
    made = make(viewer, q["id"], practice_session_id=session)  # viewers create
    assert made["status"] == "succeeded"
    problem(regenerate(viewer, q["id"], practice_session_id=session), 403, INSUFFICIENT_ROLE)
    regenerated = state(regenerate(editor, q["id"], view="detail"), (202,))["explanation"]
    assert regenerated["version"] == 2
    drain(editor, regenerated)
    for res in (get(outsider, q["id"], view="detail"), post(outsider, q["id"], view="detail")):
        implemented(res)
        assert res.status_code == 404

    second = book.mcq()
    owner_session = submitted(owner, second)
    owner.ok("POST", f"/workspaces/{book.ws}/archive", None)
    problem(post(owner, second["id"], practice_session_id=owner_session), 403, ARCHIVED)
    problem(regenerate(owner, q["id"], view="detail"), 403, ARCHIVED)
    read = state(get(viewer, q["id"], practice_session_id=session), (200,))
    assert read["explanation"]["status"] in {"succeeded", "queued", "running"}
    assert read["can_create"] is False
    assert read["can_regenerate"] is False
    calls_before = calls(second["id"])
    owner.ok("DELETE", f"/workspaces/{book.ws}", None, (200, 202, 204))
    for res in (get(viewer, q["id"], view="detail"), post(owner, second["id"], view="detail")):
        implemented(res)
        assert res.status_code == 404
    assert calls(second["id"]) == calls_before


def test_c02_share_api_reads_only_the_latest_success_of_published_questions(
    seed: Any, off_app: Any
) -> None:
    owner = seed.client("expl-c02s-owner")
    book = Book(owner)
    with_one, without = book.mcq(), book.mcq()
    first = make(owner, with_one["id"], view="detail")
    state(regenerate(owner, with_one["id"], view="detail"), (202,))
    latest = make(owner, with_one["id"], view="detail")
    assert latest["id"] != first["id"]
    link = owner.create_link(book.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    res = guest.read(link["id"], cookie, f"/questions/{with_one['id']}/ai-explanation")
    body = state(implemented(res), (200,))
    assert not {"id", "status", "version", "error_code", "usage", "job_id"} & set(body)
    assert body["body"] == latest["body"]
    res = guest.read(link["id"], cookie, f"/questions/{without['id']}/ai-explanation")
    assert res.status_code == 404
    # No share session: no read; a revoked link: the share API's one 404 on the next request.
    bare = guest.send("GET", f"/shared/{link['id']}/questions/{with_one['id']}/ai-explanation")
    assert bare.status_code == 401
    revoked = owner.revoke(book.ws, link["id"])
    assert revoked.status_code == 200
    res = guest.read(link["id"], cookie, f"/questions/{with_one['id']}/ai-explanation")
    assert res.status_code == 404

    # Feature off: creating is refused; what exists still reads.
    off = type(owner)(off_app, owner.user)
    session = submitted(owner, without)
    problem(
        off.call("POST", base("question", without["id"]), {"practice_session_id": session}),
        409,
        DISABLED,
    )
    still = off.call("GET", f"{base('question', with_one['id'])}?view=detail")
    assert state(still, (200,))["explanation"]["id"] == latest["id"]
    assert state(still, (200,))["available"] is False


# ---------------------------------------------------------------------------------------------
# C03 cache, concurrency, versions
# ---------------------------------------------------------------------------------------------


def test_c03_twenty_concurrent_posts_make_one_row_one_job_one_call(
    seed: Any, db: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c03-owner")
    book = Book(owner)
    q = book.mcq()
    learners = [member(seed, book.ws, f"expl-c03-l{i}", "viewer") for i in range(4)]
    sessions = [submitted(c, q) for c in learners]
    posts: list[Callable[[], httpx.Response]] = []
    for i in range(20):
        client, sid = learners[i % 4], sessions[i % 4]
        posts.append(lambda c=client, s=sid: post(c, q["id"], practice_session_id=s))
    results = race(posts)
    ids = {state(r)["explanation"]["id"] for r in results}
    assert len(ids) == 1
    assert len(rows(db, q["id"])) == 1
    assert explain_jobs(db, q["id"]) == 1
    drain(owner, state(results[0])["explanation"])
    assert calls(q["id"]) == 1

    # A cache hit: 200, the same id, no job, no call.
    hit = post(learners[0], q["id"], practice_session_id=sessions[0])
    assert state(hit, (200,))["explanation"]["id"] in ids
    assert explain_jobs(db, q["id"]) == 1
    assert calls(q["id"]) == 1


def test_c03_failed_rows_do_not_block_new_revisions_get_new_keys_regenerate_caps(
    seed: Any, db: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c03b-owner")
    book = Book(owner)
    failing = book.mcq(FAIL)
    failed = make(owner, failing["id"], view="detail")
    assert failed["status"] == "failed"
    assert failed["error_code"] == "llm_unavailable"
    retried = make(owner, failing["id"], view="detail")
    assert retried["status"] == "succeeded"
    assert retried["id"] != failed["id"]
    assert calls(failing["id"]) == 2

    q = book.mcq()
    done = make(owner, q["id"], view="detail")
    current = owner.ok("GET", f"/questions/{q['id']}")
    owner.ok(
        "PATCH",
        f"/questions/{q['id']}",
        {"base_revision_id": current["revision"]["id"], "explanation": "고친 사람 해설"},
    )
    fresh = state(get(owner, q["id"], view="detail"), (200,))
    assert fresh["explanation"] is None
    assert fresh["can_create"] is True
    renewed = make(owner, q["id"], view="detail")
    assert renewed["id"] != done["id"]
    assert len({r[4] for r in rows(db, q["id"])}) == 2  # one key per revision, old row kept

    versions = [renewed["version"]]
    for _ in range(3):
        nxt = state(regenerate(owner, q["id"], view="detail"), (202,))["explanation"]
        drain(owner, nxt)
        versions.append(nxt["version"])
    assert versions == [1, 2, 3, 4]
    problem(regenerate(owner, q["id"], view="detail"), 409, REGENERATE_LIMIT)
    live = [r for r in rows(db, q["id"]) if r[4] == renewed["question_revision_id"]]
    assert [r[3] for r in live] == [True, True, True, False]  # superseded, never deleted


def test_c03_a_failed_regeneration_never_hides_the_current_success(seed: Any, db: Any) -> None:
    """After a success, a regeneration that fails leaves the success current: GET and the POST
    cache hit answer it (not the failed attempt), and it can be regenerated again."""
    owner = seed.client("expl-c03c-owner")
    book = Book(owner)
    q = book.mcq()
    good = make(owner, q["id"], view="detail")
    again = state(regenerate(owner, q["id"], view="detail"), (202,))["explanation"]
    assert again["version"] == 2
    # The worker failing the regeneration (as on a provider error), written as the superuser.
    db(
        "update public.question_ai_explanations set status = 'failed', "
        "error_code = 'llm_unavailable', started_at = now(), finished_at = now() where id = %s",
        (again["id"],),
    )
    read = state(get(owner, q["id"], view="detail"), (200,))
    assert read["explanation"]["id"] == good["id"]
    assert read["explanation"]["status"] == "succeeded"
    assert read["explanation"]["body"] == good["body"]
    assert read["can_regenerate"] is True
    hit = state(post(owner, q["id"], view="detail"), (200,))
    assert hit["explanation"]["id"] == good["id"]


def test_c03_an_older_prompt_version_stays_stored_and_the_question_can_be_made_again(
    seed: Any, db: Any, off_app: Any
) -> None:
    """UX12 D-14: a prompt version bump leaves the rows alone and takes them out of every read."""
    owner = seed.client("expl-c03v-owner")
    book = Book(owner)
    q = book.mcq()
    old = make(owner, q["id"], view="detail")
    assert old["status"] == "succeeded"
    older = "question.ai_explain/v1"
    db(
        "update public.question_ai_explanations set prompt_version = %s where id = %s",
        (older, old["id"]),
    )
    link = owner.create_link(book.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    url = f"/questions/{q['id']}/ai-explanation"

    now = state(get(owner, q["id"], view="detail"), (200,))
    assert now["explanation"] is None
    assert now["can_create"] is True
    assert now["can_regenerate"] is False
    assert guest.read(link["id"], cookie, url).status_code == 404
    # A client still holding the old id reconnects: the row is gone from the stream as well.
    res = owner.call("GET", f"/ai-explanations/{old['id']}/stream?view=detail")
    assert res.status_code == 404
    assert old["body"]["summary_md"] not in res.text
    off = type(owner)(off_app, owner.user)
    disabled = state(off.call("GET", f"{base('question', q['id'])}?view=detail"), (200,))
    assert disabled["explanation"] is None
    assert disabled["can_create"] is False

    fresh = make(owner, q["id"], view="detail")
    assert fresh["status"] == "succeeded"
    assert fresh["id"] != old["id"]
    assert fresh["version"] == 1  # a first explanation of the new key, not a regeneration
    stored = db(
        "select id::text, prompt_version, status, superseded_at is not null "
        "from public.question_ai_explanations where question_id = %s order by created_at",
        (q["id"],),
    )
    assert stored == [
        (old["id"], older, "succeeded", False),
        (fresh["id"], PROMPT_VERSION, "succeeded", False),
    ]
    assert state(guest.read(link["id"], cookie, url), (200,))["body"] == fresh["body"]


def test_c03_an_older_prompt_version_of_a_mock_question_is_gone_from_its_stream(
    seed: Any, db: Any
) -> None:
    owner = seed.client("expl-c03m-owner")
    book = Book(owner)
    items = shuffle_exam(owner, book.ws, [book.mcq()["id"], book.mcq()["id"]])
    item = items[0]
    old = make(owner, item["id"], "mock", view="manage")
    stream = f"/mock-ai-explanations/{old['id']}/stream?view=manage"
    assert owner.call("GET", stream).status_code == 200
    db(
        "update public.mock_exam_question_ai_explanations set prompt_version = %s where id = %s",
        ("question.ai_explain/v1", old["id"]),
    )
    res = owner.call("GET", stream)
    assert res.status_code == 404
    assert old["body"]["summary_md"] not in res.text


def test_c03_the_daily_limit_holds_under_concurrent_posts_across_questions(
    seed: Any, db: Any, daily_app: Any
) -> None:
    """Concurrent new explanations of different questions never exceed the user's daily limit
    (the count is re-checked under a per-user lock in the inserting transaction)."""
    owner = seed.client("expl-c03d-owner")
    book = Book(owner)
    questions = [book.mcq() for _ in range(6)]
    limited = type(owner)(daily_app, owner.user)
    results = race(
        [
            lambda qid=q["id"]: limited.call("POST", base("question", qid), {"view": "detail"})
            for q in questions
        ]
    )
    made = db(
        "select count(*) from public.question_ai_explanations where created_by = %s",
        (owner.user.id,),
    )[0][0]
    assert made == 2
    codes = sorted(r.status_code for r in results)
    assert codes == [202, 202, 429, 429, 429, 429]
    for res in results:
        if res.status_code == 429:
            assert res.json()["type"] == P + "explanation-daily-limit"


# ---------------------------------------------------------------------------------------------
# C04 input and validation
# ---------------------------------------------------------------------------------------------


def test_c04_input_has_the_answer_and_sources_but_no_user_answer_or_paper(
    seed: Any, job_worker: Any, prompts: Callable[[Any], list[str]]
) -> None:
    owner = seed.client("expl-c04-owner")
    book = Book(owner)
    upload(owner, book.ws, QUESTION_PAPER, "question_paper")
    user_answer = f"E2E-USER-ANSWER-{uuid.uuid4().hex[:8]}"
    short: dict[str, Any] = owner.ok(
        "POST",
        f"/workspaces/{book.ws}/questions",
        {
            "question_type": "SHORT_ANSWER",
            "stem": f"{book.label} 물이 기체로 변하는 현상은?",
            "accepted_answers": ["증발"],
            "explanation": f"{book.label} 단답 사람 해설",
            "chapter_id": book.ch1,
            "sources": [
                {"document_id": book.doc, "page_start": SOURCE_PAGE, "page_end": SOURCE_PAGE}
            ],
        },
        (201,),
    )
    session = start(owner, short["id"])
    submit(owner, session["id"], {"answer_text": user_answer})
    before = len(prompts(job_worker))
    make(owner, short["id"], practice_session_id=session["id"])
    sent = prompts(job_worker)[before:]
    assert len(sent) == 1
    prompt = sent[0]
    assert short["revision"]["stem"] in prompt
    assert "증발" in prompt
    assert f"{book.label} 단답 사람 해설" not in prompt  # UX12 EXPL-2: not an input
    assert "햇빛이 바다와 호수의 표면을 데우면" in prompt  # the published source block
    assert user_answer not in prompt
    for paper_question in PAPER_TRUTH["questions"]:
        assert paper_question["stem"] not in prompt, "a question paper reached the explainer"


def test_c04_answer_mismatch_fails_unsaved_and_option_coverage_is_rerequested_once(
    seed: Any, db: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c04b-owner")
    book = Book(owner)
    q = book.mcq(MISMATCH)
    failed = make(owner, q["id"], view="detail")
    assert failed["status"] == "failed"
    assert failed["error_code"] == "explanation_answer_mismatch"
    assert failed["body"] is None
    stored = db(
        "select body::text from public.question_ai_explanations where id = %s", (failed["id"],)
    )
    assert stored[0][0] in (None, "null")
    res = get(owner, q["id"], view="detail")
    assert RAW_SENTINEL not in res.text

    partial = book.mcq(MISSING_OPTION)
    out = make(owner, partial["id"], view="detail")
    assert out["status"] == "failed"
    assert calls(partial["id"]) == 2  # one re-request, then failed

    ok = book.mcq()
    good = make(owner, ok["id"], view="detail")
    assert good["status"] == "succeeded"
    covered = [o["option_id"] for o in good["body"]["options"]]
    assert sorted(covered) == sorted(o["id"] for o in ok["revision"]["options"])
    assert good["body"]["correct_option_ids"] == ok["revision"]["correct_option_ids"]
    assert good["sources"]
    assert good["sources"][0]["page"] == SOURCE_PAGE
    # The pinned passage: the document revision the explanation was made from, and its blocks
    # (none for the question's own page-range source).
    active = db("select active_revision_id::text from public.documents where id = %s", (book.doc,))
    for source in good["sources"]:
        assert source["revision_id"] == active[0][0]
        assert source["block_id"] == (source["block_ids"][0] if source["block_ids"] else None)


# ---------------------------------------------------------------------------------------------
# C05 streaming
# ---------------------------------------------------------------------------------------------


def _events(client: Any, explanation_id: str, **gate: str) -> list[tuple[str, dict[str, Any]]]:
    res = client.call("GET", f"/ai-explanations/{explanation_id}/stream?{urlencode(gate)}")
    implemented(res)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    out: list[tuple[str, dict[str, Any]]] = []
    for chunk in res.text.split("\n\n"):
        event = next((ln[6:].strip() for ln in chunk.splitlines() if ln.startswith("event:")), "")
        data = "\n".join(ln[5:].strip() for ln in chunk.splitlines() if ln.startswith("data:"))
        if event:
            out.append((event, json.loads(data) if data else {}))
    return out


def test_c05_a_second_reader_gets_the_stream_from_seq_zero_and_each_connection_is_authorized(
    seed: Any, hold_dir: Path
) -> None:
    owner = seed.client("expl-c05-owner")
    book = Book(owner)
    token = uuid.uuid4().hex[:16]
    q = book.mcq(f"E2E-EXPL-HOLDMID-{token}")
    reader = member(seed, book.ws, "expl-c05-reader", "viewer")
    outsider = seed.client("expl-c05-outsider")
    session = submitted(reader, q)
    explanation = state(post(owner, q["id"], view="detail"), (202,))["explanation"]
    worker = threading.Thread(target=drain, args=(owner, explanation), daemon=True)
    streams: dict[str, list[tuple[str, dict[str, Any]]]] = {}

    def read(who: str, client: Any, **gate: str) -> None:
        streams[who] = _events(client, explanation["id"], **gate)

    first = threading.Thread(
        target=read, args=("owner", owner), kwargs={"view": "detail"}, daemon=True
    )
    second = threading.Thread(
        target=read, args=("reader", reader), kwargs={"practice_session_id": session}, daemon=True
    )
    mid = hold_dir / f"{token}.mid"
    try:
        first.start()  # connected from the start
        worker.start()
        # The fake has published its first chunk (seq 0) and waits mid-stream (E7 HOLDMID).
        for _ in range(240):
            if mid.exists():
                break
            worker.join(0.5)
        assert mid.exists(), "the explanation reaches the mid-stream barrier after one delta"
        assert worker.is_alive(), "the explanation is still running"
        res = outsider.call("GET", f"/ai-explanations/{explanation['id']}/stream?view=detail")
        implemented(res)
        assert res.status_code == 404
        second.start()  # connects after seq 0 was published, while it still runs
        second.join(2)
        assert "reader" not in streams, "the second reader's stream is still open (running)"
    finally:
        (hold_dir / f"{token}.resume").write_text("")
    for t in (worker, first, second):
        t.join(120)
    assert set(streams) == {"owner", "reader"}
    deltas = {who: [d for e, d in events if e == "delta"] for who, events in streams.items()}
    for who, events in streams.items():
        assert [d["seq"] for d in deltas[who]] == list(range(len(deltas[who]))), who
        assert len(deltas[who]) >= 2, who
        assert events[-1][0] == "done", who
    # The late reader also got the delta published before it connected (replay from seq 0).
    assert deltas["reader"][0]["seq"] == 0
    assert deltas["owner"] == deltas["reader"]


def test_c05_a_session_of_another_revision_never_reads_its_stream(seed: Any) -> None:
    """The stream is bound to the explanation's own revision: a session submitted on revision A
    never opens the stream (or its final `done`) of revision B's explanation — the same 404 as an
    unknown id, so nothing tells B exists."""
    owner = seed.client("expl-c05b-owner")
    book = Book(owner)
    q = book.mcq()
    learner = member(seed, book.ws, "expl-c05b-learner", "viewer")
    old_session = submitted(learner, q)  # revision A
    owner.ok(
        "PATCH",
        f"/questions/{q['id']}",
        {"base_revision_id": q["revision"]["id"], "explanation": "고친 사람 해설 B"},
    )
    on_b = make(owner, q["id"], view="detail")  # revision B
    assert on_b["question_revision_id"] != q["revision"]["id"]
    leaked = learner.call(
        "GET", f"/ai-explanations/{on_b['id']}/stream?practice_session_id={old_session}"
    )
    unknown = learner.call(
        "GET", f"/ai-explanations/{uuid.uuid4()}/stream?practice_session_id={old_session}"
    )
    implemented(leaked)
    assert leaked.status_code == 404
    assert leaked.json()["detail"] == unknown.json()["detail"]
    assert "고친 사람 해설" not in leaked.text
    # A session of its own revision still reads it.
    fresh = submitted(learner, owner.ok("GET", f"/questions/{q['id']}"))
    events = _events(learner, on_b["id"], practice_session_id=fresh)
    assert events[-1][0] == "done"


# ---------------------------------------------------------------------------------------------
# C06 no leaks, usage, activity
# ---------------------------------------------------------------------------------------------


def test_c06_no_content_in_logs_job_results_or_activities_and_one_usage_row(
    seed: Any, db: Any, caplog: pytest.LogCaptureFixture
) -> None:
    owner = seed.client("expl-c06-owner")
    book = Book(owner)
    q = book.mcq()
    caplog.set_level(logging.DEBUG)
    done = make(owner, q["id"], view="detail")
    secrets = [
        q["revision"]["stem"],
        q["revision"]["explanation"],
        q["revision"]["options"][0]["text"],
        done["body"]["summary_md"],
        "햇빛이 바다와 호수의 표면을 데우면",
    ]
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for secret in secrets:
        assert secret not in logged
    job = db(
        "select result::text from public.async_jobs where job_type = 'question.ai_explain' "
        "and payload::text like %s",
        (f"%{q['id']}%",),
    )
    assert len(job) == 1
    for secret in secrets:
        assert secret not in (job[0][0] or "")
    usage = db(
        "select feature, user_id::text from public.llm_feature_usage where ref_id = %s",
        (done["id"],),
    )
    assert usage == [("ai_explanation", owner.user.id)]
    events = db(
        "select metadata::text from public.activity_events "
        "where workspace_id = %s and event_type = 'question.ai_explanation_generated'",
        (book.ws,),
    )
    assert len(events) == 1
    for secret in secrets:
        assert secret not in events[0][0]


# ---------------------------------------------------------------------------------------------
# C07 fork
# ---------------------------------------------------------------------------------------------


def test_c07_fork_copies_only_the_latest_succeeded_explanation_with_new_ids(
    seed: Any, db: Any
) -> None:
    owner = seed.client("expl-c07-owner")
    book = Book(owner)
    q, failing = book.mcq(), book.mcq(FAIL)
    make(owner, q["id"], view="detail")
    state(regenerate(owner, q["id"], view="detail"), (202,))
    latest = make(owner, q["id"], view="detail")
    assert make(owner, failing["id"], view="detail")["status"] == "failed"
    link = owner.create_link(book.ws, allow_fork=True)
    recipient = seed.client("expl-c07-recipient")
    cookie = seed.guest().session(link["id"], link["secret"])
    res = recipient.fork(link["id"], cookie, f"fork {uuid.uuid4().hex[:6]}")
    assert res.status_code == 202
    fork = recipient.wait_fork(res.json()["id"], "COMPLETED")
    target = fork["target_workspace_id"]
    copied = db(
        "select e.id::text, e.version, e.status, e.body::text, e.question_id::text "
        "from public.question_ai_explanations e where e.workspace_id = %s",
        (target,),
    )
    assert len(copied) == 1, "only the latest succeeded explanation is copied"
    new_id, _, status, body, question_id = copied[0]
    assert status == "succeeded"
    assert new_id != latest["id"]
    assert question_id != q["id"]
    assert json.loads(body) == latest["body"]
    assert (
        db("select count(*) from public.llm_feature_usage where workspace_id = %s", (target,))[0][0]
        == 0
    )
    forked = recipient.ok("GET", f"/questions/{question_id}/ai-explanation?view=detail")
    assert forked["explanation"]["id"] == new_id
    assert all(s["document_id"] != book.doc for s in forked["explanation"]["sources"])


# ---------------------------------------------------------------------------------------------
# C08 deterministic fake
# ---------------------------------------------------------------------------------------------


def test_c08_the_fake_explainer_is_deterministic_and_logs_its_calls(
    seed: Any, calls: Callable[[str], int]
) -> None:
    owner = seed.client("expl-c08-owner")
    one, two = Book(owner), Book(owner)
    two.label = one.label  # the same question text in another workspace
    q1, q2 = one.mcq(), two.mcq()
    a = make(owner, q1["id"], view="detail")
    b = make(owner, q2["id"], view="detail")
    assert a["status"] == b["status"] == "succeeded"
    assert a["body"] == b["body"]
    assert calls(q1["id"]) == 1
    assert calls(q2["id"]) == 1
    correct = q1["revision"]["options"][0]["text"]
    assert correct in a["body"]["summary_md"]
    assert "[S1]" in a["body"]["summary_md"] or "[1]" in a["body"]["summary_md"]


# ---------------------------------------------------------------------------------------------
# C09 mock exam questions
# ---------------------------------------------------------------------------------------------


def test_c09_mock_questions_have_their_own_rows_gate_and_manage_view(
    seed: Any,
    db: Any,
    calls: Callable[[str], int],
    job_worker: Any,
    prompts: Callable[[Any], list[str]],
) -> None:
    owner = seed.client("expl-c09-owner")
    book = Book(owner)
    q1, q2 = book.mcq(), book.mcq()
    bank_expl = make(owner, q1["id"], view="detail")
    items = shuffle_exam(owner, book.ws, [q1["id"], q2["id"]])
    item = next(i for i in items if i["source"]["question_id"] == q1["id"])
    viewer = member(seed, book.ws, "expl-c09-viewer", "viewer")
    outsider = seed.client("expl-c09-outsider")

    open_session: dict[str, Any] = viewer.ok(
        "POST", f"/mock-exam-questions/{item['id']}/practice-sessions", {}, (201,)
    )
    for res in (
        get(viewer, item["id"], "mock", mock_practice_session_id=open_session["id"]),
        post(viewer, item["id"], "mock", mock_practice_session_id=open_session["id"]),
        post(viewer, item["id"], "mock"),
    ):
        problem(res, 409, BEFORE_SUBMIT)
    problem(post(viewer, item["id"], "mock", view="manage"), 403, INSUFFICIENT_ROLE)
    assert calls(item["id"]) == 0
    graded: dict[str, Any] = viewer.ok(
        "POST",
        f"/mock-practice-sessions/{open_session['id']}/submit",
        {"selected_option_ids": item["correct_option_ids"]},
    )
    # The mock practice API is unchanged.
    assert not ANSWER_KEYS & keys(open_session)
    assert not {"ai_explanation", "ai_explanation_id"} & keys(open_session)
    assert not {"ai_explanation", "ai_explanation_id"} & keys(graded)

    made = make(viewer, item["id"], "mock", mock_practice_session_id=open_session["id"])
    assert made["status"] == "succeeded"
    assert made["id"] != bank_expl["id"]  # never the source question's row
    assert calls(item["id"]) == 1
    # UX12 EXPL-2: the mock revision's human explanation is not an input either.
    [(human,)] = db(
        "select r.explanation from public.mock_exam_question_revisions r "
        "where r.mock_exam_question_id = %s",
        (item["id"],),
    )
    assert human
    assert human not in prompts(job_worker)[-1]
    mock_rows = db(
        "select id::text from public.mock_exam_question_ai_explanations "
        "where mock_exam_question_id = %s",
        (item["id"],),
    )
    assert mock_rows == [(made["id"],)]
    assert (
        db("select count(*) from public.question_ai_explanations where id = %s", (made["id"],))[0][
            0
        ]
        == 0
    )
    managed = state(get(owner, item["id"], "mock", view="manage"), (200,))
    assert managed["explanation"]["id"] == made["id"]

    # Someone else's session, another workspace's user: 404.
    other_session, _ = mock_submitted(owner, item)
    implemented(res := get(viewer, item["id"], "mock", mock_practice_session_id=other_session))
    assert res.status_code == 404
    implemented(res := get(outsider, item["id"], "mock", view="manage"))
    assert res.status_code == 404

    # A removed question and a deleted mock exam: 404.
    second = next(i for i in items if i["id"] != item["id"])
    second_session, _ = mock_submitted(viewer, second)
    owner.ok("DELETE", f"/mock-exam-questions/{second['id']}", None, (204,))
    implemented(res := get(viewer, second["id"], "mock", mock_practice_session_id=second_session))
    assert res.status_code == 404
    owner.ok("DELETE", f"/mock-exams/{item['mock_exam_id']}", None, (204,))
    implemented(res := get(viewer, item["id"], "mock", mock_practice_session_id=open_session["id"]))
    assert res.status_code == 404
