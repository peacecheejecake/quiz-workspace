"""UX12-REEXTRACT server guarantees C01-C04 (docs/screens/ux12-reextract.md, questions.md §6).

`다시 추출` reads the same revision again as a new run with fresh drafts; nothing registered moves.
Changed stems escape the fingerprint, so a draft says which earlier question it replaces and what
differs: the reviewer decides, nothing is applied by itself. Jobs run in this process (conftest).
"""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

pytestmark = pytest.mark.infra

IMPORT_RUNNING = "urn:quiz-workspace:problem:import-running"
NOT_READY = "urn:quiz-workspace:problem:document-not-ready"
CONTENT_KEYS = {"stem", "options", "correct_option_ids", "accepted_answers", "explanation"}


def _admin(seed: Any, sql: str, params: tuple[Any, ...]) -> list[tuple[Any, ...]]:
    with psycopg.connect(seed.DB_ADMIN_URL, autocommit=True) as conn:
        cur = conn.execute(sql, params)
        return cur.fetchall() if cur.description else []


def _reextract(client: Any, run_id: str, key: str | None = None) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    return client.call_with_headers("POST", f"/question-imports/{run_id}/re-extract", {}, headers)


def _accepted(client: Any, run_id: str, key: str | None = None) -> dict[str, Any]:
    run: dict[str, Any] = client.ok_response(_reextract(client, run_id, key), "POST", "r", (202,))
    return run


def _summaries(client: Any, run_id: str) -> dict[str, Any]:
    body: dict[str, Any] = client.ok("GET", f"/question-imports/{run_id}/draft-summaries")
    return body


def _runs(client: Any, workspace_id: str, document_id: str) -> list[dict[str, Any]]:
    path = f"/workspaces/{workspace_id}/question-imports?document_id={document_id}"
    runs: list[dict[str, Any]] = client.ok("GET", path)["items"]
    return runs


def _published(client: Any, seed: Any, run: dict[str, Any], number: int) -> dict[str, Any]:
    draft = seed.draft_for(client.drafts(run["id"]), number)
    res = client.publish(run["id"], [draft["id"]])
    body = client.ok_response(res, "POST", "publish", (200,))
    question: dict[str, Any] = client.get_question(body["items"][0]["question_id"])
    return question


def _parse_jobs(seed: Any, workspace_id: str) -> int:
    rows = _admin(
        seed,
        "select count(*) from public.async_jobs where workspace_id = %s "
        "and job_type = 'document.parse'",
        (workspace_id,),
    )
    return int(rows[0][0])


def test_ux12_reextract_c01_a_new_run_with_fresh_drafts_leaves_registered_questions(
    seed: Any,
) -> None:
    alice = seed.client("reextract-c01")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    question = _published(alice, seed, run, 1)
    parses = _parse_jobs(seed, ws["id"])

    fresh = _accepted(alice, run["id"])
    assert fresh["id"] != run["id"]
    assert fresh["reextract_of"] == run["id"]
    assert fresh["source_document_id"] == run["source_document_id"]
    assert fresh["source_document_revision_id"] == run["source_document_revision_id"]
    alice.wait_for_job(str(fresh["job_id"]))
    assert _parse_jobs(seed, ws["id"]) == parses

    new = alice.drafts(fresh["id"])
    assert len(new) == len(drafts)
    assert {d["id"] for d in new}.isdisjoint({d["id"] for d in drafts})
    assert all(d["published_question_id"] is None for d in new)
    assert all(d["review_status"] == "pending" for d in new)
    # The old run keeps its drafts and its link; the question did not move.
    assert seed.draft_for(alice.drafts(run["id"]), 1)["published_question_id"] == question["id"]
    assert alice.get_question(question["id"]) == question
    # The newest run is what the review shows; POST attaches to it.
    assert _runs(alice, ws["id"], run["source_document_id"])[0]["id"] == fresh["id"]
    attached = alice.ok_response(
        alice.start_import(ws["id"], run["source_document_id"]), "POST", "i", (202,)
    )
    assert attached["id"] == fresh["id"]


def test_ux12_reextract_c02_idempotency_and_one_running_run_per_document(seed: Any) -> None:
    alice = seed.client("reextract-c02")
    ws = alice.create_workspace()
    run, _ = alice.import_paper(ws["id"])
    document = run["source_document_id"]

    first = _accepted(alice, run["id"], "key-1")
    again = _accepted(alice, run["id"], "key-1")
    assert again["id"] == first["id"]
    assert again["job_id"] == first["job_id"]

    seed.problem(_reextract(alice, run["id"]), 409, IMPORT_RUNNING)
    seed.problem(_reextract(alice, first["id"], "key-2"), 409, IMPORT_RUNNING)
    assert len(_runs(alice, ws["id"], document)) == 2

    # A failed run cannot be retried beside a running one.
    _admin(
        seed,
        "update public.question_import_runs set status = 'failed', finished_at = now() "
        "where id = %s",
        (run["id"],),
    )
    retried = alice.call("POST", f"/question-imports/{run['id']}/retry", {})
    seed.problem(retried, 409, IMPORT_RUNNING)

    alice.wait_for_job(str(first["job_id"]))
    done = _accepted(alice, first["id"], "key-3")
    assert done["reextract_of"] == first["id"]
    alice.wait_for_job(str(done["job_id"]))


def test_ux12_reextract_c03_authorization(seed: Any) -> None:
    owner = seed.client("reextract-c03")
    viewer = seed.client("reextract-c03-viewer")
    stranger = seed.client("reextract-c03-stranger")
    ws = owner.create_workspace()
    run, _ = owner.import_paper(ws["id"])
    seed.membership(ws["id"], viewer.user, "viewer")
    document = run["source_document_id"]

    seed.problem(_reextract(viewer, run["id"]), 403, seed.INSUFFICIENT_ROLE)
    assert _reextract(stranger, run["id"]).status_code == 404
    assert _reextract(owner, seed.new_id()).status_code == 404

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    seed.problem(_reextract(owner, run["id"]), 403, seed.ARCHIVED)
    owner.ok("POST", f"/workspaces/{ws['id']}/restore")

    status = "update public.documents set status = %s where id = %s"
    _admin(seed, status, ("processing", document))
    seed.problem(_reextract(owner, run["id"]), 409, NOT_READY)
    _admin(seed, status, ("ready", document))
    _admin(seed, "update public.documents set deleted_at = now() where id = %s", (document,))
    seed.problem(_reextract(owner, run["id"]), 409, NOT_READY)
    assert len(owner.ok("GET", f"/workspaces/{ws['id']}/question-imports")["items"]) == 1


def test_ux12_reextract_c04_drafts_say_what_changed_against_the_earlier_question(
    seed: Any,
) -> None:
    alice = seed.client("reextract-c04")
    viewer = seed.client("reextract-c04-viewer")
    ws = alice.create_workspace()
    run, _ = alice.import_paper(ws["id"])
    seed.membership(ws["id"], viewer.user, "viewer")
    same = _published(alice, seed, run, 1)
    edited = _published(alice, seed, run, 5)
    answer = _published(alice, seed, run, 2)

    # What the extractor would now print differently: the bank differs from the paper.
    alice.ok(
        "PATCH",
        f"/questions/{edited['id']}",
        {"base_revision_id": edited["revision"]["id"], "stem": "고친 뒤의 발문"},
    )
    edited = alice.get_question(edited["id"])
    alice.ok(
        "PATCH",
        f"/questions/{answer['id']}",
        {
            "base_revision_id": answer["revision"]["id"],
            "correct_option_ids": answer["revision"]["correct_option_ids"][:-1],
        },
    )
    # A number that is gone from the new extraction, and one that is new.
    gone = seed.draft_for(alice.drafts(run["id"]), 8)
    _admin(
        seed,
        "update public.question_drafts set payload = jsonb_set(payload, '{id}', '\"old-q208\"'), "
        "question_number = 208 where id = %s",
        (gone["id"],),
    )

    fresh = _accepted(alice, run["id"])
    alice.wait_for_job(str(fresh["job_id"]))
    drafts = alice.drafts(fresh["id"])
    previous = {n: seed.draft_for(drafts, n)["previous"] for n in (1, 2, 4, 5, 8)}

    assert previous[1]["question_id"] == same["id"]
    assert previous[1]["changed"] == []
    assert previous[5]["question_id"] == edited["id"]
    assert previous[5]["revision_id"] == edited["revision"]["id"]
    assert previous[5]["number"] == 5
    assert previous[5]["changed"] == ["stem"]
    assert previous[2]["changed"] == ["answer"]
    assert previous[4] == {"question_id": None, "revision_id": None, "number": 4, "changed": []}
    assert previous[8] is None

    body = _summaries(viewer, fresh["id"])
    assert body["missing_previous"] == [208]
    by_id = {d["id"]: d for d in body["items"]}
    assert by_id[seed.draft_for(drafts, 5)["id"]]["previous"] == previous[5]
    for item in body["items"]:
        assert CONTENT_KEYS.isdisjoint(item), item

    # Archiving the earlier question (the replace path) leaves no link to it.
    alice.ok(
        "PATCH",
        f"/questions/{edited['id']}",
        {"base_revision_id": edited["revision"]["id"], "publication_status": "ARCHIVED"},
    )
    assert seed.draft_for(alice.drafts(fresh["id"]), 5)["previous"]["question_id"] is None
    # An ordinary run has no comparison at all.
    assert alice.ok("GET", f"/question-imports/{run['id']}")["reextract_of"] is None
    assert seed.draft_for(alice.drafts(run["id"]), 5)["previous"] is None
    assert _summaries(alice, run["id"])["missing_previous"] == []
