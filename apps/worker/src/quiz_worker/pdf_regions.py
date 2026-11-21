"""Render a region of a source PDF page as PNG (FIGTBL-2), for the question refine step.

``open_pdf_regions`` opens a PDF with pypdfium2 (installed with the parser extra, so imported
lazily) and yields a ``PageRegionRenderer``. pdfium is not thread-safe: calls are serialised.
"""

from __future__ import annotations

import io
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from book_core.contracts import BBox

MAX_SCALE = 3.0
"""Upper bound of pixels per PDF point (216 dpi); small regions are not blown up further."""


@contextmanager
def open_pdf_regions(path: Path) -> Iterator[_PdfRegions]:
    import pypdfium2 as pdfium  # type: ignore[import-untyped]

    pdf = pdfium.PdfDocument(str(path))
    try:
        yield _PdfRegions(pdf)
    finally:
        pdf.close()


class _PdfRegions:
    def __init__(self, pdf: object) -> None:
        self._pdf = pdf
        self._lock = threading.Lock()

    def __call__(self, page: int, bbox: BBox, *, max_edge: int) -> bytes | None:
        """PNG of ``bbox`` (PDF points, top-left origin) on 1-based ``page``; ``None`` when the
        page is missing, rotated, or the box is empty after clamping to the page."""
        with self._lock:
            if not 1 <= page <= len(self._pdf):  # type: ignore[arg-type]
                return None
            pdf_page = self._pdf[page - 1]  # type: ignore[index]
            try:
                if pdf_page.get_rotation() % 360:
                    return None
                width, height = pdf_page.get_size()
                x0, y0 = max(0.0, bbox.x0), max(0.0, bbox.y0)
                x1, y1 = min(width, bbox.x1), min(height, bbox.y1)
                if x1 - x0 < 1 or y1 - y0 < 1:
                    return None
                scale = min(MAX_SCALE, max_edge / max(x1 - x0, y1 - y0))
                # pdfium crops by the margin to remove on each side (left, bottom, right, top).
                bitmap = pdf_page.render(
                    scale=scale, crop=(x0, height - y1, width - x1, y0), may_draw_forms=False
                )
                image = bitmap.to_pil()
                if max(image.size) > max_edge:
                    image.thumbnail((max_edge, max_edge))
                out = io.BytesIO()
                image.convert("RGB").save(out, format="PNG")
                return out.getvalue()
            finally:
                pdf_page.close()
