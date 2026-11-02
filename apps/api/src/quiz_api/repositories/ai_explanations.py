"""Reads and writes of AI explanations (EXPL-B, 20261103150000_ai_explanations.sql).

Runs in the request session after the route checked the caller (resource → workspace →
membership and the submission gate). Two tables with one shape, picked by `kind`:
`question` (`question_ai_explanations`, keyed on a bank question revision) and
`mock_exam_question` (`mock_exam_question_ai_explanations`, keyed on a mock exam question
revision; never the source question's rows).

The question content read here (stem, option texts, correct ids, accepted answers, source refs)
is only used after the gate passed, for the evidence query and the pinned passage references; it
is never returned and never logged. Pinned sources hold ids and pages only.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

EXPLAIN_JOB_TYPE = "question.ai_explain"
EXPLAIN_JOB_SCHEMA_VERSION = 1
# One retry of a crashed attempt (the job never retries a provider call on its own).
EXPLAIN_JOB_MAX_ATTEMPTS = 2
LIVE = ("queued", "running")
PAGE_SPAN = 20


@dataclass(frozen=True)
class _Table:
    name: str
    target: str
    revision: str


TABLES = {
    "question": _Table("question_ai_explanations", "question_id", "question_revision_id"),
    "mock_exam_question": _Table(
        "mock_exam_question_ai_explanations",
        "mock_exam_question_id",
        "mock_exam_question_revision_id",
    ),
}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class ExplanationRow:
    id: uuid.UUID
    kind: str
    workspace_id: uuid.UUID
    target_id: uuid.UUID
    revision_id: uuid.UUID
    version: int
    status: str
    job_id: uuid.UUID | None
    error_code: str | None
    body: dict[str, Any] | None
    sources: list[dict[str, Any]]
    truncated: bool
    created_at: datetime
    finished_at: datetime | None
    superseded_at: datetime | None

    @property
    def terminal(self) -> bool:
        return self.status not in LIVE


@dataclass(frozen=True)
class QuestionTarget:
    """The explained question as the API needs it (after the gate)."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    question_type: str
    publication_status: str | None  # bank only
    revision_id: uuid.UUID  # the active revision
    query_text: str


@dataclass(frozen=True)
class SourceRef:
    document_id: uuid.UUID
    block_ids: list[str]
    page_start: int | None
    page_end: int | None


@dataclass(frozen=True)
class LiveBook:
    id: uuid.UUID
    title: str
    revision_id: uuid.UUID


@dataclass(frozen=True)
class SourceView:
    number: int
    document_id: uuid.UUID
    document_title: str
    chapter_title: str | None
    page: int
    block_id: str | None
    outdated: bool


_COLUMNS = (
    "id, workspace_id, {target} as target_id, {revision} as revision_id, version, status, "
    "job_id, error_code, body, sources, truncated, created_at, finished_at, superseded_at"
)


def _row(kind: str, row: Any) -> ExplanationRow:
    return ExplanationRow(
        id=row.id,
        kind=kind,
        workspace_id=row.workspace_id,
        target_id=row.target_id,
        revision_id=row.revision_id,
        version=row.version,
        status=row.status,
        job_id=row.job_id,
        error_code=row.error_code,
        body=dict(row.body) if row.body is not None else None,
        sources=[dict(s) for s in row.sources or [] if isinstance(s, Mapping)],
        truncated=row.truncated,
        created_at=row.created_at,
        finished_at=row.finished_at,
        superseded_at=row.superseded_at,
    )


def _query_text(stem: str, options: Any, correct: Sequence[str] | None, accepted: Any) -> str:
    """The evidence query: the stem plus the correct option texts (or the accepted answers)."""
    ids = set(correct or ())
    texts = [
        str(o.get("text", ""))
        for o in options or []
        if isinstance(o, Mapping) and str(o.get("id")) in ids
    ]
    texts += [str(a) for a in accepted or [] if str(a).strip()]
    return " ".join([stem, *texts])


class ExplanationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def session(self) -> Session:
        return self._session

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    # --- the explained question ----------------------------------------------------------------

    def bank_question(self, question_id: uuid.UUID) -> QuestionTarget | None:
        row = self._session.execute(
            text(
                "select q.id, q.workspace_id, q.question_type, q.publication_status, "
                "q.active_revision_id, r.stem, r.options, r.correct_option_ids, "
                "r.accepted_answers from public.questions q "
                "join public.question_revisions r on r.id = q.active_revision_id "
                "and r.question_id = q.id "
                "where q.id = :q and q.deleted_at is null"
            ),
            {"q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return QuestionTarget(
            row.id,
            row.workspace_id,
            row.question_type,
            row.publication_status,
            row.active_revision_id,
            _query_text(row.stem, row.options, row.correct_option_ids, row.accepted_answers),
        )

    def mock_question(self, question_id: uuid.UUID) -> QuestionTarget | None:
        row = self._session.execute(
            text(
                "select q.id, q.workspace_id, q.question_type, q.active_revision_id, r.stem, "
                "r.options, r.correct_option_ids, r.accepted_answers "
                "from public.mock_exam_questions q "
                "join public.mock_exams e on e.id = q.mock_exam_id "
                "and e.workspace_id = q.workspace_id "
                "join public.mock_exam_question_revisions r on r.id = q.active_revision_id "
                "and r.mock_exam_question_id = q.id "
                "where q.id = :q and q.removed_at is null and e.deleted_at is null"
            ),
            {"q": question_id},
        ).one_or_none()
        if row is None:
            return None
        return QuestionTarget(
            row.id,
            row.workspace_id,
            row.question_type,
            None,
            row.active_revision_id,
            _query_text(row.stem, row.options, row.correct_option_ids, row.accepted_answers),
        )

    def revision_query_text(self, kind: str, revision_id: uuid.UUID) -> str:
        table = "question_revisions" if kind == "question" else "mock_exam_question_revisions"
        row = self._session.execute(
            text(
                "select stem, options, correct_option_ids, accepted_answers "  # noqa: S608
                f"from public.{table} where id = :r"
            ),
            {"r": revision_id},
        ).one_or_none()
        if row is None:
            return ""
        return _query_text(row.stem, row.options, row.correct_option_ids, row.accepted_answers)

    def source_refs(
        self, kind: str, target_id: uuid.UUID, revision_id: uuid.UUID
    ) -> list[SourceRef]:
        """The question's own sources: `question_sources` (bank) or the revision's `evidence`
        (mock; its quote text is never used)."""
        if kind == "question":
            rows = self._session.execute(
                text(
                    "select document_id, block_ids, page_start, page_end "
                    "from public.question_sources where question_id = :q "
                    "and document_id is not null order by created_at, id"
                ),
                {"q": target_id},
            )
            return [
                SourceRef(r.document_id, list(r.block_ids or []), r.page_start, r.page_end)
                for r in rows
            ]
        evidence = self._session.execute(
            text("select evidence from public.mock_exam_question_revisions where id = :r"),
            {"r": revision_id},
        ).scalar_one_or_none()
        out: list[SourceRef] = []
        for raw in evidence or []:
            if not isinstance(raw, Mapping):
                continue
            try:
                document_id = uuid.UUID(str(raw.get("document_id")))
            except ValueError:
                continue
            blocks = [str(b) for b in raw.get("block_ids") or [] if isinstance(b, str)]
            pages: list[int] = [
                int(p["page"])
                for p in raw.get("locations") or []
                if isinstance(p, Mapping) and isinstance(p.get("page"), int)
            ]
            out.append(
                SourceRef(
                    document_id,
                    blocks,
                    min(pages) if pages else None,
                    max(pages) if pages else None,
                )
            )
        return out

    def live_books(
        self, workspace_id: uuid.UUID, ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, LiveBook]:
        """Live `book` documents of the workspace with a published active revision (never a
        question paper)."""
        if not ids:
            return {}
        rows = self._session.execute(
            text(
                "select d.id, d.title, d.active_revision_id from public.documents d "
                "join public.document_revisions r on r.id = d.active_revision_id "
                "and r.document_id = d.id "
                "where d.workspace_id = :w and d.id = any(:ids) and d.deleted_at is null "
                "and d.document_type = 'book' and r.status = 'published'"
            ),
            {"w": workspace_id, "ids": list(ids)},
        )
        return {r.id: LiveBook(r.id, r.title, r.active_revision_id) for r in rows}

    def located(
        self, revision_id: uuid.UUID, ref: SourceRef
    ) -> tuple[list[str], int, int, uuid.UUID | None] | None:
        """(block ids, first page, last page, chapter) of a source ref in a revision; None when
        nothing of it is there."""
        if ref.block_ids:
            rows = self._session.execute(
                text(
                    "select block_id, page, chapter_id from public.content_blocks "
                    "where document_revision_id = :r and block_id = any(:b) order by ordinal"
                ),
                {"r": revision_id, "b": list(ref.block_ids)},
            ).all()
            pages = [r.page for r in rows if r.page is not None]
            if rows and pages:
                chapter = next((r.chapter_id for r in rows if r.chapter_id), None)
                return [r.block_id for r in rows], min(pages), max(pages), chapter
        if ref.page_start is None:
            return None
        start = ref.page_start
        end = min(ref.page_end or start, start + PAGE_SPAN)
        found = self._session.execute(
            text(
                "select chapter_id from public.content_blocks where document_revision_id = :r "
                "and page between :a and :b and block_type <> 'heading' and btrim(text) <> '' "
                "order by ordinal limit 1"
            ),
            {"r": revision_id, "a": start, "b": end},
        ).one_or_none()
        if found is None:
            return None
        return [], start, end, found.chapter_id

    # --- rows ------------------------------------------------------------------------------------

    def get(self, kind: str, explanation_id: uuid.UUID) -> ExplanationRow | None:
        table = TABLES[kind]
        row = self._session.execute(
            text(
                f"select {_COLUMNS.format(target=table.target, revision=table.revision)} "  # noqa: S608
                f"from public.{table.name} where id = :e"
            ),
            {"e": explanation_id},
        ).one_or_none()
        return _row(kind, row) if row is not None else None

    def _key_filter(self, model: str | None) -> str:
        return "prompt_version = :pv" + (" and model = :m" if model is not None else "")

    def newest(
        self, kind: str, revision_id: uuid.UUID, prompt_version: str, model: str | None
    ) -> ExplanationRow | None:
        """The newest row of the key that is not superseded (any status)."""
        table = TABLES[kind]
        row = self._session.execute(
            text(
                f"select {_COLUMNS.format(target=table.target, revision=table.revision)} "  # noqa: S608
                f"from public.{table.name} where {table.revision} = :r and "
                f"{self._key_filter(model)} and superseded_at is null "
                "order by created_at desc, id desc limit 1"
            ),
            {"r": revision_id, "pv": prompt_version, "m": model},
        ).one_or_none()
        return _row(kind, row) if row is not None else None

    def live(
        self, kind: str, revision_id: uuid.UUID, prompt_version: str, model: str | None
    ) -> ExplanationRow | None:
        return self._one(
            kind, revision_id, prompt_version, model, "status in ('queued', 'running')"
        )

    def current(
        self, kind: str, revision_id: uuid.UUID, prompt_version: str, model: str | None
    ) -> ExplanationRow | None:
        """The key's current success (not superseded)."""
        return self._one(
            kind,
            revision_id,
            prompt_version,
            model,
            "status = 'succeeded' and superseded_at is null",
        )

    def _one(
        self, kind: str, revision_id: uuid.UUID, prompt_version: str, model: str | None, where: str
    ) -> ExplanationRow | None:
        table = TABLES[kind]
        row = self._session.execute(
            text(
                f"select {_COLUMNS.format(target=table.target, revision=table.revision)} "  # noqa: S608
                f"from public.{table.name} where {table.revision} = :r and "
                f"{self._key_filter(model)} and {where} "
                "order by created_at desc, id desc limit 1"
            ),
            {"r": revision_id, "pv": prompt_version, "m": model},
        ).one_or_none()
        return _row(kind, row) if row is not None else None

    def lock_user(self, user_id: uuid.UUID) -> None:
        """Serializes the user's new explanations (the daily count) until the transaction ends."""
        self._session.execute(
            text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"ai_explanation_user:{user_id}"},
        )

    def lock_key(self, kind: str, revision_id: uuid.UUID) -> None:
        """Serializes creating explanations of one revision (until the transaction ends)."""
        self._session.execute(
            text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"ai_explanation:{kind}:{revision_id}"},
        )

    def insert(
        self,
        kind: str,
        *,
        workspace_id: uuid.UUID,
        target_id: uuid.UUID,
        revision_id: uuid.UUID,
        version: int,
        regenerated: bool,
        prompt_version: str,
        model: str,
        sources: list[dict[str, Any]],
        created_by: uuid.UUID,
    ) -> tuple[uuid.UUID, uuid.UUID] | None:
        """The queued row and its job, or None when the key already has a live row (`INSERT … ON
        CONFLICT DO NOTHING`; the job insert is undone with it)."""
        table = TABLES[kind]
        explanation_id, job_id = uuid.uuid4(), uuid.uuid4()
        nested = self._session.begin_nested()
        self._session.execute(
            text(
                "insert into public.async_jobs (id, workspace_id, created_by, job_type, "
                "schema_version, payload, max_attempts) values (:j, :w, :u, :t, :v, "
                "cast(:p as jsonb), :a)"
            ),
            {
                "j": job_id,
                "w": workspace_id,
                "u": created_by,
                "t": EXPLAIN_JOB_TYPE,
                "v": EXPLAIN_JOB_SCHEMA_VERSION,
                "p": _json(
                    {
                        "kind": kind,
                        "explanation_id": str(explanation_id),
                        "target_id": str(target_id),
                    }
                ),
                "a": EXPLAIN_JOB_MAX_ATTEMPTS,
            },
        )
        inserted = self._session.execute(
            text(
                f"insert into public.{table.name} (id, workspace_id, {table.target}, "  # noqa: S608
                f"{table.revision}, version, regenerated, job_id, prompt_version, model, "
                "sources, created_by) values (:id, :w, :t, :r, :v, :regen, :j, :pv, :m, "
                "cast(:s as jsonb), :u) on conflict do nothing returning id"
            ),
            {
                "id": explanation_id,
                "w": workspace_id,
                "t": target_id,
                "r": revision_id,
                "v": version,
                "regen": regenerated,
                "j": job_id,
                "pv": prompt_version,
                "m": model,
                "s": _json(sources),
                "u": created_by,
            },
        ).scalar_one_or_none()
        if inserted is None:
            nested.rollback()
            return None
        nested.commit()
        return explanation_id, job_id

    def mark_published(self, job_id: uuid.UUID) -> None:
        self._session.execute(
            text(
                "update public.async_jobs set published_at = now() "
                "where id = :j and status = 'queued' and published_at is null"
            ),
            {"j": job_id},
        )

    # --- limits ----------------------------------------------------------------------------------

    def created_since(self, user_id: uuid.UUID, since: datetime) -> int:
        """New explanations (both tables, regenerations included) the user started since."""
        count: int = self._session.execute(
            text(
                "select (select count(*) from public.question_ai_explanations "
                "where created_by = :u and created_at >= :t) + "
                "(select count(*) from public.mock_exam_question_ai_explanations "
                "where created_by = :u and created_at >= :t)"
            ),
            {"u": user_id, "t": since},
        ).scalar_one()
        return int(count)

    def regenerations_since(self, kind: str, revision_id: uuid.UUID, since: datetime) -> int:
        table = TABLES[kind]
        count: int = self._session.execute(
            text(
                f"select count(*) from public.{table.name} where {table.revision} = :r "  # noqa: S608
                "and regenerated and created_at >= :t"
            ),
            {"r": revision_id, "t": since},
        ).scalar_one()
        return int(count)

    def tokens_since(self, since: datetime) -> int:
        total: int = self._session.execute(
            text(
                "select coalesce(sum(input_tokens + output_tokens + cache_read_tokens + "
                "cache_creation_tokens), 0) from public.llm_feature_usage "
                "where feature = 'ai_explanation' and created_at >= :t"
            ),
            {"t": since},
        ).scalar_one()
        return int(total)

    # --- presentation ----------------------------------------------------------------------------

    def source_views(
        self,
        workspace_id: uuid.UUID,
        sources: Sequence[Mapping[str, Any]],
        visible: set[uuid.UUID] | None = None,
    ) -> list[SourceView]:
        """The cited sources (with `number`) in number order, of live documents of the workspace
        (and, for a guest, the shared ones in `visible`)."""
        cited: list[tuple[int, uuid.UUID, uuid.UUID | None, uuid.UUID | None, Mapping[str, Any]]]
        cited = []
        for s in sources:
            number = s.get("number")
            if not isinstance(number, int):
                continue
            try:
                document_id = uuid.UUID(str(s.get("document_id")))
                revision_id = uuid.UUID(str(s.get("document_revision_id")))
            except ValueError:
                continue
            chapter: uuid.UUID | None
            try:
                chapter = uuid.UUID(str(s["chapter_id"])) if s.get("chapter_id") else None
            except ValueError:
                chapter = None
            cited.append((number, document_id, revision_id, chapter, s))
        if not cited:
            return []
        docs = {
            r.id: r
            for r in self._session.execute(
                text(
                    "select id, title, active_revision_id from public.documents "
                    "where workspace_id = :w and id = any(:ids) and deleted_at is null"
                ),
                {"w": workspace_id, "ids": list({c[1] for c in cited})},
            )
        }
        chapter_ids = [c[3] for c in cited if c[3] is not None]
        chapters = (
            {
                r.id: r.title
                for r in self._session.execute(
                    text("select id, title from public.chapters where id = any(:ids)"),
                    {"ids": chapter_ids},
                )
            }
            if chapter_ids
            else {}
        )
        out: list[SourceView] = []
        for number, doc_id, pinned_revision, chapter, raw in sorted(cited, key=lambda c: c[0]):
            doc = docs.get(doc_id)
            if doc is None or (visible is not None and doc_id not in visible):
                continue
            blocks = [b for b in raw.get("block_ids") or [] if isinstance(b, str)]
            page = raw.get("page_from")
            out.append(
                SourceView(
                    number=number,
                    document_id=doc_id,
                    document_title=doc.title,
                    chapter_title=chapters.get(chapter) if chapter else None,
                    page=page if isinstance(page, int) else 1,
                    block_id=blocks[0] if blocks else None,
                    outdated=doc.active_revision_id != pinned_revision,
                )
            )
        return out
