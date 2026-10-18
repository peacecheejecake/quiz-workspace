from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from book_core.contracts import ParsedDocument


class ParserError(RuntimeError):
    """The PDF could not be converted into a ``ParsedDocument``."""


@dataclass(frozen=True, slots=True)
class ParserOptions:
    """Knobs shared by parser implementations.

    ``ocr``: run the OCR fallback (RapidOCR) on documents with pages without a text layer. Off by
    default; the engine ships with the ``ocr`` extra and is never installed by default, so
    ``ocr=True`` without it is a ``ParserError``. Pages without a text layer are flagged
    (``PageInfo.text_layer = False``) whether or not OCR runs.
    ``ocr_lang``: RapidOCR recognition language (PP-OCR code, e.g. ``korean``, ``en``).
    ``table_structure``: recover table cells (Docling TableFormer).
    ``artifacts_path``: pre-downloaded model weights directory (offline workers); ``None`` uses
    the Hugging Face cache (``HF_HOME``, default ``~/.cache/huggingface``).
    ``device``: model inference device. ``cpu`` keeps output identical across machines.
    ``document_timeout``: seconds after which conversion stops; a document that does not finish
    in time is a ``ParserError`` (never a partial document). ``None`` = no limit.
    """

    ocr: bool = False
    ocr_lang: str = "korean"
    table_structure: bool = True
    artifacts_path: Path | None = None
    device: str = "cpu"
    document_timeout: float | None = None


@runtime_checkable
class PdfParser(Protocol):
    """Turns one immutable source PDF into a ``ParsedDocument``.

    ``source_path`` is recorded as ``ParsedDocument.source_path`` (e.g. the storage key);
    it defaults to the file name so local paths do not leak into stored artifacts.
    Implementations must be deterministic: the same bytes give the same document.
    """

    @property
    def parser_version(self) -> str: ...

    def parse(self, path: Path, *, source_path: str | None = None) -> ParsedDocument: ...


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
