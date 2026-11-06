"""Fixtures for the CHMAN-01 chapter management contract tests.

Reuses the CHNOTE-01 contract stack (tests/integration/questions/chapter_notes/conftest.py: the
sharing stack with the M4 in-process `JobWorker`, the chapter note feature on, superuser `db`),
loaded by path because conftest modules are not importable under `--import-mode=importlib`.
Notes give C03 and C06 their `has_note`; share links and forks give C01 and C02 their guests and
copies.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_NOTES_CONFTEST = Path(__file__).resolve().parents[1] / "chapter_notes" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_chnote_conftest_chman", _NOTES_CONFTEST)
assert _spec is not None
assert _spec.loader is not None
_cn = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _cn
_spec.loader.exec_module(_cn)

# Re-exported fixtures (pytest collects fixtures from conftest attributes).
stack = _cn.stack
seed = _cn.seed
note_env = _cn.note_env
job_worker = _cn.job_worker
app_client = _cn.app_client
db = _cn.db
