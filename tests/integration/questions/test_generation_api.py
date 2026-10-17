"""M6.2 generation API guarantees beyond the QGEN-01 contract: drafts never become dots before a
human approves and registers them (DoD), job idempotency, cross-workspace isolation, and that
generated answers never reach anyone outside the workspace (nor job results, activity or logs).

Fixtures: conftest.py (jobs run in-process with the APP_ENV=test ScenarioLLMClient). Needs the
20261018150000 migration.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

SCENARIO_FILE = Path(__file__).resolve().parents[2] / "fixtures/llm/generation-scenarios.json"
SCENARIOS: dict[str, Any] = json.loads(SCENARIO_FILE.read_text(encoding="utf-8"))
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
STALE_DRAFT = "urn:quiz-workspace:problem:stale-draft"
NOT_APPROVED = "urn:quiz-workspace:problem:draft-not-approved"
NOT_CONFIRMED = "urn:quiz-workspace:problem:question-not-confirmed"
KEY_REUSED = "urn:quiz-workspace:problem:idempotency-key-reused"
DRAFT_PUBLISHED = "urn:quiz-workspace:problem:draft-published"


def _source_input(name: str, document_id: str) -> dict[str, Any]:
    s = SCENARIOS["sources"][name]
    page = s["source_page"]
    return {
        "question_type": s["question_type"],
        "stem": f"{s['stem']} [{s['marker']}]",
        "options": s["options"],
        "correct_option_ids": s["correct_option_ids"],
        "is_multi_answer": s["is_multi_answer"],
        "explanation": s["explanation"],
        "question_number": 1,
        "sources": [{"document_id": document_id, "page_start": page, "page_end": page}],
    }


def _candidates() -> list[dict[str, Any]]:
    ok = next(s for s in SCENARIOS["scenarios"] if s["marker"] == "E2E-LLM-OK")
    return [c for r in ok["responses"].values() for c in r["candidates"]]


def _with_source(
    seed: Any, label: str, name: str = "disinfection"
) -> tuple[Any, str, dict[str, Any]]:
    owner = seed.client(label)
    ws = owner.create_workspace()
    _upload, _sha, done = owner.upload_book(ws["id"])
    owner.wait_for_job(str(done["job_id"]))
    source = owner.create_question(ws["id"], _source_input(name, str(done["document_id"])))
    return owner, ws["id"], source


def _start(client: Any, question_id: str, types: list[str], **extra: Any) -> httpx.Response:
    headers = extra.pop("headers", {})
    res: httpx.Response = client.call_with_headers(
        "POST",
        f"/questions/{question_id}/generations",
        {"variation_types": types, **extra},
        headers,
    )
    return res


def _generate(client: Any, question_id: str, types: list[str]) -> tuple[dict[str, Any], list[Any]]:
    res = _start(client, question_id, types)
    assert res.status_code == 202, res.text[:300]
    run = res.json()
    client.wait_for_job(str(run["job_id"]))
    return client.ok("GET", f"/question-generations/{run['id']}"), _drafts(client, run["id"])


def _drafts(client: Any, run_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok("GET", f"/question-generations/{run_id}/drafts")[
        "items"
    ]
    return sorted(items, key=lambda d: int(d["position"]))


def _patch(client: Any, draft: dict[str, Any], **body: Any) -> httpx.Response:
    res: httpx.Response = client.call(
        "PATCH", f"/question-drafts/{draft['id']}", {"base_version": draft["version"], **body}
    )
    return res


def _publish(client: Any, run_id: str, drafts: list[dict[str, Any]]) -> httpx.Response:
    items = [{"draft_id": d["id"], "version": str(d["version"])} for d in drafts]
    res: httpx.Response = client.call(
        "POST", f"/question-generations/{run_id}/publish", {"drafts": items}
    )
    return res


def _overview(client: Any, workspace_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")
    return out


def _dots(client: Any, workspace_id: str) -> int:
    return int(_overview(client, workspace_id)["counts"]["total"])


# --- DoD: no dot before approval + registration ------------------------------------------------


def test_drafts_add_no_dot_until_approved_and_registered(seed: Any) -> None:
    owner, ws_id, source = _with_source(seed, "m62-dots")
    assert _dots(owner, ws_id) == 1

    run, drafts = _generate(owner, source["id"], ["PARAPHRASE", "ANALOGOUS_CONCEPT"])
    assert run["status"] == "succeeded"
    assert run["draft_count"] == 2
    assert [d["variation_type"] for d in drafts] == ["PARAPHRASE", "ANALOGOUS_CONCEPT"]
    assert all(d["run_id"] == run["id"] and d["import_id"] is None for d in drafts)
    overview = _overview(owner, ws_id)
    assert overview["counts"]["total"] == 1
    assert [i["question_id"] for i in overview["items"]] == [source["id"]]
    assert [q["id"] for q in owner.list_questions(ws_id)] == [source["id"]]
    for status in ("DRAFT", "ARCHIVED"):
        assert owner.list_questions(ws_id, f"publication_status={status}") == []

    # Editing and approving changes nothing either.
    paraphrase, analogous = drafts
    edited = _patch(owner, paraphrase, explanation="검토자가 고친 해설")
    assert edited.status_code == 200, edited.text[:300]
    approved = _patch(owner, edited.json(), review_status="approved")
    assert approved.status_code == 200, approved.text[:300]
    assert _dots(owner, ws_id) == 1
    # A pending draft in the same request refuses the whole publish: still no dot.
    seed.problem(_publish(owner, run["id"], [approved.json(), analogous]), 409, NOT_APPROVED)
    assert _dots(owner, ws_id) == 1

    # Registering the approved draft adds exactly one dot.
    registered = _publish(owner, run["id"], [approved.json()])
    assert registered.status_code == 200, registered.text[:300]
    assert _dots(owner, ws_id) == 2
    [item] = registered.json()["items"]
    created = owner.get_question(item["question_id"])
    assert created["revision"]["explanation"] == "검토자가 고친 해설"
    assert created["lineage"]["variation_type"] == "PARAPHRASE"

    # The other one only after its own approval.
    second = _patch(owner, analogous, review_status="approved").json()
    assert _dots(owner, ws_id) == 2
    assert _publish(owner, run["id"], [second]).status_code == 200
    assert _dots(owner, ws_id) == 3
    run = owner.ok("GET", f"/question-generations/{run['id']}")
    assert (run["draft_count"], run["published_count"]) == (2, 2)


def test_approval_follows_the_reviewed_content_and_published_drafts_are_frozen(
    seed: Any,
) -> None:
    owner, _ws, source = _with_source(seed, "m62-review")
    run, [draft] = _generate(owner, source["id"], ["PARAPHRASE"])

    approved = _patch(owner, draft, review_status="approved").json()
    # An edit returns the draft to pending; the reviewed version no longer publishes.
    edited = _patch(owner, approved, stem="정수장의 마지막 단계에서 넣는 소독제는?").json()
    assert edited["review_status"] == "pending"
    seed.problem(_publish(owner, run["id"], [approved]), 409, STALE_DRAFT)
    seed.problem(_patch(owner, approved, review_status="approved"), 409, STALE_DRAFT)

    # An edit that copies the source back is a duplicate: approval is refused.
    copy = _patch(
        owner,
        edited,
        stem=source["revision"]["stem"],
        options=source["revision"]["options"],
        correct_option_ids=source["revision"]["correct_option_ids"],
    )
    assert copy.status_code == 200
    assert "duplicate_of_source" in {v["code"] for v in copy.json()["validations"]}
    assert copy.json()["publishable"] is False
    seed.problem(_patch(owner, copy.json(), review_status="approved"), 422)

    # A fabricated answer option is refused as an edit (it must be one of the options).
    seed.problem(_patch(owner, copy.json(), correct_option_ids=["opt-9"]), 422)

    fixed = _patch(owner, copy.json(), stem="정수 처리에서 마지막으로 투입하는 소독제는?").json()
    published = _publish(owner, run["id"], [_patch(owner, fixed, review_status="approved").json()])
    assert published.status_code == 200
    [current] = _drafts(owner, run["id"])
    seed.problem(_patch(owner, current, review_status="rejected"), 409, DRAFT_PUBLISHED)


def test_generation_starts_only_from_a_confirmed_question(seed: Any) -> None:
    owner = seed.client("m62-start")
    ws = owner.create_workspace()
    draft_q = owner.create_question(
        ws["id"], {**seed.mcq("미확정 문제", ["가", "나"], 0), "publication_status": "DRAFT"}
    )
    seed.problem(_start(owner, draft_q["id"], ["PARAPHRASE"]), 409, NOT_CONFIRMED)
    confirmed = owner.create_question(ws["id"], seed.mcq("출처 없는 문제", ["가", "나"], 0))
    # Analogous concepts come from the source's document pages.
    res = _start(owner, confirmed["id"], ["ANALOGOUS_CONCEPT"])
    assert seed.problem(res, 422)["errors"][0]["loc"] == ["body", "variation_types"]
    seed.problem(_start(owner, confirmed["id"], ["PARAPHRASE", "PARAPHRASE"]), 422)
    seed.problem(_start(owner, confirmed["id"], ["PARAPHRASE"], candidate_count=21), 422)
    seed.problem(_start(owner, confirmed["id"], []), 422)
    assert owner.ok("GET", f"/workspaces/{ws['id']}/question-generations")["items"] == []


# --- idempotency ----------------------------------------------------------------------------------


def test_start_and_job_are_idempotent(seed: Any) -> None:
    owner, ws_id, source = _with_source(seed, "m62-idem")
    key = str(uuid.uuid4())
    first = _start(owner, source["id"], ["PARAPHRASE"], headers={"Idempotency-Key": key})
    assert first.status_code == 202
    replay = _start(owner, source["id"], ["PARAPHRASE"], headers={"Idempotency-Key": key})
    assert replay.status_code == 202
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["job_id"] == first.json()["job_id"]
    other = _start(owner, source["id"], ["INVERT_POLARITY"], headers={"Idempotency-Key": key})
    seed.problem(other, 409, KEY_REUSED)
    runs = owner.ok("GET", f"/workspaces/{ws_id}/question-generations")["items"]
    assert [r["id"] for r in runs] == [first.json()["id"]]

    run_id, job_id = first.json()["id"], first.json()["job_id"]
    owner.wait_for_job(job_id)
    [draft] = _drafts(owner, run_id)
    # A redelivered message of the finished job runs nothing: same drafts, same versions.
    jobs, runner, definitions = owner.worker._build()
    record = jobs.get(uuid.UUID(job_id))
    assert record is not None
    again = runner.run(definitions["question.generate"], record.to_envelope().to_message())
    assert again.outcome.value == "duplicate_finished"
    assert _drafts(owner, run_id) == [draft]

    # Publishing twice registers once.
    approved = _patch(owner, draft, review_status="approved").json()
    one = _publish(owner, run_id, [approved]).json()
    two = _publish(owner, run_id, [approved]).json()
    assert one == two
    assert _dots(owner, ws_id) == 2


def test_a_failed_run_keeps_no_drafts_and_reports_a_stable_code(seed: Any) -> None:
    owner, ws_id, source = _with_source(seed, "m62-fail", "malformed")
    res = _start(owner, source["id"], ["PARAPHRASE", "INVERT_POLARITY"])
    run = res.json()
    owner.wait_for_job(str(run["job_id"]), "failed")
    job = owner.ok("GET", f"/jobs/{run['job_id']}")
    assert job["error_code"] == "llm_output_invalid"
    run = owner.ok("GET", f"/question-generations/{run['id']}")
    assert (run["status"], run["error_code"], run["draft_count"]) == (
        "failed",
        "llm_output_invalid",
        0,
    )
    assert run["finished_at"] is not None
    assert _dots(owner, ws_id) == 1


# --- isolation ------------------------------------------------------------------------------------


def test_runs_and_drafts_are_invisible_and_immutable_across_workspaces(seed: Any) -> None:
    alice, alice_ws, source = _with_source(seed, "m62-iso-alice")
    run, [draft] = _generate(alice, source["id"], ["PARAPHRASE"])
    bob, bob_ws, bob_source = _with_source(seed, "m62-iso-bob")
    bob_run, [bob_draft] = _generate(bob, bob_source["id"], ["PARAPHRASE"])

    def same_404(path: str, method: str = "GET", body: Any = None) -> None:
        foreign = bob.call(method, path, body)
        unknown = bob.call(
            method, path.replace(run["id"], RANDOM_ID).replace(draft["id"], RANDOM_ID), body
        )
        assert seed.problem(foreign, 404) == seed.problem(unknown, 404)

    same_404(f"/question-generations/{run['id']}")
    same_404(f"/question-generations/{run['id']}/drafts")
    same_404(
        f"/question-generations/{run['id']}/publish",
        "POST",
        {"drafts": [{"draft_id": draft["id"], "version": draft["version"]}]},
    )
    same_404(f"/question-drafts/{draft['id']}", "PATCH", {"base_version": draft["version"]})
    seed.problem(bob.call("GET", f"/workspaces/{alice_ws}/question-generations"), 404)
    seed.problem(bob.call("GET", f"/jobs/{run['job_id']}"), 404)
    seed.problem(_start(bob, source["id"], ["PARAPHRASE"]), 404)

    # Bob's own run cannot publish Alice's draft (nor his draft through her run).
    res = bob.call(
        "POST",
        f"/question-generations/{bob_run['id']}/publish",
        {"drafts": [{"draft_id": draft["id"], "version": draft["version"]}]},
    )
    seed.problem(res, 404)
    res = alice.call(
        "POST",
        f"/question-generations/{run['id']}/publish",
        {"drafts": [{"draft_id": bob_draft["id"], "version": bob_draft["version"]}]},
    )
    seed.problem(res, 404)
    # Nothing moved.
    assert _drafts(alice, run["id"]) == [draft]
    assert _dots(alice, alice_ws) == 1
    assert _dots(bob, bob_ws) == 1
    assert [
        r["id"] for r in bob.ok("GET", f"/workspaces/{bob_ws}/question-generations")["items"]
    ] == [bob_run["id"]]


def test_viewers_read_drafts_but_cannot_generate_review_or_publish(seed: Any) -> None:
    owner, ws_id, source = _with_source(seed, "m62-viewer")
    run, [draft] = _generate(owner, source["id"], ["PARAPHRASE"])
    viewer = seed.client("m62-viewer-v")
    seed.membership(ws_id, viewer.user, "viewer")

    assert [d["id"] for d in _drafts(viewer, run["id"])] == [draft["id"]]
    seed.problem(_start(viewer, source["id"], ["PARAPHRASE"]), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(_patch(viewer, draft, review_status="approved"), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(_publish(viewer, run["id"], [draft]), 403, seed.INSUFFICIENT_ROLE)

    approved = _patch(owner, draft, review_status="approved").json()
    owner.ok("POST", f"/workspaces/{ws_id}/archive")
    seed.problem(_patch(owner, approved, review_status="rejected"), 403, seed.ARCHIVED)
    seed.problem(_publish(owner, run["id"], [approved]), 403, seed.ARCHIVED)
    # Archived workspaces stay readable.
    assert owner.ok("GET", f"/question-generations/{run['id']}")["id"] == run["id"]
    assert _dots(owner, ws_id) == 1


# --- answer leakage -------------------------------------------------------------------------------


def test_generated_answers_never_leave_the_workspace(seed: Any) -> None:
    owner, ws_id, source = _with_source(seed, "m62-leak")
    run, drafts = _generate(owner, source["id"], ["PARAPHRASE", "ANALOGOUS_CONCEPT"])
    secrets = [c["stem"] for c in _candidates()] + [
        o["text"] for c in _candidates() for o in c["options"]
    ]
    secrets += [c["explanation"] for c in _candidates()] + [
        c["justification"] for c in _candidates()
    ]

    outsider = seed.client("m62-leak-outsider")
    responses = [
        outsider.call("GET", f"/question-generations/{run['id']}"),
        outsider.call("GET", f"/question-generations/{run['id']}/drafts"),
        outsider.call("GET", f"/workspaces/{ws_id}/question-generations"),
        outsider.call("GET", f"/jobs/{run['job_id']}"),
        outsider.call("PATCH", f"/question-drafts/{drafts[0]['id']}", {"base_version": "0"}),
    ]
    for res in responses:
        assert res.status_code == 404
        assert not any(s in res.text for s in secrets)

    # The owner's job status, the stored job result and the activity log carry codes and ids only.
    job = owner.call("GET", f"/jobs/{run['job_id']}")
    assert not any(s in job.text for s in secrets)
    with psycopg.connect(seed.DB_ADMIN_URL, autocommit=True) as conn:
        result = conn.execute(
            "select result::text, payload::text, coalesce(last_error, '') from public.async_jobs "
            "where id = %s",
            (run["job_id"],),
        ).fetchone()
        activity = conn.execute(
            "select coalesce(string_agg(metadata::text, ' '), '') from public.activity_events "
            "where workspace_id = %s",
            (ws_id,),
        ).fetchone()
    assert result is not None
    assert activity is not None
    stored = " ".join([*result, *activity])
    assert not any(s in stored for s in secrets)
    assert "opt-1" not in result[0]
