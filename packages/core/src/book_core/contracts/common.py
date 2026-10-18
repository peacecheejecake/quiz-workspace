"""Shared value types for every core contract.

Conventions:
- Contracts are frozen, reject unknown fields, and reject NaN/infinity, so a value read back from
  JSON is equal to the value that was written.
- Enum values keep the spelling the design docs use (``keyword|semantic|hybrid``,
  ``OPTION_SHUFFLE``, ``MCQ``); values the docs do not name are lowercase snake case.
- Top-level documents carry ``schema_version`` so stored artifacts (``parsed_document.json``,
  index payloads, drafts) can be migrated later.
"""

from __future__ import annotations

from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=256, pattern=r"^\S+$")]
"""Opaque identifier: non-empty, no whitespace. Core never interprets its format."""

Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
"""Lowercase hex SHA-256 digest."""

NonEmptyText = Annotated[str, StringConstraints(min_length=1)]

LanguageTag = Annotated[
    str,
    StringConstraints(min_length=2, max_length=35, pattern=r"^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$"),
]
"""BCP 47 language tag, e.g. ``ko`` or ``en-US``."""

PageNumber = Annotated[int, Field(ge=1)]
"""1-based PDF page number."""


class CoreModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class BBox(CoreModel):
    """Axis-aligned box on a PDF page in PDF points, origin at the page's top-left corner.

    ``x0 < x1`` and ``y0 < y1`` (top edge above bottom edge); zero-area boxes are rejected.
    """

    x0: Annotated[float, Field(ge=0)]
    y0: Annotated[float, Field(ge=0)]
    x1: Annotated[float, Field(ge=0)]
    y1: Annotated[float, Field(ge=0)]

    @model_validator(mode="after")
    def _check_order(self) -> Self:
        if not (self.x0 < self.x1 and self.y0 < self.y1):
            raise ValueError("bbox requires x0 < x1 and y0 < y1")
        return self


class SourceLocation(CoreModel):
    """Where content sits in the original PDF.

    ``bbox`` is optional for page-level provenance (e.g. question sources stored as a page range,
    or a whole-page OCR fallback). ``block_id`` links to the canonical block when known.
    """

    page: PageNumber
    bbox: BBox | None = None
    block_id: Identifier | None = None


def ensure_unique(values: list[str], what: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"duplicate {what}: {value!r}")
        seen.add(value)
