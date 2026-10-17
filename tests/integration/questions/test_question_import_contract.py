"""QIMPORT-01 server guarantees (docs/questions.md §6, architecture.md §6, AGENTS.md §5 Data).

A question-PDF import produces drafts only: drafts never reach the bank until a human approves
them, only the approved subset is published, an answer the PDF's key does not give stays null
(never invented, also after publishing), drafts keep page provenance, retries are idempotent,
and only editors of a non-archived workspace may import or publish. Uses the synthetic
questions-ko.pdf (8 questions; key covers 1, 2, 4, 5, 8) with the worker's fake LLM adapter.
Fixtures: conftest.py (assumptions A4/A5 in tests/e2e/fixtures/questions.ts).
"""

from __future__ import annotations

from typing import Any

import pytest

# GREEN since M4.4a (RED in M4.0). Jobs run in-process (conftest.JobWorker).
pytestmark = pytest.mark.infra


def _no_imports_yet(client: Any, workspace_id: str) -> None:
    assert client.ok("GET", f"/workspaces/{workspace_id}/question-imports")["items"] == []


def test_qimport_01_ac01_drafts_carry_page_provenance_and_stay_out_of_the_bank(seed: Any) -> None:
    alice = seed.client("qimport01-ac01")
    ws = alice.create_workspace()
    _no_imports_yet(alice, ws["id"])
    run, drafts = alice.import_paper(ws["id"])

    truth = seed.QUESTION_TRUTH["questions"]
    assert len(drafts) == len(truth)
    for t in truth:
        draft = seed.draft_for(drafts, t["number"])
        assert draft["question_type"] == t["question_type"]
        assert draft["review_status"] == "pending"
        assert draft["published_question_id"] is None
        assert draft["payload"]["origin"] == "pdf_import"
        evidence = draft["payload"]["evidence"]
        assert evidence, f"question {t['number']} has no provenance"
        assert evidence[0]["document_id"] == run["source_document_id"]
        assert t["page"] in [loc["page"] for loc in evidence[0]["locations"]]

    # Drafts are isolated: not in the bank, not readable as questions.
    assert alice.list_questions(ws["id"]) == []
    for draft in drafts:
        seed.problem(alice.call("GET", f"/questions/{draft['id']}"), 404)


def test_qimport_01_ac02_missing_answers_stay_null_through_publish(seed: Any) -> None:
    alice = seed.client("qimport01-ac02")
    ws = alice.create_workspace()
    _no_imports_yet(alice, ws["id"])
    run, drafts = alice.import_paper(ws["id"])

    for number in (3, 6, 7):  # not covered by the printed answer key
        payload = seed.draft_for(drafts, number)["payload"]
        assert payload["correct_option_ids"] is None, number
        assert payload["accepted_answers"] is None, number
    q1 = seed.draft_for(drafts, 1)["payload"]
    evaporation = next(o["id"] for o in q1["options"] if o["text"] == "증발")
    assert q1["correct_option_ids"] == [evaporation]
    assert seed.draft_for(drafts, 4)["payload"]["accepted_answers"] == ["응결"]

    # Publishing the short-answer and essay drafts keeps the unknown answer null.
    short, essay = seed.draft_for(drafts, 6), seed.draft_for(drafts, 7)
    alice.ok_response(
        alice.publish(run["id"], [short["id"], essay["id"]]), "POST", "publish", (200,)
    )
    bank = {q["revision"]["stem"]: q for q in alice.list_questions(ws["id"])}
    assert len(bank) == 2
    for q in bank.values():
        assert q["revision"]["accepted_answers"] is None
        assert q["revision"]["correct_option_ids"] is None

    # An MCQ draft without an answer cannot be confirmed as-is, and no answer is made up for it.
    q3 = seed.draft_for(drafts, 3)
    refused = alice.publish(run["id"], [q3["id"]])
    assert refused.status_code == 422, f"HTTP {refused.status_code}"
    assert len(alice.list_questions(ws["id"])) == 2
    after = seed.draft_for(alice.drafts(run["id"]), 3)
    assert after["published_question_id"] is None
    assert after["payload"]["correct_option_ids"] is None


def test_qimport_01_ac03_only_approved_drafts_are_registered(seed: Any) -> None:
    alice = seed.client("qimport01-ac03")
    ws = alice.create_workspace()
    _no_imports_yet(alice, ws["id"])
    run, drafts = alice.import_paper(ws["id"])
    approved = {1: seed.draft_for(drafts, 1), 2: seed.draft_for(drafts, 2)}

    res = alice.publish(run["id"], [d["id"] for d in approved.values()])
    published = alice.ok_response(res, "POST", "publish", (200,))["items"]
    assert {p["draft_id"] for p in published} == {d["id"] for d in approved.values()}

    bank = alice.list_questions(ws["id"])
    assert {q["id"] for q in bank} == {p["question_id"] for p in published}
    for number, draft in approved.items():
        question = next(q for q in bank if q["id"] == draft_question(published, draft["id"]))
        assert question["publication_status"] == "CONFIRMED"
        assert question["question_type"] == draft["question_type"]
        assert question["revision"]["options"] == draft["payload"]["options"]
        assert question["revision"]["correct_option_ids"] == draft["payload"]["correct_option_ids"]
        page = seed.truth_question(number)["page"]
        assert [(s["document_id"], s["page_start"]) for s in question["sources"]] == [
            (run["source_document_id"], page)
        ]

    for draft in alice.drafts(run["id"]):
        if draft["id"] in {d["id"] for d in approved.values()}:
            assert draft["review_status"] == "approved"
            assert draft["published_question_id"] is not None
        else:
            assert draft["review_status"] == "pending"
            assert draft["published_question_id"] is None

    # A draft id that does not belong to this import is refused without registering anything.
    unknown = alice.publish(run["id"], [seed.new_id()])
    assert unknown.status_code in {404, 422}, f"HTTP {unknown.status_code}"
    assert len(alice.list_questions(ws["id"])) == len(approved)


def draft_question(published: list[dict[str, Any]], draft_id: str) -> str:
    return str(next(p["question_id"] for p in published if p["draft_id"] == draft_id))


def test_qimport_01_ac03_import_and_publish_need_an_editor_of_an_active_workspace(
    seed: Any,
) -> None:
    owner = seed.client("qimport01-ac03-owner")
    viewer = seed.client("qimport01-ac03-viewer")
    mallory = seed.client("qimport01-ac03-mallory")
    ws = owner.create_workspace()
    _no_imports_yet(owner, ws["id"])
    run, drafts = owner.import_paper(ws["id"])
    seed.membership(ws["id"], viewer.user, "viewer")
    first = drafts[0]["id"]

    # Other users: the run, its drafts and the workspace's imports do not exist for them.
    for method, path, body in (
        ("GET", f"/question-imports/{run['id']}", None),
        ("GET", f"/question-imports/{run['id']}/drafts", None),
        ("POST", f"/question-imports/{run['id']}/publish", {"draft_ids": [first]}),
        ("GET", f"/workspaces/{ws['id']}/question-imports", None),
        ("POST", f"/workspaces/{ws['id']}/question-imports", {"document_id": seed.new_id()}),
    ):
        res = mallory.call(method, path, body)
        seed.problem(res, 404)
        assert "questions-ko" not in res.text

    # Viewers can read drafts but cannot import or publish.
    assert len(viewer.drafts(run["id"])) == len(drafts)
    seed.problem(
        viewer.call("POST", f"/question-imports/{run['id']}/publish", {"draft_ids": [first]}),
        403,
        seed.INSUFFICIENT_ROLE,
    )
    seed.problem(
        viewer.call(
            "POST",
            f"/workspaces/{ws['id']}/question-imports",
            {"document_id": run["source_document_id"]},
        ),
        403,
        seed.INSUFFICIENT_ROLE,
    )

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    seed.problem(
        owner.call("POST", f"/question-imports/{run['id']}/publish", {"draft_ids": [first]}),
        403,
        seed.ARCHIVED,
    )
    seed.problem(owner.start_import(ws["id"], str(run["source_document_id"])), 403, seed.ARCHIVED)
    assert owner.list_questions(ws["id"]) == []


def test_qimport_01_ac04_retries_do_not_duplicate_runs_drafts_or_questions(seed: Any) -> None:
    alice = seed.client("qimport01-ac04")
    ws = alice.create_workspace()
    _no_imports_yet(alice, ws["id"])
    document_id = alice.upload_question_paper(ws["id"])

    # A retried start (e.g. after a lost response) with the same key returns the same run.
    key = f"qimport-{seed.new_id()}"
    first = alice.ok_response(alice.start_import(ws["id"], document_id, key), "POST", "i", (202,))
    again = alice.start_import(ws["id"], document_id, key)
    assert again.status_code in {200, 202}, f"HTTP {again.status_code}"
    assert again.json()["id"] == first["id"]
    alice.wait_for_job(str(first["job_id"]))
    runs = alice.ok("GET", f"/workspaces/{ws['id']}/question-imports")["items"]
    assert [r["id"] for r in runs] == [first["id"]]
    drafts = alice.drafts(first["id"])
    assert len(drafts) == len(seed.QUESTION_TRUTH["questions"])

    # A retried publish returns the same questions and registers nothing twice.
    ids = [seed.draft_for(drafts, 1)["id"], seed.draft_for(drafts, 5)["id"]]
    once = alice.ok_response(alice.publish(first["id"], ids), "POST", "publish", (200,))
    twice = alice.ok_response(alice.publish(first["id"], ids), "POST", "publish", (200,))

    def mapping(body: dict[str, Any]) -> dict[str, str]:
        return {p["draft_id"]: p["question_id"] for p in body["items"]}

    assert mapping(twice) == mapping(once)
    bank = alice.list_questions(ws["id"])
    assert sorted(q["id"] for q in bank) == sorted(mapping(once).values())
    assert len(alice.drafts(first["id"])) == len(drafts)


def test_qimport_01_ac04_retrying_a_failed_import_job_does_not_duplicate_drafts(seed: Any) -> None:
    alice = seed.client("qimport01-ac04-job")
    ws = alice.create_workspace()
    _no_imports_yet(alice, ws["id"])
    # Same bytes as questions-ko.pdf; the marker makes the fake extractor fail the first job
    # after it persisted part of the drafts (A7).
    document_id = alice.upload_question_paper(
        ws["id"], f"questions-ko-{seed.IMPORT_FAILURE_MARKER}.pdf"
    )
    run = alice.ok_response(alice.start_import(ws["id"], document_id), "POST", "import", (202,))
    alice.wait_for_job(str(run["job_id"]), expected="failed")
    assert alice.ok("GET", f"/question-imports/{run['id']}")["status"] == "failed"
    partial = alice.drafts(run["id"])
    # A strict, non-empty subset survives the failure (A7), so the retry must reconcile with it.
    assert 0 < len(partial) < len(seed.QUESTION_TRUTH["questions"])
    assert all(d["published_question_id"] is None for d in partial)

    retried = alice.retry_import(str(run["id"]))
    assert retried["id"] == run["id"]
    assert retried["job_id"] != run["job_id"]
    alice.wait_for_job(str(retried["job_id"]))
    assert alice.ok("GET", f"/question-imports/{run['id']}")["status"] == "succeeded"
    runs = alice.ok("GET", f"/workspaces/{ws['id']}/question-imports")["items"]
    assert [r["id"] for r in runs] == [run["id"]]

    drafts = alice.drafts(run["id"])
    truth = seed.QUESTION_TRUTH["questions"]
    assert len(drafts) == len(truth)
    assert len({d["position"] for d in drafts}) == len(drafts)
    for t in truth:
        seed.draft_for(drafts, t["number"])  # asserts exactly one draft per question

    ids = [seed.draft_for(drafts, 1)["id"], seed.draft_for(drafts, 2)["id"]]
    published = alice.ok_response(alice.publish(run["id"], ids), "POST", "publish", (200,))
    question_ids = [p["question_id"] for p in published["items"]]
    assert len(set(question_ids)) == len(ids)
    assert sorted(q["id"] for q in alice.list_questions(ws["id"])) == sorted(question_ids)
