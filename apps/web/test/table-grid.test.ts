import { describe, expect, it } from 'vitest';
import { tableGrid } from '@/lib/documents/table-grid';

describe('tableGrid', () => {
  it('draws every cell of a table without spans', () => {
    const grid = tableGrid({
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      header_rows: 1,
    });
    expect(grid).toEqual([
      [
        { col: 0, text: 'a' },
        { col: 1, text: 'b' },
      ],
      [
        { col: 0, text: 'c' },
        { col: 1, text: 'd' },
      ],
    ]);
  });

  it('draws a merged cell once and keeps the column of the cells after it', () => {
    const grid = tableGrid({
      rows: [
        ['a', 'a', 'b'],
        ['a', 'a', 'c'],
        ['d', 'e', 'c'],
      ],
      header_rows: 0,
      spans: [
        { row: 0, col: 0, row_span: 2, col_span: 2 },
        { row: 1, col: 2, row_span: 2, col_span: 1 },
      ],
    });
    expect(grid).toEqual([
      [
        { col: 0, text: 'a', rowSpan: 2, colSpan: 2 },
        { col: 2, text: 'b' },
      ],
      [{ col: 2, text: 'c', rowSpan: 2 }],
      [
        { col: 0, text: 'd' },
        { col: 1, text: 'e' },
      ],
    ]);
  });
});
