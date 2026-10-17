from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from quiz_worker.envelope import JobEnvelope, parse_envelope
from quiz_worker.errors import InvalidEnvelopeError, InvalidPayloadError
from quiz_worker.jobs import ECHO_JOB

from .conftest import BOOK_TEXT, TOKEN, WORKSPACE_ID, EnvelopeFactory


def _message(**overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "job_id": str(uuid4()),
        "job_type": "document.parse",
        "schema_version": 1,
        "idempotency_key": "upload-123",
        "workspace_id": str(WORKSPACE_ID),
        "payload": {"text": BOOK_TEXT},
    }
    message.update(overrides)
    return message


def test_valid_envelope_round_trips_through_json_message() -> None:
    envelope = parse_envelope(_message())

    assert envelope.job_type == "document.parse"
    assert parse_envelope(envelope.to_message()) == envelope


def test_envelope_repr_never_shows_the_payload() -> None:
    envelope = parse_envelope(_message())

    assert BOOK_TEXT not in repr(envelope)
    assert BOOK_TEXT not in str(envelope)


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"job_id": f"Bearer {TOKEN}"}, "job_id: uuid_parsing"),
        ({"job_type": BOOK_TEXT}, "job_type: string_pattern_mismatch"),
        ({"schema_version": 0}, "schema_version: greater_than_equal"),
        ({"idempotency_key": f"{BOOK_TEXT}"}, "idempotency_key: string_pattern_mismatch"),
        ({"workspace_id": None}, "workspace_id: uuid_type"),
        ({BOOK_TEXT: "x"}, "<key>: extra_forbidden"),
    ],
)
def test_invalid_envelope_is_rejected_without_echoing_input(
    overrides: dict[str, Any], expected: str
) -> None:
    with pytest.raises(InvalidEnvelopeError) as excinfo:
        parse_envelope(_message(**overrides))

    message = str(excinfo.value)
    assert expected in message
    assert TOKEN not in message
    assert BOOK_TEXT not in message


def test_missing_fields_and_non_objects_are_rejected() -> None:
    with pytest.raises(InvalidEnvelopeError, match="schema_version: missing"):
        parse_envelope({k: v for k, v in _message().items() if k != "schema_version"})
    with pytest.raises(InvalidEnvelopeError, match="expected an object, got str"):
        parse_envelope(BOOK_TEXT)


def test_payload_is_validated_by_the_versioned_payload_model(
    make_envelope: EnvelopeFactory,
) -> None:
    ok = ECHO_JOB.parse_payload(make_envelope(payload={"message": "hi"}))
    assert ok.message == "hi"

    with pytest.raises(InvalidPayloadError) as excinfo:
        ECHO_JOB.parse_payload(make_envelope(payload={"message": 1, BOOK_TEXT: TOKEN}))
    assert str(excinfo.value) == "message: string_type; <key>: extra_forbidden"


def test_envelope_model_is_frozen() -> None:
    envelope = JobEnvelope.model_validate(_message())

    with pytest.raises(ValueError, match="frozen"):
        envelope.job_type = "other"
