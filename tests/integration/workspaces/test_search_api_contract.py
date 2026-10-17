"""SEARCH-01 server guarantees (docs/architecture.md §4 search flow, auth.md §5).

Search is scoped by the path workspace after a membership check: a foreign workspace answers
the same 404 as a missing one in every mode and never carries document content.
Fixtures: conftest.py.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

pytestmark = pytest.mark.infra

MODES = ("keyword", "semantic", "hybrid")


def test_search_01_ac05_foreign_workspace_search_is_404_without_content(seed: Any) -> None:
    alice, mallory = seed.client("search01-ac05-alice"), seed.client("search01-ac05-mallory")
    ws = alice.create_workspace("Alice Search")
    alice.upload_book(ws["id"])

    for mode in MODES:
        own = alice.ok("POST", f"/workspaces/{ws['id']}/search", {"query": "물", "mode": mode})
        assert isinstance(own["items"], list), mode

    missing = seed.problem(
        mallory.call(
            "POST", f"/workspaces/{uuid.uuid4()}/search", {"query": "물", "mode": "hybrid"}
        ),
        404,
    )
    for mode in MODES:
        res = mallory.call("POST", f"/workspaces/{ws['id']}/search", {"query": "물", "mode": mode})
        assert seed.problem(res, 404) == missing, mode
        assert "items" not in res.text
        assert "Alice Search" not in res.text
