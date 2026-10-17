"""Outline, canonical blocks, corrections, publish and revision history (M3.4, DOC-02).

    GET   /documents/{id}/outline                    chapter/section tree of a revision
    GET   /documents/{id}/blocks                     canonical blocks of a revision, paged
    GET   /documents/{id}/blocks/{block_id}          one block
    PATCH /documents/{id}/blocks/{block_id}          editor+; correct a block's text (draft)
    POST  /documents/{id}/publish                    editor+; index + publish the draft (202 job)
    GET   /documents/{id}/revisions                  revision history (newest first)
    POST  /documents/{id}/revisions/{rid}/restore    editor+; draft := a published revision

Revisions (`?revision=`): `active` (default) = the published revision search and the viewer use;
`latest` = the newest revision (the correction draft when there is one); or a revision id of this
document. Drafts (unpublished content) are readable by owners and editors only; a viewer asking
for one gets 403 `insufficient-role`. A document whose first parse has not published anything has
no active revision: reads of `active` answer an empty outline / block list (`revision: null`).

Corrections (DOC-02-AC02): the first PATCH creates draft revision n+1 as a copy of the active
revision; later PATCHes edit that draft. The original PDF is never touched. Optimistic
concurrency: every block carries `version` (changes with its text); a PATCH with `base_version`
that no longer matches is 409 `edit-conflict`. While a publish of the draft is queued or running,
edits are 409 `publish-in-progress`. Text follows `book_core.structure.apply_edits` (normalized,
`edited: true`, a heading edit renames its section, table text is `a | b` rows); an unchanged text
is a no-op that creates no draft.

Publish (DOC-02-AC03/AC04): stores the draft's content hash and enqueues `document.parse` for the
draft; the worker reuses the stored content (no re-parse), indexes it (unchanged chunks reuse
their vectors) and, in one DB transaction, publishes the draft and makes it the active revision.
Search is scoped to DB-active revisions, so the switch is atomic for readers; until then (and if
indexing fails) the previous published revision stays active and searchable, the job fails with
an `error_code`, the document keeps `status: ready` with `last_error`, and the draft stays editable
so the publish can be retried. The same publish request while a job for the draft is in flight
returns that job (202); `Idempotency-Key` replays the first response. 409 `nothing-to-publish`
without a draft or when the draft equals the active revision. The publish switch also remaps
question chapter links (`questions.chapter_id`) to the new revision's chapters by section key
(DB trigger, 20261018003400); question sources keep their cited revision.

Rollback: `restore` replaces the draft's content with a previous published revision (creating the
draft if needed); publishing it then goes through the same index-then-switch path, so search never
serves a revision that is not the DB's active one. Restoring the active revision discards the
draft's corrections.

Activity: `document.block_corrected`, `document.publish_requested`, `document.revision_restored`
(ids only, never text). Publish completion is the job's status (`GET /jobs/{id}`, SSE); the worker
records no activity.

Authorization: every route resolves the document's workspace from the DB (404 for non-members,
other workspaces and deleted documents); writes need `document.edit` (403 `insufficient-role` for
viewers, 403 `workspace-archived` when archived), checked before the block or draft is looked at.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from quiz_api.api.documents import DocumentRepo, PublisherDep, publish_job
from quiz_api.authz import (
    Action,
    ResourceAccess,
    ResourceType,
    Role,
    require_resource_access,
)
from quiz_api.db import get_db_session
from quiz_api.document_content import (
    MAX_BLOCK_TEXT,
    BlockEditRefused,
    ContentDecodeError,
    block_attributes,
    block_from_row,
    block_version,
    edit_block,
    outline_tree,
)
from quiz_api.document_content import OutlineNode as OutlineTreeNode
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.document_content import (
    DocumentContentRepository,
    DocumentRef,
    JobBrief,
    RevisionRow,
)
from quiz_api.repositories.documents import RevisionStatus
from quiz_api.repositories.idempotency import IdempotencyStore

router = APIRouter(tags=["documents"])

BLOCK_NOT_FOUND = "Block not found."
REVISION_NOT_FOUND = "Revision not found."
MAX_PAGE_SIZE = 500
DEFAULT_PAGE_SIZE = 200
_READERS_OF_DRAFTS = frozenset({Role.OWNER, Role.EDITOR})

BlockId = Annotated[
    str,
    Path(
        min_length=1,
        max_length=256,
        pattern=r"^\S+$",
        description="Canonical block id (stable across revisions), e.g. from search hits.",
    ),
]
RevisionSelector = Annotated[
    str,
    Query(
        pattern=r"^(active|latest|[0-9a-fA-F-]{36})$",
        description="`active` (published, default), `latest` (the draft if any) or a revision id.",
    ),
]


# --- schemas ------------------------------------------------------------------------------------


class RevisionInfo(BaseModel):
    id: uuid.UUID
    revision_number: int
    status: RevisionStatus
    parent_revision_id: uuid.UUID | None
    is_active: bool = Field(description="The published revision search and the viewer use.")
    published_at: datetime | None
    created_at: datetime


class OutlineItem(BaseModel):
    id: uuid.UUID = Field(
        description="Chapter id of this revision (the `chapter_ids` value search and questions "
        "use). Changes with every revision; `section_key` does not."
    )
    section_key: str = Field(description="Stable section id across revisions.")
    title: str
    level: int
    page: int | None = Field(description="1-based PDF page of the heading.")
    block_id: str | None = Field(description="The heading block that opens the section.")
    children: list[OutlineItem]


class Outline(BaseModel):
    document_id: uuid.UUID
    revision: RevisionInfo | None = Field(description="Null while nothing is published yet.")
    items: list[OutlineItem]


class BoundingBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class BlockLocation(BaseModel):
    page: int
    bbox: BoundingBox | None = Field(description="PDF points, origin top-left.")


class TableCells(BaseModel):
    rows: list[list[str]]
    header_rows: int


class ContentBlock(BaseModel):
    block_id: str = Field(description="Stable across revisions (search hits, question sources).")
    ordinal: int = Field(description="Reading order within the revision.")
    type: Literal["heading", "text", "table", "image", "formula"]
    text: str
    page: int = Field(description="First PDF page of the block.")
    chapter_id: uuid.UUID | None
    locations: list[BlockLocation] = Field(description="Where the block sits in the PDF.")
    heading_level: int | None
    table: TableCells | None
    caption_block_id: str | None
    edited: bool = Field(description="Corrected by a user in this or an earlier revision.")
    version: str = Field(description="Send as `base_version` when correcting this block.")


class BlockList(BaseModel):
    document_id: uuid.UUID
    revision: RevisionInfo | None
    items: list[ContentBlock]
    next_after: int | None = Field(
        description="Pass as `after` for the next page; null on the last page."
    )


class BlockDetail(BaseModel):
    document_id: uuid.UUID
    revision: RevisionInfo
    block: ContentBlock


class BlockCorrection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(max_length=MAX_BLOCK_TEXT, pattern=r"^[^\x00]*$")] = (
        Field(description="Corrected text. Tables: one row per line, cells separated by `|`.")
    )
    base_version: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")] | None = Field(
        default=None,
        description="The block `version` the correction started from; 409 `edit-conflict` "
        "when the block changed since.",
    )


class PublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision_id: uuid.UUID | None = Field(
        default=None,
        description="The draft the client reviewed; 409 `edit-conflict` if it is not the draft.",
    )


class PublishAccepted(BaseModel):
    job_id: uuid.UUID = Field(description="The indexing job; poll `GET /jobs/{id}` or its SSE.")
    revision_id: uuid.UUID = Field(description="The draft revision being published.")


class RevisionJob(BaseModel):
    id: uuid.UUID
    status: str = Field(description="queued | running | succeeded | failed | cancelled")


class RevisionHistoryItem(RevisionInfo):
    job: RevisionJob | None = Field(description="The newest parse/publish job of this revision.")


class RevisionHistory(BaseModel):
    document_id: uuid.UUID
    items: list[RevisionHistoryItem]


class RestoredDraft(BaseModel):
    document_id: uuid.UUID
    revision: RevisionInfo = Field(description="The draft now holding the restored content.")


# --- dependencies -------------------------------------------------------------------------------


def get_content_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> DocumentContentRepository:
    return DocumentContentRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


ContentRepo = Annotated[DocumentContentRepository, Depends(get_content_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]


def _document(action: Action) -> Any:
    return Depends(require_resource_access(ResourceType.DOCUMENT, action, param="document_id"))


ReadDocument = Annotated[ResourceAccess, _document(Action.READ)]
EditDocument = Annotated[ResourceAccess, _document(Action.DOCUMENT_EDIT)]


# --- helpers ------------------------------------------------------------------------------------


def _info(revision: RevisionRow, document: DocumentRef) -> RevisionInfo:
    return RevisionInfo(
        id=revision.id,
        revision_number=revision.revision_number,
        status=revision.status,
        parent_revision_id=revision.parent_revision_id,
        is_active=revision.id == document.active_revision_id,
        published_at=revision.published_at,
        created_at=revision.created_at,
    )


def _resolve(
    repo: DocumentContentRepository,
    access: ResourceAccess,
    document: DocumentRef,
    selector: str,
) -> RevisionRow | None:
    """The revision a read addresses (None: `active` before anything was published)."""
    if selector == "active":
        if document.active_revision_id is None:
            return None
        revision = repo.revision(document.id, document.active_revision_id)
    elif selector == "latest":
        revision = repo.latest_revision(document.id)
    else:
        try:
            revision_id = uuid.UUID(selector)
        except ValueError:
            raise HTTPException(status_code=404, detail=REVISION_NOT_FOUND) from None
        revision = repo.revision(document.id, revision_id)
        if revision is None:
            raise HTTPException(status_code=404, detail=REVISION_NOT_FOUND)
    if (
        revision is not None
        and revision.is_draft
        and access.workspace.role not in (_READERS_OF_DRAFTS)
    ):
        raise ProblemException(
            403,
            ProblemType.INSUFFICIENT_ROLE,
            detail="Unpublished corrections are visible to owners and editors only.",
        )
    return revision


def _block(row: RowMapping) -> ContentBlock:
    attributes = row["attributes"] or {}
    table = attributes.get("table")
    return ContentBlock(
        block_id=row["block_id"],
        ordinal=row["ordinal"],
        type=row["block_type"],
        text=row["text"],
        page=row["page"],
        chapter_id=row["chapter_id"],
        locations=[
            BlockLocation(page=loc["page"], bbox=loc.get("bbox"))
            for loc in row["provenance"]["locations"]
        ],
        heading_level=attributes.get("heading_level"),
        table=TableCells(rows=table["rows"], header_rows=table.get("header_rows", 0))
        if table is not None
        else None,
        caption_block_id=attributes.get("caption_block_id"),
        edited=row["edited"],
        version=block_version(row["text"]),
    )


def _outline_item(node: OutlineTreeNode) -> OutlineItem:
    return OutlineItem(
        id=node.id,
        section_key=node.section_key,
        title=node.title,
        level=node.level,
        page=node.page,
        block_id=node.heading_block_id,
        children=[_outline_item(child) for child in node.children],
    )


def _require_published(document: DocumentRef) -> uuid.UUID:
    if document.active_revision_id is None:
        raise ProblemException(
            409,
            ProblemType.DOCUMENT_NOT_READY,
            detail="The document has no published revision yet. Wait for processing to finish.",
        )
    return document.active_revision_id


def _publish_in_progress() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.PUBLISH_IN_PROGRESS,
        detail="The draft is being published. Wait for the indexing job, then edit again.",
    )


def _refresh_hash(
    repo: DocumentContentRepository, document: DocumentRef, draft: RevisionRow
) -> None:
    """Keep a hashed draft's hash in step with its content (see the repository docstring)."""
    if draft.content_hash is None:
        return
    content = repo.load_content(document, draft)
    assert content.content_hash is not None  # noqa: S101 - load_content computes it
    repo.set_content_hash(draft.id, content.content_hash)


# --- reads --------------------------------------------------------------------------------------


@router.get("/documents/{document_id}/outline", operation_id="getDocumentOutline")
def get_outline(
    access: ReadDocument, repo: ContentRepo, revision: RevisionSelector = "active"
) -> Outline:
    """Chapter/section tree of a revision (DOC-02-AC01), roots and children in reading order."""
    document = repo.document(access.resource_id)
    found = _resolve(repo, access, document, revision)
    items = outline_tree(repo.chapters(found.id)) if found is not None else []
    return Outline(
        document_id=document.id,
        revision=_info(found, document) if found is not None else None,
        items=[_outline_item(node) for node in items],
    )


@router.get("/documents/{document_id}/blocks", operation_id="listDocumentBlocks")
def list_blocks(
    access: ReadDocument,
    repo: ContentRepo,
    revision: RevisionSelector = "active",
    chapter: Annotated[
        uuid.UUID | None,
        Query(description="Only blocks of this chapter (an outline id) and its sub-sections."),
    ] = None,
    page: Annotated[int | None, Query(ge=1, description="Only blocks starting on this page.")] = (
        None
    ),
    after: Annotated[
        int | None, Query(ge=-1, description="`next_after` of the previous page.")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> BlockList:
    """Canonical blocks of a revision in reading order (keyset-paged by ordinal)."""
    document = repo.document(access.resource_id)
    found = _resolve(repo, access, document, revision)
    if found is None:
        return BlockList(document_id=document.id, revision=None, items=[], next_after=None)
    chapter_ids = None
    if chapter is not None:
        chapter_ids = repo.chapter_subtree(found.id, chapter)
        if not chapter_ids:
            raise HTTPException(status_code=404, detail="Chapter not found in this revision.")
    rows = repo.blocks(found.id, chapter_ids=chapter_ids, page=page, after=after, limit=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    return BlockList(
        document_id=document.id,
        revision=_info(found, document),
        items=[_block(row) for row in rows],
        next_after=rows[-1]["ordinal"] if more and rows else None,
    )


@router.get("/documents/{document_id}/blocks/{block_id}", operation_id="getDocumentBlock")
def get_block(
    access: ReadDocument,
    block_id: BlockId,
    repo: ContentRepo,
    revision: RevisionSelector = "active",
) -> BlockDetail:
    document = repo.document(access.resource_id)
    found = _resolve(repo, access, document, revision)
    row = repo.block(found.id, block_id) if found is not None else None
    if found is None or row is None:
        raise HTTPException(status_code=404, detail=BLOCK_NOT_FOUND)
    return BlockDetail(document_id=document.id, revision=_info(found, document), block=_block(row))


@router.get("/documents/{document_id}/revisions", operation_id="listDocumentRevisions")
def list_revisions(access: ReadDocument, repo: ContentRepo) -> RevisionHistory:
    """Every revision, newest first, with its newest parse/publish job."""
    document = repo.document(access.resource_id)
    jobs: dict[uuid.UUID, JobBrief] = repo.latest_parse_jobs(document.workspace_id, document.id)
    items = []
    for revision in repo.list_revisions(document.id):
        job = jobs.get(revision.id)
        items.append(
            RevisionHistoryItem(
                **_info(revision, document).model_dump(),
                job=RevisionJob(id=job.id, status=job.status) if job else None,
            )
        )
    return RevisionHistory(document_id=document.id, items=items)


# --- writes -------------------------------------------------------------------------------------


@router.patch(
    "/documents/{document_id}/blocks/{block_id}",
    operation_id="correctDocumentBlock",
    responses=problem_responses(409),
)
def correct_block(
    access: EditDocument, block_id: BlockId, body: BlockCorrection, repo: ContentRepo
) -> BlockDetail:
    """Correct one block's canonical text in the document's draft revision (DOC-02-AC02)."""
    user_id = access.workspace.user_id
    document = repo.document(access.resource_id, lock=True)
    active_id = _require_published(document)
    draft = repo.current_draft(document, lock=True)
    if draft is not None and repo.active_parse_job(document.workspace_id, draft.id) is not None:
        raise _publish_in_progress()
    source_id = draft.id if draft is not None else active_id
    row = repo.block(source_id, block_id)
    if row is None:
        raise HTTPException(status_code=404, detail=BLOCK_NOT_FOUND)
    if body.base_version is not None and body.base_version != block_version(row["text"]):
        raise ProblemException(
            409,
            ProblemType.EDIT_CONFLICT,
            detail="This block changed since it was loaded. Reload it and apply the correction "
            "again.",
        )
    # The section/caption links do not take part in a text edit (`edit_block` detaches them).
    current = block_from_row(
        row, {row["chapter_id"]: "section"} if row["chapter_id"] is not None else {}
    )
    try:
        edited = edit_block(current, body.text, source_sha256=document.sha256)
    except BlockEditRefused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    if edited is None:  # same text: no draft, nothing written
        revision = draft or repo.revision(document.id, active_id)
        assert revision is not None  # noqa: S101 - the active revision exists
        repo.rollback()
        return BlockDetail(
            document_id=document.id, revision=_info(revision, document), block=_block(row)
        )

    if draft is None:
        active = repo.revision(document.id, active_id)
        assert active is not None  # noqa: S101 - the active revision exists
        draft = repo.create_draft(document, active, parent_revision_id=active_id, actor_id=user_id)
    repo.update_block(draft.id, block_id, new_text=edited.text, attributes=block_attributes(edited))
    if edited.type.value == "heading":
        repo.rename_section(draft.id, block_id, edited.text)
    _refresh_hash(repo, document, draft)
    repo.record_activity(
        document,
        user_id,
        "document.block_corrected",
        {"revision_id": str(draft.id), "block_id": block_id},
    )
    saved = repo.block(draft.id, block_id)
    assert saved is not None  # noqa: S101 - updated above
    repo.commit()
    return BlockDetail(
        document_id=document.id, revision=_info(draft, document), block=_block(saved)
    )


@router.post(
    "/documents/{document_id}/publish",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="publishDocumentDraft",
    response_model=PublishAccepted,
    responses=problem_responses(409),
)
def publish_draft(
    access: EditDocument,
    repo: ContentRepo,
    documents_repo: DocumentRepo,
    publisher: PublisherDep,
    idempotency: IdempotencyStoreDep,
    body: PublishRequest | None = None,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Index and publish the correction draft (DOC-02-AC03): 202 with the job to follow."""
    user_id = access.workspace.user_id
    request = body or PublishRequest()
    scope = f"POST /documents/{access.resource_id}/publish"
    digest = request_hash(request.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user_id, scope, idempotency_key)
        stored = idempotency.find(user_id, scope, idempotency_key)
        if stored is not None:
            return replay(stored, digest)

    document = repo.document(access.resource_id, lock=True)
    active_id = _require_published(document)
    draft = repo.current_draft(document, lock=True)
    if draft is None:
        raise ProblemException(
            409,
            ProblemType.NOTHING_TO_PUBLISH,
            detail="There are no corrections to publish.",
        )
    if request.revision_id is not None and request.revision_id != draft.id:
        raise ProblemException(
            409,
            ProblemType.EDIT_CONFLICT,
            detail="The draft changed since it was loaded. Reload the document and try again.",
        )
    job = repo.active_parse_job(document.workspace_id, draft.id)
    if job is None:
        try:
            content = repo.load_content(document, draft)
        except ContentDecodeError:
            raise HTTPException(
                status_code=409, detail="The draft content is inconsistent and cannot be published."
            ) from None
        active = repo.revision(document.id, active_id)
        if active is not None and active.content_hash == content.content_hash:
            raise ProblemException(
                409,
                ProblemType.NOTHING_TO_PUBLISH,
                detail="The draft does not differ from the published revision.",
            )
        assert content.content_hash is not None  # noqa: S101 - load_content computes it
        if draft.content_hash != content.content_hash:
            repo.set_content_hash(draft.id, content.content_hash)
        job = repo.create_parse_job(document, draft.id, actor_id=user_id)
        repo.record_activity(
            document,
            user_id,
            "document.publish_requested",
            {"revision_id": str(draft.id), "job_id": str(job.id)},
        )
    accepted = PublishAccepted(job_id=job.id, revision_id=draft.id)
    payload = accepted.model_dump(mode="json")
    if idempotency_key is not None:
        idempotency.save(user_id, scope, idempotency_key, digest, 202, payload)
    repo.commit()
    publish_job(documents_repo, publisher, job)
    return JSONResponse(payload, status_code=202)


@router.post(
    "/documents/{document_id}/revisions/{revision_id}/restore",
    operation_id="restoreDocumentRevision",
    responses=problem_responses(409),
)
def restore_revision(
    access: EditDocument,
    revision_id: Annotated[uuid.UUID, Path()],
    repo: ContentRepo,
) -> RestoredDraft:
    """Put a previous published revision's content into the draft (rollback); publish it to
    make it live. Restoring the active revision discards the draft's corrections."""
    user_id = access.workspace.user_id
    document = repo.document(access.resource_id, lock=True)
    _require_published(document)
    source = repo.revision(document.id, revision_id)
    if source is None or source.is_draft:
        raise HTTPException(status_code=404, detail=REVISION_NOT_FOUND)
    draft = repo.current_draft(document, lock=True)
    if draft is None:
        draft = repo.create_draft(document, source, parent_revision_id=source.id, actor_id=user_id)
    else:
        if repo.active_parse_job(document.workspace_id, draft.id) is not None:
            raise _publish_in_progress()
        repo.replace_draft_content(draft, source)
        _refresh_hash(repo, document, draft)
    repo.record_activity(
        document,
        user_id,
        "document.revision_restored",
        {"revision_id": str(draft.id), "source_revision_id": str(source.id)},
    )
    repo.commit()
    return RestoredDraft(document_id=document.id, revision=_info(draft, document))
