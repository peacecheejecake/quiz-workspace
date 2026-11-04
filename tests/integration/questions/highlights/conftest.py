"""Fixtures for the HILITE-01 highlight contract tests (C01-C08).

Reuses the CHNOTE-01 contract stack (tests/integration/questions/chapter_notes/conftest.py: the
sharing stack with the M4 in-process `JobWorker`, the chapter note feature on, superuser `db`),
loaded by path because conftest modules are not importable under `--import-mode=importlib`. Note
highlights need chapter note versions (the scenario LLM), C02 needs share links and forks, so this
package gets the same app, worker and seed as the chapter note package. Request/response shapes
mirror tests/e2e/fixtures/highlights.ts, whose header lists every UX9.0 assumption (H1-H5); keep
both in sync.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_NOTES_CONFTEST = Path(__file__).resolve().parents[1] / "chapter_notes" / "conftest.py"
_spec = importlib.util.spec_from_file_location("_chnote_conftest_hilite", _NOTES_CONFTEST)
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
