"""Structured cells beside the GFM tables of a stem (UX12-STEMTABLE, questions.md §4 11).

``stem`` stays the source for AI, search, fingerprints and duplicates. ``stem_tables`` is a list
aligned with the stem's pipe blocks, so merged cells can be drawn: one ``TableContent`` per block,
or ``None`` for a block shown from its GFM. An entry only counts while it says the same as its
block (letters compared without spacing); any other pairing is dropped, never repaired, and that
block shows as GFM. ``alignedStemTables`` in apps/web mirrors these rules;
tests/fixtures/stem-table-alignment.json holds their shared cases.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from book_core.contracts.document import TableContent, TableSpan
from book_core.export import gfm_table
from book_core.question.labels import loose_text, split_pipe_blocks

__all__ = [
    "MAX_STEM_TABLES",
    "MAX_STEM_TABLES_BYTES",
    "StemTables",
    "aligned_stem_tables",
    "gfm_table",
    "stem_table_spans",
    "stem_tables_json",
    "variant_stem_tables",
]

# The same limits as the `stem_tables_valid` constraint in supabase/migrations.
MAX_STEM_TABLES = 50
MAX_STEM_TABLES_BYTES = 200_000

StemTables = tuple[TableContent | None, ...]


def stem_tables_json(tables: Sequence[TableContent | None] | None) -> list[Any] | None:
    if tables is None:
        return None
    return [t.model_dump(mode="json") if t is not None else None for t in tables]


def aligned_stem_tables(
    stem: str, tables: Sequence[TableContent | None] | None
) -> StemTables | None:
    """``tables`` kept where they line up with ``stem``, ``None`` when no entry is left."""
    if not tables:
        return None
    blocks = [text for is_table, text in split_pipe_blocks(stem) if is_table]
    if len(blocks) != len(tables):
        return None
    kept = tuple(
        table if table is not None and loose_text(gfm_table(table)) == loose_text(block) else None
        for table, block in zip(tables, blocks, strict=True)
    )
    if all(table is None for table in kept) or len(kept) > MAX_STEM_TABLES:
        return None
    if len(json.dumps(stem_tables_json(kept), ensure_ascii=False).encode()) > MAX_STEM_TABLES_BYTES:
        return None
    return kept


def stem_table_spans(
    tables: Sequence[TableContent | None] | None,
) -> list[tuple[TableSpan, ...]]:
    """The merged cells per table, what structured cells add to a stem: no entry and no merged
    cell are the same display, so a re-extraction only reports the first real difference."""
    spans = [(table.spans or ()) if table is not None else () for table in tables or ()]
    while spans and not spans[-1]:
        spans.pop()
    return spans


def variant_stem_tables(
    variant_stem: str, source_stem: str, tables: Sequence[TableContent | None] | None
) -> StemTables | None:
    """The source's cells for a variant: only with the very same stem (an option shuffle)."""
    return aligned_stem_tables(variant_stem, tables) if variant_stem == source_stem else None
