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

from quiz_api.middleware import REQUEST_ID_HEADER

PROBLEM_MEDIA_TYPE = "application/problem+json"


class ProblemType(StrEnum):
    """Problem `type` URIs that distinguish failures sharing a status code (URNs: not links)."""

    # 403: the caller is a member but their role does not allow the action.
    INSUFFICIENT_ROLE = "urn:quiz-workspace:problem:insufficient-role"
    # 403: the workspace is archived (read-only); restore it to write again.
    WORKSPACE_ARCHIVED = "urn:quiz-workspace:problem:workspace-archived"


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
    return problem_response(request, HTTPStatus.INTERNAL_SERVER_ERROR)


def install_error_handlers(app: FastAPI) -> None:
    # Starlette types handlers as taking `Exception`; it dispatches by the registered class.
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _unhandled_exception_handler)
