from __future__ import annotations

import logging
import os
import pickle

import pytest
from pydantic import ValidationError
from quiz_worker import serve
from quiz_worker.celery_app import QuizCelery, create_celery_app, task_name
from quiz_worker.logging_config import configure_logging
from quiz_worker.retry import RetryPolicy
from quiz_worker.settings import WorkerSettings, get_settings


def test_settings_read_env_and_keep_redis_url_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDIS_URL", "redis://:s3cret@redis:6379/0")
    monkeypatch.setenv("WORKER_CONCURRENCY", "2")

    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]

    assert settings.concurrency == 2
    assert settings.redis_url is not None
    assert "s3cret" not in repr(settings)
    assert settings.lease_seconds == settings.task_time_limit_seconds + settings.lease_grace_seconds


def test_defaults_follow_deployment_guidance(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_CONCURRENCY", raising=False)

    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]

    assert settings.concurrency == 1
    assert settings.task_always_eager is False


def test_soft_time_limit_must_be_below_hard_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_TASK_SOFT_TIME_LIMIT_SECONDS", "60")
    monkeypatch.setenv("WORKER_TASK_TIME_LIMIT_SECONDS", "60")

    with pytest.raises(ValidationError, match="below the hard limit"):
        WorkerSettings(_env_file=None)  # type: ignore[call-arg]


def test_retry_policy_backoff_is_exponential_and_capped() -> None:
    policy = RetryPolicy(max_attempts=5, base_delay_seconds=10, max_delay_seconds=60)

    assert [policy.countdown(n) for n in range(1, 6)] == [10, 20, 40, 60, 60]
    assert [policy.should_retry(n) for n in range(1, 6)] == [True] * 4 + [False]
    assert policy.should_retry(1, max_attempts=1) is False
    with pytest.raises(ValueError, match="max_attempts"):
        RetryPolicy(max_attempts=0)
    with pytest.raises(ValueError, match="base_delay_seconds"):
        RetryPolicy(base_delay_seconds=10, max_delay_seconds=5)


def test_worker_argv_uses_configured_concurrency_and_job_queue() -> None:
    argv = serve.build_worker_argv(1, "info")

    assert argv[0] == "worker"
    assert "--concurrency=1" in argv
    assert "--loglevel=INFO" in argv
    assert "--queues=quiz.jobs" in argv
    assert "--beat" in argv
    assert "--scheduler=celery.beat:Scheduler" in argv
    assert "--beat" not in serve.build_worker_argv(1, "info", beat=False)


def test_soft_time_limit_zero_disables_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_TASK_SOFT_TIME_LIMIT_SECONDS", "0")

    settings = WorkerSettings(_env_file=None)  # type: ignore[call-arg]

    assert settings.task_soft_time_limit_seconds == 0
    assert settings.reconcile_stale_after == settings.lease_seconds


def test_serve_refuses_eager_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_TASK_ALWAYS_EAGER", "true")
    get_settings.cache_clear()
    try:
        with pytest.raises(SystemExit, match="for tests"):
            serve.main([])
    finally:
        get_settings.cache_clear()


def test_app_pickles_by_rebuilding_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    # Prefork children started with spawn unpickle the app (seen on macOS).
    monkeypatch.setenv("APP_ENV", "local")
    monkeypatch.setenv("WORKER_TASK_ALWAYS_EAGER", "true")
    get_settings.cache_clear()
    root = logging.getLogger()
    handlers = list(root.handlers)
    try:
        app = create_celery_app(get_settings())
        clone = pickle.loads(pickle.dumps(app))  # noqa: S301 - our own object
    finally:
        get_settings.cache_clear()
        for handler in root.handlers[:]:
            if handler not in handlers:
                root.removeHandler(handler)

    assert isinstance(clone, QuizCelery)
    assert clone is not app
    assert task_name("echo") in clone.tasks


@pytest.mark.parametrize(("method", "flagged"), [("spawn", True), ("fork", False)])
def test_spawned_pool_children_get_the_execv_flag(
    monkeypatch: pytest.MonkeyPatch, method: str, flagged: bool
) -> None:
    monkeypatch.delenv("FORKED_BY_MULTIPROCESSING", raising=False)
    monkeypatch.setattr("billiard.get_start_method", lambda: method)

    assert serve.prepare_pool_start_method() == method
    assert ("FORKED_BY_MULTIPROCESSING" in os.environ) is flagged


def test_debug_level_never_enables_payload_logging_loggers() -> None:
    root = logging.getLogger()
    level, handlers = root.level, list(root.handlers)
    try:
        configure_logging("DEBUG")
        assert logging.getLogger("celery.pool").getEffectiveLevel() == logging.INFO
        assert logging.getLogger("kombu").getEffectiveLevel() == logging.INFO
    finally:
        root.setLevel(level)
        for handler in root.handlers[:]:
            if handler not in handlers:
                root.removeHandler(handler)
