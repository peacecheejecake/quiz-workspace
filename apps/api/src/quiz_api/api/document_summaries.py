"""Document summaries (DOCSUM-B, DOCSUM-01; docs/architecture.md §5-§6).

    GET    /documents/{id}/summary        any member (archived workspaces too): availability,
                                          opt-in, the current revision's run, the newest
                                          succeeded summary and whether it is stale
    POST   /documents/{id}/summary        editor+, active workspace: `요약 만들기` = opt in (auto
                                          refresh on) and summarize the current published
                                          revision; 202 with a queued run, 200 when that revision
                                          already has a summary (opt-in only); `Idempotency-Key`
    POST   /documents/{id}/summary/retry  editor+: a new run of the current revision after a
                                          failed one (409 `summary-not-failed` otherwise)
    DELETE /documents/{id}/summary/auto   editor+: `자동 갱신 끄기`; 204, idempotent

Errors: 404 for non-members, other workspaces and deleted documents (resource authorization);
403 `insufficient-role` / `workspace-archived` for writes; 409 `summary-not-applicable` for a
question paper, `document-not-ready` before the first publish, `summary-disabled` when this
environment has no summaries (WORKER_DOCUMENT_SUMMARY off). Responses never carry prompts, LLM
output other than the stored summaries, or provider errors (codes only). Activities
`document.summary_enabled` / `document.summary_auto_disabled` carry ids only, and only when the
setting actually changes.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from quiz_api.api.documents import DocumentRepo, PublisherDep, publish_job
from quiz_api.authz import Action, ResourceAccess, ResourceType, require_resource_access
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.document_summaries import (
    DocumentSummaryRepository,
    RunRecord,
    StoredSummary,
    SummaryDocument,
)
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.settings import Settings

router = APIRouter(tags=["document summaries"], responses=problem_responses(503))

RunStatus = Literal["queued", "running", "succeeded", "failed", "superseded"]
RunTrigger = Literal["manual", "publish", "retry"]


# --- schemas ------------------------------------------------------------------------------------


class SummaryPages(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from", serialization_alias="from")
    to: int


class SummaryKeyPoint(BaseModel):
    text: str
    pages: SummaryPages | None = Field(
        description="Pages the point is based on (inside the chapter's range), or null."
    )


class SummaryUnit(BaseModel):
    title: str
    summary_md: str = Field(
        description="Markdown subset (paragraphs, lists, emphasis); render HTML, links and images "
        "as text. Empty when the chapter has no body text."
    )
    key_points: list[SummaryKeyPoint]


class ChapterSummary(SummaryUnit):
    section_key: str
    page_from: int | None
    page_to: int | None


class SummaryUsage(BaseModel):
    reused_units: int = 0
    generated_units: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


class SummaryProgress(BaseModel):
    chapters_done: int
    chapters_total: int


class SummaryRun(BaseModel):
    id: uuid.UUID
    revision_id: uuid.UUID
    status: RunStatus
    trigger: RunTrigger
    job_id: uuid.UUID | None
    error_code: str | None = Field(
        description="llm_unavailable | llm_timeout | llm_invalid_output | summary_too_large | "
        "document_unavailable (failed runs only)."
    )
    progress: SummaryProgress | None
    usage: SummaryUsage | None
    created_at: datetime


class Summary(BaseModel):
    run_id: uuid.UUID
    revision_id: uuid.UUID
    published_at: datetime | None
    usage: SummaryUsage | None
    document: SummaryUnit
    chapters: list[ChapterSummary] = Field(description="Top-level chapters in outline order.")


class SharedSummary(BaseModel):
    """What a share-link guest sees: the current published revision's summary only."""

    revision_id: uuid.UUID
    published_at: datetime | None
    document: SummaryUnit
    chapters: list[ChapterSummary]


class SummaryState(BaseModel):
    document_id: uuid.UUID
    available: bool = Field(description="This environment can create summaries.")
    enabled: bool = Field(description="Opted in: every publish re-summarizes (auto refresh).")
    published_revision_id: uuid.UUID | None
    run: SummaryRun | None = Field(description="The newest run of the current revision.")
    summary: Summary | None = Field(description="The newest succeeded summary (any revision).")
    stale: bool = Field(description="`summary` is not of the current published revision.")


# --- helpers ------------------------------------------------------------------------------------


def get_summary_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> DocumentSummaryRepository:
    return DocumentSummaryRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


SummaryRepo = Annotated[DocumentSummaryRepository, Depends(get_summary_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
ReadDocument = Annotated[
    ResourceAccess,
    Depends(require_resource_access(ResourceType.DOCUMENT, Action.READ, param="document_id")),
]
EditDocument = Annotated[
    ResourceAccess,
    Depends(
        require_resource_access(ResourceType.DOCUMENT, Action.DOCUMENT_EDIT, param="document_id")
    ),
]
NOT_FOUND = "Document not found."


def summary_available(request: Request) -> bool:
    settings: Settings = request.app.state.settings
    return settings.document_summary


def _run_out(run: RunRecord) -> SummaryRun:
    return SummaryRun(
        id=run.id,
        revision_id=run.revision_id,
        status=run.status,  # type: ignore[arg-type]
        trigger=run.trigger,  # type: ignore[arg-type]
        job_id=run.job_id,
        error_code=run.error_code if run.status == "failed" else None,
        progress=SummaryProgress.model_validate(run.progress) if run.progress else None,
        usage=SummaryUsage.model_validate(run.usage) if run.usage else None,
        created_at=run.created_at,
    )


def _unit(body: dict[str, Any]) -> SummaryUnit:
    return SummaryUnit(
        title=str(body.get("title", "")),
        summary_md=str(body.get("summary_md", "")),
        key_points=[SummaryKeyPoint.model_validate(k) for k in body.get("key_points", [])],
    )


def summary_parts(stored: StoredSummary) -> tuple[SummaryUnit, list[ChapterSummary]]:
    document = SummaryUnit(title="", summary_md="", key_points=[])
    chapters: list[ChapterSummary] = []
    for unit in stored.units:
        if unit.scope == "document":
            document = _unit(unit.body)
        else:
            chapters.append(
                ChapterSummary(
                    **_unit(unit.body).model_dump(by_alias=True),
                    section_key=unit.section_key,
                    page_from=unit.page_from,
                    page_to=unit.page_to,
                )
            )
    return document, chapters


def _summary_out(stored: StoredSummary) -> Summary:
    document, chapters = summary_parts(stored)
    return Summary(
        run_id=stored.run.id,
        revision_id=stored.run.revision_id,
        published_at=stored.published_at,
        usage=SummaryUsage.model_validate(stored.run.usage) if stored.run.usage else None,
        document=document,
        chapters=chapters,
    )


def _state(
    repo: DocumentSummaryRepository, document: SummaryDocument, available: bool
) -> SummaryState:
    current = document.active_revision_id
    run = repo.current_run(document.id, current) if current is not None else None
    stored = repo.latest_summary(document.id)
    return SummaryState(
        document_id=document.id,
        available=available,
        enabled=document.summary_enabled_at is not None,
        published_revision_id=current,
        run=_run_out(run) if run is not None else None,
        summary=_summary_out(stored) if stored is not None else None,
        stale=stored is not None and stored.run.revision_id != current,
    )


def _document(
    repo: DocumentSummaryRepository, document_id: uuid.UUID, *, lock: bool
) -> SummaryDocument:
    found = repo.document(document_id, lock=lock)
    if found is None:  # deleted after the authorization lookup
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return found


def _check_writable(document: SummaryDocument, available: bool) -> None:
    if document.document_type == "question_paper":
        raise ProblemException(
            409,
            ProblemType.SUMMARY_NOT_APPLICABLE,
            detail="Question papers are not summarized.",
        )
    if document.status != "ready" or document.active_revision_id is None:
        raise ProblemException(
            409,
            ProblemType.DOCUMENT_NOT_READY,
            detail="The document has not finished processing.",
        )
    if not available:
        raise ProblemException(
            409,
            ProblemType.SUMMARY_DISABLED,
            detail="AI summaries are not available in this environment.",
        )


def _publish(documents: Any, publisher: Any, job_id: uuid.UUID | None) -> None:
    if job_id is None:
        return
    job = documents.get_job(job_id)
    if job is not None:
        publish_job(documents, publisher, job)


# --- routes -------------------------------------------------------------------------------------


@router.get("/documents/{document_id}/summary", operation_id="getDocumentSummary")
def get_document_summary(access: ReadDocument, repo: SummaryRepo, request: Request) -> SummaryState:
    """The summary panel's state (DOCSUM-01): any member, archived workspaces included."""
    document = repo.document(access.resource_id)
    if document is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    out = _state(repo, document, summary_available(request))
    repo.rollback()
    return out


@router.post(
    "/documents/{document_id}/summary",
    operation_id="createDocumentSummary",
    response_model=SummaryState,
    status_code=status.HTTP_202_ACCEPTED,
    responses={200: {"model": SummaryState}, **problem_responses(409)},
)
def create_document_summary(
    access: EditDocument,
    repo: SummaryRepo,
    documents: DocumentRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    request: Request,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """`요약 만들기` (DOCSUM-01-AC01/AC08): opt in and summarize the current published revision.

    202 with the queued (or still running) run; 200 when the current revision already has a
    succeeded summary (only the opt-in changes, no run). Re-enables auto refresh after
    `자동 갱신 끄기`."""
    user_id = access.workspace.user_id
    scope = f"POST /documents/{access.resource_id}/summary"
    body_hash = request_hash({})
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            run = stored.body.get("run") if isinstance(stored.body, dict) else None
            repo.rollback()
            if isinstance(run, dict) and run.get("job_id"):
                _publish(documents, publisher, uuid.UUID(str(run["job_id"])))
            return response

    document = _document(repo, access.resource_id, lock=True)
    available = summary_available(request)
    _check_writable(document, available)
    repo.enable(document, user_id)
    assert document.active_revision_id is not None  # noqa: S101 - _check_writable
    current = repo.current_run(document.id, document.active_revision_id)
    code = status.HTTP_202_ACCEPTED
    job_id: uuid.UUID | None = None
    if current is not None and current.status == "succeeded":
        code = status.HTTP_200_OK
    elif current is not None and current.status in ("queued", "running"):
        job_id = current.job_id
    else:
        _, job_id = repo.start_run(document, user_id, "manual")
    out = _state(repo, _document(repo, document.id, lock=False), available)
    body = out.model_dump(mode="json", by_alias=True)
    if idempotency_key is not None:
        idempotency.save(user_id, scope, idempotency_key, body_hash, code, body)
    repo.commit()
    _publish(documents, publisher, job_id)
    return JSONResponse(body, status_code=code)


@router.post(
    "/documents/{document_id}/summary/retry",
    operation_id="retryDocumentSummary",
    response_model=SummaryState,
    status_code=status.HTTP_202_ACCEPTED,
    responses=problem_responses(409),
)
def retry_document_summary(
    access: EditDocument,
    repo: SummaryRepo,
    documents: DocumentRepo,
    publisher: PublisherDep,
    request: Request,
) -> Any:
    """`다시 시도` (DOCSUM-01-AC03): a new run of the current revision after a failed one."""
    document = _document(repo, access.resource_id, lock=True)
    available = summary_available(request)
    _check_writable(document, available)
    assert document.active_revision_id is not None  # noqa: S101 - _check_writable
    current = repo.current_run(document.id, document.active_revision_id)
    if current is None or current.status != "failed":
        raise ProblemException(
            409,
            ProblemType.SUMMARY_NOT_FAILED,
            detail="Only a failed summary of the current revision can be retried.",
        )
    _, job_id = repo.start_run(document, access.workspace.user_id, "retry")
    out = _state(repo, document, available)
    body = out.model_dump(mode="json", by_alias=True)
    repo.commit()
    _publish(documents, publisher, job_id)
    return JSONResponse(body, status_code=status.HTTP_202_ACCEPTED)


@router.delete(
    "/documents/{document_id}/summary/auto",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="disableDocumentSummaryAuto",
)
def disable_document_summary_auto(access: EditDocument, repo: SummaryRepo) -> Response:
    """`자동 갱신 끄기` (DOCSUM-01-AC08): later publishes start no run and send nothing to the
    LLM; stored summaries stay. Running runs are not cancelled. Idempotent (204)."""
    document = _document(repo, access.resource_id, lock=True)
    repo.disable(document, access.workspace.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
