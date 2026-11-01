"""UX7-DEDUP duplicate questions (docs/questions.md §10; QOV-01-AC16/AC17, QIMPORT-01-AC10).

    GET  /workspaces/{id}/question-duplicates        groups of identical CONFIRMED questions
    POST /workspaces/{id}/question-duplicates/merge  keep one per group, archive the rest and
                                                     merge their study history into it

Covers grouping across option order / numbering / spacing variants, authorization (viewer 403,
outsider and cross-workspace 404, archived workspace 403 `workspace-archived` — the repository
convention for writes in an archived workspace), merged study state in every reader (overview,
my-state, attempts, history), unarchive = unmerge, re-pointing, idempotent merge and re-scan,
and the import review's duplicate flag. Attempts are never rewritten.
"""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
import pytest

pytestmark = [pytest.mark.infra, pytest.mark.red]

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
PROBLEM = "urn:quiz-workspace:problem:"
TEXTS = ["증발은 액체가 기체로 변하는 현상이다", "응결은 기체가 고체로 변한다", "강수는 없다"]


def _stem() -> str:
    return f"다음 중 물의 순환에 대한 설명으로 옳은 것은? [{uuid.uuid4().hex[:8]}]"


def _keys(value: Any) -> set[str]:
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    return set()


def mcq(
    stem: str,
    texts: list[str],
    answer: str,
    *,
    ids: list[str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """An MCQ whose answer is the option with text `answer` (ids are opaque)."""
    ids = ids or [f"o{i}" for i in range(len(texts))]
    options = [{"id": i, "text": t} for i, t in zip(ids, texts, strict=True)]
    correct = [o["id"] for o in options if answer in o["text"]]
    return {
        "question_type": "MCQ",
        "stem": stem,
        "options": options,
        "correct_option_ids": correct[:1],
        "is_multi_answer": False,
        **extra,
    }


def scan(client: Any, workspace_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/workspaces/{workspace_id}/question-duplicates")
    assert not (_keys(out) & ANSWER_KEYS), "the scan never carries answers"
    return out


def merge(client: Any, workspace_id: str, groups: list[dict[str, Any]]) -> Any:
    return client.call(
        "POST", f"/workspaces/{workspace_id}/question-duplicates/merge", {"groups": groups}
    )


def group_ids(view: dict[str, Any]) -> list[list[str]]:
    return [[q["question_id"] for q in g["questions"]] for g in view["groups"]]


def overview(client: Any, workspace_id: str) -> dict[str, dict[str, Any]]:
    out = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    return {i["question_id"]: i for i in out["items"]}


def answer(client: Any, question: dict[str, Any], option_id: str) -> str:
    session = client.ok("POST", f"/questions/{question['id']}/practice-sessions", {}, (201,))
    out = client.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": [option_id]}
    )
    return str(out["attempt_id"])


def attempts_rows(workspace_id: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        return conn.execute(
            "select id, question_id, result, submitted_at from public.question_attempts "
            "where workspace_id = %s order by id",
            (workspace_id,),
        ).fetchall()


def favorite_flag(user_id: str, question_id: str) -> bool | None:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select is_favorite from public.question_user_states "
            "where user_id = %s and question_id = %s",
            (user_id, question_id),
        ).fetchone()
    return None if row is None else bool(row[0])


def problem(res: Any, status: int, kind: str) -> None:
    assert res.status_code == status, res.text
    assert res.json()["type"] == PROBLEM + kind, res.text


def test_scan_groups_variants_and_suggests_the_oldest(seed: Any) -> None:
    owner = seed.client("dedup-scan")
    ws = owner.create_workspace()
    stem = _stem()
    first = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    # Option order, circled labels, a stem number and an empty answer mark.
    second = owner.create_question(
        ws["id"],
        mcq(
            f"1. {stem} ( )",
            [f"③ {TEXTS[2]}", f"① {TEXTS[0]}", f"② {TEXTS[1]}"],
            "증발",
            ids=["x", "y", "z"],
        ),
    )
    # Spacing, punctuation and (A) labels; another answer -> the group warns.
    third = owner.create_question(
        ws["id"],
        mcq(
            stem.replace(" ", "  ").replace("?", " ?"),
            [f"(A) {TEXTS[0]}.", f"(B) {TEXTS[1]}", f"(C) {TEXTS[2]}"],
            "응결",
        ),
    )
    other = owner.create_question(ws["id"], mcq(stem, [*TEXTS[:2], "강수는 있다"], "증발"))
    owner.create_question(ws["id"], {"question_type": "SHORT_ANSWER", "stem": stem})
    owner.create_question(
        ws["id"], {**mcq(stem, TEXTS, "증발"), "publication_status": "DRAFT"}
    )  # drafts are not scanned

    view = scan(owner, ws["id"])
    assert group_ids(view) == [[first["id"], second["id"], third["id"]]]
    group = view["groups"][0]
    assert group["suggested_keep_question_id"] == first["id"]
    assert group["answers_differ"] is True
    shown = group["questions"][1]
    assert shown["stem"] == f"1. {stem} ( )"
    assert [o["text"] for o in shown["options"]] == [
        f"③ {TEXTS[2]}",
        f"① {TEXTS[0]}",
        f"② {TEXTS[1]}",
    ]
    assert other["id"] not in {q["question_id"] for g in view["groups"] for q in g["questions"]}

    # Same answers -> no warning.
    ws2 = owner.create_workspace()
    a = owner.create_question(ws2["id"], mcq(stem, TEXTS, "증발"))
    b = owner.create_question(
        ws2["id"], mcq(stem, list(reversed(TEXTS)), "증발", ids=["p", "q", "r"])
    )
    view2 = scan(owner, ws2["id"])
    assert group_ids(view2) == [[a["id"], b["id"]]]
    assert view2["groups"][0]["answers_differ"] is False
    assert scan(owner, ws2["id"]) == view2  # a scan is a read: same answer twice


def test_authorization(seed: Any) -> None:
    owner = seed.client("dedup-authz-owner")
    viewer = seed.client("dedup-authz-viewer")
    editor = seed.client("dedup-authz-editor")
    outsider = seed.client("dedup-authz-outsider")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    seed.membership(ws["id"], editor.user, "editor")
    stem = _stem()
    keep = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    dup = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    groups = [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}]

    problem(
        viewer.call("GET", f"/workspaces/{ws['id']}/question-duplicates"), 403, "insufficient-role"
    )
    problem(merge(viewer, ws["id"], groups), 403, "insufficient-role")
    for path in (
        f"/workspaces/{ws['id']}/question-duplicates",
        f"/workspaces/{uuid.uuid4()}/question-duplicates",
    ):
        res = outsider.call("GET", path)
        assert res.status_code == 404
        assert res.json()["detail"] == "Not found."
    assert merge(outsider, ws["id"], groups).status_code == 404

    # Cross-workspace: ids of another workspace are 404 for the whole request, nothing changes.
    other_ws = owner.create_workspace()
    foreign = owner.create_question(other_ws["id"], mcq(stem, TEXTS, "증발"))
    res = merge(
        owner,
        ws["id"],
        [{"keep_question_id": keep["id"], "duplicate_question_ids": [foreign["id"]]}],
    )
    assert res.status_code == 404
    res = merge(owner, other_ws["id"], groups)
    assert res.status_code == 404
    assert owner.get_question(dup["id"])["publication_status"] == "CONFIRMED"
    assert owner.get_question(foreign["id"])["publication_status"] == "CONFIRMED"
    # Each workspace scans only its own questions.
    assert group_ids(scan(owner, ws["id"])) == [[keep["id"], dup["id"]]]
    assert scan(owner, other_ws["id"])["groups"] == []

    # An editor may merge.
    assert scan(editor, ws["id"])["groups"]
    # Archived workspace: read-only for everyone (403 workspace-archived, as every write).
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    problem(
        owner.call("GET", f"/workspaces/{ws['id']}/question-duplicates"), 403, "workspace-archived"
    )
    problem(merge(owner, ws["id"], groups), 403, "workspace-archived")
    assert owner.get_question(dup["id"])["publication_status"] == "CONFIRMED"


def test_merge_validation(seed: Any) -> None:
    owner = seed.client("dedup-validate")
    ws = owner.create_workspace()
    stem = _stem()
    keep = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    dup = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    different = owner.create_question(ws["id"], mcq(f"{stem} 다른", TEXTS, "증발"))
    archived = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    owner.ok(
        "PATCH",
        f"/questions/{archived['id']}",
        {"base_revision_id": archived["revision"]["id"], "publication_status": "ARCHIVED"},
    )

    res = merge(
        owner,
        ws["id"],
        [{"keep_question_id": keep["id"], "duplicate_question_ids": [different["id"]]}],
    )
    problem(res, 409, "not-duplicates")
    res = merge(
        owner,
        ws["id"],
        [{"keep_question_id": archived["id"], "duplicate_question_ids": [dup["id"]]}],
    )
    problem(res, 409, "question-not-confirmed")
    res = merge(
        owner,
        ws["id"],
        [{"keep_question_id": keep["id"], "duplicate_question_ids": [archived["id"]]}],
    )
    problem(res, 409, "question-not-confirmed")  # archived on its own, not merged into keep
    for bad in (
        [{"keep_question_id": keep["id"], "duplicate_question_ids": [keep["id"]]}],
        [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"], dup["id"]]}],
        [
            {"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]},
            {"keep_question_id": dup["id"], "duplicate_question_ids": [different["id"]]},
        ],
        [{"keep_question_id": keep["id"], "duplicate_question_ids": []}],
        [],
    ):
        assert merge(owner, ws["id"], bad).status_code == 422, bad
    # Nothing changed.
    assert owner.get_question(dup["id"])["publication_status"] == "CONFIRMED"
    assert owner.get_question(different["id"])["publication_status"] == "CONFIRMED"


def test_merge_archives_and_folds_study_state(seed: Any) -> None:
    owner = seed.client("dedup-merge-owner")
    viewer = seed.client("dedup-merge-viewer")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    stem = _stem()
    keep = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    dup = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발", ids=["d0", "d1", "d2"]))
    unrelated = owner.create_question(ws["id"], mcq(f"{stem} 다른", TEXTS, "증발"))

    answer(owner, keep, "o0")  # correct, earlier
    answer(owner, dup, "d1")  # incorrect, later
    owner.ok("PATCH", f"/questions/{dup['id']}/my-state", {"is_favorite": True})
    answer(viewer, dup, "d0")  # the viewer's own record (correct)
    before = attempts_rows(ws["id"])
    assert len(before) == 3

    res = merge(
        owner, ws["id"], [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}]
    )
    assert res.status_code == 200, res.text
    assert res.json()["groups"] == [
        {
            "keep_question_id": keep["id"],
            "archived_question_ids": [dup["id"]],
            "already_merged_question_ids": [],
        }
    ]
    assert owner.get_question(dup["id"])["publication_status"] == "ARCHIVED"
    assert attempts_rows(ws["id"]) == before  # attempts are never rewritten

    # Overview: one dot for the pair, the latest grade (dup's incorrect) and the favorite.
    items = overview(owner, ws["id"])
    assert set(items) == {keep["id"], unrelated["id"]}
    assert items[keep["id"]]["status"] == "incorrect"
    assert items[keep["id"]]["last_graded_result"] == "incorrect"
    assert items[keep["id"]]["is_favorite"] is True
    assert items[unrelated["id"]]["status"] == "unseen"
    # Per user: the viewer's own merged record (correct, viewed), no owner state.
    vitems = overview(viewer, ws["id"])
    assert vitems[keep["id"]]["status"] == "correct"
    assert vitems[keep["id"]]["is_favorite"] is False

    # Attempts of the kept question include the duplicate's, each with its question id.
    listed = owner.ok("GET", f"/questions/{keep['id']}/attempts")["items"]
    assert [(a["question_id"], a["result"]) for a in listed] == [
        (dup["id"], "incorrect"),
        (keep["id"], "correct"),
    ]
    assert len(viewer.ok("GET", f"/questions/{keep['id']}/attempts")["items"]) == 1
    # History links the duplicate's attempt to the kept question.
    history = owner.ok("GET", f"/workspaces/{ws['id']}/attempts")["items"]
    merged_into = {a["question_id"]: a["merged_into_question_id"] for a in history}
    assert merged_into == {dup["id"]: keep["id"], keep["id"]: None}

    # Clearing the favorite on the kept question clears the duplicate's too (OR of both).
    state = owner.ok("PATCH", f"/questions/{keep['id']}/my-state", {"is_favorite": False})
    assert state["is_favorite"] is False
    assert state["status"] == "incorrect"
    assert overview(owner, ws["id"])[keep["id"]]["is_favorite"] is False
    assert favorite_flag(owner.user.id, dup["id"]) is False
    state = owner.ok("PATCH", f"/questions/{keep['id']}/my-state", {"needs_retry": True})
    assert state["status"] == "retry"

    # A new attempt on the kept question is the latest grade.
    answer(owner, keep, "o0")
    assert overview(owner, ws["id"])[keep["id"]]["last_graded_result"] == "correct"


def test_merge_is_idempotent_and_rescan_is_empty(seed: Any) -> None:
    owner = seed.client("dedup-idem")
    ws = owner.create_workspace()
    stem = _stem()
    keep = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    dups = [owner.create_question(ws["id"], mcq(stem, TEXTS, "증발")) for _ in range(2)]
    groups = [{"keep_question_id": keep["id"], "duplicate_question_ids": [d["id"] for d in dups]}]
    assert merge(owner, ws["id"], groups).status_code == 200
    again = merge(owner, ws["id"], groups)
    assert again.status_code == 200, again.text
    assert again.json()["groups"] == [
        {
            "keep_question_id": keep["id"],
            "archived_question_ids": [],
            "already_merged_question_ids": sorted([d["id"] for d in dups]),
        }
    ]
    assert scan(owner, ws["id"])["groups"] == []
    assert scan(owner, ws["id"])["groups"] == []
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select count(*) from public.question_merges where kept_question_id = %s",
            (keep["id"],),
        ).fetchone()
    assert row is not None
    assert row[0] == 2  # no duplicate links


def test_unarchive_unmerges(seed: Any) -> None:
    owner = seed.client("dedup-unarchive")
    ws = owner.create_workspace()
    stem = _stem()
    keep = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    dup = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    answer(owner, keep, "o0")
    answer(owner, dup, "o1")
    owner.ok("PATCH", f"/questions/{dup['id']}/my-state", {"is_favorite": True})
    assert (
        merge(
            owner,
            ws["id"],
            [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}],
        ).status_code
        == 200
    )
    assert overview(owner, ws["id"])[keep["id"]]["status"] == "incorrect"

    current = owner.get_question(dup["id"])
    owner.ok(
        "PATCH",
        f"/questions/{dup['id']}",
        {"base_revision_id": current["revision"]["id"], "publication_status": "CONFIRMED"},
    )
    items = overview(owner, ws["id"])
    assert items[keep["id"]]["status"] == "correct"
    assert items[keep["id"]]["is_favorite"] is False
    assert items[dup["id"]]["status"] == "incorrect"
    assert items[dup["id"]]["is_favorite"] is True
    assert [
        a["question_id"] for a in owner.ok("GET", f"/questions/{keep['id']}/attempts")["items"]
    ] == [keep["id"]]
    # It is a duplicate again: the scan finds the pair, a new merge links it again.
    assert group_ids(scan(owner, ws["id"])) == [[keep["id"], dup["id"]]]
    assert (
        merge(
            owner,
            ws["id"],
            [{"keep_question_id": keep["id"], "duplicate_question_ids": [dup["id"]]}],
        ).status_code
        == 200
    )
    assert overview(owner, ws["id"])[keep["id"]]["is_favorite"] is True


def test_merging_a_kept_question_repoints_its_duplicates(seed: Any) -> None:
    owner = seed.client("dedup-repoint")
    ws = owner.create_workspace()
    stem = _stem()
    first = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    second = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    answer(owner, second, "o1")  # incorrect
    assert (
        merge(
            owner,
            ws["id"],
            [{"keep_question_id": first["id"], "duplicate_question_ids": [second["id"]]}],
        ).status_code
        == 200
    )
    third = owner.create_question(ws["id"], mcq(stem, TEXTS, "증발"))
    # Keep the newest this time: first is archived, second now folds into third.
    res = merge(
        owner,
        ws["id"],
        [{"keep_question_id": third["id"], "duplicate_question_ids": [first["id"]]}],
    )
    assert res.status_code == 200, res.text
    items = overview(owner, ws["id"])
    assert set(items) == {third["id"]}
    assert items[third["id"]]["status"] == "incorrect"
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        rows = conn.execute(
            "select duplicate_question_id::text, kept_question_id::text, end_reason "
            "from public.question_merges where workspace_id = %s order by created_at, id",
            (ws["id"],),
        ).fetchall()
    active = {(d, k) for d, k, reason in rows if reason is None}
    assert active == {(second["id"], third["id"]), (first["id"], third["id"])}
    assert (second["id"], first["id"], "repointed") in set(rows)


def test_import_review_flags_duplicates(seed: Any) -> None:
    owner = seed.client("dedup-import")
    ws = owner.create_workspace()
    truth = seed.truth_question(1)
    texts = [o["text"] for o in truth["options"]]
    # The same question typed by hand: another option order, other labels, extra spacing.
    existing = owner.create_question(
        ws["id"],
        {
            **mcq(
                f"1) {truth['stem']}  ( )",
                [f"({chr(65 + i)}) {t}" for i, t in enumerate(reversed(texts))],
                texts[1],
            ),
            "question_number": 7,
        },
    )
    run, drafts = owner.import_paper(ws["id"])
    target = seed.draft_for(drafts, 1)
    summaries = owner.ok("GET", f"/question-imports/{run['id']}/draft-summaries")["items"]
    flagged = {s["id"]: s["duplicate_of"] for s in summaries if s["duplicate_of"]}
    assert flagged == {
        target["id"]: {
            "kind": "question",
            "question_id": existing["id"],
            "draft_id": None,
            "number": 7,
        }
    }
    # The drafts page carries the same flag.
    page = {d["id"]: d for d in owner.drafts(run["id"])}
    assert page[target["id"]]["duplicate_of"]["question_id"] == existing["id"]
    assert all(d["duplicate_of"] is None for i, d in page.items() if i != target["id"])
    # Flagged drafts can still be registered on purpose.
    res = owner.approve_and_publish(
        run["id"], [{"draft_id": target["id"], "version": str(target["version"])}]
    )
    assert res.status_code == 200, res.text
    summaries = owner.ok("GET", f"/question-imports/{run['id']}/draft-summaries")["items"]
    assert all(s["duplicate_of"] is None for s in summaries)  # registered drafts are not flagged
