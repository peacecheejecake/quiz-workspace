"""History read API helpers (M7.1): cursor codec, retry permission, metadata parsing.

The routes against the local stack are covered in tests/integration/history/.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.exceptions import RequestValidationError
from quiz_api.api.history import can_retry, decode_cursor, encode_cursor
from quiz_api.authz import Action, Role, WorkspaceAccess
from quiz_api.repositories.history import Cursor, as_uuid, as_version, question_label


def _access(role: Role, status: str = "active") -> WorkspaceAccess:
    return WorkspaceAccess(uuid.uuid4(), uuid.uuid4(), role, status, Action.READ)


def test_cursor_round_trips() -> None:
    cursor = Cursor(datetime(2026, 10, 18, 1, 2, 3, 456789, tzinfo=UTC), uuid.uuid4())
    assert decode_cursor(encode_cursor(cursor)) == cursor


@pytest.mark.parametrize(
    "value",
    ["", "!!!", "bm90IGpzb24", "WyIyMDI2LTEwLTE4VDAwOjAwOjAwIiwiYSJd", "W10"],
)
def test_forged_cursors_are_rejected(value: str) -> None:
    with pytest.raises(RequestValidationError):
        decode_cursor(value)


@pytest.mark.parametrize(
    ("role", "status", "expected"),
    [
        (Role.OWNER, "active", True),
        (Role.EDITOR, "active", True),
        (Role.VIEWER, "active", False),
        (Role.OWNER, "archived", False),
        (Role.EDITOR, "archived", False),
    ],
)
def test_retry_needs_an_edit_role_in_an_active_workspace(
    role: Role, status: str, expected: bool
) -> None:
    access = _access(role, status)
    assert can_retry(access, "document") is expected
    assert can_retry(access, "question_import") is expected
    assert can_retry(access, "question_generation") is False
    assert can_retry(access, "unknown") is False


def test_metadata_values_are_parsed_defensively() -> None:
    value = uuid.uuid4()
    assert as_uuid(str(value)) == value
    for bad in (None, 1, "nope", {"id": str(value)}, [str(value)]):
        assert as_uuid(bad) is None
    assert as_version(2) == 2
    for bad_version in (0, -1, True, "2", 2.0, None):
        assert as_version(bad_version) is None


def test_question_label_shows_the_number_only() -> None:
    assert question_label(12) == "12번 문제"
    assert question_label(None) is None
