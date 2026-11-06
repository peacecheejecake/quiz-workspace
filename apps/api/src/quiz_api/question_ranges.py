"""Question ranges (QVIEW-01-C01/C07, docs/questions.md §12): resolve a range request into the
ordered list of question ids it selects. Shared by range practice runs (QVIEW-B) and mock exam
ranges (MOCK-B).

A range is evaluated against the Heatmap's set and order (quiz_api.repositories.question_overview
`heatmap_source`/`heatmap_conditions`/`heatmap_order`): the workspace's live CONFIRMED questions
only — drafts, archived questions (merged duplicates included) and deleted questions are never in
a range — in Heatmap order whatever order the request listed them in.

    selected = (all | chapter in chapter_ids | id in question_ids) - excluded_question_ids
    result   = [q for q in heatmap if q in selected and q matches filters]

Filters narrow the whole selection ("선택 = 보이는 문제 중에서만"), the way the overview's query
filters do: `types`, `status` (the caller's dot status), `favorite`, `retry`. The caller's study
state is read through the `question_merged_user_states` view, so a question's state includes its
actively merged duplicates' (questions.md §10.2) and the filter picks what the Heatmap shows.

Refusals: an id in `question_ids`/`excluded_question_ids` that is not a live CONFIRMED question of
this workspace, or a chapter id that is not a chapter of this workspace, is 422 `range-invalid`
(never silently dropped). An empty result is 409 `no-matching-questions`. The size cap belongs to
the caller (MAX_RANGE_QUESTIONS for practice runs).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from quiz_api.errors import ProblemException, ProblemType
from quiz_api.question_rules import QuestionType
from quiz_api.question_status import DOT_STATUSES, DotStatus, StudyState, derive_dot_status
from quiz_api.repositories.question_overview import (
    heatmap_conditions,
    heatmap_order,
    heatmap_source,
)
from quiz_api.repositories.tables import chapters, question_merged_user_states, questions

MAX_RANGE_IDS = 5_000
MAX_RANGE_QUESTIONS = 5_000
NO_CHAPTER = "none"

ChapterRef = Annotated[
    uuid.UUID | Literal["none"],
    Field(description="A chapter id, or `none` for the questions without a chapter."),
]


class RangeFilters(BaseModel):
    """The overview's state/type filters (GET /workspaces/{id}/questions/overview)."""

    model_config = ConfigDict(extra="forbid")

    status: list[DotStatus] | None = Field(
        default=None,
        max_length=len(DOT_STATUSES),
        description="Keep these dot statuses; empty selects none, omitted selects all.",
    )
    favorite: bool | None = None
    retry: bool | None = Field(default=None, description="The `needs_retry` flag.")
    types: list[QuestionType] | None = Field(
        default=None,
        min_length=1,
        max_length=len(get_args(QuestionType)),
        description="Keep these question types; omitted selects all.",
    )

    @model_validator(mode="before")
    @classmethod
    def _single_type(cls, data: Any) -> Any:
        """Ranges saved before the multi-select hold one `type`, or a null one."""
        if not isinstance(data, dict) or "type" not in data:
            return data
        filters = {k: v for k, v in data.items() if k != "type"}
        if data["type"] is not None and filters.get("types") is None:
            filters["types"] = [data["type"]]
        return filters


class QuestionRange(BaseModel):
    """Whole groups (`all`, `chapter_ids`) plus single questions, minus exclusions, narrowed by
    `filters`. Id lists are capped at 5,000 entries each."""

    model_config = ConfigDict(extra="forbid")

    all: bool = Field(default=False, description="Every question of the Heatmap.")
    chapter_ids: list[ChapterRef] = Field(default_factory=list, max_length=MAX_RANGE_IDS)
    question_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_RANGE_IDS)
    excluded_question_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_RANGE_IDS)
    filters: RangeFilters = Field(default_factory=RangeFilters)


@dataclass(frozen=True)
class RangeRow:
    """One Heatmap question with the caller's merged study state."""

    question_id: uuid.UUID
    chapter_id: uuid.UUID | None
    question_type: QuestionType
    status: DotStatus
    is_favorite: bool
    needs_retry: bool
    revision_id: uuid.UUID
    """The question's active revision (what a mock exam generation pins)."""


def select_range(rows: Sequence[RangeRow], range_: QuestionRange) -> list[uuid.UUID]:
    """Pure part of the resolver: `rows` are the Heatmap in order; the result keeps that order.
    Raises `range-invalid` for unknown ids (see the module docstring)."""
    return [r.question_id for r in select_rows(rows, range_)]


def select_rows(
    rows: Sequence[RangeRow], range_: QuestionRange, *, drop_unknown: bool = False
) -> list[RangeRow]:
    """`select_range` returning the rows. With `drop_unknown` an id that is no longer a live
    CONFIRMED question (deleted, archived, merged away since the range was saved) is ignored
    instead of refused: a saved range re-resolved "with the questions of the time"."""
    live = {r.question_id for r in rows}
    unknown = [i for i in (*range_.question_ids, *range_.excluded_question_ids) if i not in live]
    if unknown and not drop_unknown:
        raise range_invalid()
    chapter_ids = {c for c in range_.chapter_ids if c != NO_CHAPTER}
    no_chapter = NO_CHAPTER in range_.chapter_ids
    picked = set(range_.question_ids)
    excluded = set(range_.excluded_question_ids)
    f = range_.filters
    wanted = set(f.status) if f.status is not None else None
    return [
        r
        for r in rows
        if (
            range_.all
            or r.question_id in picked
            or (r.chapter_id in chapter_ids if r.chapter_id is not None else no_chapter)
        )
        and r.question_id not in excluded
        and (f.types is None or r.question_type in f.types)
        and (wanted is None or r.status in wanted)
        and (f.favorite is None or r.is_favorite == f.favorite)
        and (f.retry is None or r.needs_retry == f.retry)
    ]


def range_invalid() -> ProblemException:
    return ProblemException(
        422,
        ProblemType.RANGE_INVALID,
        detail="The range names questions or chapters that cannot be practised in this workspace.",
    )


def no_matching_questions() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.NO_MATCHING_QUESTIONS,
        detail="No confirmed question of this workspace matches the range.",
    )


class QuestionRangeResolver:
    def __init__(self, session: Session) -> None:
        self._session = session

    def heatmap_rows(self, workspace_id: uuid.UUID, user_id: uuid.UUID) -> list[RangeRow]:
        """The workspace's Heatmap for `user_id`: ids, chapters, types and merged state only."""
        merged = question_merged_user_states
        stmt = (
            select(
                questions.c.id,
                questions.c.active_revision_id,
                questions.c.chapter_id,
                questions.c.question_type,
                merged.c.first_viewed_at,
                merged.c.last_graded_result,
                func.coalesce(merged.c.is_favorite, False).label("is_favorite"),
                func.coalesce(merged.c.needs_retry, False).label("needs_retry"),
            )
            .select_from(
                heatmap_source().outerjoin(
                    merged,
                    and_(
                        merged.c.user_id == user_id,
                        merged.c.workspace_id == workspace_id,
                        merged.c.question_id == questions.c.id,
                    ),
                )
            )
            .where(*heatmap_conditions(workspace_id))
            .order_by(*heatmap_order())
        )
        out: list[RangeRow] = []
        for r in self._session.execute(stmt):
            state = StudyState(
                first_viewed_at=r.first_viewed_at,
                last_graded_result=r.last_graded_result,
                needs_retry=bool(r.needs_retry),
                is_favorite=bool(r.is_favorite),
            )
            out.append(
                RangeRow(
                    question_id=r.id,
                    chapter_id=r.chapter_id,
                    question_type=r.question_type,
                    status=derive_dot_status(state),
                    is_favorite=bool(r.is_favorite),
                    needs_retry=bool(r.needs_retry),
                    revision_id=r.active_revision_id,
                )
            )
        return out

    def _known_chapters(self, workspace_id: uuid.UUID, ids: set[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        rows = self._session.execute(
            select(chapters.c.id).where(
                chapters.c.workspace_id == workspace_id, chapters.c.id.in_(ids)
            )
        )
        return {r.id for r in rows}

    def resolve(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, range_: QuestionRange
    ) -> list[uuid.UUID]:
        """The range's question ids in Heatmap order (never empty)."""
        rows = self.resolve_rows(workspace_id, user_id, range_)
        if not rows:
            raise no_matching_questions()
        return [r.question_id for r in rows]

    def resolve_rows(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        range_: QuestionRange,
        *,
        drop_unknown: bool = False,
    ) -> list[RangeRow]:
        """The range's Heatmap rows in order (possibly empty). `drop_unknown` re-resolves a saved
        range: ids and chapters that are gone are ignored instead of 422 (see `select_rows`)."""
        chapter_ids = {c for c in range_.chapter_ids if isinstance(c, uuid.UUID)}
        if not drop_unknown and self._known_chapters(workspace_id, chapter_ids) != chapter_ids:
            raise range_invalid()
        return select_rows(
            self.heatmap_rows(workspace_id, user_id), range_, drop_unknown=drop_unknown
        )


def stored_range(range_: QuestionRange) -> dict[str, Any]:
    """The range as stored on a run (`practice_runs.range`)."""
    return range_.model_dump(mode="json")
