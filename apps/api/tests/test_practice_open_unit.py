"""UX12-OPEN retries the browser cannot observe, with the repositories faked. The DB side is in
tests/integration/questions/test_practice_open.py."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, NoReturn
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from quiz_api.api import practice as practice_api
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.idempotency import request_hash
from quiz_api.repositories.idempotency import StoredResponse


def test_ux12_open_ac04_a_submitted_key_after_a_revision_change_opens_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The key's record cannot be replaced, so opening here would add a session on every retry."""

    def no_new_session(*_: Any, **__: Any) -> NoReturn:
        raise AssertionError("a retried key opened another session")

    monkeypatch.setattr(practice_api, "_open_session", no_new_session)
    old_revision = SimpleNamespace(id=uuid.uuid4())
    submitted = SimpleNamespace(reset_epoch=0, state="graded", revision=old_revision)
    repo = MagicMock()
    repo.lock_epoch_with_reset.return_value = (0, False)
    repo.get_session.return_value = submitted
    repo.latest_outcome.return_value = SimpleNamespace(
        session=submitted,
        latest_attempt_id=uuid.uuid4(),
        latest_result=object(),
    )
    questions = MagicMock()
    questions.get.return_value = SimpleNamespace(
        id=uuid.uuid4(), revision=SimpleNamespace(id=uuid.uuid4())
    )
    idempotency = MagicMock()
    idempotency.find.return_value = StoredResponse(
        request_hash({}), 200, {"session": {"id": str(uuid.uuid4())}}
    )

    with pytest.raises(ProblemException) as refused:
        practice_api.open_question_practice(
            access=SimpleNamespace(resource_id=uuid.uuid4()),  # type: ignore[arg-type]
            practice=repo,
            questions=questions,
            idempotency=idempotency,
            user=SimpleNamespace(id=uuid.uuid4()),  # type: ignore[arg-type]
            idempotency_key="k",
        )

    assert refused.value.status_code == 409
    assert refused.value.problem_type == ProblemType.PRACTICE_SESSION_SUBMITTED
    idempotency.save.assert_not_called()
    repo.commit.assert_not_called()


def _revision() -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        stem="stem",
        stem_tables=None,
        options=[{"id": "opt-1", "text": "a"}],
        is_multi_answer=False,
        correct_option_ids=["opt-1"],
        accepted_answers=None,
        explanation="the explanation",
        rubric=None,
    )


def _submitted(revision: SimpleNamespace) -> SimpleNamespace:
    now = datetime.now(UTC)
    return SimpleNamespace(
        id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        question_id=uuid.uuid4(),
        question_type="MCQ",
        chapter_id=None,
        question_number=1,
        revision=revision,
        displayed_option_ids=["opt-1"],
        state="graded",
        opened_at=now,
        submitted_at=now,
        graded_at=now,
        practice_run_id=None,
        run_position=None,
    )


def _repos(latest_result: str) -> tuple[SimpleNamespace, MagicMock, MagicMock]:
    revision = _revision()
    submitted = _submitted(revision)
    repo = MagicMock()
    repo.lock_epoch_with_reset.return_value = (0, False)
    repo.get_session.return_value = SimpleNamespace(reset_epoch=0, state="graded")
    repo.latest_outcome.return_value = SimpleNamespace(
        session=submitted,
        latest_attempt_id=uuid.uuid4(),
        latest_result=latest_result,
        submitted_answer={"selected_option_ids": ["opt-1"]},
    )
    questions = MagicMock()
    questions.get.return_value = SimpleNamespace(id=submitted.question_id, revision=revision)
    return submitted, repo, questions


def _open_solved(
    monkeypatch: pytest.MonkeyPatch,
    *,
    latest_result: str,
    stored: StoredResponse | None = None,
    body: practice_api.PracticeOpenBody | None = None,
) -> tuple[practice_api.PracticeOpened, MagicMock]:
    submitted, repo, questions = _repos(latest_result)
    new_session = SimpleNamespace(**{**vars(submitted), "id": uuid.uuid4(), "state": "open"})
    session_out = practice_api._session_out(new_session)  # type: ignore[arg-type]
    opener = MagicMock(return_value=session_out)
    monkeypatch.setattr(practice_api, "_open_session", opener)
    if body:
        repo.get_session.return_value = new_session
    idempotency = MagicMock()
    idempotency.find.return_value = stored
    out = practice_api.open_question_practice(
        access=SimpleNamespace(resource_id=submitted.question_id),  # type: ignore[arg-type]
        practice=repo,
        questions=questions,
        idempotency=idempotency,
        user=SimpleNamespace(id=uuid.uuid4()),  # type: ignore[arg-type]
        body=body,
        idempotency_key="k",
    )
    return out, opener


@pytest.mark.parametrize("latest_result", ["correct", "incorrect"])
def test_ux12_solvedopen_ac08_a_solved_question_opens_without_its_result(
    monkeypatch: pytest.MonkeyPatch, latest_result: str
) -> None:
    out, opener = _open_solved(monkeypatch, latest_result=latest_result)
    opener.assert_called_once()
    assert out.session is not None
    assert out.result is None
    assert out.submitted_answer is None
    assert "the explanation" not in out.model_dump_json()


def test_ux12_solvedopen_ac08_a_pending_submission_stays_on_screen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, opener = _open_solved(monkeypatch, latest_result="pending")
    opener.assert_not_called()
    assert out.result is not None


def test_ux12_solvedopen_ac08_a_submitted_key_never_carries_a_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stored = StoredResponse(request_hash({}), 200, {"session": {"id": str(uuid.uuid4())}})
    with pytest.raises(ProblemException) as refused:
        _open_solved(monkeypatch, latest_result="correct", stored=stored)
    assert refused.value.problem_type == ProblemType.PRACTICE_SESSION_SUBMITTED


def test_ux12_solvedopen_ac08_a_solved_question_reuses_its_cached_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(practice_api, "_reusable", lambda *_: True)
    out, opener = _open_solved(
        monkeypatch,
        latest_result="correct",
        body=practice_api.PracticeOpenBody(cached_session_id=uuid.uuid4()),
    )
    opener.assert_not_called()
    assert out.reused is True
    assert out.result is None


def _reveal(repo: MagicMock, questions: MagicMock, question_id: uuid.UUID) -> Any:
    return practice_api.reveal_question_practice(
        access=SimpleNamespace(resource_id=question_id),  # type: ignore[arg-type]
        practice=repo,
        questions=questions,
        user=SimpleNamespace(id=uuid.uuid4()),  # type: ignore[arg-type]
    )


def test_ux12_solvedopen_ac08_reveal_returns_the_result_and_retires_open_sessions() -> None:
    submitted, repo, questions = _repos("incorrect")
    out = _reveal(repo, questions, submitted.question_id)
    assert out.result.outcome.explanation == "the explanation"
    assert out.submitted_answer == {"selected_option_ids": ["opt-1"]}
    repo.retire_open_sessions.assert_called_once()
    repo.commit.assert_called_once()


@pytest.mark.parametrize("case", ["never-submitted", "other-revision"])
def test_ux12_solvedopen_ac08_reveal_needs_a_submission_of_this_revision(case: str) -> None:
    submitted, repo, questions = _repos("correct")
    if case == "never-submitted":
        repo.latest_outcome.return_value = None
    else:
        questions.get.return_value = SimpleNamespace(
            id=submitted.question_id, revision=SimpleNamespace(id=uuid.uuid4())
        )
    with pytest.raises(HTTPException) as refused:
        _reveal(repo, questions, submitted.question_id)
    assert refused.value.status_code == 404
    repo.retire_open_sessions.assert_not_called()
    repo.commit.assert_not_called()
