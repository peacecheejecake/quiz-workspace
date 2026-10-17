"""Workspace history (M7.1, HISTORY-01; docs/screens/history-jobs.md, architecture.md §5-§6).

    GET /workspaces/{id}/activities  any member; who changed what, when, and which revision
    GET /workspaces/{id}/jobs        any member; async jobs with their target and retryability
    GET /workspaces/{id}/attempts    the CALLER's practice attempts in the workspace only

All three are newest first with an opaque keyset cursor (`next_cursor` → `?cursor=`). Unknown,
foreign and soft-deleted workspaces answer the same 404 (`require_workspace_access`); archived
workspaces stay readable. Nothing here returns block text, question stems, answers or
explanations: activities carry ids, labels (document title, "N번 문제") and revisions; attempts
are the caller's own submissions. `question.study_state_changed` events (personal favorites and
retry flags) are listed for their own actor only.

`retryable` on a job means the caller can start it again from History: a failed or cancelled
reindex of a document's current correction draft (`POST /documents/{id}/publish`) or the current
job of a failed import run (`POST /question-imports/{id}/retry`), for owners and editors of an
active workspace. A retry is always a new job; the failed one stays in the list unchanged.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import AwareDatetime, BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from quiz_api.api.jobs import Job, _job
from quiz_api.api.practice import Attempt, SubmittedAnswer
from quiz_api.authz import Action, WorkspaceAccess, require_workspace_access
from quiz_api.authz.permissions import policy_for
from quiz_api.db import get_db_session
from quiz_api.repositories.history import (
    ActivityRecord,
    Cursor,
    HistoryRepository,
    WorkspaceAttemptRecord,
    WorkspaceJobRecord,
)

router = APIRouter(tags=["history"])

DEFAULT_PAGE = 50
MAX_PAGE = 100
MAX_CURSOR = 200

JobTargetType = Literal["document", "question_import", "question_generation"]


class ActivityActor(BaseModel):
    id: uuid.UUID
    display_name: str | None


class ActivityRevision(BaseModel):
    id: uuid.UUID | None = Field(description="Document revision id or question revision id.")
    number: int | None = Field(
        description="Document `revision_number` or question `version` the event produced."
    )


class Activity(BaseModel):
    id: uuid.UUID
    event_type: str = Field(description="e.g. `document.block_corrected`, `question.updated`.")
    target_type: str = Field(description="e.g. `document`, `question`, `workspace`.")
    target_id: uuid.UUID | None
    target_label: str | None = Field(
        description="Document title, workspace name or a question label (`N번 문제`); never "
        "book or question text."
    )
    actor: ActivityActor | None = Field(description="null once the user was deleted.")
    created_at: datetime
    revision: ActivityRevision | None = Field(
        description="The revision a document correction/publish/restore touched or the "
        "question version a change produced; null for events without one."
    )


class ActivityPage(BaseModel):
    items: list[Activity]
    next_cursor: str | None = Field(description="Pass as `cursor` for older events.")


class WorkspaceJob(Job):
    target_type: JobTargetType | None = Field(description="What the job works on.")
    target_id: uuid.UUID | None
    target_label: str | None = Field(description="Document or question paper title.")
    retryable: bool = Field(
        description="The caller can start this job again: `document` → POST "
        "/documents/{target_id}/publish, `question_import` → POST "
        "/question-imports/{target_id}/retry. The retry is a new job."
    )


class WorkspaceJobPage(BaseModel):
    items: list[WorkspaceJob]
    next_cursor: str | None = Field(description="Pass as `cursor` for older jobs.")


class WorkspaceAttempt(Attempt):
    question_id: uuid.UUID
    question_number: int | None
    question_type: str


class WorkspaceAttemptPage(BaseModel):
    items: list[WorkspaceAttempt]
    next_cursor: str | None = Field(description="Pass as `cursor` for older attempts.")


# --- cursor ---------------------------------------------------------------------------------------

_CURSOR = TypeAdapter(tuple[AwareDatetime, uuid.UUID])


def _invalid_cursor() -> RequestValidationError:
    return RequestValidationError(
        [{"loc": ("query", "cursor"), "msg": "Invalid cursor.", "type": "value_error"}]
    )


def encode_cursor(cursor: Cursor) -> str:
    raw = json.dumps([cursor.at.isoformat(), str(cursor.id)], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(value: str) -> Cursor:
    """Opaque cursor -> keyset position; anything `encode_cursor` did not produce is a 422."""
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii") + b"=" * (-len(value) % 4))
        at, item_id = _CURSOR.validate_json(raw)
    except (binascii.Error, UnicodeError, ValueError, ValidationError):
        raise _invalid_cursor() from None
    return Cursor(at, item_id)


# --- dependencies ---------------------------------------------------------------------------------


def get_history_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> HistoryRepository:
    return HistoryRepository(session)


HistoryRepo = Annotated[HistoryRepository, Depends(get_history_repository)]
ReadWorkspace = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.READ))]
Limit = Annotated[int, Query(ge=1, le=MAX_PAGE)]
CursorParam = Annotated[str | None, Query(max_length=MAX_CURSOR)]

# Which edit permission starts each job target again.
_RETRY_ACTION = {"document": Action.DOCUMENT_EDIT, "question_import": Action.QUESTION_EDIT}


def can_retry(access: WorkspaceAccess, target_type: str) -> bool:
    action = _RETRY_ACTION.get(target_type)
    if action is None:
        return False
    policy = policy_for(action)
    return policy.allows(access.role) and (
        access.status != "archived" or policy.allowed_when_archived
    )


# --- mapping --------------------------------------------------------------------------------------


def _activity(a: ActivityRecord) -> Activity:
    return Activity(
        id=a.id,
        event_type=a.event_type,
        target_type=a.target_type,
        target_id=a.target_id,
        target_label=a.target_label,
        actor=ActivityActor(id=a.actor.id, display_name=a.actor.display_name) if a.actor else None,
        created_at=a.created_at,
        revision=ActivityRevision(id=a.revision.id, number=a.revision.number)
        if a.revision
        else None,
    )


def _workspace_job(record: WorkspaceJobRecord) -> WorkspaceJob:
    t = record.target
    return WorkspaceJob(
        **_job(record.job).model_dump(),
        target_type=t.target_type,  # type: ignore[arg-type]
        target_id=t.target_id,
        target_label=t.target_label,
        retryable=t.retryable,
    )


def _workspace_attempt(a: WorkspaceAttemptRecord) -> WorkspaceAttempt:
    return WorkspaceAttempt(
        id=a.id,
        question_id=a.question_id,
        question_number=a.question_number,
        question_type=a.question_type,
        question_revision_id=a.question_revision_id,
        revision_version=a.revision_version,
        practice_session_id=a.practice_session_id,
        displayed_option_ids=a.displayed_option_ids,
        submitted_answer=SubmittedAnswer.model_validate(a.submitted_answer),
        result=a.result,
        grading_method=a.grading_method,  # type: ignore[arg-type]
        grades_attempt_id=a.grades_attempt_id,
        submitted_at=a.submitted_at,
        graded_at=a.graded_at,
    )


# --- routes ---------------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/activities", operation_id="listWorkspaceActivities")
def list_activities(
    access: ReadWorkspace,
    repo: HistoryRepo,
    limit: Limit = DEFAULT_PAGE,
    cursor: CursorParam = None,
) -> ActivityPage:
    """Change history of the workspace (documents, questions, imports, sharing), newest first.
    Personal study-state events are included for the caller's own changes only."""
    after = decode_cursor(cursor) if cursor else None
    items, next_cursor = repo.activities(
        access.workspace_id, access.user_id, limit=limit, after=after
    )
    return ActivityPage(
        items=[_activity(a) for a in items],
        next_cursor=encode_cursor(next_cursor) if next_cursor else None,
    )


@router.get("/workspaces/{workspace_id}/jobs", operation_id="listWorkspaceJobs")
def list_jobs(
    access: ReadWorkspace,
    repo: HistoryRepo,
    limit: Limit = DEFAULT_PAGE,
    cursor: CursorParam = None,
) -> WorkspaceJobPage:
    """Async jobs of the workspace (parse/reindex, import, generation), newest first, with what
    each works on and whether the caller can retry it."""
    after = decode_cursor(cursor) if cursor else None
    items, next_cursor = repo.jobs(
        access.workspace_id,
        can_retry=lambda target_type: can_retry(access, target_type),
        limit=limit,
        after=after,
    )
    return WorkspaceJobPage(
        items=[_workspace_job(j) for j in items],
        next_cursor=encode_cursor(next_cursor) if next_cursor else None,
    )


@router.get("/workspaces/{workspace_id}/attempts", operation_id="listMyWorkspaceAttempts")
def list_my_attempts(
    access: ReadWorkspace,
    repo: HistoryRepo,
    request: Request,
    limit: Limit = DEFAULT_PAGE,
    cursor: CursorParam = None,
) -> WorkspaceAttemptPage:
    """The caller's own practice attempts in the workspace, newest first. Other users' attempts
    are never listed; a `user_id` parameter is refused (422)."""
    if "user_id" in request.query_params:
        raise RequestValidationError(
            [
                {
                    "loc": ("query", "user_id"),
                    "msg": "Only your own attempts can be listed.",
                    "type": "extra_forbidden",
                }
            ]
        )
    after = decode_cursor(cursor) if cursor else None
    items, next_cursor = repo.attempts(
        access.workspace_id, access.user_id, limit=limit, after=after
    )
    return WorkspaceAttemptPage(
        items=[_workspace_attempt(a) for a in items],
        next_cursor=encode_cursor(next_cursor) if next_cursor else None,
    )
