"""Range practice runs (QVIEW-B, QVIEW-01-C01~C05) over `practice_runs` and the run-linked
`practice_sessions` rows.

Size: a run holds up to 5,000 positions. No read here loads `item_ids` into Python except
creation: the run read takes `cardinality(item_ids)`, an item read takes `item_ids[position]`,
a results page takes a slice `item_ids[offset+1 : offset+limit]`. Progress and summary are one
aggregate over the run's sessions (the partial unique `(practice_run_id, run_position)` index).

Every read is keyed by the run id AND the caller's user id: a run belongs to its creator only.

The `이어 풀기` list (UX12-RESUME) is the one read over several runs: it scans at most
`UNFINISHED_SCAN` runs, most recently touched first, and aggregates their positions in SQL.

Eligibility (QVIEW-01-C07, the question-viewer state table): a position is available only while
its question is a live CONFIRMED question of the run's workspace (`eligible_question`). The item
read, the summary and the results all use that one condition: a position whose question was
archived (merged duplicates included) or deleted shows no content and counts as skipped, even if
it was submitted before; its attempts are history and are never changed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import (
    ColumnElement,
    Integer,
    Text,
    Uuid,
    and_,
    case,
    false,
    func,
    insert,
    literal,
    or_,
    select,
    true,
    update,
)
from sqlalchemy import (
    cast as sql_cast,
)
from sqlalchemy.orm import Session

from quiz_api.authz.permissions import LockMode
from quiz_api.authz.repository import MembershipRecord, membership_record, membership_select
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.practice_epoch import current_session
from quiz_api.repositories.tables import (
    chapters,
    practice_runs,
    practice_sessions,
    question_attempts,
    question_revisions,
    questions,
    workspaces,
)

# Characters of the stem fetched for a results preview.
STEM_HEAD = 1000

RunResult = str  # correct | incorrect | pending

# The runs the `이어 풀기` list looks at: bounds its cost when many runs were left open.
UNFINISHED_SCAN = 100


@dataclass(frozen=True)
class RunRecord:
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    source: str
    mock_exam_id: uuid.UUID | None
    random_order: bool
    seed: int
    total: int
    created_at: datetime
    finished_at: datetime | None
    shuffle_options: bool = False


@dataclass(frozen=True)
class RunProgress:
    """Aggregates over the run's sessions. `reached` = the furthest position opened (0: none);
    `submitted_before_reached` counts submissions at positions < reached."""

    reached: int
    submitted: int
    correct: int
    incorrect: int
    pending: int
    submitted_before_reached: int


@dataclass(frozen=True)
class LiveQuestion:
    """A live CONFIRMED question at a run position: what an item shows (no answers)."""

    id: uuid.UUID
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    question_number: int | None
    stem: str
    options: list[dict[str, str]]
    is_multi_answer: bool
    stem_tables: list[Any] | None = None


@dataclass(frozen=True)
class ResultRow:
    position: int
    question_id: uuid.UUID | None
    available: bool
    question_type: QuestionType | None
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    question_number: int | None
    stem_head: str | None
    state: str | None
    result: RunResult | None


@dataclass(frozen=True)
class UnfinishedRun:
    """A row of the `이어 풀기` list. `next_position` is the first position still answerable."""

    id: uuid.UUID
    total: int
    answered: int
    next_position: int
    chapter_title: str | None
    created_at: datetime
    last_touched_at: datetime


_RUN_COLUMNS = (
    practice_runs.c.id,
    practice_runs.c.workspace_id,
    practice_runs.c.user_id,
    practice_runs.c.source,
    practice_runs.c.mock_exam_id,
    practice_runs.c.random_order,
    practice_runs.c.seed,
    func.cardinality(practice_runs.c.item_ids).label("total"),
    practice_runs.c.created_at,
    practice_runs.c.finished_at,
    func.coalesce(practice_runs.c.range["shuffle_options"].as_boolean(), false()).label(
        "shuffle_options"
    ),
)


def _run(row: Any) -> RunRecord:
    return RunRecord(
        id=row.id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        source=row.source,
        mock_exam_id=row.mock_exam_id,
        random_order=row.random_order,
        seed=int(row.seed),
        total=int(row.total),
        created_at=row.created_at,
        finished_at=row.finished_at,
        shuffle_options=row.shuffle_options,
    )


def eligible_question(question_id: Any, workspace_id: uuid.UUID) -> ColumnElement[bool]:
    """`questions` row condition: `question_id` is a live CONFIRMED question of the workspace."""
    return and_(
        questions.c.id == question_id,
        questions.c.workspace_id == workspace_id,
        questions.c.publication_status == "CONFIRMED",
        questions.c.deleted_at.is_(None),
    )


def _latest_result() -> Any:
    """LATERAL: the current result of the enclosing session (its newest attempt)."""
    return (
        select(question_attempts.c.result)
        .where(question_attempts.c.practice_session_id == practice_sessions.c.id)
        .order_by(question_attempts.c.submitted_at.desc(), question_attempts.c.id.desc())
        .limit(1)
        .correlate(practice_sessions)
        .lateral("latest")
    )


class PracticeRunRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def commit(self) -> None:
        self._session.commit()

    def run_membership(
        self, run_id: uuid.UUID, user_id: uuid.UUID, lock: LockMode
    ) -> MembershipRecord | None:
        """The caller's membership in the workspace of the caller's own run (one query); `None`
        for unknown runs, other users' runs and non-members alike (one 404)."""
        stmt = (
            membership_select(user_id, lock)
            .join(practice_runs, practice_runs.c.workspace_id == workspaces.c.id)
            .where(practice_runs.c.id == run_id, practice_runs.c.user_id == user_id)
        )
        return membership_record(self._session, stmt, user_id)

    def create(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        source: str,
        mock_exam_id: uuid.UUID | None,
        range_: dict[str, Any],
        mock_exam_generation_id: uuid.UUID | None = None,
        random_order: bool,
        seed: int,
        item_ids: list[uuid.UUID],
    ) -> RunRecord:
        row = self._session.execute(
            insert(practice_runs)
            .values(
                workspace_id=workspace_id,
                user_id=user_id,
                source=source,
                mock_exam_id=mock_exam_id,
                mock_exam_generation_id=mock_exam_generation_id,
                range=range_,
                random_order=random_order,
                seed=seed,
                item_ids=item_ids,
            )
            .returning(*_RUN_COLUMNS)
        ).one()
        return _run(row)

    def get(self, run_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False) -> RunRecord | None:
        stmt = select(*_RUN_COLUMNS).where(
            practice_runs.c.id == run_id, practice_runs.c.user_id == user_id
        )
        if lock:
            stmt = stmt.with_for_update(key_share=True)
        row = self._session.execute(stmt).one_or_none()
        return _run(row) if row is not None else None

    def get_in_workspace(
        self, run_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> RunRecord | None:
        """The caller's run of this workspace, locked (opening a position serialises per run)."""
        row = self._session.execute(
            select(*_RUN_COLUMNS)
            .where(
                practice_runs.c.id == run_id,
                practice_runs.c.user_id == user_id,
                practice_runs.c.workspace_id == workspace_id,
            )
            .with_for_update(key_share=True)
        ).one_or_none()
        return _run(row) if row is not None else None

    def question_at(self, run_id: uuid.UUID, position: int) -> uuid.UUID | None:
        """The question id stored at a 1-based position (None outside the run)."""
        value: uuid.UUID | None = self._session.execute(
            select(practice_runs.c.item_ids[position]).where(practice_runs.c.id == run_id)
        ).scalar_one_or_none()
        return value

    def finish(self, run_id: uuid.UUID) -> None:
        """Set `finished_at` once (a finished run is left as it is)."""
        self._session.execute(
            update(practice_runs)
            .where(practice_runs.c.id == run_id, practice_runs.c.finished_at.is_(None))
            .values(finished_at=func.now())
        )

    def dismiss(self, run_id: uuid.UUID) -> None:
        """Take the run out of the `이어 풀기` list, once; nothing else about it changes."""
        self._session.execute(
            update(practice_runs)
            .where(practice_runs.c.id == run_id, practice_runs.c.resume_dismissed_at.is_(None))
            .values(resume_dismissed_at=func.now())
        )

    def unfinished(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, limit: int
    ) -> list[UnfinishedRun]:
        """The caller's bank runs of this workspace with a position left to answer, most
        recently touched first (UX12-RESUME)."""
        touched = (
            select(
                func.max(
                    func.greatest(
                        practice_sessions.c.opened_at,
                        practice_sessions.c.submitted_at,
                        practice_sessions.c.graded_at,
                    )
                )
            )
            .where(practice_sessions.c.practice_run_id == practice_runs.c.id)
            .correlate(practice_runs)
            .scalar_subquery()
        )
        last_touched = func.coalesce(touched, practice_runs.c.created_at).label("last_touched_at")
        candidates = self._session.execute(
            select(
                practice_runs.c.id,
                func.cardinality(practice_runs.c.item_ids).label("total"),
                practice_runs.c.created_at,
                last_touched,
            )
            .where(
                practice_runs.c.workspace_id == workspace_id,
                practice_runs.c.user_id == user_id,
                practice_runs.c.source == "bank",
                practice_runs.c.finished_at.is_(None),
                practice_runs.c.resume_dismissed_at.is_(None),
            )
            .order_by(last_touched.desc(), practice_runs.c.id.desc())
            .limit(UNFINISHED_SCAN)
        ).all()
        if not candidates:
            return []
        positions = self._unfinished_positions(workspace_id, [c.id for c in candidates])
        out: list[UnfinishedRun] = []
        for candidate in candidates:
            row = positions.get(candidate.id)
            if row is None or row.next_position is None:
                continue
            out.append(
                UnfinishedRun(
                    id=candidate.id,
                    total=int(candidate.total),
                    answered=int(row.answered),
                    next_position=int(row.next_position),
                    chapter_title=row.chapter_title,
                    created_at=candidate.created_at,
                    last_touched_at=candidate.last_touched_at,
                )
            )
            if len(out) == limit:
                break
        return out

    def _unfinished_positions(
        self, workspace_id: uuid.UUID, run_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, Any]:
        """For each run: positions answered, the first one still answerable and the chapter
        title if its live questions share one. A position is answerable while its question is
        live and it has no session, or an open session of the current epoch: a session reset
        since it was opened cannot be read in the run any more (409), and a submitted one is
        done. `answered` is `PracticeRun.answered`."""
        item = (
            func.unnest(practice_runs.c.item_ids)
            .table_valued("question_id", with_ordinality="ordinality")
            .render_derived(name="run_item")
        )
        rows = (
            select(
                practice_runs.c.id.label("run_id"),
                item.c.ordinality.label("position"),
                questions.c.id.label("live_id"),
                questions.c.chapter_id,
                practice_sessions.c.id.label("session_id"),
                practice_sessions.c.state,
                current_session().label("current"),
            )
            .select_from(
                practice_runs.join(item, true())
                .outerjoin(questions, eligible_question(item.c.question_id, workspace_id))
                .outerjoin(
                    practice_sessions,
                    and_(
                        practice_sessions.c.practice_run_id == practice_runs.c.id,
                        practice_sessions.c.run_position == item.c.ordinality,
                        practice_sessions.c.superseded_at.is_(None),
                    ),
                )
            )
            .where(practice_runs.c.id.in_(run_ids))
            .cte("run_items")
        )
        live = rows.c.live_id.is_not(None)
        submitted = and_(live, rows.c.state != "open", rows.c.current)
        answerable = and_(
            live,
            or_(rows.c.session_id.is_(None), and_(rows.c.state == "open", rows.c.current)),
        )
        totals = (
            select(
                rows.c.run_id,
                func.count().filter(submitted).label("answered"),
                func.min(rows.c.position).filter(answerable).label("next_position"),
                func.count(rows.c.chapter_id.distinct()).label("chapters"),
                func.count().filter(live, rows.c.chapter_id.is_(None)).label("no_chapter"),
                func.min(sql_cast(rows.c.chapter_id, Text)).label("chapter_id"),
            )
            .group_by(rows.c.run_id)
            .subquery("totals")
        )
        stmt = select(
            totals.c.run_id,
            totals.c.answered,
            totals.c.next_position,
            case(
                (and_(totals.c.chapters == 1, totals.c.no_chapter == 0), chapters.c.title),
                else_=None,
            ).label("chapter_title"),
        ).select_from(
            totals.outerjoin(
                chapters,
                and_(
                    chapters.c.id == sql_cast(totals.c.chapter_id, Uuid),
                    chapters.c.workspace_id == workspace_id,
                ),
            )
        )
        return {row.run_id: row for row in self._session.execute(stmt)}

    def progress(self, run: RunRecord) -> RunProgress:
        """`reached` counts every opened position; the submissions count only at positions that
        are still eligible (an unavailable position is skipped)."""
        latest = _latest_result()
        sessions = (
            select(
                practice_sessions.c.run_position.label("position"),
                practice_sessions.c.state,
                latest.c.result,
                and_(questions.c.id.is_not(None), current_session()).label("eligible"),
            )
            .select_from(
                practice_sessions.outerjoin(latest, true()).outerjoin(
                    questions, eligible_question(practice_sessions.c.question_id, run.workspace_id)
                )
            )
            .where(
                practice_sessions.c.practice_run_id == run.id,
                practice_sessions.c.superseded_at.is_(None),
            )
            .cte("run_sessions")
        )
        reached = select(func.coalesce(func.max(sessions.c.position), 0)).scalar_subquery()
        submitted = and_(sessions.c.state != "open", sessions.c.eligible)
        row = self._session.execute(
            select(
                reached.label("reached"),
                func.count().filter(submitted).label("submitted"),
                func.count().filter(submitted, sessions.c.result == "correct").label("correct"),
                func.count().filter(submitted, sessions.c.result == "incorrect").label("incorrect"),
                func.count()
                .filter(submitted, sessions.c.state == "pending_grade")
                .label("pending"),
                func.count()
                .filter(submitted, sessions.c.position < reached)
                .label("submitted_before_reached"),
            ).select_from(sessions)
        ).one()
        return RunProgress(
            reached=int(row.reached),
            submitted=int(row.submitted),
            correct=int(row.correct),
            incorrect=int(row.incorrect),
            pending=int(row.pending),
            submitted_before_reached=int(row.submitted_before_reached),
        )

    def live_question(self, workspace_id: uuid.UUID, question_id: uuid.UUID) -> LiveQuestion | None:
        """The question if it is still a live CONFIRMED question of the workspace."""
        row = self._session.execute(
            select(
                questions.c.id,
                questions.c.question_type,
                questions.c.chapter_id,
                chapters.c.title.label("chapter_title"),
                questions.c.question_number,
                question_revisions.c.stem,
                question_revisions.c.options,
                question_revisions.c.is_multi_answer,
                question_revisions.c.stem_tables,
            )
            .select_from(
                questions.join(
                    question_revisions,
                    and_(
                        question_revisions.c.id == questions.c.active_revision_id,
                        question_revisions.c.question_id == questions.c.id,
                    ),
                ).outerjoin(
                    chapters,
                    and_(
                        chapters.c.id == questions.c.chapter_id,
                        chapters.c.workspace_id == questions.c.workspace_id,
                    ),
                )
            )
            .where(eligible_question(question_id, workspace_id))
        ).one_or_none()
        if row is None:
            return None
        return LiveQuestion(
            id=row.id,
            question_type=cast(QuestionType, row.question_type),
            chapter_id=row.chapter_id,
            chapter_title=row.chapter_title,
            question_number=row.question_number,
            stem=row.stem,
            options=list(row.options),
            is_multi_answer=row.is_multi_answer,
            stem_tables=row.stem_tables,
        )

    def results(self, run: RunRecord, offset: int, limit: int) -> list[ResultRow]:
        """One page of positions offset+1 .. offset+limit with their question (if still live)
        and the caller's session result."""
        sliced = (
            func.unnest(practice_runs.c.item_ids[offset + 1 : offset + limit])
            .table_valued("question_id", with_ordinality="ordinality")
            .render_derived(name="slice")
        )
        page = (
            select(
                (sliced.c.ordinality + literal(offset, Integer)).label("position"),
                sliced.c.question_id,
            )
            .select_from(practice_runs.join(sliced, true()))
            .where(practice_runs.c.id == run.id)
            .cte("page")
        )
        latest = _latest_result()
        run_sessions = (
            select(
                practice_sessions.c.run_position,
                case((current_session(), practice_sessions.c.state), else_="reset").label("state"),
                case((current_session(), latest.c.result), else_=None).label("result"),
            )
            .select_from(practice_sessions.outerjoin(latest, true()))
            .where(
                practice_sessions.c.practice_run_id == run.id,
                practice_sessions.c.superseded_at.is_(None),
            )
            .subquery("run_sessions")
        )
        live = eligible_question(page.c.question_id, run.workspace_id)
        stmt = (
            select(
                page.c.position,
                page.c.question_id,
                questions.c.id.label("live_id"),
                questions.c.question_type,
                questions.c.chapter_id,
                chapters.c.title.label("chapter_title"),
                questions.c.question_number,
                func.left(question_revisions.c.stem, STEM_HEAD).label("stem_head"),
                run_sessions.c.state,
                run_sessions.c.result,
            )
            .select_from(
                page.outerjoin(questions, live)
                .outerjoin(
                    question_revisions,
                    and_(
                        question_revisions.c.id == questions.c.active_revision_id,
                        question_revisions.c.question_id == questions.c.id,
                    ),
                )
                .outerjoin(
                    chapters,
                    and_(
                        chapters.c.id == questions.c.chapter_id,
                        chapters.c.workspace_id == questions.c.workspace_id,
                    ),
                )
                # An unavailable position has no result (it is skipped), whatever it had.
                .outerjoin(
                    run_sessions,
                    and_(
                        run_sessions.c.run_position == page.c.position,
                        questions.c.id.is_not(None),
                    ),
                )
            )
            .order_by(page.c.position)
        )
        out: list[ResultRow] = []
        for r in self._session.execute(stmt):
            available = r.live_id is not None
            out.append(
                ResultRow(
                    position=int(r.position),
                    question_id=r.question_id if available else None,
                    available=available,
                    question_type=cast("QuestionType | None", r.question_type),
                    chapter_id=r.chapter_id,
                    chapter_title=r.chapter_title,
                    question_number=r.question_number,
                    stem_head=r.stem_head,
                    state=r.state,
                    result=r.result,
                )
            )
        return out
