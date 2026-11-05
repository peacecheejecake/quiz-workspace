"""UX10-PLAY bank count contract, independent of mock variation settings."""

import pytest
from pydantic import ValidationError
from quiz_api.api.practice_runs import PracticeRunCreate


def test_bank_count_contract() -> None:
    base = {"source": "bank", "range": {"all": True}}
    assert PracticeRunCreate.model_validate(base).question_count is None
    assert PracticeRunCreate.model_validate({**base, "question_count": None}).question_count is None
    for count in (1, 5000):
        assert (
            PracticeRunCreate.model_validate({**base, "question_count": count}).question_count
            == count
        )
    for count in (0, 5001):
        with pytest.raises(ValidationError):
            PracticeRunCreate.model_validate({**base, "question_count": count})


def test_oversized_candidate_pool_is_rejected_before_count_limit() -> None:
    from types import SimpleNamespace
    from unittest.mock import Mock
    from uuid import uuid4

    from quiz_api.api.practice_runs import MAX_RUN, create_practice_run
    from quiz_api.errors import ProblemException, ProblemType

    access = SimpleNamespace(user_id=uuid4(), workspace_id=uuid4())
    resolver = Mock()
    resolver.resolve.return_value = [uuid4() for _ in range(MAX_RUN + 1)]
    body = PracticeRunCreate.model_validate(
        {"source": "bank", "range": {"all": True}, "question_count": 10}
    )
    with pytest.raises(ProblemException) as error:
        create_practice_run(access, body, Mock(), resolver, Mock(), Mock(), Mock(), None)
    assert error.value.status_code == 422
    assert error.value.problem_type is ProblemType.PRACTICE_RUN_TOO_LARGE
