// @vitest-environment jsdom
// QTABLE-01: pipe tables in a stem and option tables. The Python side reads the same
// tests/fixtures/question-tables.json (packages/core/tests/test_question_tables.py).
import './dom-setup';
import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OptionCells, OptionGridHead } from '../src/components/questions/stem/option-grid';
import { StemBlocks, StemText } from '../src/components/questions/stem/stem-text';
import { stemItems } from '../src/lib/questions/stem-items';
import { optionGrid, stemSegments } from '../src/lib/questions/stem-table';

const cases = JSON.parse(readFileSync('../../tests/fixtures/question-tables.json', 'utf8')) as {
  name: string;
  stem: string;
  normalized: string;
  segments: [boolean, string][];
}[];

const TABLE = '| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 |';
const texts = (...values: string[]) => values.map((text) => ({ text }));

describe('stemSegments', () => {
  it.each(cases)('matches the shared matrix: $name', ({ stem, normalized, segments }) => {
    const read = (text: string) => stemSegments(text).map((s) => [s.kind === 'table', s.text]);
    expect(read(stem)).toEqual(segments);
    expect(read(normalized).filter(([table]) => table)).toEqual(
      segments.filter(([table]) => table),
    );
  });

  it('unescapes cells and turns <br> into a line break', () => {
    const [segment] = stemSegments('| a\\|b | c\\\\ |\n| --- | --- |\n| 1<br>2 | 3 |');
    expect(segment).toMatchObject({
      kind: 'table',
      table: { header: ['a|b', 'c\\'], rows: [['1\n2', '3']] },
    });
  });
});

describe('stemItems with a table', () => {
  it('never reads labels in cells', () => {
    const stem = '옳은 것은?\n\n| (가) x | (나) y |\n| --- | --- |\n| 1 | 2 |';
    expect(stemItems(stem)).toBeNull();
  });
});

describe('StemText and StemBlocks', () => {
  it('shows the table between its sentences with column headers', () => {
    const { container } = render(
      <StemText stem={`표를 보시오. ( )\n\n${TABLE}\n\n옳은 것은?`} className="host" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('host')).toBe(true);
    expect([...root.children].map((el) => el.tagName)).toEqual(['P', 'DIV', 'P']);
    expect(root.children[0]?.textContent).toBe('표를 보시오.');
    const region = screen.getByRole('region', { name: '표' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['단계', '작용']);
    expect(within(region).getByRole('cell', { name: '결합' })).toBeTruthy();
  });

  it('finds items around a table, not inside it', () => {
    render(<StemBlocks stem={`옳은 것은? (가) 갑 (나) 을\n\n| ㄱ. a | ㄴ. b |\n| --- | --- |`} />);
    expect(
      within(screen.getByRole('list', { name: '제시 항목' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['(가) 갑', '(나) 을']);
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it.each([
    ['a row with another cell count', '| 단계 | 작용 |\n| --- | --- |\n| 응집 |'],
    ['no delimiter row', '| 단계 | 작용 |\n| 응집 | 결합 |'],
  ])('falls back to text for %s', (_name, table) => {
    const { container } = render(<StemText stem={`표를 보시오.\n\n${table}`} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.textContent).toContain('응집');
  });

  it('does not build markup from a cell', () => {
    render(<StemBlocks stem={'| <img src=x> |\n| --- |\n| <b>굵게</b> |'} />);
    expect(screen.getByRole('table').querySelector('img, b')).toBeNull();
    expect(screen.getByRole('cell').textContent).toBe('<b>굵게</b>');
  });
});

describe('optionGrid', () => {
  const options = texts('가 | 하나', '나 | 둘');

  it('moves a header glued to the question sentence up to the columns', () => {
    expect(optionGrid('옳은 것은? ( ) 구분 | 내용', options)).toEqual({
      columns: 2,
      rows: [
        ['가', '하나'],
        ['나', '둘'],
      ],
      headers: ['구분', '내용'],
      stem: '옳은 것은? ( )',
    });
  });

  it('moves a header on its own line and drops the label column of a wider header', () => {
    expect(optionGrid('옳은 것은?\n구분 | 내용', options)).toMatchObject({
      headers: ['구분', '내용'],
      stem: '옳은 것은?',
    });
    expect(optionGrid('옳은 것은? 번호 | 구분 | 내용', options)).toMatchObject({
      headers: ['구분', '내용'],
      stem: '옳은 것은?',
    });
  });

  it('leaves the stem alone without a header it can tell from the sentence', () => {
    const stem = '다음 중 옳은 것은?';
    expect(optionGrid(stem, options)).toMatchObject({ headers: null, stem });
    expect(optionGrid('구분 | 내용', options)).toMatchObject({ headers: null });
    expect(optionGrid(`표를 보시오.\n\n${TABLE}`, options)).toMatchObject({ headers: null });
  });

  it('keeps each row whole in any order, so shuffling is safe', () => {
    const shuffled = texts('나 | 둘', '가 | 하나');
    expect(optionGrid('옳은 것은? 구분 | 내용', shuffled)?.rows).toEqual([
      ['나', '둘'],
      ['가', '하나'],
    ]);
  });

  it.each([
    ['uneven cells', texts('가 | 하나', '나')],
    ['an empty cell', texts('가 | 하나', '나 |  | 셋')],
    ['one cell', texts('가', '나')],
    ['one option', texts('가 | 하나')],
  ])('is null for %s', (_name, given) => {
    expect(optionGrid('옳은 것은?', given)).toBeNull();
  });
});

describe('OptionCells', () => {
  it('repeats the header in every cell and hides the visible header', () => {
    const grid = optionGrid('옳은 것은? 구분 | 내용', texts('가 | 하나', '나 | 둘'));
    if (!grid) throw new Error('grid');
    const { container } = render(
      <div>
        <OptionGridHead grid={grid} numbered />
        <label>
          <input type="radio" />
          <OptionCells grid={grid} index={1} number="2." />
        </label>
      </div>,
    );
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('구분내용');
    expect(screen.getByRole('radio', { name: /구분:\s*나 내용:\s*둘/ })).toBeTruthy();
  });
});
