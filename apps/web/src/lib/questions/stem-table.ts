// QTABLE-01 (docs/questions.md §4 item 11): a table inside a stem is a GFM pipe table, and options
// printed as a table are `cell | cell` texts. Display only: stored stems, options, grading,
// fingerprints and editor values keep the original text.
//
// `stemSegments` mirrors `split_pipe_blocks` in packages/core/src/book_core/question/labels.py;
// tests/fixtures/question-tables.json holds their shared cases.

export interface PipeTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type StemSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'table'; readonly text: string; readonly table: PipeTable };

/** Raw cells of a `| a | b |` row (`\|` stays inside its cell), null for any other line. */
export function pipeCells(line: string): string[] | null {
  const row = line.trim();
  if (row.length < 2 || !row.startsWith('|')) return null;
  const cells: string[] = [];
  let start = 1;
  for (let i = 1; i < row.length; i += 1) {
    if (row[i] === '\\') {
      i += 1;
    } else if (row[i] === '|') {
      cells.push(row.slice(start, i).trim());
      start = i + 1;
    }
  }
  return start === row.length ? cells : null;
}

/** A header row, a delimiter row and the same number of cells in every row. */
function isPipeTable(rows: readonly (readonly string[])[]): boolean {
  const width = rows[0]?.length;
  return (
    rows.length >= 2 &&
    (rows[1] as readonly string[]).every((cell) => /^:?-+:?$/u.test(cell)) &&
    rows.every((row) => row.length === width)
  );
}

/** A stored cell as shown: `\|` and `\\` unescaped, `<br>` a line break. */
function cellText(raw: string): string {
  return raw.replace(/\\([\\|])|<br>/gu, (_, escaped?: string) => escaped ?? '\n');
}

function table(rows: readonly (readonly string[])[]): PipeTable {
  const [header = [], , ...body] = rows;
  return { header: header.map(cellText), rows: body.map((row) => row.map(cellText)) };
}

/** The consecutive `| ... |` lines from `start`, as cells, and the line after them. */
function pipeRun(lines: readonly string[], start: number) {
  const rows: string[][] = [];
  let end = start;
  for (;;) {
    const cells = end < lines.length ? pipeCells(lines[end] as string) : null;
    if (!cells) return { rows, end };
    rows.push(cells);
    end += 1;
  }
}

/** The `[start, end)` lines of each table of the stem, in order. */
export function stemTableRanges(stem: string): { readonly start: number; readonly end: number }[] {
  const lines = stem.split('\n');
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const { rows, end } = pipeRun(lines, i);
    if (isPipeTable(rows)) ranges.push({ start: i, end });
    i = Math.max(end, i + 1);
  }
  return ranges;
}

/**
 * The stem as text and table segments in order, trimmed, empty ones dropped. A table is a run of
 * consecutive `| ... |` lines that passes `isPipeTable`; any other run stays text, whole.
 */
export function stemSegments(stem: string): StemSegment[] {
  const segments: StemSegment[] = [];
  let plain: string[] = [];
  const flush = () => {
    const text = plain.join('\n').trim();
    plain = [];
    if (text !== '') segments.push({ kind: 'text', text });
  };
  const lines = stem.split('\n');
  let i = 0;
  while (i < lines.length) {
    const { rows, end } = pipeRun(lines, i);
    if (isPipeTable(rows)) {
      flush();
      const text = lines
        .slice(i, end)
        .map((line) => line.trim())
        .join('\n');
      segments.push({ kind: 'table', text, table: table(rows) });
    } else {
      plain.push(...lines.slice(i, Math.max(end, i + 1)));
    }
    i = Math.max(end, i + 1);
  }
  flush();
  return segments;
}

export function hasStemTable(stem: string): boolean {
  return stemSegments(stem).some((segment) => segment.kind === 'table');
}

export interface OptionGrid {
  readonly columns: number;
  /** Cells per option, in the order of the options given. */
  readonly rows: readonly (readonly string[])[];
  /** Column headers taken from the end of the stem; null when it prints none. */
  readonly headers: readonly string[] | null;
  /** The stem to show: without the header row when one moved up to the columns. */
  readonly stem: string;
}

const CELL_SEPARATOR = ' | ';
/** The question sentence and the first header cell glued on one line (`옳은 것은? 구분 | 내용`). */
const SENTENCE_THEN_CELL = /^(.*[?？.:：)）」>])\s+(\S.*)$/su;

/** The trailing `머리글 | 머리글` of a stem, `columns` cells or one more for the label column. */
function trailingHeader(
  stem: string,
  columns: number,
): { readonly headers: readonly string[]; readonly stem: string } | null {
  const lineStart = stem.lastIndexOf('\n') + 1;
  const line = stem.slice(lineStart);
  if (line.trimStart().startsWith('|')) return null;
  const cells = line.split(CELL_SEPARATOR).map((cell) => cell.trim());
  if (cells.length !== columns && cells.length !== columns + 1) return null;
  const sentence = SENTENCE_THEN_CELL.exec(cells[0] as string);
  if (!sentence && lineStart === 0) return null;
  const lead = sentence?.[1] ?? '';
  const named = sentence ? [sentence[2] as string, ...cells.slice(1)] : cells;
  if (named.some((cell) => cell === '')) return null;
  return {
    headers: named.slice(-columns),
    stem: `${stem.slice(0, lineStart)}${lead}`.trimEnd(),
  };
}

/**
 * Options that print as one table: every text splits on ` | ` into the same N >= 2 non-empty
 * cells. Decided row by row, so shuffled options keep their cells, and registered questions need
 * no new import. Null for any other options: they show as text.
 */
export function optionGrid(
  stem: string,
  options: readonly { readonly text: string }[],
): OptionGrid | null {
  if (options.length < 2) return null;
  const rows = options.map((option) =>
    option.text.split(CELL_SEPARATOR).map((cell) => cell.trim()),
  );
  const columns = rows[0]?.length ?? 0;
  if (columns < 2) return null;
  if (rows.some((row) => row.length !== columns || row.some((cell) => cell === ''))) return null;
  const moved = trailingHeader(stem, columns);
  return { columns, rows, headers: moved?.headers ?? null, stem: moved?.stem ?? stem };
}
