"""M5.1 questions overview API guarantees beyond the QOV-01 contract tests.

The contract tests (test_overview_api_contract.py) drive study state through the practice and
my-state API (M5.2); until then they stay `red`. This module seeds `question_user_states`,
practice sessions and attempts directly with the `postgres` superuser (as conftest's
`graded_attempt` does) and checks what M5.1 owns: status derivation per caller, mutually
exclusive counts with an overlapping favorite count, CONFIRMED-only items, chapter grouping and
numbering, filters and their count scope, no answers, no side effects, authorization, and the
index plan of the overview statement.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

import psycopg
import pytest
from quiz_api.repositories.question_overview import OverviewFilter, overview_statement
from sqlalchemy.dialects import postgresql

pytestmark = pytest.mark.infra

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
STATUSES = ("unseen", "viewed", "incorrect", "correct", "retry")


def _stem(text: str) -> str:
    return f"{text} [{uuid.uuid4().hex[:8]}]"


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def overview(client: Any, workspace_id: str, query: str = "") -> dict[str, Any]:
    path = f"/workspaces/{workspace_id}/questions/overview" + (f"?{query}" if query else "")
    out: dict[str, Any] = client.ok("GET", path)
    assert not (_keys(out) & ANSWER_KEYS), "the overview must never carry answers"
    return out


def by_id(view: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {i["question_id"]: i for i in view["items"]}


def numbered(seed: Any, n: int, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = seed.mcq(_stem(f"{n}번 문제"), ["a", "b", "c", "d"], 0)
    return {**body, "question_number": n, "explanation": "해설 비밀", **extra}


def seed_state(
    question: dict[str, Any],
    user_id: str,
    *,
    viewed: bool = False,
    result: str | None = None,
    retry: bool = False,
    favorite: bool = False,
    pending: bool = False,
) -> None:
    """Direct seed of one user's study state (the practice/my-state API is M5.2). `result` adds a
    graded (auto) attempt and points `last_graded_result` at it; `pending` adds a later submitted
    session that awaits grading."""
    ws, qid, rev = question["workspace_id"], question["id"], question["revision"]["id"]
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        attempt_id = None
        if result is not None:
            row = conn.execute(
                "with s as (insert into public.practice_sessions (workspace_id, question_id, "
                "question_revision_id, user_id, state, submitted_at, graded_at) "
                "values (%s, %s, %s, %s, 'graded', now() - interval '1 hour', "
                "now() - interval '1 hour') returning id) "
                "insert into public.question_attempts (workspace_id, question_id, "
                "question_revision_id, practice_session_id, user_id, submitted_answer, result, "
                "grading_method, graded_at) select %s, %s, %s, s.id, %s, '{}'::jsonb, %s, "
                "'auto', now() from s returning id",
                (ws, qid, rev, user_id, ws, qid, rev, user_id, result),
            ).fetchone()
            assert row is not None
            attempt_id = row[0]
        if pending:
            conn.execute(
                "with s as (insert into public.practice_sessions (workspace_id, question_id, "
                "question_revision_id, user_id, state, submitted_at) "
                "values (%s, %s, %s, %s, 'pending_grade', now()) returning id) "
                "insert into public.question_attempts (workspace_id, question_id, "
                "question_revision_id, practice_session_id, user_id, submitted_answer, result) "
                "select %s, %s, %s, s.id, %s, '{}'::jsonb, 'pending' from s",
                (ws, qid, rev, user_id, ws, qid, rev, user_id),
            )
        seen = viewed or result is not None or pending
        conn.execute(
            "insert into public.question_user_states (user_id, question_id, workspace_id, "
            "first_viewed_at, last_viewed_at, last_graded_result, last_graded_attempt_id, "
            "is_favorite, needs_retry) values (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                user_id,
                qid,
                ws,
                "2026-10-01T09:00:00Z" if seen else None,
                "2026-10-01T09:00:00Z" if seen else None,
                result,
                attempt_id,
                favorite,
                retry,
            ),
        )


def state_rows(workspace_id: str) -> int:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select count(*) from public.question_user_states where workspace_id = %s",
            (workspace_id,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def seed_document(workspace_id: str, titles: list[str], sub: dict[int, str]) -> list[str]:
    """A ready document whose active revision has one top-level chapter per title (in order) and,
    for `sub[i]`, a child section under chapter i. Returns chapter ids (top-level, then subs)."""
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
        order = 0
        top: list[str] = []
        subs: list[str] = []
        for i, title in enumerate(titles):
            cid = conn.execute(
                "insert into public.chapters (workspace_id, document_id, document_revision_id, "
                "section_key, level, sort_order, title) values (%s, %s, %s, %s, 1, %s, %s) "
                "returning id",
                (workspace_id, doc_id, rev_id, f"s{i}", order, title),
            ).fetchone()[0]  # type: ignore[index]
            order += 1
            top.append(str(cid))
            if i in sub:
                sid = conn.execute(
                    "insert into public.chapters (workspace_id, document_id, "
                    "document_revision_id, parent_id, section_key, level, sort_order, title) "
                    "values (%s, %s, %s, %s, %s, 2, %s, %s) returning id",
                    (workspace_id, doc_id, rev_id, cid, f"s{i}.1", order, sub[i]),
                ).fetchone()[0]  # type: ignore[index]
                order += 1
                subs.append(str(sid))
        conn.execute(
            "update public.document_revisions set status = 'published', published_at = now() "
            "where id = %s",
            (rev_id,),
        )
        conn.execute(
            "update public.documents set active_revision_id = %s, status = 'ready' where id = %s",
            (rev_id, doc_id),
        )
    ids.extend(top)
    ids.extend(subs)
    return ids


def test_status_per_caller_counts_and_pending_grading(seed: Any) -> None:
    alice = seed.client("ov-status")
    ws = alice.create_workspace()
    qs = [alice.create_question(ws["id"], numbered(seed, n)) for n in range(1, 10)]
    uid = alice.user.id
    seed_state(qs[0], uid, result="correct", retry=True)  # retry outranks correct
    seed_state(qs[1], uid, result="incorrect", retry=True, favorite=True)
    seed_state(qs[2], uid, result="correct")
    seed_state(qs[3], uid, result="incorrect")
    seed_state(qs[4], uid, viewed=True)
    # qs[5]: no row at all -> unseen
    seed_state(qs[6], uid, favorite=True)  # favorite only: still unseen
    seed_state(qs[7], uid, pending=True)  # pending essay-like submission: viewed + 채점 대기
    seed_state(qs[8], uid, result="correct", pending=True, favorite=True)  # keeps last result

    view = overview(alice, ws["id"])
    items = by_id(view)
    assert [items[q["id"]]["status"] for q in qs] == [
        "retry",
        "retry",
        "correct",
        "incorrect",
        "viewed",
        "unseen",
        "unseen",
        "viewed",
        "correct",
    ]
    assert [items[q["id"]]["is_pending_grading"] for q in qs] == [False] * 7 + [True, True]
    first = items[qs[0]["id"]]
    assert first["last_graded_result"] == "correct"
    assert first["needs_retry"] is True
    assert first["is_favorite"] is False
    assert items[qs[1]["id"]]["is_favorite"] is True
    assert view["counts"] == {
        "total": 9,
        "unseen": 2,
        "viewed": 2,
        "incorrect": 1,
        "correct": 2,
        "retry": 2,
        "favorite": 3,
    }
    assert sum(view["counts"][s] for s in STATUSES) == view["counts"]["total"]
    assert set(first) == {
        "question_id",
        "chapter_id",
        "question_number",
        "question_type",
        "status",
        "is_favorite",
        "needs_retry",
        "last_graded_result",
        "is_pending_grading",
        "preview",
    }

    # Another member's view is their own: alice's state never leaks.
    viewer = seed.client("ov-status-viewer")
    seed.membership(ws["id"], viewer.user, "viewer")
    theirs = overview(viewer, ws["id"])
    assert {i["status"] for i in theirs["items"]} == {"unseen"}
    assert not any(i["is_favorite"] or i["is_pending_grading"] for i in theirs["items"])
    assert theirs["counts"]["unseen"] == 9


def test_reading_never_records_a_view(seed: Any) -> None:
    alice = seed.client("ov-read-only")
    ws = alice.create_workspace()
    q = alice.create_question(ws["id"], numbered(seed, 1))
    for query in ("", "status=unseen", f"q={q['revision']['stem'][:3]}", "favorite=true"):
        overview(alice, ws["id"], query)
    alice.get_question(q["id"])
    assert state_rows(ws["id"]) == 0
    assert by_id(overview(alice, ws["id"]))[q["id"]]["status"] == "unseen"


def test_only_confirmed_live_questions_in_bank_order(seed: Any) -> None:
    alice = seed.client("ov-confirmed")
    ws = alice.create_workspace()
    later = alice.create_question(ws["id"], numbered(seed, 3))
    unnumbered = alice.create_question(ws["id"], seed.mcq(_stem("번호 없음"), ["a", "b"], 0))
    first = alice.create_question(ws["id"], numbered(seed, 1))
    draft = alice.create_question(ws["id"], numbered(seed, 2, publication_status="DRAFT"))
    archived = alice.create_question(ws["id"], numbered(seed, 4))
    alice.ok(
        "PATCH",
        f"/questions/{archived['id']}",
        {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    deleted = alice.create_question(ws["id"], numbered(seed, 5))
    alice.ok("DELETE", f"/questions/{deleted['id']}", None, (204,))

    view = overview(alice, ws["id"])
    assert [i["question_id"] for i in view["items"]] == [
        first["id"],
        later["id"],
        unnumbered["id"],
    ]
    assert draft["id"] not in by_id(view)
    assert view["counts"]["total"] == 3
    assert view["chapters"] == [
        {"id": None, "number": None, "title": "챕터 없음", "document_id": None, "question_count": 3}
    ]


def test_chapter_groups_order_numbers_and_preview(seed: Any) -> None:
    alice = seed.client("ov-chapters")
    ws = alice.create_workspace()
    ch1, ch2, ch3, sec21 = seed_document(
        ws["id"], ["Chapter 1 Basics", "2장 어텐션", "Appendix"], {1: "2.1 Scaled"}
    )
    none_q = alice.create_question(ws["id"], numbered(seed, 1))
    c2_q = alice.create_question(ws["id"], numbered(seed, 7, chapter_id=ch2))
    c1_b = alice.create_question(ws["id"], numbered(seed, 2, chapter_id=ch1))
    c1_a = alice.create_question(ws["id"], numbered(seed, 1, chapter_id=ch1))
    sec_q = alice.create_question(ws["id"], numbered(seed, 3, chapter_id=sec21))
    app_q = alice.create_question(
        ws["id"],
        numbered(seed, 1, chapter_id=ch3, stem="첫 줄\n\n둘째 줄\n셋째 줄\n넷째 줄 비밀"),
    )

    view = overview(alice, ws["id"])
    assert [i["question_id"] for i in view["items"]] == [
        c1_a["id"],
        c1_b["id"],
        c2_q["id"],
        sec_q["id"],
        app_q["id"],
        none_q["id"],
    ]
    doc = view["chapters"][0]["document_id"]
    assert view["chapters"] == [
        {"id": ch1, "number": 1, "title": "Chapter 1 Basics", "document_id": doc,
         "question_count": 2},
        {"id": ch2, "number": 2, "title": "2장 어텐션", "document_id": doc, "question_count": 1},
        {"id": sec21, "number": 2, "title": "2.1 Scaled", "document_id": doc,
         "question_count": 1},
        {"id": ch3, "number": None, "title": "Appendix", "document_id": doc, "question_count": 1},
        {"id": None, "number": None, "title": "챕터 없음", "document_id": None,
         "question_count": 1},
    ]  # fmt: skip
    items = by_id(view)
    assert items[sec_q["id"]]["chapter_id"] == sec21
    assert items[app_q["id"]]["preview"] == "첫 줄\n둘째 줄\n셋째 줄"
    assert items[c1_a["id"]]["preview"] == c1_a["revision"]["stem"]
    assert items[c1_a["id"]]["question_type"] == "MCQ"
    assert items[c1_a["id"]]["question_number"] == 1


def test_filters_and_count_scope(seed: Any) -> None:
    alice = seed.client("ov-filters")
    ws = alice.create_workspace()
    ch1, ch2 = seed_document(ws["id"], ["1장 기초", "2장 응용"], {})
    uid = alice.user.id
    a = alice.create_question(ws["id"], numbered(seed, 1, chapter_id=ch1))
    b = alice.create_question(ws["id"], numbered(seed, 2, chapter_id=ch1))
    c = alice.create_question(ws["id"], numbered(seed, 3, chapter_id=ch2))
    essay = alice.create_question(
        ws["id"],
        {"question_type": "ESSAY", "stem": _stem("서술 고양이"), "question_number": 4},
    )
    seed_state(a, uid, result="correct", retry=True, favorite=True)
    seed_state(b, uid, result="incorrect")
    seed_state(c, uid, viewed=True, favorite=True)

    def ids(query: str) -> list[str]:
        return [i["question_id"] for i in overview(alice, ws["id"], query)["items"]]

    assert ids(f"chapter={ch1}") == [a["id"], b["id"]]
    assert ids("chapter=none") == [essay["id"]]
    assert ids("type=ESSAY") == [essay["id"]]
    assert ids("q=고양이") == [essay["id"]]
    assert ids("q=%25") == []  # LIKE wildcards are literal
    assert ids("status=retry") == [a["id"]]
    assert ids("status=incorrect&status=unseen") == [b["id"], essay["id"]]
    assert ids("favorite=true") == [a["id"], c["id"]]
    assert ids("favorite=false") == [b["id"], essay["id"]]
    assert ids("retry=true") == [a["id"]]
    assert ids("retry=false") == [b["id"], c["id"], essay["id"]]
    assert ids(f"chapter={ch1}&status=incorrect") == [b["id"]]

    # Counts follow the scope filters (chapter/type/q) and ignore the state filters.
    everything = {
        "total": 4,
        "unseen": 1,
        "viewed": 1,
        "incorrect": 1,
        "correct": 0,
        "retry": 1,
        "favorite": 2,
    }
    assert overview(alice, ws["id"], "status=retry&favorite=true")["counts"] == everything
    chapter1 = overview(alice, ws["id"], f"chapter={ch1}&status=incorrect")
    assert chapter1["counts"] == {
        "total": 2,
        "unseen": 0,
        "viewed": 0,
        "incorrect": 1,
        "correct": 0,
        "retry": 1,
        "favorite": 1,
    }
    assert [g["id"] for g in chapter1["chapters"]] == [ch1]
    assert chapter1["chapters"][0]["question_count"] == 1
    empty = overview(alice, ws["id"], f"chapter={uuid.uuid4()}")
    assert empty == {"counts": {**dict.fromkeys(everything, 0)}, "chapters": [], "items": []}

    for bad in ("chapter=chapter-1", "status=done", "type=mcq", "favorite=maybe"):
        res = alice.call("GET", f"/workspaces/{ws['id']}/questions/overview?{bad}")
        assert res.status_code == 422, bad


def test_authorization_viewer_archived_and_outsiders(seed: Any) -> None:
    owner = seed.client("ov-authz-owner")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], numbered(seed, 1))
    viewer = seed.client("ov-authz-viewer")
    seed.membership(ws["id"], viewer.user, "viewer")
    outsider = seed.client("ov-authz-outsider")

    assert [i["question_id"] for i in overview(viewer, ws["id"])["items"]] == [q["id"]]
    for path in (
        f"/workspaces/{ws['id']}/questions/overview",
        f"/workspaces/{uuid.uuid4()}/questions/overview",
    ):
        res = outsider.call("GET", path)
        assert res.status_code == 404
        assert res.json()["detail"] == "Not found."

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert len(overview(owner, ws["id"])["items"]) == 1  # archived stays readable
    assert len(overview(viewer, ws["id"])["items"]) == 1


INDEX_SCANS = {"Index Scan", "Index Only Scan", "Bitmap Heap Scan"}


def _plan_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    return [node, *(n for child in node.get("Plans", []) for n in _plan_nodes(child))]


def _index_conds(node: dict[str, Any]) -> str:
    """Index conditions of a scan node (a bitmap heap scan keeps them in its index children)."""
    return " ".join(str(n["Index Cond"]) for n in _plan_nodes(node) if "Index Cond" in n)


def test_overview_statement_is_index_bounded(seed: Any) -> None:
    """Plan check (not timing, not a specific index name): with sequential scans disabled the
    statement is still answered by index scans bounded by the workspace (questions) and the
    caller (study states, practice sessions), i.e. its predicates match the indexes."""
    stmt = overview_statement(uuid.uuid4(), uuid.uuid4(), OverviewFilter())
    compiled = stmt.compile(dialect=postgresql.psycopg.dialect())  # type: ignore[attr-defined]
    with psycopg.connect(DB_ADMIN_URL) as conn:
        conn.execute("set local enable_seqscan = off")
        row = conn.execute(f"explain (format json) {compiled}", compiled.params).fetchone()
        conn.rollback()
    assert row is not None
    nodes = _plan_nodes(row[0][0]["Plan"])
    by_table: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        if "Relation Name" in n:
            by_table.setdefault(n["Relation Name"], []).append(n)

    for table in ("questions", "question_user_states", "practice_sessions"):
        scans = by_table.get(table, [])
        assert scans, f"{table} missing from the plan: {nodes}"
        assert all(s["Node Type"] in INDEX_SCANS for s in scans), f"{table}: {scans}"
    assert any("workspace_id" in _index_conds(s) for s in by_table["questions"]), by_table
    # Per-caller lookups: index-driven by the caller or by the joined question (the planner may
    # pick either, e.g. practice_sessions_user_question_idx or practice_sessions_revision_idx).
    for table in ("question_user_states", "practice_sessions"):
        for scan in by_table[table]:
            conds = _index_conds(scan)
            assert "user_id" in conds or "question_id" in conds, f"{table}: {scan}"
