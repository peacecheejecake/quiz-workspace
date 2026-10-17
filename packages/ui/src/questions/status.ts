// Pure question study-state logic shared by the heatmap components and the web app
// (docs/questions.md §2, §3.2, §7). No React, no DOM: safe in Server Components and tests.
import { questionStatuses, type QuestionStatus } from '@quiz/design-tokens';

export type QuestionDotStatus = QuestionStatus;
export type QuestionType = 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
export type LastGradedResult = 'correct' | 'incorrect' | null;

/** The five display states, in legend/summary order. */
export const QUESTION_DOT_STATUSES: readonly QuestionDotStatus[] = questionStatuses;

export interface UserStudyState {
  firstViewedAt: string | null;
  lastGradedResult: LastGradedResult;
  needsRetry: boolean;
  isFavorite: boolean;
}

/**
 * Display status of a question for the current user (docs/questions.md §2.1). Priority:
 * retry > incorrect > correct > viewed > unseen. Favorite never affects the status (it only
 * changes the marker shape); a pending (ungraded) submission is not a graded result.
 */
export function deriveDotStatus(s: UserStudyState): QuestionDotStatus {
  if (s.needsRetry) return 'retry';
  if (s.lastGradedResult === 'incorrect') return 'incorrect';
  if (s.lastGradedResult === 'correct') return 'correct';
  if (s.firstViewedAt) return 'viewed';
  return 'unseen';
}

export type QuestionStatusCounts = Record<QuestionDotStatus, number> & {
  /** Number of questions (sum of the five mutually exclusive status counts). */
  total: number;
  /** Favorites, counted independently: it overlaps the status counts. */
  favorite: number;
};

/**
 * Header counts (docs/questions.md §7): each question is counted under exactly one status
 * (retry wins via `deriveDotStatus`), favorites are a separate overlapping count.
 */
export function summarizeStatuses(
  items: Iterable<{ status: QuestionDotStatus; isFavorite: boolean }>,
): QuestionStatusCounts {
  const counts: QuestionStatusCounts = {
    total: 0,
    favorite: 0,
    unseen: 0,
    viewed: 0,
    incorrect: 0,
    correct: 0,
    retry: 0,
  };
  for (const item of items) {
    counts.total += 1;
    counts[item.status] += 1;
    if (item.isFavorite) counts.favorite += 1;
  }
  return counts;
}

/** Short Korean status names used by the legend, summary chips and preview. */
export const questionStatusLabels: Record<QuestionDotStatus, string> = {
  unseen: '미열람',
  viewed: '열람',
  incorrect: '오답',
  correct: '정답',
  retry: '다시 풀기',
};

export const questionTypeLabels: Record<QuestionType, string> = {
  MCQ: '객관식',
  SHORT_ANSWER: '단답형',
  ESSAY: '서술형',
};

export interface QuestionLabelInput {
  questionNumber: string;
  questionType: QuestionType;
  status: QuestionDotStatus;
  isFavorite: boolean;
  /** Chapter number shown as `3장`; when absent the chapter title is used instead. */
  chapterNumber?: number | string;
  chapterTitle: string;
  /** Last graded result; lets a retry label still say what the last result was. */
  lastGradedResult?: LastGradedResult;
  /** Defaults to `status === 'retry'`. */
  needsRetry?: boolean;
  /** An essay/short answer submission is waiting for grading (shown as `채점 대기`). */
  isPendingGrading?: boolean;
}

/** `3장 12번 문제` (or `<chapter title> 12번 문제` without a chapter number). */
export function questionTitle({
  chapterNumber,
  chapterTitle,
  questionNumber,
}: Pick<QuestionLabelInput, 'chapterNumber' | 'chapterTitle' | 'questionNumber'>): string {
  const chapter =
    chapterNumber !== undefined && chapterNumber !== '' ? `${chapterNumber}장` : chapterTitle;
  return `${chapter} ${questionNumber}번 문제`;
}

/** Status phrases without the title/type, e.g. `마지막 결과 오답, 다시 풀기 표시됨`. */
export function questionStatusPhrases(input: QuestionLabelInput): string[] {
  const needsRetry = input.needsRetry ?? input.status === 'retry';
  const graded =
    input.status === 'incorrect' || input.status === 'correct'
      ? input.status
      : (input.lastGradedResult ?? null);
  const phrases: string[] = [];
  if (graded) phrases.push(`마지막 결과 ${questionStatusLabels[graded]}`);
  else if (input.status === 'unseen') phrases.push('아직 보지 않음');
  else if (input.status === 'viewed') phrases.push('열람함, 채점 결과 없음');
  if (needsRetry) phrases.push('다시 풀기 표시됨');
  if (input.isPendingGrading) phrases.push('채점 대기');
  if (input.isFavorite) phrases.push('즐겨찾기');
  return phrases;
}

/**
 * Accessible name of a heatmap dot (docs/questions.md §3.2), e.g.
 * `3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기`.
 */
export function questionDotLabel(input: QuestionLabelInput): string {
  return [
    questionTitle(input),
    questionTypeLabels[input.questionType],
    ...questionStatusPhrases(input),
  ].join(', ');
}
