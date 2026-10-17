"""Search contracts: index units, hits and paragraph-complete excerpts.

Source: docs/architecture.md §4 (``SearchChunk``, ``SearchHit``, ``Excerpt``, search flow),
docs/screens/search.md (SourceLocation = page, block id, revision), implementation plan M1.4,
M2.3-M2.5.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from book_core.contracts.common import (
    CoreModel,
    Identifier,
    LanguageTag,
    NonEmptyText,
    Sha256Hex,
    SourceLocation,
    ensure_unique,
)


class SearchMode(StrEnum):
    KEYWORD = "keyword"
    SEMANTIC = "semantic"
    HYBRID = "hybrid"


class ScoreType(StrEnum):
    """What a hit's ``score`` means; scores of different types are not comparable."""

    BM25 = "bm25"
    COSINE = "cosine"
    RRF = "rrf"
    RERANK = "rerank"


_SCORE_TYPES_BY_MODE: dict[SearchMode, frozenset[ScoreType]] = {
    SearchMode.KEYWORD: frozenset({ScoreType.BM25, ScoreType.RERANK}),
    SearchMode.SEMANTIC: frozenset({ScoreType.COSINE, ScoreType.RERANK}),
    SearchMode.HYBRID: frozenset({ScoreType.RRF, ScoreType.RERANK}),
}


class ChunkLevel(StrEnum):
    """Parent chunks give section context; child chunks are the retrieval units."""

    PARENT = "parent"
    CHILD = "child"


class SearchChunk(CoreModel):
    """One indexable chunk of a document revision.

    ``content`` is the canonical text shown to users; ``search_text`` is the contextualised text
    that is embedded/indexed (e.g. prefixed with chapter/section titles). ``parent_id`` points at
    the parent chunk in the parent/child hierarchy; parent chunks have none.

    ``id`` is stable across revisions for unchanged regions and ``content_hash`` changes when
    anything that must be re-indexed changes; ``revision_id`` and ``ordinal`` (reading-order
    position among chunks of the same ``level``) are excluded from it, so both are payload that
    is refreshed for every chunk of a new revision. ``breadcrumb`` is the document title (when
    known) followed by the chapter/section titles; ``token_count`` is the size of
    ``search_text`` under the chunker's tokenizer.
    """

    schema_version: Literal[1] = 1
    id: Identifier
    document_id: Identifier
    revision_id: Identifier
    parent_id: Identifier | None = None
    section_id: Identifier | None = None
    content: NonEmptyText
    search_text: NonEmptyText
    content_hash: Sha256Hex
    language: LanguageTag | None = None
    block_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]
    locations: Annotated[tuple[SourceLocation, ...], Field(min_length=1)]
    level: ChunkLevel = ChunkLevel.CHILD
    ordinal: Annotated[int, Field(ge=0)] | None = None
    token_count: Annotated[int, Field(ge=0)] | None = None
    breadcrumb: tuple[NonEmptyText, ...] = ()

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.parent_id == self.id:
            raise ValueError("chunk cannot be its own parent")
        if self.level is ChunkLevel.PARENT and self.parent_id is not None:
            raise ValueError("parent chunks cannot have a parent")
        ensure_unique(list(self.block_ids), "block id")
        return self


class SearchHit(CoreModel):
    """A ranked result: the matching passage plus where it lives in the document."""

    chunk_id: Identifier
    document_id: Identifier
    revision_id: Identifier
    section_id: Identifier | None = None
    mode: SearchMode
    score_type: ScoreType
    score: float
    rank: Annotated[int, Field(ge=1)]
    passage: NonEmptyText
    locations: Annotated[tuple[SourceLocation, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.score_type not in _SCORE_TYPES_BY_MODE[self.mode]:
            raise ValueError(f"score type {self.score_type} is not valid for mode {self.mode}")
        return self


class TextSpan(CoreModel):
    """Half-open character range ``[start, end)`` within a text."""

    start: Annotated[int, Field(ge=0)]
    end: Annotated[int, Field(ge=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.end <= self.start:
            raise ValueError("span end must be greater than start")
        return self


class Excerpt(CoreModel):
    """Original text expanded to paragraph boundaries around a hit, with page coordinates.

    ``highlights`` mark the matched passage inside ``text`` for emphasis in the UI.
    """

    document_id: Identifier
    revision_id: Identifier
    chunk_id: Identifier | None = None
    section_id: Identifier | None = None
    text: NonEmptyText
    highlights: tuple[TextSpan, ...] = ()
    block_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]
    locations: Annotated[tuple[SourceLocation, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        ensure_unique(list(self.block_ids), "block id")
        for span in self.highlights:
            if span.end > len(self.text):
                raise ValueError("highlight exceeds excerpt text")
        return self
