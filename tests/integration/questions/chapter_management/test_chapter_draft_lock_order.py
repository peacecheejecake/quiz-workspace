"""Lock order against a chapter delete (docs/questions.md §14.6): workspace FOR SHARE -> chapter
tree row -> documents -> questions -> drafts.

A delete holds the chapter's owner and then moves drafts, so a draft write must wait for the owner
without holding the draft, or the two deadlock. As in test_chapter_management_races.py a rival
connection holds what the delete holds, the write starts in a thread and the test waits until the
API's backend is blocked. The rival must still reach the draft at once.
"""

from __future__ import annotations

import importlib.util
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.infra

_NOTES = Path(__file__).resolve().parents[1] / "chapter_notes" / "test_chapter_notes_contract.py"
_spec = importlib.util.spec_from_file_location("_chnote_contract_helpers_chlock", _NOTES)
assert _spec is not None
assert _spec.loader is not None
notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notes)

DB_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
STALE_DRAFT = "urn:quiz-workspace:problem:stale-draft"
HOLD_TREE = "select 1 from public.workspace_chapter_trees where workspace_id = %s for update"
HOLD_DOCUMENT = "select 1 from public.documents where id = %s for update"


def _wait_until_blocked_by(pid: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    with psycopg.connect(DB_ADMIN_URL, autocommit=True) as conn:
        while time.monotonic() < deadline:
            row = conn.execute(
                "select count(*) from pg_stat_activity where %s = any(pg_blocking_pids(pid))",
                (pid,),
            ).fetchone()
            if row is not None and row[0] > 0:
                return
            time.sleep(0.05)
    pytest.fail("the draft write never waited for the chapter's owner")


def _chapter(owner: Any, ws: str, title: str, document_id: str | None = None) -> str:
    made = owner.ok(
        "POST", f"/workspaces/{ws}/chapters", {"title": title, "document_id": document_id}, (201,)
    )
    return str(made["chapter"]["id"])


def _race(
    hold: str,
    held: str,
    draft_id: str,
    write: Callable[[], httpx.Response],
    *,
    move_draft: bool = False,
) -> httpx.Response:
    result: dict[str, httpx.Response] = {}

    def attempt() -> None:
        result["res"] = write()

    with psycopg.connect(DB_ADMIN_URL) as delete:
        pid = delete.info.backend_pid
        delete.execute(hold, (held,))
        thread = threading.Thread(target=attempt)
        thread.start()
        _wait_until_blocked_by(pid)
        assert "res" not in result, "the write must wait for the owner"
        # NOWAIT: an API that held the draft here would be half of the deadlock.
        delete.execute(
            "select 1 from public.question_drafts where id = %s for update nowait", (draft_id,)
        )
        if move_draft:
            delete.execute(
                "update public.question_drafts set chapter_id = null where id = %s", (draft_id,)
            )
        delete.commit()
        thread.join(timeout=30)
        assert not thread.is_alive(), "the write never finished"
    return result["res"]


def test_ux12_chapteradd_a_draft_edit_waits_for_a_workspace_chapter_delete_outside_the_draft(
    seed: Any,
) -> None:
    owner = seed.client("chlock-tree")
    ws = str(owner.create_workspace()["id"])
    gone, kept = _chapter(owner, ws, "지울 장"), _chapter(owner, ws, "남을 장")
    draft = notes.draft_in(owner, ws, gone)

    res = _race(
        HOLD_TREE,
        ws,
        str(draft["id"]),
        lambda: owner.send(
            "PATCH",
            f"/question-drafts/{draft['id']}",
            {"base_version": draft["version"], "chapter_id": kept},
            headers={},
        ),
    )
    assert res.status_code == 200, res.text
    assert res.json()["chapter"]["id"] == kept


def test_ux12_chapteradd_a_draft_edit_is_stale_after_a_delete_moved_the_draft(seed: Any) -> None:
    owner = seed.client("chlock-stale")
    ws = str(owner.create_workspace()["id"])
    gone, kept = _chapter(owner, ws, "지울 장"), _chapter(owner, ws, "남을 장")
    draft = notes.draft_in(owner, ws, gone)

    res = _race(
        HOLD_TREE,
        ws,
        str(draft["id"]),
        lambda: owner.send(
            "PATCH",
            f"/question-drafts/{draft['id']}",
            {"base_version": draft["version"], "chapter_id": kept},
            headers={},
        ),
        move_draft=True,
    )
    assert res.status_code == 409, res.text
    assert res.json()["type"] == STALE_DRAFT, "the draft is read again after the wait"


def test_ux12_chapteradd_a_draft_edit_waits_for_a_book_chapter_delete_outside_the_draft(
    seed: Any,
) -> None:
    owner = seed.client("chlock-book")
    ws = str(owner.create_workspace()["id"])
    doc = notes.upload(owner, ws)
    gone, kept = _chapter(owner, ws, "지울 장", doc), _chapter(owner, ws, "남을 장", doc)
    draft = notes.draft_in(owner, ws, gone)

    res = _race(
        HOLD_DOCUMENT,
        doc,
        str(draft["id"]),
        lambda: owner.send(
            "PATCH",
            f"/question-drafts/{draft['id']}",
            {"base_version": draft["version"], "chapter_id": kept},
            headers={},
        ),
    )
    assert res.status_code == 200, res.text


def test_ux12_chapteradd_a_registration_takes_the_chapter_owner_before_its_drafts(
    seed: Any,
) -> None:
    owner = seed.client("chlock-publish")
    ws = str(owner.create_workspace()["id"])
    chapter = _chapter(owner, ws, "범위")
    draft = notes.draft_in(owner, ws, chapter)

    res = _race(
        HOLD_TREE,
        ws,
        str(draft["id"]),
        lambda: owner.send(
            "POST",
            f"/question-imports/{draft['import_id']}/publish",
            {
                "approve": True,
                "drafts": [{"draft_id": draft["id"], "version": draft["version"]}],
            },
            headers={},
        ),
    )
    assert res.status_code == 200, res.text
