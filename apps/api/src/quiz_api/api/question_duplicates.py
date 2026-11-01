"""Duplicate questions API (UX7-DEDUP; docs/questions.md §10, QOV-01-AC16/AC17).

    GET  /workspaces/{id}/question-duplicates        editor+; groups of identical CONFIRMED
                                                     questions (quiz_api.question_fingerprint)
    POST /workspaces/{id}/question-duplicates/merge  editor+; per group keep one question, archive
                                                     the others and link them to it

Authorization: both routes are question edits (`Action.QUESTION_EDIT`): viewers get 403
`insufficient-role`, an archived workspace 403 `workspace-archived` (the repository's rule for
every write; the scan only serves the merge), unknown/foreign workspaces 404. The scan never
returns answers, explanations or rubrics: it shows what makes questions the same (stem and option
texts) plus `answers_differ`.

Merge (one transaction): every named question is locked FOR UPDATE in id order, then
  * any id that is not a live question of this workspace -> 404 for the whole request;
  * an id named twice anywhere in the request, or a keep among its own duplicates -> 422;
  * a keep that is not CONFIRMED -> 409 `question-not-confirmed`;
  * a duplicate whose fingerprint (recomputed on the server) differs from its keep's -> 409
    `not-duplicates`;
  * a duplicate that is CONFIRMED is archived and linked to the keep (`question.status_changed`
    and `question.merged` activities); one already ARCHIVED and linked to the same keep is left as
    it is (idempotent retry, `already_merged_question_ids`); any other ARCHIVED one -> 409
    `question-not-confirmed`.
A duplicate that was itself the keep of earlier merges hands its links to the new keep (ended
`repointed`, re-inserted), so links never chain. Attempts and study-state rows are not touched:
the kept question's state is read through the `question_merged_user_states` view.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
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
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.question_rules import QuestionType
from quiz_api.repositories.question_duplicates import CandidateRecord, QuestionDuplicateRepository

router = APIRouter(tags=["questions"], responses=problem_responses(503))

NOT_FOUND = "Not found."  # the question routes' body (no existence probing)
MAX_GROUPS = 100
MAX_DUPLICATES = 50


class DuplicateOption(BaseModel):
    id: str
    text: str


class DuplicateQuestion(BaseModel):
    question_id: uuid.UUID
    question_number: int | None
    question_type: QuestionType
    chapter_id: uuid.UUID | None
    chapter_title: str | None
    created_at: datetime
    stem: str
    options: list[DuplicateOption] = Field(description="Authored order; no answer marks.")


class DuplicateGroup(BaseModel):
    fingerprint: str
    suggested_keep_question_id: uuid.UUID = Field(
        description="The oldest confirmed question of the group (registration order)."
    )
    answers_differ: bool = Field(
        description="The questions' answers (correct option texts / accepted answers) differ."
    )
    questions: list[DuplicateQuestion] = Field(description="Registration order, oldest first.")


class DuplicateScan(BaseModel):
    groups: list[DuplicateGroup] = Field(description="Heatmap order of each group's first member.")
    question_count: int = Field(description="Confirmed questions scanned.")


class MergeGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keep_question_id: uuid.UUID
    duplicate_question_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_DUPLICATES)


class MergeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groups: list[MergeGroup] = Field(min_length=1, max_length=MAX_GROUPS)


class MergedGroup(BaseModel):
    keep_question_id: uuid.UUID
    archived_question_ids: list[uuid.UUID] = Field(description="Archived and merged now.")
    already_merged_question_ids: list[uuid.UUID] = Field(
        description="Already archived and merged into this question (left as they were)."
    )


class MergeResult(BaseModel):
    groups: list[MergedGroup]


def get_duplicate_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionDuplicateRepository:
    return QuestionDuplicateRepository(session)


DuplicateRepo = Annotated[QuestionDuplicateRepository, Depends(get_duplicate_repository)]


def _edit_workspace(
    workspace_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    repo: Annotated[AccessRepository, Depends(get_access_repository)],
) -> WorkspaceAccess:
    return authorize_workspace(
        repo, user.id, workspace_id, Action.QUESTION_EDIT, not_found_detail=NOT_FOUND
    )


EditWorkspace = Annotated[WorkspaceAccess, Depends(_edit_workspace)]


def _question_out(q: CandidateRecord) -> DuplicateQuestion:
    return DuplicateQuestion(
        question_id=q.id,
        question_number=q.question_number,
        question_type=q.question_type,
        chapter_id=q.chapter_id,
        chapter_title=q.chapter_title,
        created_at=q.created_at,
        stem=q.stem,
        options=[DuplicateOption(id=o["id"], text=o["text"]) for o in q.options],
    )


def duplicate_groups(candidates: list[CandidateRecord]) -> list[list[CandidateRecord]]:
    """Groups of 2+ candidates with the same fingerprint: in the order of each group's first
    candidate (the input order), members oldest first."""
    by_key: dict[str, list[CandidateRecord]] = {}
    for c in candidates:
        by_key.setdefault(c.fingerprint, []).append(c)
    return [
        sorted(members, key=lambda q: (q.created_at, q.id))
        for members in by_key.values()
        if len(members) > 1
    ]


@router.get(
    "/workspaces/{workspace_id}/question-duplicates",
    operation_id="listQuestionDuplicates",
)
def list_question_duplicates(access: EditWorkspace, repo: DuplicateRepo) -> DuplicateScan:
    """Groups of identical CONFIRMED questions (same normalised stem and options, any option
    order). A read: scanning again gives the same groups until questions change."""
    candidates = repo.confirmed(access.workspace_id)
    groups = []
    for members in duplicate_groups(candidates):
        answers = {m.answer_key for m in members if m.answer_key is not None}
        groups.append(
            DuplicateGroup(
                fingerprint=members[0].fingerprint,
                suggested_keep_question_id=members[0].id,
                answers_differ=len(answers) > 1,
                questions=[_question_out(m) for m in members],
            )
        )
    return DuplicateScan(groups=groups, question_count=len(candidates))


def _invalid(msg: str) -> RequestValidationError:
    return RequestValidationError([{"loc": ("body", "groups"), "msg": msg, "type": "value_error"}])


def _not_confirmed(question_id: uuid.UUID) -> ProblemException:
    return ProblemException(
        409,
        ProblemType.QUESTION_NOT_CONFIRMED,
        detail=f"Question {question_id} is not a confirmed question any more. Scan again.",
    )


@router.post(
    "/workspaces/{workspace_id}/question-duplicates/merge",
    operation_id="mergeQuestionDuplicates",
    responses=problem_responses(409),
)
def merge_question_duplicates(
    access: EditWorkspace, body: MergeRequest, repo: DuplicateRepo
) -> MergeResult:
    """Keep one question per group, archive the others and merge their study history into it
    (the kept question's state, favorite and retry marks include theirs; attempts unchanged).
    Repeating a merge changes nothing. Unarchiving a duplicate later unmerges it."""
    named: list[uuid.UUID] = []
    for group in body.groups:
        named += [group.keep_question_id, *group.duplicate_question_ids]
    if len(set(named)) != len(named):
        raise _invalid("Each question may appear once in the request.")

    workspace_id, actor_id = access.workspace_id, access.user_id
    found = repo.lock(workspace_id, named)
    if len(found) != len(named):
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    links = repo.active_links(workspace_id, duplicates=named, kept=named)
    kept_of = {link.duplicate_question_id: link.kept_question_id for link in links}

    plan: list[tuple[CandidateRecord, list[CandidateRecord], list[uuid.UUID]]] = []
    for group in body.groups:
        keep = found[group.keep_question_id]
        if keep.publication_status != "CONFIRMED":
            raise _not_confirmed(keep.id)
        to_archive: list[CandidateRecord] = []
        already: list[uuid.UUID] = []
        for dup_id in group.duplicate_question_ids:
            dup = found[dup_id]
            if dup.fingerprint != keep.fingerprint:
                raise ProblemException(
                    409,
                    ProblemType.NOT_DUPLICATES,
                    detail="These questions are not the same question any more. Scan again.",
                )
            if dup.publication_status == "CONFIRMED":
                to_archive.append(dup)
            elif dup.publication_status == "ARCHIVED" and kept_of.get(dup.id) == keep.id:
                already.append(dup.id)
            else:
                raise _not_confirmed(dup.id)
        plan.append((keep, to_archive, already))

    try:
        for keep, to_archive, _ in plan:
            for dup in to_archive:
                # The duplicate's own duplicates move to the new keep (no chains).
                children = [link for link in links if link.kept_question_id == dup.id]
                repo.end_links([link.id for link in children], actor_id, "repointed")
                for link in children:
                    repo.link(workspace_id, link.duplicate_question_id, keep.id, actor_id)
                repo.archive(dup.id)
                repo.link(workspace_id, dup.id, keep.id, actor_id)
                metadata: dict[str, Any] = {"version": dup.revision_version}
                repo.record_activity(
                    workspace_id,
                    actor_id,
                    "question.status_changed",
                    dup.id,
                    {"from": "CONFIRMED", "to": "ARCHIVED", **metadata},
                )
                repo.record_activity(
                    workspace_id,
                    actor_id,
                    "question.merged",
                    dup.id,
                    {"into_question_id": str(keep.id), **metadata},
                )
        repo.commit()
    except IntegrityError:
        repo.rollback()
        raise ProblemException(
            409,
            ProblemType.QUESTION_NOT_CONFIRMED,
            detail="The questions changed while merging. Scan again.",
        ) from None
    return MergeResult(
        groups=[
            MergedGroup(
                keep_question_id=keep.id,
                archived_question_ids=sorted(d.id for d in to_archive),
                already_merged_question_ids=sorted(already),
            )
            for keep, to_archive, already in plan
        ]
    )
