"""Source question, passage and evidence helpers shared by the jobs that build questions from
CONFIRMED questions: `question.generate` (QGEN, M6.2) and `mock_exam.generate` (MOCK-B).

- `source_question`: the core view of a pinned source revision (with its stored sources as
  provenance evidence);
- `source_pages` / `build_passages`: the published blocks of the pages a source cites, one
  paragraph-complete excerpt per section in reading order, read through `PublishedContents`
  (live documents' *active* published revisions only, loaded once per job);
- `narrow_evidence_items`: each quoted evidence narrowed to the block(s) holding the quote;
- `workspace_fingerprints`: duplicate fingerprints of the workspace's live questions.

Nothing here logs question or book text.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from book_core.contracts import (
    BlockType,
    DocumentRevision,
    Excerpt,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    SourceEvidence,
)
from book_core.generation import MAX_SOURCE_PAGES, SourceQuestion, stored_source_evidence
from book_core.question import normalize_text, question_fingerprint
from book_core.search.excerpt import ExcerptConfig, ExcerptError, ExcerptResolver
from pydantic import ValidationError

from quiz_worker.document_store import DocumentStore
from quiz_worker.question_generation_store import SourceQuestionRow

# One passage is a section's text on the source pages; generous so a page is rarely cut.
PASSAGE_MAX_CHARS = 6000


def source_question(row: SourceQuestionRow) -> SourceQuestion:
    """The core view of the pinned source revision, with its sources as page provenance."""
    question_type = QuestionType(row.question_type)
    return SourceQuestion(
        question_id=str(row.question_id),
        revision_id=str(row.revision_id),
        question_type=question_type,
        stem=row.stem,
        options=tuple(QuestionOption(id=o["id"], text=o["text"]) for o in row.options),
        correct_option_ids=tuple(row.correct_option_ids)
        if row.correct_option_ids is not None
        else None,
        accepted_answers=tuple(a for a in row.accepted_answers if a.strip())
        if row.accepted_answers
        else None,
        is_multi_answer=row.is_multi_answer,
        explanation=row.explanation,
        evidence=tuple(_source_evidence(row)),
    )


def _source_evidence(row: SourceQuestionRow) -> Iterable[SourceEvidence]:
    for source in row.sources:
        if source.document_id is None:
            continue
        evidence = stored_source_evidence(
            document_id=str(source.document_id),
            revision_id=str(source.document_revision_id) if source.document_revision_id else None,
            page_start=source.page_start,
            page_end=source.page_end,
            block_ids=source.block_ids,
            locations=source.locations,
        )
        if evidence is not None:
            yield evidence


def source_pages(row: SourceQuestionRow) -> dict[uuid.UUID, set[int]]:
    """document id -> pages the source question cites (page ranges and located blocks)."""
    pages: dict[uuid.UUID, set[int]] = {}
    for source in row.sources:
        if source.document_id is None:
            continue
        found = pages.setdefault(source.document_id, set())
        if source.page_start is not None:
            end = min(source.page_end or source.page_start, source.page_start + MAX_SOURCE_PAGES)
            found.update(range(source.page_start, end + 1))
        for raw in source.locations:
            page = raw.get("page") if isinstance(raw, dict) else None
            if isinstance(page, int) and page > 0:
                found.add(page)
    return {doc: p for doc, p in pages.items() if p}


def build_passages(
    revision: DocumentRevision, pages: set[int], *, title: str | None = None
) -> list[Excerpt]:
    """One excerpt per section on `pages`, in reading order: the section's non-heading blocks
    located on those pages (a table/figure travels with its caption)."""
    resolver = ExcerptResolver(revision, document_title=title)
    config = ExcerptConfig(context_before=0, context_after=0, max_chars=PASSAGE_MAX_CHARS)
    groups: list[list[str]] = []
    last_section: object = object()
    for block in revision.blocks:
        if block.type is BlockType.HEADING:
            continue
        if not block.text.strip() and block.caption_block_id is None:
            continue
        if not any(loc.page in pages for loc in block.locations):
            continue
        if block.section_id != last_section or not groups:
            groups.append([])
            last_section = block.section_id
        groups[-1].append(block.id)
    passages: list[Excerpt] = []
    for ids in groups:
        try:
            passages.append(resolver.resolve(ids, config=config))
        except ExcerptError:
            continue
    return passages


def narrow_evidence_items(
    evidence: Iterable[SourceEvidence], revisions: Mapping[str, DocumentRevision]
) -> tuple[SourceEvidence, ...]:
    """Each quoted evidence points at the block(s) of its passage that contain the quote."""
    narrowed: list[SourceEvidence] = []
    for item in evidence:
        revision = revisions.get(f"{item.document_id}:{item.revision_id}")
        if item.quote is None or revision is None:
            narrowed.append(item)
            continue
        needle = normalize_text(item.quote)
        texts = {b.id: b.text for b in revision.blocks}
        hits = tuple(b for b in item.block_ids if needle in normalize_text(texts.get(b, "")))
        locations = tuple(loc for loc in item.locations if loc.block_id in hits)
        if not hits or not locations:
            narrowed.append(item)
            continue
        narrowed.append(item.model_copy(update={"block_ids": hits, "locations": locations}))
    return tuple(narrowed)


def narrow_evidence(
    draft: QuestionDraft, revisions: Mapping[str, DocumentRevision]
) -> QuestionDraft:
    """`narrow_evidence_items` applied to a draft's evidence."""
    narrowed = narrow_evidence_items(draft.evidence, revisions)
    return QuestionDraft.model_validate(
        {**draft.model_dump(), "evidence": [e.model_dump() for e in narrowed]}
    )


def workspace_fingerprints(rows: Iterable[Any]) -> frozenset[str]:
    out: set[str] = set()
    for row in rows:
        try:
            out.add(
                question_fingerprint(
                    question_type=QuestionType(row.question_type),
                    stem=row.stem,
                    options=[QuestionOption(id=o["id"], text=o["text"]) for o in row.options],
                    correct_option_ids=row.correct_option_ids,
                    accepted_answers=row.accepted_answers,
                )
            )
        except (ValidationError, ValueError, KeyError, TypeError):
            continue
    return frozenset(out)


class PublishedContents:
    """Published active revisions loaded once per job (`document:revision` -> content)."""

    def __init__(self, documents: DocumentStore, workspace_id: uuid.UUID) -> None:
        self._documents = documents
        self._workspace_id = workspace_id
        self.revisions: dict[str, DocumentRevision] = {}
        self._titles: dict[str, str] = {}

    def get(
        self, document_id: uuid.UUID, revision_id: uuid.UUID
    ) -> tuple[DocumentRevision, str] | None:
        key = f"{document_id}:{revision_id}"
        if key not in self.revisions:
            found = self._documents.load(self._workspace_id, document_id, revision_id)
            if found is None:
                return None
            row, revision = found
            if row.deleted or not revision.published or revision.content_hash is None:
                return None
            if row.active_revision_id != revision.id:
                return None
            self.revisions[key] = self._documents.load_content(row, revision)
            self._titles[key] = row.title
        return self.revisions[key], self._titles[key]
