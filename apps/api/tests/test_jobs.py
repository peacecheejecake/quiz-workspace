"""The API's job message is exactly the worker's envelope contract (apps/worker)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from pydantic import SecretStr
from quiz_api.jobs import (
    DEFAULT_QUEUE,
    TASK_NAME_PREFIX,
    CeleryJobPublisher,
    JobMessage,
    build_job_publisher,
    task_name,
)
from quiz_api.repositories.documents import PARSE_JOB_TYPE, parse_job_key
from quiz_api.settings import Settings

celery_app = pytest.importorskip("quiz_worker.celery_app")
envelope = pytest.importorskip("quiz_worker.envelope")


def _message() -> JobMessage:
    upload_id = uuid.uuid4()
    return JobMessage(
        job_id=uuid.uuid4(),
        job_type=PARSE_JOB_TYPE,
        schema_version=1,
        workspace_id=uuid.uuid4(),
        created_by=uuid.uuid4(),
        idempotency_key=parse_job_key(upload_id),
        payload={"document_id": str(uuid.uuid4()), "revision_id": str(uuid.uuid4())},
    )


def test_names_match_the_worker() -> None:
    assert TASK_NAME_PREFIX == celery_app.TASK_NAME_PREFIX
    assert DEFAULT_QUEUE == celery_app.DEFAULT_QUEUE
    assert task_name(PARSE_JOB_TYPE) == celery_app.task_name(PARSE_JOB_TYPE)


def test_message_parses_as_a_worker_envelope() -> None:
    message = _message()
    parsed = envelope.parse_envelope(message.to_message())
    assert parsed.job_id == message.job_id
    assert parsed.job_type == "document.parse"
    assert parsed.created_by == message.created_by
    assert parsed.idempotency_key == message.idempotency_key
    assert parsed.to_message() == message.to_message()
    assert "payload" not in repr(message)


def test_celery_publisher_sends_the_worker_task(monkeypatch: pytest.MonkeyPatch) -> None:
    publisher = CeleryJobPublisher("memory://")
    sent: dict[str, Any] = {}

    def fake_send_task(name: str, **options: Any) -> None:
        sent.update(options, name=name)

    monkeypatch.setattr(publisher._app, "send_task", fake_send_task)
    message = _message()
    publisher.publish(message)
    assert sent["name"] == "quiz.jobs.document.parse"
    assert sent["queue"] == "quiz.jobs"
    assert sent["task_id"] == str(message.job_id)
    assert sent["args"] == (message.to_message(),)
    # The envelope never shows up in broker events / logs.
    assert sent["argsrepr"] == f"(<job {message.job_id}>,)"
    assert sent["kwargsrepr"] == "{}"
    publisher.close()


def test_publisher_needs_a_broker() -> None:
    assert build_job_publisher(Settings.model_construct()) is None
    publisher = build_job_publisher(
        Settings.model_construct(redis_url=SecretStr("redis://127.0.0.1:6379/0"))
    )
    assert isinstance(publisher, CeleryJobPublisher)
    publisher.close()
