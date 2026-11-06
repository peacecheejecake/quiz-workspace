// @vitest-environment jsdom
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { GroupedResults } from '../src/components/questions/viewer/grouped-results';
import type { RunResultItem } from '../src/lib/questions/practice-runs';

it('UX10-PLAY-AC05 names O and X, preserves pending and opens the run position', async () => {
  const base: RunResultItem = {
    position: 1,
    question_id: 'q',
    available: true,
    question_type: 'MCQ',
    chapter_id: 'c',
    chapter_number: 1,
    chapter_title: '물',
    question_number: 2,
    preview: '발문',
    result: 'correct',
  };
  const select = vi.fn();
  render(
    <GroupedResults source="bank"
      items={[
        base,
        { ...base, position: 2, result: 'incorrect' },
        { ...base, position: 3, result: 'pending' },
        { ...base, position: 4, available: false },
      ]}
      onSelect={select}
    />,
  );
  expect(screen.getByLabelText('정답')).toHaveTextContent('O');
  expect(screen.getByLabelText('오답')).toHaveTextContent('X');
  expect(screen.getByText('채점 대기')).toBeVisible();
  expect(screen.getAllByText('더 이상 풀 수 없는 문제').length).toBeGreaterThan(0);
  await userEvent.click(screen.getByLabelText('오답'));
  expect(select).toHaveBeenCalledWith(2);
});
