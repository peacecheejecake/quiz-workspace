"""Fixtures for the QSRC-01 question source preview contract tests (C01-C05).

Lives in its own directory because tests/integration/questions/conftest.py (M4 questions) builds
a different `seed`/`app_client`/`job_worker`; the fixtures here override those for this package.

Reuses the MOCK-01 contract stack (tests/integration/questions/mock_exams/conftest.py, itself on
the sharing stack and the M4 in-process `JobWorker`), loaded by path because conftest modules are
not importable under `--import-mode=importlib`: the production app in-process (APP_ENV=test), local
Auth users, the `quiz_api` DB role, share links / guest sessions, mock exams (`보기 섞기` needs no
LLM) and jobs drained in this process. Request/response shapes and labels mirror
tests/e2e/fixtures/question-source.ts, whose header lists every QSRC.0 assumption (S1-S7); keep
both in sync.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_MOCK_CONFTEST = Path(__file__).resolve().parents[1] / "mock_exams" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_mock_contract_conftest_qsrc", _MOCK_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_mock = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mock  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(_mock)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _mock.stack
seed = _mock.seed
mock_env = _mock.mock_env
job_worker = _mock.job_worker
app_client = _mock.app_client
db = _mock.db
