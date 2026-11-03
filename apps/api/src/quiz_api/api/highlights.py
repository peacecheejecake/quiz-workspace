"""Personal highlights API (UX9-HL-B, HILITE-01-C01~C08; docs/questions.md §15,
architecture.md §5-§6, workspace-sharing.md §11).

    GET    /chapters/{chapterId}/my-highlights      the caller's highlights of a chapter: every
                                                    note version of the chapter, then the
                                                    explanations of its live CONFIRMED questions
    GET    /workspaces/{id}/my-highlights?chapter=none   the same for the "챕터 없음" group
    GET    /questions/{id}/my-highlights            the caller's highlights of one explanation
    POST   /my-highlights                           make one (`replace_ids` merges, atomically)
    PATCH  /my-highlights/{id}                      change the color (`version` lock)
    DELETE /my-highlights/{id}                      soft delete (idempotent)
    POST   /my-highlights/{id}/restore              undo a delete within 10 minutes

A highlight is a personal record: every route reads and writes the rows of the verified JWT `sub`
only, and another user's id answers exactly like an unknown id (404). Any member may highlight —
also in an archived workspace, the one write an archived workspace allows (`Action.HIGHLIGHT`,
user decision 2026-11-02 (i)). There is no workspace-wide list (user decision C5), no activity
event, no share route and no fork copy.

The server cuts the quote and its 32-character context from the stored text (a note version's
presented item, a question revision's explanation paragraph); a quote the client sends is ignored.
Responses never carry the prefix/suffix or any other explanation text, only the user's own quote
(HILITE-01-C07). Explanation highlights are found again in the question's current revision on
every read (`exact` / `relocated` / `missing`, `quiz_api.highlight_anchor`) and are grouped by the
question's *current* chapter. Nothing here logs a quote.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from quiz_api.api.question_overview import NO_CHAPTER_TITLE, chapter_number
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
from quiz_api.chapter_notes import question_label, stem_preview
from quiz_api.db import get_db_session
from quiz_api.errors import ProblemException, ProblemType, problem_responses
from quiz_api.highlight_anchor import (
    Anchor,
    AnchorError,
    block_order,
    cut,
    explanation_blocks,
    note_blocks,
    overlaps,
    relocate,
)
from quiz_api.idempotency import IdempotencyKey, replay, request_hash
from quiz_api.repositories.chapter_notes import ChapterNoteRepository
from quiz_api.repositories.highlights import HighlightRepository, HighlightRow, QuestionText
from quiz_api.repositories.idempotency import IdempotencyStore

router = APIRouter(tags=["highlights"])

NOT_FOUND = "Not found."
HIGHLIGHT_NOT_FOUND = "Highlight not found."
LIMIT_PER_TARGET = 500
CREATE_SCOPE = "POST /my-highlights"

Color = Literal["yellow", "blue", "pink"]
AnchorStatus = Literal["exact", "relocated", "missing"]


# --- schemas ------------------------------------------------------------------------------------


class HighlightAnchor(BaseModel):
    block: str = Field(
        max_length=16,
        description="`s<i>.i<j>` (note item `sections[i].items[j]`) or `p<i>` (explanation "
        "paragraph, blank-line separated, 0-based).",
    )
    start: int = Field(ge=0, le=10_000_000, description="UTF-16 offset in the block.")
    end: int = Field(ge=0, le=10_000_000, description="UTF-16 offset, exclusive.")


class NoteTargetIn(BaseModel):
    kind: Literal["note"]
    chapter_note_id: uuid.UUID = Field(description="A succeeded chapter note version.")


class ExplanationTargetIn(BaseModel):
    kind: Literal["explanation"]
    question_id: uuid.UUID = Field(description="The question's current revision's explanation.")
    question_revision_id: uuid.UUID | None = Field(
        default=None,
        description="The revision whose explanation the client showed (recommended): 409 "
        "`stale-revision` when it is no longer the current one, so the anchor is never applied "
        "to a different text.",
    )


class AiExplanationTargetIn(BaseModel):
    kind: Literal["ai_explanation"]
    ai_explanation_id: uuid.UUID = Field(description="AIEXPL-01 (not available yet: 404).")


HighlightTargetIn = Annotated[
    NoteTargetIn | ExplanationTargetIn | AiExplanationTargetIn, Field(discriminator="kind")
]


class HighlightCreate(BaseModel):
    target: HighlightTargetIn
    anchor: HighlightAnchor
    color: Color
    replace_ids: list[uuid.UUID] | None = Field(
        default=None,
        max_length=100,
        description="The caller's live highlights of the same target that overlap `anchor`: "
        "removed in the same transaction (merge). They cannot be restored.",
    )


class HighlightUpdate(BaseModel):
    color: Color
    version: int = Field(ge=1, description="The `version` the client read (optimistic lock).")


class NoteHighlightTarget(BaseModel):
    kind: Literal["note"]
    chapter_note_id: uuid.UUID
    note_version: int


class ExplanationHighlightTarget(BaseModel):
    kind: Literal["explanation"]
    question_id: uuid.UUID
    question_revision_id: uuid.UUID = Field(description="The revision it was made on.")


class AiExplanationHighlightTarget(BaseModel):
    kind: Literal["ai_explanation"]
    ai_explanation_id: uuid.UUID
    question_id: uuid.UUID


HighlightTarget = Annotated[
    NoteHighlightTarget | ExplanationHighlightTarget | AiExplanationHighlightTarget,
    Field(discriminator="kind"),
]


class HighlightQuestion(BaseModel):
    question_id: uuid.UUID
    number_label: str = Field(description="`<n>장 <번호>번` (the Heatmap's numbering).")
    stem_preview: str = Field(description="First 40 characters of the current stem.")


class Highlight(BaseModel):
    id: uuid.UUID
    color: Color
    version: int
    target: HighlightTarget
    anchor: HighlightAnchor = Field(description="Where it was made (in its note version/revision).")
    quote: str = Field(description="The highlighted text, cut by the server.")
    anchor_status: AnchorStatus = Field(
        description="`exact`: same text; `relocated`: found again in the current revision; "
        "`missing`: the current explanation no longer contains the quote."
    )
    anchor_current: HighlightAnchor | None = Field(
        description="Position in the current text; null when missing."
    )
    question: HighlightQuestion | None = Field(description="Explanation highlights only.")
    created_at: datetime
    updated_at: datetime


class HighlightList(BaseModel):
    items: list[Highlight] = Field(
        description="Display order: note highlights (newest version first, body order), then "
        "explanation highlights (Heatmap order, position in the explanation)."
    )


# --- dependencies -------------------------------------------------------------------------------


def get_highlight_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> HighlightRepository:
    return HighlightRepository(session)


def get_note_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> ChapterNoteRepository:
    return ChapterNoteRepository(session)


def get_idempotency_store(
    session: Annotated[Session, Depends(get_db_session)],
) -> IdempotencyStore:
    return IdempotencyStore(session)


Repo = Annotated[HighlightRepository, Depends(get_highlight_repository)]
NoteRepo = Annotated[ChapterNoteRepository, Depends(get_note_repository)]
IdempotencyStoreDep = Annotated[IdempotencyStore, Depends(get_idempotency_store)]
AccessRepo = Annotated[AccessRepository, Depends(get_access_repository)]


def _uniform(call: Callable[[], ResourceAccess], detail: str = NOT_FOUND) -> ResourceAccess:
    try:
        return call()
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=detail) from None
        raise


def _read_chapter(
    chapter_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> ResourceAccess:
    return _uniform(
        lambda: authorize_resource(repo, user.id, ResourceType.CHAPTER, chapter_id, Action.READ)
    )


def _read_question(
    question_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> ResourceAccess:
    return authorize_resource(repo, user.id, ResourceType.QUESTION, question_id, Action.READ)


def _read_workspace(
    workspace_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> WorkspaceAccess:
    return authorize_workspace(repo, user.id, workspace_id, Action.READ)


def _own_highlight(
    highlight_id: Annotated[uuid.UUID, Path()], user: CurrentUser, repo: AccessRepo
) -> ResourceAccess:
    return _uniform(
        lambda: authorize_resource(
            repo, user.id, ResourceType.HIGHLIGHT, highlight_id, Action.HIGHLIGHT
        ),
        HIGHLIGHT_NOT_FOUND,
    )


ReadChapter = Annotated[ResourceAccess, Depends(_read_chapter)]
ReadQuestion = Annotated[ResourceAccess, Depends(_read_question)]
ReadWorkspace = Annotated[WorkspaceAccess, Depends(_read_workspace)]
OwnHighlight = Annotated[ResourceAccess, Depends(_own_highlight)]


# --- presentation -------------------------------------------------------------------------------


def _anchor(raw: dict[str, Any]) -> Anchor:
    return Anchor(str(raw.get("block", "")), int(raw.get("start", 0)), int(raw.get("end", 0)))


def _anchor_out(anchor: Anchor) -> HighlightAnchor:
    return HighlightAnchor(block=anchor.block, start=anchor.start, end=anchor.end)


class _Context:
    """Current question texts and labels for presenting a batch of highlights."""

    def __init__(self, repo: HighlightRepository, workspace_id: uuid.UUID) -> None:
        self._repo = repo
        self.workspace_id = workspace_id
        self.texts: dict[uuid.UUID, QuestionText] = {}
        self.labels: dict[uuid.UUID, HighlightQuestion] = {}
        self.positions: dict[uuid.UUID, int] = {}
        self._pinned: set[uuid.UUID] = set()

    def pin(self, text: QuestionText) -> None:
        """Use this snapshot of the question for every later label/position/relocation in the
        request, even if a concurrent edit commits a newer revision meanwhile."""
        self.texts[text.question_id] = text
        self._pinned.add(text.question_id)

    def add_group(
        self, chapter_id: uuid.UUID | None, title: str | None, ordered: list[QuestionText]
    ) -> None:
        number: int | None = None
        if chapter_id is not None:
            number = chapter_number(self._repo.chapter_lineage([chapter_id]).get(chapter_id, []))
        heading = title if title is not None else NO_CHAPTER_TITLE
        for position, q in enumerate(ordered, start=1):
            if q.question_id not in self._pinned:
                self.texts[q.question_id] = q
            self.positions[q.question_id] = position
            self.labels[q.question_id] = HighlightQuestion(
                question_id=q.question_id,
                number_label=question_label(number, heading, q.question_number, position),
                stem_preview=stem_preview(q.stem),
            )

    def ensure(self, question_ids: Iterable[uuid.UUID]) -> None:
        """Labels for questions outside the groups added so far (their own Heatmap group)."""
        for qid in set(question_ids) - set(self.labels):
            text = self.texts.get(qid) or self._repo.questions(self.workspace_id, [qid]).get(qid)
            if text is None:
                continue
            group = self._repo.group_of(self.workspace_id, qid)
            ordered = self._repo.heatmap_group(self.workspace_id, group.chapter_id)
            self.add_group(group.chapter_id, group.chapter_title, ordered)
            if qid not in self.labels:  # a draft or archived question: not in its group
                number: int | None = None
                if group.chapter_id is not None:
                    lineage = self._repo.chapter_lineage([group.chapter_id])
                    number = chapter_number(lineage.get(group.chapter_id, []))
                heading = group.chapter_title or NO_CHAPTER_TITLE
                if qid not in self._pinned:
                    self.texts[qid] = text
                self.labels[qid] = HighlightQuestion(
                    question_id=qid,
                    number_label=question_label(
                        number, heading, text.question_number, len(ordered) + 1
                    ),
                    stem_preview=stem_preview(text.stem),
                )

    def position(self, question_id: uuid.UUID | None) -> int:
        return self.positions.get(question_id, 0) if question_id is not None else 0

    def current(self, row: HighlightRow) -> tuple[AnchorStatus, Anchor | None]:
        anchor = _anchor(row.anchor)
        if row.target_kind == "note":
            return "exact", anchor  # note versions never change
        text = self.texts.get(row.question_id) if row.question_id else None
        if text is None or text.revision_id is None:
            return "missing", None
        if row.question_revision_id == text.revision_id:
            return "exact", anchor
        found = relocate(
            explanation_blocks(text.explanation), anchor, row.quote, row.prefix, row.suffix
        )
        return ("relocated", found) if found is not None else ("missing", None)

    def present(self, row: HighlightRow) -> Highlight:
        state, current = self.current(row)
        target: NoteHighlightTarget | ExplanationHighlightTarget
        question: HighlightQuestion | None = None
        if row.target_kind == "note" and row.chapter_note_id is not None:
            target = NoteHighlightTarget(
                kind="note", chapter_note_id=row.chapter_note_id, note_version=row.note_version or 0
            )
        elif row.question_id is not None and row.question_revision_id is not None:
            target = ExplanationHighlightTarget(
                kind="explanation",
                question_id=row.question_id,
                question_revision_id=row.question_revision_id,
            )
            question = self.labels.get(row.question_id)
        else:  # excluded by user_highlights_target_columns
            raise ValueError(f"highlight {row.id} has no target")
        return Highlight(
            id=row.id,
            color=row.color,  # type: ignore[arg-type]
            version=row.version,
            target=target,
            anchor=_anchor_out(_anchor(row.anchor)),
            quote=row.quote,
            anchor_status=state,
            anchor_current=_anchor_out(current) if current is not None else None,
            question=question,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


def _position_key(ctx: _Context, row: HighlightRow) -> tuple[Any, ...]:
    _, current = ctx.current(row)
    anchor = current or _anchor(row.anchor)
    return (block_order(anchor.block), anchor.start, row.created_at, row.id)


def _explanation_items(
    repo: HighlightRepository, ctx: _Context, user_id: uuid.UUID, ordered: list[QuestionText]
) -> list[Highlight]:
    rows = repo.live_on_questions(user_id, ctx.workspace_id, [q.question_id for q in ordered])
    rows.sort(key=lambda r: (ctx.position(r.question_id), *_position_key(ctx, r)))
    return [ctx.present(r) for r in rows]


def _one(repo: HighlightRepository, row: HighlightRow) -> Highlight:
    ctx = _Context(repo, row.workspace_id)
    if row.question_id is not None:
        ctx.ensure([row.question_id])
    return ctx.present(row)


# --- write helpers ------------------------------------------------------------------------------


def _unavailable(detail: str) -> ProblemException:
    return ProblemException(409, ProblemType.HIGHLIGHT_TARGET_UNAVAILABLE, detail=detail)


def _invalid(detail: str) -> ProblemException:
    return ProblemException(422, ProblemType.HIGHLIGHT_ANCHOR_INVALID, detail=detail)


def _overlap() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.HIGHLIGHT_OVERLAP,
        detail="The range overlaps another of your highlights.",
    )


def _limit() -> ProblemException:
    return ProblemException(
        409,
        ProblemType.HIGHLIGHT_LIMIT,
        detail=f"At most {LIMIT_PER_TARGET} highlights per note version or explanation.",
    )


def _live_positions(ctx: _Context, rows: list[HighlightRow]) -> dict[uuid.UUID, Anchor | None]:
    """Each live row's position in the current text (None when missing)."""
    return {r.id: ctx.current(r)[1] for r in rows}


# --- routes -------------------------------------------------------------------------------------


@router.get(
    "/chapters/{chapter_id}/my-highlights",
    operation_id="listChapterHighlights",
    response_model=HighlightList,
)
def list_chapter_highlights(
    access: ReadChapter, user: CurrentUser, repo: Repo, notes: NoteRepo
) -> HighlightList:
    """The caller's highlights of the chapter: those of every note version of the chapter (version
    number included) and the explanation highlights of the questions now in it (live CONFIRMED;
    archived, deleted, draft and moved-away questions are left out)."""
    workspace_id = access.workspace.workspace_id
    chapter = notes.chapter(access.resource_id, workspace_id)
    if chapter is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    ctx = _Context(repo, workspace_id)
    note_rows = repo.live_on_chapter_notes(
        user.id, workspace_id, chapter.document_id, chapter.section_key
    )
    note_rows.sort(
        key=lambda r: (-(r.note_version or 0), *_position_key(ctx, r))  # newest version first
    )
    ordered = repo.heatmap_group(workspace_id, chapter.id)
    ctx.add_group(chapter.id, chapter.title, ordered)
    items = [ctx.present(r) for r in note_rows]
    items += _explanation_items(repo, ctx, user.id, ordered)
    return HighlightList(items=items)


@router.get(
    "/workspaces/{workspace_id}/my-highlights",
    operation_id="listChapterlessHighlights",
    response_model=HighlightList,
)
def list_chapterless_highlights(
    access: ReadWorkspace,
    user: CurrentUser,
    repo: Repo,
    chapter: Annotated[
        Literal["none"],
        Query(description='Only `none`: the "챕터 없음" group (no workspace-wide list).'),
    ],
) -> HighlightList:
    """The caller's explanation highlights of the "챕터 없음" Heatmap group."""
    ctx = _Context(repo, access.workspace_id)
    ordered = repo.heatmap_group(access.workspace_id, None)
    ctx.add_group(None, None, ordered)
    return HighlightList(items=_explanation_items(repo, ctx, user.id, ordered))


@router.get(
    "/questions/{question_id}/my-highlights",
    operation_id="listQuestionHighlights",
    response_model=HighlightList,
)
def list_question_highlights(access: ReadQuestion, user: CurrentUser, repo: Repo) -> HighlightList:
    """The caller's highlights of the question's explanation (same access as GET /questions/{id};
    the response holds the caller's quotes only, never the explanation)."""
    workspace_id = access.workspace.workspace_id
    ctx = _Context(repo, workspace_id)
    ctx.ensure([access.resource_id])
    rows = repo.live_on_questions(user.id, workspace_id, [access.resource_id])
    rows.sort(key=lambda r: _position_key(ctx, r))
    return HighlightList(items=[ctx.present(r) for r in rows])


@router.post(
    "/my-highlights",
    status_code=status.HTTP_201_CREATED,
    response_model=Highlight,
    operation_id="createHighlight",
    responses=problem_responses(409),
)
def create_highlight(
    body: HighlightCreate,
    user: CurrentUser,
    access_repo: AccessRepo,
    repo: Repo,
    idempotency: IdempotencyStoreDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Highlight a range of a note version or of a question's current explanation. Overlapping
    highlights of the caller must be named in `replace_ids` (they are replaced by this one in the
    same transaction); allowed for every member, also in an archived workspace."""
    target = body.target
    if isinstance(target, AiExplanationTargetIn):  # AIEXPL-01 is not available yet
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if isinstance(target, NoteTargetIn):
        resource, target_id = ResourceType.CHAPTER_NOTE, target.chapter_note_id
    else:
        resource, target_id = ResourceType.QUESTION, target.question_id
    access = _uniform(
        lambda: authorize_resource(access_repo, user.id, resource, target_id, Action.HIGHLIGHT)
    ).workspace
    workspace_id = access.workspace_id

    body_hash = request_hash(body.model_dump(mode="json"))
    if idempotency_key is not None:
        idempotency.lock(user.id, CREATE_SCOPE, idempotency_key)
        stored = idempotency.find(user.id, CREATE_SCOPE, idempotency_key)
        if stored is not None:
            response = replay(stored, body_hash)
            repo.rollback()
            return response

    kind = target.kind
    revision_id: uuid.UUID | None = None
    ctx = _Context(repo, workspace_id)
    if isinstance(target, NoteTargetIn):
        note = repo.note(target_id, workspace_id)
        if note is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        if note.status != "succeeded":
            raise _unavailable("Only a finished note version can be highlighted.")
        blocks = note_blocks(note.body, note.refs)
    else:
        question = repo.questions(workspace_id, [target_id]).get(target_id)
        if question is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        if question.publication_status == "DRAFT":
            raise _unavailable("Draft questions cannot be highlighted.")
        if not question.explanation or question.revision_id is None:
            raise _unavailable("The question has no explanation.")
        if target.question_revision_id not in (None, question.revision_id):
            raise ProblemException(
                409,
                ProblemType.STALE_REVISION,
                detail="The explanation changed since it was loaded; reload it.",
            )
        revision_id = question.revision_id
        # One snapshot: the cut, the other highlights' positions and the overlap checks all use
        # this revision (a question edit may commit while this request runs).
        ctx.pin(question)
        blocks = explanation_blocks(question.explanation)

    anchor = Anchor(body.anchor.block, body.anchor.start, body.anchor.end)
    try:
        piece = cut(blocks, anchor)
    except AnchorError:
        raise _invalid("The anchor is not a range of one block of the text.") from None

    repo.lock_target(user.id, target_id)
    if kind == "explanation":
        ctx.ensure([target_id])
    live = repo.live_on_target(user.id, workspace_id, kind, target_id)
    positions = _live_positions(ctx, live)
    replace = list(dict.fromkeys(body.replace_ids or []))
    for rid in replace:
        position = positions.get(rid)
        if position is None or not overlaps(position, anchor):
            raise _invalid("replace_ids must be your highlights overlapping this range.")
    chosen = set(replace)
    if any(
        position is not None and overlaps(position, anchor)
        for rid, position in positions.items()
        if rid not in chosen
    ):
        raise _overlap()
    if len(live) - len(chosen) + 1 > LIMIT_PER_TARGET:
        raise _limit()

    new_id = repo.insert(
        workspace_id=workspace_id,
        user_id=user.id,
        kind=kind,
        chapter_note_id=target_id if kind == "note" else None,
        question_id=target_id if kind == "explanation" else None,
        question_revision_id=revision_id,
        anchor=anchor.as_dict(),
        quote=piece.quote,
        prefix=piece.prefix,
        suffix=piece.suffix,
        color=body.color,
    )
    repo.replace(replace, new_id, user.id)
    row = repo.own_required(new_id, user.id)
    result = ctx.present(row).model_dump(mode="json")
    if idempotency_key is not None:
        idempotency.save(
            user.id, CREATE_SCOPE, idempotency_key, body_hash, status.HTTP_201_CREATED, result
        )
    repo.commit()
    return JSONResponse(result, status_code=status.HTTP_201_CREATED)


def _owned(repo: HighlightRepository, access: ResourceAccess, *, lock: bool) -> HighlightRow:
    row = repo.own(access.resource_id, access.workspace.user_id, lock=lock)
    if row is None:  # another user's highlight answers like an unknown id
        raise HTTPException(status_code=404, detail=HIGHLIGHT_NOT_FOUND)
    return row


@router.patch(
    "/my-highlights/{highlight_id}",
    response_model=Highlight,
    operation_id="updateHighlight",
    responses=problem_responses(409),
)
def update_highlight(body: HighlightUpdate, access: OwnHighlight, repo: Repo) -> Highlight:
    """Change the color of one of the caller's live highlights (`version` must match)."""
    row = _owned(repo, access, lock=True)
    if row.deleted_at is not None:
        raise HTTPException(status_code=404, detail=HIGHLIGHT_NOT_FOUND)
    if row.version != body.version:
        raise ProblemException(
            409, ProblemType.HIGHLIGHT_CHANGED, detail="The highlight changed; reload it."
        )
    repo.set_color(row.id, body.color)
    updated = repo.own_required(row.id, row.user_id)
    out = _one(repo, updated)
    repo.commit()
    return out


@router.delete(
    "/my-highlights/{highlight_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="deleteHighlight",
)
def delete_highlight(access: OwnHighlight, repo: Repo) -> Response:
    """Remove one of the caller's highlights (idempotent; it can be restored for 10 minutes)."""
    row = _owned(repo, access, lock=True)
    if row.deleted_at is None:
        repo.soft_delete(row.id)
    repo.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/my-highlights/{highlight_id}/restore",
    response_model=Highlight,
    operation_id="restoreHighlight",
    responses=problem_responses(409),
)
def restore_highlight(access: OwnHighlight, repo: Repo) -> Highlight:
    """Undo the deletion of one of the caller's highlights within 10 minutes: the same id,
    target, anchor and color (`version` + 1). Merged-away highlights are not restorable."""
    first = _owned(repo, access, lock=False)
    repo.lock_target(first.user_id, first.target_id)
    row = _owned(repo, access, lock=True)
    if row.deleted_at is None or row.replaced_by is not None or not row.recently_deleted:
        raise ProblemException(
            409,
            ProblemType.HIGHLIGHT_NOT_RESTORABLE,
            detail="Only a highlight deleted in the last 10 minutes can be restored.",
        )
    ctx = _Context(repo, row.workspace_id)
    if row.question_id is not None:
        ctx.ensure([row.question_id])
    _, mine = ctx.current(row)
    live = repo.live_on_target(row.user_id, row.workspace_id, row.target_kind, row.target_id)
    if mine is not None and any(
        position is not None and overlaps(position, mine)
        for position in _live_positions(ctx, live).values()
    ):
        raise _overlap()
    if len(live) + 1 > LIMIT_PER_TARGET:
        raise _limit()
    repo.restore(row.id)
    restored = repo.own_required(row.id, row.user_id)
    out = ctx.present(restored)
    repo.commit()
    return out
