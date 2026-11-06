// @vitest-environment jsdom
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GroupedResults } from '../src/components/questions/viewer/grouped-results';
import { resultMark } from '../src/components/questions/viewer/result-groups';
import type { RunResultItem } from '../src/lib/questions/practice-runs';

const base: RunResultItem = {
  position: 1,
  question_id: 'q',
  available: true,
  question_type: 'MCQ',
  chapter_id: 'c',
  chapter_number: 1,
  chapter_title: '물',
  question_number: 3,
  preview: '발문 앞부분',
  result: 'correct',
};

it('UX12-RESULTTABLE-AC01 draws a named table of numbers and marks without the stem', () => {
  render(<GroupedResults source="bank" items={[base]} onSelect={vi.fn()} />);
  const table = screen.getByRole('table', { name: '1장 물' });
  expect(within(table).getByRole('rowheader')).toHaveTextContent('3번');
  expect(within(table).getByRole('cell')).toHaveTextContent('O');
  expect(screen.queryByText(/발문/)).toBeNull();
});

it('UX12-RESULTTABLE-AC02 marks every result in text and names each column', () => {
  const mark = (item: Partial<RunResultItem>) => resultMark({ ...base, ...item });
  expect(mark({ result: 'correct' })).toMatchObject({ mark: 'O', word: '맞음' });
  expect(mark({ result: 'incorrect' })).toMatchObject({ mark: 'X', word: '틀림' });
  expect(mark({ result: 'pending' })).toMatchObject({ mark: '대기', word: '채점 대기' });
  expect(mark({ result: 'skipped' })).toMatchObject({ mark: '–', word: '건너뜀' });
  expect(mark({ result: 'reset' })).toMatchObject({ mark: '초기화', word: '초기화됨' });
  expect(mark({ result: null })).toMatchObject({ mark: '–', word: '아직 풀지 않음' });
  expect(mark({ available: false })).toMatchObject({
    mark: '불가',
    word: '더 이상 풀 수 없는 문제',
  });

  render(<GroupedResults source="bank" items={[base]} onSelect={vi.fn()} />);
  expect(screen.getByRole('button', { name: '3번 맞음, 문제로 이동' })).toBeVisible();
});

it('UX12-RESULTTABLE-AC05 keeps a mock label and explains 불가 once per chapter', () => {
  render(
    <GroupedResults
      source="mock"
      items={[
        { ...base, position: 7, available: false },
        { ...base, position: 8, available: false },
        { ...base, position: 9, chapter_id: 'd', chapter_title: '불' },
      ]}
      onSelect={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', { name: '문제 8 더 이상 풀 수 없는 문제, 문제로 이동' }),
  ).toBeVisible();
  expect(screen.getAllByText('불가: 더 이상 풀 수 없는 문제')).toHaveLength(1);
});
