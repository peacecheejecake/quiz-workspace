"""M4.4a import API guarantees beyond the QIMPORT-01 contract: what an import may start from,
draft review (edit / approve / reject, optimistic concurrency, published drafts are frozen), what
a published import question carries, and the conflict answers of retry/idempotency.

Fixtures: conftest.py (jobs run in-process). Needs the 20261018100000 migration.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

NOT_READY = "urn:quiz-workspace:problem:document-not-ready"
NOT_RETRYABLE = "urn:quiz-workspace:problem:import-not-retryable"
STALE_DRAFT = "urn:quiz-workspace:problem:stale-draft"
DRAFT_PUBLISHED = "urn:quiz-workspace:problem:draft-published"
KEY_REUSED = "urn:quiz-workspace:problem:idempotency-key-reused"
PAPER = Path(__file__).resolve().parents[2] / "fixtures" / "pdfs" / "questions-ko.pdf"


def _patch(client: Any, draft: dict[str, Any], **body: Any) -> httpx.Response:
    res: httpx.Response = client.call(
        "PATCH", f"/question-drafts/{draft['id']}", {"base_version": draft["version"], **body}
    )
    return res


def _unparsed_paper(client: Any, workspace_id: str) -> str:
    """A question paper whose parse job has not run yet (document `processing`)."""
    pdf = PAPER.read_bytes()
    sha256 = hashlib.sha256(pdf).hexdigest()
    intent = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": "q.pdf",
            "size_bytes": len(pdf),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": "question_paper",
        },
        (201,),
    )
    assert urlsplit(intent["upload_url"]).hostname in {"127.0.0.1", "localhost"}
    put = httpx.put(intent["upload_url"], content=pdf, headers=intent["upload_headers"])
    assert put.is_success
    done = client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )
    return str(done["document_id"])


def test_an_import_starts_only_from_a_ready_question_paper_of_the_workspace(seed: Any) -> None:
    alice = seed.client("m44a-start")
    ws = alice.create_workspace()
    other = alice.create_workspace()

    # A document of another workspace is unknown here.
    foreign = alice.upload_question_paper(other["id"])
    res = alice.start_import(ws["id"], foreign)
    assert seed.problem(res, 422)["errors"][0]["loc"] == ["body", "document_id"]
    seed.problem(alice.start_import(ws["id"], seed.new_id()), 422)
    # Still processing.
    seed.problem(alice.start_import(ws["id"], _unparsed_paper(alice, ws["id"])), 409, NOT_READY)
    # A book is not a question paper.
    _, _, book = alice.upload_book(ws["id"])
    alice.wait_for_job(str(book["job_id"]))
    seed.problem(alice.start_import(ws["id"], str(book["document_id"])), 422)

    assert alice.ok("GET", f"/workspaces/{ws['id']}/question-imports")["items"] == []


def test_an_idempotency_key_cannot_be_reused_for_another_paper(seed: Any) -> None:
    alice = seed.client("m44a-idem")
    ws = alice.create_workspace()
    first, second = (alice.upload_question_paper(ws["id"]) for _ in range(2))
    key = f"k-{seed.new_id()}"
    run = alice.ok_response(alice.start_import(ws["id"], first, key), "POST", "i", (202,))
    seed.problem(alice.start_import(ws["id"], second, key), 409, KEY_REUSED)
    runs = alice.ok("GET", f"/workspaces/{ws['id']}/question-imports")["items"]
    assert [r["id"] for r in runs] == [run["id"]]


def test_review_edits_answers_approves_and_freezes_published_drafts(seed: Any) -> None:
    alice = seed.client("m44a-review")
    viewer = seed.client("m44a-review-viewer")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    seed.membership(ws["id"], viewer.user, "viewer")
    q3 = seed.draft_for(drafts, 3)
    assert q3["answer_missing"] is True
    assert q3["publishable"] is False
    assert q3["pages"] == [1]
    assert q3["question_number"] == 3

    # Approving a draft that cannot be confirmed is refused; nothing changes.
    seed.problem(_patch(alice, q3, review_status="approved"), 422)
    seed.problem(_patch(viewer, q3, correct_option_ids=["opt-3"]), 403, seed.INSUFFICIENT_ROLE)

    # The reviewer enters the answer the paper does not print.
    evaporation = next(o["id"] for o in q3["payload"]["options"] if o["text"] == "증발")
    edited = alice.ok_response(
        _patch(alice, q3, correct_option_ids=[evaporation]), "PATCH", "edit", (200,)
    )
    assert edited["payload"]["correct_option_ids"] == [evaporation]
    assert edited["answer_missing"] is False
    assert edited["publishable"] is True
    assert "answer_missing" not in {v["code"] for v in edited["validations"]}
    assert edited["payload"]["evidence"] == q3["payload"]["evidence"]
    assert edited["version"] != q3["version"]
    # An edit based on the old version is refused.
    seed.problem(_patch(alice, q3, stem="다른 문제"), 409, STALE_DRAFT)
    # An unknown answer id is not storable.
    seed.problem(_patch(alice, edited, correct_option_ids=["opt-9"]), 422)

    approved = alice.ok_response(
        _patch(alice, edited, review_status="approved"), "PATCH", "approve", (200,)
    )
    assert approved["review_status"] == "approved"
    assert approved["published_question_id"] is None
    assert alice.list_questions(ws["id"]) == []  # approval alone registers nothing

    published = alice.ok_response(alice.publish(run["id"], [q3["id"]]), "POST", "p", (200,))
    question = alice.get_question(published["items"][0]["question_id"])
    assert question["publication_status"] == "CONFIRMED"
    assert question["origin"] == "import"
    assert question["question_number"] == 3
    assert question["revision"]["correct_option_ids"] == [evaporation]
    assert question["revision"]["is_multi_answer"] is False
    [source] = question["sources"]
    assert source["document_id"] == run["source_document_id"]
    assert source["document_revision_id"] == run["source_document_revision_id"]
    assert (source["page_start"], source["page_end"]) == (1, 1)

    after = seed.draft_for(alice.drafts(run["id"]), 3)
    seed.problem(_patch(alice, after, stem="바꾼 문제"), 409, DRAFT_PUBLISHED)


def test_rejected_drafts_stay_out_and_multi_answer_is_kept(seed: Any) -> None:
    alice = seed.client("m44a-reject")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    q1, q2 = seed.draft_for(drafts, 1), seed.draft_for(drafts, 2)
    rejected = alice.ok_response(
        _patch(alice, q1, review_status="rejected"), "PATCH", "reject", (200,)
    )
    assert rejected["review_status"] == "rejected"
    assert q2["is_multi_answer"] is True

    published = alice.ok_response(alice.publish(run["id"], [q2["id"]]), "POST", "p", (200,))
    bank = alice.list_questions(ws["id"])
    assert [q["id"] for q in bank] == [published["items"][0]["question_id"]]
    assert bank[0]["revision"]["is_multi_answer"] is True
    assert sorted(bank[0]["revision"]["correct_option_ids"]) == ["opt-A", "opt-C", "opt-D"]
    run_after = alice.ok("GET", f"/question-imports/{run['id']}")
    assert (run_after["draft_count"], run_after["published_count"]) == (8, 1)


def test_publish_is_all_or_nothing_and_scoped_to_its_import(seed: Any) -> None:
    alice = seed.client("m44a-publish")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    other_run, other_drafts = alice.import_paper(ws["id"])

    # A draft of another import of the same workspace is not part of this one.
    mixed = [seed.draft_for(drafts, 1)["id"], seed.draft_for(other_drafts, 1)["id"]]
    seed.problem(alice.publish(run["id"], mixed), 404)
    # One blocked draft (MCQ without answer) blocks the whole request.
    blocked = [seed.draft_for(drafts, 1)["id"], seed.draft_for(drafts, 3)["id"]]
    res = alice.publish(run["id"], blocked)
    assert seed.problem(res, 422)["errors"][0]["loc"][:3] == ["body", "draft_ids", 1]
    assert alice.list_questions(ws["id"]) == []
    assert all(d["review_status"] == "pending" for d in alice.drafts(run["id"]))
    assert other_run["id"] != run["id"]


def test_only_failed_or_cancelled_runs_can_be_retried(seed: Any) -> None:
    alice = seed.client("m44a-retry")
    ws = alice.create_workspace()
    run, _ = alice.import_paper(ws["id"])
    res = alice.call("POST", f"/question-imports/{run['id']}/retry", {})
    seed.problem(res, 409, NOT_RETRYABLE)
    assert alice.ok("GET", f"/question-imports/{run['id']}")["job_id"] == run["job_id"]


def test_the_worker_role_cannot_touch_reviewed_drafts(seed: Any) -> None:
    """Least privilege (20261018100000): quiz_worker inserts pending import drafts only."""
    alice = seed.client("m44a-grants")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    worker_url = seed.worker_database_url()
    with psycopg.connect(worker_url, autocommit=True) as conn:
        for sql in (
            "update public.question_drafts set review_status = 'approved' where id = %s",
            "delete from public.question_drafts where id = %s",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql, (drafts[0]["id"],))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "update public.question_import_runs set source_document_id = null where id = %s",
                (run["id"],),
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "insert into public.question_drafts (workspace_id, source_type, import_run_id, "
                "position, question_type, payload, review_status, reviewed_at) "
                "values (%s, 'import', %s, 99, 'ESSAY', '{}'::jsonb, 'approved', now())",
                (ws["id"], run["id"]),
            )
