"""QGEN-MULTI batch generation API (docs/questions.md §5 "묶음 변형 출제"): one run per source,
drafts isolated per source until approved, random pick scoped to the workspace and the caller's
study state and reproducible by seed, limits, authorization and idempotent retries.

Fixtures: conftest.py (jobs run in-process with the APP_ENV=test ScenarioLLMClient).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from quiz_api.api import question_generation_batches as batches
from quiz_api.rate_limit import TokenBucketLimiter

pytestmark = pytest.mark.infra

SCENARIO_FILE = Path(__file__).resolve().parents[2] / "fixtures/llm/generation-scenarios.json"
SCENARIOS: dict[str, Any] = json.loads(SCENARIO_FILE.read_text(encoding="utf-8"))
NOT_CONFIRMED = "urn:quiz-workspace:problem:question-not-confirmed"
KEY_REUSED = "urn:quiz-workspace:problem:idempotency-key-reused"
NO_MATCH = "urn:quiz-workspace:problem:no-matching-questions"
BUSY = "urn:quiz-workspace:problem:generation-busy"


@pytest.fixture(autouse=True)
def unlimited(app_client: Any) -> Any:
    """Tests start many batches as one user: the per-user rate limit has its own test."""
    state = app_client.app.state
    previous = state.__dict__.get("generation_batch_limiter")
    state.generation_batch_limiter = TokenBucketLimiter(0, 1)
    yield state
    if previous is None:
        state.__dict__.pop("generation_batch_limiter", None)
    else:
        state.generation_batch_limiter = previous


def _source_input(name: str, document_id: str, number: int) -> dict[str, Any]:
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


def _plain(number: int, **extra: Any) -> dict[str, Any]:
    return {
        "question_type": "MCQ",
        "stem": f"묶음 테스트 문제 {number} {uuid.uuid4().hex[:6]}",
        "options": [{"id": "a", "text": "응집"}, {"id": "b", "text": "증발"}],
        "correct_option_ids": ["a"],
        "is_multi_answer": False,
        "question_number": number,
        **extra,
    }


def _with_book(seed: Any, label: str) -> tuple[Any, str, str]:
    owner = seed.client(label)
    ws = owner.create_workspace()
    _upload, _sha, done = owner.upload_book(ws["id"])
    owner.wait_for_job(str(done["job_id"]))
    return owner, ws["id"], str(done["document_id"])


def _start(client: Any, workspace_id: str, body: dict[str, Any], key: str | None = None) -> Any:
    headers = {"Idempotency-Key": key} if key else {}
    res: httpx.Response = client.call_with_headers(
        "POST", f"/workspaces/{workspace_id}/question-generation-batches", body, headers
    )
    return res


def _selected(ids: list[str], **extra: Any) -> dict[str, Any]:
    return {
        "selection": {"mode": "selected", "question_ids": ids},
        "variation_types": ["PARAPHRASE"],
        **extra,
    }


def _random(count: int, **filters: Any) -> dict[str, Any]:
    return {
        "selection": {"mode": "random", "count": count, **filters},
        "variation_types": ["PARAPHRASE"],
    }


def _get(client: Any, workspace_id: str, batch_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "GET", f"/workspaces/{workspace_id}/question-generation-batches/{batch_id}"
    )
    return out


def _sources(batch: dict[str, Any]) -> list[str]:
    return [i["source"]["question_id"] for i in batch["items"]]


def _dots(client: Any, workspace_id: str) -> int:
    return int(
        client.ok("GET", f"/workspaces/{workspace_id}/questions/overview")["counts"]["total"]
    )


def test_selected_batch_creates_one_run_and_isolated_drafts_per_source(seed: Any) -> None:
    owner, ws_id, doc = _with_book(seed, "qmulti-selected")
    first = owner.create_question(ws_id, _source_input("disinfection", doc, 1))
    second = owner.create_question(ws_id, _source_input("flocculation", doc, 2))
    assert _dots(owner, ws_id) == 2

    res = _start(owner, ws_id, _selected([second["id"], first["id"]], candidate_count=1))
    assert res.status_code == 202, res.text[:300]
    batch = res.json()
    assert batch["mode"] == "selected"
    assert batch["seed"] is None
    assert batch["requested_count"] == 2
    assert batch["run_count"] == 2
    assert _sources(batch) == [second["id"], first["id"]]  # the caller's order
    assert batch["items"][0]["source"]["question_number"] == 2
    assert "[E2E-LLM-BATCH]" in batch["items"][0]["source"]["preview"]
    runs = [i["run"] for i in batch["items"]]
    assert len({r["id"] for r in runs}) == 2
    assert all(r["batch_id"] == batch["id"] for r in runs)
    assert [r["source_question_revision_id"] for r in runs] == [
        second["revision"]["id"],
        first["revision"]["id"],
    ]

    for run in runs:
        owner.wait_for_job(str(run["job_id"]))
    done = _get(owner, ws_id, batch["id"])
    assert done["status"] == "finished"
    assert done["finished_run_count"] == 2
    assert [i["run"]["status"] for i in done["items"]] == ["succeeded", "succeeded"]
    assert done["draft_count"] == 2
    assert done["published_count"] == 0
    for item in done["items"]:
        drafts = owner.ok("GET", f"/question-generations/{item['run']['id']}/drafts")["items"]
        assert len(drafts) == 1
        assert drafts[0]["payload"]["parent_question_id"] == item["source"]["question_id"]
        assert drafts[0]["review_status"] == "pending"
    # Drafts are no questions: no new bank entry, no dot (questions.md §8).
    assert len(owner.list_questions(ws_id)) == 2
    assert _dots(owner, ws_id) == 2
    # The single-run listing still shows the batch's runs, per source.
    listed = owner.ok(
        "GET", f"/workspaces/{ws_id}/question-generations?source_question_id={first['id']}"
    )["items"]
    assert [r["id"] for r in listed] == [runs[1]["id"]]


def test_selected_batch_refuses_foreign_unknown_draft_and_duplicate_ids_without_runs(
    seed: Any,
) -> None:
    owner = seed.client("qmulti-refuse")
    ws_id = owner.create_workspace()["id"]
    confirmed = owner.create_question(ws_id, _plain(1))
    draft = owner.create_question(ws_id, _plain(2, publication_status="DRAFT"))
    other_ws = owner.create_workspace()["id"]
    foreign = owner.create_question(other_ws, _plain(1))

    unknown = _start(owner, ws_id, _selected([confirmed["id"], str(uuid.uuid4())]))
    cross = _start(owner, ws_id, _selected([confirmed["id"], foreign["id"]]))
    assert unknown.status_code == cross.status_code == 404
    assert unknown.json()["detail"] == cross.json()["detail"]
    seed.problem(
        _start(owner, ws_id, _selected([confirmed["id"], draft["id"]])), 409, NOT_CONFIRMED
    )
    dup = _start(owner, ws_id, _selected([confirmed["id"], confirmed["id"]]))
    assert dup.status_code == 422
    shuffle = _start(
        owner, ws_id, {**_selected([confirmed["id"]]), "variation_types": ["OPTION_SHUFFLE"]}
    )
    assert shuffle.status_code == 422
    too_many = _start(owner, ws_id, _selected([str(uuid.uuid4()) for _ in range(21)]))
    assert too_many.status_code == 422
    # Cost guard: 20 sources x 3 variations x 2 candidates > 60.
    costly = _start(
        owner,
        ws_id,
        {
            "selection": {"mode": "random", "count": 20},
            "variation_types": ["PARAPHRASE", "INVERT_POLARITY", "ANALOGOUS_CONCEPT"],
            "candidate_count": 2,
        },
    )
    assert costly.status_code == 422
    assert owner.ok("GET", f"/workspaces/{ws_id}/question-generations")["items"] == []


def test_random_pick_respects_filters_state_workspace_and_seed(seed: Any) -> None:
    owner = seed.client("qmulti-random")
    ws_id = owner.create_workspace()["id"]
    plain = [owner.create_question(ws_id, _plain(n)) for n in range(1, 7)]
    owner.create_question(ws_id, _plain(7, publication_status="DRAFT"))
    other_ws = owner.create_workspace()["id"]
    owner.create_question(other_ws, _plain(1))
    favorites = {plain[1]["id"], plain[4]["id"]}
    for qid in favorites:
        owner.ok("PATCH", f"/questions/{qid}/my-state", {"is_favorite": True})
    confirmed = {q["id"] for q in plain}

    a = _start(owner, ws_id, _random(3, seed=42)).json()
    b = _start(owner, ws_id, _random(3, seed=42)).json()
    assert a["mode"] == "random"
    assert a["seed"] == 42
    assert a["id"] != b["id"]
    assert _sources(a) == _sources(b)  # same seed, same candidates -> same pick
    assert len(set(_sources(a))) == 3
    assert set(_sources(a)) <= confirmed  # never a draft or another workspace's question

    fav = _start(owner, ws_id, _random(5, favorite=True)).json()
    assert set(_sources(fav)) == favorites  # fewer matches than asked: all of them
    assert fav["requested_count"] == 5
    assert fav["run_count"] == 2
    assert isinstance(fav["seed"], int)  # drawn by the server and returned

    # Study state is the caller's: another editor has no favorites.
    editor = seed.client("qmulti-random-editor")
    seed.membership(ws_id, editor.user, "editor")
    seed.problem(_start(editor, ws_id, _random(2, favorite=True)), 409, NO_MATCH)
    unseen = _start(editor, ws_id, _random(20, statuses=["unseen"])).json()
    assert set(_sources(unseen)) == confirmed
    seed.problem(_start(owner, ws_id, _random(2, statuses=["incorrect"])), 409, NO_MATCH)
    seed.problem(_start(owner, ws_id, _random(2, question_type="ESSAY")), 409, NO_MATCH)
    none_chapter = _start(owner, ws_id, _random(1, chapter="none", seed=7)).json()
    assert set(_sources(none_chapter)) <= confirmed
    seed.problem(_start(owner, ws_id, _random(1, chapter=str(uuid.uuid4()))), 409, NO_MATCH)
    assert _dots(owner, ws_id) == 6


def test_batches_are_editor_only_read_by_members_and_hidden_from_outsiders(seed: Any) -> None:
    owner = seed.client("qmulti-authz")
    ws_id = owner.create_workspace()["id"]
    q = owner.create_question(ws_id, _plain(1))
    batch = _start(owner, ws_id, _selected([q["id"]])).json()

    viewer = seed.client("qmulti-authz-viewer")
    seed.membership(ws_id, viewer.user, "viewer")
    seed.problem(_start(viewer, ws_id, _selected([q["id"]])), 403, seed.INSUFFICIENT_ROLE)
    seed.problem(_start(viewer, ws_id, _random(1)), 403, seed.INSUFFICIENT_ROLE)
    assert _get(viewer, ws_id, batch["id"])["id"] == batch["id"]

    outsider = seed.client("qmulti-authz-outsider")
    path = f"/workspaces/{ws_id}/question-generation-batches/{batch['id']}"
    hidden = outsider.call("GET", path)
    unknown = owner.call("GET", f"/workspaces/{ws_id}/question-generation-batches/{uuid.uuid4()}")
    assert hidden.status_code == unknown.status_code == 404
    assert _start(outsider, ws_id, _selected([q["id"]])).status_code == 404
    # A batch id is only found in its own workspace.
    other_ws = owner.create_workspace()["id"]
    assert (
        owner.call(
            "GET", f"/workspaces/{other_ws}/question-generation-batches/{batch['id']}"
        ).status_code
        == 404
    )

    owner.ok("POST", f"/workspaces/{ws_id}/archive")
    seed.problem(_start(owner, ws_id, _selected([q["id"]])), 403, seed.ARCHIVED)
    assert _get(owner, ws_id, batch["id"])["run_count"] == 1  # archived stays readable


def test_idempotent_retry_returns_the_same_batch(seed: Any) -> None:
    owner = seed.client("qmulti-idem")
    ws_id = owner.create_workspace()["id"]
    for n in range(1, 4):
        owner.create_question(ws_id, _plain(n))
    key = str(uuid.uuid4())
    body = _random(2)
    first = _start(owner, ws_id, body, key)
    again = _start(owner, ws_id, body, key)
    assert first.status_code == again.status_code == 202
    assert again.json()["id"] == first.json()["id"]
    assert _sources(again.json()) == _sources(first.json())  # the server's seed is replayed
    assert again.headers.get("idempotent-replayed") == "true"
    runs = owner.ok("GET", f"/workspaces/{ws_id}/question-generations")["items"]
    assert len(runs) == 2
    seed.problem(_start(owner, ws_id, _random(1), key), 409, KEY_REUSED)


def test_in_flight_runs_cap_new_batches(seed: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(batches, "MAX_ACTIVE_RUNS", 4)
    owner = seed.client("qmulti-busy")
    ws_id = owner.create_workspace()["id"]
    ids = [owner.create_question(ws_id, _plain(n))["id"] for n in range(1, 4)]
    assert _start(owner, ws_id, _selected(ids)).status_code == 202  # 3 queued runs
    seed.problem(_start(owner, ws_id, _selected(ids)), 409, BUSY)  # 3 + 3 > 4
    assert _start(owner, ws_id, _selected(ids[:1])).status_code == 202  # 3 + 1 <= 4
    assert len(owner.ok("GET", f"/workspaces/{ws_id}/question-generations")["items"]) == 4


def test_rate_limit_answers_429_with_retry_after(seed: Any, unlimited: Any) -> None:
    owner = seed.client("qmulti-rate")
    ws_id = owner.create_workspace()["id"]
    q = owner.create_question(ws_id, _plain(1))
    unlimited.generation_batch_limiter = TokenBucketLimiter(1, 1)
    key = str(uuid.uuid4())
    assert _start(owner, ws_id, _selected([q["id"]]), key).status_code == 202
    # A retry of the same request is a replay, not a new start: never rate limited.
    assert _start(owner, ws_id, _selected([q["id"]]), key).status_code == 202
    limited = _start(owner, ws_id, _selected([q["id"]]))
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
