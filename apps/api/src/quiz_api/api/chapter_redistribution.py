"""Chapter redistribution API (UX9-REDIST-B, CHREDIST-01; docs/questions.md §14).

    GET  /workspaces/{id}/chapter-redistribution/questions  editor+, active workspace: the
                                                            Heatmap's questions by chapter group
                                                            and the chapters they may move to
    POST /workspaces/{id}/chapter-redistribution/preview    editor+, active workspace: CHAPTER-MAP
                                                            recommendations, read-only
    POST /workspaces/{id}/questions/chapter-assignments     editor+, active workspace: move
                                                            questions, atomic, `Idempotency-Key`

Authorization (C01): all three are question edits (`Action.QUESTION_EDIT`, also for the two
reads: they only serve the move): viewers 403 `insufficient-role`, an archived workspace 403
`workspace-archived`, unknown/deleted/foreign workspaces 404 with one body. The workspace is the
path's; nothing in a body names one. Share sessions have no such routes (shared router).

Nothing here returns answers, explanations, rubrics or options: a 40-character stem preview,
the display number and the type only.

Assignment (C02-C04), one transaction:
  1. `Idempotency-Key` replay before any check (same user, same body -> the stored response;
     another body -> 422 `idempotency-key-reused`). Without a key nothing is replayed: a repeated
     move is refused by its now stale `expected_chapter_id` (409 `chapter-changed`).
  2. Lock order of every question write (documents, then questions): the workspace row FOR SHARE
     (authorization), the books of the target chapters and of the expected (current) chapters FOR
     SHARE in document id order in one statement (`QuestionRepository.lock_documents`), then the
     questions FOR UPDATE in id order. A correction publish locks its document FOR UPDATE and
     then remaps the questions of its chapters; taking the documents first means the two never
     wait on each other in opposite orders (no deadlock): a publish that committed first is seen
     as a changed chapter (409), one that comes later waits for this transaction and remaps the
     moved questions.
  3. Checks, all before any write (so a refused request changes nothing): a question that is not
     a live question of this workspace -> 404; not CONFIRMED -> 409 `question-not-confirmed`;
     current chapter != `expected_chapter_id` -> 409 `chapter-changed` with `question_ids`; a
     target chapter of another workspace (or unknown) -> 404; a target that is not a chapter of
     the active revision of a live book here -> 422 `chapter-invalid`.
  4. Questions already in their target (as expected) are `unchanged`; the others get the chapter,
     `chapter_source` (manual -> manual, recommendation -> auto), `chapter_set_by/at` and one
     `question_chapter_changes` row; no revision, attempt, state or run is touched. One activity
     `questions.chapters_reassigned` (counts and source only) when anything moved.
"""

from __future__ import annotations

import uuid
from collections import Counter
from typing import Annotated, Any, Literal, cast

from book_core.chapter_matching import (
    BookChapter,
    ChapterMatcher,
    NoRecommendation,
    RecommendationReason,
    recommend,
)
from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.question_overview import NO_CHAPTER_TITLE, chapter_number
from quiz_api.api.questions import (
    IdempotencyStoreDep,
    _constraint_violation,
    _with_lock_retry,
)
from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    WorkspaceAccess,
    authorize_workspace,
    get_access_repository,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import REPLAYED_HEADER, IdempotencyKey, request_hash
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.chapter_redistribution import (
    ChapterRedistributionRepository,
    ListedQuestion,
)
from quiz_api.repositories.question_overview import QuestionOverviewRepository
from quiz_api.repositories.questions import ChapterSource, QuestionRepository

router = APIRouter(tags=["questions"], responses=problem_responses(503))

NOT_FOUND = "Not found."  # the question routes' body (no existence probing)
MAX_ITEMS = 5000
STEM_PREVIEW = 40


# --- schemas ------------------------------------------------------------------------------------


class RedistributionQuestion(BaseModel):
    question_id: uuid.UUID
    chapter_id: uuid.UUID | None
    question_number: int | None
    question_type: QuestionType
    label: str = Field(description='Display label, e.g. "1장 3번" (chapter number, number).')
    stem_preview: str = Field(description=f"The stem's first {STEM_PREVIEW} characters.")
    chapter_source: ChapterSource = Field(description="`manual` rows show 직접 정함.")


class RedistributionGroup(BaseModel):
    id: uuid.UUID | None = Field(description='null = "챕터 없음" (always last).')
    number: int | None = Field(description="Chapter number for labels, if known.")
    title: str
    document_id: uuid.UUID | None
    question_count: int


class RedistributionTargetChapter(BaseModel):
    id: uuid.UUID
    title: str
    depth: int = Field(description="Outline level (1 = top level).")


class RedistributionTargetDocument(BaseModel):
    document_id: uuid.UUID
    document_title: str
    chapters: list[RedistributionTargetChapter] = Field(description="Outline order.")


class RedistributionList(BaseModel):
    items: list[RedistributionQuestion] = Field(description="Heatmap order.")
    chapters: list[RedistributionGroup] = Field(description="Groups of `items`, Heatmap order.")
    targets: list[RedistributionTargetDocument] = Field(
        description="Chapters a question may move to (live books' current revisions; \"챕터 "
        '없음" = `chapter_id: null` is always allowed).'
    )


class RedistributionPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_ids: list[uuid.UUID] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_ITEMS,
        description="The selected questions (ids that are not confirmed questions here are "
        "ignored).",
    )
    all: bool = Field(default=False, description="Every confirmed question (nothing selected).")
    include_manual: bool = Field(
        default=False, description="Also recommend for chapters a person chose (`manual`)."
    )

    @model_validator(mode="after")
    def _one_scope(self) -> RedistributionPreviewRequest:
        if (self.question_ids is not None) == self.all:
            raise ValueError("Send either `question_ids` or `all: true`.")
        return self


class RedistributionChapter(BaseModel):
    id: uuid.UUID
    title: str
    document_id: uuid.UUID | None = None


class RedistributionPreviewItem(BaseModel):
    question_id: uuid.UUID
    number_label: str
    stem_preview: str
    current_chapter: RedistributionChapter | None = Field(description='null = "챕터 없음".')
    recommended_chapter: RedistributionChapter
    reason: RecommendationReason = Field(
        description="source_in_book (출처 교재의 장) | matched (문제지 장 제목과 일치) | "
        "paper_chapter (일치하는 교재 장이 없어 문제지 자신의 최상위 장)."
    )


class RedistributionPreview(BaseModel):
    items: list[RedistributionPreviewItem] = Field(
        description="Only questions whose chapter would change."
    )
    unchanged: int = Field(description="Recommended chapter = current chapter.")
    no_recommendation: dict[NoRecommendation, int] = Field(
        description="Questions without a recommendation, by reason (non-zero only)."
    )
    skipped_manual: int = Field(description="`manual` questions not computed (include_manual).")


class ChapterAssignmentItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: uuid.UUID
    chapter_id: uuid.UUID | None = Field(description='Target; null = "챕터 없음".')
    expected_chapter_id: uuid.UUID | None = Field(
        description="The chapter the client showed (the current one); a different current "
        "chapter refuses the whole request (409 `chapter-changed`)."
    )


class ChapterAssignmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["manual", "recommendation"] = Field(
        description="manual (직접 옮기기 -> `manual`) | recommendation (applied -> `auto`)."
    )
    items: list[ChapterAssignmentItem] = Field(min_length=1, max_length=MAX_ITEMS)


class ChapterAssignmentResult(BaseModel):
    moved: int
    unchanged: int = Field(description="Already in the target chapter (as expected).")


# --- dependencies -------------------------------------------------------------------------------


def _edit_workspace(
    workspace_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    repo: Annotated[AccessRepository, Depends(get_access_repository)],
) -> WorkspaceAccess:
    return authorize_workspace(
        repo, user.id, workspace_id, Action.QUESTION_EDIT, not_found_detail=NOT_FOUND
    )


def _repo(session: Annotated[Session, Depends(get_db_session)]) -> ChapterRedistributionRepository:
    return ChapterRedistributionRepository(session)


def _questions(session: Annotated[Session, Depends(get_db_session)]) -> QuestionRepository:
    return QuestionRepository(session)


EditWorkspace = Annotated[WorkspaceAccess, Depends(_edit_workspace)]
RedistRepo = Annotated[ChapterRedistributionRepository, Depends(_repo)]
QuestionRepo = Annotated[QuestionRepository, Depends(_questions)]


# --- helpers ------------------------------------------------------------------------------------


def stem_preview(stem: str) -> str:
    """The stem's first STEM_PREVIEW characters, whitespace collapsed."""
    return " ".join(stem.split())[:STEM_PREVIEW]


def number_label(chapter_no: int | None, chapter_title: str | None, number: int | None) -> str:
    """ "1장 3번": the chapter number (else its title) and the question number."""
    parts: list[str] = []
    if chapter_no is not None:
        parts.append(f"{chapter_no}장")
    elif chapter_title is not None:
        parts.append(chapter_title)
    if number is not None:
        parts.append(f"{number}번")
    return " ".join(parts) if parts else "번호 없음"


def _chapter_numbers(session: Session, rows: list[ListedQuestion]) -> dict[uuid.UUID, int | None]:
    lineage = QuestionOverviewRepository(session).chapter_lineage(
        r.chapter_id for r in rows if r.chapter_id is not None
    )
    return {cid: chapter_number(titles) for cid, titles in lineage.items()}


def _label(row: ListedQuestion, numbers: dict[uuid.UUID, int | None]) -> str:
    no = numbers.get(row.chapter_id) if row.chapter_id is not None else None
    return number_label(no, row.chapter_title, row.question_number)


def _brief(chapter: BookChapter) -> RedistributionChapter:
    return RedistributionChapter(
        id=chapter.id, title=chapter.title, document_id=chapter.document_id
    )


# --- routes -------------------------------------------------------------------------------------


@router.get(
    "/workspaces/{workspace_id}/chapter-redistribution/questions",
    operation_id="listChapterRedistributionQuestions",
)
def list_redistribution_questions(
    access: EditWorkspace, repo: RedistRepo, session: Annotated[Session, Depends(get_db_session)]
) -> RedistributionList:
    """The workspace's confirmed questions by chapter group (Heatmap order) with how each chapter
    was decided, and the book chapters they can move to. No answers."""
    rows = repo.listed(access.workspace_id)
    numbers = _chapter_numbers(session, rows)
    groups: dict[uuid.UUID | None, RedistributionGroup] = {}
    items: list[RedistributionQuestion] = []
    for row in rows:
        group = groups.get(row.chapter_id)
        if group is None:
            group = groups[row.chapter_id] = RedistributionGroup(
                id=row.chapter_id,
                number=numbers.get(row.chapter_id) if row.chapter_id is not None else None,
                title=row.chapter_title if row.chapter_title is not None else NO_CHAPTER_TITLE,
                document_id=row.chapter_document_id,
                question_count=0,
            )
        group.question_count += 1
        items.append(
            RedistributionQuestion(
                question_id=row.question_id,
                chapter_id=row.chapter_id,
                question_number=row.question_number,
                question_type=row.question_type,
                label=_label(row, numbers),
                stem_preview=stem_preview(row.stem_head),
                chapter_source=row.chapter_source,
            )
        )
    targets: dict[uuid.UUID, RedistributionTargetDocument] = {}
    for chapter in [
        *repo.book_chapters(access.workspace_id),
        *repo.paper_chapters(access.workspace_id),
    ]:
        doc = targets.get(chapter.document_id)
        if doc is None:
            doc = targets[chapter.document_id] = RedistributionTargetDocument(
                document_id=chapter.document_id, document_title=chapter.document_title, chapters=[]
            )
        doc.chapters.append(
            RedistributionTargetChapter(id=chapter.id, title=chapter.title, depth=chapter.level)
        )
    return RedistributionList(
        items=items, chapters=list(groups.values()), targets=list(targets.values())
    )


@router.post(
    "/workspaces/{workspace_id}/chapter-redistribution/preview",
    operation_id="previewChapterRedistribution",
)
def preview_redistribution(
    access: EditWorkspace,
    body: RedistributionPreviewRequest,
    repo: RedistRepo,
    session: Annotated[Session, Depends(get_db_session)],
) -> RedistributionPreview:
    """Recommend chapters again (CHAPTER-MAP on each question's first source block) and list the
    questions whose chapter would change. Read-only: computed on every request, nothing stored."""
    rows = repo.listed(access.workspace_id, body.question_ids)
    skipped = 0
    scoped: list[ListedQuestion] = []
    for row in rows:
        if row.chapter_source == "manual" and not body.include_manual:
            skipped += 1
        else:
            scoped.append(row)
    starts = repo.start_blocks(access.workspace_id, [r.question_id for r in scoped])
    matcher = ChapterMatcher(repo.book_chapters(access.workspace_id))
    numbers = _chapter_numbers(session, scoped)
    items: list[RedistributionPreviewItem] = []
    unchanged = 0
    missing: Counter[NoRecommendation] = Counter()
    for row in scoped:
        found = recommend(starts.get(row.question_id), matcher)
        if found.chapter is None:
            missing[cast(NoRecommendation, found.reason)] += 1
            continue
        if found.chapter.id == row.chapter_id:
            unchanged += 1
            continue
        items.append(
            RedistributionPreviewItem(
                question_id=row.question_id,
                number_label=_label(row, numbers),
                stem_preview=stem_preview(row.stem_head),
                current_chapter=RedistributionChapter(
                    id=row.chapter_id,
                    title=row.chapter_title or "",
                    document_id=row.chapter_document_id,
                )
                if row.chapter_id is not None
                else None,
                recommended_chapter=_brief(found.chapter),
                reason=cast(RecommendationReason, found.reason),
            )
        )
    return RedistributionPreview(
        items=items,
        unchanged=unchanged,
        no_recommendation=dict(missing),
        skipped_manual=skipped,
    )


def _scope(workspace_id: uuid.UUID) -> str:
    return f"POST /workspaces/{workspace_id}/questions/chapter-assignments"


@router.post(
    "/workspaces/{workspace_id}/questions/chapter-assignments",
    operation_id="assignQuestionChapters",
    response_model=ChapterAssignmentResult,
    responses=problem_responses(409),
)
def assign_question_chapters(
    access: EditWorkspace,
    body: ChapterAssignmentRequest,
    repo: RedistRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Move questions to chapters in one transaction (all or nothing). Each item carries the
    chapter the client showed; any difference refuses the whole request. Moving never creates a
    question revision and keeps attempts and study state."""
    workspace_id, actor_id = access.workspace_id, access.user_id
    scope, body_hash = _scope(workspace_id), request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(actor_id, scope, idempotency_key)
        stored = idempotency.find(actor_id, scope, idempotency_key)
        if stored is not None:
            if stored.request_hash != body_hash:
                raise ProblemException(
                    422,
                    ProblemType.IDEMPOTENCY_KEY_REUSED,
                    detail="This Idempotency-Key was already used with a different request body.",
                )
            return JSONResponse(
                stored.body, status_code=stored.status, headers={REPLAYED_HEADER: "true"}
            )

    ids = [i.question_id for i in body.items]
    if len(set(ids)) != len(ids):
        raise RequestValidationError(
            [
                {
                    "loc": ("body", "items"),
                    "msg": "Each question may appear once in the request.",
                    "type": "value_error",
                }
            ]
        )

    def attempt() -> ChapterAssignmentResult:
        targets = {i.chapter_id for i in body.items if i.chapter_id is not None}
        expected = {i.expected_chapter_id for i in body.items}
        questions.lock_documents(workspace_id, chapter_ids=[*targets, *expected])
        locked = repo.lock_questions(workspace_id, ids)
        if len(locked) != len(ids):
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        not_confirmed = [q for q in ids if locked[q].publication_status != "CONFIRMED"]
        if not_confirmed:
            raise ProblemException(
                409,
                ProblemType.QUESTION_NOT_CONFIRMED,
                detail="Only confirmed questions can be moved. Reload the list.",
            )
        changed = [
            str(i.question_id)
            for i in body.items
            if locked[i.question_id].chapter_id != i.expected_chapter_id
        ]
        if changed:
            raise ProblemException(
                409,
                ProblemType.CHAPTER_CHANGED,
                detail="The chapter of some questions changed in the meantime. Nothing was moved; "
                "reload the list.",
                question_ids=changed,
            )
        found = repo.target_chapters(workspace_id, targets)
        if len(found) != len(targets):
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        if not all(t.valid for t in found.values()):
            raise ProblemException(
                422,
                ProblemType.CHAPTER_INVALID,
                detail="Questions can move only to a chapter of a book's current revision or to "
                "no chapter.",
            )
        moves = [
            (i.question_id, i.expected_chapter_id, i.chapter_id)
            for i in body.items
            if i.chapter_id != i.expected_chapter_id
        ]
        questions.set_chapter(
            workspace_id,
            moves,
            chapter_source="manual" if body.source == "manual" else "auto",
            change_source=body.source,
            actor_id=actor_id,
        )
        result = ChapterAssignmentResult(moved=len(moves), unchanged=len(body.items) - len(moves))
        if moves:
            metadata: dict[str, Any] = {
                "source": body.source,
                "moved": result.moved,
                "unchanged": result.unchanged,
            }
            moved_to = {to for _, _, to in moves}
            if len(moved_to) == 1:
                only = next(iter(moved_to))
                metadata["chapter_id"] = str(only) if only is not None else None
            repo.record_reassigned(workspace_id, actor_id, metadata)
        return result

    try:
        result = _with_lock_retry(questions, attempt)
        if idempotency_key is not None:
            idempotency.save(
                actor_id, scope, idempotency_key, body_hash, 200, result.model_dump(mode="json")
            )
        questions.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(questions) from None
    return result
