"""UX12-OPEN retries the browser cannot observe, with the repositories faked. The DB side is in
tests/integration/questions/test_practice_open.py."""

from __future__ import annotations

import uuid
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
        session=submitted, latest_attempt_id=uuid.uuid4(), latest_result=object()
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
