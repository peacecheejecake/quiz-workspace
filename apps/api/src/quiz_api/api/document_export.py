"""Full-text export of a document as a Markdown or text file (DOCTXT, DOC-03).

    GET /documents/{id}/text?format=md|txt&revision=published|draft|<revision id>

The body is `book_core.export.render_revision` of the published (active) revision, of the
unpublished correction draft for owners and editors (`revision=draft`; viewer 403
`insufficient-role`, checked before the draft is looked up; no draft 404 `draft-not-found`), or
of one revision of this document by id (what DOC-02 shows for a search hit; the blocks API's
rule: published revisions for every member, a draft for owners and editors; another document's
revision 404).
`format` also accepts `markdown` / `plain` (docs/architecture.md names).

Authorization is the document read: its workspace is resolved from the DB (404 for non-members,
other workspaces, deleted documents and deleted workspaces; archived workspaces stay readable).
A share session is not a login: without a JWT the answer is 401. A document still processing or
failed has nothing to export: 409 `document-not-ready`.

The response is an attachment (`Content-Disposition: attachment` with an RFC 5987 `filename*`,
the title stripped of path and control characters and cut to 120 characters, ` (초안)` for a
draft), `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. An export changes
nothing on the server: no activity event, no job; the body is never logged.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Annotated, Literal
from urllib.parse import quote

from book_core.export import ExportFormat, render_revision
from fastapi import APIRouter, HTTPException, Query, Response

from quiz_api.api.document_revisions import (
    _READERS_OF_DRAFTS,
    REVISION_NOT_FOUND,
    ContentRepo,
    ReadDocument,
)
from quiz_api.api.documents import DocumentRepo
from quiz_api.authz import ResourceAccess
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.repositories.document_content import (
    DocumentContentRepository,
    DocumentRef,
    RevisionRow,
)

router = APIRouter(tags=["documents"])

MAX_FILENAME_TITLE = 120
DRAFT_SUFFIX = " (초안)"
_MEDIA_TYPES = {
    ExportFormat.MARKDOWN: "text/markdown; charset=utf-8",
    ExportFormat.TEXT: "text/plain; charset=utf-8",
}
_PATH_OR_CONTROL = re.compile(r"[/\\\x00-\x1f\x7f-\x9f]")
_ASCII_UNSAFE = re.compile(r"[^\x20-\x7e]|[\"\\;%]")


def export_filename_title(title: str) -> str:
    """The title part of the file name: no path separators or control characters, collapsed
    whitespace, no leading/trailing dots, at most 120 characters."""
    text = unicodedata.normalize("NFC", title)
    text = _PATH_OR_CONTROL.sub("", text)
    text = re.sub(r"\s+", " ", text).strip().strip(".").strip()
    text = text[:MAX_FILENAME_TITLE].rstrip()
    return text or "document"


def content_disposition(filename: str) -> str:
    """`attachment` with an ASCII fallback `filename` and the exact RFC 5987 `filename*`."""
    fallback = _ASCII_UNSAFE.sub("_", filename)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _draft_refused() -> ProblemException:
    return ProblemException(
        403,
        ProblemType.INSUFFICIENT_ROLE,
        detail="Unpublished corrections are visible to owners and editors only.",
    )


def _revision(
    repo: DocumentContentRepository,
    access: ResourceAccess,
    document: DocumentRef,
    active_revision_id: uuid.UUID,
    selector: str,
) -> RevisionRow:
    """The revision `selector` names. Roles are checked before a draft is looked up; an id of
    another document (or none at all) is the same 404 as an unknown id."""
    editor = access.workspace.role in _READERS_OF_DRAFTS
    if selector == "draft":
        if not editor:
            raise _draft_refused()
        draft = repo.current_draft(document)
        if draft is None:
            raise ProblemException(
                404,
                ProblemType.DRAFT_NOT_FOUND,
                detail="The document has no unpublished correction draft.",
            )
        return draft
    if selector == "published":
        found = repo.revision(document.id, active_revision_id)
    else:
        try:
            revision_id = uuid.UUID(selector)
        except ValueError:
            raise HTTPException(status_code=404, detail=REVISION_NOT_FOUND) from None
        found = repo.revision(document.id, revision_id)
    if found is None:
        raise HTTPException(status_code=404, detail=REVISION_NOT_FOUND)
    if found.is_draft and not editor:
        raise _draft_refused()
    return found


@router.get(
    "/documents/{document_id}/text",
    operation_id="exportDocumentText",
    response_class=Response,
    responses={
        200: {
            "description": "The document text as a file (attachment).",
            "content": {
                "text/markdown": {"schema": {"type": "string"}},
                "text/plain": {"schema": {"type": "string"}},
            },
        },
        **problem_responses(409),
    },
)
def export_document_text(
    access: ReadDocument,
    repo: ContentRepo,
    documents: DocumentRepo,
    format: Annotated[
        Literal["md", "txt", "markdown", "plain"],
        Query(description="`md` (Markdown) or `txt` (plain text); `markdown` / `plain` alike."),
    ] = "md",
    revision: Annotated[
        str,
        Query(
            pattern=r"^(published|draft|[0-9a-fA-F-]{36})$",
            description="`published` (default), the unpublished correction `draft` (owners and "
            "editors) or a revision id of this document (the revision a screen shows; a draft "
            "id needs owner or editor).",
        ),
    ] = "published",
) -> Response:
    """The document's canonical text as a Markdown or text file (DOC-03)."""
    doc = documents.get_document(access.resource_id)
    if doc.status != "ready" or doc.active_revision_id is None:
        raise ProblemException(
            409,
            ProblemType.DOCUMENT_NOT_READY,
            detail="The document has not finished processing; there is no text to export yet.",
        )
    document = repo.document(access.resource_id)
    found = _revision(repo, access, document, doc.active_revision_id, revision)
    content = repo.load_content(document, found)
    repo.rollback()
    fmt = ExportFormat.parse(format)
    body = render_revision(content, fmt, title=doc.title).encode("utf-8")
    name = export_filename_title(doc.title) + (DRAFT_SUFFIX if found.is_draft else "")
    return Response(
        content=body,
        headers={
            "Content-Type": _MEDIA_TYPES[fmt],
            "Content-Disposition": content_disposition(f"{name}.{fmt.value}"),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
