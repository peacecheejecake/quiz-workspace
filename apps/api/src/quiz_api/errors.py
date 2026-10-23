"""RFC 9457 problem details for every error response.

All handled errors (401/403/404/405/422/500 and any `HTTPException`) are rendered as
`application/problem+json` with the same `Problem` shape plus the request id.
401 = missing/expired/invalid credentials; 403 = authenticated but not authorized
(docs/auth.md §5). Handlers never echo request input or internal exception text.

Most problems use `type: about:blank` (the status says it all). Where a client must tell two
failures with the same status apart, the route raises `ProblemException` with one of the
`ProblemType` URIs below; they are part of the API contract.
"""

from __future__ import annotations

from enum import StrEnum
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from quiz_api.middleware import REQUEST_ID_HEADER, no_store_headers, security_headers

PROBLEM_MEDIA_TYPE = "application/problem+json"


class ProblemType(StrEnum):
    """Problem `type` URIs that distinguish failures sharing a status code (URNs: not links)."""

    # 403: the caller is a member but their role does not allow the action.
    INSUFFICIENT_ROLE = "urn:quiz-workspace:problem:insufficient-role"
    # 403: the workspace is archived (read-only); restore it to write again.
    WORKSPACE_ARCHIVED = "urn:quiz-workspace:problem:workspace-archived"
    # 409: an `Idempotency-Key` was reused for the same operation with a different request body.
    IDEMPOTENCY_KEY_REUSED = "urn:quiz-workspace:problem:idempotency-key-reused"
    # 409: complete-upload found no stored object for the intent (upload not finished yet).
    UPLOAD_INCOMPLETE = "urn:quiz-workspace:problem:upload-incomplete"
    # 409: the upload intent expired before it was completed; request a new one.
    UPLOAD_EXPIRED = "urn:quiz-workspace:problem:upload-expired"
    # 422: the stored object does not match the declared size / SHA-256 (it is discarded).
    UPLOAD_MISMATCH = "urn:quiz-workspace:problem:upload-mismatch"
    # 409: an edit was based on a revision that is no longer the active one (reload and retry).
    STALE_REVISION = "urn:quiz-workspace:problem:stale-revision"
    # 409: the share link is revoked (or, for rotate, revoked or expired); create a new link.
    SHARE_LINK_INACTIVE = "urn:quiz-workspace:problem:share-link-inactive"
    # 404 (shared routes): unknown share id, wrong secret, revoked/expired link or deleted
    # workspace; one body for all of them (no existence oracle). The guest's session is over.
    SHARE_UNAVAILABLE = "urn:quiz-workspace:problem:share-unavailable"
    # 401 (shared reads) / 403 (fork, where 401 means the user JWT): no (valid) share session
    # cookie; exchange the link secret first.
    SHARE_SESSION_REQUIRED = "urn:quiz-workspace:problem:share-session-required"
    # 403: the share link does not allow forking (WS-FORK-01-AC02).
    FORK_NOT_ALLOWED = "urn:quiz-workspace:problem:fork-not-allowed"
    # 409: the shared workspace is larger than one fork may copy.
    FORK_TOO_LARGE = "urn:quiz-workspace:problem:fork-too-large"
    # 409: practice needs a CONFIRMED question (drafts and archived questions are not studied).
    QUESTION_NOT_CONFIRMED = "urn:quiz-workspace:problem:question-not-confirmed"
    # 409: the practice session was already submitted (a session is answered exactly once).
    PRACTICE_SESSION_SUBMITTED = "urn:quiz-workspace:problem:practice-session-submitted"
    # 409: self-grade of a session that is not awaiting a grade (still open or already graded).
    PRACTICE_SESSION_NOT_PENDING = "urn:quiz-workspace:problem:practice-session-not-pending"
    # 409: the document has no published revision yet (first parse pending or failed); also a
    # question import needs a `question_paper` document that finished processing.
    DOCUMENT_NOT_READY = "urn:quiz-workspace:problem:document-not-ready"
    # 409: a correction was based on block text (or a draft) that changed since it was loaded.
    EDIT_CONFLICT = "urn:quiz-workspace:problem:edit-conflict"
    # 409: the draft is being published (indexing); wait for the job, then edit again.
    PUBLISH_IN_PROGRESS = "urn:quiz-workspace:problem:publish-in-progress"
    # 409: there is no correction draft, or it does not differ from the published revision.
    NOTHING_TO_PUBLISH = "urn:quiz-workspace:problem:nothing-to-publish"
    # 409: only a failed or cancelled import run can be retried.
    IMPORT_NOT_RETRYABLE = "urn:quiz-workspace:problem:import-not-retryable"
    # 409: a draft edit was based on an outdated version of the draft (reload and retry).
    STALE_DRAFT = "urn:quiz-workspace:problem:stale-draft"
    # 409: the draft is already published as a question; edit the question instead.
    DRAFT_PUBLISHED = "urn:quiz-workspace:problem:draft-published"
    # 409: publishing a draft that is not approved (pending or rejected); approve it first.
    DRAFT_NOT_APPROVED = "urn:quiz-workspace:problem:draft-not-approved"
    # 409: a generated draft duplicates a question already in the workspace (or another draft of
    # the same publish request); edit or reject it.
    DUPLICATE_QUESTION = "urn:quiz-workspace:problem:duplicate-question"
    # 409: the import's previous registration (QIMP-JOB) is still queued or running; follow it.
    IMPORT_REGISTRATION_RUNNING = "urn:quiz-workspace:problem:import-registration-running"


class ProblemException(StarletteHTTPException):
    """An HTTP error rendered with a specific problem `type`."""

    def __init__(
        self,
        status_code: int,
        problem_type: ProblemType,
        detail: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.problem_type = problem_type


class ValidationIssue(BaseModel):
    loc: list[str | int]
    msg: str
    type: str


class Problem(BaseModel):
    type: str = Field(default="about:blank", description="Problem type URI.")
    title: str
    status: int
    detail: str | None = None
    instance: str | None = Field(default=None, description="Request path.")
    request_id: str | None = None
    errors: list[ValidationIssue] | None = Field(
        default=None, description="Field-level issues (422 only)."
    )


def _problem_content() -> dict[str, Any]:
    # `Problem` is added to components by `quiz_api.main` so this $ref always resolves.
    return {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}}


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses=` entries for routes that can fail with these statuses."""
    return {
        status: {"content": _problem_content(), "description": _title(status)}
        for status in statuses
    }


# RFC 9110 titles where Python's `HTTPStatus` phrase is outdated (3.12: "Unprocessable Entity"),
# so the contract does not change with the interpreter version.
_TITLE_OVERRIDES = {413: "Content Too Large", 422: "Unprocessable Content"}


def _title(status: int) -> str:
    if status in _TITLE_OVERRIDES:
        return _TITLE_OVERRIDES[status]
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Error"


def problem_response(
    request: Request,
    status: int,
    *,
    problem_type: str = "about:blank",
    detail: str | None = None,
    errors: list[ValidationIssue] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    problem = Problem(
        type=problem_type,
        title=_title(status),
        status=status,
        detail=detail,
        instance=request.url.path,
        request_id=getattr(request.state, "request_id", None),
        errors=errors,
    )
    response_headers = dict(headers or {})
    if problem.request_id:
        # Set here too: 500s are rendered outside RequestIdMiddleware.
        response_headers[REQUEST_ID_HEADER] = problem.request_id
    return JSONResponse(
        problem.model_dump(exclude_none=True),
        status_code=status,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=response_headers,
    )


async def _http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail: str | None = exc.detail if isinstance(exc.detail, str) else None
    if detail == _title(exc.status_code):
        detail = None
    headers = dict(exc.headers) if exc.headers else None
    if exc.status_code == HTTPStatus.UNAUTHORIZED:
        headers = {"WWW-Authenticate": "Bearer", **(headers or {})}
    problem_type = getattr(exc, "problem_type", "about:blank")
    return problem_response(
        request, exc.status_code, problem_type=problem_type, detail=detail, headers=headers
    )


async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # `input`/`ctx` are dropped on purpose: they can echo secrets or user content.
    issues = [
        ValidationIssue(loc=list(err.get("loc", ())), msg=err.get("msg", ""), type=err["type"])
        for err in exc.errors()
    ]
    return problem_response(
        request,
        422,
        detail="Request validation failed.",
        errors=issues,
    )


async def _unhandled_exception_handler(request: Request, _exc: Exception) -> JSONResponse:
    # Logged (with traceback and request id) by RequestIdMiddleware; never echoed here.
    # Rendered by Starlette's outermost error middleware, i.e. outside SecurityHeadersMiddleware.
    # The same goes for NoStoreMiddleware: without its headers a 500 of an authenticated or
    # shared request would be cacheable.
    settings = getattr(request.app.state, "settings", None)
    https = request.url.scheme == "https" or bool(getattr(settings, "is_deployed", False))
    headers = security_headers(https=https)
    no_store: dict[str, str] | None = getattr(request.app.state, "no_store", None)
    if no_store is not None:
        headers.update(
            no_store_headers(
                request.url.path,
                has_authorization="authorization" in request.headers,
                path_prefix=no_store["path_prefix"],
                shared_prefix=no_store.get("shared_prefix"),
            )
        )
    return problem_response(request, HTTPStatus.INTERNAL_SERVER_ERROR, headers=headers)


def install_error_handlers(app: FastAPI) -> None:
    # Starlette types handlers as taking `Exception`; it dispatches by the registered class.
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _unhandled_exception_handler)
