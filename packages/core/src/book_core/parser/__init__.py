"""PDF parsing to ``ParsedDocument`` (pages, bboxes, block types, OCR fallback): Task M1.2.

``DoclingParser`` lives in ``book_core.parser.docling_adapter`` and needs the ``parser`` extra;
it is not imported here so the rest of core (and installs without the extra) never import
Docling. ``FakeParser`` is the deterministic stand-in for unit tests and fake-adapter E2E.
"""

from book_core.parser.base import ParserError, ParserOptions, PdfParser, sha256_hex
from book_core.parser.fake import (
    FAKE_PARSER_VERSION,
    FakeParser,
    UnknownDocumentError,
    document_from_pages,
    document_from_text,
    load_truth_document,
)

__all__ = [
    "FAKE_PARSER_VERSION",
    "FakeParser",
    "ParserError",
    "ParserOptions",
    "PdfParser",
    "UnknownDocumentError",
    "document_from_pages",
    "document_from_text",
    "load_truth_document",
    "sha256_hex",
]
