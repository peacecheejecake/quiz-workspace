"""QVIEW-01 range practice contract (docs/screens/question-viewer.md C01-C05, C07; docs/questions.md
§12; docs/architecture.md §5/§6 `practice_runs`).

    POST /workspaces/{id}/practice-runs        resolve a range server-side into a fixed run
    GET  /practice-runs/{id}                   counts / progress / summary only (no content)
    GET  /practice-runs/{id}/items/{position}  one question, never its answer before submission
    GET  /practice-runs/{id}/results           one page (limit <= 200) of per-position results
    POST /practice-runs/{id}/finish            fix the summary
    POST /questions/{id}/practice-sessions     {practice_run_id, run_position}: a run position

QVIEW.0 (RED) marked every test `red`; QVIEW-B removed it from the `bank` tests, MOCK-P from the
`mock` ones (implementation-plan §3 MOCK gate). C06 is a Vitest component contract
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
import os
import random
import uuid
from typing import Any

import psycopg
import pytest
from quiz_api.practice_grading import run_option_seed, shuffled_option_ids
from quiz_api.settings import LOCAL_CORS_ORIGINS

pytestmark = pytest.mark.infra

DB_ADMIN_URL = os.environ.get(
    "QUIZ_DB_ADMIN_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
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
    """P7: a `보기 섞기` mock exam of the given questions, generated and `ready` (MOCK-B's shape:
    `title`, the job of `latest_generation`)."""
    exam: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/mock-exams",
        {
            "title": f"모의 {uuid.uuid4().hex[:6]}",
            "config": {"variation_types": ["OPTION_SHUFFLE"], "question_count": len(question_ids)},
            "range": {"question_ids": question_ids},
        },
        (202,),
    )
    assert exam["status"] == "ready"
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


def test_ux12_chapterrun_c03_a_shuffled_run_fixes_each_positions_options(seed: Any) -> None:
    r = Range(seed, "shuffle")
    owner = r.owner
    plain = created(owner, r.ws_id, bank({"chapter_ids": [r.ch1]}))
    assert plain["shuffle_options"] is False
    run = created(owner, r.ws_id, bank({"chapter_ids": [r.ch1]}, shuffle_options=True, seed=7))
    assert run["shuffle_options"] is True
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["shuffle_options"] is True

    before = item(owner, run["id"], 1)
    shown = [o["id"] for o in before["options"]]
    canonical = [o["id"] for o in item(owner, plain["id"], 1)["options"]]
    assert shown == shuffled_option_ids(canonical, run_option_seed(7, 1))

    # The session stores the order the item promised, and a resumed one keeps it.
    res = run_session(owner, before["question_id"], run["id"], 1)
    session = owner.ok_response(res, "POST", "run session", (201,))
    assert session["displayed_option_ids"] == shown
    assert [o["id"] for o in item(owner, run["id"], 1)["options"]] == shown
    res = run_session(owner, before["question_id"], run["id"], 1)
    resumed = owner.ok_response(res, "POST", "run session", (201,))
    assert resumed["displayed_option_ids"] == shown

    # Grading stays on stable ids, wherever the correct option is shown.
    question = next(q for q in r.confirmed if q["id"] == before["question_id"])
    owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": question["revision"]["correct_option_ids"]},
    )
    done = item(owner, run["id"], 1)
    assert done["attempt"]["result"] == "correct"
    assert [o["id"] for o in done["options"]] == shown
    assert admin(
        "select displayed_option_ids from public.question_attempts where practice_session_id = %s",
        (session["id"],),
    ) == [(shown,)]

    # A mock run has its own question copies and refuses the setting.
    body = {"source": "mock", "mock_exam_id": RANDOM_ID, "range": {"all": True}}
    assert start(owner, r.ws_id, {**body, "shuffle_options": True}).status_code == 422


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
            "join public.mock_exam_practice_sessions s on s.id = a.practice_session_id "
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


def test_c07_submitted_positions_that_become_unavailable_count_as_skipped(seed: Any) -> None:
    """Archived or deleted after submission: the position is unavailable and skipped in the
    summary and the results (questions.md §12, QVIEW-01 state table); attempts stay."""
    owner = seed.client("qview-gone-submitted")
    ws_id = str(owner.create_workspace()["id"])
    qs = [owner.create_question(ws_id, mcq("gone", 1, n, None)) for n in (1, 2, 3)]
    run = created(owner, ws_id, bank({"all": True}))
    for position, question in ((1, qs[0]), (2, qs[1])):
        session = owner.ok_response(
            run_session(owner, question["id"], run["id"], position), "POST", "open", (201,)
        )
        owner.ok(
            "POST",
            f"/practice-sessions/{session['id']}/submit",
            {"selected_option_ids": question["revision"]["correct_option_ids"]},
        )
    owner.ok_response(run_session(owner, qs[2]["id"], run["id"], 3), "POST", "open 3", (201,))
    owner.ok(
        "PATCH",
        f"/questions/{qs[0]['id']}",
        {"base_revision_id": qs[0]["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    owner.ok("DELETE", f"/questions/{qs[1]['id']}", None, (204,))
    for position in (1, 2):
        assert item(owner, run["id"], position)["available"] is False

    current = owner.ok("GET", f"/practice-runs/{run['id']}")
    assert current["summary"] == {"correct": 0, "incorrect": 0, "pending": 0, "skipped": 2}
    assert current["answered"] == 0
    results = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    assert [i["result"] for i in results["items"]] == ["skipped", "skipped", None]
    finished = owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert finished["summary"] == {"correct": 0, "incorrect": 0, "pending": 0, "skipped": 3}
    results = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    assert [i["result"] for i in results["items"]] == ["skipped", "skipped", "skipped"]
    run_attempts = (
        "select count(*) from public.question_attempts a join public.practice_sessions s "
        "on s.id = a.practice_session_id where s.practice_run_id = %s"
    )
    assert count(run_attempts, (run["id"],)) == 2, "historical attempts are never touched"


# ---------------------------------------------------------------------------------------------
# MOCK-P: mock exam runs (QVIEW-01-C01~C05 for `source=mock`, MOCK-01 decision n)
# ---------------------------------------------------------------------------------------------


def mock_questions(client: Any, exam_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok(
        "GET", f"/mock-exams/{exam_id}/questions?include=answers"
    )["items"]
    return sorted(items, key=lambda q: int(q["position"]))


def mock(exam_id: str, range_: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"source": "mock", "mock_exam_id": exam_id, "range": range_, **extra}


def mock_session(client: Any, question_id: str, run_id: str, position: int) -> Any:
    return client.call(
        "POST",
        f"/mock-exam-questions/{question_id}/practice-sessions",
        {"practice_run_id": run_id, "run_position": position},
    )


def mock_submit(client: Any, session_id: str, option_ids: list[str]) -> Any:
    return client.call(
        "POST", f"/mock-practice-sessions/{session_id}/submit", {"selected_option_ids": option_ids}
    )


def mock_wrong(question: dict[str, Any]) -> str:
    correct = set(question["correct_option_ids"] or [])
    return next(o["id"] for o in question["options"] if o["id"] not in correct)


def test_c01_mock_run_ranges_are_the_mock_exams_listed_questions(seed: Any) -> None:
    owner = seed.client("qview-mock-range")
    ws_id = str(owner.create_workspace()["id"])
    bank_qs = [owner.create_question(ws_id, mcq("mr", 1, n, None)) for n in (1, 2, 3)]
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in bank_qs])
    mq = [q["id"] for q in mock_questions(owner, exam["id"])]
    assert len(mq) == 3

    # Mock exam order, whatever order the request listed them in; exclusions; the type filter.
    picked = created(owner, ws_id, mock(exam["id"], {"question_ids": [mq[2], mq[0]]}))
    assert picked["source"] == "mock"
    assert picked["mock_exam_id"] == exam["id"]
    assert order(owner, picked) == [mq[0], mq[2]]
    without = created(
        owner, ws_id, mock(exam["id"], {"all": True, "excluded_question_ids": [mq[1]]})
    )
    assert order(owner, without) == [mq[0], mq[2]]
    typed = created(owner, ws_id, mock(exam["id"], {"all": True, "filters": {"type": "MCQ"}}))
    assert typed["total"] == 3
    seed.problem(
        start(owner, ws_id, mock(exam["id"], {"all": True, "filters": {"type": "ESSAY"}})),
        409,
        PROBLEM + "no-matching-questions",
    )
    # Bank ids, chapters and personal-state filters are no mock exam range; nothing is dropped.
    for bad in (
        {"question_ids": [bank_qs[0]["id"]]},
        {"question_ids": [mq[0], RANDOM_ID]},
        {"all": True, "excluded_question_ids": [bank_qs[0]["id"]]},
        {"chapter_ids": ["none"]},
        {"all": True, "filters": {"status": ["unseen"]}},
        {"all": True, "filters": {"favorite": True}},
        {"all": True, "filters": {"retry": True}},
    ):
        seed.problem(start(owner, ws_id, mock(exam["id"], bad)), 422, PROBLEM + "range-invalid")
    # A bank run cannot practise mock exam questions either.
    seed.problem(
        start(owner, ws_id, bank({"question_ids": [mq[0]]})), 422, PROBLEM + "range-invalid"
    )
    # Unknown and foreign mock exams answer one 404.
    other_ws = str(owner.create_workspace()["id"])
    foreign_q = owner.create_question(other_ws, mcq("mr-f", 1, 1, None))
    foreign = create_mock_exam(owner, other_ws, [foreign_q["id"]])
    for exam_id in (RANDOM_ID, foreign["id"]):
        seed.problem(start(owner, ws_id, mock(exam_id, {"all": True})), 404)
    # The run stores the generation it started on (superuser read: no API exposes it).
    assert admin(
        "select mock_exam_generation_id::text from public.practice_runs where id = %s",
        (picked["id"],),
    ) == [(exam["current_generation"]["id"],)]


def test_c04_mock_run_positions_are_submitted_once_and_keep_their_questions(seed: Any) -> None:
    owner = seed.client("qview-mock-once")
    ws_id = str(owner.create_workspace()["id"])
    bank_qs = [owner.create_question(ws_id, mcq("mo", 1, n, None)) for n in (1, 2, 3)]
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in bank_qs])
    mq = mock_questions(owner, exam["id"])
    run = created(owner, ws_id, mock(exam["id"], {"all": True}))
    assert order(owner, run) == [q["id"] for q in mq]

    # Grading is by option id; the result reveals that question's answers only.
    first = owner.ok_response(
        mock_session(owner, mq[0]["id"], run["id"], 1), "POST", "mock session", (201,)
    )
    assert (first["practice_run_id"], first["run_position"]) == (run["id"], 1)
    graded = owner.ok_response(
        mock_submit(owner, first["id"], [mock_wrong(mq[0])]), "POST", "submit", (200,)
    )
    assert graded["result"] == "incorrect"
    assert graded["correct_option_ids"] == mq[0]["correct_option_ids"]
    assert graded["explanation"] == mq[0]["explanation"]
    got = item(owner, run["id"], 1)
    assert got["attempt"]["result"] == "incorrect"
    assert got["attempt"]["submitted_answer"]["selected_option_ids"] == [mock_wrong(mq[0])]
    # One submission per position: a new session and a second submit are refused.
    seed.problem(mock_session(owner, mq[0]["id"], run["id"], 1), 409, PROBLEM + "already-submitted")
    seed.problem(
        mock_submit(owner, first["id"], mq[0]["correct_option_ids"]),
        409,
        PROBLEM + "already-submitted",
    )
    # A session practises its position's question; the bank route cannot open a mock position.
    assert mock_session(owner, mq[0]["id"], run["id"], 2).status_code == 422
    assert run_session(owner, mq[1]["id"], run["id"], 2).status_code == 404
    # An open position is resumed, not duplicated.
    second = owner.ok_response(
        mock_session(owner, mq[1]["id"], run["id"], 2), "POST", "mock session", (201,)
    )
    again = owner.ok_response(
        mock_session(owner, mq[1]["id"], run["id"], 2), "POST", "resume", (201,)
    )
    assert again["id"] == second["id"]

    # Taken out of the mock exam mid-run: unavailable, no submission, counted as skipped.
    assert owner.call("DELETE", f"/mock-exam-questions/{mq[1]['id']}").status_code == 204
    assert item(owner, run["id"], 2)["available"] is False
    assert mock_submit(owner, second["id"], [mock_wrong(mq[1])]).status_code == 404
    # 다시 만들기 mid-run (decision n): the run keeps the questions it started with.
    remade = owner.ok("POST", f"/mock-exams/{exam['id']}/generations", {}, (202,))
    assert remade["status"] == "ready"
    new_ids = {q["id"] for q in mock_questions(owner, exam["id"])}
    assert len(new_ids) == 3
    assert not new_ids & {q["id"] for q in mq}
    third = item(owner, run["id"], 3)
    assert (third["available"], third["question_id"]) == (True, mq[2]["id"])
    s3 = owner.ok_response(
        mock_session(owner, mq[2]["id"], run["id"], 3), "POST", "old round", (201,)
    )
    owner.ok_response(
        mock_submit(owner, s3["id"], mq[2]["correct_option_ids"]), "POST", "submit", (200,)
    )
    # Outside a run only what the mock exam lists now can be opened.
    seed.problem(
        owner.call("POST", f"/mock-exam-questions/{mq[2]['id']}/practice-sessions", {}), 404
    )
    # A new run counts the current generation only.
    fresh = created(owner, ws_id, mock(exam["id"], {"all": True}))
    assert set(order(owner, fresh)) == new_ids

    # The results summary covers mock positions.
    results = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    assert [r["result"] for r in results["items"]] == ["incorrect", "skipped", "correct"]
    assert [r["available"] for r in results["items"]] == [True, False, True]
    assert results["items"][0]["preview"]
    summary = {"correct": 1, "incorrect": 1, "pending": 0, "skipped": 1}
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["summary"] == summary

    # 삭제 mid-run (decision n): the started run stays readable; a new run is 404.
    assert owner.call("DELETE", f"/mock-exams/{exam['id']}").status_code == 204
    assert item(owner, run["id"], 1)["attempt"]["result"] == "incorrect"
    seed.problem(start(owner, ws_id, mock(exam["id"], {"all": True})), 404)
    finished = owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert finished["summary"] == summary
    seed.problem(
        mock_session(owner, mq[0]["id"], run["id"], 1), 409, PROBLEM + "practice-run-finished"
    )
    run_attempts = count(
        "select count(*) from public.mock_exam_attempts a "
        "join public.mock_exam_practice_sessions s on s.id = a.practice_session_id "
        "where s.practice_run_id = %s",
        (run["id"],),
    )
    assert run_attempts == 2


def test_c05_mock_practice_follows_roles_and_the_workspace_state(seed: Any) -> None:
    owner = seed.client("qview-mock-c05-owner")
    editor = seed.client("qview-mock-c05-editor")
    viewer = seed.client("qview-mock-c05-viewer")
    outsider = seed.client("qview-mock-c05-outsider")
    ws_id = str(owner.create_workspace()["id"])
    seed.membership(ws_id, editor.user, "editor")
    seed.membership(ws_id, viewer.user, "viewer")
    bank_qs = [owner.create_question(ws_id, mcq("m5", 1, n, None)) for n in (1, 2)]
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in bank_qs])
    mq = mock_questions(owner, exam["id"])

    # Every member practises (viewer included), standalone and in their own run.
    for member in (owner, editor, viewer):
        session = member.ok(
            "POST", f"/mock-exam-questions/{mq[0]['id']}/practice-sessions", {}, (201,)
        )
        assert session["practice_run_id"] is None
        out = member.ok(
            "POST",
            f"/mock-practice-sessions/{session['id']}/submit",
            {"selected_option_ids": mq[0]["correct_option_ids"]},
        )
        assert out["result"] == "correct"
    mine = created(viewer, ws_id, mock(exam["id"], {"all": True}))
    viewer_session = viewer.ok_response(
        mock_session(viewer, mq[0]["id"], mine["id"], 1), "POST", "viewer run", (201,)
    )
    # Another member's run or session, and outsiders: one 404.
    seed.problem(mock_session(owner, mq[0]["id"], mine["id"], 1), 404)
    seed.problem(mock_submit(owner, viewer_session["id"], ["o0"]), 404)
    seed.problem(
        outsider.call("POST", f"/mock-exam-questions/{mq[0]['id']}/practice-sessions", {}), 404
    )
    seed.problem(mock_submit(outsider, viewer_session["id"], ["o0"]), 404)
    seed.problem(start(outsider, ws_id, mock(exam["id"], {"all": True})), 404)
    seed.problem(owner.call("POST", f"/mock-exam-questions/{RANDOM_ID}/practice-sessions", {}), 404)

    # Archived: runs can be created and read, nothing can be practised (403).
    open_before = viewer.ok_response(
        mock_session(viewer, mq[1]["id"], mine["id"], 2), "POST", "open before", (201,)
    )
    owner.ok("POST", f"/workspaces/{ws_id}/archive")
    archived = created(owner, ws_id, mock(exam["id"], {"all": True}))
    assert item(owner, archived["id"], 1)["available"] is True
    archived_problem = PROBLEM + "workspace-archived"
    seed.problem(mock_session(owner, mq[0]["id"], archived["id"], 1), 403, archived_problem)
    seed.problem(
        owner.call("POST", f"/mock-exam-questions/{mq[0]['id']}/practice-sessions", {}),
        403,
        archived_problem,
    )
    seed.problem(mock_submit(viewer, open_before["id"], ["o0"]), 403, archived_problem)
    seed.problem(
        viewer.call(
            "POST",
            f"/mock-practice-sessions/{open_before['id']}/self-grade",
            {"result": "correct"},
        ),
        403,
        archived_problem,
    )
    assert item(viewer, mine["id"], 2)["attempt"] is None
    owner.ok("POST", f"/workspaces/{ws_id}/restore")

    # Guests: no JWT → 401; a share session cookie only → 401/404.
    cookie = guest_cookie(seed, owner, ws_id)
    submit_path = f"/mock-practice-sessions/{viewer_session['id']}"
    for path, body in (
        (f"/mock-exam-questions/{mq[0]['id']}/practice-sessions", {}),
        (f"{submit_path}/submit", {"selected_option_ids": ["o0"]}),
        (f"{submit_path}/self-grade", {"result": "correct"}),
        (f"/workspaces/{ws_id}/practice-runs", mock(exam["id"], {"all": True})),
    ):
        bare = seed._http.request("POST", f"/api/v1{path}", json=body)
        seed._http.cookies.clear()
        assert bare.status_code == 401, f"{path}: {bare.status_code}"
        shared = seed._http.request("POST", f"/api/v1{path}", json=body, headers={"Cookie": cookie})
        seed._http.cookies.clear()
        assert shared.status_code in {401, 404}, f"{path}: {shared.status_code}"


def test_c04_mock_pending_answers_are_self_graded_once(seed: Any) -> None:
    owner = seed.client("qview-mock-pending")
    ws_id = str(owner.create_workspace()["id"])
    essay = owner.create_question(
        ws_id,
        {
            "question_type": "ESSAY",
            "stem": "모의 서술형: 물의 순환을 설명하시오.",
            "rubric": "증발·응결·강수",
            "explanation": "모의 서술 해설 비밀",
        },
    )
    exam = create_mock_exam(owner, ws_id, [essay["id"]])
    [mq] = mock_questions(owner, exam["id"])
    assert mq["question_type"] == "ESSAY"
    session = owner.ok("POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,))
    assert not set(session) & ANSWER_KEYS
    self_grade = f"/mock-practice-sessions/{session['id']}/self-grade"
    not_pending = PROBLEM + "practice-session-not-pending"
    seed.problem(owner.call("POST", self_grade, {"result": "correct"}), 409, not_pending)
    # An MCQ answer to an essay is refused without an attempt.
    assert mock_submit(owner, session["id"], ["o0"]).status_code == 422
    pending = owner.ok(
        "POST", f"/mock-practice-sessions/{session['id']}/submit", {"answer_text": "증발과 강수"}
    )
    assert (pending["result"], pending["state"]) == ("pending", "pending_grade")
    assert pending["rubric"] == "증발·응결·강수"
    graded = owner.ok("POST", self_grade, {"result": "correct"})
    assert graded["grades_attempt_id"] == pending["attempt_id"]
    seed.problem(owner.call("POST", self_grade, {"result": "incorrect"}), 409, not_pending)
    rows = admin(
        "select result, grading_method, grades_attempt_id::text from public.mock_exam_attempts "
        "where practice_session_id = %s order by submitted_at, id",
        (session["id"],),
    )
    assert rows == [("pending", None, None), ("correct", "self", pending["attempt_id"])]


def test_c05_standalone_sessions_end_with_their_mock_exam_round_and_workspace(seed: Any) -> None:
    """MOCK-01-C05/C04: outside a run only what the mock exam lists now is practised — a
    standalone session opened before 삭제 or 다시 만들기 cannot be submitted or self-graded
    afterwards (404, no attempt, no answers); a run keeps its questions (decision n)."""
    owner = seed.client("qview-mock-standalone")
    ws_id = str(owner.create_workspace()["id"])
    mcqs = [owner.create_question(ws_id, mcq("ms", 1, n, None)) for n in (1, 2)]
    essay = owner.create_question(
        ws_id,
        {"question_type": "ESSAY", "stem": "모의 단독 서술형", "explanation": "단독 해설 비밀"},
    )

    def opened(exam_id: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        return [
            (q, owner.ok("POST", f"/mock-exam-questions/{q['id']}/practice-sessions", {}, (201,)))
            for q in mock_questions(owner, exam_id)
        ]

    def attempts(session_id: str) -> int:
        return count(
            "select count(*) from public.mock_exam_attempts where practice_session_id = %s",
            (session_id,),
        )

    def refused(res: Any, session_id: str, before: int) -> None:
        seed.problem(res, 404)
        assert "해설 비밀" not in res.text
        assert "correct_option_ids" not in res.text
        assert attempts(session_id) == before

    # 삭제: open MCQ and pending essay sessions are over; the run continues.
    exam = create_mock_exam(owner, ws_id, [mcqs[0]["id"], essay["id"]])
    sessions = opened(exam["id"])
    (q_mcq, s_mcq) = next(p for p in sessions if p[0]["question_type"] == "MCQ")
    (_, s_essay) = next(p for p in sessions if p[0]["question_type"] == "ESSAY")
    owner.ok("POST", f"/mock-practice-sessions/{s_essay['id']}/submit", {"answer_text": "답"})
    run = created(owner, ws_id, mock(exam["id"], {"question_ids": [q_mcq["id"]]}))
    in_run = owner.ok_response(
        mock_session(owner, q_mcq["id"], run["id"], 1), "POST", "run session", (201,)
    )
    assert owner.call("DELETE", f"/mock-exams/{exam['id']}").status_code == 204
    refused(mock_submit(owner, s_mcq["id"], q_mcq["correct_option_ids"]), s_mcq["id"], 0)
    refused(
        owner.call(
            "POST", f"/mock-practice-sessions/{s_essay['id']}/self-grade", {"result": "correct"}
        ),
        s_essay["id"],
        1,
    )
    graded = mock_submit(owner, in_run["id"], q_mcq["correct_option_ids"])
    assert graded.status_code == 200, graded.text[:200]

    # 다시 만들기: a session of the superseded round is over; the new round is practised.
    remade_exam = create_mock_exam(owner, ws_id, [mcqs[1]["id"]])
    [(old_q, old_s)] = opened(remade_exam["id"])
    remade = owner.ok("POST", f"/mock-exams/{remade_exam['id']}/generations", {}, (202,))
    assert remade["status"] == "ready"
    refused(mock_submit(owner, old_s["id"], old_q["correct_option_ids"]), old_s["id"], 0)
    [(new_q, new_s)] = opened(remade_exam["id"])
    assert new_q["id"] != old_q["id"]
    ok = mock_submit(owner, new_s["id"], new_q["correct_option_ids"])
    assert ok.status_code == 200, ok.text[:200]

    # A soft-deleted workspace: every mock practice route is 404.
    [(last_q, last_s)] = opened(remade_exam["id"])
    owner.ok("DELETE", f"/workspaces/{ws_id}", None, (200, 202, 204))
    seed.problem(
        owner.call("POST", f"/mock-exam-questions/{last_q['id']}/practice-sessions", {}), 404
    )
    refused(mock_submit(owner, last_s["id"], last_q["correct_option_ids"]), last_s["id"], 0)
    seed.problem(
        owner.call(
            "POST", f"/mock-practice-sessions/{last_s['id']}/self-grade", {"result": "correct"}
        ),
        404,
    )
    seed.problem(mock_session(owner, q_mcq["id"], run["id"], 1), 404)


def test_ux10_play_bank_count_selects_stable_prefix_and_rejects_oversize(seed: Any) -> None:
    r = Range(seed, "ux10-count")
    ordered = created(r.owner, r.ws_id, bank({"all": True}, question_count=2))
    assert order(r.owner, ordered) == r.heatmap[:2]
    expected = list(r.heatmap)
    random.Random(12345).shuffle(expected)  # noqa: S311 - deterministic run seed
    shuffled = created(
        r.owner, r.ws_id, bank({"all": True}, random_order=True, seed=12345, question_count=2)
    )
    assert order(r.owner, shuffled) == expected[:2]
    assert order(r.owner, shuffled) == order(r.owner, shuffled)
    assert start(r.owner, r.ws_id, bank({"all": True}, question_count=6)).status_code == 422


def test_ux10_play_mock_result_source_metadata_and_chapterless_fallback(seed: Any) -> None:
    r = Range(seed, "ux10-metadata")
    chapterless = r.owner.create_question(r.ws_id, mcq("chapterless", 0, 9, None))
    exam = create_mock_exam(r.owner, r.ws_id, [r.heatmap[0], chapterless["id"]])
    run = created(r.owner, r.ws_id, mock(exam["id"], {"all": True}))
    page = r.owner.ok("GET", f"/practice-runs/{run['id']}/results")
    assert len(page["items"]) == 2
    assert any(
        item["chapter_id"] == r.ch1 and item["question_number"] is not None
        for item in page["items"]
    )
    assert any(item["chapter_id"] is None for item in page["items"])
    assert not (_keys(page) & ANSWER_KEYS)
    admin("update public.questions set deleted_at = now() where id = %s", (r.heatmap[0],))
    after = r.owner.ok("GET", f"/practice-runs/{run['id']}/results")
    assert all(item["chapter_id"] is None for item in after["items"])


def test_ux11_return_ac01_standalone_bank_retry_preserves_run_result(seed: Any) -> None:
    owner = seed.client("ux11-return-bank")
    workspace = str(owner.create_workspace()["id"])
    question = owner.create_question(workspace, mcq("ux11", 1, 1, None))
    run = created(owner, workspace, bank({"all": True}))
    original = owner.ok_response(
        run_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok(
        "POST",
        f"/practice-sessions/{original['id']}/submit",
        {"selected_option_ids": [wrong_option(question)]},
    )
    owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    before = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    before_summary = owner.ok("GET", f"/practice-runs/{run['id']}")["summary"]
    path = f"/practice-runs/{run['id']}/items/1/retry-session"
    key = str(uuid.uuid4())
    generic_path = f"/questions/{question['id']}/practice-sessions"
    generic = owner.ok_response(
        owner.call_with_headers("POST", generic_path, {}, {"Idempotency-Key": key}),
        "POST",
        generic_path,
        (201,),
    )
    retry = owner.ok_response(
        owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key}), "POST", path, (201,)
    )
    replayed = owner.ok_response(
        owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key}), "POST", path, (201,)
    )
    assert replayed["id"] == retry["id"]
    assert retry["id"] != generic["id"]
    assert not (_keys(retry) & ANSWER_KEYS)
    assert retry["id"] != original["id"]
    assert retry.get("practice_run_id") is None
    assert retry.get("run_position") is None
    owner.ok(
        "POST",
        f"/practice-sessions/{retry['id']}/submit",
        {"selected_option_ids": question["revision"]["correct_option_ids"]},
    )
    assert owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200") == before
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["summary"] == before_summary
    assert (
        count(
            "select count(*) from public.question_attempts where question_id = %s",
            (question["id"],),
        )
        == 2
    )
    owner.ok("POST", f"/questions/{question['id']}/practice-reset", {})
    assert owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key}).status_code == 409
    owner.ok("POST", f"/workspaces/{workspace}/archive")
    assert owner.call("POST", path, {}).status_code == 403


def test_ux11_return_ac01_standalone_mock_retry_preserves_run_result(seed: Any) -> None:
    owner = seed.client("ux11-return-mock")
    workspace = str(owner.create_workspace()["id"])
    bank_question = owner.create_question(workspace, mcq("ux11-mock", 1, 1, None))
    exam = create_mock_exam(owner, workspace, [bank_question["id"]])
    question = mock_questions(owner, exam["id"])[0]
    run = created(owner, workspace, mock(exam["id"], {"all": True}))
    original = owner.ok_response(
        mock_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok_response(
        mock_submit(owner, original["id"], [mock_wrong(question)]), "POST", "submit", (200,)
    )
    owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    before = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    before_summary = owner.ok("GET", f"/practice-runs/{run['id']}")["summary"]
    retry = owner.ok("POST", f"/mock-exam-questions/{question['id']}/practice-sessions", {}, (201,))
    assert retry["id"] != original["id"]
    assert retry.get("practice_run_id") is None
    assert retry.get("run_position") is None
    owner.ok_response(
        mock_submit(owner, retry["id"], question["correct_option_ids"]), "POST", "submit", (200,)
    )
    assert owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200") == before
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["summary"] == before_summary
    assert (
        count(
            "select count(*) from public.mock_exam_attempts where mock_exam_question_id = %s",
            (question["id"],),
        )
        == 2
    )
    assert (
        count("select count(*) from public.question_attempts where workspace_id = %s", (workspace,))
        == 0
    )
    assert (
        count(
            "select count(*) from public.question_user_states where workspace_id = %s", (workspace,)
        )
        == 0
    )


def test_ux11_return_historical_mock_retry_is_separate_and_keeps_run(seed: Any) -> None:
    owner = seed.client("ux11-history-owner")
    other = seed.client("ux11-history-other")
    workspace = str(owner.create_workspace()["id"])
    seed.membership(workspace, other.user, "viewer")
    bank_question = owner.create_question(workspace, mcq("ux11-history", 1, 1, None))
    exam = create_mock_exam(owner, workspace, [bank_question["id"]])
    question = mock_questions(owner, exam["id"])[0]
    run = created(owner, workspace, mock(exam["id"], {"all": True}))
    original = owner.ok_response(
        mock_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok_response(
        mock_submit(owner, original["id"], [mock_wrong(question)]), "POST", "submit", (200,)
    )
    owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    before = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    remade = owner.ok("POST", f"/mock-exams/{exam['id']}/generations", {}, (202,))
    assert remade["status"] == "ready"
    assert item(owner, run["id"], 1)["available"] is True
    path = f"/practice-runs/{run['id']}/items/1/retry-session"
    assert other.call("POST", path, {}).status_code == 404
    key = str(uuid.uuid4())
    response = owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key})
    retry = owner.ok_response(response, "POST", path, (201,))
    assert not (_keys(retry) & ANSWER_KEYS)
    assert retry.get("practice_run_id") is None
    assert retry.get("run_position") is None
    again = owner.ok_response(
        owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key}), "POST", path, (201,)
    )
    assert again["id"] == retry["id"]
    owner.ok_response(
        mock_submit(owner, retry["id"], question["correct_option_ids"]), "POST", "submit", (200,)
    )
    assert owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200") == before
    assert (
        count(
            "select count(*) from public.mock_exam_attempts where mock_exam_question_id = %s",
            (question["id"],),
        )
        == 2
    )
    assert (
        count("select count(*) from public.question_attempts where workspace_id = %s", (workspace,))
        == 0
    )
    pending = owner.ok("POST", path, {}, (201,))
    assert owner.call("DELETE", f"/mock-exam-questions/{question['id']}").status_code == 204
    assert mock_submit(owner, pending["id"], question["correct_option_ids"]).status_code == 404
    assert owner.call("POST", path, {}).status_code == 404
    assert owner.call_with_headers("POST", path, {}, {"Idempotency-Key": key}).status_code == 404


def test_ux11_return_deleted_mock_exam_rejects_retry_open_submit_and_self_grade(seed: Any) -> None:
    owner = seed.client("ux11-deleted-mock")
    workspace = str(owner.create_workspace()["id"])
    bank_question = owner.create_question(workspace, mcq("ux11-delete", 1, 1, None))
    exam = create_mock_exam(owner, workspace, [bank_question["id"]])
    question = mock_questions(owner, exam["id"])[0]
    run = created(owner, workspace, mock(exam["id"], {"all": True}))
    path = f"/practice-runs/{run['id']}/items/1/retry-session"
    retry = owner.ok("POST", path, {}, (201,))
    assert owner.call("DELETE", f"/mock-exams/{exam['id']}").status_code == 204
    assert owner.call("POST", path, {}).status_code == 404
    assert mock_submit(owner, retry["id"], question["correct_option_ids"]).status_code == 404
    assert (
        owner.call(
            "POST", f"/mock-practice-sessions/{retry['id']}/self-grade", {"result": "correct"}
        ).status_code
        == 404
    )


def test_ux11_return_deleted_exam_rejects_self_grading_a_pending_retry(seed: Any) -> None:
    owner = seed.client("ux11-deleted-pending")
    workspace = str(owner.create_workspace()["id"])
    essay = owner.create_question(
        workspace,
        {
            "question_type": "ESSAY",
            "stem": "Explain the cycle.",
            "rubric": "Evaporation",
            "explanation": "Synthetic explanation",
        },
    )
    exam = create_mock_exam(owner, workspace, [essay["id"]])
    run = created(owner, workspace, mock(exam["id"], {"all": True}))
    retry = owner.ok("POST", f"/practice-runs/{run['id']}/items/1/retry-session", {}, (201,))
    submitted = owner.ok(
        "POST", f"/mock-practice-sessions/{retry['id']}/submit", {"answer_text": "Evaporation"}
    )
    assert submitted["result"] == "pending"
    assert owner.call("DELETE", f"/mock-exams/{exam['id']}").status_code == 204
    assert (
        owner.call(
            "POST", f"/mock-practice-sessions/{retry['id']}/self-grade", {"result": "correct"}
        ).status_code
        == 404
    )


# ---------------------------------------------------------------------------------------------
# UX12-RESUME: GET /workspaces/{id}/practice-runs/unfinished, POST /practice-runs/{id}/dismiss
# ---------------------------------------------------------------------------------------------


def unfinished(client: Any, workspace_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok(
        "GET", f"/workspaces/{workspace_id}/practice-runs/unfinished"
    )["items"]
    return items


def answer_position(client: Any, question: dict[str, Any], run_id: str, position: int) -> None:
    session = client.ok_response(
        run_session(client, question["id"], run_id, position), "POST", "open", (201,)
    )
    client.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": question["revision"]["correct_option_ids"]},
    )


def resume_workspace(seed: Any, label: str, n: int = 3) -> tuple[Any, str, list[dict[str, Any]]]:
    owner = seed.client(f"resume-{label}")
    ws_id = str(owner.create_workspace()["id"])
    tag = f"{label}-{uuid.uuid4().hex[:6]}"
    qs = [owner.create_question(ws_id, mcq(tag, 1, k, None)) for k in range(1, n + 1)]
    return owner, ws_id, qs


def test_ux12_resume_lists_progress_and_the_next_position_without_content(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "shape")
    run = created(owner, ws_id, bank({"all": True}))
    answer_position(owner, qs[0], run["id"], 1)
    answer_position(owner, qs[2], run["id"], 3)
    # An opened position is still unanswered.
    owner.ok_response(run_session(owner, qs[1]["id"], run["id"], 2), "POST", "open 2", (201,))

    [row] = unfinished(owner, ws_id)
    assert row["id"] == run["id"]
    assert (row["answered"], row["total"], row["next_position"]) == (2, 3, 2)
    assert row["chapter_title"] is None
    assert row["last_touched_at"] >= row["created_at"]
    assert not _keys(row) & (ANSWER_KEYS | {"stem", "options", "item_ids", "seed", "range"})


def test_ux12_resume_a_run_of_one_chapter_is_named_after_it(seed: Any) -> None:
    owner = seed.client("resume-chapter")
    ws_id = str(owner.create_workspace()["id"])
    ch1, ch2 = seed_chapters(ws_id, ["1장 물", "2장 불"])
    tag = uuid.uuid4().hex[:6]
    first = [owner.create_question(ws_id, mcq(tag, 1, n, ch1)) for n in (1, 2)]
    second = owner.create_question(ws_id, mcq(tag, 2, 1, ch2))
    one = created(owner, ws_id, bank({"chapter_ids": [ch1]}))
    both = created(owner, ws_id, bank({"all": True}))
    picked = created(owner, ws_id, bank({"question_ids": [q["id"] for q in first]}))
    titles = {row["id"]: row["chapter_title"] for row in unfinished(owner, ws_id)}
    assert titles == {one["id"]: "1장 물", both["id"]: None, picked["id"]: "1장 물"}
    # The name follows the questions still live.
    owner.ok("DELETE", f"/questions/{second['id']}", None, (204,))
    assert {r["id"]: r["chapter_title"] for r in unfinished(owner, ws_id)}[both["id"]] == "1장 물"


def test_ux12_resume_finished_and_fully_answered_runs_leave_the_list(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "finished", 2)
    done = created(owner, ws_id, bank({"all": True}))
    owner.ok("POST", f"/practice-runs/{done['id']}/finish")
    answered = created(owner, ws_id, bank({"all": True}))
    answer_position(owner, qs[0], answered["id"], 1)
    answer_position(owner, qs[1], answered["id"], 2)
    assert unfinished(owner, ws_id) == []


def test_ux12_resume_mock_runs_are_not_listed_and_cannot_be_dismissed(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "mock", 1)
    exam = create_mock_exam(owner, ws_id, [q["id"] for q in qs])
    run = created(
        owner,
        ws_id,
        {"source": "mock", "mock_exam_id": exam["id"], "range": {"all": True}},
    )
    assert unfinished(owner, ws_id) == []
    assert owner.call("POST", f"/practice-runs/{run['id']}/dismiss").status_code == 404


def test_ux12_resume_lists_only_the_callers_runs_of_this_workspace(seed: Any) -> None:
    owner, ws_id, _ = resume_workspace(seed, "owner")
    viewer = seed.client("resume-viewer")
    editor = seed.client("resume-editor")
    outsider = seed.client("resume-outsider")
    seed.membership(ws_id, viewer.user, "viewer")
    seed.membership(ws_id, editor.user, "editor")
    mine = created(owner, ws_id, bank({"all": True}))
    theirs = created(viewer, ws_id, bank({"all": True}))

    other_ws = str(owner.create_workspace()["id"])
    owner.create_question(other_ws, mcq("other", 1, 1, None))
    other = created(owner, other_ws, bank({"all": True}))

    assert [r["id"] for r in unfinished(owner, ws_id)] == [mine["id"]]
    assert [r["id"] for r in unfinished(viewer, ws_id)] == [theirs["id"]]
    assert unfinished(editor, ws_id) == []
    assert [r["id"] for r in unfinished(owner, other_ws)] == [other["id"]]

    path = f"/workspaces/{ws_id}/practice-runs/unfinished"
    unknown = owner.call("GET", f"/workspaces/{RANDOM_ID}/practice-runs/unfinished")
    assert unknown.status_code == 404
    res = outsider.call("GET", path)
    assert res.status_code == 404
    assert res.json()["detail"] == unknown.json()["detail"]

    # Another member, an outsider and an unknown id cannot tell a run exists.
    missing = owner.call("POST", f"/practice-runs/{RANDOM_ID}/dismiss")
    assert missing.status_code == 404
    for client in (viewer, outsider):
        res = client.call("POST", f"/practice-runs/{mine['id']}/dismiss")
        assert res.status_code == 404
        assert res.json()["detail"] == missing.json()["detail"]
    assert [r["id"] for r in unfinished(owner, ws_id)] == [mine["id"]]


def test_ux12_resume_archived_shows_own_runs_and_guests_get_nothing(seed: Any) -> None:
    owner, ws_id, _ = resume_workspace(seed, "archived")
    run = created(owner, ws_id, bank({"all": True}))
    owner.ok("POST", f"/workspaces/{ws_id}/archive")
    assert [r["id"] for r in unfinished(owner, ws_id)] == [run["id"]]
    owner.ok("POST", f"/workspaces/{ws_id}/restore")

    path = f"/workspaces/{ws_id}/practice-runs/unfinished"
    cookie = guest_cookie(seed, owner, ws_id)
    for method, target in (("GET", path), ("POST", f"/practice-runs/{run['id']}/dismiss")):
        bare = seed._http.request(method, f"/api/v1{target}")
        seed._http.cookies.clear()
        assert bare.status_code == 401
        shared = seed._http.request(method, f"/api/v1{target}", headers={"Cookie": cookie})
        seed._http.cookies.clear()
        assert shared.status_code == 401

    owner.ok("DELETE", f"/workspaces/{ws_id}", None, (200, 202, 204))
    assert owner.call("GET", path).status_code == 404


def test_ux12_resume_dismiss_is_idempotent_and_changes_nothing_else(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "dismiss")
    run = created(owner, ws_id, bank({"all": True}))
    answer_position(owner, qs[0], run["id"], 1)
    attempts = "select count(*) from public.question_attempts where workspace_id = %s"
    stamp = "select resume_dismissed_at from public.practice_runs where id = %s"
    assert count(attempts, (ws_id,)) == 1

    assert owner.call("POST", f"/practice-runs/{run['id']}/dismiss").status_code == 204
    stamped = admin(stamp, (run["id"],))
    assert stamped[0][0] is not None
    assert owner.call("POST", f"/practice-runs/{run['id']}/dismiss").status_code == 204
    assert admin(stamp, (run["id"],)) == stamped
    assert unfinished(owner, ws_id) == []

    # Still the same open run, reachable by its URL; going on does not bring it back.
    read = owner.ok("GET", f"/practice-runs/{run['id']}")
    assert (read["finished_at"], read["answered"]) == (None, 1)
    assert count(attempts, (ws_id,)) == 1
    answer_position(owner, qs[1], run["id"], 2)
    assert unfinished(owner, ws_id) == []


def test_ux12_resume_runs_without_a_live_position_show_nothing(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "gone")
    created(owner, ws_id, bank({"question_ids": [qs[0]["id"]]}))
    first_gone = created(owner, ws_id, bank({"question_ids": [qs[1]["id"], qs[2]["id"]]}))
    owner.ok("DELETE", f"/questions/{qs[0]['id']}", None, (204,))
    owner.ok("DELETE", f"/questions/{qs[1]['id']}", None, (204,))
    [row] = unfinished(owner, ws_id)
    assert row["id"] == first_gone["id"]
    assert (row["answered"], row["total"], row["next_position"]) == (0, 2, 2)


def test_ux12_resume_a_reset_position_is_not_offered(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "reset", 2)
    run = created(owner, ws_id, bank({"all": True}))
    answer_position(owner, qs[0], run["id"], 1)
    admin(
        "insert into public.practice_reset_epochs (user_id, question_id, epoch) "
        "values (%s, %s, 1) on conflict (user_id, question_id) do update set epoch = 1",
        (str(owner.user.id), qs[0]["id"]),
    )
    [row] = unfinished(owner, ws_id)
    assert (row["answered"], row["next_position"]) == (0, 2)
    assert owner.call("GET", f"/practice-runs/{run['id']}/items/2").status_code == 200


def test_ux12_resume_order_is_last_touched_first_and_capped_at_twenty(seed: Any) -> None:
    owner, ws_id, qs = resume_workspace(seed, "cap", 1)
    runs = [created(owner, ws_id, bank({"all": True})) for _ in range(22)]
    owner.ok_response(run_session(owner, qs[0]["id"], runs[0]["id"], 1), "POST", "open", (201,))
    rows = unfinished(owner, ws_id)
    assert len(rows) == 20
    assert rows[0]["id"] == runs[0]["id"]
    touched = [r["last_touched_at"] for r in rows]
    assert touched == sorted(touched, reverse=True)


# --- UX12-RETRYINPLACE ---------------------------------------------------------------------------


def reopen(client: Any, run_id: str, position: int) -> Any:
    return client.call("POST", f"/practice-runs/{run_id}/items/{position}/reopen", {})


def test_ux12_retryinplace_c01_reopen_clears_the_position_and_keeps_the_attempt(seed: Any) -> None:
    owner = seed.client("ux12-inplace-c01")
    workspace = str(owner.create_workspace()["id"])
    question = owner.create_question(workspace, mcq("inplace", 1, 1, None))
    run = created(owner, workspace, bank({"all": True}))
    first = owner.ok_response(
        run_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok(
        "POST",
        f"/practice-sessions/{first['id']}/submit",
        {"selected_option_ids": [wrong_option(question)]},
    )
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["answered"] == 1

    assert reopen(owner, run["id"], 1).status_code == 204
    assert owner.ok("GET", f"/practice-runs/{run['id']}")["answered"] == 0
    item = owner.ok("GET", f"/practice-runs/{run['id']}/items/1")
    assert item["attempt"] is None
    assert not (_keys(item) & ANSWER_KEYS)
    # Called again nothing changes: no graded session is left.
    assert reopen(owner, run["id"], 1).status_code == 204

    second = owner.ok_response(
        run_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    assert second["id"] != first["id"]
    assert not (_keys(second) & ANSWER_KEYS)
    owner.ok(
        "POST",
        f"/practice-sessions/{second['id']}/submit",
        {"selected_option_ids": question["revision"]["correct_option_ids"]},
    )
    results = owner.ok("GET", f"/practice-runs/{run['id']}/results?offset=0&limit=200")
    assert [row["result"] for row in results["items"]] == ["correct"]
    done = owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert done["summary"]["correct"] == 1
    assert done["summary"]["incorrect"] == 0
    assert (
        count(
            "select count(*) from public.question_attempts where question_id = %s",
            (question["id"],),
        )
        == 2
    )


def test_ux12_retryinplace_c02_a_finished_run_is_not_reopened(seed: Any) -> None:
    owner = seed.client("ux12-inplace-c02")
    workspace = str(owner.create_workspace()["id"])
    question = owner.create_question(workspace, mcq("inplace", 1, 1, None))
    run = created(owner, workspace, bank({"all": True}))
    session = owner.ok_response(
        run_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [wrong_option(question)]},
    )
    finished = owner.ok("POST", f"/practice-runs/{run['id']}/finish", {})
    assert reopen(owner, run["id"], 1).status_code == 409
    assert owner.ok("GET", f"/practice-runs/{run['id']}") == finished
    assert (
        count(
            "select count(*) from public.practice_sessions where id = %s and superseded_at is null",
            (session["id"],),
        )
        == 1
    )


def test_ux12_retryinplace_refuses_a_pending_position_a_reset_and_another_user(seed: Any) -> None:
    owner = seed.client("ux12-inplace-refuse")
    stranger = seed.client("ux12-inplace-stranger")
    workspace = str(owner.create_workspace()["id"])
    essay = owner.create_question(
        workspace,
        {
            "question_type": "ESSAY",
            "stem": "Explain the cycle.",
            "rubric": "Evaporation",
            "explanation": "Synthetic explanation",
        },
    )
    run = created(owner, workspace, bank({"all": True}))
    session = owner.ok_response(
        run_session(owner, essay["id"], run["id"], 1), "POST", "run session", (201,)
    )
    owner.ok("POST", f"/practice-sessions/{session['id']}/submit", {"answer_text": "Evaporation"})
    assert reopen(owner, run["id"], 1).status_code == 409
    assert reopen(stranger, run["id"], 1).status_code == 404
    assert reopen(owner, run["id"], 2).status_code == 404

    owner.ok("POST", f"/practice-sessions/{session['id']}/self-grade", {"result": "correct"})
    owner.ok("POST", f"/questions/{essay['id']}/practice-reset", {})
    assert reopen(owner, run["id"], 1).status_code == 409
    owner.ok("POST", f"/workspaces/{workspace}/archive")
    assert reopen(owner, run["id"], 1).status_code == 403


def test_ux12_retryinplace_c04_superseded_at_is_set_once_on_a_graded_run_session(
    seed: Any,
) -> None:
    owner = seed.client("ux12-inplace-c04")
    workspace = str(owner.create_workspace()["id"])
    question = owner.create_question(workspace, mcq("inplace", 1, 1, None))
    run = created(owner, workspace, bank({"all": True}))
    session = owner.ok_response(
        run_session(owner, question["id"], run["id"], 1), "POST", "run session", (201,)
    )
    supersede = "update public.practice_sessions set superseded_at = now() where id = %s"
    with pytest.raises(psycopg.errors.CheckViolation):
        admin(supersede, (session["id"],))
    owner.ok(
        "POST",
        f"/practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [wrong_option(question)]},
    )
    assert reopen(owner, run["id"], 1).status_code == 204
    with pytest.raises(psycopg.errors.CheckViolation):
        admin(supersede, (session["id"],))
