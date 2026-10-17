"""Document rows as the `document.parse` job sees them (M3.2b), on the `quiz_worker` role.

Grants come from supabase/migrations/20261017200000_documents.sql: the worker reads documents,
revisions and uploads, writes chapters/blocks of *draft* revisions (the revision content guard
refuses anything else), moves a revision to `published` and a document's processing state.

Row encoding of a revision's content (the contract M3.4 writers follow too):

- `chapters`: one row per `Section`, `section_key` = section id, `sort_order` = the section's
  index in `DocumentRevision.sections` (parents precede children), `page` = first page of the
  heading block.
- `content_blocks`: one row per `Block`, `block_id` = block id, `ordinal` = reading order,
  `chapter_id` -> the block's section, `page` = first location's page,
  `provenance = {"locations": [SourceLocation...], "source_block_ids": [...]}`,
  `attributes = {"heading_level"?, "table"? (TableContent), "caption_block_id"?}`.
- `document_revisions.content_hash` (book_core `revision_content_hash`) is written in the same
  transaction as the rows, after them: a draft with a hash has complete content, a draft without
  one has none (a retried attempt replaces any stray rows).

Job progress is stored in the running job's `async_jobs.result` as
`{"progress": {"stage", "percent"}}` (fenced on the attempt); the terminal transition replaces
it with the job's result (or NULL), so it is only ever read while the job runs.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Protocol

from book_core.contracts import (
    Block,
    BlockType,
    DocumentRevision,
    Section,
    SourceLocation,
    TableContent,
)
from pydantic import ValidationError
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

from quiz_worker.errors import JobError, NonRetryableJobError

logger = logging.getLogger(__name__)

# DB limits (CHECK constraints of chapters / content_blocks).
MAX_CHAPTER_TITLE = 1000
MAX_CHAPTER_LEVEL = 20
MAX_BLOCK_TEXT = 200_000
MAX_PARSER_VERSION = 100
_LOCK_POLL_SECONDS = 0.5


class DocumentBusyError(JobError):
    """Another job holds the document; retried later."""

    code = "document_busy"


class ContentInvalidError(NonRetryableJobError):
    code = "content_invalid"


class ContentChangedError(JobError):
    """The draft's content changed while it was being indexed; a retry indexes the new one."""

    code = "content_changed"


class DocumentDeletedError(NonRetryableJobError):
    code = "document_deleted"


@dataclass(frozen=True)
class DocumentRow:
    id: uuid.UUID
    workspace_id: uuid.UUID
    document_type: str
    title: str
    size_bytes: int
    sha256: str
    source_object_key: str
    status: str
    active_revision_id: uuid.UUID | None
    deleted: bool


@dataclass(frozen=True)
class RevisionRow:
    id: uuid.UUID
    document_id: uuid.UUID
    revision_number: int
    parent_revision_id: uuid.UUID | None
    status: str
    content_hash: str | None
    parsed_object_key: str | None

    @property
    def published(self) -> bool:
        return self.status == "published"


@dataclass(frozen=True)
class JobRow:
    payload: Mapping[str, Any]
    status: str
    last_error: str | None


class DocumentStore(Protocol):
    def document_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Any:
        """Context manager serialising jobs (and their cleanups) on one document."""
        ...

    def load(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, revision_id: uuid.UUID
    ) -> tuple[DocumentRow, RevisionRow] | None: ...

    def mark_processing(self, document_id: uuid.UUID) -> None: ...

    def write_content(
        self,
        document: DocumentRow,
        revision: RevisionRow,
        content: DocumentRevision,
        *,
        parser_version: str,
        parsed_object_key: str,
    ) -> None: ...

    def load_content(self, document: DocumentRow, revision: RevisionRow) -> DocumentRevision: ...

    def publish(
        self,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
        content_hash: str,
        *,
        before_commit: Callable[[], None],
    ) -> uuid.UUID | None:
        """Publish the draft and make it the document's active revision (status `ready`).
        Returns the previously active revision."""
        ...

    def record_failure(self, document_id: uuid.UUID, revision_id: uuid.UUID, error: str) -> None:
        """`failed` + `last_error` without an active revision; a ready document keeps serving
        its active revision and only gets `last_error`. No-op once `revision_id` is active."""
        ...

    def report_progress(
        self, job_id: uuid.UUID, attempt: int, stage: str, percent: int
    ) -> None: ...

    def job(self, job_id: uuid.UUID) -> JobRow | None: ...


# --------------------------------------------------------------------------------------------
# Row encoding (pure)
# --------------------------------------------------------------------------------------------


def chapter_rows(
    document: DocumentRow, revision: RevisionRow, content: DocumentRevision
) -> tuple[list[dict[str, Any]], dict[str, uuid.UUID]]:
    blocks = {b.id: b for b in content.blocks}
    ids: dict[str, uuid.UUID] = {}
    rows = []
    for order, section in enumerate(content.sections):
        title = section.title.strip()
        if not title or len(section.title) > MAX_CHAPTER_TITLE:
            raise ContentInvalidError("a chapter title is empty or too long")
        if section.level > MAX_CHAPTER_LEVEL:
            raise ContentInvalidError("the chapter tree is nested too deeply")
        heading = blocks.get(section.heading_block_id) if section.heading_block_id else None
        ids[section.id] = uuid.uuid4()
        rows.append(
            {
                "id": ids[section.id],
                "workspace_id": document.workspace_id,
                "document_id": document.id,
                "document_revision_id": revision.id,
                "parent_id": ids[section.parent_id] if section.parent_id else None,
                "section_key": section.id,
                "level": section.level,
                "sort_order": order,
                "title": section.title,
                "page": heading.locations[0].page if heading else None,
                "heading_block_id": section.heading_block_id,
            }
        )
    return rows, ids


def block_rows(
    document: DocumentRow,
    revision: RevisionRow,
    content: DocumentRevision,
    chapter_ids: Mapping[str, uuid.UUID],
) -> list[dict[str, Any]]:
    rows = []
    for index, block in enumerate(content.blocks):
        if len(block.text) > MAX_BLOCK_TEXT:
            raise ContentInvalidError("a content block is too long")
        attributes: dict[str, Any] = {}
        if block.heading_level is not None:
            attributes["heading_level"] = block.heading_level
        if block.table is not None:
            attributes["table"] = block.table.model_dump(mode="json")
        if block.caption_block_id is not None:
            attributes["caption_block_id"] = block.caption_block_id
        rows.append(
            {
                "workspace_id": document.workspace_id,
                "document_id": document.id,
                "document_revision_id": revision.id,
                "block_id": block.id,
                "ordinal": block.ordinal if block.ordinal is not None else index,
                "chapter_id": chapter_ids[block.section_id] if block.section_id else None,
                "block_type": block.type.value,
                "text": block.text,
                "page": block.locations[0].page,
                "provenance": {
                    "locations": [loc.model_dump(mode="json") for loc in block.locations],
                    "source_block_ids": list(block.source_block_ids),
                },
                "attributes": attributes,
                "edited": block.edited,
            }
        )
    return rows


def revision_from_rows(
    document: DocumentRow,
    revision: RevisionRow,
    chapters: Sequence[Mapping[str, Any]],
    blocks: Sequence[Mapping[str, Any]],
) -> DocumentRevision:
    """Inverse of `chapter_rows` / `block_rows`; the stored content hash must match."""
    keys = {row["id"]: row["section_key"] for row in chapters}
    try:
        sections = [
            Section(
                id=row["section_key"],
                title=row["title"],
                level=row["level"],
                parent_id=keys[row["parent_id"]] if row["parent_id"] else None,
                heading_block_id=row["heading_block_id"],
            )
            for row in sorted(chapters, key=lambda r: r["sort_order"])
        ]
        content_blocks = []
        for row in sorted(blocks, key=lambda r: r["ordinal"]):
            provenance = row["provenance"]
            attributes = row["attributes"] or {}
            table = attributes.get("table")
            content_blocks.append(
                Block(
                    id=row["block_id"],
                    type=BlockType(row["block_type"]),
                    text=row["text"],
                    section_id=keys[row["chapter_id"]] if row["chapter_id"] else None,
                    locations=tuple(
                        SourceLocation.model_validate(loc) for loc in provenance["locations"]
                    ),
                    heading_level=attributes.get("heading_level"),
                    table=TableContent.model_validate(table) if table is not None else None,
                    caption_block_id=attributes.get("caption_block_id"),
                    source_block_ids=tuple(provenance.get("source_block_ids") or ()),
                    ordinal=row["ordinal"],
                    edited=row["edited"],
                )
            )
        return DocumentRevision(
            document_id=str(document.id),
            revision_id=str(revision.id),
            revision_number=revision.revision_number,
            parent_revision_id=(
                str(revision.parent_revision_id) if revision.parent_revision_id else None
            ),
            source_sha256=document.sha256,
            sections=tuple(sections),
            blocks=tuple(content_blocks),
            content_hash=revision.content_hash,
        )
    except (ValidationError, ValueError, KeyError, TypeError):
        # Never the validation text: it quotes block content.
        raise ContentInvalidError("the stored revision content is inconsistent") from None


# --------------------------------------------------------------------------------------------
# Postgres
# --------------------------------------------------------------------------------------------

_DOCUMENT = text(
    """
    select d.id, d.workspace_id, d.document_type, d.title, d.size_bytes, d.sha256,
           d.source_object_key, d.status, d.active_revision_id, d.deleted_at is not null as deleted,
           r.id as r_id, r.revision_number, r.parent_revision_id, r.status as r_status,
           r.content_hash, r.parsed_object_key
      from public.documents d
      join public.document_revisions r
        on r.document_id = d.id and r.workspace_id = d.workspace_id
     where d.id = :document_id and d.workspace_id = :workspace_id and r.id = :revision_id
    """
)

_INSERT_CHAPTER = text(
    """
    insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                                 section_key, level, sort_order, title, page, heading_block_id)
    values (:id, :workspace_id, :document_id, :document_revision_id, :parent_id, :section_key,
            :level, :sort_order, :title, :page, :heading_block_id)
    """
)

_INSERT_BLOCK = text(
    """
    insert into public.content_blocks (workspace_id, document_id, document_revision_id, block_id,
                                       ordinal, chapter_id, block_type, text, page, provenance,
                                       attributes, edited)
    values (:workspace_id, :document_id, :document_revision_id, :block_id, :ordinal, :chapter_id,
            :block_type, :text, :page, cast(:provenance as jsonb), cast(:attributes as jsonb),
            :edited)
    """
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class PostgresDocumentStore:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    @property
    def engine(self) -> Engine:
        return self._engine

    @contextmanager
    def document_lock(
        self, document_id: uuid.UUID, *, wait_seconds: float, check: Callable[[], None]
    ) -> Iterator[None]:
        """Session-level advisory lock on a dedicated connection for the job's duration. A
        worker that dies drops its connection, which releases the lock."""
        key = f"quiz.document:{document_id}"
        with self._engine.connect() as conn:
            deadline = time.monotonic() + wait_seconds
            while not conn.execute(
                text("select pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
            ).scalar_one():
                conn.commit()
                if time.monotonic() >= deadline:
                    raise DocumentBusyError("another job is processing this document")
                check()
                time.sleep(_LOCK_POLL_SECONDS)
            conn.commit()
            try:
                yield
            finally:
                try:
                    conn.execute(
                        text("select pg_advisory_unlock(hashtextextended(:k, 0))"), {"k": key}
                    )
                    conn.commit()
                except Exception:
                    # Do not return a connection that may still hold the lock to the pool.
                    conn.invalidate()

    def load(
        self, workspace_id: uuid.UUID, document_id: uuid.UUID, revision_id: uuid.UUID
    ) -> tuple[DocumentRow, RevisionRow] | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    _DOCUMENT,
                    {
                        "workspace_id": workspace_id,
                        "document_id": document_id,
                        "revision_id": revision_id,
                    },
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return (
            DocumentRow(
                id=row["id"],
                workspace_id=row["workspace_id"],
                document_type=row["document_type"],
                title=row["title"],
                size_bytes=row["size_bytes"],
                sha256=row["sha256"],
                source_object_key=row["source_object_key"],
                status=row["status"],
                active_revision_id=row["active_revision_id"],
                deleted=row["deleted"],
            ),
            RevisionRow(
                id=row["r_id"],
                document_id=row["id"],
                revision_number=row["revision_number"],
                parent_revision_id=row["parent_revision_id"],
                status=row["r_status"],
                content_hash=row["content_hash"],
                parsed_object_key=row["parsed_object_key"],
            ),
        )

    def mark_processing(self, document_id: uuid.UUID) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.documents set status = 'processing', last_error = null "
                    "where id = :d and active_revision_id is null and status <> 'processing'"
                ),
                {"d": document_id},
            )

    def write_content(
        self,
        document: DocumentRow,
        revision: RevisionRow,
        content: DocumentRevision,
        *,
        parser_version: str,
        parsed_object_key: str,
    ) -> None:
        chapters, chapter_ids = chapter_rows(document, revision, content)
        blocks = block_rows(document, revision, content, chapter_ids)
        with self._engine.begin() as conn:
            current = (
                conn.execute(
                    text(
                        "select status, content_hash from public.document_revisions "
                        "where id = :r for update"
                    ),
                    {"r": revision.id},
                )
                .mappings()
                .one()
            )
            if current["status"] != "draft" or current["content_hash"] is not None:
                # Written by a concurrent attempt (or published meanwhile): keep that content.
                return
            # Rows left by anything that did not finish this transaction (none are expected:
            # the hash is written with them) are replaced.
            conn.execute(
                text("delete from public.content_blocks where document_revision_id = :r"),
                {"r": revision.id},
            )
            conn.execute(
                text("delete from public.chapters where document_revision_id = :r"),
                {"r": revision.id},
            )
            try:
                if chapters:
                    conn.execute(_INSERT_CHAPTER, chapters)
                if blocks:
                    conn.execute(
                        _INSERT_BLOCK,
                        [
                            {
                                **b,
                                "provenance": _json(b["provenance"]),
                                "attributes": _json(b["attributes"]),
                            }
                            for b in blocks
                        ],
                    )
            except IntegrityError:
                raise ContentInvalidError("the parsed content violates a constraint") from None
            conn.execute(
                text(
                    "update public.document_revisions set content_hash = :h, parser_version = :p, "
                    "parsed_object_key = :k where id = :r"
                ),
                {
                    "h": content.content_hash,
                    "p": parser_version[:MAX_PARSER_VERSION],
                    "k": parsed_object_key,
                    "r": revision.id,
                },
            )

    def load_content(self, document: DocumentRow, revision: RevisionRow) -> DocumentRevision:
        with self._engine.begin() as conn:
            chapters = [
                dict(r)
                for r in conn.execute(
                    text(
                        "select id, parent_id, section_key, level, sort_order, title, "
                        "heading_block_id from public.chapters where document_revision_id = :r"
                    ),
                    {"r": revision.id},
                ).mappings()
            ]
            blocks = [
                dict(r)
                for r in conn.execute(
                    text(
                        "select block_id, ordinal, chapter_id, block_type, text, provenance, "
                        "attributes, edited from public.content_blocks "
                        "where document_revision_id = :r"
                    ),
                    {"r": revision.id},
                ).mappings()
            ]
        return revision_from_rows(document, revision, chapters, blocks)

    def publish(
        self,
        document_id: uuid.UUID,
        revision_id: uuid.UUID,
        content_hash: str,
        *,
        before_commit: Callable[[], None],
    ) -> uuid.UUID | None:
        with self._engine.begin() as conn:
            document = (
                conn.execute(
                    text(
                        "select active_revision_id, deleted_at is not null as deleted "
                        "from public.documents where id = :d for update"
                    ),
                    {"d": document_id},
                )
                .mappings()
                .one()
            )
            if document["deleted"]:
                raise DocumentDeletedError("the document was deleted")
            revision = (
                conn.execute(
                    text(
                        "select status, content_hash from public.document_revisions "
                        "where id = :r for update"
                    ),
                    {"r": revision_id},
                )
                .mappings()
                .one()
            )
            previous: uuid.UUID | None = document["active_revision_id"]
            if revision["status"] == "published" and previous == revision_id:
                return None
            if revision["content_hash"] != content_hash:
                raise ContentChangedError("the draft changed while it was indexed")
            if revision["status"] != "published":
                conn.execute(
                    text(
                        "update public.document_revisions set status = 'published', "
                        "published_at = now() where id = :r"
                    ),
                    {"r": revision_id},
                )
            conn.execute(
                text(
                    "update public.documents set active_revision_id = :r, status = 'ready', "
                    "last_error = null where id = :d"
                ),
                {"r": revision_id, "d": document_id},
            )
            before_commit()
        return previous

    def record_failure(self, document_id: uuid.UUID, revision_id: uuid.UUID, error: str) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.documents "
                    "set status = case when active_revision_id is null then 'failed' "
                    "                  else status end, "
                    "    last_error = :e "
                    "where id = :d and active_revision_id is distinct from :r"
                ),
                {"d": document_id, "r": revision_id, "e": error[:500]},
            )

    def report_progress(self, job_id: uuid.UUID, attempt: int, stage: str, percent: int) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text(
                    "update public.async_jobs "
                    "set result = jsonb_build_object('progress', jsonb_build_object("
                    "      'stage', cast(:s as text), 'percent', cast(:p as int))) "
                    "where id = :j and status = 'running' and attempts = :a"
                ),
                {"j": job_id, "a": attempt, "s": stage, "p": percent},
            )

    def job(self, job_id: uuid.UUID) -> JobRow | None:
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    text("select payload, status, last_error from public.async_jobs where id = :j"),
                    {"j": job_id},
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return JobRow(payload=row["payload"], status=row["status"], last_error=row["last_error"])
