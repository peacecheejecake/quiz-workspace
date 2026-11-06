// The cells of a table block to draw: a merged cell once, at its start, and nothing in the
// positions it hides (UX12-SPANS-AC01). `rowSpan`/`colSpan` stay undefined for a plain cell.
export interface TableGridCell {
  readonly col: number;
  readonly text: string;
  readonly rowSpan?: number;
  readonly colSpan?: number;
}

export interface TableGridSource {
  readonly header_rows?: number;
  readonly rows: readonly (readonly string[])[];
  readonly spans?:
    | readonly {
        readonly row: number;
        readonly col: number;
        readonly row_span: number;
        readonly col_span: number;
      }[]
    | null;
}

export function tableGrid(table: TableGridSource): readonly TableGridCell[][] {
  const merged = new Map<string, Pick<TableGridCell, 'rowSpan' | 'colSpan'>>();
  const hidden = new Set<string>();
  const width = table.rows[0]?.length ?? 0;
  for (const { row, col, row_span: rowSpan, col_span: colSpan } of table.spans ?? []) {
    merged.set(`${row}:${col}`, {
      ...(rowSpan > 1 ? { rowSpan } : {}),
      ...(colSpan > 1 ? { colSpan } : {}),
    });
    // Only positions of the grid can be hidden, whatever the span says.
    const lastRow = Math.min(row + rowSpan, table.rows.length);
    const lastCol = Math.min(col + colSpan, width);
    for (let r = Math.max(row, 0); r < lastRow; r += 1) {
      for (let c = Math.max(col, 0); c < lastCol; c += 1) {
        if (r !== row || c !== col) hidden.add(`${r}:${c}`);
      }
    }
  }
  return table.rows.map((row, r) =>
    row.flatMap((text, col) =>
      hidden.has(`${r}:${col}`) ? [] : [{ col, text, ...merged.get(`${r}:${col}`) }],
    ),
  );
}
