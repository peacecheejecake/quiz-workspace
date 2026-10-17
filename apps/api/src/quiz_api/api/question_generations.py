"""Question variant generation API (M6.2, QGEN-01; docs/questions.md §5, architecture.md §6).

    POST  /questions/{id}/generations               editor+; {variation_types, candidate_count?,
                                                    difficulty?} from a CONFIRMED question ->
                                                    202 GenerationRun with its
                                                    `question.generate` job; `Idempotency-Key`
    GET   /workspaces/{id}/question-generations     any member; runs, newest first
                                                    (`source_question_id` filter)
    GET   /question-generations/{id}                any member
    GET   /question-generations/{id}/drafts         any member; drafts in generation order
    PATCH /question-drafts/{id}                     shared with imports (quiz_api.api.
                                                    question_imports; generation rules in
                                                    quiz_api.question_generation_review)
    POST  /question-generations/{id}/publish        editor+; {drafts: [{draft_id, version}]} of
                                                    APPROVED drafts at the reviewed version ->
                                                    CONFIRMED questions with lineage, idempotent
                                                    per draft

OPTION_SHUFFLE is not a generation (422, no run): it never creates a question or a dot; the
practice session stores the displayed option order (M5.2). The other variations produce
isolated drafts in `question_drafts` (never questions: the bank, the overview and its dots never
see them) carrying lineage, generator provenance, cited book passages and machine validations.
The LLM's declared answer is never trusted: a draft with an `error` validation cannot be
approved, and only approved drafts at the reviewed version are registered (409 `stale-draft` /
`draft-not-approved` otherwise; all or nothing).

Publishing a draft creates a CONFIRMED question (origin `generation`, revision 1 from the draft,
the source question's current chapter, one `question_sources` row per cited document with the
cited pages/blocks of the revision the passage came from) and its `question_lineage` row
(parent question + revision, variation type, run, draft, model/prompt, source block ids). The new
question has its own dot and study state.

Authorization as everywhere (A1.3): runs, drafts and questions resolve their workspace from the
DB; unknown, foreign and invisible ids answer the same 404; viewers read but cannot generate,
edit or publish (403 `insufficient-role`); archived workspaces are read-only (403
`workspace-archived`). Answers in drafts are visible to members only, like the bank.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from book_core.contracts import QuestionDraft
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.question_imports import (
    ImportDraft,
    ImportPublishedDraft,
    ImportPublishRequest,
    ImportPublishResult,
    _constraint_violation,
    _content,
    _draft_out,
    _publish_job,
    draft_version,
)
from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    ResourceAccess,
    ResourceType,
    WorkspaceAccess,
    authorize_resource,
    authorize_workspace,
    get_access_repository,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.jobs import JobPublisher
from quiz_api.question_drafts import parse_payload, publish_issues
from quiz_api.question_rules import Issues, QuestionContent
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.question_generations import (
    GenerationRunRecord,
    QuestionGenerationRepository,
)
from quiz_api.repositories.question_imports import (
    DraftRecord,
    QuestionImportRepository,
    RunStatus,
)
from quiz_api.repositories.questions import QuestionRepository

router = APIRouter(tags=["question-generations"], responses=problem_responses(503))

NOT_FOUND = "Not found."
MAX_SOURCE_BLOCK_IDS = 1000  # question_ids_valid
VariationName = Literal["OPTION_SHUFFLE", "PARAPHRASE", "INVERT_POLARITY", "ANALOGOUS_CONCEPT"]
DraftVariation = Literal["PARAPHRASE", "INVERT_POLARITY", "ANALOGOUS_CONCEPT"]


# --- schemas ------------------------------------------------------------------------------------


class GenerationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variation_types: list[VariationName] = Field(
        min_length=1,
        max_length=3,
        description="Distinct variations. OPTION_SHUFFLE is refused (422): it is a practice "
        "order (POST /questions/{id}/practice-sessions), never a generation.",
    )
    candidate_count: int = Field(default=1, ge=1, le=20, description="Candidates per variation.")
    difficulty: Literal["easier", "same", "harder"] | None = Field(
        default=None, description="Optional target difficulty relative to the source."
    )


class GenerationRun(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: RunStatus = Field(description="queued | running | succeeded | failed | cancelled")
    job_id: uuid.UUID | None = Field(description="Poll `GET /jobs/{id}` (job `question.generate`).")
    error_code: str | None = Field(
        description="Why the job failed (stable code), e.g. `llm_output_invalid`, "
        "`no_valid_candidates`, `llm_unavailable`, `llm_not_configured`."
    )
    source_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID = Field(
        description="The revision the variants are generated from (the diff original)."
    )
    variation_types: list[DraftVariation]
    candidate_count: int
    difficulty: Literal["easier", "same", "harder"] | None
    draft_count: int
    published_count: int
    llm_model: str | None = Field(description="Set when the run succeeded.")
    prompt_version: str | None = Field(description="Set when the run succeeded.")
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


class GenerationRunList(BaseModel):
    items: list[GenerationRun]


class GenerationDraftList(BaseModel):
    items: list[ImportDraft] = Field(description="Generation drafts (`run_id` set).")


# --- dependencies -------------------------------------------------------------------------------


def get_generation_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionGenerationRepository:
    return QuestionGenerationRepository(session)


def get_import_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionImportRepository:
    return QuestionImportRepository(session)


def get_question_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionRepository:
    return QuestionRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


GenerationRepo = Annotated[QuestionGenerationRepository, Depends(get_generation_repository)]
DraftRepo = Annotated[QuestionImportRepository, Depends(get_import_repository)]
QuestionRepo = Annotated[QuestionRepository, Depends(get_question_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]


def _uniform(call: Callable[[], ResourceAccess]) -> ResourceAccess:
    try:
        return call()
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None
        raise


def _workspace(action: Action) -> Any:
    def dependency(
        workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> WorkspaceAccess:
        return authorize_workspace(repo, user.id, workspace_id, action, not_found_detail=NOT_FOUND)

    return Depends(dependency)


def _question(action: Action) -> Any:
    def dependency(
        question_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return _uniform(
            lambda: authorize_resource(repo, user.id, ResourceType.QUESTION, question_id, action)
        )

    return Depends(dependency)


def _run(action: Action) -> Any:
    def dependency(
        generation_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return _uniform(
            lambda: authorize_resource(
                repo, user.id, ResourceType.QUESTION_GENERATION_RUN, generation_id, action
            )
        )

    return Depends(dependency)


ReadWorkspace = Annotated[WorkspaceAccess, _workspace(Action.READ)]
EditQuestion = Annotated[ResourceAccess, _question(Action.QUESTION_EDIT)]
ReadRun = Annotated[ResourceAccess, _run(Action.READ)]
EditRun = Annotated[ResourceAccess, _run(Action.QUESTION_EDIT)]


# --- helpers ------------------------------------------------------------------------------------


def _run_out(run: GenerationRunRecord) -> GenerationRun:
    difficulty = run.params.get("difficulty")
    return GenerationRun(
        id=run.id,
        workspace_id=run.workspace_id,
        status=run.status,
        job_id=run.job_id,
        error_code=run.error_code,
        source_question_id=run.source_question_id,
        source_question_revision_id=run.source_question_revision_id,
        variation_types=run.variation_types,  # type: ignore[arg-type]
        candidate_count=run.candidate_count,
        difficulty=difficulty if difficulty in {"easier", "same", "harder"} else None,
        draft_count=run.draft_count,
        published_count=run.published_count,
        llm_model=run.llm_model,
        prompt_version=run.prompt_version,
        created_at=run.created_at,
        updated_at=run.updated_at,
        finished_at=run.finished_at,
    )


def _load_run(repo: QuestionGenerationRepository, run_id: uuid.UUID) -> GenerationRunRecord:
    run = repo.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return run


def _invalid(field: str, message: str) -> RequestValidationError:
    return RequestValidationError([{"loc": ("body", field), "msg": message, "type": "value_error"}])


# --- routes: runs -------------------------------------------------------------------------------


@router.post(
    "/questions/{question_id}/generations",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=GenerationRun,
    operation_id="createQuestionGeneration",
    responses=problem_responses(409),
)
def create_question_generation(
    access: EditQuestion,
    body: GenerationCreate,
    repo: GenerationRepo,
    drafts: DraftRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Start generating variant drafts of a CONFIRMED question (QGEN-01-AC02..AC04). 409
    `question-not-confirmed` for a draft/archived question. ANALOGOUS_CONCEPT needs a source
    question that cites document pages (422 otherwise): its passages come from those pages."""
    user_id = access.workspace.user_id
    workspace_id = access.workspace.workspace_id
    if "OPTION_SHUFFLE" in body.variation_types:
        raise _invalid(
            "variation_types",
            "OPTION_SHUFFLE is not a generation: the practice session stores the shuffled "
            "option order of the original question.",
        )
    if len(set(body.variation_types)) != len(body.variation_types):
        raise _invalid("variation_types", "Variation types must be distinct.")

    scope = f"POST /questions/{access.resource_id}/generations"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            run_id = stored.body.get("id") if isinstance(stored.body, dict) else None
            repo.rollback()
            if run_id:
                found = repo.get_run(uuid.UUID(str(run_id)))
                _publish_job(drafts, publisher, found.job_id if found else None)
            return response

    question = questions.get(access.resource_id)
    if question is None:  # soft-deleted after the authorization lookup
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if question.publication_status != "CONFIRMED":
        raise ProblemException(
            409,
            ProblemType.QUESTION_NOT_CONFIRMED,
            detail="Variants are generated from confirmed questions only.",
        )
    if "ANALOGOUS_CONCEPT" in body.variation_types and not any(
        s.document_id is not None and s.page_start is not None for s in question.sources
    ):
        raise _invalid(
            "variation_types",
            "ANALOGOUS_CONCEPT needs a source question that cites document pages.",
        )

    run_id = repo.create_run(
        workspace_id=workspace_id,
        actor_id=user_id,
        question_id=question.id,
        revision_id=question.revision.id,
        variation_types=body.variation_types,
        candidate_count=body.candidate_count,
        params={"difficulty": body.difficulty} if body.difficulty else {},
    )
    run = _load_run(repo, run_id)
    result = _run_out(run)
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
    _publish_job(drafts, publisher, run.job_id)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)


@router.get(
    "/workspaces/{workspace_id}/question-generations", operation_id="listQuestionGenerations"
)
def list_question_generations(
    access: ReadWorkspace,
    repo: GenerationRepo,
    source_question_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> GenerationRunList:
    """The workspace's generation runs, newest first (optionally of one source question)."""
    return GenerationRunList(
        items=[
            _run_out(r)
            for r in repo.list_runs(
                access.workspace_id, limit=limit, source_question_id=source_question_id
            )
        ]
    )


@router.get("/question-generations/{generation_id}", operation_id="getQuestionGeneration")
def get_question_generation(access: ReadRun, repo: GenerationRepo) -> GenerationRun:
    return _run_out(_load_run(repo, access.resource_id))


@router.get(
    "/question-generations/{generation_id}/drafts", operation_id="listQuestionGenerationDrafts"
)
def list_question_generation_drafts(access: ReadRun, repo: GenerationRepo) -> GenerationDraftList:
    """The run's drafts in generation order with diff original (the run's source revision),
    justification, cited passages and validations. Review them with PATCH /question-drafts/{id}."""
    _load_run(repo, access.resource_id)
    return GenerationDraftList(items=[_draft_out(d) for d in repo.list_drafts(access.resource_id)])


# --- routes: publish ----------------------------------------------------------------------------


def _uuid(value: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(value) if value else None
    except ValueError:
        return None


@router.post(
    "/question-generations/{generation_id}/publish",
    operation_id="publishQuestionGenerationDrafts",
    responses=problem_responses(409),
)
def publish_question_generation_drafts(
    access: EditRun,
    body: ImportPublishRequest,
    repo: GenerationRepo,
    drafts: DraftRepo,
    questions: QuestionRepo,
) -> ImportPublishResult:
    """Register exactly these approved drafts as CONFIRMED questions with lineage
    (QGEN-01-AC04). Same contract as the import publish: all or nothing; 404 for an id that is
    not a draft of this run, 409 `stale-draft` for a draft changed since review, 409
    `draft-not-approved` for a pending/rejected draft, 422 when a draft cannot be confirmed;
    already published drafts return their question (idempotent replay)."""
    run = _load_run(repo, access.resource_id)
    user_id = access.workspace.user_id
    versions: dict[uuid.UUID, str] = {}
    for item in body.drafts:
        versions.setdefault(item.draft_id, item.version)
    requested = list(versions)
    locked = {d.id: d for d in repo.lock_drafts(run.id, requested)}
    if len(locked) != len(requested):
        raise HTTPException(status_code=404, detail="Draft not found.")

    pending = [locked[d] for d in requested if locked[d].published_question_id is None]
    if any(versions[r.id] != draft_version(r.updated_at) for r in pending):
        raise ProblemException(
            409,
            ProblemType.STALE_DRAFT,
            detail="A draft changed since it was reviewed. Reload the drafts and review again.",
        )
    if any(r.review_status != "approved" for r in pending):
        raise ProblemException(
            409,
            ProblemType.DRAFT_NOT_APPROVED,
            detail="Only approved drafts can be registered. Approve them first.",
        )

    issues = Issues()
    plans: list[tuple[DraftRecord, QuestionDraft, QuestionContent]] = []
    for index, record in enumerate(pending):
        draft = parse_payload(record.payload)
        content = _content(record, draft)
        blockers = publish_issues(content, record.validations, prefix=("body", "drafts", index))
        issues.items.extend(blockers.items)
        plans.append((record, draft, content))
    issues.raise_if_any()

    mapping = {d.id: d.published_question_id for d in locked.values()}
    try:
        if plans:
            _register(run, plans, user_id, repo, drafts, questions, mapping)
        repo.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(drafts) from None
    return ImportPublishResult(
        items=[
            ImportPublishedDraft(draft_id=d, question_id=q)
            for d in requested
            if (q := mapping[d]) is not None
        ]
    )


def _register(
    run: GenerationRunRecord,
    plans: list[tuple[DraftRecord, QuestionDraft, QuestionContent]],
    user_id: uuid.UUID,
    repo: QuestionGenerationRepository,
    drafts: QuestionImportRepository,
    questions: QuestionRepository,
    mapping: dict[uuid.UUID, uuid.UUID | None],
) -> None:
    workspace_id = run.workspace_id
    source = repo.source_revision(
        workspace_id, run.source_question_id, run.source_question_revision_id
    )
    chapter = source.chapter_id if source is not None and not source.deleted else None
    cited = {_uuid(e.document_id) for _, draft, _ in plans for e in draft.evidence}
    # Lock order of question writes (quiz_api.repositories.questions.lock_documents): documents
    # (chapter + cited) first, so a concurrent publish of a document cannot strand the chapter.
    questions.lock_documents(
        workspace_id, chapter_ids=[chapter], document_ids=[d for d in cited if d is not None]
    )
    if chapter is not None and not questions.chapter_is_current(workspace_id, chapter):
        chapter = None
    live = questions.live_documents(workspace_id, [d for d in cited if d is not None])

    for record, draft, content in plans:
        question_id = questions.create(
            workspace_id=workspace_id,
            actor_id=user_id,
            content=content,
            status="CONFIRMED",
            chapter_id=chapter,
            question_number=record.question_number,
            sources=[],
            source_revisions={},
            origin="generation",
        )
        by_document: dict[uuid.UUID, list[Any]] = defaultdict(list)
        for evidence in draft.evidence:
            document_id = _uuid(evidence.document_id)
            if document_id is not None and document_id in live:
                by_document[document_id].append(evidence)
        for document_id, items in by_document.items():
            pages = sorted({loc.page for e in items for loc in e.locations})
            revision = _uuid(items[0].revision_id)
            repo.insert_source(
                workspace_id=workspace_id,
                question_id=question_id,
                document_id=document_id,
                revision_id=revision,
                page_start=pages[0] if pages else None,
                page_end=pages[-1] if pages else None,
                block_ids=list(dict.fromkeys(b for e in items for b in e.block_ids)),
                locations=[loc.model_dump(mode="json") for e in items for loc in e.locations],
            )
        generator = draft.generator
        assert draft.variation_type is not None  # noqa: S101 - generation drafts carry it
        repo.insert_lineage(
            workspace_id=workspace_id,
            parent_question_id=run.source_question_id,
            child_question_id=question_id,
            source_question_revision_id=run.source_question_revision_id,
            variation_type=draft.variation_type.value,
            run_id=run.id,
            draft_id=record.id,
            llm_model=generator.model[:200] if generator else None,
            prompt_version=generator.prompt_version[:100] if generator else None,
            source_block_ids=list(dict.fromkeys(b for e in draft.evidence for b in e.block_ids))[
                :MAX_SOURCE_BLOCK_IDS
            ],
        )
        # The approval (reviewer, time, content) stays as it was; only the link is added.
        drafts.update_draft(record.id, published_question_id=question_id)
        mapping[record.id] = question_id
    repo.record_published(workspace_id, user_id, run.id, len(plans))
