"""Question list cursors (M4.2a fix): only cursors the API wrote decode; the rest are 422."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.exceptions import RequestValidationError
from quiz_api.api.questions import MAX_CURSOR, _decode_cursor, _encode_cursor
from quiz_api.repositories.questions import UNNUMBERED, ListCursor


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _cursor(payload: Any) -> str:
    return _b64(json.dumps(payload).encode())


TS = "2026-10-17T00:00:00+00:00"
ID = str(uuid.uuid4())


def test_round_trip() -> None:
    c = ListCursor(0, UNNUMBERED, datetime(2026, 10, 17, tzinfo=UTC), uuid.uuid4())
    assert _decode_cursor(_encode_cursor(c)) == c


@pytest.mark.parametrize(
    "value",
    [
        "bogus!",
        "가나다",
        _b64(b"\xff\xfe"),
        _b64(b"not json"),
        _cursor({"a": 1}),
        _cursor([0, 0, TS]),
        _cursor([0, 0, TS, ID, 5]),
        _cursor([0, 0, "2026-10-17T00:00:00", 123]),  # naive timestamp, int id
        _cursor([0, 0, "2026-10-17T00:00:00", ID]),  # naive timestamp
        _cursor([0, 0, TS, 123]),
        _cursor([0, 0, TS, "not-a-uuid"]),
        _cursor(["0", 0, TS, ID]),
        _cursor([0.5, 0, TS, ID]),
        _cursor([True, 0, TS, ID]),
        _cursor([2**31, 0, TS, ID]),
        _cursor([0, -(2**31) - 1, TS, ID]),
        _cursor([10**400, 0, TS, ID]),
        _b64(f'[Infinity, 0, "{TS}", "{ID}"]'.encode()),
        _b64(f'[NaN, 0, "{TS}", "{ID}"]'.encode()),
        _cursor([0, 0, "99999-01-01T00:00:00+00:00", ID]),
        _cursor([0, 0, None, ID]),
        "A" * (MAX_CURSOR + 1),
    ],
)
def test_malformed_cursors_are_422_without_echo(value: str) -> None:
    with pytest.raises(RequestValidationError) as err:
        _decode_cursor(value)
    assert err.value.errors() == [
        {"loc": ("query", "cursor"), "msg": "Invalid cursor.", "type": "value_error"}
    ]
