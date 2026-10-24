"""Batch variant generation API (QGEN-MULTI; docs/questions.md §5 "묶음 변형 출제").

    POST /workspaces/{id}/question-generation-batches             editor+; `Idempotency-Key`
         {selection: {mode: "selected", question_ids} | {mode: "random", count, chapter?,
          question_type?, statuses?, favorite?, seed?}, variation_types, candidate_count?,
          difficulty?} -> 202 GenerationBatch: one ordinary generation run (+ its
          `question.generate` job) per source, created in one transaction
    GET  /workspaces/{id}/question-generation-batches/{batch_id}  any member

A batch has no table: its runs carry `batch_id`, `batch_mode`, `batch_position`,
`batch_requested` (and `batch_seed`) in `params`. Drafts, review, approval and publishing are the
single-run ones (quiz_api.api.question_generations): nothing is registered before a human approves
a draft of the source's run.

Sources. `selected`: 1..MAX_BATCH_SOURCES distinct ids, every one a live question of the path's
workspace (another workspace's, deleted or unknown ids: the same 404 as the single-run route; the
whole request is refused, no partial batch) and CONFIRMED (else 409 `question-not-confirmed`).
`random`: the server picks `min(count, candidates)` sources with `random.Random(seed).sample` from
the workspace's CONFIRMED questions matching the filters, in heatmap order (the caller's study
state, as the overview derives it); no candidate -> 409 `no-matching-questions`. Without `seed`
the server draws one and returns it.

Limits (cost guard): sources <= MAX_BATCH_SOURCES; sources x variation types x candidate_count <=
MAX_BATCH_CANDIDATES (422, checked against `count` for a random pick); batch starts of a workspace
are serialised by an advisory lock, and more than MAX_ACTIVE_RUNS queued/running runs in the
workspace (with the new ones) -> 409 `generation-busy`; per-user starts per minute
(QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE) -> 429 + Retry-After. A retry with the same
`Idempotency-Key` returns the stored batch before any limit is checked and re-hands its queued
jobs to the broker.
"""

from __future__ import annotations

import random
import secrets
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from quiz_api.api.question_generations import (
    NOT_FOUND,
    DraftRepo,
    GenerationRepo,
    GenerationRun,
    IdempotencyStoreDep,
    PublisherDep,
    VariationName,
    _run_out,
)
from quiz_api.api.question_imports import _publish_job
from quiz_api.api.question_overview import preview_text
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
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.question_rules import QuestionType
from quiz_api.question_status import DotStatus, StudyState, derive_dot_status
from quiz_api.rate_limit import TokenBucketLimiter, retry_after_header
from quiz_api.repositories.question_generations import (
    GenerationRunRecord,
    LiveQuestionRecord,
    QuestionGenerationRepository,
)
from quiz_api.repositories.question_overview import OverviewFilter, QuestionOverviewRepository

router = APIRouter(tags=["question-generations"], responses=problem_responses(503))

MAX_BATCH_SOURCES = 20
MAX_BATCH_CANDIDATES = 60
MAX_ACTIVE_RUNS = 40
MAX_SEED = 2**31 - 1
BatchMode = Literal["selected", "random"]


# --- schemas ------------------------------------------------------------------------------------


class SelectedSources(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["selected"]
    question_ids: list[uuid.UUID] = Field(
        min_length=1,
        max_length=MAX_BATCH_SOURCES,
        description="Distinct CONFIRMED questions of this workspace, in the batch's order.",
    )


class RandomSources(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["random"]
    count: int = Field(ge=1, le=MAX_BATCH_SOURCES, description="How many sources to pick.")
    chapter: str | None = Field(
        default=None,
        pattern=r"^(none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
        description="A chapter id, or `none` for the questions without a chapter.",
    )
    question_type: QuestionType | None = None
    statuses: list[DotStatus] = Field(
        default_factory=list,
        max_length=5,
        description="Heatmap statuses of the caller's study state (any of them); empty = all.",
    )
    favorite: bool | None = Field(
        default=None, description="true: the caller's favorites only; false: no favorites."
    )
    seed: int | None = Field(
        default=None,
        ge=0,
        le=MAX_SEED,
        description="Same seed and same candidates -> same pick. Omitted: the server draws one.",
    )


class GenerationBatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selection: Annotated[SelectedSources | RandomSources, Field(discriminator="mode")]
    variation_types: list[VariationName] = Field(
        min_length=1,
        max_length=3,
        description="Distinct variations for every source. OPTION_SHUFFLE is refused (422).",
    )
    candidate_count: int = Field(
        default=1,
        ge=1,
        le=20,
        description=f"Candidates per variation and source; sources x variations x candidates "
        f"<= {MAX_BATCH_CANDIDATES}.",
    )
    difficulty: Literal["easier", "same", "harder"] | None = None


class GenerationBatchSource(BaseModel):
    question_id: uuid.UUID
    question_number: int | None
    preview: str = Field(description="First lines of the pinned source stem; never the answer.")


class GenerationBatchItem(BaseModel):
    position: int
    source: GenerationBatchSource
    run: GenerationRun


class GenerationBatch(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    mode: BatchMode
    seed: int | None = Field(description="The random pick's seed (null for `selected`).")
    requested_count: int = Field(description="Sources asked for (a random pick may find fewer).")
    status: Literal["working", "finished"] = Field(
        description="`working` while any run is queued or running."
    )
    run_count: int
    finished_run_count: int
    draft_count: int
    published_count: int
    created_at: datetime
    items: list[GenerationBatchItem] = Field(description="One per source, in batch order.")


# --- dependencies -------------------------------------------------------------------------------


def get_overview_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionOverviewRepository:
    return QuestionOverviewRepository(session)


def get_batch_limiter(request: Request) -> TokenBucketLimiter:
    limiter: TokenBucketLimiter | None = getattr(
        request.app.state, "generation_batch_limiter", None
    )
    if limiter is None:
        rate = request.app.state.settings.question_generation_batch_rate_per_minute
        limiter = request.app.state.generation_batch_limiter = TokenBucketLimiter(
            rate, max(1, rate)
        )
    return limiter


def _workspace(action: Action) -> Any:
    def dependency(
        workspace_id: Annotated[uuid.UUID, Path()],
        user: CurrentUser,
        repo: Annotated[AccessRepository, Depends(get_access_repository)],
    ) -> WorkspaceAccess:
        return authorize_workspace(repo, user.id, workspace_id, action, not_found_detail=NOT_FOUND)

    return Depends(dependency)


OverviewRepo = Annotated[QuestionOverviewRepository, Depends(get_overview_repository)]
LimiterDep = Annotated[TokenBucketLimiter, Depends(get_batch_limiter)]


# --- helpers ------------------------------------------------------------------------------------


def _invalid(loc: tuple[str | int, ...], message: str) -> RequestValidationError:
    return RequestValidationError([{"loc": ("body", *loc), "msg": message, "type": "value_error"}])


def _batch_out(
    repo: QuestionGenerationRepository,
    workspace_id: uuid.UUID,
    batch_id: uuid.UUID,
    runs: list[GenerationRunRecord],
) -> GenerationBatch:
    stems = repo.source_stems(workspace_id, [r.source_question_revision_id for r in runs])
    first = runs[0].params
    seed = first.get("batch_seed")
    requested = first.get("batch_requested")
    items = []
    for index, run in enumerate(runs):
        number, stem = stems.get(run.source_question_revision_id, (None, ""))
        items.append(
            GenerationBatchItem(
                position=index,
                source=GenerationBatchSource(
                    question_id=run.source_question_id,
                    question_number=number,
                    preview=preview_text(stem),
                ),
                run=_run_out(run),
            )
        )
    working = sum(1 for r in runs if r.status in ("queued", "running"))
    return GenerationBatch(
        id=batch_id,
        workspace_id=workspace_id,
        mode="random" if first.get("batch_mode") == "random" else "selected",
        seed=seed if isinstance(seed, int) else None,
        requested_count=requested if isinstance(requested, int) else len(runs),
        status="working" if working else "finished",
        run_count=len(runs),
        finished_run_count=len(runs) - working,
        draft_count=sum(r.draft_count for r in runs),
        published_count=sum(r.published_count for r in runs),
        created_at=min(r.created_at for r in runs),
        items=items,
    )


def _selected_sources(
    repo: QuestionGenerationRepository, workspace_id: uuid.UUID, ids: list[uuid.UUID]
) -> list[LiveQuestionRecord]:
    found = repo.live_questions(workspace_id, ids)
    if len(found) != len(ids):  # another workspace's, deleted or unknown: like the single route
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if any(q.publication_status != "CONFIRMED" for q in found.values()):
        raise ProblemException(
            409,
            ProblemType.QUESTION_NOT_CONFIRMED,
            detail="Variants are generated from confirmed questions only.",
        )
    return [found[i] for i in ids]


def _random_sources(
    repo: QuestionGenerationRepository,
    overview: QuestionOverviewRepository,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    selection: RandomSources,
    seed: int,
) -> list[LiveQuestionRecord]:
    chapter = selection.chapter
    rows = overview.rows(
        workspace_id,
        user_id,
        OverviewFilter(
            chapter_id=uuid.UUID(chapter) if chapter and chapter != "none" else None,
            no_chapter=chapter == "none",
            question_type=selection.question_type,
        ),
    )
    wanted = set(selection.statuses)
    candidates = [
        r.question_id
        for r in rows
        if (selection.favorite is None or r.is_favorite == selection.favorite)
        and (
            not wanted
            or derive_dot_status(
                StudyState(
                    first_viewed_at=r.first_viewed_at,
                    last_graded_result=r.last_graded_result,
                    needs_retry=r.needs_retry,
                    is_favorite=r.is_favorite,
                )
            )
            in wanted
        )
    ]
    if not candidates:
        raise ProblemException(
            409,
            ProblemType.NO_MATCHING_QUESTIONS,
            detail="No confirmed question of this workspace matches the filters.",
        )
    picked = random.Random(seed).sample(candidates, min(selection.count, len(candidates)))  # noqa: S311 - selection, not security
    found = repo.live_questions(workspace_id, picked)
    return [found[i] for i in picked if i in found]


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/question-generation-batches",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=GenerationBatch,
    operation_id="createQuestionGenerationBatch",
    responses=problem_responses(409, 429),
)
def create_question_generation_batch(
    access: Annotated[WorkspaceAccess, _workspace(Action.QUESTION_EDIT)],
    body: GenerationBatchCreate,
    repo: GenerationRepo,
    drafts: DraftRepo,
    overview: OverviewRepo,
    idempotency: IdempotencyStoreDep,
    limiter: LimiterDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Start variant generation for several CONFIRMED questions at once (QGEN-01-AC06/AC07):
    one run per source, reviewed and registered per run like a single generation."""
    user_id = access.user_id
    workspace_id = access.workspace_id
    if "OPTION_SHUFFLE" in body.variation_types:
        raise _invalid(
            ("variation_types",),
            "OPTION_SHUFFLE is not a generation: the practice session stores the shuffled "
            "option order of the original question.",
        )
    if len(set(body.variation_types)) != len(body.variation_types):
        raise _invalid(("variation_types",), "Variation types must be distinct.")
    selection = body.selection
    if isinstance(selection, SelectedSources):
        if len(set(selection.question_ids)) != len(selection.question_ids):
            raise _invalid(("selection", "question_ids"), "Questions must be distinct.")
        most = len(selection.question_ids)
    else:
        most = selection.count
    if most * len(body.variation_types) * body.candidate_count > MAX_BATCH_CANDIDATES:
        raise _invalid(
            ("candidate_count",),
            f"At most {MAX_BATCH_CANDIDATES} candidates per batch "
            "(sources x variation types x candidate_count).",
        )

    scope = f"POST /workspaces/{workspace_id}/question-generation-batches"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            batch_id = stored.body.get("id") if isinstance(stored.body, dict) else None
            repo.rollback()
            if batch_id:
                for run in repo.list_batch_runs(workspace_id, uuid.UUID(str(batch_id))):
                    _publish_job(drafts, publisher, run.job_id)
            return response

    wait = limiter.acquire(f"generation_batch:{user_id}")
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many batch generations. Wait a moment and try again.",
            headers={"Retry-After": retry_after_header(wait)},
        )

    repo.lock_batches(workspace_id)
    seed: int | None = None
    if isinstance(selection, SelectedSources):
        sources = _selected_sources(repo, workspace_id, selection.question_ids)
    else:
        seed = selection.seed if selection.seed is not None else secrets.randbelow(MAX_SEED + 1)
        sources = _random_sources(repo, overview, workspace_id, user_id, selection, seed)
        if not sources:  # every pick was deleted between the two reads
            raise ProblemException(
                409,
                ProblemType.NO_MATCHING_QUESTIONS,
                detail="No confirmed question of this workspace matches the filters.",
            )
    if repo.active_run_count(workspace_id) + len(sources) > MAX_ACTIVE_RUNS:
        raise ProblemException(
            409,
            ProblemType.GENERATION_BUSY,
            detail="Too many generations of this workspace are still running. Wait for them "
            "to finish, then try again.",
        )

    batch_id = uuid.uuid4()
    base: dict[str, Any] = {
        "batch_id": str(batch_id),
        "batch_mode": selection.mode,
        "batch_requested": most,
        **({"batch_seed": seed} if seed is not None else {}),
        **({"difficulty": body.difficulty} if body.difficulty else {}),
    }
    for position, source in enumerate(sources):
        repo.create_run(
            workspace_id=workspace_id,
            actor_id=user_id,
            question_id=source.id,
            revision_id=source.active_revision_id,
            variation_types=body.variation_types,
            candidate_count=body.candidate_count,
            params={**base, "batch_position": position},
        )
    runs = repo.list_batch_runs(workspace_id, batch_id)
    result = _batch_out(repo, workspace_id, batch_id, runs)
    if idempotency_key is not None:
        idempotency.save(
            user_id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_202_ACCEPTED,
            result.model_dump(mode="json"),
        )
    repo.commit()
    for run in runs:
        _publish_job(drafts, publisher, run.job_id)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)


@router.get(
    "/workspaces/{workspace_id}/question-generation-batches/{batch_id}",
    operation_id="getQuestionGenerationBatch",
)
def get_question_generation_batch(
    access: Annotated[WorkspaceAccess, _workspace(Action.READ)],
    batch_id: Annotated[uuid.UUID, Path()],
    repo: GenerationRepo,
) -> GenerationBatch:
    """The batch's runs, one per source in batch order, with their progress and draft counts."""
    runs = repo.list_batch_runs(access.workspace_id, batch_id)
    if not runs:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return _batch_out(repo, access.workspace_id, batch_id, runs)
