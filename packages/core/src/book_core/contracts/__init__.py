"""Pydantic contracts exchanged between core modules, the API and the worker.

Kept in one package (rather than per module) because most contracts cross module boundaries:
``SourceLocation`` is produced by ``parser`` and consumed by ``chunker``, ``search``,
``extractor`` and ``generation``; keeping them together avoids import cycles between modules and
gives the API one place to import from.
"""

from book_core.contracts.common import (
    BBox,
    CoreModel,
    Identifier,
    LanguageTag,
    PageNumber,
    Sha256Hex,
    SourceLocation,
)
from book_core.contracts.document import (
    Block,
    BlockType,
    DocumentRevision,
    PageInfo,
    ParsedDocument,
    RevisionStatus,
    Section,
    TableContent,
    revision_content_hash,
)
from book_core.contracts.question import (
    DRAFT_VARIATION_TYPES,
    DraftOrigin,
    GeneratorInfo,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    SourceEvidence,
    ValidationIssue,
    ValidationSeverity,
    VariationType,
)
from book_core.contracts.search import (
    Excerpt,
    ScoreType,
    SearchChunk,
    SearchHit,
    SearchMode,
    TextSpan,
)

__all__ = [
    "DRAFT_VARIATION_TYPES",
    "BBox",
    "Block",
    "BlockType",
    "CoreModel",
    "DocumentRevision",
    "DraftOrigin",
    "Excerpt",
    "GeneratorInfo",
    "Identifier",
    "LanguageTag",
    "PageInfo",
    "PageNumber",
    "ParsedDocument",
    "QuestionDraft",
    "QuestionOption",
    "QuestionType",
    "ReviewStatus",
    "RevisionStatus",
    "ScoreType",
    "SearchChunk",
    "SearchHit",
    "SearchMode",
    "Section",
    "Sha256Hex",
    "SourceEvidence",
    "SourceLocation",
    "TableContent",
    "TextSpan",
    "ValidationIssue",
    "ValidationSeverity",
    "VariationType",
    "revision_content_hash",
]
