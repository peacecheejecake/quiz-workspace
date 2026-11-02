"""UX9-HL-B create_highlight against one explanation snapshot (Codex review P2).

A question edit can commit between the route's first read of the explanation and the later
reads that label and re-anchor the caller's other highlights (the per-user advisory lock does not
block question edits). The new range is cut from one revision, so overlaps must be checked
against that same revision; a client that read another revision gets 409 `stale-revision`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from quiz_api.api.highlights import ExplanationTargetIn, HighlightAnchor, HighlightCreate
from quiz_api.api.highlights import create_highlight as create_route
from quiz_api.authz.permissions import Role
from quiz_api.authz.repository import MembershipRecord
from quiz_api.errors import ProblemException, ProblemType
from quiz_api.repositories.highlights import HighlightRow, QuestionGroup, QuestionText

WS = uuid.uuid4()
USER = uuid.uuid4()
QID = uuid.uuid4()
CHAPTER = uuid.uuid4()
REV_A = uuid.uuid4()
REV_B = uuid.uuid4()
TEXT_A = "가나다 라마바 사아자"
TEXT_B = "가나다 (보충) 라마바 사아자"  # "라마바" moves from 4..7 to 9..12
NOW = datetime(2026, 11, 3, tzinfo=UTC)


def _text(revision: uuid.UUID, explanation: str) -> QuestionText:
    return QuestionText(QID, WS, CHAPTER, "CONFIRMED", 1, revision, explanation, "발문")


def _row(
    highlight_id: uuid.UUID, revision: uuid.UUID, start: int, end: int, quote: str
) -> HighlightRow:
    return HighlightRow(
        id=highlight_id,
        workspace_id=WS,
        user_id=USER,
        target_kind="explanation",
        chapter_note_id=None,
        question_id=QID,
        question_revision_id=revision,
        anchor={"block": "p0", "start": start, "end": end},
        quote=quote,
        prefix="",
        suffix="",
        color="yellow",
        version=1,
        replaced_by=None,
        created_at=NOW,
        updated_at=NOW,
        deleted_at=None,
        recently_deleted=False,
        note_version=None,
    )


class Access:
    def load_resource_membership(self, *_: Any) -> MembershipRecord:
        return MembershipRecord(WS, USER, Role.VIEWER, "active", None)


class EditedMidRequest:
    """The first explanation read sees revision A; every later read sees revision B."""

    def __init__(self, live: list[HighlightRow]) -> None:
        self.reads = 0
        self.live = live
        self.inserted: list[dict[str, Any]] = []

    def _current(self) -> QuestionText:
        self.reads += 1
        return _text(REV_A, TEXT_A) if self.reads == 1 else _text(REV_B, TEXT_B)

    def questions(self, _ws: uuid.UUID, ids: Any) -> dict[uuid.UUID, QuestionText]:
        return {QID: self._current()} if QID in list(ids) else {}

    def heatmap_group(self, _ws: uuid.UUID, _chapter: uuid.UUID | None) -> list[QuestionText]:
        return [_text(REV_B, TEXT_B)]

    def group_of(self, _ws: uuid.UUID, _qid: uuid.UUID) -> QuestionGroup:
        return QuestionGroup(CHAPTER, "1장 물의 순환")

    def chapter_lineage(self, ids: Any) -> dict[uuid.UUID, list[str]]:
        return {i: ["1장 물의 순환"] for i in ids}

    def lock_target(self, *_: Any) -> None:
        return None

    def live_on_target(self, *_: Any) -> list[HighlightRow]:
        return self.live

    def insert(self, **values: Any) -> uuid.UUID:
        self.inserted.append(values)
        return uuid.uuid4()

    def replace(self, *_: Any) -> None:
        return None

    def own_required(self, highlight_id: uuid.UUID, _user: uuid.UUID) -> HighlightRow:
        v = self.inserted[-1]
        a = v["anchor"]
        return _row(highlight_id, v["question_revision_id"], a["start"], a["end"], v["quote"])

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


def _create(repo: EditedMidRequest, start: int, end: int, revision: uuid.UUID | None = None) -> Any:
    body = HighlightCreate(
        target=ExplanationTargetIn(
            kind="explanation", question_id=QID, question_revision_id=revision
        ),
        anchor=HighlightAnchor(block="p0", start=start, end=end),
        color="blue",
    )
    return create_route(
        body=body,
        user=SimpleNamespace(id=USER),  # type: ignore[arg-type]
        access_repo=Access(),  # type: ignore[arg-type]
        repo=repo,  # type: ignore[arg-type]
        idempotency=SimpleNamespace(),  # type: ignore[arg-type]
        idempotency_key=None,
    )


def test_an_edit_mid_request_cannot_slip_an_overlapping_duplicate_in() -> None:
    # "라마바" highlighted on revision A; the client highlights it again on revision A while an
    # edit to B commits. Checked against B, the old one would sit at 9..12 and not overlap 4..7.
    existing = _row(uuid.uuid4(), REV_A, 4, 7, "라마바")
    repo = EditedMidRequest([existing])
    with pytest.raises(ProblemException) as exc:
        _create(repo, 4, 7)
    assert exc.value.problem_type is ProblemType.HIGHLIGHT_OVERLAP
    assert repo.inserted == []


def test_the_new_row_pins_the_revision_it_was_cut_from() -> None:
    repo = EditedMidRequest([])
    res = _create(repo, 0, 3)
    assert res.status_code == 201
    [values] = repo.inserted
    assert (values["question_revision_id"], values["quote"]) == (REV_A, "가나다")


def test_a_client_that_read_another_revision_gets_stale_revision() -> None:
    repo = EditedMidRequest([])
    with pytest.raises(ProblemException) as exc:
        _create(repo, 4, 7, revision=REV_B)
    assert exc.value.problem_type is ProblemType.STALE_REVISION
    assert repo.inserted == []
