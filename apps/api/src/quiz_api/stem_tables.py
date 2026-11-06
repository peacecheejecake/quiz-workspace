"""`stem_tables` over the API (UX12-STEMTABLE, C04, C05).

Stored as sent by the extractor or an editor, after `aligned_stem_tables`: what does not line up
with the stem is dropped, never refused and never repaired, so that block shows as GFM. A table
holds no answer, but like the stem it is sent only where the stem is.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any, Self

from book_core.contracts import TableContent
from book_core.question import MAX_STEM_TABLES, StemTables, aligned_stem_tables
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StemTableSpan(BaseModel):
    row: int = Field(ge=0)
    col: int = Field(ge=0)
    row_span: int = Field(ge=1)
    col_span: int = Field(ge=1)


class StemTable(BaseModel):
    """The cells of one pipe block of the stem, in the shape of a document table."""

    rows: list[list[str]] = Field(description="Rectangular grid: merged cells repeat their text.")
    header_rows: int
    spans: list[StemTableSpan] | None = Field(
        default=None, description="Merged cells; null when there are none."
    )


class StemTableInput(StemTable):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _grid(self) -> Self:
        content(self)
        return self


StemTablesInput = Annotated[list[StemTableInput | None], Field(max_length=MAX_STEM_TABLES)]
STEM_TABLES_DESCRIPTION = (
    "Cells of the stem's pipe blocks, in order; a null entry shows that block as GFM. "
    "Null when every block shows as GFM."
)
STEM_TABLES_EDIT_DESCRIPTION = (
    f"{STEM_TABLES_DESCRIPTION} Omitted: the stored cells, while they fit the stem."
)


def content(table: StemTable) -> TableContent:
    return TableContent.model_validate(table.model_dump(exclude_none=True))


def stem_tables_out(stored: Sequence[Any] | None) -> list[StemTable | None] | None:
    """A stored value (JSON, or a draft's parsed cells) as a response field."""
    if stored is None:
        return None
    return [
        StemTable.model_validate(t.model_dump(mode="json") if isinstance(t, TableContent) else t)
        if t is not None
        else None
        for t in stored
    ]


def parse_stem_tables(stored: Sequence[Any] | None) -> StemTables | None:
    if stored is None:
        return None
    return tuple(TableContent.model_validate(t) if t is not None else None for t in stored)


def sent_stem_tables(
    stem: str, tables: Sequence[StemTableInput | None] | None
) -> StemTables | None:
    """The cells a request sent, as far as they line up with its stem."""
    if tables is None:
        return None
    return aligned_stem_tables(stem, tuple(content(t) if t is not None else None for t in tables))


def edited_stem_tables(
    stem: str,
    *,
    sent: bool,
    tables: Sequence[StemTableInput | None] | None,
    stored: StemTables | None,
) -> StemTables | None:
    """An edit's cells: what it sent, or else the stored ones if they still fit the new stem."""
    return sent_stem_tables(stem, tables) if sent else aligned_stem_tables(stem, stored)
