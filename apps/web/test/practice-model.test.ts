// QPLAY-01 practice model: answers are stable option ids (never positions), a pending result is
// not a grade, previous/next follow the heatmap order; QOV-01 dot state after a submission.
import { describe, expect, it } from 'vitest';
import { gradedPatch } from '../src/components/questions/overview/overview-model';
import {
  canSubmit,
  EMPTY_ANSWER,
  finalResult,
  neighbors,
  optionMark,
  resultMessage,
  submitBody,
  toggleOption,
} from '../src/components/questions/practice/practice-model';
import type { OverviewItem } from '../src/lib/questions/overview-data';

const single = {
  question_type: 'MCQ' as const,
  is_multi_answer: false,
  displayed_option_ids: ['c', 'a', 'b'],
};
const multi = { ...single, is_multi_answer: true };
const essay = { question_type: 'ESSAY' as const, is_multi_answer: false, displayed_option_ids: [] };

describe('toggleOption', () => {
  it('a single answer replaces the selection', () => {
    expect(toggleOption(single, ['c'], 'a', true)).toEqual(['a']);
    expect(toggleOption(single, ['a'], 'a', false)).toEqual([]);
  });

  it('a multi answer toggles and keeps the displayed order', () => {
    expect(toggleOption(multi, ['b'], 'c', true)).toEqual(['c', 'b']);
    expect(toggleOption(multi, ['c', 'b'], 'c', false)).toEqual(['b']);
  });

  it('ignores ids that are not options of the session', () => {
    expect(toggleOption(multi, ['a'], 'zzz', true)).toEqual(['a']);
  });
});

describe('canSubmit / submitBody', () => {
  it('needs exactly one option for a single answer and at least one for multi', () => {
    expect(canSubmit(single, EMPTY_ANSWER)).toBe(false);
    expect(canSubmit(single, { selected: ['a'], text: '' })).toBe(true);
    expect(canSubmit(single, { selected: ['a', 'b'], text: '' })).toBe(false);
    expect(canSubmit(multi, { selected: ['a', 'b'], text: '' })).toBe(true);
    expect(canSubmit(multi, { selected: ['unknown'], text: '' })).toBe(false);
  });

  it('needs non-blank text for short answers and essays', () => {
    expect(canSubmit(essay, { selected: [], text: '   ' })).toBe(false);
    expect(canSubmit(essay, { selected: [], text: ' 증발 ' })).toBe(true);
    expect(canSubmit(essay, { selected: [], text: 'x'.repeat(20_001) })).toBe(false);
  });

  it('submits option ids of this session only, never positions', () => {
    expect(submitBody(multi, { selected: ['b', 'zzz', 'c'], text: 'ignored' })).toEqual({
      selected_option_ids: ['c', 'b'],
    });
    expect(submitBody(essay, { selected: ['a'], text: ' 답 ' })).toEqual({ answer_text: ' 답 ' });
  });
});

describe('result wording', () => {
  it('keeps a pending submission pending until the user grades it', () => {
    expect(finalResult('pending', null)).toBe('pending');
    expect(finalResult('pending', 'incorrect')).toBe('incorrect');
    expect(finalResult('correct', 'incorrect')).toBe('correct');
    expect(resultMessage('pending', null)).toMatch(/채점 대기/);
    expect(resultMessage('pending', null)).not.toMatch(/정답|오답/);
    expect(resultMessage('pending', 'correct')).toMatch(/정답/);
    expect(resultMessage('correct', null)).toBe('정답입니다.');
    expect(resultMessage('incorrect', null)).toBe('오답입니다.');
  });

  it('marks revealed options in text, not by color alone', () => {
    expect(optionMark('a', ['a'], ['a'])).toBe('정답 · 내 선택');
    expect(optionMark('a', ['a'], [])).toBe('정답');
    expect(optionMark('b', ['a'], ['b'])).toBe('내 선택');
    expect(optionMark('b', ['a'], [])).toBeUndefined();
  });
});

describe('neighbors', () => {
  it('follows the heatmap order and stops at both ends', () => {
    expect(neighbors(['1', '2', '3'], '2')).toEqual({ previous: '1', next: '3' });
    expect(neighbors(['1', '2', '3'], '1')).toEqual({ previous: null, next: '2' });
    expect(neighbors(['1', '2', '3'], '3')).toEqual({ previous: '2', next: null });
  });

  it('has none for a question outside the list (or none open)', () => {
    expect(neighbors(['1', '2'], '9')).toEqual({ previous: null, next: null });
    expect(neighbors(['1', '2'], null)).toEqual({ previous: null, next: null });
  });
});

describe('gradedPatch', () => {
  const item = {
    question_id: 'q',
    chapter_id: null,
    question_number: 1,
    question_type: 'MCQ',
    status: 'viewed',
    is_favorite: false,
    needs_retry: false,
    last_graded_result: null,
    is_pending_grading: false,
    preview: '',
  } as OverviewItem;

  it('a graded result becomes the dot status', () => {
    expect(gradedPatch(item, 'correct')).toEqual({
      last_graded_result: 'correct',
      is_pending_grading: false,
      status: 'correct',
    });
  });

  it('retry still wins the color after a correct answer', () => {
    expect(gradedPatch({ ...item, needs_retry: true }, 'correct').status).toBe('retry');
  });

  it('a pending submission keeps the previous graded result', () => {
    expect(
      gradedPatch({ ...item, status: 'incorrect', last_graded_result: 'incorrect' }, 'pending'),
    ).toEqual({ last_graded_result: 'incorrect', is_pending_grading: true, status: 'incorrect' });
  });
});
