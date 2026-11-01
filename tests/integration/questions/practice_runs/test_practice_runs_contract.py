"""QVIEW-01 range practice contract (docs/screens/question-viewer.md C01-C05, C07; docs/questions.md
§12; docs/architecture.md §5/§6 `practice_runs`).

    POST /workspaces/{id}/practice-runs        resolve a range server-side into a fixed run
    GET  /practice-runs/{id}                   counts / progress / summary only (no content)
    GET  /practice-runs/{id}/items/{position}  one question, never its answer before submission
    GET  /practice-runs/{id}/results           one page (limit <= 200) of per-position results
    POST /practice-runs/{id}/finish            fix the summary
    POST /questions/{id}/practice-sessions     {practice_run_id, run_position}: a run position

QVIEW.0 (RED) marked every test `red`; QVIEW-B removed it from the `bank` tests, MOCK-P removes
it from the `mock` ones (implementation-plan §3 MOCK gate). C06 is a Vitest component contract
(QVIEW-W).
Request/response shapes P1-P7 are the assumptions in the header of
tests/e2e/fixtures/practice-runs.ts (keep both in sync). Uses the M4 question suite's fixtures
(../conftest.py: in-process app, per-test users, `quiz_api` role). The `postgres` superuser seeds
what no API creates in test time (book chapters, as test_overview_api.py does; 5,000 confirmed
questions for the size boundary) and reads rows no API exposes (`practice_runs.item_ids`/`seed`,
`practice_sessions.practice_run_id`, row counts of the history tables).
"""

from __future__ import annotations

import hashlib
import random
import uuid
from typing import Any

import psycopg
import pytest
from quiz_api.settings import LOCAL_CORS_ORIGINS

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
PROBLEM = "urn:quiz-workspace:problem:"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
MAX_RUN = 5_000
SHARE_COOKIE = "quiz_share_session"
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
CH1, CH2 = "1장 물의 순환", "2장 정수 처리"


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def admin(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


def count(sql: str, params: tuple[Any, ...] = ()) -> int:
    return int(admin(sql, params)[0][0])


def seed_chapters(workspace_id: str, titles: list[str]) -> list[str]:
    """A ready book whose active revision has one top-level chapter per title (in order)."""
    doc_id, rev_id = str(uuid.uuid4()), str(uuid.uuid4())
    key = f"workspaces/{workspace_id}/documents/{doc_id}/revisions/{rev_id}/source.pdf"
    ids: list[str] = []
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256, "
            "source_object_key, status) values (%s, %s, 'Book', 'book.pdf', 10, %s, %s, "
            "'processing')",
            (doc_id, workspace_id, hashlib.sha256(doc_id.encode()).hexdigest(), key),
        )
        conn.execute(
            "insert into public.document_revisions (id, workspace_id, document_id, "
            "revision_number, source_object_key) values (%s, %s, %s, 1, %s)",
            (rev_id, workspace_id, doc_id, key),
        )
        for i, title in enumerate(titles):
            row = conn.execute(
                "insert into public.chapters (workspace_id, document_id, document_revision_id, "
                "section_key, level, sort_order, title) values (%s, %s, %s, %s, 1, %s, %s) "
                "returning id",
                (workspace_id, doc_id, rev_id, f"s{i}", i, title),
            ).fetchone()
            assert row is not None
            ids.append(str(row[0]))
        conn.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (rev_id,),
        )
        conn.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (rev_id, doc_id),
        )
    return ids


def bulk_confirmed(workspace_id: str, n: int, start: int = 1) -> None:
    """`n` CONFIRMED short-answer questions (numbers start..start+n-1) without a chapter."""
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            "with q as (insert into public.questions (workspace_id, question_type, "
            "question_number, sort_order) select %s, 'SHORT_ANSWER', g, g "
            "from generate_series(%s::int, %s::int) g returning id, question_number) "
            "insert into public.question_revisions (workspace_id, question_id, version, stem) "
            "select %s, q.id, 1, 'bulk question ' || q.question_number from q",
            (workspace_id, start, start + n - 1, workspace_id),
        )
        conn.execute(
            "update public.questions q set active_revision_id = r.id, "
            "publication_status = 'CONFIRMED' from public.question_revisions r "
            "where q.workspace_id = %s and q.active_revision_id is null "
            "and r.question_id = q.id and r.version = 1",
            (workspace_id,),
        )


def mcq(
    label: str, chapter: int, n: int, chapter_id: str | None, answer: int = 0
) -> dict[str, Any]:
    texts = [f"{label}-{chapter}-{n} 보기 {x}" for x in "가나다라"]
    options = [{"id": f"o{i}", "text": t} for i, t in enumerate(texts)]
    return {
        "question_type": "MCQ",
        "stem": f"{label} {chapter}장 {n}번 문제: 알맞은 것을 고르시오.",
        "options": options,
        "correct_option_ids": [options[answer]["id"]],
        "is_multi_answer": False,
        "explanation": f"{label}-{chapter}-{n} 해설 비밀",
        "chapter_id": chapter_id,
        "question_number": n,
    }


def wrong_option(question: dict[str, Any]) -> str:
    correct = set(question["revision"]["correct_option_ids"] or [])
    return next(o["id"] for o in question["revision"]["options"] if o["id"] not in correct)


def answer_directly(client: Any, question: dict[str, Any], option_id: str) -> None:
    """A practice-panel answer outside any run (the existing practice API)."""
    session = client.ok("POST", f"/questions/{question['id']}/practice-sessions", {}, (201,))
    client.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": [option_id]}
    )


def start(client: Any, workspace_id: str, body: dict[str, Any], key: str | None = None) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    return client.call_with_headers(
        "POST", f"/workspaces/{workspace_id}/practice-runs", body, headers
    )


def bank(range_: dict[str, Any], *, random_order: bool = False, **extra: Any) -> dict[str, Any]:
    return {"source": "bank", "range": range_, "random_order": random_order, **extra}


def created(client: Any, workspace_id: str, body: dict[str, Any]) -> dict[str, Any]:
    res = start(client, workspace_id, body)
    out: dict[str, Any] = client.ok_response(res, "POST", "practice-runs", (201,))
    return out


def item(client: Any, run_id: str, position: int) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/practice-runs/{run_id}/items/{position}")
    return out


def order(client: Any, run: dict[str, Any]) -> list[str]:
    return [str(item(client, run["id"], i)["question_id"]) for i in range(1, run["total"] + 1)]


def run_session(client: Any, question_id: str, run_id: str, position: int) -> Any:
    return client.call(
        "POST",
        f"/questions/{question_id}/practice-sessions",
        {"practice_run_id": run_id, "run_position": position},
    )


def overview_ids(client: Any, workspace_id: str, query: str = "") -> list[str]:
    path = f"/workspaces/{workspace_id}/questions/overview" + (f"?{query}" if query else "")
    return [i["question_id"] for i in client.ok("GET", path)["items"]]


class Range:
    """Two chapters (1장 3 + 2장 2 CONFIRMED MCQs), two drafts, an archived 1장 question and a
    copy of 2장 2번 merged into it (UX7-DEDUP). The viewer answered 1장 2번 wrong directly and
    2장 2번 only through the merged copy (C07), the owner nothing."""

    def __init__(self, seed: Any, label: str) -> None:
        self.owner = seed.client(f"qview-{label}-owner")
        self.viewer = seed.client(f"qview-{label}-viewer")
        self.ws = self.owner.create_workspace()
        self.ws_id = str(self.ws["id"])
        seed.membership(self.ws_id, self.viewer.user, "viewer")
        self.ch1, self.ch2 = seed_chapters(self.ws_id, [CH1, CH2])
        tag = f"{label}-{uuid.uuid4().hex[:6]}"
        self.confirmed = [
            self.owner.create_question(self.ws_id, mcq(tag, c, n, ch))
            for c, ch, k in ((1, self.ch1, 3), (2, self.ch2, 2))
            for n in range(1, k + 1)
        ]
        self.drafts = [
            self.owner.create_question(
                self.ws_id, {**mcq(tag, 1, n, self.ch1), "publication_status": "DRAFT"}
            )
            for n in (5, 6)
        ]
        archived = self.owner.create_question(self.ws_id, mcq(tag, 1, 4, self.ch1))
        self.archived = self.owner.ok(
            "PATCH",
            f"/questions/{archived['id']}",
            {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
        )
        keep = self.confirmed[4]
        copy = self.owner.create_question(
            self.ws_id, {**mcq(tag, 2, 2, self.ch2), "question_number": 3}
        )
        answer_directly(self.viewer, self.confirmed[1], wrong_option(self.confirmed[1]))
        answer_directly(self.viewer, copy, wrong_option(copy))
        self.owner.ok(
            "POST",
            f"/workspaces/{self.ws_id}/question-duplicates/merge",
            {"groups": [{"keep_question_id": keep["id"], "duplicate_question_ids": [copy["id"]]}]},
        )
        self.duplicate = copy

    @property
    def heatmap(self) -> list[str]:
        return [str(q["id"]) for q in self.confirmed]


def guest_cookie(seed: Any, owner: Any, workspace_id: str) -> str:
    """A share link of the workspace exchanged for a guest share session cookie header."""
    link = owner.ok("POST", f"/workspaces/{workspace_id}/share-links", {}, (201,))
    for origin in LOCAL_CORS_ORIGINS:
        res = seed._http.request(
            "POST",
            f"/api/v1/shared/{link['id']}/sessions",
            json={"secret": link["secret"]},
            headers={"Origin": origin},
        )
        seed._http.cookies.clear()
        for raw in res.headers.get_list("set-cookie"):
            if raw.startswith(f"{SHARE_COOKIE}="):
                return raw.split(";", 1)[0]
    pytest.fail("share session exchange set no cookie")


def create_mock_exam(client: Any, workspace_id: str, question_ids: list[str]) -> dict[str, Any]:
    """P7: a `보기 섞기` mock exam of the given questions, generated and `ready`."""
    exam: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/mock-exams",
        {
            "name": f"모의 {uuid.uuid4().hex[:6]}",
            "config": {"variation_types": ["OPTION_SHUFFLE"], "question_count": len(question_ids)},
            "range": {"question_ids": question_ids},
        },
        (201, 202),
    )
    if exam.get("job_id"):
        client.wait_for_job(str(exam["job_id"]))
    current: dict[str, Any] = client.ok("GET", f"/mock-exams/{exam['id']}")
    assert current["status"] == "ready", current["status"]
    return current


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C01 range resolution
# ---------------------------------------------------------------------------------------------


def test_c01_range_resolves_to_live_confirmed_questions_of_this_workspace(seed: Any) -> None:
    r = Range(seed, "c01")
    owner = r.owner
    whole = created(owner, r.ws_id, bank({"all": True}))
    assert whole["total"] == 5
    assert whole["workspace_id"] == r.ws_id
    assert order(owner, whole) == r.heatmap  # drafts, the archived question and the merged copy
    assert created(owner, r.ws_id, bank({"chapter_ids": [r.ch2]}))["total"] == 2
    picked = created(owner, r.ws_id, bank({"question_ids": [r.heatmap[3], r.heatmap[0]]}))
    assert order(owner, picked) == [r.heatmap[0], r.heatmap[3]]  # Heatmap order, not request order
    without = created(
        owner, r.ws_id, bank({"chapter_ids": [r.ch1], "excluded_question_ids": [r.heatmap[1]]})
    )
    assert order(owner, without) == [r.heatmap[0], r.heatmap[2]]
    union = created(owner, r.ws_id, bank({"chapter_ids": [r.ch2], "question_ids": [r.heatmap[0]]}))
    assert order(owner, union) == [r.heatmap[0], r.heatmap[3], r.heatmap[4]]

    # Ids that are not live CONFIRMED questions of this workspace are refused, never dropped.
    other_ws = owner.create_workspace()
    foreign = owner.create_question(other_ws["id"], mcq("foreign", 1, 1, None))
    deleted = owner.create_question(r.ws_id, mcq("deleted", 1, 9, r.ch1))
    owner.ok("DELETE", f"/questions/{deleted['id']}", None, (204,))
    runs_before = count(
        "select count(*) from public.practice_runs where user_id = %s", (owner.user.id,)
    )
    for bad in (
        r.drafts[0]["id"],
        r.archived["id"],
        r.duplicate["id"],
        deleted["id"],
        foreign["id"],
        RANDOM_ID,
    ):
        res = start(owner, r.ws_id, bank({"question_ids": [r.heatmap[0], bad]}))
        seed.problem(res, 422, PROBLEM + "range-invalid")
    seed.problem(
        start(owner, r.ws_id, bank({"chapter_ids": [str(uuid.uuid4())]})),
        422,
        PROBLEM + "range-invalid",
    )
    # Nothing matches → 409, and no run row is written.
    seed.problem(
        start(owner, r.ws_id, bank({"all": True, "filters": {"status": ["incorrect"]}})),
        409,
        PROBLEM + "no-matching-questions",
    )
    seed.problem(
        start(owner, r.ws_id, bank({"question_ids": []})), 409, PROBLEM + "no-matching-questions"
    )
    runs_after = count(
        "select count(*) from public.practice_runs where user_id = %s", (owner.user.id,)
    )
    assert runs_after == runs_before

    # A client-supplied workspace_id / user_id is ignored: the run is the caller's, in the path's
    # workspace.
    spoofed = created(
        owner,
        r.ws_id,
        {**bank({"all": True}), "workspace_id": other_ws["id"], "user_id": r.viewer.user.id},
    )
    rows = admin(
        "select workspace_id::text, user_id::text from public.practice_runs where id = %s",
        (spoofed["id"],),
    )
    assert rows == [(r.ws_id, owner.user.id)]
    assert r.viewer.call("GET", f"/practice-runs/{spoofed['id']}").status_code == 404


def test_c01_filters_follow_the_callers_heatmap_state(seed: Any) -> None:
    r = Range(seed, "c01-filters")
    owner_q = r.confirmed[0]
    answer_directly(r.owner, owner_q, wrong_option(owner_q))
    r.owner.ok("PATCH", f"/questions/{r.confirmed[2]['id']}/my-state", {"is_favorite": True})
    for client, query, filters in (
        (r.viewer, "status=incorrect", {"status": ["incorrect"]}),
        (r.owner, "status=incorrect", {"status": ["incorrect"]}),
        (r.owner, "favorite=true", {"favorite": True}),
        (r.owner, "status=unseen", {"status": ["unseen"]}),
        (r.owner, "type=MCQ", {"type": "MCQ"}),
    ):
        expected = overview_ids(client, r.ws_id, query)
        run = created(client, r.ws_id, bank({"all": True, "filters": filters}))
        assert order(client, run) == expected, query
    viewer_wrong = overview_ids(r.viewer, r.ws_id, "status=incorrect")
    assert viewer_wrong == [r.heatmap[1], r.heatmap[4]]


def test_c01_idempotency_key_returns_the_same_run(seed: Any) -> None:
    r = Range(seed, "c01-idem")
    key = str(uuid.uuid4())
    first = start(r.owner, r.ws_id, bank({"all": True}, random_order=True), key)
    again = start(r.owner, r.ws_id, bank({"all": True}, random_order=True), key)
    one = r.owner.ok_response(first, "POST", "practice-runs", (201,))
    two = r.owner.ok_response(again, "POST", "practice-runs", (200, 201))
    assert two["id"] == one["id"]
    assert two["seed"] == one["seed"]


def test_c01_c02_five_thousand_is_the_cap_and_responses_do_not_grow(seed: Any) -> None:
    owner = seed.client("qview-c01-cap")
    ws = owner.create_workspace()
    ws_id = str(ws["id"])
    bulk_confirmed(ws_id, MAX_RUN)
    full = created(owner, ws_id, bank({"all": True}))
    assert full["total"] == MAX_RUN
    assert item(owner, full["id"], MAX_RUN)["position"] == MAX_RUN
    assert owner.call("GET", f"/practice-runs/{full['id']}/items/{MAX_RUN + 1}").status_code == 404
    assert owner.call("GET", f"/practice-runs/{full['id']}/items/0").status_code in {404, 422}

    small_ws = owner.create_workspace()
    bulk_confirmed(str(small_ws["id"]), 2)
    small = created(owner, str(small_ws["id"]), bank({"all": True}))
    big_body = owner.call("GET", f"/practice-runs/{full['id']}").content
    small_body = owner.call("GET", f"/practice-runs/{small['id']}").content
    assert len(big_body) < 2_000
    assert len(big_body) - len(small_body) < 100, "the run read must not grow with its size"
    assert "item_ids" not in owner.call("GET", f"/practice-runs/{full['id']}").json()

    page = owner.ok("GET", f"/practice-runs/{full['id']}/results?offset=4800&limit=200")
    assert page["total"] == MAX_RUN
    assert [i["position"] for i in page["items"]] == list(range(4801, 5001))
    res = owner.call("GET", f"/practice-runs/{full['id']}/results?offset=0&limit=201")
    assert res.status_code == 422

    # One more confirmed question: 5,001 → 422, nothing written.
    bulk_confirmed(ws_id, 1, start=MAX_RUN + 1)
    runs = count("select count(*) from public.practice_runs where user_id = %s", (owner.user.id,))
    seed.problem(start(owner, ws_id, bank({"all": True})), 422, PROBLEM + "practice-run-too-large")
    assert (
        count("select count(*) from public.practice_runs where user_id = %s", (owner.user.id,))
        == runs
    )
    # Explicit id lists are capped at 5,000 entries each (request validation).
    ids = [str(uuid.uuid4()) for _ in range(MAX_RUN + 1)]
    res = start(owner, ws_id, bank({"question_ids": ids}))
    assert res.status_code == 422


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C02 order and size
# ---------------------------------------------------------------------------------------------


def test_c02_order_is_heatmap_or_the_stored_seed_shuffle_and_never_changes(seed: Any) -> None:
    r = Range(seed, "c02")
    owner = r.owner
    ordered = created(owner, r.ws_id, bank({"all": True}))
    assert ordered["random_order"] is False
    assert order(owner, ordered) == r.heatmap

    expected = list(r.heatmap)
    random.Random(12345).shuffle(expected)  # noqa: S311 - the spec'd deterministic order
    shuffled = created(owner, r.ws_id, bank({"all": True}, random_order=True, seed=12345))
    assert shuffled["seed"] == 12345
    assert order(owner, shuffled) == expected
    same = created(owner, r.ws_id, bank({"all": True}, random_order=True, seed=12345))
    assert order(owner, same) == expected  # same seed + same range → same order

    # No seed: the server picks one, stores it and returns it on every read.
    chosen = created(owner, r.ws_id, bank({"all": True}, random_order=True))
    assert isinstance(chosen["seed"], int)
    expected_chosen = list(r.heatmap)
    random.Random(chosen["seed"]).shuffle(expected_chosen)  # noqa: S311
    assert order(owner, chosen) == expected_chosen
    assert owner.ok("GET", f"/practice-runs/{chosen['id']}")["seed"] == chosen["seed"]
    stored = admin(
        "select item_ids::text[], seed from public.practice_runs where id = %s", (chosen["id"],)
    )
    assert stored == [(expected_chosen, chosen["seed"])]

    # Later bank changes never reorder or grow an existing run.
    owner.create_question(r.ws_id, {**mcq("late", 1, 1, r.ch1), "question_number": 1})
    assert order(owner, ordered) == r.heatmap
    assert owner.ok("GET", f"/practice-runs/{ordered['id']}")["total"] == 5

    # The run read carries counts and progress only: no ids list, no question content.
    run = owner.ok("GET", f"/practice-runs/{ordered['id']}")
    assert not (_keys(run) & ({"item_ids", "items", "stem", "options"} | ANSWER_KEYS))
    assert set(run["summary"]) >= {"correct", "incorrect", "pending", "skipped"}


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C03 no answers before submission
# ---------------------------------------------------------------------------------------------


def _mixed(owner: Any, ws_id: str, label: str) -> list[dict[str, Any]]:
    return [
        owner.create_question(ws_id, mcq(label, 1, 1, None)),
        owner.create_question(
            ws_id,
            {
                "question_type": "SHORT_ANSWER",
                "stem": f"{label} 단답",
                "accepted_answers": [f"{label}-정답"],
                "explanation": f"{label} 단답 해설 비밀",
                "question_number": 2,
            },
        ),
        owner.create_question(
            ws_id,
            {
                "question_type": "ESSAY",
                "stem": f"{label} 서술형",
                "rubric": f"{label} 채점 기준 비밀",
                "explanation": f"{label} 서술형 해설 비밀",
                "question_number": 3,
            },
        ),
    ]


def _assert_clean(value: Any, secrets: list[str], what: str) -> None:
    assert not (_keys(value) & ANSWER_KEYS), f"{what} carries an answer field"
    text = str(value)
    for secret in secrets:
        assert secret not in text, f"{what} carries an answer text"


def test_c03_bank_run_reads_and_sessions_never_carry_answers_before_submission(seed: Any) -> None:
    owner = seed.client("qview-c03")
    ws_id = str(owner.create_workspace()["id"])
    label = f"c03-{uuid.uuid4().hex[:6]}"
    qs = _mixed(owner, ws_id, label)
    secrets = [f"{label}-1-1 해설 비밀", f"{label}-정답", f"{label} 채점 기준 비밀"]
    run = created(owner, ws_id, bank({"all": True}))
    _assert_clean(run, secrets, "run")
    _assert_clean(owner.ok("GET", f"/practice-runs/{run['id']}"), secrets, "run read")
    for position in (1, 2, 3):
        got = item(owner, run["id"], position)
        _assert_clean(got, secrets, f"item {position}")
        assert got["available"] is True
        assert got["attempt"] is None
    _assert_clean(
        owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200"),
        secrets,
        "results",
    )
    res = run_session(owner, qs[0]["id"], run["id"], 1)
    session = owner.ok_response(res, "POST", "run practice session", (201,))
    _assert_clean(session, secrets, "session")

    # Only the submission reveals that question's answer; the item shows it from then on.
    graded = owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [wrong_option(qs[0])]},
    )
    assert graded["result"] == "incorrect"
    assert graded["correct_option_ids"] == qs[0]["revision"]["correct_option_ids"]
    assert graded["explanation"] == f"{label}-1-1 해설 비밀"
    after = item(owner, run["id"], 1)
    assert after["attempt"]["result"] == "incorrect"
    assert after["attempt"]["explanation"] == f"{label}-1-1 해설 비밀"
    for position in (2, 3):
        _assert_clean(item(owner, run["id"], position), secrets[1:], f"item {position} after")


@pytest.mark.red
def test_c03_mock_run_reads_and_sessions_never_carry_answers_before_submission(seed: Any) -> None:
    owner = seed.client("qview-c03-mock")
    ws_id = str(owner.create_workspace()["id"])
    label = f"c03m-{uuid.uuid4().hex[:6]}"
    qs = [owner.create_question(ws_id, mcq(label, 1, n, None)) for n in (1, 2)]
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in qs])
    secrets = [f"{label}-1-1 해설 비밀", f"{label}-1-2 해설 비밀"]
    run = created(
        owner,
        ws_id,
        {
            "source": "mock",
            "mock_exam_id": exam["id"],
            "range": {"all": True},
            "random_order": False,
        },
    )
    assert run["source"] == "mock"
    assert run["total"] == 2
    got = item(owner, run["id"], 1)
    _assert_clean(got, secrets, "mock item")
    res = owner.call(
        "POST",
        f"/mock-exam-questions/{got['question_id']}/practice-sessions",
        {"practice_run_id": run["id"], "run_position": 1},
    )
    session = owner.ok_response(res, "POST", "mock practice session", (201,))
    _assert_clean(session, secrets, "mock session")
    graded = owner.ok(
        "POST",
        f"/mock-practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [session["options"][0]["id"]]},
    )
    assert graded["result"] in {"correct", "incorrect"}
    assert graded["explanation"] in secrets


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C04 records
# ---------------------------------------------------------------------------------------------


def test_c04_bank_run_records_in_the_question_tables_once_per_position(seed: Any) -> None:
    owner = seed.client("qview-c04")
    ws_id = str(owner.create_workspace()["id"])
    qs = [owner.create_question(ws_id, mcq("c04", 1, n, None)) for n in (1, 2)]
    run = created(owner, ws_id, bank({"all": True}))
    session = owner.ok_response(
        run_session(owner, qs[0]["id"], run["id"], 1), "POST", "run session", (201,)
    )
    rows = admin(
        "select practice_run_id::text, run_position from public.practice_sessions where id = %s",
        (session["id"],),
    )
    assert rows == [(run["id"], 1)]
    graded = owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [wrong_option(qs[0])]},
    )
    attempts = admin(
        "select a.question_id::text, s.practice_run_id::text from public.question_attempts a "
        "join public.practice_sessions s on s.id = a.practice_session_id where a.id = %s",
        (graded["attempt_id"],),
    )
    assert attempts == [(qs[0]["id"], run["id"])]
    overview = owner.ok("GET", f"/workspaces/{ws_id}/questions/overview")
    status = {i["question_id"]: i["status"] for i in overview["items"]}
    assert status[qs[0]["id"]] == "incorrect"

    # One submission per position: a new session or a second submit is refused.
    again = run_session(owner, qs[0]["id"], run["id"], 1)
    if again.status_code == 201:
        seed.problem(
            owner.call(
                "POST",
                f"/practice-sessions/{again.json()['id']}/submit",
                {"selected_option_ids": [wrong_option(qs[0])]},
            ),
            409,
            PROBLEM + "already-submitted",
        )
    else:
        seed.problem(again, 409, PROBLEM + "already-submitted")
    # A session must belong to its position's question.
    mismatch = run_session(owner, qs[0]["id"], run["id"], 2)
    assert mismatch.status_code in {409, 422}, mismatch.text[:200]
    assert (
        count(
            "select count(*) from public.question_attempts a join public.practice_sessions s "
            "on s.id = a.practice_session_id where s.practice_run_id = %s",
            (run["id"],),
        )
        == 1
    )

    # Finishing fixes the summary: the unanswered position counts as skipped.
    finished = owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert finished["finished_at"] is not None
    assert finished["summary"] == {"correct": 0, "incorrect": 1, "pending": 0, "skipped": 1}


@pytest.mark.red
def test_c04_mock_run_leaves_the_question_tables_unchanged(seed: Any) -> None:
    owner = seed.client("qview-c04-mock")
    ws_id = str(owner.create_workspace()["id"])
    qs = [owner.create_question(ws_id, mcq("c04m", 1, n, None)) for n in (1, 2)]
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in qs])

    def counts() -> tuple[int, ...]:
        row = admin(
            "select (select count(*) from public.practice_sessions where workspace_id = %s), "
            "(select count(*) from public.question_attempts where workspace_id = %s), "
            "(select count(*) from public.question_user_states where workspace_id = %s)",
            (ws_id, ws_id, ws_id),
        )
        return tuple(int(v) for v in row[0])

    before = counts()
    run = created(
        owner,
        ws_id,
        {
            "source": "mock",
            "mock_exam_id": exam["id"],
            "range": {"all": True},
            "random_order": False,
        },
    )
    got = item(owner, run["id"], 1)
    session = owner.ok(
        "POST",
        f"/mock-exam-questions/{got['question_id']}/practice-sessions",
        {"practice_run_id": run["id"], "run_position": 1},
        (201,),
    )
    owner.ok(
        "POST",
        f"/mock-practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [session["options"][0]["id"]]},
    )
    assert counts() == before
    assert (
        count(
            "select count(*) from public.mock_exam_practice_sessions where practice_run_id = %s",
            (run["id"],),
        )
        == 1
    )
    assert (
        count(
            "select count(*) from public.mock_exam_attempts a "
            "join public.mock_exam_practice_sessions s on s.id = a.mock_exam_practice_session_id "
            "where s.practice_run_id = %s",
            (run["id"],),
        )
        == 1
    )


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C05 authorization matrix
# ---------------------------------------------------------------------------------------------


def test_c05_runs_belong_to_their_creator_and_follow_the_workspace_state(seed: Any) -> None:
    owner = seed.client("qview-c05-owner")
    viewer = seed.client("qview-c05-viewer")
    outsider = seed.client("qview-c05-outsider")
    ws_id = str(owner.create_workspace()["id"])
    seed.membership(ws_id, viewer.user, "viewer")
    qs = [owner.create_question(ws_id, mcq("c05", 1, n, None)) for n in (1, 2)]
    run = created(owner, ws_id, bank({"all": True}))
    paths = [
        ("GET", f"/practice-runs/{run['id']}", None),
        ("GET", f"/practice-runs/{run['id']}/items/1", None),
        ("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200", None),
        ("POST", f"/practice-runs/{run['id']}/finish", {}),
    ]
    # Another member of the same workspace and an outsider: 404, same body as an unknown run.
    unknown = owner.call("GET", f"/practice-runs/{RANDOM_ID}")
    assert unknown.status_code == 404
    for client in (viewer, outsider):
        for method, path, body in paths:
            res = client.call(method, path, body)
            assert res.status_code == 404, f"{method} {path}: {res.status_code}"
            assert res.json()["detail"] == unknown.json()["detail"]
        res = run_session(client, qs[0]["id"], run["id"], 1)
        assert res.status_code == 404
    assert (
        outsider.call("POST", f"/workspaces/{ws_id}/practice-runs", bank({"all": True})).status_code
        == 404
    )

    # Every member may create and practise their own run (viewer included).
    mine = created(viewer, ws_id, bank({"all": True}))
    session = viewer.ok_response(
        run_session(viewer, qs[0]["id"], mine["id"], 1), "POST", "viewer session", (201,)
    )
    viewer.ok("POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["o0"]})
    # A position opened before the workspace is archived (submitted after it, below).
    open_before = viewer.ok_response(
        run_session(viewer, qs[1]["id"], mine["id"], 2), "POST", "viewer session 2", (201,)
    )

    # Archived workspace: create and read yes, practise no.
    owner.ok("POST", f"/workspaces/{ws_id}/archive")
    archived = created(owner, ws_id, bank({"all": True}))
    assert owner.call("GET", f"/practice-runs/{archived['id']}").status_code == 200
    assert owner.call("GET", f"/practice-runs/{archived['id']}/items/1").status_code == 200
    seed.problem(
        run_session(owner, qs[0]["id"], archived["id"], 1), 403, PROBLEM + "workspace-archived"
    )
    run_attempts = (
        "select count(*) from public.question_attempts a join public.practice_sessions s "
        "on s.id = a.practice_session_id where s.practice_run_id = %s"
    )
    assert count(run_attempts, (mine["id"],)) == 1
    seed.problem(
        viewer.call(
            "POST",
            f"/practice-sessions/{open_before['id']}/submit",
            {"selected_option_ids": ["o0"]},
        ),
        403,
        PROBLEM + "workspace-archived",
    )
    assert count(run_attempts, (mine["id"],)) == 1, "a refused submission writes no attempt"
    assert item(viewer, mine["id"], 2)["attempt"] is None
    owner.ok("POST", f"/workspaces/{ws_id}/restore")

    # Guests: no JWT → 401; a share session cookie only → 401/404.
    cookie = guest_cookie(seed, owner, ws_id)
    for method, path, body in [
        *paths,
        ("POST", f"/workspaces/{ws_id}/practice-runs", bank({"all": True})),
    ]:
        bare = seed._http.request(method, f"/api/v1{path}", json=body)
        seed._http.cookies.clear()
        assert bare.status_code == 401, f"{method} {path}: {bare.status_code}"
        shared = seed._http.request(method, f"/api/v1{path}", json=body, headers={"Cookie": cookie})
        seed._http.cookies.clear()
        assert shared.status_code in {401, 404}, f"{method} {path}: {shared.status_code}"

    # Soft-deleted workspace: every run route is 404.
    owner.ok("DELETE", f"/workspaces/{ws_id}", None, (200, 202, 204))
    for method, path, body in paths:
        assert owner.call(method, path, body).status_code == 404, f"{method} {path}"
    assert (
        owner.call("POST", f"/workspaces/{ws_id}/practice-runs", bank({"all": True})).status_code
        == 404
    )


# ---------------------------------------------------------------------------------------------
# QVIEW-01-C07 archived and merged duplicates
# ---------------------------------------------------------------------------------------------


def test_c07_ranges_match_the_heatmap_with_archived_and_merged_duplicates(seed: Any) -> None:
    r = Range(seed, "c07")
    viewer = r.viewer
    # Same selection as the Heatmap overview for the same user and filter.
    for query, filters in (
        ("", {}),
        ("status=incorrect", {"status": ["incorrect"]}),
        ("status=unseen", {"status": ["unseen"]}),
        (f"chapter={r.ch2}&status=incorrect", None),
    ):
        expected = overview_ids(viewer, r.ws_id, query)
        range_: dict[str, Any] = (
            {"chapter_ids": [r.ch2], "filters": {"status": ["incorrect"]}}
            if filters is None
            else {"all": True, "filters": filters}
        )
        assert order(viewer, created(viewer, r.ws_id, bank(range_))) == expected, query
    # 2장 2번 is "틀린 문제" only through the merged copy; the copy itself is never in a range.
    wrong = created(viewer, r.ws_id, bank({"all": True, "filters": {"status": ["incorrect"]}}))
    assert order(viewer, wrong) == [r.heatmap[1], r.heatmap[4]]
    for bad in (r.duplicate["id"], r.archived["id"], r.drafts[1]["id"]):
        seed.problem(
            start(viewer, r.ws_id, bank({"question_ids": [bad]})), 422, PROBLEM + "range-invalid"
        )

    # Archived (or merged away) after the run started: unavailable, counted as skipped.
    run = created(r.owner, r.ws_id, bank({"chapter_ids": [r.ch1]}))
    target = r.confirmed[2]
    r.owner.ok(
        "PATCH",
        f"/questions/{target['id']}",
        {"base_revision_id": target["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    gone = item(r.owner, run["id"], 3)
    assert gone["available"] is False
    assert not gone.get("stem")
    assert not gone.get("options")
    assert not (_keys(gone) & ANSWER_KEYS)
    assert run_session(r.owner, target["id"], run["id"], 3).status_code in {404, 409, 422}

    # A run submission on the kept question records on the kept question; the merged state is
    # computed by the view, attempts are never moved.
    keep = r.confirmed[4]
    mine = created(viewer, r.ws_id, bank({"question_ids": [keep["id"]]}))
    session = viewer.ok_response(
        run_session(viewer, keep["id"], mine["id"], 1), "POST", "run session", (201,)
    )
    graded = viewer.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": keep["revision"]["correct_option_ids"]},
    )
    assert admin(
        "select question_id::text from public.question_attempts where id = %s",
        (graded["attempt_id"],),
    ) == [(keep["id"],)]
    assert (
        count(
            "select count(*) from public.question_attempts where question_id = %s and user_id = %s",
            (r.duplicate["id"], viewer.user.id),
        )
        == 1
    )  # the copy's own wrong answer stays where it was
    finished = r.owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert finished["summary"]["skipped"] == 3
    results = r.owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    assert [i["result"] for i in results["items"]] == ["skipped", "skipped", "skipped"]


# ---------------------------------------------------------------------------------------------
# QVIEW-B review follow-ups (Codex P2s)
# ---------------------------------------------------------------------------------------------


def test_c04_resuming_a_position_with_an_idempotency_key_replays_it(seed: Any) -> None:
    """A resumed open position is stored under its Idempotency-Key like a new session: a retry
    replays it (no new view write), also after the position was submitted, and the key cannot be
    reused with another body."""
    owner = seed.client("qview-idem-resume")
    ws_id = str(owner.create_workspace()["id"])
    qs = [owner.create_question(ws_id, mcq("idem", 1, n, None)) for n in (1, 2)]
    run = created(owner, ws_id, bank({"all": True}))
    opened = owner.ok_response(
        run_session(owner, qs[0]["id"], run["id"], 1), "POST", "first open", (201,)
    )
    path = f"/questions/{qs[0]['id']}/practice-sessions"
    body = {"practice_run_id": run["id"], "run_position": 1}
    key = {"Idempotency-Key": str(uuid.uuid4())}
    resumed = owner.call_with_headers("POST", path, body, key)
    assert resumed.status_code == 201, resumed.text[:200]
    assert resumed.json()["id"] == opened["id"]

    def last_viewed() -> Any:
        return admin(
            "select last_viewed_at from public.question_user_states "
            "where user_id = %s and question_id = %s",
            (owner.user.id, qs[0]["id"]),
        )

    viewed = last_viewed()
    again = owner.call_with_headers("POST", path, body, key)
    assert again.status_code == 201
    assert again.headers.get("idempotent-replayed") == "true"
    assert again.json() == resumed.json()
    assert last_viewed() == viewed, "a replay must not record another view"

    owner.ok(
        "POST",
        f"/practice-sessions/{opened['id']}/submit",
        {"selected_option_ids": [wrong_option(qs[0])]},
    )
    after = owner.call_with_headers("POST", path, body, key)
    assert after.status_code == 201, "a retry after submission replays the original response"
    assert after.json()["id"] == opened["id"]
    seed.problem(
        owner.call_with_headers(
            "POST", path, {"practice_run_id": run["id"], "run_position": 2}, key
        ),
        409,
        PROBLEM + "idempotency-key-reused",
    )
