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

    ``ocr``: run the OCR fallback on pages without a text layer. Off by default; the OCR engine
    ships with the ``ocr`` extra and is never installed by default. Pages without a text layer
    are flagged (``PageInfo.text_layer = False``) whether or not OCR runs.
    ``table_structure``: recover table cells (Docling TableFormer).
    ``artifacts_path``: pre-downloaded model weights directory (offline workers); ``None`` uses
    the Hugging Face cache (``HF_HOME``, default ``~/.cache/huggingface``).
    ``device``: model inference device. ``cpu`` keeps output identical across machines.
    """

    ocr: bool = False
    table_structure: bool = True
    artifacts_path: Path | None = None
    device: str = "cpu"


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
