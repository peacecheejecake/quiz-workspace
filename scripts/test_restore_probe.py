"""scripts/restore_probe.py refuses any non-loopback endpoint before it creates or reads anything
(M7.3; Codex P2: a hosted QDRANT_URL next to a local Supabase/Postgres)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

LOCAL = {
    "NEXT_PUBLIC_SUPABASE_URL": "http://127.0.0.1:54321",
    "SUPABASE_URL": "http://127.0.0.1:54321",
    "SUPABASE_SECRET_KEY": "sb_secret_unit",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_unit",
    "DATABASE_URL": "postgresql://quiz_api:x@127.0.0.1:54322/postgres",
    "WORKER_DATABASE_URL": "postgresql://quiz_worker:x@127.0.0.1:54322/postgres",
    "QDRANT_URL": "http://127.0.0.1:6333",
}


def _probe() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "restore_probe", Path(__file__).with_name("restore_probe.py")
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _no_side_effects(monkeypatch: pytest.MonkeyPatch, probe: ModuleType) -> list[str]:
    calls: list[str] = []

    def forbidden(*_a: Any, **_k: Any) -> Any:
        calls.append("network")
        raise AssertionError("no request may be made")

    monkeypatch.setattr(probe.httpx, "post", forbidden)
    monkeypatch.setattr(probe.httpx, "put", forbidden)
    monkeypatch.setattr(probe.httpx, "get", forbidden)
    import quiz_worker.adapters
    import quiz_worker.pg_store

    monkeypatch.setattr(quiz_worker.pg_store, "create_job_store_engine", forbidden)
    monkeypatch.setattr(quiz_worker.adapters, "build_index_store", forbidden)
    return calls


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("QDRANT_URL", "https://cluster.cloud.qdrant.io:6333"),
        ("WORKER_DATABASE_URL", "postgresql://quiz_worker:x@db.example.org:5432/postgres"),
        ("SUPABASE_URL", "https://project.supabase.co"),
    ],
)
@pytest.mark.parametrize("command", ["seed", "verify"])
def test_mixed_local_remote_config_is_refused_without_side_effects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, command: str, variable: str, value: str
) -> None:
    for key, local in LOCAL.items():
        monkeypatch.setenv(key, local)
    monkeypatch.setenv(variable, value)
    probe = _probe()
    calls = _no_side_effects(monkeypatch, probe)
    state = tmp_path / "probe.json"
    if command == "verify":
        state.write_text(json.dumps({"document_id": "d"}), encoding="utf-8")
    before = state.read_bytes() if state.exists() else None

    with pytest.raises(SystemExit, match="refusing a non-local"):
        probe.main([command, "--state", str(state)])

    assert calls == []
    assert (state.read_bytes() if state.exists() else None) == before


def test_preflight_accepts_an_all_local_config(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, local in LOCAL.items():
        monkeypatch.setenv(key, local)
    probe = _probe()
    probe._preflight(probe._worker_settings(), LOCAL["SUPABASE_URL"])
