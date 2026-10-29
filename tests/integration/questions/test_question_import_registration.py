"""QIMP-JOB: the import page submits the whole selection once and the server approves and
registers it (`POST /question-imports/{id}/registrations` + the `question.import_register` job),
whether or not the page stays open (QIMPORT-01-AC07).

Fixtures: conftest.py (jobs run in-process; the registration job uses batches of 3 here, so the
8-draft paper takes several transactions). Needs migration 20261023120000.
"""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
import pytest

pytestmark = pytest.mark.infra

RUNNING = "urn:quiz-workspace:problem:import-registration-running"
DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def _item(draft: dict[str, Any]) -> dict[str, str]:
    return {"draft_id": draft["id"], "version": draft["version"]}


def _review_of(draft_id: str) -> tuple[str, str | None, Any]:
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute(
            "select review_status, reviewed_by::text, published_question_id::text "
            "from public.question_drafts where id = %s",
            (draft_id,),
        ).fetchone()
    assert row is not None
    return row[0], row[1], row[2]


def _submit(client: Any, run_id: str, items: list[dict[str, str]], **kw: Any) -> dict[str, Any]:
    out: dict[str, Any] = client.ok_response(
        client.register(run_id, items, **kw), "POST", "registrations", (202,)
    )
    return out


def test_qimport_01_ac07_the_server_registers_the_whole_selection(seed: Any) -> None:
    """One request records the selection; the job (not the request, not the browser) approves and
    registers it; a draft that cannot be confirmed is refused at once and left as it was."""
    alice = seed.client("qjob-all")
    viewer = seed.client("qjob-all-viewer")
    ws = alice.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    run, drafts = alice.import_paper(ws["id"])
    q3 = seed.draft_for(drafts, 3)
    assert q3["publishable"] is False
    selection = [_item(d) for d in drafts]

    key = f"k-{uuid.uuid4()}"
    submitted = _submit(alice, run["id"], selection, idempotency_key=key)
    assert submitted["import_id"] == run["id"]
    assert submitted["status"] == "queued"
    assert (submitted["total"], submitted["registered"]) == (8, 0)
    assert submitted["processed"] == 1
    assert [r["draft_id"] for r in submitted["refused"]] == [q3["id"]]
    assert submitted["refused"][0]["reason"] == "not-publishable"
    assert submitted["refused"][0]["question_number"] == 3
    # The request itself registers nothing; the run points at the registration for reattaching.
    assert alice.list_questions(ws["id"]) == []
    assert (
        alice.ok("GET", f"/question-imports/{run['id']}")["registration_job_id"]
        == (submitted["job_id"])
    )
    # A lost response replayed with the same key is the same registration.
    replay = _submit(alice, run["id"], selection, idempotency_key=key)
    assert replay["job_id"] == submitted["job_id"]

    alice.wait_for_job(submitted["job_id"])

    done = viewer.registration(run["id"], submitted["job_id"])
    assert done["status"] == "succeeded"
    assert (done["total"], done["processed"], done["registered"], done["skipped"]) == (8, 8, 7, 0)
    bank = alice.list_questions(ws["id"])
    assert len(bank) == 7
    assert all(q["publication_status"] == "CONFIRMED" and q["origin"] == "import" for q in bank)
    for draft in drafts:
        status, reviewer, question = _review_of(draft["id"])
        if draft["id"] == q3["id"]:
            assert (status, reviewer, question) == ("pending", None, None)
        else:
            assert (status, reviewer) == ("approved", alice.user.id)
            assert question in {q["id"] for q in bank}
    assert alice.ok("GET", f"/question-imports/{run['id']}")["published_count"] == 7
    q1 = alice.get_question(_review_of(seed.draft_for(drafts, 1)["id"])[2])
    [source] = q1["sources"]
    assert source["document_revision_id"] == run["source_document_revision_id"]

    # Submitting the same selection again registers nothing twice.
    again = _submit(alice, run["id"], selection)
    alice.wait_for_job(again["job_id"])
    second = alice.registration(run["id"], again["job_id"])
    assert (second["registered"], second["skipped"]) == (0, 7)
    assert len(alice.list_questions(ws["id"])) == 7


class _InterruptedStore:
    """Delegates to the real store and fails once after the first batch (a crashed worker)."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    def register_batch(self, job_id: uuid.UUID, limit: int) -> Any:
        self.calls += 1
        if self.calls == 2:
            raise ConnectionError("worker lost its database connection")
        return self.inner.register_batch(job_id, limit)


def test_qimport_01_ac07_an_interrupted_registration_resumes_without_duplicates(
    seed: Any, job_worker: Any
) -> None:
    alice = seed.client("qjob-resume")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    selection = [_item(d) for d in drafts if d["publishable"]]
    submitted = _submit(alice, run["id"], selection)

    deps = job_worker.register_deps
    real = deps.store
    deps.store = _InterruptedStore(real)
    try:
        job_worker.run_once(submitted["job_id"])
    finally:
        deps.store = real
    halfway = alice.registration(run["id"], submitted["job_id"])
    assert halfway["status"] in {"queued", "running"}
    assert halfway["processed"] == 3
    assert len(alice.list_questions(ws["id"])) == 3

    alice.wait_for_job(submitted["job_id"])
    done = alice.registration(run["id"], submitted["job_id"])
    assert (done["status"], done["registered"]) == ("succeeded", len(selection))
    bank = alice.list_questions(ws["id"])
    assert len(bank) == len(selection)
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        rows = conn.execute(
            "select count(*), count(distinct published_question_id) from public.question_drafts "
            "where import_run_id = %s and published_question_id is not null",
            (run["id"],),
        ).fetchone()
    assert rows == (len(selection), len(selection))


def test_qimport_01_ac07_a_draft_changed_after_submitting_is_refused_by_the_job(
    seed: Any,
) -> None:
    alice = seed.client("qjob-stale")
    bob = seed.client("qjob-stale-bob")
    ws = alice.create_workspace()
    seed.membership(ws["id"], bob.user, "editor")
    run, drafts = alice.import_paper(ws["id"])
    q1, q2 = seed.draft_for(drafts, 1), seed.draft_for(drafts, 2)
    submitted = _submit(alice, run["id"], [_item(q1), _item(q2)])

    bob.ok(
        "PATCH",
        f"/question-drafts/{q1['id']}",
        {"base_version": q1["version"], "stem": "바뀐 문제: 물이 기체로 변하는 과정은?"},
    )
    alice.wait_for_job(submitted["job_id"])

    done = alice.registration(run["id"], submitted["job_id"])
    assert done["registered"] == 1
    assert done["refused"] == [
        {"draft_id": q1["id"], "reason": "stale-draft", "question_number": 1, "position": 0}
    ]
    assert _review_of(q1["id"]) == ("pending", None, None)
    assert _review_of(q2["id"])[2] is not None


def test_qimport_01_ac07_registration_keeps_the_authorization_boundary(seed: Any) -> None:
    """Editors submit (viewers 403, others 404, a foreign draft 404, archived 403); the job runs
    for the submitter and stops when the workspace is archived meanwhile."""
    owner = seed.client("qjob-authz")
    viewer = seed.client("qjob-authz-viewer")
    mallory = seed.client("qjob-authz-mallory")
    ws = owner.create_workspace()
    seed.membership(ws["id"], viewer.user, "viewer")
    run, drafts = owner.import_paper(ws["id"])
    _, other_drafts = owner.import_paper(ws["id"])
    selection = [_item(seed.draft_for(drafts, n)) for n in (1, 2, 4)]

    seed.problem(mallory.register(run["id"], selection), 404)
    seed.problem(viewer.register(run["id"], selection), 403, seed.INSUFFICIENT_ROLE)
    foreign = _item(seed.draft_for(other_drafts, 1))
    seed.problem(owner.register(run["id"], [*selection, foreign]), 404)
    assert owner.ok("GET", f"/question-imports/{run['id']}")["registration_job_id"] is None

    submitted = _submit(owner, run["id"], selection)
    # A second submission while the first is still queued is refused.
    seed.problem(owner.register(run["id"], selection), 409, RUNNING)
    seed.problem(
        mallory.call("GET", f"/question-imports/{run['id']}/registrations/{submitted['job_id']}"),
        404,
    )
    seed.problem(
        owner.call("GET", f"/question-imports/{run['id']}/registrations/{run['job_id']}"), 404
    )

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    owner.wait_for_job(submitted["job_id"], expected="failed")
    stopped = viewer.registration(run["id"], submitted["job_id"])
    assert (stopped["status"], stopped["error_code"]) == ("failed", "workspace_unavailable")
    assert (stopped["processed"], stopped["registered"]) == (0, 0)
    assert owner.list_questions(ws["id"]) == []
    seed.problem(owner.register(run["id"], selection), 403, seed.ARCHIVED)


def test_the_worker_role_cannot_move_registration_items(seed: Any) -> None:
    """Least privilege (20261023120000): quiz_worker reads items and calls the function only."""
    alice = seed.client("qjob-grants")
    ws = alice.create_workspace()
    run, drafts = alice.import_paper(ws["id"])
    submitted = _submit(alice, run["id"], [_item(seed.draft_for(drafts, 1))])
    with psycopg.connect(seed.worker_database_url(), autocommit=True) as conn:
        for sql in (
            "update public.question_import_registration_items set state = 'registered' "
            "where job_id = %s",
            "delete from public.question_import_registration_items where job_id = %s",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql, (submitted["job_id"],))
