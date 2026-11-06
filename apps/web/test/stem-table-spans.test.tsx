// @vitest-environment jsdom
// UX12-STEMTABLE: merged cells in a stem and the table editor in QuestionContentFields.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { QuestionContentFields } from '@/components/questions/question-content-fields';
import { StemBlocks, StemText } from '@/components/questions/stem/stem-text';
import { emptyForm, contentBody, type QuestionFormValues } from '@/lib/questions/form';
import { changedText } from '@/lib/questions/reextract';
import type { StemCells } from '@/lib/questions/stem-table-edit';

const GFM = '| 구분 | 구분 | 값 |\n| --- | --- | --- |\n| A | x | 1 |\n| A | y | 2 |';
const MERGED: StemCells = {
  rows: [
    ['구분', '구분', '값'],
    ['A', 'x', '1'],
    ['A', 'y', '2'],
  ],
  header_rows: 1,
  spans: [
    { row: 0, col: 0, row_span: 1, col_span: 2 },
    { row: 1, col: 0, row_span: 2, col_span: 1 },
  ],
};

describe('StemBlocks with structured cells', () => {
  it('draws a merged cell once with its spans', () => {
    render(<StemBlocks stem={`옳은 것은?\n\n${GFM}`} stemTables={[MERGED]} />);
    const header = screen.getByRole('columnheader', { name: '구분' });
    expect(header).toHaveAttribute('colspan', '2');
    expect(header).toHaveAttribute('scope', 'col');
    const merged = screen.getByRole('cell', { name: 'A' });
    expect(merged).toHaveAttribute('rowspan', '2');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(within(screen.getAllByRole('row')[2] as HTMLElement).getAllByRole('cell')).toHaveLength(
      2,
    );
  });

  it('keeps the first row as column headers when the parser marked none', () => {
    render(<StemBlocks stem={GFM} stemTables={[{ ...MERGED, header_rows: 0 }]} />);
    expect(screen.getByRole('columnheader', { name: '값' })).toBeInTheDocument();
  });

  it('falls back to GFM without cells', () => {
    render(<StemBlocks stem={GFM} stemTables={null} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(2);
  });

  it('falls back to GFM when the entry count differs from the block count', () => {
    render(<StemBlocks stem={`${GFM}\n\n| c |\n| --- |\n| 1 |`} stemTables={[MERGED]} />);
    expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(2);
  });

  it('falls back for one block whose text no longer matches', () => {
    render(<StemBlocks stem={GFM.replace('| A | y', '| B | y')} stemTables={[MERGED]} />);
    expect(screen.getByRole('cell', { name: 'B' })).not.toHaveAttribute('rowspan');
  });

  it('draws in StemText too', () => {
    render(<StemText stem={GFM} stemTables={[MERGED]} />);
    expect(screen.getByRole('cell', { name: 'A' })).toHaveAttribute('rowspan', '2');
  });
});

function Fields({ initial }: { readonly initial: Partial<QuestionFormValues> }) {
  const [values, setValues] = useState<QuestionFormValues>({
    ...emptyForm(() => 'opt-1'),
    ...initial,
  });
  return (
    <>
      <QuestionContentFields
        values={values}
        errors={{}}
        update={(next) => setValues(next)}
        stemId="stem"
      />
      <output data-testid="body">{JSON.stringify(contentBody(values))}</output>
    </>
  );
}

const body = () =>
  JSON.parse(screen.getByTestId('body').textContent as string) as ReturnType<typeof contentBody>;

describe('the stem table editor', () => {
  it('shows no editor for a stem without a table', () => {
    render(<Fields initial={{ stem: '표가 없는 문제' }} />);
    expect(screen.queryByRole('region', { name: /표 1 편집/ })).not.toBeInTheDocument();
  });

  it('labels every cell and regenerates the GFM from a merged cell', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: GFM, stemTables: [MERGED] }} />);
    const merged = screen.getByRole('textbox', { name: '표 1 2–3행 1열 병합' });
    await user.clear(merged);
    await user.type(merged, 'C');
    expect(body().stem).toContain('| C | x | 1 |\n| C | y | 2 |');
    expect(body().stem_tables?.[0]?.spans).toEqual(MERGED.spans);
    expect(screen.getByRole('textbox', { name: '문제 내용' })).toHaveValue(body().stem);
  });

  it('removes a row from its keyboard menu and shrinks the merged cell', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: GFM, stemTables: [MERGED] }} />);
    screen.getByRole('button', { name: '표 1 3행 메뉴' }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: /이 행 삭제/ }));
    expect(body().stem).not.toContain('| A | y | 2 |');
    expect(body().stem_tables?.[0]?.spans).toEqual([MERGED.spans?.[0]]);
  });

  it('adds a column from its menu', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: GFM, stemTables: [MERGED] }} />);
    await user.click(screen.getByRole('button', { name: '표 1 3열 메뉴' }));
    await user.click(await screen.findByRole('menuitem', { name: /오른쪽에 열 추가/ }));
    expect(body().stem_tables?.[0]?.rows[1]).toEqual(['A', 'x', '1', '']);
  });

  it('cannot remove the last row', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: '| a |\n| --- |' }} />);
    await user.click(screen.getByRole('button', { name: '표 1 1행 메뉴' }));
    expect(await screen.findByRole('menuitem', { name: /이 행 삭제/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('opens a pipe block without cells and leaves it null until it is edited', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: '| a | b |\n| --- | --- |\n| 1 | 2 |' }} />);
    expect(body().stem_tables).toBeNull();
    await user.type(screen.getByRole('textbox', { name: '표 1 2행 2열' }), '3');
    expect(body().stem).toContain('| 1 | 23 |');
    expect(body().stem_tables?.[0]?.rows[1]).toEqual(['1', '23']);
  });

  it('falls back when the pipe block is edited by hand, and says so', async () => {
    const user = userEvent.setup();
    render(<Fields initial={{ stem: GFM, stemTables: [MERGED] }} />);
    await user.type(screen.getByRole('textbox', { name: '문제 내용' }), '{Backspace}9 |');
    expect(screen.getByText(/병합 정보 없이 글자 표로 편집합니다/)).toBeInTheDocument();
    expect(body().stem_tables).toBeNull();
    expect(screen.getByRole('textbox', { name: '표 1 2행 1열' })).toHaveValue('A');
  });
});

describe('a re-extraction', () => {
  it('names merged cells as 표', () => {
    const text = changedText({
      question_id: 'q',
      revision_id: 'r',
      number: 5,
      changed: ['table'],
    });
    expect(text).toBe('이전 문제 5번과 달라진 항목: 표');
  });
});
