"""M5.2 practice API guarantees beyond the QPLAY-01 contract tests.

Concurrency (double submit / double self-grade race on one session), `Idempotency-Key` on
session open, resuming a session (answers only after submit), the stored shuffle seed, CONFIRMED
only, soft-deleted questions, my-state validation and its actor-private activity event, and
attempt history pagination. Fixtures come from conftest.py.
"""

from __future__ import annotations

import itertools
import os
import threading
import time
import uuid
from typing import Any

import httpx
import psycopg
import pytest
from quiz_api.practice_grading import shuffled_option_ids

pytestmark = pytest.mark.infra

DB_ADMIN_URL = os.environ.get(
    "QUIZ_DB_ADMIN_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def start(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def _race(calls: list[Any]) -> list[httpx.Response]:
    barrier = threading.Barrier(len(calls))
    results: list[httpx.Response] = []
    errors: list[BaseException] = []

    def run(call: Any) -> None:
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


def _db_one(sql: str, params: tuple[Any, ...]) -> Any:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(sql, params).fetchone()
    assert row is not None
    return row


def test_concurrent_submits_grade_the_session_once(seed: Any) -> None:
    alice = seed.client("m52-race-submit")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("경합"), ["a", "b", "c"], 0))
    session = start(alice, q["id"])
    path = f"/practice-sessions/{session['id']}/submit"
    bodies = [{"selected_option_ids": [f"opt-{1 + i % 3}"]} for i in range(6)]

    results = _race([lambda b=b: alice.call("POST", path, b) for b in bodies])

    assert sorted(r.status_code for r in results) == [200] + [409] * 5
    for r in results:
        if r.status_code == 409:
            assert r.json()["type"] == "urn:quiz-workspace:problem:practice-session-submitted"
    items = alice.ok("GET", f"/questions/{q['id']}/attempts")["items"]
    assert len(items) == 1
    [winner] = [r.json() for r in results if r.status_code == 200]
    assert items[0]["id"] == winner["attempt_id"]


def test_concurrent_self_grades_settle_the_pending_attempt_once(seed: Any) -> None:
    alice = seed.client("m52-race-grade")
    ws = alice.create_workspace()
    essay = alice.create_question(ws["id"], {"question_type": "ESSAY", "stem": _stem("서술")})
    session = start(alice, essay["id"])
    alice.ok("POST", f"/practice-sessions/{session['id']}/submit", {"answer_text": "답"})
    path = f"/practice-sessions/{session['id']}/self-grade"

    results = _race(
        [lambda r=r: alice.call("POST", path, {"result": r}) for r in ["correct", "incorrect"] * 3]
    )

    assert sorted(r.status_code for r in results) == [200] + [409] * 5
    items = alice.ok("GET", f"/questions/{essay['id']}/attempts")["items"]
    assert [i["result"] for i in items][1:] == ["pending"]
    assert len(items) == 2


def test_idempotent_open_returns_the_same_session(seed: Any) -> None:
    alice = seed.client("m52-idem")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("멱등"), ["a", "b", "c", "d"], 0))
    path = f"/questions/{q['id']}/practice-sessions"
    key = {"Idempotency-Key": f"open-{uuid.uuid4()}"}

    first = alice.call_with_headers("POST", path, {}, key)
    again = alice.call_with_headers("POST", path, {}, key)
    assert (first.status_code, again.status_code) == (201, 201)
    assert again.json() == first.json()
    assert again.headers.get("Idempotent-Replayed") == "true"
    other = alice.call_with_headers("POST", path, {"x": 1}, key)
    assert other.status_code == 422  # unknown body field

    (count,) = _db_one(
        "select count(*) from public.practice_sessions where question_id = %s", (q["id"],)
    )
    assert count == 1


def test_ux10_qview_ac01_default_order_is_authored_and_persisted(seed: Any) -> None:
    alice = seed.client("ux10-qview-order")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("순서"), ["a", "b", "c", "d"], 0))
    session = start(alice, q["id"])
    expected = [o["id"] for o in q["revision"]["options"]]
    assert session["displayed_option_ids"] == expected
    resumed = alice.ok("GET", f"/practice-sessions/{session['id']}")
    assert resumed["displayed_option_ids"] == expected
    seed_value, displayed = _db_one(
        "select shuffle_seed, displayed_option_ids from public.practice_sessions where id = %s",
        (session["id"],),
    )
    assert seed_value is None
    assert displayed == expected


def test_the_stored_seed_reproduces_the_displayed_order(seed: Any) -> None:
    alice = seed.client("m52-seed")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("씨앗"), ["a", "b", "c", "d", "e"], 0))
    session = alice.ok(
        "POST", f"/questions/{q['id']}/practice-sessions", {"shuffle_options": True}, (201,)
    )
    seed_value, displayed = _db_one(
        "select shuffle_seed, displayed_option_ids from public.practice_sessions where id = %s",
        (session["id"],),
    )
    assert displayed == session["displayed_option_ids"] == [o["id"] for o in session["options"]]
    authored = [o["id"] for o in q["revision"]["options"]]
    assert shuffled_option_ids(authored, seed_value) == displayed

    short = alice.create_question(
        ws["id"],
        {"question_type": "SHORT_ANSWER", "stem": _stem("단답"), "accepted_answers": ["x"]},
    )
    plain = start(alice, short["id"])
    assert (plain["options"], plain["displayed_option_ids"]) == ([], [])


def test_resume_reveals_answers_only_after_submit(seed: Any) -> None:
    alice, bob = seed.client("m52-resume"), seed.client("m52-resume-bob")
    ws = alice.create_workspace()
    seed.membership(ws["id"], bob.user, "editor")
    q = alice.create_question(
        ws["id"], seed.mcq(_stem("재개"), ["a", "b"], 1, explanation="해설 비밀")
    )
    session = start(alice, q["id"])

    opened = alice.ok("GET", f"/practice-sessions/{session['id']}")
    assert not _keys({k: v for k, v in opened.items() if k != "outcome"}) & ANSWER_KEYS
    assert opened["outcome"] is None
    assert "해설 비밀" not in str(opened)
    assert opened["options"] == session["options"]
    # A member of the same workspace cannot read someone else's session.
    assert bob.call("GET", f"/practice-sessions/{session['id']}").status_code == 404

    alice.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    done = alice.ok("GET", f"/practice-sessions/{session['id']}")
    assert done["state"] == "graded"
    assert done["outcome"]["result"] == "incorrect"
    assert done["outcome"]["correct_option_ids"] == ["opt-2"]
    assert done["outcome"]["explanation"] == "해설 비밀"


def test_only_confirmed_live_questions_are_practised(seed: Any) -> None:
    alice = seed.client("m52-confirmed")
    ws = alice.create_workspace()
    draft = alice.create_question(
        ws["id"], {**seed.mcq(_stem("초안"), ["a", "b"], 0), "publication_status": "DRAFT"}
    )
    res = alice.call("POST", f"/questions/{draft['id']}/practice-sessions", {})
    assert res.status_code == 409
    assert res.json()["type"] == "urn:quiz-workspace:problem:question-not-confirmed"

    q = alice.create_question(ws["id"], seed.mcq(_stem("삭제"), ["a", "b"], 0))
    session = start(alice, q["id"])
    assert alice.call("DELETE", f"/questions/{q['id']}").status_code == 204
    unknown = alice.call("POST", f"/practice-sessions/{uuid.uuid4()}/submit", {"answer_text": "x"})
    gone = alice.call(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    assert seed.problem(gone, 404) == seed.problem(unknown, 404)


def test_my_state_validation_and_private_history(seed: Any) -> None:
    alice = seed.client("m52-mystate")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("상태"), ["a", "b"], 0))
    path = f"/questions/{q['id']}/my-state"
    for bad in ({}, {"is_favorite": None}, {"is_favorite": "yes"}, {"other": True}):
        assert alice.call("PATCH", path, bad).status_code == 422, bad

    state = alice.ok("PATCH", path, {"is_favorite": True})
    assert state == {
        "question_id": q["id"],
        "status": "unseen",
        "is_favorite": True,
        "needs_retry": False,
        "last_graded_result": None,
    }
    alice.ok("PATCH", path, {"is_favorite": True})  # no change, no new history entry
    # RETRY-CORRECT: retry can only be turned on after a correct answer.
    session = alice.ok("POST", f"/questions/{q['id']}/practice-sessions", {}, (201,))
    alice.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    alice.ok("PATCH", path, {"needs_retry": True, "is_favorite": False})

    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        rows = conn.execute(
            "select actor_id::text, event_type, metadata from public.activity_events "
            "where target_id = %s and event_type = 'question.study_state_changed' "
            "order by created_at, id",
            (q["id"],),
        ).fetchall()
    assert [r[2] for r in rows] == [
        {"visibility": "actor", "changed": {"is_favorite": True}},
        {"visibility": "actor", "changed": {"is_favorite": False, "needs_retry": True}},
    ]
    assert {r[0] for r in rows} == {alice.user.id}


def test_attempt_history_pages_newest_first(seed: Any) -> None:
    alice = seed.client("m52-pages")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("이력"), ["a", "b"], 0))
    ids = []
    for i in range(5):
        session = start(alice, q["id"])
        body = {"selected_option_ids": [f"opt-{1 + i % 2}"]}
        ids.append(
            alice.ok("POST", f"/practice-sessions/{session['id']}/submit", body)["attempt_id"]
        )

    seen: list[str] = []
    cursor = None
    while True:
        query = "?limit=2" + (f"&cursor={cursor}" if cursor else "")
        page = alice.ok("GET", f"/questions/{q['id']}/attempts{query}")
        seen += [a["id"] for a in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ids[::-1]
    assert alice.call("GET", f"/questions/{q['id']}/attempts?cursor=bogus").status_code == 422
    first = alice.ok("GET", f"/questions/{q['id']}/attempts")["items"][-1]
    assert first["submitted_answer"] == {"selected_option_ids": ["opt-1"], "answer_text": None}
    assert first["revision_version"] == 1


def test_concurrent_first_my_state_updates_serialize(seed: Any) -> None:
    """Two first-ever PATCHes with opposite flag pairs (no state row yet) must end in a state
    some serial order produces, with history events that replay to it."""
    alice = seed.client("m52-race-mystate")
    ws = alice.create_workspace()
    a = {"is_favorite": True, "needs_retry": False}
    b = {"is_favorite": False, "needs_retry": False}
    for n in range(8):
        q = alice.create_question(ws["id"], seed.mcq(_stem(f"첫 상태 {n}"), ["a", "b"], 0))
        path = f"/questions/{q['id']}/my-state"
        results = _race(
            [lambda body=body, path=path: alice.call("PATCH", path, body) for body in (a, b)]
        )
        assert sorted(r.status_code for r in results) == [200, 200]

        items = alice.ok("GET", f"/workspaces/{ws['id']}/questions/overview")["items"]
        [item] = [i for i in items if i["question_id"] == q["id"]]
        state = {"is_favorite": item["is_favorite"], "needs_retry": item["needs_retry"]}
        assert state in (a, b), f"round {n}: {state} is no serial outcome"

        with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
            rows = conn.execute(
                "select metadata from public.activity_events where target_id = %s "
                "and event_type = 'question.study_state_changed' order by created_at, id",
                (q["id"],),
            ).fetchall()
        events = [r[0]["changed"] for r in rows]
        # created_at is each transaction's start, not its commit order: some order of the
        # events must replay from the defaults to the final state, every step a real change.
        assert any(_replays(list(order), state) for order in itertools.permutations(events)), events


def _replays(events: list[dict[str, bool]], final: dict[str, bool]) -> bool:
    state = {"is_favorite": False, "needs_retry": False}
    for changed in events:
        if not changed or any(state[k] == v for k, v in changed.items()):
            return False
        state.update(changed)
    return state == final


def test_ux10_qview_ac04_reset_hides_immutable_history(seed: Any) -> None:
    alice = seed.client("ux10-qview-reset")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("초기화"), ["a", "b"], 0))
    session = start(alice, q["id"])
    alice.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    key = {"Idempotency-Key": str(uuid.uuid4())}
    path = f"/questions/{q['id']}/practice-reset"
    assert alice.call_with_headers("POST", path, {}, key).status_code == 200
    assert alice.call_with_headers("POST", path, {}, key).status_code == 200
    assert alice.ok("GET", f"/questions/{q['id']}/attempts")["items"] == []
    recent = alice.ok("GET", f"/questions/{q['id']}/practice-recent")
    assert recent["latest_attempt_id"] is None
    assert recent["session"] is None
    assert alice.call("GET", f"/practice-sessions/{session['id']}").status_code == 409
    (count,) = _db_one(
        "select count(*) from public.question_attempts where question_id = %s", (q["id"],)
    )
    assert count == 1


def test_ux10_qview_ac05_epoch_repository_in_rolled_back_transaction(seed: Any) -> None:
    from pathlib import Path
    from types import SimpleNamespace

    from quiz_api.api.practice import reset_question_practice
    from quiz_api.repositories.idempotency import IdempotencyStore
    from quiz_api.repositories.practice import PracticeRepository
    from quiz_api.repositories.tables import question_merges
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    alice = seed.client("ux10-qview-epoch")
    other = seed.client("ux10-qview-epoch-other")
    ws = alice.create_workspace()
    seed.membership(ws["id"], other.user, "viewer")
    q = alice.create_question(ws["id"], seed.mcq(_stem("경계"), ["a", "b"], 0))
    duplicate = alice.create_question(ws["id"], seed.mcq(_stem("중복"), ["a", "b"], 0))
    user_id = uuid.UUID(alice.user.id)
    question_id = uuid.UUID(q["id"])
    workspace_id = uuid.UUID(ws["id"])
    revision_id = uuid.UUID(q["revision"]["id"])
    migration = Path("supabase/migrations/20261106100000_practice_reset_epochs.sql").read_text()
    engine = create_engine(DB_ADMIN_URL.replace("postgresql://", "postgresql+psycopg://"))
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            if (
                connection.exec_driver_sql(
                    "select to_regclass('public.practice_reset_epochs')"
                ).scalar()
                is None
            ):
                connection.exec_driver_sql(migration)
            with Session(bind=connection) as db:
                repo = PracticeRepository(db)
                assert repo.lock_epoch(user_id, question_id) == 0
                opened = repo.open_session(
                    workspace_id=workspace_id,
                    question_id=question_id,
                    revision_id=revision_id,
                    user_id=user_id,
                    displayed_option_ids=["opt-1", "opt-2"],
                    shuffle_seed=None,
                )
                session_id = opened.id
                session = repo.get_session(session_id, user_id)
                assert session is not None
                assert session.reset_epoch == 0
                repo.submit(
                    session, submitted_answer={"selected_option_ids": ["opt-1"]}, result="correct"
                )
                alias_id = uuid.UUID(duplicate["id"])
                alias = repo.open_session(
                    workspace_id=workspace_id,
                    question_id=alias_id,
                    revision_id=uuid.UUID(duplicate["revision"]["id"]),
                    user_id=user_id,
                    displayed_option_ids=["opt-1", "opt-2"],
                    shuffle_seed=None,
                )
                alias_session = repo.get_session(alias.id, user_id)
                assert alias_session is not None
                repo.submit(
                    alias_session,
                    submitted_answer={"selected_option_ids": ["opt-1"]},
                    result="correct",
                )
                db.execute(
                    question_merges.insert().values(
                        workspace_id=workspace_id,
                        duplicate_question_id=alias_id,
                        kept_question_id=question_id,
                        created_by=user_id,
                    )
                )
                assert len(repo.attempts(question_id, user_id, limit=10)[0]) == 2
                assert repo.latest_submitted_session(question_id, user_id) is not None
                other_id = uuid.UUID(other.user.id)
                other_open = repo.open_session(
                    workspace_id=workspace_id,
                    question_id=question_id,
                    revision_id=revision_id,
                    user_id=other_id,
                    displayed_option_ids=["opt-1", "opt-2"],
                    shuffle_seed=None,
                )
                other_session = repo.get_session(other_open.id, other_id)
                assert other_session is not None
                repo.submit(
                    other_session,
                    submitted_answer={"selected_option_ids": ["opt-1"]},
                    result="correct",
                )
                store = IdempotencyStore(db)
                access = SimpleNamespace(resource_id=question_id)
                user = SimpleNamespace(id=user_id)
                key = str(uuid.uuid4())
                reset_result = reset_question_practice(access, repo, store, user, key)
                assert reset_result["epochs"] == {str(question_id): 1, str(alias_id): 1}
                assert repo.lock_epoch(user_id, question_id) == 1
                assert repo.lock_epoch(user_id, alias_id) == 1
                reset_question_practice(access, repo, store, user, key)
                assert repo.lock_epoch(user_id, question_id) == 1
                assert repo.lock_epoch(user_id, alias_id) == 1
                assert repo.get_session(session_id, user_id).reset_epoch == 0
                assert repo.attempts(question_id, user_id, limit=10)[0] == []
                assert len(repo.attempts(question_id, other_id, limit=10)[0]) == 1
                assert repo.latest_submitted_session(question_id, user_id) is None
        finally:
            transaction.rollback()
    engine.dispose()


def test_ux10_qview_ac05_reset_submit_race_and_idempotent_replay(seed: Any) -> None:
    alice = seed.client("ux10-race")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("경합"), ["a", "b"], 0))
    session = start(alice, q["id"])
    path = f"/questions/{q['id']}/practice-reset"
    key = {"Idempotency-Key": str(uuid.uuid4())}
    submit_path = f"/practice-sessions/{session['id']}/submit"
    responses = _race(
        [
            lambda: alice.call_with_headers("POST", path, {}, key),
            lambda: alice.call("POST", submit_path, {"selected_option_ids": ["opt-1"]}),
        ]
    )
    reset = next(r for r in responses if r.request.url.path.endswith("/practice-reset"))
    submission = next(r for r in responses if r.request.url.path.endswith("/submit"))
    assert reset.status_code == 200
    assert reset.json()["epochs"] == {q["id"]: 1}
    assert submission.status_code in (200, 409)
    assert alice.ok("GET", f"/questions/{q['id']}/attempts")["items"] == []
    fresh = start(alice, q["id"])
    replayed = alice.call_with_headers("POST", path, {}, key)
    assert replayed.status_code == 200
    assert replayed.json() == reset.json()
    assert replayed.headers.get("Idempotent-Replayed") == "true"
    assert (
        alice.call(
            "POST", f"/practice-sessions/{fresh['id']}/submit", {"selected_option_ids": ["opt-1"]}
        ).status_code
        == 200
    )
    assert alice.call("GET", f"/practice-sessions/{session['id']}").status_code == 409


def test_ux10_qview_ac05_reset_is_scoped_and_archived_is_read_only(seed: Any) -> None:
    alice = seed.client("ux10-owner")
    outsider = seed.client("ux10-outsider")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("격리"), ["a", "b"], 0))
    path = f"/questions/{q['id']}/practice-reset"
    assert outsider.call("POST", path, {}).status_code == 404
    alice.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert alice.call("POST", path, {}).status_code == 403


def test_ux10_qview_ac05_sensitive_get_keeps_lock_across_queries() -> None:
    from types import SimpleNamespace

    from quiz_api.db import Database, get_db_session
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(DB_ADMIN_URL.replace("postgresql://", "postgresql+psycopg://"))
    database = Database(
        engine=engine,
        sessionmaker=sessionmaker(engine),
        read_sessionmaker=sessionmaker(engine.execution_options(isolation_level="AUTOCOMMIT")),
    )
    paths = [
        "/api/v1/practice-sessions/00000000-0000-4000-8000-000000000001",
        "/api/v1/questions/00000000-0000-4000-8000-000000000001/practice-recent",
        "/api/v1/practice-runs/00000000-0000-4000-8000-000000000001/items/1",
    ]
    for path in paths:
        request = SimpleNamespace(
            method="GET",
            scope={"path": path},
            app=SimpleNamespace(state=SimpleNamespace(database=database)),
        )
        dependency = get_db_session(request)
        session = next(dependency)
        lock_id = int.from_bytes(uuid.uuid4().bytes[:7], "big")
        session.execute(text("select pg_advisory_xact_lock(:key)"), {"key": lock_id})
        session.execute(text("select 1"))
        with engine.begin() as other:
            assert not other.execute(
                text("select pg_try_advisory_xact_lock(:key)"), {"key": lock_id}
            ).scalar_one()
        dependency.close()
        with engine.begin() as other:
            assert other.execute(
                text("select pg_try_advisory_xact_lock(:key)"), {"key": lock_id}
            ).scalar_one()
    engine.dispose()


def test_ux10_qview_ac05_create_respects_reset_epoch_in_both_orders(seed: Any) -> None:
    alice = seed.client("ux10-open-reset-order")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("순서 경합"), ["a", "b"], 0))
    recent_path = f"/questions/{q['id']}/practice-recent"
    open_path = f"/questions/{q['id']}/practice-sessions"
    reset_path = f"/questions/{q['id']}/practice-reset"
    epoch = alice.ok("GET", recent_path)["reset_epoch"]
    first = alice.ok("POST", open_path, {"expected_reset_epoch": epoch}, (201,))
    alice.ok("POST", reset_path)
    assert alice.call("GET", f"/practice-sessions/{first['id']}").status_code == 409
    stale = alice.call("POST", open_path, {"expected_reset_epoch": epoch})
    assert stale.status_code == 409
    assert stale.json()["type"] == "urn:quiz-workspace:problem:practice-session-reset"
    overview = alice.ok("GET", f"/workspaces/{ws['id']}/questions/overview")
    [state] = [item for item in overview["items"] if item["question_id"] == q["id"]]
    assert state["status"] == "unseen"
    current = alice.ok("GET", recent_path)["reset_epoch"]
    fresh = alice.ok("POST", open_path, {"expected_reset_epoch": current}, (201,))
    assert fresh["state"] == "open"


@pytest.mark.parametrize(
    ("operation", "with_expected_epoch"), [("open", True), ("open", False), ("flag", False)]
)
def test_ux10_qview_ac05_queued_write_cannot_undo_reset(
    seed: Any, operation: str, with_expected_epoch: bool
) -> None:
    alice = seed.client("ux10-queued-open")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("대기 경합"), ["a", "b"], 0))
    epoch = alice.ok("GET", f"/questions/{q['id']}/practice-recent")["reset_epoch"]
    lock_text = f"practice-reset:{alice.user.id}:{q['id']}"
    responses: dict[str, httpx.Response] = {}
    failures: list[BaseException] = []

    def call(name: str, method: str, path: str, body: dict[str, Any]) -> None:
        try:
            responses[name] = alice.call(method, path, body)
        except BaseException as exc:
            failures.append(exc)

    with psycopg.connect(DB_ADMIN_URL) as conn:
        (lock_id,) = conn.execute("select hashtextextended(%s, 0)", (lock_text,)).fetchone()
        conn.execute("select pg_advisory_xact_lock(%s)", (lock_id,))
        high, low = (lock_id >> 32) & 0xFFFFFFFF, lock_id & 0xFFFFFFFF

        def waiters(count: int) -> None:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                (waiting,) = conn.execute(
                    "select count(*) from pg_locks where locktype = 'advisory' and not granted "
                    "and classid = %s::oid and objid = %s::oid and objsubid = 1",
                    (high, low),
                ).fetchone()
                if waiting >= count:
                    return
                time.sleep(0.02)
            raise AssertionError(f"expected {count} waiting requests")

        reset = threading.Thread(
            target=call, args=("reset", "POST", f"/questions/{q['id']}/practice-reset", {})
        )
        opened = threading.Thread(
            target=call,
            args=(
                "write",
                "POST" if operation == "open" else "PATCH",
                f"/questions/{q['id']}/practice-sessions"
                if operation == "open"
                else f"/questions/{q['id']}/my-state",
                ({"expected_reset_epoch": epoch} if with_expected_epoch else {})
                if operation == "open"
                else {"is_favorite": True},
            ),
        )
        try:
            reset.start()
            waiters(1)
            opened.start()
            waiters(2)
        finally:
            conn.commit()
            reset.join(timeout=10)
            if opened.ident is not None:
                opened.join(timeout=10)
    assert failures == []
    assert responses["reset"].status_code == 200
    assert responses["write"].status_code == 409
    overview = alice.ok("GET", f"/workspaces/{ws['id']}/questions/overview")
    [state] = [item for item in overview["items"] if item["question_id"] == q["id"]]
    assert state["status"] == "unseen"
    assert state["is_favorite"] is False
    if operation == "flag":
        fresh = alice.ok("PATCH", f"/questions/{q['id']}/my-state", {"is_favorite": True})
        assert fresh["is_favorite"] is True


def test_ux10_qview_ac05_delayed_flag_epoch_is_rejected_after_reset(seed: Any) -> None:
    alice = seed.client("ux10-delayed-flag")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], seed.mcq(_stem("지연 표시"), ["a", "b"], 0))
    recent = f"/questions/{q['id']}/practice-recent"
    state = f"/questions/{q['id']}/my-state"
    epoch = alice.ok("GET", recent)["reset_epoch"]
    alice.ok("POST", f"/questions/{q['id']}/practice-reset")
    stale = alice.call("PATCH", state, {"is_favorite": True, "expected_reset_epoch": epoch})
    assert stale.status_code == 409
    assert stale.json()["type"] == "urn:quiz-workspace:problem:practice-session-reset"
    overview = alice.ok("GET", f"/workspaces/{ws['id']}/questions/overview")
    [item] = [entry for entry in overview["items"] if entry["question_id"] == q["id"]]
    assert item["status"] == "unseen"
    assert item["is_favorite"] is False
    fresh_epoch = alice.ok("GET", recent)["reset_epoch"]
    fresh = alice.ok("PATCH", state, {"is_favorite": True, "expected_reset_epoch": fresh_epoch})
    assert fresh["is_favorite"] is True
