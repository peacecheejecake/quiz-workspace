// UX12-STEMTABLE (docs/screens/ux12-stemtable.md): structured cells beside the GFM tables of a
// stem, and the table editor's model. Pure.
//
// `alignedStemTables` mirrors `aligned_stem_tables` and `tableGfm` mirrors `gfm_table` in
// packages/core/src/book_core; tests/fixtures/stem-table-alignment.json holds their shared cases.
// Cells are a rectangular grid: a merged cell repeats its text in every position it covers, so
// writing them as GFM gives the block the stem stores.
import { stemSegments, stemTableRanges, type PipeTable } from './stem-table';

export interface StemCellSpan {
  readonly row: number;
  readonly col: number;
  readonly row_span: number;
  readonly col_span: number;
}

export interface StemCells {
  readonly rows: readonly (readonly string[])[];
  readonly header_rows: number;
  readonly spans?: readonly StemCellSpan[] | null;
}

/** One entry per pipe block in order; null shows that block as GFM. */
export type StemTables = readonly (StemCells | null)[] | null | undefined;

export interface EditableTable {
  readonly cells: StemCells;
  /** The block had an entry that no longer lines up: its merged cells are not known. */
  readonly fellBack: boolean;
}

const MAX_STEM_TABLES = 50;

function loose(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function gfmCell(cell: string): string {
  return cell
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .split('\n')
    .filter((part) => part.trim() !== '')
    .map(oneLine)
    .join('<br>');
}

/** The cells as the GFM block a stem stores. */
export function tableGfm(table: Pick<StemCells, 'rows'>): string {
  const rows = table.rows.map((row) => row.map(gfmCell));
  const [first = []] = rows;
  return [
    `| ${first.join(' | ')} |`,
    `|${' --- |'.repeat(first.length)}`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function pipeBlocks(stem: string): { readonly text: string; readonly table: PipeTable }[] {
  return stemSegments(stem).flatMap((segment) => (segment.kind === 'table' ? [segment] : []));
}

/** `tables` kept where they line up with `stem`, null when no entry is left. */
export function alignedStemTables(
  stem: string,
  tables: StemTables,
): readonly (StemCells | null)[] | null {
  if (!tables || tables.length === 0 || tables.length > MAX_STEM_TABLES) return null;
  const blocks = pipeBlocks(stem);
  if (blocks.length !== tables.length) return null;
  const kept = tables.map((table, i) =>
    table && loose(tableGfm(table)) === loose((blocks[i] as { text: string }).text) ? table : null,
  );
  return kept.some((table) => table !== null) ? kept : null;
}

/** Every table of the stem as the editor opens it: its entry, or else its parsed pipe block. */
export function editableStemTables(stem: string, tables: StemTables): readonly EditableTable[] {
  const aligned = alignedStemTables(stem, tables);
  return pipeBlocks(stem).map(({ table }, i) => {
    const entry = aligned?.[i];
    if (entry) return { cells: entry, fellBack: false };
    return {
      cells: { rows: [table.header, ...table.rows], header_rows: 1, spans: null },
      fellBack: Boolean(tables?.[i]),
    };
  });
}

/**
 * The stem and cells after the editor changed table `index`: the structured table stays the
 * source and its GFM block is written from it. Blocks not edited keep what they had.
 */
export function applyTableEdit(
  stem: string,
  tables: StemTables,
  index: number,
  next: StemCells,
): { readonly stem: string; readonly stemTables: readonly (StemCells | null)[] } {
  const ranges = stemTableRanges(stem);
  const range = ranges[index];
  if (!range) throw new Error(`no table ${index} in the stem`);
  const lines = stem.split('\n');
  lines.splice(range.start, range.end - range.start, ...tableGfm(next).split('\n'));
  const aligned = alignedStemTables(stem, tables);
  return {
    stem: lines.join('\n'),
    stemTables: ranges.map((_, i) => (i === index ? next : (aligned?.[i] ?? null))),
  };
}

function spanAt(table: StemCells, row: number, col: number): StemCellSpan | undefined {
  return (table.spans ?? []).find(
    (s) => row >= s.row && row < s.row + s.row_span && col >= s.col && col < s.col + s.col_span,
  );
}

/** A span covers more than one cell; none left is null, as the contract stores it. */
function kept(spans: readonly StemCellSpan[]): readonly StemCellSpan[] | null {
  const left = spans.filter((s) => s.row_span * s.col_span > 1);
  return left.length > 0 ? left : null;
}

/** New text of a cell: every grid position a merged cell covers takes it. */
export function setCell(table: StemCells, row: number, col: number, text: string): StemCells {
  const span = spanAt(table, row, col);
  return {
    ...table,
    rows: table.rows.map((cells, r) =>
      cells.map((cell, c) => {
        const covered = span ? spanAt(table, r, c) === span : r === row && c === col;
        return covered ? text : cell;
      }),
    ),
  };
}

/** `[start, size]` of a span along one axis after a line is inserted at `at`. */
function grown(start: number, size: number, at: number): readonly [number, number] {
  if (at <= start) return [start + 1, size];
  return at < start + size ? [start, size + 1] : [start, size];
}

/** `[start, size]` of a span along one axis after line `at` goes: the next line takes over. */
function shrunk(start: number, size: number, at: number): readonly [number, number] {
  if (at < start) return [start - 1, size];
  return at < start + size ? [start, size - 1] : [start, size];
}

/** Inserts a row before `at`. Inside a merged cell the merge grows and keeps its text. */
export function insertRow(table: StemCells, at: number): StemCells {
  const spans = table.spans ?? [];
  const width = table.rows[0]?.length ?? 0;
  const row = Array.from({ length: width }, (_, col) => {
    const span = spans.find(
      (s) => s.row < at && at < s.row + s.row_span && col >= s.col && col < s.col + s.col_span,
    );
    return span ? (table.rows[span.row]?.[span.col] ?? '') : '';
  });
  return {
    rows: [...table.rows.slice(0, at), row, ...table.rows.slice(at)],
    header_rows: at < table.header_rows ? table.header_rows + 1 : table.header_rows,
    spans: kept(
      spans.map((s) => {
        const [start, size] = grown(s.row, s.row_span, at);
        return { ...s, row: start, row_span: size };
      }),
    ),
  };
}

/** Inserts a column before `at`. Inside a merged cell the merge grows and keeps its text. */
export function insertColumn(table: StemCells, at: number): StemCells {
  const spans = table.spans ?? [];
  return {
    ...table,
    rows: table.rows.map((cells, row) => {
      const span = spans.find(
        (s) => s.col < at && at < s.col + s.col_span && row >= s.row && row < s.row + s.row_span,
      );
      const text = span ? (table.rows[span.row]?.[span.col] ?? '') : '';
      return [...cells.slice(0, at), text, ...cells.slice(at)];
    }),
    spans: kept(
      spans.map((s) => {
        const [start, size] = grown(s.col, s.col_span, at);
        return { ...s, col: start, col_span: size };
      }),
    ),
  };
}

/** Removes row `at`, shrinking the merged cells it crosses. The last row stays. */
export function removeRow(table: StemCells, at: number): StemCells {
  if (table.rows.length <= 1) return table;
  return {
    rows: table.rows.filter((_, r) => r !== at),
    header_rows: at < table.header_rows ? table.header_rows - 1 : table.header_rows,
    spans: kept(
      (table.spans ?? []).map((s) => {
        const [start, size] = shrunk(s.row, s.row_span, at);
        return { ...s, row: start, row_span: size };
      }),
    ),
  };
}

/** Removes column `at`, shrinking the merged cells it crosses. The last column stays. */
export function removeColumn(table: StemCells, at: number): StemCells {
  if ((table.rows[0]?.length ?? 0) <= 1) return table;
  return {
    ...table,
    rows: table.rows.map((cells) => cells.filter((_, c) => c !== at)),
    spans: kept(
      (table.spans ?? []).map((s) => {
        const [start, size] = shrunk(s.col, s.col_span, at);
        return { ...s, col: start, col_span: size };
      }),
    ),
  };
}

function range(start: number, span: number | undefined): string {
  return span && span > 1 ? `${start + 1}–${start + span}` : `${start + 1}`;
}

/** The name of a cell's input: "표 1 2행 3열", a merged cell by its range. */
export function cellLabel(
  tableIndex: number,
  cell: {
    readonly row: number;
    readonly col: number;
    readonly rowSpan?: number;
    readonly colSpan?: number;
  },
): string {
  const merged = (cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1;
  const name = `표 ${tableIndex + 1} ${range(cell.row, cell.rowSpan)}행 ${range(cell.col, cell.colSpan)}열`;
  return merged ? `${name} 병합` : name;
}
