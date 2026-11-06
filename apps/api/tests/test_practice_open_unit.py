"""UX12-OPEN retries the browser cannot observe, with the repositories faked. The DB side is in
tests/integration/questions/test_practice_open.py."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, NoReturn
from unittest.mock import MagicMock

import pytest
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
        needs_retry=False,
    )
    questions = MagicMock()
    questions.get.return_value = SimpleNamespace(
        id=uuid.uuid4(), revision=SimpleNamespace(id=uuid.uuid4())
    )
    idempotency = MagicMock()
    idempotency.find.return_value = StoredResponse(
        request_hash({"force_new": False}), 200, {"session": {"id": str(uuid.uuid4())}}
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


def _open_with_outcome(
    monkeypatch: pytest.MonkeyPatch,
    *,
    needs_retry: bool,
    latest_result: str,
    stored: StoredResponse | None = None,
) -> tuple[practice_api.PracticeOpened, MagicMock]:
    revision = _revision()
    submitted = _submitted(revision)
    new_session = SimpleNamespace(**{**vars(submitted), "id": uuid.uuid4(), "state": "open"})
    opener = MagicMock(return_value=practice_api._session_out(new_session))  # type: ignore[arg-type]
    monkeypatch.setattr(practice_api, "_open_session", opener)
    repo = MagicMock()
    repo.lock_epoch_with_reset.return_value = (0, False)
    repo.get_session.return_value = SimpleNamespace(reset_epoch=0, state="graded")
    repo.latest_outcome.return_value = SimpleNamespace(
        session=submitted,
        latest_attempt_id=uuid.uuid4(),
        latest_result=latest_result,
        submitted_answer={"selected_option_ids": ["opt-1"]},
        needs_retry=needs_retry,
    )
    questions = MagicMock()
    questions.get.return_value = SimpleNamespace(id=submitted.question_id, revision=revision)
    idempotency = MagicMock()
    idempotency.find.return_value = stored
    out = practice_api.open_question_practice(
        access=SimpleNamespace(resource_id=submitted.question_id),  # type: ignore[arg-type]
        practice=repo,
        questions=questions,
        idempotency=idempotency,
        user=SimpleNamespace(id=uuid.uuid4()),  # type: ignore[arg-type]
        idempotency_key="k",
    )
    return out, opener


def test_ux12_retryopen_ac09_a_marked_question_opens_without_its_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, opener = _open_with_outcome(monkeypatch, needs_retry=True, latest_result="correct")
    opener.assert_called_once()
    assert out.session is not None
    assert out.result is None
    assert out.submitted_answer is None
    assert "the explanation" not in out.model_dump_json()


def test_ux12_retryopen_ac09_an_unmarked_question_keeps_its_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, opener = _open_with_outcome(monkeypatch, needs_retry=False, latest_result="correct")
    opener.assert_not_called()
    assert out.session is None
    assert out.result is not None


def test_ux12_retryopen_ac09_a_pending_submission_stays_on_screen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, opener = _open_with_outcome(monkeypatch, needs_retry=True, latest_result="pending")
    opener.assert_not_called()
    assert out.result is not None


def test_ux12_retryopen_ac09_the_same_opening_keeps_its_own_submission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stored = StoredResponse(
        request_hash({"force_new": False}), 200, {"session": {"id": str(uuid.uuid4())}}
    )
    out, opener = _open_with_outcome(
        monkeypatch, needs_retry=True, latest_result="correct", stored=stored
    )
    opener.assert_not_called()
    assert out.result is not None
