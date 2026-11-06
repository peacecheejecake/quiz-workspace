import { describe, expect, it } from 'vitest';
import { tableGrid } from '@/lib/documents/table-grid';
import { emptyForm, parseFormValues } from '@/lib/questions/form';
import {
  alignedStemTables,
  applyTableEdit,
  cellLabel,
  editableStemTables,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  setCell,
  tableGfm,
  type StemCells,
} from '@/lib/questions/stem-table-edit';
import cases from '../../../tests/fixtures/stem-table-alignment.json';

const MERGED: StemCells = {
  rows: [
    ['구분', '구분', '값'],
    ['A', 'x', '1'],
    ['A', 'y', '2'],
    ['B', 'z', '3'],
  ],
  header_rows: 1,
  spans: [
    { row: 0, col: 0, row_span: 1, col_span: 2 },
    { row: 1, col: 0, row_span: 2, col_span: 1 },
  ],
};
const GFM =
  '| 구분 | 구분 | 값 |\n| --- | --- | --- |\n| A | x | 1 |\n| A | y | 2 |\n| B | z | 3 |';

describe('alignedStemTables', () => {
  it.each(cases)('$name', ({ stem, tables, kept }) => {
    const got = alignedStemTables(stem, tables as StemCells[]);
    expect((got ?? []).map((table) => table !== null)).toEqual(kept);
  });

  it('is null without cells', () => {
    expect(alignedStemTables(GFM, null)).toBeNull();
    expect(alignedStemTables(GFM, undefined)).toBeNull();
    expect(alignedStemTables(GFM, [])).toBeNull();
  });
});

describe('spans from outside', () => {
  const huge = { row: 0, col: 0, row_span: 1_000_000_000, col_span: 1_000_000_000 };

  it('tableGrid walks the grid only, whatever a span says', () => {
    expect(tableGrid({ rows: [['a']], spans: [huge] })).toHaveLength(1);
  });

  it('the form drops cells whose span leaves the grid', () => {
    const form = { ...emptyForm(), stemTables: [{ rows: [['a']], header_rows: 0, spans: [huge] }] };
    expect(parseFormValues(form)?.stemTables).toBeNull();
  });

  it('the form keeps cells whose span fits', () => {
    const spans = [{ row: 0, col: 0, row_span: 2, col_span: 1 }];
    const form = { ...emptyForm(), stemTables: [{ rows: [['a'], ['a']], header_rows: 0, spans }] };
    expect(parseFormValues(form)?.stemTables).toEqual(form.stemTables);
  });
});

describe('tableGfm', () => {
  it('writes the text the stem stores, repeating merged cells', () => {
    expect(tableGfm(MERGED)).toBe(GFM);
  });

  it('escapes pipes and backslashes and keeps line breaks as <br>', () => {
    const table = {
      rows: [
        ['a|b', 'c\\'],
        ['x\ny', ''],
      ],
      header_rows: 1,
    };
    expect(tableGfm(table)).toBe('| a\\|b | c\\\\ |\n| --- | --- |\n| x<br>y |  |');
  });
});

describe('setCell', () => {
  it('changes one plain cell', () => {
    expect(setCell(MERGED, 1, 1, 'q').rows[1]).toEqual(['A', 'q', '1']);
  });

  it('changes every grid cell a merged cell covers', () => {
    const next = setCell(MERGED, 1, 0, 'C');
    expect(next.rows.map((row) => row[0])).toEqual(['구분', 'C', 'C', 'B']);
    expect(next.spans).toEqual(MERGED.spans);
  });
});

describe('removeRow', () => {
  it('shrinks a span the row crosses', () => {
    const next = removeRow(MERGED, 2);
    expect(next.rows.map((row) => row[1])).toEqual(['구분', 'x', 'z']);
    expect(next.spans).toEqual([{ row: 0, col: 0, row_span: 1, col_span: 2 }]);
  });

  it('keeps a span whose first row goes: the next row starts it', () => {
    const table = removeRow(
      { ...MERGED, spans: [{ row: 1, col: 0, row_span: 3, col_span: 1 }] },
      1,
    );
    expect(table.spans).toEqual([{ row: 1, col: 0, row_span: 2, col_span: 1 }]);
  });

  it('moves the spans below up', () => {
    const table = removeRow(
      { ...MERGED, spans: [{ row: 2, col: 0, row_span: 2, col_span: 1 }] },
      1,
    );
    expect(table.spans).toEqual([{ row: 1, col: 0, row_span: 2, col_span: 1 }]);
  });

  it('drops a span on the removed row alone', () => {
    const next = removeRow(MERGED, 0);
    expect(next.header_rows).toBe(0);
    expect(next.spans).toEqual([{ row: 0, col: 0, row_span: 2, col_span: 1 }]);
  });

  it('has no spans left as null', () => {
    const table = {
      rows: [
        ['a', 'a'],
        ['a', 'a'],
      ],
      header_rows: 0,
      spans: [{ row: 0, col: 0, row_span: 2, col_span: 1 }],
    };
    expect(removeRow(table, 0).spans).toBeNull();
  });

  it('keeps the last row', () => {
    const table = { rows: [['a']], header_rows: 1 };
    expect(removeRow(table, 0)).toBe(table);
  });
});

describe('removeColumn', () => {
  it('shrinks a span the column crosses', () => {
    const next = removeColumn(MERGED, 1);
    expect(next.rows[0]).toEqual(['구분', '값']);
    expect(next.spans).toEqual([{ row: 1, col: 0, row_span: 2, col_span: 1 }]);
  });

  it('keeps a span whose first column goes', () => {
    const table = removeColumn(
      { ...MERGED, spans: [{ row: 0, col: 0, row_span: 1, col_span: 3 }] },
      0,
    );
    expect(table.spans).toEqual([{ row: 0, col: 0, row_span: 1, col_span: 2 }]);
  });

  it('moves the spans to the right left', () => {
    const table = removeColumn(
      { ...MERGED, spans: [{ row: 1, col: 1, row_span: 2, col_span: 2 }] },
      0,
    );
    expect(table.spans).toEqual([{ row: 1, col: 0, row_span: 2, col_span: 2 }]);
  });

  it('keeps the last column', () => {
    const table = { rows: [['a'], ['b']], header_rows: 1 };
    expect(removeColumn(table, 0)).toBe(table);
  });
});

describe('insertRow', () => {
  it('grows a span it falls inside and repeats its text', () => {
    const next = insertRow(MERGED, 2);
    expect(next.rows[2]).toEqual(['A', '', '']);
    expect(next.spans?.[1]).toEqual({ row: 1, col: 0, row_span: 3, col_span: 1 });
  });

  it('leaves a span at its outer edge alone and moves the ones below', () => {
    const next = insertRow(MERGED, 1);
    expect(next.rows[1]).toEqual(['', '', '']);
    expect(next.spans).toEqual([
      { row: 0, col: 0, row_span: 1, col_span: 2 },
      { row: 2, col: 0, row_span: 2, col_span: 1 },
    ]);
    expect(next.header_rows).toBe(1);
  });

  it('adds a header row inside the header', () => {
    expect(insertRow(MERGED, 0).header_rows).toBe(2);
  });
});

describe('insertColumn', () => {
  it('grows a span it falls inside and repeats its text', () => {
    const next = insertColumn(MERGED, 1);
    expect(next.rows[0]).toEqual(['구분', '구분', '구분', '값']);
    expect(next.rows[1]).toEqual(['A', '', 'x', '1']);
    expect(next.spans?.[0]).toEqual({ row: 0, col: 0, row_span: 1, col_span: 3 });
    expect(next.spans?.[1]).toEqual({ row: 1, col: 0, row_span: 2, col_span: 1 });
  });

  it('adds an empty column at the right edge', () => {
    const next = insertColumn(MERGED, 3);
    expect(next.rows[0]).toEqual(['구분', '구분', '값', '']);
    expect(next.spans).toEqual(MERGED.spans);
  });
});

describe('editableStemTables', () => {
  it('opens a structured entry as it is', () => {
    const [table] = editableStemTables(GFM, [MERGED]);
    expect(table?.cells).toEqual(MERGED);
    expect(table?.fellBack).toBe(false);
  });

  it('parses a pipe block without cells into an editable table', () => {
    const [table] = editableStemTables('문장\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', null);
    expect(table?.cells).toEqual({
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
      header_rows: 1,
      spans: null,
    });
    expect(table?.fellBack).toBe(false);
  });

  it('says so when a hand edit left the block without its merged cells', () => {
    const [table] = editableStemTables(GFM.replace('| B |', '| C |'), [MERGED]);
    expect(table?.cells.spans).toBeNull();
    expect(table?.cells.rows[3]?.[0]).toBe('C');
    expect(table?.fellBack).toBe(true);
  });

  it('has no tables for a stem without a pipe block', () => {
    expect(editableStemTables('그냥 글자 | 입니다', null)).toEqual([]);
  });
});

describe('applyTableEdit', () => {
  const STEM = `앞 문장\n\n${GFM}\n\n가운데\n\n| c |\n| --- |\n| 1 |\n\n뒤 문장`;

  it('rewrites only that block of the stem and keeps the rest', () => {
    const next = setCell(MERGED, 1, 0, 'C');
    const out = applyTableEdit(STEM, [MERGED, null], 0, next);
    expect(out.stem).toBe(
      `앞 문장\n\n${tableGfm(next)}\n\n가운데\n\n| c |\n| --- |\n| 1 |\n\n뒤 문장`,
    );
    expect(out.stemTables).toEqual([next, null]);
    expect(alignedStemTables(out.stem, out.stemTables)).toEqual([next, null]);
  });

  it('turns a parsed block into an entry, leaving untouched blocks null', () => {
    const [, second] = editableStemTables(STEM, null);
    const next = insertRow(second?.cells as StemCells, 1);
    const out = applyTableEdit(STEM, null, 1, next);
    expect(out.stemTables?.[0]).toBeNull();
    expect(out.stemTables?.[1]).toEqual(next);
    expect(out.stem).toContain('| c |\n| --- |\n|  |\n| 1 |');
  });

  it('keeps the regenerated block lined up after structural edits', () => {
    const next = insertColumn(removeRow(MERGED, 2), 1);
    const out = applyTableEdit(GFM, [MERGED], 0, next);
    expect(alignedStemTables(out.stem, out.stemTables)).toEqual([next]);
  });
});

describe('cellLabel', () => {
  it('names a plain cell by its position', () => {
    expect(cellLabel(0, { row: 1, col: 2 })).toBe('표 1 2행 3열');
  });

  it('names a merged cell by its range', () => {
    expect(cellLabel(1, { row: 1, col: 0, rowSpan: 2 })).toBe('표 2 2–3행 1열 병합');
    expect(cellLabel(0, { row: 0, col: 0, colSpan: 2 })).toBe('표 1 1행 1–2열 병합');
  });
});
