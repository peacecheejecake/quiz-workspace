"""Questions overview API (M5.1, QOV-01; docs/questions.md §2-§3, §7, architecture.md §6).

    GET /workspaces/{id}/questions/overview   any member (viewer included, archived workspace
                                              included); the caller's heatmap

Response (tests/e2e/fixtures/questions.ts A8): `{counts, chapters, items}`.

* `items`: one per CONFIRMED, non-deleted question (drafts, archived and deleted questions never
  appear; practice sessions/option shuffles never add items), in heatmap order (see
  quiz_api.repositories.question_overview). Each carries the CALLER's study state
  (`question_user_states`): `status` from `derive_dot_status` (retry > incorrect > correct >
  viewed > unseen), `is_favorite`, `needs_retry`, `last_graded_result`, and
  `is_pending_grading` (the caller's latest submitted practice session awaits grading; the status
  then stays `viewed` or the previous graded result, questions.md §2.1 "채점 대기"). `preview` is
  the first 1-3 non-blank lines of the stem (<= PREVIEW_CHARS). Never answers, explanations or
  rubrics.
* `chapters`: the groups present in `items`, in order: `{id, number, title, document_id,
  question_count}`. The questions without a chapter form one last group with `id: null` and
  title "챕터 없음". `number` (for dot labels like `3장 12번 문제`, M5.3 `chapterNumber`) is the
  leading chapter number in the outline path's titles, top-level ancestor first ("Chapter 3 …",
  "제3장", "3장 …", "3. …", "3.2 …" -> 3); null when no title carries one (the UI then labels with
  the title). It is never an ordinal: a preface would shift every number.
* `counts`: `{total, unseen, viewed, incorrect, correct, retry, favorite}`; statuses mutually
  exclusive (`summarize`), `favorite` overlapping them.

Filters (query string, so the screen can mirror them in its URL, questions.md §7):
  chapter=<chapter id>|none     one chapter group (`none` = the "챕터 없음" group)
  type=MCQ|SHORT_ANSWER|ESSAY
  q=<text>                      case-insensitive stem substring (<= 200 chars)
  status=<status> (repeatable)  unseen|viewed|incorrect|correct|retry
  favorite=true|false
  retry=true|false              the `needs_retry` flag (same set as status=retry)

Counts scope (decision): `counts` are computed over the questions matching the *scope* filters
(chapter, type, q) and ignore the *state* filters (status, favorite, retry). The summary chips
double as the status filter, so selecting a chip must not zero the others; "전체" is then the
number of questions in the current chapter/type/search scope. The number shown in the current
filter is `len(items)`.

Side effects: none. Reading the overview (or a question) never records a view; only opening a
practice session does (M5.2).
"""

from __future__ import annotations

import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    WorkspaceAccess,
    authorize_workspace,
    get_access_repository,
)
from quiz_api.db import get_db_session
from quiz_api.errors import problem_responses
from quiz_api.question_rules import QuestionType, storable
from quiz_api.question_status import (
    DotStatus,
    LastGradedResult,
    StudyState,
    derive_dot_status,
    summarize,
)
from quiz_api.repositories.question_overview import (
    OverviewFilter,
    OverviewRow,
    QuestionOverviewRepository,
)

router = APIRouter(tags=["questions"], responses=problem_responses(503))

NOT_FOUND = "Not found."  # same body as the question routes (no existence probing)
NO_CHAPTER_TITLE = "챕터 없음"
PREVIEW_LINES = 3
PREVIEW_CHARS = 240
MAX_SEARCH = 200

# "Chapter 3", "CHAPTER 3:", "Ch. 3", "제3장", "3장", "3. Intro", "3 Intro", "3.2 Intro", "3)".
_CHAPTER_NUMBER = re.compile(
    r"^\s*(?:chapter|chap\.|ch\.|제)?\s*(\d{1,4})(?=\s*장|[.):\-\u2013\u2014\s]|$)", re.IGNORECASE
)


class OverviewCounts(BaseModel):
    total: int
    unseen: int
    viewed: int
    incorrect: int
    correct: int
    retry: int
    favorite: int = Field(description="Overlaps the status counts.")


class OverviewChapter(BaseModel):
    id: uuid.UUID | None = Field(description="null = the questions without a chapter.")
    number: int | None = Field(description="Chapter number for `3장 12번` labels, if known.")
    title: str
    document_id: uuid.UUID | None
    question_count: int = Field(description="Items of this group in `items`.")


class OverviewItem(BaseModel):
    question_id: uuid.UUID
    chapter_id: uuid.UUID | None
    question_number: int | None
    question_type: QuestionType
    status: DotStatus
    is_favorite: bool
    needs_retry: bool
    last_graded_result: LastGradedResult | None
    is_pending_grading: bool = Field(description="Latest submission awaits grading (채점 대기).")
    preview: str = Field(description="First 1-3 lines of the stem; never the answer.")


class QuestionOverview(BaseModel):
    counts: OverviewCounts = Field(
        description="Over the chapter/type/q scope; status/favorite/retry filters ignored."
    )
    chapters: list[OverviewChapter]
    items: list[OverviewItem]


def chapter_number(path_titles: list[str]) -> int | None:
    """Leading chapter number of an outline path (top-level ancestor first), or None."""
    for title in path_titles:
        m = _CHAPTER_NUMBER.match(title)
        if m:
            return int(m.group(1))
    return None


def preview_text(stem: str) -> str:
    lines = [line.strip() for line in stem.splitlines() if line.strip()][:PREVIEW_LINES]
    text = "\n".join(lines)
    if len(text) > PREVIEW_CHARS:
        text = text[: PREVIEW_CHARS - 1].rstrip() + "…"
    return text


def _invalid(field: str, msg: str) -> RequestValidationError:
    return RequestValidationError([{"loc": ("query", field), "msg": msg, "type": "value_error"}])


def _scope(
    chapter: str | None, question_type: QuestionType | None, q: str | None
) -> OverviewFilter:
    chapter_id: uuid.UUID | None = None
    no_chapter = False
    if chapter is not None:
        if chapter == "none":
            no_chapter = True
        else:
            try:
                chapter_id = uuid.UUID(chapter)
            except ValueError:
                raise _invalid("chapter", "Use a chapter id or `none`.") from None
    if q is not None and not storable(q):
        raise _invalid("q", "Invalid search text.")
    return OverviewFilter(
        chapter_id=chapter_id,
        no_chapter=no_chapter,
        question_type=question_type,
        text=q.strip() if q and q.strip() else None,
    )


def get_overview_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionOverviewRepository:
    return QuestionOverviewRepository(session)


def _read_workspace(
    workspace_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    repo: Annotated[AccessRepository, Depends(get_access_repository)],
) -> WorkspaceAccess:
    return authorize_workspace(repo, user.id, workspace_id, Action.READ, not_found_detail=NOT_FOUND)


def _item(row: OverviewRow) -> OverviewItem:
    status = derive_dot_status(
        StudyState(
            first_viewed_at=row.first_viewed_at,
            last_graded_result=row.last_graded_result,
            needs_retry=row.needs_retry,
            is_favorite=row.is_favorite,
        )
    )
    return OverviewItem(
        question_id=row.question_id,
        chapter_id=row.chapter_id,
        question_number=row.question_number,
        question_type=row.question_type,
        status=status,
        is_favorite=row.is_favorite,
        needs_retry=row.needs_retry,
        last_graded_result=row.last_graded_result,
        is_pending_grading=row.is_pending_grading,
        preview=preview_text(row.stem_head),
    )


@router.get("/workspaces/{workspace_id}/questions/overview", operation_id="getQuestionOverview")
def get_question_overview(
    access: Annotated[WorkspaceAccess, Depends(_read_workspace)],
    repo: Annotated[QuestionOverviewRepository, Depends(get_overview_repository)],
    chapter: Annotated[
        str | None,
        Query(max_length=36, description="A chapter id, or `none` for questions without one."),
    ] = None,
    question_type: Annotated[QuestionType | None, Query(alias="type")] = None,
    q: Annotated[
        str | None, Query(max_length=MAX_SEARCH, description="Case-insensitive stem search.")
    ] = None,
    status: Annotated[
        list[DotStatus] | None, Query(description="Repeatable; keeps these statuses.")
    ] = None,
    favorite: Annotated[bool | None, Query(description="Keep (non-)favorites only.")] = None,
    retry: Annotated[
        bool | None, Query(description="Keep questions (not) marked for retry.")
    ] = None,
) -> QuestionOverview:
    """The caller's question heatmap: CONFIRMED questions with their study status, grouped by
    chapter, plus the status counts. Read-only: never records a view."""
    rows = repo.rows(access.workspace_id, access.user_id, _scope(chapter, question_type, q))
    scope = [_item(r) for r in rows]
    counts = summarize((i.status, i.is_favorite) for i in scope)

    wanted = set(status) if status else None
    selected = [
        (row, item)
        for row, item in zip(rows, scope, strict=True)
        if (wanted is None or item.status in wanted)
        and (favorite is None or item.is_favorite == favorite)
        and (retry is None or item.needs_retry == retry)
    ]

    lineage = repo.chapter_lineage(r.chapter_id for r, _ in selected if r.chapter_id is not None)
    groups: dict[uuid.UUID | None, OverviewChapter] = {}
    for row, _ in selected:
        group = groups.get(row.chapter_id)
        if group is None:
            group = groups[row.chapter_id] = OverviewChapter(
                id=row.chapter_id,
                number=chapter_number(lineage.get(row.chapter_id, []))
                if row.chapter_id is not None
                else None,
                title=row.chapter_title if row.chapter_title is not None else NO_CHAPTER_TITLE,
                document_id=row.chapter_document_id,
                question_count=0,
            )
        group.question_count += 1

    return QuestionOverview(
        counts=OverviewCounts(**counts),
        chapters=list(groups.values()),
        items=[item for _, item in selected],
    )
