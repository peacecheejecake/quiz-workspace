// @vitest-environment jsdom
import './dom-setup';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QUESTION_DOT_STATUSES } from '@quiz/ui';
import { filtersFromRange } from '../src/components/questions/mock-exams/mock-exam-model';
import { QuestionRangePicker } from '../src/components/questions/viewer/question-range-picker';
import {
  EMPTY_RANGE_FILTERS,
  rangeApiFilters,
} from '../src/components/questions/viewer/range-model';
import { createPracticeRunApi } from '../src/lib/questions/practice-run-client';

const range = { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] };

describe('UX10-HOME range status semantics', () => {
  it('restores omitted statuses for saved favorite/type filters and preserves explicit empty', () => {
    expect(filtersFromRange({ ...range, filters: { favorite: true, type: 'MCQ' } }).status).toEqual(
      QUESTION_DOT_STATUSES,
    );
    expect(filtersFromRange({ ...range, filters: { status: null, type: 'ESSAY' } }).status).toEqual(
      QUESTION_DOT_STATUSES,
    );
    expect(filtersFromRange({ ...range, filters: { status: [] } }).status).toEqual([]);
    expect(rangeApiFilters({ ...EMPTY_RANGE_FILTERS, status: [], favorite: true })).toEqual({
      status: [],
      favorite: true,
    });
  });

  it('sends status=none while loading an explicitly empty selection', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ chapters: [], items: [] }), { status: 200 }),
    );
    const api = createPracticeRunApi('workspace', fetcher);
    await api.rangeQuestions({ status: [], favorite: true, retry: false, type: null });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.searchParams.getAll('status')).toEqual(['none']);
    expect(url.searchParams.get('favorite')).toBe('true');
  });

  it('exposes every selected status and clearing them submits an empty set', async () => {
    function Picker() {
      const [filters, setFilters] = useState(EMPTY_RANGE_FILTERS);
      return (
        <>
          <QuestionRangePicker
            groups={[]}
            selected={new Set()}
            onSelectedChange={vi.fn()}
            filters={filters}
            onFiltersChange={setFilters}
          />
          <output>{JSON.stringify(rangeApiFilters(filters))}</output>
        </>
      );
    }
    render(<Picker />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '상태 필터' }));
    const group = screen.getByRole('group', { name: '상태 필터' });
    const statuses = ['안 푼 문제', '본 문제', '틀린 문제', '맞힌 문제', '다시 풀기'];
    for (const label of statuses) {
      const chip = within(group).getByRole('button', { name: new RegExp(`^${label}$`) });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
      await user.click(chip);
    }
    expect(screen.getByText('{"status":[]}')).toBeInTheDocument();
  });
});
