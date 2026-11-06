// The cells of a table block to draw: a merged cell once, at its start, and nothing in the
// positions it hides (UX12-SPANS-AC01). `rowSpan`/`colSpan` stay undefined for a plain cell.
import type { ContentBlock } from './editor-api';

export interface TableGridCell {
  readonly col: number;
  readonly text: string;
  readonly rowSpan?: number;
  readonly colSpan?: number;
}

export function tableGrid(table: NonNullable<ContentBlock['table']>): readonly TableGridCell[][] {
  const merged = new Map<string, Pick<TableGridCell, 'rowSpan' | 'colSpan'>>();
  const hidden = new Set<string>();
  for (const { row, col, row_span: rowSpan, col_span: colSpan } of table.spans ?? []) {
    merged.set(`${row}:${col}`, {
      ...(rowSpan > 1 ? { rowSpan } : {}),
      ...(colSpan > 1 ? { colSpan } : {}),
    });
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = col; c < col + colSpan; c += 1) {
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
