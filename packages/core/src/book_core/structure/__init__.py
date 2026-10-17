"""Chapter/section hierarchy and canonical blocks as ``DocumentRevision``: Task M1.3.

``build_revision`` turns a ``ParsedDocument`` into the first draft revision: the chapter/section
tree restored from heading numbering (front matter and TOC excluded), and canonical blocks
(paragraphs split across pages/columns merged, text normalized) with provenance to the parser
blocks, pages and bboxes. ``apply_edits`` derives the next revision from user corrections.
"""

from book_core.structure.canonical import ends_sentence, join_texts, normalize_block_text
from book_core.structure.hierarchy import StructureWarning
from book_core.structure.numbering import Numbering, NumberingKind, parse_numbering
from book_core.structure.revision import (
    RevisionEditError,
    StructureResult,
    apply_edits,
    build_revision,
    canonical_block_id,
    changed_block_ids,
    publish,
    section_id,
)

__all__ = [
    "Numbering",
    "NumberingKind",
    "RevisionEditError",
    "StructureResult",
    "StructureWarning",
    "apply_edits",
    "build_revision",
    "canonical_block_id",
    "changed_block_ids",
    "ends_sentence",
    "join_texts",
    "normalize_block_text",
    "parse_numbering",
    "publish",
    "section_id",
]
