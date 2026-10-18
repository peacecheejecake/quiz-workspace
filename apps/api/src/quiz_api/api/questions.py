"""Question bank API (M4.2a, QBANK-01; docs/architecture.md §6, docs/questions.md §2/§4).

    POST   /workspaces/{id}/questions          editor+; question + revision 1 (+ sources), 201;
                                               `Idempotency-Key` aware
    GET    /workspaces/{id}/questions          any member; filters + keyset pagination
    GET    /questions/{id}                     any member; active revision, sources, revisions
    GET    /questions/{id}/revisions/{rev_id}  any member; one immutable revision (history)
    PATCH  /questions/{id}                     editor+; `base_revision_id` optimistic concurrency;
                                               content change -> new revision; status transitions
    DELETE /questions/{id}                     editor+; soft delete, 204, then 404 everywhere

Authorization: every route resolves the workspace from the DB (A1.3). Unknown, soft-deleted and
foreign questions/workspaces answer the same 404 body (QBANK-01-AC04); members whose role cannot
edit get 403 `insufficient-role`; writes in an archived workspace get 403 `workspace-archived`
(reads stay allowed).

Answer visibility (decision): the bank is the authoring view, so every member (viewer included)
receives answers, explanations and rubrics here. docs/questions.md "공유 Workspace" allows even
share-link viewers to read published answers/explanations; hiding answers before submission is
the practice API's job (M5.2, `POST /questions/{id}/practice-sessions`), not the bank's.

Listing (decision, tests/e2e/fixtures/questions.ts A1): by default only CONFIRMED questions are
listed (manual DRAFT and ARCHIVED ones on request via `publication_status`); import/generation
drafts (`question_drafts`) are never questions and never listed here.

Content rules: quiz_api.question_rules (mirrors the DB CHECKs, 422 with body field paths before
anything is written). Option ids are opaque client-chosen strings kept verbatim across edits;
grading uses them, never positions (questions.md §4.3).

PATCH semantics: a partial update merged over the current question. Omitted fields keep their
value; `null` clears a nullable field. `base_revision_id` must be the active revision, otherwise
409 `stale-revision` and nothing changes. A content change (stem/options/answers/explanation/
rubric) appends revision n+1 and moves the active pointer; history is never modified. Changing
`question_type` is refused (old revisions and attempts would be reinterpreted): create a new
question instead. Metadata (`chapter_id`, `question_number`, `sources`, `publication_status`)
changes without a new revision. Transitions: DRAFT -> CONFIRMED (content must then be complete),
CONFIRMED <-> ARCHIVED.

Chapter link (decision): `chapter_id` is a `chapters.id` (a document outline node, A3). Chapters
are revision-scoped, so on save it must belong to the *active* revision of a live document of
this workspace (an unchanged chapter_id on PATCH is not re-checked). When a document revision is
published (M3.4), the publish transaction must remap `questions.chapter_id` from the old
revision's chapter to the new revision's chapter with the same `(document_id, section_key)`
(`chapters_revision_section_key`), or set it to null when that section no longer exists.
Sources pin `document_revision_id` = the document's active revision at save time (provenance)
and are not remapped.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from fastapi.exceptions import RequestValidationError
from psycopg import errors as pg_errors
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    Strict,
    TypeAdapter,
    ValidationError,
    field_validator,
)
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError
from sqlalchemy.orm import Session

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
from quiz_api.question_rules import (
    MAX_ACCEPTED_ANSWERS,
    MAX_LONG_TEXT,
    MAX_OPTION_ID,
    MAX_OPTION_TEXT,
    MAX_OPTIONS,
    MAX_STEM,
    Issues,
    PublicationStatus,
    QuestionContent,
    QuestionType,
    content_issues,
    storable,
    transition_allowed,
    unstorable_strings,
)
from quiz_api.repositories.idempotency import IdempotencyStore
from quiz_api.repositories.questions import (
    ListCursor,
    QuestionFilter,
    QuestionRecord,
    QuestionRepository,
    RevisionRecord,
    SourceInputRecord,
)

router = APIRouter(tags=["questions"], responses=problem_responses(503))

# One body for every invisible question/workspace on the question routes, so a non-member
# cannot tell a foreign question from a missing one (QBANK-01-AC04).
NOT_FOUND = "Not found."
MAX_SOURCES = 20
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 100
INT4_MAX = 2147483647


# --- schemas ------------------------------------------------------------------------------------


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        max_length=MAX_OPTION_ID,
        description="Opaque, client-chosen id (no whitespace, unique in the question). Grading "
        "and practice use it; keep it when editing the option.",
    )
    text: str = Field(max_length=MAX_OPTION_TEXT)


class QuestionSourceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: uuid.UUID = Field(description="A live document of this workspace.")
    page_start: int | None = Field(default=None, ge=1, le=INT4_MAX)
    page_end: int | None = Field(
        default=None, ge=1, le=INT4_MAX, description="Defaults to `page_start`."
    )


class QuestionSource(BaseModel):
    document_id: uuid.UUID | None
    document_revision_id: uuid.UUID | None = Field(
        description="The document revision that was active when the source was saved."
    )
    page_start: int | None
    page_end: int | None


class QuestionRevision(BaseModel):
    id: uuid.UUID
    version: int
    stem: str
    options: list[QuestionOption]
    correct_option_ids: list[str] | None = Field(description="null = answer unknown.")
    accepted_answers: list[str] | None = Field(description="null = not auto-gradable.")
    is_multi_answer: bool
    explanation: str | None
    rubric: str | None
    created_at: datetime


class ChapterRef(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    title: str


class Question(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    question_type: QuestionType
    publication_status: PublicationStatus
    origin: str = Field(description="manual | import | generation")
    chapter_id: uuid.UUID | None = Field(description="Document outline node (`chapters.id`).")
    chapter: ChapterRef | None
    question_number: int | None = Field(description="Display number (`12번`), not unique.")
    revision: QuestionRevision = Field(description="The active revision.")
    sources: list[QuestionSource]
    created_at: datetime
    updated_at: datetime


class RevisionSummary(BaseModel):
    id: uuid.UUID
    version: int
    created_at: datetime


class QuestionLineage(BaseModel):
    """Where a generated variant comes from (questions.md §5)."""

    parent_question_id: uuid.UUID
    source_question_revision_id: uuid.UUID = Field(
        description="The parent's revision the variant was generated from."
    )
    variation_type: str = Field(description="PARAPHRASE | INVERT_POLARITY | ANALOGOUS_CONCEPT")
    generation_run_id: uuid.UUID | None


class QuestionDetail(Question):
    revisions: list[RevisionSummary] = Field(description="Every revision, newest first.")
    lineage: QuestionLineage | None = Field(
        default=None,
        description="Set for a question registered from a generated draft (origin `generation`).",
    )


class QuestionList(BaseModel):
    items: list[Question]
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")


_LongText = Field(default=None, max_length=MAX_LONG_TEXT)


class QuestionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_type: QuestionType
    stem: str = Field(max_length=MAX_STEM)
    options: list[QuestionOption] = Field(
        default_factory=list, max_length=MAX_OPTIONS, description="MCQ only."
    )
    correct_option_ids: list[str] | None = Field(
        default=None, max_length=MAX_OPTIONS, description="MCQ only; required when CONFIRMED."
    )
    is_multi_answer: bool = False
    accepted_answers: list[str] | None = Field(
        default=None, max_length=MAX_ACCEPTED_ANSWERS, description="SHORT_ANSWER only."
    )
    explanation: str | None = _LongText
    rubric: str | None = _LongText
    chapter_id: uuid.UUID | None = None
    question_number: int | None = Field(default=None, ge=1, le=INT4_MAX)
    sources: list[QuestionSourceInput] = Field(default_factory=list, max_length=MAX_SOURCES)
    publication_status: PublicationStatus = Field(
        default="CONFIRMED", description="DRAFT or CONFIRMED (ARCHIVED is not a creation state)."
    )


# Fields of QuestionUpdate that cannot be cleared with an explicit null.
_NOT_NULLABLE = (
    "question_type",
    "stem",
    "options",
    "is_multi_answer",
    "sources",
    "publication_status",
)


class QuestionUpdate(BaseModel):
    """Partial update: omitted fields are kept, `null` clears a nullable field."""

    model_config = ConfigDict(extra="forbid")

    base_revision_id: uuid.UUID = Field(description="The active revision the edit is based on.")
    question_type: QuestionType | None = Field(
        default=None, description="Must equal the current type (changing it is refused)."
    )
    stem: str | None = Field(default=None, max_length=MAX_STEM)
    options: list[QuestionOption] | None = Field(default=None, max_length=MAX_OPTIONS)
    correct_option_ids: list[str] | None = Field(default=None, max_length=MAX_OPTIONS)
    is_multi_answer: bool | None = None
    accepted_answers: list[str] | None = Field(default=None, max_length=MAX_ACCEPTED_ANSWERS)
    explanation: str | None = _LongText
    rubric: str | None = _LongText
    chapter_id: uuid.UUID | None = None
    question_number: int | None = Field(default=None, ge=1, le=INT4_MAX)
    sources: list[QuestionSourceInput] | None = Field(default=None, max_length=MAX_SOURCES)
    publication_status: PublicationStatus | None = None

    @field_validator(*_NOT_NULLABLE, mode="before")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("may be omitted but not null")
        return value


# --- dependencies -------------------------------------------------------------------------------


def get_question_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> QuestionRepository:
    return QuestionRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


QuestionRepo = Annotated[QuestionRepository, Depends(get_question_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


def _uniform_404(exc: HTTPException) -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND) if exc.status_code == 404 else exc


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
        try:
            return authorize_resource(repo, user.id, ResourceType.QUESTION, question_id, action)
        except HTTPException as exc:
            raise _uniform_404(exc) from None

    return Depends(dependency)


ReadWorkspace = Annotated[WorkspaceAccess, _workspace(Action.READ)]
EditWorkspace = Annotated[WorkspaceAccess, _workspace(Action.QUESTION_EDIT)]
ReadQuestion = Annotated[ResourceAccess, _question(Action.READ)]
EditQuestion = Annotated[ResourceAccess, _question(Action.QUESTION_EDIT)]


# --- helpers ------------------------------------------------------------------------------------


def _revision_out(rev: RevisionRecord) -> QuestionRevision:
    return QuestionRevision(
        id=rev.id,
        version=rev.version,
        stem=rev.stem,
        options=[QuestionOption(id=o["id"], text=o["text"]) for o in rev.options],
        correct_option_ids=rev.correct_option_ids,
        accepted_answers=rev.accepted_answers,
        is_multi_answer=rev.is_multi_answer,
        explanation=rev.explanation,
        rubric=rev.rubric,
        created_at=rev.created_at,
    )


def _out(q: QuestionRecord) -> Question:
    return Question(
        id=q.id,
        workspace_id=q.workspace_id,
        question_type=q.question_type,
        publication_status=q.publication_status,
        origin=q.origin,
        chapter_id=q.chapter_id,
        chapter=ChapterRef(
            id=q.chapter.id, document_id=q.chapter.document_id, title=q.chapter.title
        )
        if q.chapter
        else None,
        question_number=q.question_number,
        revision=_revision_out(q.revision),
        sources=[
            QuestionSource(
                document_id=s.document_id,
                document_revision_id=s.document_revision_id,
                page_start=s.page_start,
                page_end=s.page_end,
            )
            for s in q.sources
        ],
        created_at=q.created_at,
        updated_at=q.updated_at,
    )


def _content(
    question_type: QuestionType,
    stem: str,
    options: list[QuestionOption],
    correct_option_ids: list[str] | None,
    is_multi_answer: bool,
    accepted_answers: list[str] | None,
    explanation: str | None,
    rubric: str | None,
) -> QuestionContent:
    return QuestionContent(
        question_type=question_type,
        stem=stem,
        options=tuple((o.id, o.text) for o in options),
        correct_option_ids=tuple(correct_option_ids) if correct_option_ids is not None else None,
        is_multi_answer=is_multi_answer,
        accepted_answers=tuple(accepted_answers) if accepted_answers is not None else None,
        explanation=explanation,
        rubric=rubric,
    )


def _sources(
    repo: QuestionRepository,
    workspace_id: uuid.UUID,
    sources: list[QuestionSourceInput],
    issues: Issues,
) -> tuple[list[SourceInputRecord], dict[uuid.UUID, uuid.UUID | None]]:
    live = repo.live_documents(workspace_id, (s.document_id for s in sources))
    out: list[SourceInputRecord] = []
    for i, s in enumerate(sources):
        if s.document_id not in live:
            # Same message for foreign and missing documents: no existence probing.
            issues.add(("sources", i, "document_id"), "Unknown document.")
        start, end = s.page_start, s.page_end
        if start is None and end is not None:
            issues.add(("sources", i, "page_start"), "Give page_start together with page_end.")
        if start is not None and end is None:
            end = start
        if start is not None and end is not None and end < start:
            issues.add(("sources", i, "page_end"), "page_end must not be before page_start.")
        out.append(SourceInputRecord(s.document_id, start, end))
    return out, live


def _check_chapter(
    repo: QuestionRepository, workspace_id: uuid.UUID, chapter_id: uuid.UUID, issues: Issues
) -> None:
    if not repo.chapter_is_current(workspace_id, chapter_id):
        issues.add(
            ("chapter_id",),
            "Unknown chapter: use an outline node of a document's current revision.",
        )


# Lock conflicts that a retry resolves: a deadlock victim or a serialization failure. The lock
# order (documents, then the question) avoids the known cycle with a publish; this is the safety
# net for anything else.
_RETRYABLE_LOCK_ERRORS = (pg_errors.DeadlockDetected, pg_errors.SerializationFailure)
MAX_LOCK_ATTEMPTS = 3


def _with_lock_retry[T](repo: QuestionRepository, attempt: Callable[[], T]) -> T:
    """Run `attempt` in a SAVEPOINT; on a deadlock / serialization failure roll back to it
    (releasing the locks it took, keeping the request's authorization locks) and run it again,
    at most MAX_LOCK_ATTEMPTS times, then 503."""
    for n in range(1, MAX_LOCK_ATTEMPTS + 1):
        try:
            with repo.savepoint():
                return attempt()
        except DBAPIError as exc:
            if not isinstance(exc.orig, _RETRYABLE_LOCK_ERRORS):
                raise
            if n == MAX_LOCK_ATTEMPTS:
                repo.rollback()
                raise HTTPException(
                    status_code=503,
                    detail="The question is busy (a document is being published). Try again.",
                    headers={"Retry-After": "1"},
                ) from None
    raise AssertionError("unreachable")  # pragma: no cover


def _constraint_violation(
    repo: QuestionRepository, loc: tuple[str, ...] = ("body",)
) -> RequestValidationError:
    """The DB rejected the statement's data (a constraint, e.g. a chapter/document deleted
    concurrently, or a value it cannot store). Defensive: input rules should catch these first.
    The message never echoes input."""
    repo.rollback()
    return RequestValidationError(
        [
            {
                "loc": loc,
                "msg": "The request contains data that cannot be stored.",
                "type": "value_error",
            }
        ]
    )


def _reject_unstorable(body: BaseModel) -> None:
    """422 for strings PostgreSQL cannot hold (NUL, lone surrogates) anywhere in the body; runs
    before hashing/storing so such input never reaches the DB or the idempotency store."""
    bad = unstorable_strings(body.model_dump(mode="python"))
    if bad:
        issues = Issues()
        for loc in bad:
            issues.add(loc, "Text must not contain NUL characters or invalid code points.")
        issues.raise_if_any()


def _encode_cursor(cursor: ListCursor) -> str:
    raw = json.dumps(
        [cursor.sort_order, cursor.number, cursor.created_at.isoformat(), str(cursor.id)],
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


_Int4 = Annotated[int, Strict(), Field(ge=-INT4_MAX - 1, le=INT4_MAX)]
# [sort_order, question number (or UNNUMBERED), created_at, id] as written by `_encode_cursor`.
_CURSOR = TypeAdapter(tuple[_Int4, _Int4, AwareDatetime, uuid.UUID])
MAX_CURSOR = 500


def _invalid_cursor() -> RequestValidationError:
    return RequestValidationError(
        [{"loc": ("query", "cursor"), "msg": "Invalid cursor.", "type": "value_error"}]
    )


def _decode_cursor(value: str) -> ListCursor:
    """Opaque cursor -> keyset position; anything not produced by `_encode_cursor` is a 422."""
    if len(value) > MAX_CURSOR:
        raise _invalid_cursor()
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii") + b"=" * (-len(value) % 4))
        sort_order, number, created_at, qid = _CURSOR.validate_json(raw)
    except (binascii.Error, UnicodeError, ValueError, ValidationError):
        raise _invalid_cursor() from None
    return ListCursor(sort_order, number, created_at, qid)


def _scope(workspace_id: uuid.UUID) -> str:
    return f"POST /workspaces/{workspace_id}/questions"


# --- routes -------------------------------------------------------------------------------------


@router.post(
    "/workspaces/{workspace_id}/questions",
    status_code=status.HTTP_201_CREATED,
    response_model=Question,
    operation_id="createQuestion",
    responses=problem_responses(409),
)
def create_question(
    access: EditWorkspace,
    body: QuestionCreate,
    repo: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Register a question with revision 1 (QBANK-01-AC02). CONFIRMED (default) requires
    complete content (an MCQ needs >= 2 options and a correct option); DRAFT may be incomplete.
    """
    _reject_unstorable(body)
    scope, body_hash = _scope(access.workspace_id), request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(access.user_id, scope, idempotency_key)
        stored = idempotency.find(access.user_id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, body_hash)

    issues = Issues()
    if body.publication_status == "ARCHIVED":
        issues.add(("publication_status",), "New questions are DRAFT or CONFIRMED.")
    content = _content(
        body.question_type,
        body.stem,
        body.options,
        body.correct_option_ids,
        body.is_multi_answer,
        body.accepted_answers,
        body.explanation,
        body.rubric,
    )
    issues.items.extend(content_issues(content, body.publication_status).items)

    def attempt() -> uuid.UUID:
        # Same lock order as an edit: the chapter's and the sources' documents first; the chapter
        # check and the cited revisions are then read under those locks (fresh on every retry).
        repo.lock_documents(
            access.workspace_id,
            chapter_ids=[body.chapter_id],
            document_ids=[s.document_id for s in body.sources],
        )
        found = Issues()
        found.items.extend(issues.items)
        if body.chapter_id is not None:
            _check_chapter(repo, access.workspace_id, body.chapter_id, found)
        sources, revisions = _sources(repo, access.workspace_id, body.sources, found)
        found.raise_if_any()
        return repo.create(
            workspace_id=access.workspace_id,
            actor_id=access.user_id,
            content=content,
            status=body.publication_status,
            chapter_id=body.chapter_id,
            question_number=body.question_number,
            sources=sources,
            source_revisions=revisions,
        )

    try:
        question_id = _with_lock_retry(repo, attempt)
        created = repo.get(question_id)
        assert created is not None  # noqa: S101 - inserted above in this transaction
        result = _out(created)
        if idempotency_key is not None:
            idempotency.save(
                access.user_id,
                scope,
                idempotency_key,
                body_hash,
                status.HTTP_201_CREATED,
                result.model_dump(mode="json"),
            )
        repo.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(repo) from None
    return result


@router.get("/workspaces/{workspace_id}/questions", operation_id="listQuestions")
def list_questions(
    access: ReadWorkspace,
    repo: QuestionRepo,
    publication_status: Annotated[
        list[PublicationStatus] | None,
        Query(description="Repeatable; default CONFIRMED only."),
    ] = None,
    question_type: Annotated[QuestionType | None, Query()] = None,
    chapter_id: Annotated[uuid.UUID | None, Query()] = None,
    document_id: Annotated[
        uuid.UUID | None, Query(description="Questions with a source in this document.")
    ] = None,
    q: Annotated[
        str | None, Query(max_length=200, description="Case-insensitive stem search.")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR)] = None,
) -> QuestionList:
    """The bank (any member, answers included): live questions in bank order (sort order,
    question number, registration order)."""
    if q is not None and not storable(q):
        raise RequestValidationError(
            [{"loc": ("query", "q"), "msg": "Invalid search text.", "type": "value_error"}]
        )
    flt = QuestionFilter(
        statuses=sorted(set(publication_status or ["CONFIRMED"])),
        question_type=question_type,
        chapter_id=chapter_id,
        document_id=document_id,
        text=q.strip() if q and q.strip() else None,
    )
    after = _decode_cursor(cursor) if cursor else None
    try:
        items, next_cursor = repo.list_page(access.workspace_id, flt, limit=limit, after=after)
    except DataError:
        raise _constraint_violation(repo, ("query",)) from None
    return QuestionList(
        items=[_out(i) for i in items],
        next_cursor=_encode_cursor(next_cursor) if next_cursor else None,
    )


def _load(
    repo: QuestionRepository, question_id: uuid.UUID, *, lock: bool = False
) -> QuestionRecord:
    found = repo.get(question_id, lock=lock)
    if found is None:  # soft-deleted between the authorization lookup and this read
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return found


@router.get("/questions/{question_id}", operation_id="getQuestion")
def get_question(access: ReadQuestion, repo: QuestionRepo) -> QuestionDetail:
    found = _load(repo, access.resource_id)
    lineage = repo.lineage_of(found.id)
    return QuestionDetail(
        **_out(found).model_dump(),
        revisions=[
            RevisionSummary(id=r.id, version=r.version, created_at=r.created_at)
            for r in repo.revisions(found.id)
        ],
        lineage=QuestionLineage(
            parent_question_id=lineage.parent_question_id,
            source_question_revision_id=lineage.source_question_revision_id,
            variation_type=lineage.variation_type,
            generation_run_id=lineage.generation_run_id,
        )
        if lineage is not None
        else None,
    )


@router.get("/questions/{question_id}/revisions/{revision_id}", operation_id="getQuestionRevision")
def get_question_revision(
    access: ReadQuestion,
    revision_id: Annotated[uuid.UUID, Path()],
    repo: QuestionRepo,
) -> QuestionRevision:
    """One immutable revision of the question (history; attempts point at these)."""
    rev = repo.get_revision(access.resource_id, revision_id)
    if rev is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return _revision_out(rev)


@router.patch(
    "/questions/{question_id}",
    operation_id="updateQuestion",
    responses=problem_responses(409),
)
def update_question(access: EditQuestion, body: QuestionUpdate, repo: QuestionRepo) -> Question:
    """Edit (QBANK-01-AC03): a content change appends a revision and keeps option ids; a stale
    `base_revision_id` is 409 `stale-revision`."""
    _reject_unstorable(body)
    question_id = access.resource_id

    def attempt() -> QuestionRecord:
        # Lock order, as a publish: the documents of the current and the requested chapter and of
        # the cited sources (QuestionRepository.lock_documents), then the question.
        sent_fields = body.model_fields_set
        requested = body.chapter_id if "chapter_id" in sent_fields else None
        source_documents = (
            [s.document_id for s in body.sources]
            if "sources" in sent_fields and body.sources is not None
            else []
        )
        repo.lock_documents(
            access.workspace.workspace_id,
            chapter_ids=[repo.chapter_of(question_id), requested],
            document_ids=source_documents,
        )
        current = _load(repo, question_id, lock=True)
        if body.base_revision_id != current.revision.id:
            raise ProblemException(
                409,
                ProblemType.STALE_REVISION,
                detail="The question changed since this edit started. Reload it and try again.",
            )
        sent = body.model_fields_set
        issues = Issues()
        if "question_type" in sent and body.question_type != current.question_type:
            issues.add(
                ("question_type",),
                "The type of an existing question cannot change; create a new question instead.",
            )
        target: PublicationStatus = (
            body.publication_status
            if "publication_status" in sent and body.publication_status is not None
            else current.publication_status
        )
        if not transition_allowed(current.publication_status, target):
            issues.add(
                ("publication_status",),
                f"Cannot change publication status from {current.publication_status} to {target}.",
            )

        old = current.content()
        rev = current.revision
        content = _content(
            current.question_type,
            body.stem if "stem" in sent and body.stem is not None else rev.stem,
            body.options
            if "options" in sent and body.options is not None
            else [QuestionOption(id=o["id"], text=o["text"]) for o in rev.options],
            body.correct_option_ids if "correct_option_ids" in sent else rev.correct_option_ids,
            body.is_multi_answer
            if "is_multi_answer" in sent and body.is_multi_answer is not None
            else rev.is_multi_answer,
            body.accepted_answers if "accepted_answers" in sent else rev.accepted_answers,
            body.explanation if "explanation" in sent else rev.explanation,
            body.rubric if "rubric" in sent else rev.rubric,
        )
        content_changed = content != old
        if content_changed or target != current.publication_status:
            issues.items.extend(content_issues(content, target).items)

        metadata: dict[str, Any] = {}
        if "chapter_id" in sent and body.chapter_id != current.chapter_id:
            if body.chapter_id is not None:
                _check_chapter(repo, current.workspace_id, body.chapter_id, issues)
            metadata["chapter_id"] = body.chapter_id
        if "question_number" in sent and body.question_number != current.question_number:
            metadata["question_number"] = body.question_number
        if target != current.publication_status:
            metadata["publication_status"] = target
        new_sources: list[SourceInputRecord] | None = None
        source_revisions: dict[uuid.UUID, uuid.UUID | None] = {}
        if "sources" in sent and body.sources is not None:
            new_sources, source_revisions = _sources(
                repo, current.workspace_id, body.sources, issues
            )
        issues.raise_if_any()

        changed = [k for k in metadata if k != "publication_status"]
        version = current.revision.version
        if content_changed:
            version = repo.append_revision(current, content, access.workspace.user_id)
            changed.append("content")
        repo.update_metadata(current.id, **metadata)
        if new_sources is not None:
            repo.replace_sources(current.workspace_id, current.id, new_sources, source_revisions)
            changed.append("sources")
            if not metadata and not content_changed:
                repo.touch(current.id)
        if changed:
            repo.record_activity(
                current.workspace_id,
                access.workspace.user_id,
                "question.updated",
                current.id,
                {"version": version, "changed": sorted(changed)},
            )
        if target != current.publication_status:
            repo.record_activity(
                current.workspace_id,
                access.workspace.user_id,
                "question.status_changed",
                current.id,
                {"from": current.publication_status, "to": target, "version": version},
            )
        return _load(repo, current.id)

    try:
        updated = _with_lock_retry(repo, attempt)
        repo.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(repo) from None
    return _out(updated)


@router.delete(
    "/questions/{question_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="deleteQuestion",
)
def delete_question(access: EditQuestion, repo: QuestionRepo) -> Response:
    """Soft delete (editor+). Revisions and attempts stay for history; the question then answers
    404 everywhere and leaves the bank and the overview."""
    current = _load(repo, access.resource_id, lock=True)
    repo.soft_delete(current, access.workspace.user_id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
