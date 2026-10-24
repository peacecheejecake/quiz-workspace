"""Question PDF import API (M4.4a, QIMPORT-01; docs/questions.md §6, architecture.md §6).

    POST  /workspaces/{id}/question-imports      editor+; {document_id} of a ready
                                                 `question_paper` document -> 202 ImportRun with
                                                 its `question.import` job; returns the existing
                                                 run of the paper's active revision (usually the
                                                 one the server started, QIMP-AUTO) instead of a
                                                 second one; `Idempotency-Key`
    GET   /workspaces/{id}/question-imports      any member; runs, newest first (`document_id`
                                                 filter)
    GET   /question-imports/{id}                 any member
    POST  /question-imports/{id}/retry           editor+; a failed/cancelled run gets a new job
                                                 (same run) -> 202; `Idempotency-Key`
    GET   /question-imports/{id}/drafts          any member; drafts in position order, each with
                                                 the book chapter it is registered under
                                                 (suggested or chosen, CHAPTER-MAP), plus the
                                                 workspace's book chapters (picker)
    PATCH /question-drafts/{id}                  editor+; edit / approve / reject a draft
                                                 (`base_version` optimistic concurrency); also
                                                 generation drafts (M6.2, question_generations)
    POST  /question-imports/{id}/publish         editor+; {drafts: [{draft_id, version}]} of
                                                 APPROVED drafts at the reviewed version -> the
                                                 CONFIRMED questions, idempotent per draft;
                                                 `approve: true` approves the selected drafts in
                                                 the same transaction and lists the refused ones
    POST  /question-imports/{id}/registrations   editor+; the whole selection {drafts: [{draft_id,
                                                 version}]} -> 202 registration whose
                                                 `question.import_register` job approves and
                                                 registers it on the server (QIMP-JOB); the page
                                                 may be left; `Idempotency-Key`
    GET   /question-imports/{id}/registrations/{registration_id}
                                                 any member; progress (processed/total) and the
                                                 refused drafts of a registration

Isolation (AGENTS.md §5 Data): drafts live in `question_drafts` and are never questions: the bank,
the overview and `GET /questions/{id}` never see them. Human approval is the gate: a draft is
approved through PATCH (only when it can be confirmed), any later change returns it to pending,
and `publish` registers only approved drafts whose current version is the one the client
reviewed (409 `stale-draft` / `draft-not-approved` otherwise). The import screen selects drafts
and sends them with `approve: true`: the selection is the approval, of exactly the version on
screen, recorded with the caller as the reviewer; refused drafts stay as they were. Publishing
creates CONFIRMED questions (origin `import`, revision 1 from the draft, one source row pointing
at the import's document revision and pages, no lineage) in one transaction: without `approve`,
if any draft is refused nothing is registered. Each draft is published at most once
(`published_question_id`, unique): a repeated publish returns the same mapping. Answers are
never filled in: an MCQ draft without an answer cannot be approved until a reviewer enters one
(QIMPORT-01-AC02).

Authorization as everywhere (A1.3): runs and drafts resolve their workspace from the DB; unknown,
foreign and invisible ids answer the same 404; viewers read but cannot import, edit or publish
(403 `insufficient-role`); archived workspaces are read-only (403 `workspace-archived`).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast

from book_core.contracts import QuestionDraft
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.documents import get_job_publisher
from quiz_api.api.questions import QuestionOption
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
from quiz_api.chapter_matching import BookChapter, ChapterMatch
from quiz_api.db import get_db_session
from quiz_api.draft_chapters import ChapterChoice, DraftChapter, draft_chapters
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.jobs import JobMessage, JobPublisher
from quiz_api.question_drafts import (
    answer_missing,
    content_of,
    pages,
    parse_payload,
    publish_issues,
    recompute_validations,
    source_pages,
    with_review,
)
from quiz_api.question_generation_review import acknowledged_codes, generation_validations
from quiz_api.question_rules import (
    MAX_ACCEPTED_ANSWERS,
    MAX_LONG_TEXT,
    MAX_OPTIONS,
    MAX_STEM,
    Issues,
    QuestionContent,
    QuestionType,
    content_issues,
    unstorable_strings,
)
from quiz_api.repositories.draft_chapters import DraftChapterRepository
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.question_imports import (
    DraftRecord,
    JobStatus,
    QuestionImportRepository,
    RegistrationItem,
    RegistrationRecord,
    ReviewStatus,
    RunRecord,
    RunStatus,
)
from quiz_api.repositories.questions import QuestionRepository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["question-imports"], responses=problem_responses(503))

NOT_FOUND = "Not found."
MAX_PUBLISH = 200
# One registration request carries the whole selection (QIMP-JOB): far more than one real paper
# (316 pages -> 750 drafts) while keeping the request body bounded (~100 bytes per item).
MAX_REGISTRATION = 5000
DraftVariation = Literal["PARAPHRASE", "INVERT_POLARITY", "ANALOGOUS_CONCEPT"]
INT4_MAX = 2147483647
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


# --- schemas ------------------------------------------------------------------------------------


class ImportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: uuid.UUID = Field(
        description="A `question_paper` document of this workspace whose processing finished."
    )


class ImportRun(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    status: RunStatus = Field(description="queued | running | succeeded | failed | cancelled")
    job_id: uuid.UUID | None = Field(description="The run's current job; poll `GET /jobs/{id}`.")
    error_code: str | None = Field(description="Why the last job failed (stable code).")
    source_document_id: uuid.UUID | None
    source_document_revision_id: uuid.UUID | None = Field(
        description="The document revision the import reads (active when it started)."
    )
    document_title: str | None
    draft_count: int
    published_count: int
    registration_job_id: uuid.UUID | None = Field(
        description="The newest registration (QIMP-JOB) of this run, if any: read its progress "
        "at `GET /question-imports/{id}/registrations/{registration_id}`."
    )
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


class ImportRunList(BaseModel):
    items: list[ImportRun]


class DraftBBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class DraftLocation(BaseModel):
    page: int
    bbox: DraftBBox | None = None
    block_id: str | None = None


class DraftEvidence(BaseModel):
    document_id: str
    revision_id: str | None = None
    block_ids: list[str] = Field(default_factory=list)
    locations: list[DraftLocation]
    quote: str | None = Field(default=None, description="Figure caption text, when any.")


class DraftValidation(BaseModel):
    code: str
    severity: Literal["warning", "error"] = Field(description="`error` blocks approval.")
    message: str
    field: str | None = None


class DraftGenerator(BaseModel):
    model: str
    prompt_version: str


class DraftPayload(BaseModel):
    """book_core `QuestionDraft` (schema_version 1)."""

    model_config = ConfigDict(extra="ignore")

    schema_version: int
    id: str = Field(
        description="Producer id: extractor `{document_id}-q{NNN}` or generator "
        "`gen-{run id}-{variation}-{NN}` (not the draft row id)."
    )
    origin: Literal["pdf_import", "generation"]
    question_type: QuestionType
    stem: str
    options: list[QuestionOption]
    correct_option_ids: list[str] | None = Field(description="null = the source has no answer.")
    accepted_answers: list[str] | None = Field(description="null = the source has no answer.")
    explanation: str | None = None
    justification: str | None = Field(
        default=None, description="Generation: why the answer is correct, from the passages."
    )
    evidence: list[DraftEvidence] = Field(
        description="Import: page/area provenance in the question PDF. Generation: the cited "
        "book passages (document revision, blocks, pages, verbatim quote)."
    )
    variation_type: DraftVariation | None = Field(
        default=None, description="Generation drafts only."
    )
    parent_question_id: str | None = Field(
        default=None, description="Generation: the source question (lineage parent)."
    )
    source_question_revision_id: str | None = Field(
        default=None, description="Generation: the source revision to diff against."
    )
    generator: DraftGenerator | None = None
    validations: list[DraftValidation]
    review_status: ReviewStatus


class DraftPublishError(BaseModel):
    field: str | None
    message: str


class DraftChapterRef(BaseModel):
    id: uuid.UUID
    title: str
    document_id: uuid.UUID
    document_title: str


class BookChapterOption(DraftChapterRef):
    level: int = Field(description="1 = chapter, 2+ = nested section.")


class ImportDraft(BaseModel):
    """A question draft under review: an import draft or a generation draft (M6.2)."""

    id: uuid.UUID
    import_id: uuid.UUID | None = Field(description="The import run (import drafts).")
    run_id: uuid.UUID | None = Field(
        default=None, description="The generation run (generation drafts)."
    )
    variation_type: DraftVariation | None = Field(
        default=None, description="Generation drafts only."
    )
    acknowledged_codes: list[str] = Field(
        default_factory=list,
        description="Generation: blocking validations the reviewer confirmed "
        "(answer_count_changed via is_multi_answer, question_type_changed via question_type).",
    )
    position: int = Field(description="0-based order in the source.")
    question_number: int | None = Field(description="Number printed in the source.")
    question_type: QuestionType
    is_multi_answer: bool
    rubric: str | None = Field(
        description="Essay model answer / grading criteria (a model answer printed in the "
        "source lands here, never in accepted_answers)."
    )
    review_status: ReviewStatus
    published_question_id: uuid.UUID | None
    validations: list[DraftValidation]
    answer_missing: bool = Field(
        description="No option answers, no accepted answers and (essay) no model answer."
    )
    pages: list[int] = Field(description="Source PDF pages (1-based) of the draft.")
    publishable: bool = Field(description="Can be approved / confirmed as it is.")
    publish_errors: list[DraftPublishError] = Field(description="Why it cannot be confirmed yet.")
    payload: DraftPayload
    version: str = Field(
        description="Changes with every write. Send it as `base_version` when editing and as "
        "`version` when publishing (the version that was reviewed)."
    )
    reviewed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    chapter: DraftChapterRef | None = Field(
        default=None,
        description="Import drafts (CHAPTER-MAP): the book chapter the draft is registered under "
        "(the suggestion, or the reviewer's choice), in its book's current revision; null = none.",
    )
    chapter_choice: ChapterChoice = Field(
        default="auto", description="`auto`: the server's suggestion; `manual`: chosen in review."
    )
    chapter_match: ChapterMatch | None = Field(
        default=None,
        description="Why the suggestion is what it is (auto only): `matched` (exactly one book "
        "chapter with the question's chapter title), `no_match`, `ambiguous` (several), "
        "`no_source_chapter` (the question PDF has no chapter there).",
    )
    source_chapter_title: str | None = Field(
        default=None, description="The question PDF chapter the suggestion was made from."
    )


class ImportDraftList(BaseModel):
    items: list[ImportDraft]
    chapters: list[BookChapterOption] = Field(
        default_factory=list,
        description="Import runs: the workspace's book chapters (current revisions), the "
        "choices for `chapter_id`.",
    )


class QuestionDraftUpdate(BaseModel):
    """Partial update: omitted fields are kept; `null` clears a nullable field (an answer set
    to null means unknown)."""

    model_config = ConfigDict(extra="forbid")

    base_version: str = Field(max_length=64, description="`version` of the draft being edited.")
    question_type: QuestionType | None = None
    stem: str | None = Field(default=None, max_length=MAX_STEM)
    options: list[QuestionOption] | None = Field(default=None, max_length=MAX_OPTIONS)
    correct_option_ids: list[str] | None = Field(default=None, max_length=MAX_OPTIONS)
    is_multi_answer: bool | None = None
    accepted_answers: list[str] | None = Field(default=None, max_length=MAX_ACCEPTED_ANSWERS)
    explanation: str | None = Field(default=None, max_length=MAX_LONG_TEXT)
    rubric: str | None = Field(
        default=None, max_length=MAX_LONG_TEXT, description="Essay model answer / criteria."
    )
    question_number: int | None = Field(default=None, ge=1, le=INT4_MAX)
    review_status: ReviewStatus | None = Field(
        default=None,
        description="approve (needs a publishable draft) / reject / back to pending. Any other "
        "change without `approved` returns an approved draft to pending (it must be re-approved).",
    )
    chapter_id: uuid.UUID | None = Field(
        default=None,
        description="Import drafts (CHAPTER-MAP): the book chapter to register the draft under "
        "(a chapter of a book's current revision here; `null` = no chapter). Sending it replaces "
        "the suggestion with this choice; it is not content and keeps an approval.",
    )

    @field_validator("question_type", "stem", "options", "is_multi_answer", "review_status")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("may be omitted but not null")
        return value


class ReviewedDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draft_id: uuid.UUID
    version: str = Field(max_length=64, description="The `version` of the draft that was approved.")


class ImportPublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    drafts: list[ReviewedDraft] = Field(min_length=1, max_length=MAX_PUBLISH)


class ReviewedImportDraft(ReviewedDraft):
    chapter_id: uuid.UUID | None = Field(
        default=None,
        description="CHAPTER-MAP: the chapter shown for the draft (`null` = 챕터 없음). When sent, "
        "the request is refused with 409 `chapter-changed` if the draft's chapter is no longer "
        "that one (e.g. a book was added and the suggestion changed): reload and review again. "
        "Omitted = not checked.",
    )


class ImportPublishBody(ImportPublishRequest):
    drafts: list[ReviewedImportDraft] = Field(  # type: ignore[assignment]
        min_length=1, max_length=MAX_PUBLISH
    )
    approve: bool = Field(
        default=False,
        description="Approve and register the listed drafts in one step (QIMPORT-01-AC03, "
        '"선택한 문제 승인 및 등록"): every listed draft at the sent `version` is approved by '
        "the caller and registered in the same transaction; drafts that changed since or cannot "
        "be confirmed are returned in `refused`, untouched, and the others are registered. "
        "Without it only drafts approved beforehand are registered, all or nothing.",
    )


class ImportPublishedDraft(BaseModel):
    draft_id: uuid.UUID
    question_id: uuid.UUID


class ImportPublishResult(BaseModel):
    items: list[ImportPublishedDraft] = Field(description="In request order.")


RefusalReason = Literal["stale-draft", "not-publishable"]


class ImportRefusedDraft(BaseModel):
    draft_id: uuid.UUID
    reason: RefusalReason = Field(
        description="`stale-draft`: changed since the sent version (review it again); "
        "`not-publishable`: cannot be confirmed as it is (see the draft's `publish_errors`)."
    )


class ImportRegistrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    drafts: list[ReviewedImportDraft] = Field(
        min_length=1,
        max_length=MAX_REGISTRATION,
        description="The whole selection, each draft at the version on screen (the version the "
        "selection approves).",
    )


class ImportRegistrationRefusal(BaseModel):
    draft_id: uuid.UUID
    reason: RefusalReason = Field(
        description="`stale-draft`: changed since the sent version; `not-publishable`: cannot "
        "be confirmed as it is."
    )
    question_number: int | None = Field(description="Number printed in the source.")
    position: int = Field(description="0-based order in the source.")


class ImportRegistration(BaseModel):
    """A submitted selection being approved and registered on the server (QIMP-JOB)."""

    job_id: uuid.UUID = Field(description="The `question.import_register` job (`GET /jobs/{id}`).")
    import_id: uuid.UUID
    status: JobStatus = Field(description="queued | running | succeeded | failed | cancelled")
    error_code: str | None = Field(
        description="Why the job stopped, e.g. `workspace_unavailable` (archived workspace or "
        "lost editor role); drafts not processed by then stay unregistered."
    )
    total: int = Field(description="Distinct drafts submitted.")
    processed: int = Field(description="Drafts done (registered, already registered or refused).")
    registered: int = Field(description="Drafts this registration registered.")
    skipped: int = Field(description="Drafts that were registered already (nothing new).")
    refused: list[ImportRegistrationRefusal] = Field(
        description="Drafts left as they were, in submitted order."
    )
    created_at: datetime
    finished_at: datetime | None


class ImportPublishOutcome(ImportPublishResult):
    refused: list[ImportRefusedDraft] = Field(
        description="`approve` requests only (else empty): listed drafts left as they were, "
        "in request order."
    )


# --- dependencies -------------------------------------------------------------------------------


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


ImportRepo = Annotated[QuestionImportRepository, Depends(get_import_repository)]
QuestionRepo = Annotated[QuestionRepository, Depends(get_question_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]
PublisherDep = Annotated[JobPublisher | None, Depends(get_job_publisher)]


def _workspace(action: Action) -> Any:
    def dependency(
        workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> WorkspaceAccess:
        return authorize_workspace(repo, user.id, workspace_id, action, not_found_detail=NOT_FOUND)

    return Depends(dependency)


def _resource(resource_type: ResourceType, param: str, action: Action) -> Any:
    def dependency(resource_id: uuid.UUID, user: CurrentUser, repo: AccessRepo) -> ResourceAccess:
        try:
            return authorize_resource(repo, user.id, resource_type, resource_id, action)
        except HTTPException as exc:
            if exc.status_code == 404:
                raise HTTPException(status_code=404, detail=NOT_FOUND) from None
            raise

    def import_dependency(
        import_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return dependency(import_id, user, repo)

    def draft_dependency(
        draft_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
    ) -> ResourceAccess:
        return dependency(draft_id, user, repo)

    return Depends(import_dependency if param == "import_id" else draft_dependency)


ReadWorkspace = Annotated[WorkspaceAccess, _workspace(Action.READ)]
EditWorkspace = Annotated[WorkspaceAccess, _workspace(Action.QUESTION_EDIT)]
ReadImport = Annotated[
    ResourceAccess, _resource(ResourceType.QUESTION_IMPORT_RUN, "import_id", Action.READ)
]
EditImport = Annotated[
    ResourceAccess, _resource(ResourceType.QUESTION_IMPORT_RUN, "import_id", Action.QUESTION_EDIT)
]
EditDraft = Annotated[
    ResourceAccess, _resource(ResourceType.QUESTION_DRAFT, "draft_id", Action.QUESTION_EDIT)
]


# --- helpers ------------------------------------------------------------------------------------


def _run_out(run: RunRecord) -> ImportRun:
    return ImportRun(
        id=run.id,
        workspace_id=run.workspace_id,
        status=run.status,
        job_id=run.job_id,
        error_code=run.error_code,
        source_document_id=run.source_document_id,
        source_document_revision_id=run.source_document_revision_id,
        document_title=run.document_title,
        draft_count=run.draft_count,
        published_count=run.published_count,
        registration_job_id=run.registration_job_id,
        created_at=run.created_at,
        updated_at=run.updated_at,
        finished_at=run.finished_at,
    )


def _registration_out(record: RegistrationRecord) -> ImportRegistration:
    refused = [
        ImportRegistrationRefusal(
            draft_id=r.draft_id,
            reason=cast(RefusalReason, r.reason),
            question_number=r.question_number,
            position=r.position,
        )
        for r in record.refused
    ]
    return ImportRegistration(
        job_id=record.job_id,
        import_id=record.import_run_id,
        status=record.status,
        error_code=record.error_code,
        total=record.total,
        processed=record.total - record.pending,
        registered=record.registered,
        skipped=record.skipped,
        refused=refused,
        created_at=record.created_at,
        finished_at=record.finished_at,
    )


def draft_version(updated_at: datetime) -> str:
    """Opaque optimistic-concurrency token: the row's `updated_at` in microseconds (the
    `set_updated_at` trigger moves it on every write)."""
    micros = (updated_at - _EPOCH) // _MICROSECOND
    return format(micros, "x")


_MICROSECOND = datetime(1970, 1, 1, 0, 0, 0, 1, tzinfo=UTC) - _EPOCH


def _content(record: DraftRecord, draft: QuestionDraft) -> QuestionContent:
    return content_of(draft, is_multi_answer=record.is_multi_answer, rubric=record.rubric)


def _chapter_ref(chapter: BookChapter | None) -> DraftChapterRef | None:
    if chapter is None:
        return None
    return DraftChapterRef(
        id=chapter.id,
        title=chapter.title,
        document_id=chapter.document_id,
        document_title=chapter.document_title,
    )


def _displayed_chapters(
    items: list[ReviewedImportDraft],
) -> dict[uuid.UUID, uuid.UUID | None]:
    """The chapter the client showed per draft (first occurrence; only where it was sent)."""
    shown: dict[uuid.UUID, uuid.UUID | None] = {}
    for item in items:
        if "chapter_id" in item.model_fields_set:
            shown.setdefault(item.draft_id, item.chapter_id)
    return shown


def _refuse_changed_chapters(
    displayed: dict[uuid.UUID, uuid.UUID | None], current: dict[uuid.UUID, DraftChapter]
) -> None:
    """CHAPTER-MAP: never register under another chapter than the one on screen. A suggestion
    can change without a new draft version (a book added or corrected), so the client's view is
    compared here and the whole request is refused when it is outdated."""
    for draft_id, chapter in current.items():
        if draft_id not in displayed:
            continue
        now = chapter.chapter.id if chapter.chapter is not None else None
        if displayed[draft_id] != now:
            raise ProblemException(
                409,
                ProblemType.CHAPTER_CHANGED,
                detail="The chapter of a draft changed since it was shown. Reload the drafts, "
                "check their chapters and register again.",
            )


def _chapters_of(
    session: Session, run: RunRecord, drafts: list[DraftRecord]
) -> dict[uuid.UUID, DraftChapter]:
    return draft_chapters(
        DraftChapterRepository(session), run.workspace_id, run.source_document_revision_id, drafts
    )


def _draft_out(record: DraftRecord, chapter: DraftChapter | None = None) -> ImportDraft:
    draft = parse_payload(record.payload)
    content = _content(record, draft)
    blockers = publish_issues(content, record.validations, prefix=())
    return ImportDraft(
        id=record.id,
        import_id=record.import_run_id,
        run_id=record.generation_run_id,
        variation_type=cast(DraftVariation, draft.variation_type.value)
        if draft.variation_type is not None
        else None,
        acknowledged_codes=list(record.acknowledged_codes),
        position=record.position,
        question_number=record.question_number,
        question_type=draft.question_type.value,
        is_multi_answer=record.is_multi_answer,
        rubric=content.rubric,
        review_status=record.review_status,
        published_question_id=record.published_question_id,
        validations=[DraftValidation.model_validate(v) for v in record.validations],
        answer_missing=answer_missing(content),
        pages=pages(draft),
        publishable=not blockers.items,
        publish_errors=[
            DraftPublishError(
                field=".".join(str(p) for p in i["loc"]) or None,
                message=i["msg"],
            )
            for i in blockers.items
        ],
        payload=DraftPayload.model_validate(record.payload),
        version=draft_version(record.updated_at),
        reviewed_at=record.reviewed_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
        chapter=_chapter_ref(chapter.chapter) if chapter else None,
        chapter_choice=chapter.choice if chapter else "auto",
        chapter_match=chapter.match if chapter else None,
        source_chapter_title=chapter.source_title if chapter else None,
    )


def _reject_unstorable(body: BaseModel) -> None:
    bad = unstorable_strings(body.model_dump(mode="python"))
    if bad:
        issues = Issues()
        for loc in bad:
            issues.add(loc, "Text must not contain NUL characters or invalid code points.")
        issues.raise_if_any()


def _constraint_violation(repo: QuestionImportRepository) -> RequestValidationError:
    """The DB rejected the data (defensive: the rules above should catch it first)."""
    repo.rollback()
    return RequestValidationError(
        [
            {
                "loc": ("body",),
                "msg": "The request contains data that cannot be stored.",
                "type": "value_error",
            }
        ]
    )


def _publish_job(
    repo: QuestionImportRepository, publisher: JobPublisher | None, job_id: uuid.UUID | None
) -> None:
    """Hand a queued, unpublished job to the broker; failures are left to the worker's
    reconciler (the row stays queued with `published_at` null)."""
    if publisher is None or job_id is None:
        return
    job = repo.get_job(job_id)
    if job is None or job.status != "queued" or job.published_at is not None:
        return
    try:
        publisher.publish(
            JobMessage(
                job_id=job.id,
                job_type=job.job_type,
                schema_version=job.schema_version,
                workspace_id=job.workspace_id,
                created_by=job.created_by,
                idempotency_key=job.idempotency_key,
                payload=job.payload,
            )
        )
    except Exception as exc:
        logger.warning("job publish failed (reconciler will retry): %s", type(exc).__name__)
        repo.rollback()
        return
    repo.mark_published(job.id)
    repo.commit()


def _load_run(
    repo: QuestionImportRepository, run_id: uuid.UUID, *, lock: bool = False
) -> RunRecord:
    run = repo.get_run(run_id, lock=lock)
    if run is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return run


# --- routes: runs -------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/question-imports",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ImportRun,
    operation_id="createQuestionImport",
    responses=problem_responses(409),
)
def create_question_import(
    access: EditWorkspace,
    body: ImportCreate,
    repo: ImportRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Start extracting draft questions from a question paper (QIMPORT-01-AC01). 409
    `document-not-ready` while the paper is still processing (or failed).

    The server already starts the import of a question paper when its processing succeeds
    (QIMPORT-01-AC06), so this usually attaches: if the paper's active revision already has a
    run (started by the server or by anyone), that run is returned and nothing new is created.
    It creates a run for papers that have none (e.g. processed before QIMP-AUTO)."""
    scope = f"POST /workspaces/{access.workspace_id}/question-imports"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(access.user_id, scope, idempotency_key)
        stored = idempotency.find(access.user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            run_id = stored.body.get("id") if isinstance(stored.body, dict) else None
            repo.rollback()
            if run_id:
                found = repo.get_run(uuid.UUID(str(run_id)))
                _publish_job(repo, publisher, found.job_id if found else None)
            return response

    paper = repo.paper(access.workspace_id, body.document_id)
    if paper is None:
        # Same answer for a foreign and a missing document: no existence probing.
        raise RequestValidationError(
            [{"loc": ("body", "document_id"), "msg": "Unknown document.", "type": "value_error"}]
        )
    if paper.document_type != "question_paper":
        raise RequestValidationError(
            [
                {
                    "loc": ("body", "document_id"),
                    "msg": "Only question paper documents can be imported.",
                    "type": "value_error",
                }
            ]
        )
    if paper.status != "ready" or paper.active_revision_id is None:
        raise ProblemException(
            409,
            ProblemType.DOCUMENT_NOT_READY,
            detail="The question paper has not finished processing.",
        )

    existing = repo.run_for_revision(access.workspace_id, paper.id, paper.active_revision_id)
    if existing is not None:
        run = existing
    else:
        run_id = repo.create_run(
            workspace_id=access.workspace_id,
            actor_id=access.user_id,
            document_id=paper.id,
            revision_id=paper.active_revision_id,
        )
        run = _load_run(repo, run_id)
    result = _run_out(run)
    if idempotency_key is not None:
        idempotency.save(
            access.user_id,
            scope,
            idempotency_key,
            body_hash,
            status.HTTP_202_ACCEPTED,
            result.model_dump(mode="json"),
        )
    repo.commit()
    _publish_job(repo, publisher, run.job_id)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)


@router.get("/workspaces/{workspace_id}/question-imports", operation_id="listQuestionImports")
def list_question_imports(
    access: ReadWorkspace,
    repo: ImportRepo,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    document_id: Annotated[
        uuid.UUID | None,
        Query(description="Only the runs of this question paper (e.g. the server-started one)."),
    ] = None,
) -> ImportRunList:
    """The workspace's import runs, newest first."""
    runs = repo.list_runs(access.workspace_id, limit=limit, document_id=document_id)
    return ImportRunList(items=[_run_out(r) for r in runs])


@router.get("/question-imports/{import_id}", operation_id="getQuestionImport")
def get_question_import(access: ReadImport, repo: ImportRepo) -> ImportRun:
    return _run_out(_load_run(repo, access.resource_id))


@router.post(
    "/question-imports/{import_id}/retry",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ImportRun,
    operation_id="retryQuestionImport",
    responses=problem_responses(409),
)
def retry_question_import(
    access: EditImport,
    repo: ImportRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Run a failed (or cancelled) import again as a new job of the same run
    (QIMPORT-01-AC04). The new job keeps the drafts the failed one persisted and adds only the
    missing ones. 409 `import-not-retryable` unless the run failed or was cancelled."""
    user_id = access.workspace.user_id
    scope = f"POST /question-imports/{access.resource_id}/retry"
    body_hash = request_hash({})
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            repo.rollback()
            found = repo.get_run(access.resource_id)
            _publish_job(repo, publisher, found.job_id if found else None)
            return response

    run = _load_run(repo, access.resource_id, lock=True)
    if run.status not in {"failed", "cancelled"}:
        raise ProblemException(
            409,
            ProblemType.IMPORT_NOT_RETRYABLE,
            detail="Only a failed or cancelled import can be retried.",
        )
    if run.source_document_id is None or run.document_title is None:
        raise ProblemException(
            409, ProblemType.DOCUMENT_NOT_READY, detail="The question paper was deleted."
        )
    repo.retry_run(run, user_id)
    run = _load_run(repo, run.id)
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
    _publish_job(repo, publisher, run.job_id)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)


# --- routes: drafts -----------------------------------------------------------------------------


@router.get("/question-imports/{import_id}/drafts", operation_id="listQuestionImportDrafts")
def list_question_import_drafts(access: ReadImport, repo: ImportRepo) -> ImportDraftList:
    """The run's drafts in source order, with validations, provenance pages and answer flags.
    Drafts a failed job persisted are listed too (they are kept for the retry)."""
    run = _load_run(repo, access.resource_id)
    drafts = repo.list_drafts(access.resource_id)
    chapters = _chapters_of(repo.session, run, drafts)
    options = DraftChapterRepository(repo.session).book_chapters(run.workspace_id)
    return ImportDraftList(
        items=[_draft_out(d, chapters.get(d.id)) for d in drafts],
        chapters=[
            BookChapterOption(
                id=c.id,
                title=c.title,
                document_id=c.document_id,
                document_title=c.document_title,
                level=c.level,
            )
            for c in options
        ],
    )


@router.patch(
    "/question-drafts/{draft_id}",
    operation_id="updateQuestionDraft",
    responses=problem_responses(409),
)
def update_question_draft(
    access: EditDraft, body: QuestionDraftUpdate, repo: ImportRepo
) -> ImportDraft:
    """Edit a draft (e.g. enter the answer the source did not give), approve or reject it.
    409 `stale-draft` when `base_version` is outdated, 409 `draft-published` once published.

    Import and generation drafts share this route. A generation draft (M6.2) is re-validated
    against its run's source revision and passages on every request; `is_multi_answer: true`
    confirms a changed answer count and `question_type` a changed type (`acknowledged_codes`)."""
    _reject_unstorable(body)
    record = repo.get_draft(access.resource_id, lock=True)
    if record is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if body.base_version != draft_version(record.updated_at):
        raise ProblemException(
            409,
            ProblemType.STALE_DRAFT,
            detail="The draft changed since this edit started. Reload it and try again.",
        )
    if record.published_question_id is not None:
        raise ProblemException(
            409,
            ProblemType.DRAFT_PUBLISHED,
            detail="This draft is already registered as a question; edit the question instead.",
        )

    draft = parse_payload(record.payload)
    old = _content(record, draft)
    sent = body.model_fields_set
    question_type = body.question_type if body.question_type is not None else old.question_type
    is_multi = (
        body.is_multi_answer
        if body.is_multi_answer is not None
        else (old.is_multi_answer and question_type == "MCQ")
    )
    content = QuestionContent(
        question_type=question_type,
        stem=body.stem if body.stem is not None else old.stem,
        options=tuple((o.id, o.text) for o in body.options)
        if body.options is not None
        else old.options,
        correct_option_ids=(
            tuple(body.correct_option_ids) if body.correct_option_ids is not None else None
        )
        if "correct_option_ids" in sent
        else old.correct_option_ids,
        is_multi_answer=is_multi,
        accepted_answers=(
            tuple(body.accepted_answers) if body.accepted_answers is not None else None
        )
        if "accepted_answers" in sent
        else old.accepted_answers,
        explanation=body.explanation if "explanation" in sent else old.explanation,
        rubric=body.rubric if "rubric" in sent else old.rubric,
    )
    content_changed = content != old
    number_changed = "question_number" in sent and body.question_number != record.question_number
    # Validated per target status: a review-status change alone (reject, back to pending) does
    # not depend on the content rules; an edit must be storable; an approval must be publishable.
    if content_changed:
        content_issues(content, "DRAFT").raise_if_any()
    acknowledged = record.acknowledged_codes
    if record.source_type == "generation":
        # quiz_api.question_generation_review: the worker's rules, recomputed on every PATCH.
        acknowledged = acknowledged_codes(
            record, sent=sent, is_multi_answer=body.is_multi_answer, question_type=question_type
        )
        validations = generation_validations(repo.session, record, draft, content, acknowledged)
    elif content_changed:
        validations = recompute_validations(content, draft)
    else:
        validations = draft.validations
    validation_rows = [v.model_dump(mode="json") for v in validations]
    # Human approval covers exactly the reviewed content: any other change returns an approved
    # draft to pending unless this same request approves the new content.
    target: ReviewStatus = (
        body.review_status
        if body.review_status is not None
        else (
            "pending"
            if (content_changed or number_changed) and record.review_status == "approved"
            else record.review_status
        )
    )
    if target == "approved":
        publish_issues(content, validation_rows).raise_if_any()

    try:
        payload = with_review(draft, content, validations, target)
    except ValidationError:
        # Never the validation text: it can quote the draft content.
        raise RequestValidationError(
            [{"loc": ("body",), "msg": "The draft is not valid.", "type": "value_error"}]
        ) from None
    values: dict[str, Any] = {
        "question_type": content.question_type,
        "is_multi_answer": content.is_multi_answer,
        "rubric": content.rubric,
        "validations": validation_rows,
        "acknowledged_codes": list(acknowledged),
    }
    if "question_number" in sent:
        values["question_number"] = body.question_number
    if "chapter_id" in sent:
        if record.source_type != "import":
            raise RequestValidationError(
                [
                    {
                        "loc": ("body", "chapter_id"),
                        "msg": "Only import drafts have a chapter.",
                        "type": "value_error",
                    }
                ]
            )
        if body.chapter_id is not None:
            chapters_repo = DraftChapterRepository(repo.session)
            chapters_repo.lock_documents_of(record.workspace_id, [body.chapter_id])
            current = chapters_repo.current_book_chapters(record.workspace_id, [body.chapter_id])
            found = current.get(body.chapter_id)
            if found is None or found.id != body.chapter_id:
                raise RequestValidationError(
                    [
                        {
                            "loc": ("body", "chapter_id"),
                            "msg": "Unknown chapter: use a chapter of a book's current revision.",
                            "type": "value_error",
                        }
                    ]
                )
        values["chapter_id"] = body.chapter_id
        values["chapter_manual"] = True
    try:
        repo.update_draft(record.id, **values)
        repo.mark_draft_reviewed(
            record.id,
            actor_id=access.workspace.user_id,
            review_status=target,
            payload=payload.model_dump(mode="json"),
        )
        updated = repo.get_draft(record.id)
        assert updated is not None  # noqa: S101 - locked above
        chapter: DraftChapter | None = None
        if updated.import_run_id is not None:
            run = _load_run(repo, updated.import_run_id)
            chapter = _chapters_of(repo.session, run, [updated]).get(updated.id)
        repo.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(repo) from None
    return _draft_out(updated, chapter)


@router.post(
    "/question-imports/{import_id}/publish",
    operation_id="publishQuestionImportDrafts",
    responses=problem_responses(409),
)
def publish_question_import_drafts(
    access: EditImport,
    body: ImportPublishBody,
    repo: ImportRepo,
    questions: QuestionRepo,
) -> ImportPublishOutcome:
    """Register exactly these drafts as CONFIRMED questions (QIMPORT-01-AC03).

    Each item names the draft and the `version` the reviewer saw. An id that is not a draft of
    this import is 404 (nothing changes). Already published drafts return their question whatever
    version is sent (idempotent replay).

    Without `approve` (drafts approved beforehand through PATCH) it is all or nothing: a draft
    that changed since (another editor's edit, approval or rejection) is 409 `stale-draft`; a
    draft that is not approved is 409 `draft-not-approved`; a draft that cannot be confirmed is
    422.

    With `approve` the request is the human selection itself ("선택한 문제 승인 및 등록"): each
    listed draft still at the sent version that can be confirmed is approved by the caller
    (`reviewed_by`/`reviewed_at`; a draft approved earlier keeps its approval) and registered,
    in one transaction. A draft that changed since or cannot be confirmed (e.g. an MCQ without
    an answer) is left untouched and listed in `refused`; it is never registered silently."""
    run = _load_run(repo, access.resource_id)
    user_id = access.workspace.user_id
    versions: dict[uuid.UUID, str] = {}
    for item in body.drafts:
        versions.setdefault(item.draft_id, item.version)
    requested = list(versions)
    drafts = {d.id: d for d in repo.lock_drafts(run.id, requested)}
    if len(drafts) != len(requested):
        raise HTTPException(status_code=404, detail="Draft not found.")

    pending = [drafts[d] for d in requested if drafts[d].published_question_id is None]
    plans: list[tuple[DraftRecord, QuestionDraft, QuestionContent]] = []
    refused: list[ImportRefusedDraft] = []
    if body.approve:
        for record in pending:
            if versions[record.id] != draft_version(record.updated_at):
                refused.append(ImportRefusedDraft(draft_id=record.id, reason="stale-draft"))
                continue
            draft = parse_payload(record.payload)
            content = _content(record, draft)
            if publish_issues(content, record.validations).items:
                refused.append(ImportRefusedDraft(draft_id=record.id, reason="not-publishable"))
                continue
            plans.append((record, draft, content))
    else:
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
        for index, record in enumerate(pending):
            draft = parse_payload(record.payload)
            content = _content(record, draft)
            blockers = publish_issues(content, record.validations, prefix=("body", "drafts", index))
            issues.items.extend(blockers.items)
            plans.append((record, draft, content))
        issues.raise_if_any()

    mapping = {d.id: d.published_question_id for d in drafts.values()}
    # CHAPTER-MAP: the chapter on screen. The books are locked FOR SHARE first (question lock
    # order), so the chapter read here is the current one until this transaction ends.
    chapter_repo = DraftChapterRepository(repo.session)
    shown = _chapters_of(repo.session, run, [r for r, _, _ in plans])
    _refuse_changed_chapters(_displayed_chapters(body.drafts), shown)
    chapter_repo.lock_documents_of(
        run.workspace_id, [c.chapter.id for c in shown.values() if c.chapter is not None]
    )
    current = chapter_repo.current_book_chapters(
        run.workspace_id, [c.chapter.id for c in shown.values() if c.chapter is not None]
    )

    def chapter_for(record: DraftRecord) -> uuid.UUID | None:
        found = shown.get(record.id)
        if found is None or found.chapter is None:
            return None
        resolved = current.get(found.chapter.id)
        return resolved.id if resolved is not None else None

    try:
        for record, draft, content in plans:
            if record.review_status != "approved":
                # The selection is the approval of exactly the content at the sent version.
                repo.mark_draft_reviewed(
                    record.id,
                    actor_id=user_id,
                    review_status="approved",
                    payload=with_review(draft, content, draft.validations, "approved").model_dump(
                        mode="json"
                    ),
                )
            question_id = questions.create(
                workspace_id=run.workspace_id,
                actor_id=user_id,
                content=content,
                status="CONFIRMED",
                chapter_id=chapter_for(record),
                question_number=record.question_number,
                sources=[],
                source_revisions={},
                origin="import",
            )
            found = source_pages(draft)
            repo.insert_import_source(
                workspace_id=run.workspace_id,
                question_id=question_id,
                run_id=run.id,
                document_id=run.source_document_id,
                revision_id=run.source_document_revision_id,
                page_start=found.page_start,
                page_end=found.page_end,
                block_ids=found.block_ids,
                locations=found.locations,
            )
            # The approval (reviewer, time, content) stays as it was; only the link is added.
            repo.update_draft(record.id, published_question_id=question_id)
            mapping[record.id] = question_id
        if plans:
            repo.record_published(run.workspace_id, user_id, run.id, len(plans))
        repo.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(repo) from None
    except ValidationError:
        # A stored payload that no longer validates; never the validation text (it quotes it).
        repo.rollback()
        raise RequestValidationError(
            [{"loc": ("body",), "msg": "A draft is not valid.", "type": "value_error"}]
        ) from None
    return ImportPublishOutcome(
        items=[
            ImportPublishedDraft(draft_id=d, question_id=q)
            for d in requested
            if (q := mapping[d]) is not None
        ],
        refused=refused,
    )


# --- routes: server-side registration (QIMP-JOB) --------------------------------------------------


def _registration_item(record: DraftRecord, version: str) -> RegistrationItem:
    """What the submitted draft is: already registered, changed since it was selected, not
    confirmable, or to be registered by the job."""
    if record.published_question_id is not None:
        return RegistrationItem(
            record.id, version, "skipped", question_id=record.published_question_id
        )
    if version != draft_version(record.updated_at):
        return RegistrationItem(record.id, version, "refused", reason="stale-draft")
    try:
        content = _content(record, parse_payload(record.payload))
    except ValidationError:
        return RegistrationItem(record.id, version, "refused", reason="not-publishable")
    if publish_issues(content, record.validations).items:
        return RegistrationItem(record.id, version, "refused", reason="not-publishable")
    return RegistrationItem(record.id, version, "pending")


@router.post(
    "/question-imports/{import_id}/registrations",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ImportRegistration,
    operation_id="registerQuestionImportDrafts",
    responses=problem_responses(409),
)
def register_question_import_drafts(
    access: EditImport,
    body: ImportRegistrationRequest,
    repo: ImportRepo,
    idempotency: IdempotencyStoreDep,
    publisher: PublisherDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Approve and register the whole selection on the server (QIMPORT-01-AC07, "선택한 문제 승인
    및 등록"): the request records every listed draft with the version on screen and starts a
    `question.import_register` job, which registers them in batches whether or not the page stays
    open. Same rules as `publish` with `approve: true`: the job's user (the caller) approves each
    draft still at the sent version that can be confirmed; drafts changed since (`stale-draft`) or
    not confirmable (`not-publishable`) are refused and left as they were; drafts registered
    already are skipped. Idempotent per draft (a re-delivered job never registers twice).

    An id that is not a draft of this import is 404 (nothing recorded). 409
    `import-registration-running` while the previous registration of this import is still queued
    or running (follow `registration_job_id`). The job re-checks the workspace on every batch: an
    archived workspace or a lost editor role stops it (`workspace_unavailable`)."""
    user_id = access.workspace.user_id
    scope = f"POST /question-imports/{access.resource_id}/registrations"
    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            job_id = stored.body.get("job_id") if isinstance(stored.body, dict) else None
            repo.rollback()
            if job_id:
                _publish_job(repo, publisher, uuid.UUID(str(job_id)))
            return response

    run = _load_run(repo, access.resource_id, lock=True)
    if run.registration_job_id is not None:
        previous = repo.get_job(run.registration_job_id)
        if previous is not None and previous.status in {"queued", "running"}:
            raise ProblemException(
                409,
                ProblemType.IMPORT_REGISTRATION_RUNNING,
                detail="The previous registration of this import is still running.",
            )
    versions: dict[uuid.UUID, str] = {}
    for item in body.drafts:
        versions.setdefault(item.draft_id, item.version)
    requested = list(versions)
    drafts = {d.id: d for d in repo.lock_drafts(run.id, requested)}
    if len(drafts) != len(requested):
        raise HTTPException(status_code=404, detail="Draft not found.")

    items = [_registration_item(drafts[d], versions[d]) for d in requested]
    # CHAPTER-MAP: register each draft under the chapter on screen (the job resolves it to the
    # book's then-current revision).
    shown = _chapters_of(
        repo.session, run, [drafts[i.draft_id] for i in items if i.state == "pending"]
    )
    _refuse_changed_chapters(_displayed_chapters(body.drafts), shown)
    items = [
        replace(i, chapter_id=c.chapter.id)
        if (c := shown.get(i.draft_id)) is not None and c.chapter is not None
        else i
        for i in items
    ]
    try:
        job_id = repo.create_registration(run, user_id, items)
        record = repo.registration(run.id, job_id)
    except (IntegrityError, DataError):
        raise _constraint_violation(repo) from None
    assert record is not None  # noqa: S101 - inserted above
    result = _registration_out(record)
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
    _publish_job(repo, publisher, job_id)
    return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_202_ACCEPTED)


@router.get(
    "/question-imports/{import_id}/registrations/{registration_id}",
    operation_id="getQuestionImportRegistration",
)
def get_question_import_registration(
    access: ReadImport, registration_id: Annotated[uuid.UUID, Path()], repo: ImportRepo
) -> ImportRegistration:
    """Progress of a registration of this import (`registration_id` = its `job_id`):
    processed/total and the refused drafts."""
    record = repo.registration(access.resource_id, registration_id)
    if record is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return _registration_out(record)
