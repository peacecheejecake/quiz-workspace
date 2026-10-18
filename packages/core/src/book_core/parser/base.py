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
    ``queue_max_size``: pages buffered between Docling's pipeline stages. Docling's default (100)
    lets memory grow with book length (about 4.5 GB on a 300-page book); a small bound (e.g. 8)
    caps it at a few batches with about the same throughput. ``None`` keeps Docling's default.
    ``page_batch_size``: pages per layout / table / OCR model batch (memory per batch);
    ``None`` keeps Docling's default (4).
    ``num_threads``: CPU threads for Docling's models; ``None`` lets Docling read
    ``DOCLING_NUM_THREADS`` / ``OMP_NUM_THREADS`` (default 4).
    """

    ocr: bool = False
    ocr_lang: str = "korean"
    table_structure: bool = True
    artifacts_path: Path | None = None
    device: str = "cpu"
    document_timeout: float | None = None
    queue_max_size: int | None = None
    page_batch_size: int | None = None
    num_threads: int | None = None

    def __post_init__(self) -> None:
        for name in ("queue_max_size", "page_batch_size", "num_threads"):
            value = getattr(self, name)
            if value is not None and value < 1:
                raise ValueError(f"{name} must be >= 1")


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
