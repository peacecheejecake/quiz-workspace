"""Retrieval evaluation datasets: documents, queries and graded judgements.

A dataset file (``eval/datasets/*.json``) lists the documents to index and the queries. Each
document comes from one of:

- ``truth``: a synthetic fixture ``*.truth.json`` (``tests/fixtures/pdfs``), turned into a
  published revision through the fake parser, ``build_revision`` and ``chunk_revision`` (the
  default chunker); or
- ``revision`` (``DocumentRevision`` JSON, e.g. from ``core structure``) plus optional ``chunks``
  (``SearchChunk`` JSONL from ``core chunk``; chunked with the defaults when absent).

Queries are either inline (``queries``) or read from a ``retrieval-seed.json``-format file
(``seed_queries``), so the fixture stays the single source of truth for the seed judgements. Seed
judgements name a fixture section; they are expanded here into the section's source block ids
and their page/bbox from the truth file (used by the location-mapping check).

A judgement matches a hit when the hit's chunk covers one of the judgement's blocks: revision
block ids or source (parser) block ids, which survive into ``Block.source_block_ids``. A
judgement given only as ``section_id`` covers the blocks of that revision section and its
subsections. Relative paths resolve against the dataset file's directory.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from book_core.chunker import chunk_revision
from book_core.contracts import (
    DocumentRevision,
    SearchChunk,
    SourceLocation,
)
from book_core.contracts.common import Identifier, LanguageTag, NonEmptyText
from book_core.parser.fake import load_truth_document
from book_core.structure import build_revision, publish

DEFAULT_REVISION_ID = "r1"


class DatasetError(ValueError):
    """The dataset file or one of the files it references is invalid."""


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class Judgement(_Model):
    """One relevant unit for a query: a section (or explicit blocks) of one document."""

    document_id: Identifier
    section_id: Identifier | None = None
    block_ids: tuple[Identifier, ...] = ()
    locations: tuple[SourceLocation, ...] = ()
    grade: Annotated[int, Field(ge=1, le=3)] = 1

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.section_id is None and not self.block_ids:
            raise ValueError("a judgement needs a section_id or block_ids")
        return self

    @property
    def key(self) -> str:
        """Unit id of the judgement in metric computations."""
        unit = self.section_id or "+".join(self.block_ids)
        return f"{self.document_id}#{unit}"


class EvalQuery(_Model):
    id: Identifier
    language: LanguageTag
    text: NonEmptyText
    judgements: Annotated[tuple[Judgement, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        keys = [j.key for j in self.judgements]
        if len(keys) != len(set(keys)):
            raise ValueError(f"query {self.id} judges a unit twice")
        return self


class DatasetDocument(_Model):
    id: Identifier
    language: LanguageTag | None = None
    revision_id: Identifier = DEFAULT_REVISION_ID
    truth: NonEmptyText | None = None
    revision: NonEmptyText | None = None
    chunks: NonEmptyText | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if (self.truth is None) == (self.revision is None):
            raise ValueError(f"document {self.id} needs exactly one of truth or revision")
        if self.chunks is not None and self.revision is None:
            raise ValueError(f"document {self.id}: chunks need a revision")
        return self


class DatasetFile(_Model):
    """On-disk dataset (``schema_version`` 1)."""

    schema_version: Literal[1] = 1
    name: Identifier
    description: str = ""
    synthetic: bool = False
    documents: Annotated[tuple[DatasetDocument, ...], Field(min_length=1)]
    queries: tuple[EvalQuery, ...] = ()
    seed_queries: NonEmptyText | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if bool(self.queries) == (self.seed_queries is not None):
            raise ValueError("a dataset needs exactly one of queries or seed_queries")
        ids = [d.id for d in self.documents]
        if len(ids) != len(set(ids)):
            raise ValueError("document ids must be unique")
        return self


@dataclass(frozen=True, slots=True)
class CorpusDocument:
    """A document ready to index: its published revision and chunks."""

    id: str
    language: str | None
    revision: DocumentRevision
    chunks: tuple[SearchChunk, ...]

    @property
    def revision_id(self) -> str:
        return self.revision.revision_id


@dataclass(frozen=True, slots=True)
class Dataset:
    name: str
    description: str
    synthetic: bool
    documents: tuple[CorpusDocument, ...]
    queries: tuple[EvalQuery, ...]
    source: str | None = None
    _by_id: Mapping[str, CorpusDocument] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_id", {d.id: d for d in self.documents})
        for query in self.queries:
            for judgement in query.judgements:
                if judgement.document_id not in self._by_id:
                    raise DatasetError(
                        f"query {query.id} judges unknown document {judgement.document_id}"
                    )

    def document(self, document_id: str) -> CorpusDocument:
        return self._by_id[document_id]

    @property
    def languages(self) -> tuple[str, ...]:
        return tuple(sorted({d.language for d in self.documents if d.language}))


# --- loading ---------------------------------------------------------------------------------


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise DatasetError(
            f"cannot read {path.name}: {exc.strerror or type(exc).__name__}"
        ) from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DatasetError(f"{path.name} is not valid UTF-8 JSON") from exc


def _validate[M: BaseModel](model: type[M], raw: Any, what: str) -> M:
    from pydantic import ValidationError

    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        parts = [
            f"{'.'.join(str(p) for p in err['loc']) or '<root>'}: {err['type']}"
            for err in exc.errors(include_input=False, include_url=False, include_context=False)
        ]
        raise DatasetError(f"{what} is not valid: {'; '.join(parts[:5])}") from exc


def _load_chunks(path: Path) -> tuple[SearchChunk, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise DatasetError(
            f"cannot read {path.name}: {exc.strerror or type(exc).__name__}"
        ) from exc
    chunks = []
    for number, line in enumerate(lines, start=1):
        if line.strip():
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                raise DatasetError(f"{path.name} line {number} is not valid JSON") from exc
            chunks.append(_validate(SearchChunk, raw, f"{path.name} line {number}"))
    return tuple(chunks)


def _majority_language(chunks: Sequence[SearchChunk]) -> str | None:
    counts: dict[str, int] = {}
    for chunk in chunks:
        if chunk.language:
            counts[chunk.language] = counts.get(chunk.language, 0) + 1
    return max(sorted(counts), key=lambda lang: counts[lang]) if counts else None


def corpus_document(
    revision: DocumentRevision,
    chunks: Sequence[SearchChunk] | None = None,
    *,
    language: str | None = None,
) -> CorpusDocument:
    """A corpus document from a revision (chunked with the defaults when ``chunks`` is None)."""
    if chunks is None:
        chunks = chunk_revision(revision).chunks
    for chunk in chunks:
        if chunk.document_id != revision.document_id or chunk.revision_id != revision.revision_id:
            raise DatasetError(
                f"chunk {chunk.id} belongs to {chunk.document_id}/{chunk.revision_id}, not "
                f"{revision.document_id}/{revision.revision_id}"
            )
    return CorpusDocument(
        id=revision.document_id,
        language=language or _majority_language(chunks),
        revision=revision,
        chunks=tuple(chunks),
    )


def _load_document(entry: DatasetDocument, base: Path) -> tuple[CorpusDocument, Any]:
    """The corpus document and, for fixtures, the raw truth data (for seed judgements)."""
    if entry.truth is not None:
        path = base / entry.truth
        truth = _read_json(path)
        try:
            parsed = load_truth_document(path)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise DatasetError(f"cannot load truth file {path.name}") from exc
        revision = publish(
            build_revision(parsed, document_id=entry.id, revision_id=entry.revision_id).revision
        )
        language = entry.language or truth.get("language")
        return corpus_document(revision, language=language), truth
    if entry.revision is None:  # excluded by DatasetDocument validation
        raise DatasetError(f"document {entry.id} has no source")
    path = base / entry.revision
    revision = _validate(DocumentRevision, _read_json(path), path.name)
    if revision.document_id != entry.id:
        raise DatasetError(f"{path.name} holds document {revision.document_id}, not {entry.id}")
    chunks = _load_chunks(base / entry.chunks) if entry.chunks is not None else None
    return corpus_document(revision, chunks, language=entry.language), None


def _section_subtree(sections: Sequence[Mapping[str, Any]], root: str) -> set[str]:
    found = {root}
    changed = True
    while changed:
        changed = False
        for section in sections:
            if section.get("parent_id") in found and section["id"] not in found:
                found.add(section["id"])
                changed = True
    return found


def _seed_judgement(raw: Mapping[str, Any], truths: Mapping[str, Any]) -> Judgement:
    document_id = raw["fixture_id"]
    section_id = raw["section_id"]
    truth = truths.get(document_id)
    if truth is None:
        raise DatasetError(f"seed judgement names {document_id}, which has no truth document")
    if section_id not in {s["id"] for s in truth["sections"]}:
        raise DatasetError(f"seed judgement names unknown section {document_id}/{section_id}")
    subtree = _section_subtree(truth["sections"], section_id)
    blocks = [b for b in truth["blocks"] if b.get("section_id") in subtree]
    locations = tuple(
        SourceLocation.model_validate(
            {"page": part["page"], "bbox": part.get("bbox"), "block_id": block["id"]}
        )
        for block in blocks
        for part in block.get("parts", [])
    )
    return Judgement(
        document_id=document_id,
        section_id=section_id,
        block_ids=tuple(b["id"] for b in blocks),
        locations=locations,
        grade=raw.get("grade", 1),
    )


def _seed_queries(path: Path, truths: Mapping[str, Any]) -> tuple[EvalQuery, ...]:
    raw = _read_json(path)
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise DatasetError(f"{path.name} is not a retrieval seed file (schema_version 1)")
    try:
        return tuple(
            EvalQuery(
                id=q["id"],
                language=q["language"],
                text=q["query"],
                judgements=tuple(_seed_judgement(r, truths) for r in q["relevant"]),
            )
            for q in raw["queries"]
        )
    except (KeyError, TypeError) as exc:
        raise DatasetError(f"{path.name} is missing {exc}") from exc


def load_dataset(path: Path | str) -> Dataset:
    """Load a dataset file and everything it references."""
    path = Path(path)
    spec = _validate(DatasetFile, _read_json(path), path.name)
    base = path.parent
    documents = []
    truths: dict[str, Any] = {}
    for entry in spec.documents:
        document, truth = _load_document(entry, base)
        documents.append(document)
        if truth is not None:
            truths[entry.id] = truth
    if spec.seed_queries is not None:
        queries = _seed_queries(base / spec.seed_queries, truths)
    else:
        queries = spec.queries
    return Dataset(
        name=spec.name,
        description=spec.description,
        synthetic=spec.synthetic,
        documents=tuple(documents),
        queries=queries,
        source=path.name,
    )
