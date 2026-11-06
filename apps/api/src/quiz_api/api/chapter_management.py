"""Chapter management API (UX12 CHAPTER-4, CHMAN-01; docs/questions.md §14.5).

    GET    /workspaces/{id}/chapter-tree       the books' chapter trees with counts
    POST   /workspaces/{id}/chapters           add a chapter (key `user-<uuid>`)
    PATCH  /chapters/{id}                      rename
    POST   /documents/{id}/chapters/tree       batch move, `expected_version`
    DELETE /chapters/{id}?move_questions_to=   delete, moving its questions

Edits apply to the active revision at once (D-9), through the `chapter_edit_*` functions that are
the only way past the published revision guard (20261106150000_chapter_edit.sql).

Authorization (C01): all five need `Action.DOCUMENT_EDIT`, also the read, which only serves the
editor: viewers 403 `insufficient-role`, an archived workspace 403 `workspace-archived`, unknown,
deleted and foreign ids one 404. Share sessions have no such routes.

Every write (C02), one transaction: `Idempotency-Key` replay; the workspace FOR SHARE (route
dependency); the document FOR UPDATE, with a target book of another document taken in document id
order (FOR SHARE); a queued or running publish of the correction draft refuses with 409
`publish-in-progress`; the questions in id order. So a publish, a chapter assignment and a fork
commit each wait for the edit or come first, never crossing locks.

Common effects (C07): the whole revision's `level` and `sort_order` are recomputed, the correction
draft takes the new tree (a publish would otherwise drop `user-*` chapters and null their
questions), the active revision's `content_hash` follows (it covers the section tree and the
worker verifies it on load), `chapter_tree_version` goes up. Activity carries ids and counts only.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from quiz_api.api.document_revisions import (
    ContentRepo,
    _publish_in_progress,
    _refresh_hash,
)
from quiz_api.api.questions import (
    IdempotencyStoreDep,
    _constraint_violation,
    _with_lock_retry,
)
from quiz_api.auth import CurrentUser
from quiz_api.authz import (
    AccessRepository,
    Action,
    LockMode,
    ResourceAccess,
    ResourceType,
    WorkspaceAccess,
    authorize_resource,
    authorize_workspace,
    get_access_repository,
    require_workspace_access,
)
from quiz_api.chapter_tree import (
    ChapterTreeError,
    Children,
    Move,
    PlacedNode,
    TreeNode,
    UnknownChapterError,
    append_child,
    apply_moves,
    children_of,
    flatten,
    remove_node,
)
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.chapter_edit import (
    USER_KEY_PREFIX,
    ChapterEditRepository,
    ChapterRef,
)
from quiz_api.repositories.chapter_redistribution import ChapterRedistributionRepository
from quiz_api.repositories.document_content import (
    DocumentContentRepository,
    DocumentRef,
    RevisionRow,
)
from quiz_api.repositories.questions import QuestionRepository

router = APIRouter(tags=["chapters"], responses=problem_responses(503))

NOT_FOUND = "Not found."
CHAPTER_NOT_FOUND = "Chapter not found."  # `authorize_resource`'s body, for one 404 on DELETE
MAX_MOVES = 500

ChapterTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]


# --- schemas ------------------------------------------------------------------------------------


class TreeChapter(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    section_key: str = Field(description="Stable across revisions; `user-<uuid>` when added here.")
    title: str
    level: int = Field(description="1 = top level; parent + 1.")
    sort_order: int = Field(description="Pre-order position in the revision.")
    page: int | None
    question_count: int = Field(description="Live CONFIRMED questions, sub-chapters excluded.")
    attached_question_count: int = Field(
        description="Every question on the chapter, also drafts, archived and deleted ones: more "
        "than zero means a delete needs `move_questions_to`."
    )
    has_note: bool = Field(description="A chapter note exists (deleting hides it).")
    user_created: bool


class TreeDocument(BaseModel):
    document_id: uuid.UUID
    title: str
    revision_id: uuid.UUID
    version: int = Field(description="`expected_version` of the next batch move.")
    chapters: list[TreeChapter] = Field(description="Outline order.")


class ChapterTree(BaseModel):
    documents: list[TreeDocument]


class ChapterCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: uuid.UUID
    parent_id: uuid.UUID | None = Field(default=None, description="null = a top-level chapter.")
    title: ChapterTitle


class ChapterUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: ChapterTitle


class ChapterWrite(BaseModel):
    chapter: TreeChapter
    version: int


class ChapterMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapter_id: uuid.UUID
    parent_id: uuid.UUID | None
    position: int = Field(ge=0, le=100_000, description="0-based among the new siblings.")


class ChapterTreeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=0)
    moves: list[ChapterMove] = Field(min_length=1, max_length=MAX_MOVES)


class ChapterTreeResult(BaseModel):
    version: int
    chapters: list[TreeChapter] = Field(description="Outline order.")


class ChapterDeleteResult(BaseModel):
    workspace_id: uuid.UUID = Field(
        description="Where the chapter was: a retry is authorized here, the chapter being gone."
    )
    moved_questions: int
    version: int


# --- dependencies -------------------------------------------------------------------------------


def _edit_repo(session: Annotated[Session, Depends(get_db_session)]) -> ChapterEditRepository:
    return ChapterEditRepository(session)


def _redist_repo(
    session: Annotated[Session, Depends(get_db_session)],
) -> ChapterRedistributionRepository:
    return ChapterRedistributionRepository(session)


def _questions(session: Annotated[Session, Depends(get_db_session)]) -> QuestionRepository:
    return QuestionRepository(session)


AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


def _chapter_access(
    chapter_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> ResourceAccess:
    return authorize_resource(repo, user.id, ResourceType.CHAPTER, chapter_id, Action.DOCUMENT_EDIT)


def _document_access(
    document_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> ResourceAccess:
    return authorize_resource(
        repo, user.id, ResourceType.DOCUMENT, document_id, Action.DOCUMENT_EDIT
    )


ReadTree = Annotated[
    WorkspaceAccess,
    Depends(require_workspace_access(Action.DOCUMENT_EDIT, lock=LockMode.NONE)),
]
EditWorkspace = Annotated[WorkspaceAccess, Depends(require_workspace_access(Action.DOCUMENT_EDIT))]
EditChapter = Annotated[ResourceAccess, Depends(_chapter_access)]
EditDocument = Annotated[ResourceAccess, Depends(_document_access)]
EditRepo = Annotated[ChapterEditRepository, Depends(_edit_repo)]
RedistRepo = Annotated[ChapterRedistributionRepository, Depends(_redist_repo)]
QuestionRepo = Annotated[QuestionRepository, Depends(_questions)]


# --- helpers ------------------------------------------------------------------------------------


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail=NOT_FOUND)


def _invalid_document() -> ProblemException:
    return ProblemException(
        422,
        ProblemType.CHAPTER_INVALID,
        detail="Chapters are edited on a live book with a published revision.",
    )


def _tree_changed() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.CHAPTER_TREE_CHANGED,
        detail="The chapter tree changed. Reload it and try again.",
    )


def _tree_invalid(error: ChapterTreeError) -> ProblemException:
    return ProblemException(422, ProblemType.CHAPTER_TREE_INVALID, detail=str(error))


def _nodes(rows: Sequence[RowMapping]) -> list[TreeNode]:
    return [TreeNode(r["id"], r["parent_id"], r["sort_order"]) for r in rows]


def _out(
    row: RowMapping,
    document_id: uuid.UUID,
    counts: Mapping[uuid.UUID, int],
    attached: Mapping[uuid.UUID, int],
    noted: set[tuple[uuid.UUID, str]],
) -> TreeChapter:
    key = row["section_key"]
    return TreeChapter(
        id=row["id"],
        parent_id=row["parent_id"],
        section_key=key,
        title=row["title"],
        level=row["level"],
        sort_order=row["sort_order"],
        page=row["page"],
        question_count=counts.get(row["id"], 0),
        attached_question_count=attached.get(row["id"], 0),
        has_note=(document_id, key) in noted,
        user_created=key.startswith(USER_KEY_PREFIX),
    )


@dataclass(frozen=True)
class _Editing:
    """A document held FOR UPDATE, ready for a chapter write."""

    document: DocumentRef
    revision_id: uuid.UUID
    draft: RevisionRow | None

    @property
    def workspace_id(self) -> uuid.UUID:
        return self.document.workspace_id


def _begin(
    edit: ChapterEditRepository,
    content: DocumentContentRepository,
    workspace_id: uuid.UUID,
    document_id: uuid.UUID,
) -> _Editing:
    found = edit.editable_document(document_id)
    if found is None or found.workspace_id != workspace_id:
        raise _not_found()
    document = content.document(document_id, lock=True)
    # Read again under the lock: a publish or a kind change may have committed first.
    found = edit.editable_document(document_id)
    if found is None or found.revision_id is None:
        raise _invalid_document()
    draft = content.current_draft(document, lock=True)
    if draft is not None and content.active_parse_job(workspace_id, draft.id) is not None:
        raise _publish_in_progress()
    return _Editing(document, found.revision_id, draft)


def _active_chapter(
    edit: ChapterEditRepository, editing: _Editing, chapter_id: uuid.UUID
) -> ChapterRef:
    """A chapter of the locked document's active revision. An older revision's id is a screen
    that missed a publish; anything else does not exist here."""
    chapter = edit.chapter(chapter_id)
    if (
        chapter is None
        or chapter.workspace_id != editing.workspace_id
        or chapter.document_id != editing.document.id
    ):
        raise _not_found()
    if chapter.document_revision_id != editing.revision_id:
        raise _tree_changed()
    return chapter


def _finish(
    edit: ChapterEditRepository,
    content: DocumentContentRepository,
    editing: _Editing,
    nodes: Sequence[PlacedNode] | None,
    renamed_key: str | None = None,
) -> int:
    """The common effects of a write (module docstring). Returns the new version."""
    workspace_id, document = editing.workspace_id, editing.document
    if nodes is not None:
        edit.write_tree(workspace_id, document.id, nodes)
    if editing.draft is not None:
        edit.sync_draft(workspace_id, document.id, editing.draft.id, renamed_key)
        _refresh_hash(content, document, editing.draft)
    active = content.revision(document.id, editing.revision_id)
    assert active is not None  # noqa: S101 - the locked document points at it
    loaded = content.load_content(document, active)
    assert loaded.content_hash is not None  # noqa: S101 - load_content computes it
    return edit.finish(workspace_id, document.id, loaded.content_hash)


def _idempotent(
    idempotency: IdempotencyStoreDep,
    edit: ChapterEditRepository,
    questions: QuestionRepository,
    *,
    actor_id: uuid.UUID,
    scope: str,
    key: str | None,
    body_hash: str,
    success: int,
    work: Callable[[], BaseModel],
) -> Any:
    """Replay a stored response or run `work` under the lock retry and store its result, all in
    the request's one transaction."""
    if key is not None:
        idempotency.lock(actor_id, scope, key)
        stored = idempotency.find(actor_id, scope, key)
        if stored is not None:
            return replay(stored, body_hash)
    try:
        result = _with_lock_retry(questions, work)
        if key is not None:
            idempotency.save(
                actor_id, scope, key, body_hash, success, result.model_dump(mode="json")
            )
        edit.commit()
    except (IntegrityError, DataError):
        raise _constraint_violation(questions) from None
    return JSONResponse(result.model_dump(mode="json"), status_code=success)


# --- routes -------------------------------------------------------------------------------------


@router.get(
    "/workspaces/{workspace_id}/chapter-tree",
    operation_id="getChapterTree",
    response_model=ChapterTree,
)
def get_chapter_tree(access: ReadTree, edit: EditRepo) -> ChapterTree:
    """The chapter tree of every live book, with question counts and whether a note exists. No
    book text, answers or explanations."""
    workspace_id = access.workspace_id
    counts = edit.question_counts(workspace_id)
    attached = edit.attached_question_counts(workspace_id)
    noted = edit.noted_sections(workspace_id)
    return ChapterTree(
        documents=[
            TreeDocument(
                document_id=book.id,
                title=book.title,
                revision_id=book.revision_id,
                version=book.version,
                chapters=[
                    _out(r, book.id, counts, attached, noted) for r in edit.tree(book.revision_id)
                ],
            )
            for book in edit.books(workspace_id)
        ]
    )


@router.post(
    "/workspaces/{workspace_id}/chapters",
    operation_id="createChapter",
    status_code=status.HTTP_201_CREATED,
    response_model=ChapterWrite,
    responses=problem_responses(409),
)
def create_chapter(
    access: EditWorkspace,
    body: ChapterCreateRequest,
    edit: EditRepo,
    content: ContentRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Add a chapter as the last child of `parent_id`, in the active revision. The book's text
    does not change: the chapter starts empty."""
    workspace_id, actor_id = access.workspace_id, access.user_id

    def work() -> ChapterWrite:
        editing = _begin(edit, content, workspace_id, body.document_id)
        if body.parent_id is not None:
            _active_chapter(edit, editing, body.parent_id)
        chapter_id = uuid.uuid4()
        children = children_of(_nodes(edit.tree(editing.revision_id)))
        try:
            nodes = flatten(append_child(children, chapter_id, body.parent_id))
        except ChapterTreeError as exc:
            raise _tree_invalid(exc) from None
        edit.create(workspace_id, body.document_id, chapter_id, body.parent_id, body.title)
        version = _finish(edit, content, editing, nodes)
        content.record_activity(
            editing.document,
            actor_id,
            "document.chapter_created",
            {"chapter_id": str(chapter_id)},
        )
        row = next(r for r in edit.tree(editing.revision_id) if r["id"] == chapter_id)
        return ChapterWrite(chapter=_out(row, body.document_id, {}, {}, set()), version=version)

    return _idempotent(
        idempotency,
        edit,
        questions,
        actor_id=actor_id,
        scope=f"POST /workspaces/{workspace_id}/chapters",
        key=idempotency_key,
        body_hash=request_hash(body.model_dump(mode="json")),
        success=status.HTTP_201_CREATED,
        work=work,
    )


@router.patch(
    "/chapters/{chapter_id}",
    operation_id="updateChapter",
    response_model=ChapterWrite,
    responses=problem_responses(409),
)
def update_chapter(
    access: EditChapter,
    body: ChapterUpdateRequest,
    edit: EditRepo,
    content: ContentRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Rename a chapter. Its key stays, so notes, summaries and publishes keep following it."""
    workspace_id, actor_id = access.workspace.workspace_id, access.workspace.user_id
    chapter_id = access.resource_id

    def work() -> ChapterWrite:
        known = edit.chapter(chapter_id)
        if known is None:
            raise _not_found()
        editing = _begin(edit, content, workspace_id, known.document_id)
        chapter = _active_chapter(edit, editing, chapter_id)
        edit.rename(workspace_id, chapter.document_id, chapter_id, body.title)
        version = _finish(edit, content, editing, None, chapter.section_key)
        content.record_activity(
            editing.document,
            actor_id,
            "document.chapter_renamed",
            {"chapter_id": str(chapter_id)},
        )
        row = next(r for r in edit.tree(editing.revision_id) if r["id"] == chapter_id)
        return ChapterWrite(
            chapter=_out(
                row,
                chapter.document_id,
                edit.question_counts(workspace_id),
                edit.attached_question_counts(workspace_id),
                edit.noted_sections(workspace_id),
            ),
            version=version,
        )

    return _idempotent(
        idempotency,
        edit,
        questions,
        actor_id=actor_id,
        scope=f"PATCH /chapters/{chapter_id}",
        key=idempotency_key,
        body_hash=request_hash(body.model_dump(mode="json")),
        success=status.HTTP_200_OK,
        work=work,
    )


@router.post(
    "/documents/{document_id}/chapters/tree",
    operation_id="moveChapters",
    response_model=ChapterTreeResult,
    responses=problem_responses(409),
)
def move_chapters(
    access: EditDocument,
    body: ChapterTreeUpdate,
    edit: EditRepo,
    content: ContentRepo,
    questions: QuestionRepo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Apply moves in order and recompute `level` and `sort_order` for the whole revision. Only
    from the version the client read: all moves or none."""
    workspace_id, actor_id = access.workspace.workspace_id, access.workspace.user_id
    document_id = access.resource_id

    def work() -> ChapterTreeResult:
        editing = _begin(edit, content, workspace_id, document_id)
        if edit.version(document_id) != body.expected_version:
            raise _tree_changed()
        children: Children = children_of(_nodes(edit.tree(editing.revision_id)))
        try:
            nodes = flatten(
                apply_moves(
                    children,
                    [Move(m.chapter_id, m.parent_id, m.position) for m in body.moves],
                )
            )
        except ChapterTreeError as exc:
            raise _tree_invalid(exc) from None
        except UnknownChapterError:
            raise _not_found() from None
        version = _finish(edit, content, editing, nodes)
        content.record_activity(
            editing.document,
            actor_id,
            "document.chapters_moved",
            {"moves": len(body.moves)},
        )
        counts = edit.question_counts(workspace_id)
        attached = edit.attached_question_counts(workspace_id)
        noted = edit.noted_sections(workspace_id)
        return ChapterTreeResult(
            version=version,
            chapters=[
                _out(r, document_id, counts, attached, noted)
                for r in edit.tree(editing.revision_id)
            ],
        )

    return _idempotent(
        idempotency,
        edit,
        questions,
        actor_id=actor_id,
        scope=f"POST /documents/{document_id}/chapters/tree",
        key=idempotency_key,
        body_hash=request_hash(body.model_dump(mode="json")),
        success=status.HTTP_200_OK,
        work=work,
    )


@router.delete(
    "/chapters/{chapter_id}",
    operation_id="deleteChapter",
    response_model=ChapterDeleteResult,
    responses=problem_responses(409),
)
def delete_chapter(
    chapter_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    access_repo: AccessRepo,
    edit: EditRepo,
    content: ContentRepo,
    questions: QuestionRepo,
    redist: RedistRepo,
    idempotency: IdempotencyStoreDep,
    move_questions_to: Annotated[
        uuid.UUID | Literal["none"] | None,
        Query(description='Chapter id or `none` ("챕터 없음"); required when questions are here.'),
    ] = None,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Delete a chapter. Its questions go where the person chose (no new question revision;
    attempts and runs stay), its blocks and sub-chapters go to its parent.

    A retry finds the chapter gone, so the saved response comes first: the key is the caller's
    own, and the workspace the saved response names is authorized like the delete was (a member
    removed since gets the same 404, a viewer or an archived workspace the same 403). The advisory
    lock comes first too, so a retry racing the first request waits and finds the response.
    """
    scope = f"DELETE /chapters/{chapter_id}"
    body_hash = request_hash({"move_questions_to": str(move_questions_to)})
    if idempotency_key is not None:
        idempotency.lock(user.id, scope, idempotency_key)
        stored = idempotency.find(user.id, scope, idempotency_key)
        if stored is not None:
            authorize_workspace(
                access_repo,
                user.id,
                uuid.UUID(stored.body["workspace_id"]),
                Action.DOCUMENT_EDIT,
                not_found_detail=CHAPTER_NOT_FOUND,
            )
            return replay(stored, body_hash)
    access = authorize_resource(
        access_repo, user.id, ResourceType.CHAPTER, chapter_id, Action.DOCUMENT_EDIT
    )
    workspace_id, actor_id = access.workspace.workspace_id, access.workspace.user_id
    target_id = move_questions_to if isinstance(move_questions_to, uuid.UUID) else None

    def work() -> ChapterDeleteResult:
        known = edit.chapter(chapter_id)
        if known is None:
            raise _not_found()
        if target_id == chapter_id:
            raise ProblemException(
                422,
                ProblemType.CHAPTER_INVALID,
                detail="A chapter cannot take its own questions.",
            )
        target_document: uuid.UUID | None = None
        if target_id is not None:
            target = edit.chapter(target_id)
            if target is None or target.workspace_id != workspace_id:
                raise _not_found()
            if target.document_id != known.document_id:
                target_document = target.document_id
        # Document id order (CHMAN-01-C02): the edited one FOR UPDATE, the target's FOR SHARE.
        if target_document is not None and target_document < known.document_id:
            questions.lock_documents(workspace_id, document_ids=[target_document])
        editing = _begin(edit, content, workspace_id, known.document_id)
        if target_document is not None and target_document > known.document_id:
            questions.lock_documents(workspace_id, document_ids=[target_document])
        _active_chapter(edit, editing, chapter_id)
        if target_id is not None:
            found = redist.target_chapters(workspace_id, [target_id]).get(target_id)
            if found is None:
                raise _not_found()
            if not found.valid:
                raise ProblemException(
                    422,
                    ProblemType.CHAPTER_INVALID,
                    detail="The target is not a chapter of the current revision of a live book.",
                )

        moving = edit.questions_in_chapter(workspace_id, chapter_id)
        if moving and move_questions_to is None:
            raise ProblemException(
                422,
                ProblemType.CHAPTER_TARGET_REQUIRED,
                detail="Choose where this chapter's questions go.",
            )
        questions.set_chapter(
            workspace_id,
            [(question_id, chapter_id, target_id) for question_id in moving],
            chapter_source="manual",
            change_source="chapter_edit",
            actor_id=actor_id,
        )
        edit.move_drafts(workspace_id, chapter_id, target_id)
        nodes = flatten(
            remove_node(children_of(_nodes(edit.tree(editing.revision_id))), chapter_id)
        )
        edit.delete(workspace_id, editing.document.id, chapter_id)
        version = _finish(edit, content, editing, nodes)
        content.record_activity(
            editing.document,
            actor_id,
            "document.chapter_deleted",
            {
                "chapter_id": str(chapter_id),
                "moved_questions": len(moving),
                "target_chapter_id": str(target_id) if target_id else None,
            },
        )
        return ChapterDeleteResult(
            workspace_id=workspace_id, moved_questions=len(moving), version=version
        )

    return _idempotent(
        idempotency,
        edit,
        questions,
        actor_id=actor_id,
        scope=scope,
        key=idempotency_key,
        body_hash=body_hash,
        success=status.HTTP_200_OK,
        work=work,
    )
