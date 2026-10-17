"""QGEN-01 server guarantees (docs/questions.md §5/§8, architecture.md §6, auth.md §4).

OPTION_SHUFFLE is a practice order, never a generation; LLM variants are isolated drafts (no bank
question, no dot) carrying lineage, source evidence, generator provenance and machine
validations; the LLM's declared answer is not trusted (an inversion with several correct options
cannot be approved until the reviewer resolves it); invalid LLM output fails the run without
drafts; only approved drafts become CONFIRMED questions with lineage; generation is an editor
write scoped to the workspace. Endpoint shapes and the fake-LLM scenarios are assumptions G1-G6
in tests/e2e/fixtures/generation.ts; the scenario file is tests/fixtures/llm/
generation-scenarios.json. Jobs run in-process through conftest's JobWorker, which needs the
`question.generate` definition with the ScenarioLLMClient (M6.2 registers it there).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest

# RED (M6.0): M6.2 removes `red` when the generation run API/worker make these GREEN.
pytestmark = [pytest.mark.infra, pytest.mark.red]

SCENARIO_FILE = Path(__file__).resolve().parents[2] / "fixtures/llm/generation-scenarios.json"
SCENARIOS: dict[str, Any] = json.loads(SCENARIO_FILE.read_text(encoding="utf-8"))
TASK = {
    "PARAPHRASE": "questions.generate.paraphrase",
    "INVERT_POLARITY": "questions.generate.invert_polarity",
    "ANALOGOUS_CONCEPT": "questions.generate.analogous_concept",
}
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
DRAFT_NOT_APPROVED = "urn:quiz-workspace:problem:draft-not-approved"


def candidate(marker: str, variation: str) -> dict[str, Any]:
    scenario = next(s for s in SCENARIOS["scenarios"] if s["marker"] == marker)
    [first] = scenario["responses"][TASK[variation]]["candidates"]
    return dict(first)


def source_input(name: str, document_id: str, number: int = 1) -> dict[str, Any]:
    """The scenario source MCQ (G1): marker at the end of the stem, cites its page."""
    s = SCENARIOS["sources"][name]
    page = s["source_page"]
    return {
        "question_type": s["question_type"],
        "stem": f"{s['stem']} [{s['marker']}]",
        "options": s["options"],
        "correct_option_ids": s["correct_option_ids"],
        "is_multi_answer": s["is_multi_answer"],
        "explanation": s["explanation"],
        "question_number": number,
        "sources": [{"document_id": document_id, "page_start": page, "page_end": page}],
    }


def assert_status(seed: Any, res: httpx.Response, status: int, what: str) -> None:
    route = f"{res.request.method} {seed.route_of(res.request.url.path)}"
    assert not (res.status_code in {404, 405} and not _detail(res)), (
        f"{route} not implemented ({res.status_code})"
    )
    assert res.status_code == status, f"{what}: expected {status}, got {res.status_code}"


def _detail(res: httpx.Response) -> str | None:
    try:
        body = res.json()
    except ValueError:
        return None
    return body.get("detail") if isinstance(body, dict) else None


def start(
    client: Any, question_id: str, types: list[str], key: str | None = None
) -> httpx.Response:
    res: httpx.Response = client.call_with_headers(
        "POST",
        f"/questions/{question_id}/generations",
        {"variation_types": types},
        {"Idempotency-Key": key} if key else {},
    )
    return res


def run_of(client: Any, run_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/question-generations/{run_id}")
    return out


def drafts_of(client: Any, run_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.ok("GET", f"/question-generations/{run_id}/drafts")[
        "items"
    ]
    return sorted(items, key=lambda d: int(d["position"]))


def generate(
    seed: Any, client: Any, question_id: str, variation: str, expected: str = "succeeded"
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    res = start(client, question_id, [variation])
    assert_status(seed, res, 202, "start generation")
    accepted: dict[str, Any] = res.json()
    client.wait_for_job(str(accepted["job_id"]), expected)
    return run_of(client, str(accepted["id"])), drafts_of(client, str(accepted["id"]))


def publish(client: Any, run_id: str, drafts: list[dict[str, Any]]) -> httpx.Response:
    items = [{"draft_id": d["id"], "version": str(d["version"])} for d in drafts]
    res: httpx.Response = client.call(
        "POST", f"/question-generations/{run_id}/publish", {"drafts": items}
    )
    return res


def patch_draft(client: Any, draft: dict[str, Any], **changes: Any) -> httpx.Response:
    res: httpx.Response = client.call(
        "PATCH", f"/question-drafts/{draft['id']}", {"base_version": draft["version"], **changes}
    )
    return res


def total_dots(client: Any, workspace_id: str) -> int:
    return int(
        client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")["counts"]["total"]
    )


def errors(draft: dict[str, Any]) -> list[dict[str, Any]]:
    return [v for v in draft["validations"] if v["severity"] == "error"]


def with_book_source(seed: Any, label: str, name: str) -> tuple[Any, str, str, dict[str, Any]]:
    """Owner, workspace id, book-ko document id and the scenario source question."""
    owner = seed.client(label)
    ws = owner.create_workspace()
    _upload, _sha, done = owner.upload_book(ws["id"])
    owner.wait_for_job(str(done["job_id"]))
    document_id = str(done["document_id"])
    source = owner.create_question(ws["id"], source_input(name, document_id))
    return owner, ws["id"], document_id, source


def test_qgen_01_ac01_option_shuffle_is_a_practice_order_and_never_a_generation(seed: Any) -> None:
    owner = seed.client("qgen01-ac01")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq("shuffle 원본", ["가", "나", "다", "라"], 2))

    assert_status(seed, start(owner, q["id"], ["OPTION_SHUFFLE"]), 422, "OPTION_SHUFFLE run")
    mixed = start(owner, q["id"], ["OPTION_SHUFFLE", "PARAPHRASE"])
    assert_status(seed, mixed, 422, "OPTION_SHUFFLE mixed in")
    runs = owner.ok("GET", f"/workspaces/{ws['id']}/question-generations")["items"]
    assert runs == [], "a shuffle never creates a generation run"

    # The order lives on the original question's practice session and its attempt.
    session = owner.ok("POST", f"/questions/{q['id']}/practice-sessions", {}, (201,))
    shown = [o["id"] for o in session["options"]]
    assert sorted(shown) == sorted(o["id"] for o in q["revision"]["options"])
    owner.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-3"]}
    )
    [attempt] = owner.ok("GET", f"/questions/{q['id']}/attempts")["items"]
    assert attempt["displayed_option_ids"] == shown
    assert attempt["question_revision_id"] == q["revision"]["id"]
    assert len(owner.list_questions(ws["id"])) == 1
    assert total_dots(owner, ws["id"]) == 1


def test_qgen_01_ac02_paraphrase_draft_is_isolated_with_lineage_evidence_and_validation(
    seed: Any,
) -> None:
    owner, ws_id, document_id, source = with_book_source(seed, "qgen01-ac02", "disinfection")
    expected = candidate("E2E-LLM-OK", "PARAPHRASE")

    key = str(uuid.uuid4())
    first = start(owner, source["id"], ["PARAPHRASE"], key)
    assert_status(seed, first, 202, "start")
    accepted = first.json()
    assert accepted["status"] in {"queued", "running", "succeeded"}
    assert accepted["job_id"]
    assert accepted["source_question_id"] == source["id"]
    assert accepted["source_question_revision_id"] == source["revision"]["id"]
    assert accepted["variation_types"] == ["PARAPHRASE"]
    replay = start(owner, source["id"], ["PARAPHRASE"], key)
    assert_status(seed, replay, 202, "same Idempotency-Key")
    assert replay.json()["id"] == accepted["id"]

    owner.wait_for_job(str(accepted["job_id"]))
    run = run_of(owner, accepted["id"])
    assert run["status"] == "succeeded"
    assert run["draft_count"] == 1
    assert run["llm_model"]
    assert run["prompt_version"]
    [draft] = drafts_of(owner, run["id"])
    payload = draft["payload"]
    assert draft["review_status"] == "pending"
    assert draft["published_question_id"] is None
    assert draft["variation_type"] == "PARAPHRASE"
    assert payload["origin"] == "generation"
    assert payload["variation_type"] == "PARAPHRASE"
    assert payload["parent_question_id"] == source["id"]
    assert payload["source_question_revision_id"] == source["revision"]["id"]
    assert payload["stem"] == expected["stem"]
    assert payload["justification"] == expected["justification"]
    assert payload["generator"]["model"] == run["llm_model"]
    assert payload["generator"]["prompt_version"] == run["prompt_version"]
    [evidence] = payload["evidence"]
    assert evidence["document_id"] == document_id
    assert [loc["page"] for loc in evidence["locations"]] == [4]
    assert evidence["block_ids"], "the quote is mapped onto its block"
    assert errors(draft) == []
    assert draft["publishable"] is True

    # Isolated until approved: no bank question, no dot.
    assert [q["id"] for q in owner.list_questions(ws_id)] == [source["id"]]
    assert total_dots(owner, ws_id) == 1

    other = seed.client("qgen01-ac02-other")
    for path in (f"/question-generations/{run['id']}", f"/question-generations/{run['id']}/drafts"):
        foreign = other.call("GET", path)
        unknown = other.call("GET", path.replace(run["id"], RANDOM_ID))
        assert seed.problem(foreign, 404) == seed.problem(unknown, 404)


@pytest.mark.parametrize("source_name", ["malformed", "schema-invalid"])
def test_qgen_01_ac02_invalid_llm_output_fails_the_run_without_drafts(
    seed: Any, source_name: str
) -> None:
    owner, ws_id, _doc, source = with_book_source(seed, f"qgen01-ac02-{source_name}", source_name)
    run, drafts = generate(seed, owner, source["id"], "PARAPHRASE", expected="failed")
    assert run["status"] == "failed"
    assert run["error_code"] == "llm_output_invalid"
    assert drafts == []
    assert total_dots(owner, ws_id) == 1


def test_qgen_01_ac03_inversion_with_several_correct_options_blocks_approval_until_resolved(
    seed: Any,
) -> None:
    owner, ws_id, _doc, source = with_book_source(seed, "qgen01-ac03", "not-correct")
    run, [draft] = generate(seed, owner, source["id"], "INVERT_POLARITY")
    assert draft["variation_type"] == "INVERT_POLARITY"
    assert errors(draft), "3 of 4 statements are correct after the inversion"
    assert draft["publishable"] is False

    assert_status(seed, patch_draft(owner, draft, review_status="approved"), 422, "approve")
    refused = publish(owner, run["id"], [draft])
    assert seed.problem(refused, 409, DRAFT_NOT_APPROVED)
    assert len(owner.list_questions(ws_id)) == 1
    assert total_dots(owner, ws_id) == 1

    # The reviewer confirms the type switch: multi-answer with the complement of the original.
    inverted = sorted({o["id"] for o in source["revision"]["options"]} - {"opt-4"})
    edited = patch_draft(owner, draft, is_multi_answer=True, correct_option_ids=inverted)
    assert_status(seed, edited, 200, "resolve")
    resolved = edited.json()
    assert errors(resolved) == []
    assert resolved["publishable"] is True
    approved = patch_draft(owner, resolved, review_status="approved")
    assert_status(seed, approved, 200, "approve resolved")
    registered = publish(owner, run["id"], [approved.json()])
    assert_status(seed, registered, 200, "publish")
    [item] = registered.json()["items"]
    created = owner.get_question(item["question_id"])
    assert created["revision"]["is_multi_answer"] is True
    assert sorted(created["revision"]["correct_option_ids"]) == inverted
    assert total_dots(owner, ws_id) == 2


def test_qgen_01_ac04_approved_analogous_draft_becomes_a_confirmed_question_with_lineage(
    seed: Any,
) -> None:
    owner, ws_id, document_id, source = with_book_source(seed, "qgen01-ac04", "disinfection")
    run, [draft] = generate(seed, owner, source["id"], "ANALOGOUS_CONCEPT")
    expected = candidate("E2E-LLM-OK", "ANALOGOUS_CONCEPT")
    assert draft["payload"]["stem"] == expected["stem"]
    assert errors(draft) == []

    refused = publish(owner, run["id"], [draft])
    assert seed.problem(refused, 409, DRAFT_NOT_APPROVED)
    assert total_dots(owner, ws_id) == 1

    approved = patch_draft(owner, draft, review_status="approved")
    assert_status(seed, approved, 200, "approve")
    registered = publish(owner, run["id"], [approved.json()])
    assert_status(seed, registered, 200, "publish")
    [item] = registered.json()["items"]
    assert item["draft_id"] == draft["id"]
    replay = publish(owner, run["id"], [approved.json()])
    assert_status(seed, replay, 200, "publish replay")
    assert replay.json()["items"] == registered.json()["items"], "publish is idempotent"

    created = owner.get_question(item["question_id"])
    assert created["publication_status"] == "CONFIRMED"
    assert created["origin"] == "generation"
    assert created["revision"]["stem"] == expected["stem"]
    assert created["lineage"] == {
        "parent_question_id": source["id"],
        "source_question_revision_id": source["revision"]["id"],
        "variation_type": "ANALOGOUS_CONCEPT",
        "generation_run_id": run["id"],
    }
    assert any(
        s["document_id"] == document_id and s["page_start"] == 4 for s in created["sources"]
    ), "document evidence is kept as the question's source"
    assert owner.get_question(source["id"])["revision"]["id"] == source["revision"]["id"]
    assert owner.get_question(source["id"]).get("lineage") is None

    # One more dot with its own (unseen) study state.
    overview = owner.ok("GET", f"/workspaces/{ws_id}/questions/overview")
    assert overview["counts"]["total"] == 2
    [mine] = [i for i in overview["items"] if i["question_id"] == created["id"]]
    assert mine["status"] == "unseen"
    assert run_of(owner, run["id"])["published_count"] == 1


def test_generation_start_is_an_editor_write_scoped_to_the_workspace(seed: Any) -> None:
    owner = seed.client("qgen-authz")
    ws = owner.create_workspace()
    q = owner.create_question(ws["id"], seed.mcq("권한 원본", ["가", "나"], 0))

    viewer = seed.client("qgen-authz-viewer")
    seed.membership(ws["id"], viewer.user, "viewer")
    assert seed.problem(start(viewer, q["id"], ["PARAPHRASE"]), 403, seed.INSUFFICIENT_ROLE)

    outsider = seed.client("qgen-authz-outsider")
    foreign = start(outsider, q["id"], ["PARAPHRASE"])
    unknown = start(outsider, RANDOM_ID, ["PARAPHRASE"])
    assert seed.problem(foreign, 404) == seed.problem(unknown, 404)

    owner.ok("POST", f"/workspaces/{ws['id']}/archive")
    assert seed.problem(start(owner, q["id"], ["PARAPHRASE"]), 403, seed.ARCHIVED)
    assert owner.ok("GET", f"/workspaces/{ws['id']}/question-generations")["items"] == []
