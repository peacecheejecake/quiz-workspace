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
    expect(
      filtersFromRange({ ...range, filters: { favorite: true, types: ['MCQ'] } }).status,
    ).toEqual(QUESTION_DOT_STATUSES);
    expect(
      filtersFromRange({ ...range, filters: { status: null, types: ['ESSAY'] } }).status,
    ).toEqual(QUESTION_DOT_STATUSES);
    expect(filtersFromRange({ ...range, filters: { status: [] } }).status).toEqual([]);
    expect(filtersFromRange({ ...range, filters: { types: ['ESSAY'] } }).types).toEqual(['ESSAY']);
    expect(filtersFromRange({ ...range, filters: {} }).types).toEqual([
      'MCQ',
      'SHORT_ANSWER',
      'ESSAY',
    ]);
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
    await api.rangeQuestions({
      status: [],
      favorite: true,
      retry: false,
      types: ['MCQ', 'SHORT_ANSWER', 'ESSAY'],
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.searchParams.getAll('status')).toEqual(['none']);
    expect(url.searchParams.get('favorite')).toBe('true');
    expect(url.searchParams.has('type')).toBe(false);
  });

  it('reads no question, without asking the API, when no type is checked', async () => {
    const fetcher = vi.fn();
    const api = createPracticeRunApi('workspace', fetcher);
    const result = await api.rangeQuestions({
      status: QUESTION_DOT_STATUSES,
      favorite: false,
      retry: false,
      types: [],
    });
    expect(result).toEqual({ ok: true, data: { chapters: [], items: [] } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('repeats type for each chosen question type', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ chapters: [], items: [] }), { status: 200 }),
    );
    const api = createPracticeRunApi('workspace', fetcher);
    await api.rangeQuestions({
      status: QUESTION_DOT_STATUSES,
      favorite: false,
      retry: false,
      types: ['MCQ', 'ESSAY'],
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.searchParams.getAll('type')).toEqual(['MCQ', 'ESSAY']);
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
    expect(screen.queryByRole('button', { name: '상태 필터' })).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: '상태 필터' });
    const statuses = ['안 푼 문제', '본 문제', '틀린 문제', '맞힌 문제', '다시 풀기'];
    for (const label of statuses) {
      const chip = within(group).getByRole('button', { name: new RegExp(`^${label}$`) });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
      await user.click(chip);
    }
    expect(screen.getByText('{"status":[]}')).toBeInTheDocument();
  });

  it('shows a labelled swatch on each status chip', () => {
    render(
      <QuestionRangePicker
        groups={[]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        filters={EMPTY_RANGE_FILTERS}
        onFiltersChange={vi.fn()}
      />,
    );
    const group = screen.getByRole('group', { name: '상태 필터' });
    expect(group.querySelectorAll('span[data-status][aria-hidden="true"]')).toHaveLength(5);
    expect(within(group).getByRole('button', { name: '틀린 문제' })).toBeInTheDocument();
  });

  it('checks every type by default, disables types without questions and treats none as no question', async () => {
    const q = (id: string, type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY') => ({
      id,
      number: id,
      preview: id,
      type,
    });
    const groups = [{ key: 'c', title: '1장', questions: [q('a', 'MCQ'), q('b', 'ESSAY')] }];
    function Picker() {
      const [filters, setFilters] = useState(EMPTY_RANGE_FILTERS);
      return (
        <>
          <QuestionRangePicker
            groups={groups}
            selected={new Set()}
            onSelectedChange={vi.fn()}
            filters={filters}
            onFiltersChange={setFilters}
          />
          <output>{JSON.stringify(rangeApiFilters(filters) ?? null)}</output>
        </>
      );
    }
    render(<Picker />);
    const user = userEvent.setup();
    expect(screen.queryByRole('combobox', { name: '유형' })).not.toBeInTheDocument();
    expect(screen.queryByText(/모든 유형을 보여 줍니다/)).not.toBeInTheDocument();
    const types = screen.getByRole('group', { name: '유형' });
    const box = (name: string) => within(types).getByRole('checkbox', { name });
    expect(box('객관식')).toBeChecked();
    expect(box('서술형')).toBeChecked();
    // No short-answer question: disabled, unchecked, not counted.
    expect(box('단답형')).toBeDisabled();
    expect(box('단답형')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: '필터 초기화' })).not.toBeInTheDocument();
    await user.click(box('서술형'));
    // Unchecking one does not disable its sibling.
    expect(box('객관식')).toBeEnabled();
    expect(screen.getByText('{"types":["MCQ"]}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '필터 초기화' })).toBeInTheDocument();
    await user.click(box('서술형'));
    expect(screen.getByText('null')).toBeInTheDocument();
    await user.click(box('객관식'));
    await user.click(box('서술형'));
    expect(screen.getByText('{"types":[]}')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '필터 초기화' }));
    expect(box('객관식')).toBeChecked();
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('puts the selected count on the 전체 선택 row', () => {
    const groups = [
      {
        key: 'c',
        title: '1장',
        questions: [{ id: 'a', number: 'a', preview: 'a', type: 'MCQ' as const }],
      },
    ];
    render(
      <QuestionRangePicker groups={groups} selected={new Set(['a'])} onSelectedChange={vi.fn()} />,
    );
    const row = screen
      .getByRole('checkbox', { name: '전체 선택' })
      .closest('div[class*="selectRow"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('선택 1문제')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });
});
