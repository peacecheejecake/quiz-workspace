"""Fixtures for the M7.0 history contract tests (HISTORY-01).

Reuses the question contract stack (tests/integration/questions/conftest.py: in-process
production app, local Auth users, `quiz_api` DB role, in-process JobWorker with the APP_ENV=test
fake embedder that fails on INDEX_FAILURE_MARKER), loaded by path because conftest modules are
not importable under `--import-mode=importlib`. The read-API shapes mirror
tests/e2e/fixtures/history.ts, whose header lists the M7.0 assumptions H1-H4.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_QUESTIONS_CONFTEST = Path(__file__).resolve().parents[1] / "questions" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_m7_questions_conftest", _QUESTIONS_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_questions = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _questions  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_questions)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _questions.stack
app_client = _questions.app_client
job_worker = _questions.job_worker
seed = _questions.seed


# M7.1 (tests/integration/history/test_history_api.py): the local stack's superuser URL for
# documented direct seeds and EXPLAIN checks, and the history index migration under test.
HISTORY_INDEX_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "20261018160000_history_keyset_indexes.sql"
)


@pytest.fixture
def admin_db_url() -> str:
    return str(_questions.DB_ADMIN_URL)


@pytest.fixture
def history_index_migration() -> Path:
    return HISTORY_INDEX_MIGRATION
