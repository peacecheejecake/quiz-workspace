import { describe, expect, it } from 'vitest';
import {
  deriveDotStatus,
  questionDotLabel,
  summarizeStatuses,
  type LastGradedResult,
  type QuestionDotStatus,
  type UserStudyState,
} from '../src';

const VIEWED = '2026-10-01T09:00:00Z';

describe('deriveDotStatus (docs/questions.md §2.1)', () => {
  // Every combination of the three inputs that drive the status; favorite must never matter.
  const rows: [viewed: string | null, last: LastGradedResult, retry: boolean, expected: string][] =
    [
      [null, null, false, 'unseen'],
      [VIEWED, null, false, 'viewed'],
      [VIEWED, 'incorrect', false, 'incorrect'],
      [VIEWED, 'correct', false, 'correct'],
      [null, null, true, 'retry'],
      [VIEWED, null, true, 'retry'],
      [VIEWED, 'incorrect', true, 'retry'],
      // QOV-01-AC05: retry wins over a last correct result.
      [VIEWED, 'correct', true, 'retry'],
      // A graded result implies it was viewed, but the result wins even if the timestamp is absent.
      [null, 'incorrect', false, 'incorrect'],
      [null, 'correct', false, 'correct'],
    ];

  it.each(rows.flatMap((row) => [true, false].map((fav) => [...row, fav] as const)))(
    'viewed=%s last=%s retry=%s → %s (favorite=%s)',
    (firstViewedAt, lastGradedResult, needsRetry, expected, isFavorite) => {
      const state: UserStudyState = { firstViewedAt, lastGradedResult, needsRetry, isFavorite };
      expect(deriveDotStatus(state)).toBe(expected);
    },
  );

  it('clearing retry returns to the previous graded color (QOV-01-AC05)', () => {
    const state: UserStudyState = {
      firstViewedAt: VIEWED,
      lastGradedResult: 'correct',
      needsRetry: true,
      isFavorite: false,
    };
    expect(deriveDotStatus(state)).toBe('retry');
    expect(deriveDotStatus({ ...state, needsRetry: false })).toBe('correct');
  });
});

describe('summarizeStatuses (docs/questions.md §7)', () => {
  it('counts statuses mutually exclusively and favorites as an overlap', () => {
    const items: { status: QuestionDotStatus; isFavorite: boolean }[] = [
      { status: 'unseen', isFavorite: false },
      { status: 'unseen', isFavorite: true },
      { status: 'viewed', isFavorite: false },
      { status: 'incorrect', isFavorite: true },
      { status: 'correct', isFavorite: false },
      { status: 'retry', isFavorite: true },
      { status: 'retry', isFavorite: false },
    ];
    const counts = summarizeStatuses(items);
    expect(counts).toEqual({
      total: 7,
      unseen: 2,
      viewed: 1,
      incorrect: 1,
      correct: 1,
      retry: 2,
      favorite: 3,
    });
    const statusSum =
      counts.unseen + counts.viewed + counts.incorrect + counts.correct + counts.retry;
    expect(statusSum).toBe(counts.total);
  });

  it('a correct + retry question is counted once, under retry', () => {
    const status = deriveDotStatus({
      firstViewedAt: VIEWED,
      lastGradedResult: 'correct',
      needsRetry: true,
      isFavorite: true,
    });
    expect(summarizeStatuses([{ status, isFavorite: true }])).toMatchObject({
      total: 1,
      retry: 1,
      correct: 0,
      favorite: 1,
    });
  });

  it('is all zeros for no questions', () => {
    expect(summarizeStatuses([])).toEqual({
      total: 0,
      unseen: 0,
      viewed: 0,
      incorrect: 0,
      correct: 0,
      retry: 0,
      favorite: 0,
    });
  });
});

describe('questionDotLabel (docs/questions.md §3.2)', () => {
  const base = {
    chapterNumber: 3,
    chapterTitle: '어텐션',
    questionNumber: '12',
    questionType: 'MCQ',
    isFavorite: false,
  } as const;

  it('matches the spec example', () => {
    expect(
      questionDotLabel({
        ...base,
        status: 'retry',
        lastGradedResult: 'incorrect',
        isFavorite: true,
      }),
    ).toBe('3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기');
  });

  it.each([
    ['unseen', '3장 12번 문제, 객관식, 아직 보지 않음'],
    ['viewed', '3장 12번 문제, 객관식, 열람함, 채점 결과 없음'],
    ['incorrect', '3장 12번 문제, 객관식, 마지막 결과 오답'],
    ['correct', '3장 12번 문제, 객관식, 마지막 결과 정답'],
    ['retry', '3장 12번 문제, 객관식, 다시 풀기 표시됨'],
  ] as const)('%s → %s', (status, label) => {
    expect(questionDotLabel({ ...base, status })).toBe(label);
  });

  it('names the type, pending grading and falls back to the chapter title', () => {
    expect(
      questionDotLabel({
        ...base,
        chapterNumber: undefined,
        questionType: 'ESSAY',
        status: 'viewed',
        isPendingGrading: true,
      }),
    ).toBe('어텐션 12번 문제, 서술형, 열람함, 채점 결과 없음, 채점 대기');
    expect(questionDotLabel({ ...base, questionType: 'SHORT_ANSWER', status: 'unseen' })).toMatch(
      /단답형/,
    );
  });
});
