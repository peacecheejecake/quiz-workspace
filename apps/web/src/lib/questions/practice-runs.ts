// QVIEW-01 range practice (`QuestionViewer` sequence mode, docs/screens/question-viewer.md,
// questions.md §12): the URL state of the run panel on the workspace home and the run's labels.
// Pure, so it is unit-tested; the API resolves ranges and grades (QVIEW-01-C01–C05).
//   ?practice=new&source=bank|mock[&mock=<id>]   the range step
//   ?practice=<run id>&i=<position>              a position of the run (1-based)
//   ?practice=<run id>&view=results              the results step
// `시작`, `결과 보기` and `처음부터 다시` replace the history entry (user decision 2026-11-02, QOV-01-AC14);
// moving between positions pushes one, like the practice panel's previous/next.
import type { Schemas } from '@quiz/api-client';

export const RUN_PARAM = 'practice';
export const RUN_SOURCE_PARAM = 'source';
export const RUN_MOCK_PARAM = 'mock';
export const RUN_POSITION_PARAM = 'i';
export const RUN_VIEW_PARAM = 'view';
const NEW_RUN = 'new';
const RESULTS_VIEW = 'results';

/** Mirrors the API: a run holds at most this many questions (QVIEW-01-C01). */
export const PRACTICE_RUN_MAX = 5_000;
/** Mirrors the API's results page limit (QVIEW-01-C02). */
export const RUN_RESULTS_PAGE = 200;

export type RunSource = 'bank' | 'mock';
export type PracticeRun = Schemas['PracticeRun'];
export type RunItem = Schemas['RunItem'];
export type RunResults = Schemas['RunResults'];
export type RunResultItem = Schemas['RunResultItem'];
export type RunSummary = Schemas['RunSummary'];
export type RunRange = Schemas['QuestionRange'];
export type RunRangeFilters = Schemas['RangeFilters'];

export type RunUrlState =
  | { readonly step: 'picker'; readonly source: RunSource; readonly mockExamId: string | null }
  | { readonly step: 'solve'; readonly runId: string; readonly position: number }
  | { readonly step: 'results'; readonly runId: string }
  /** `?practice=` with a value that names no run: "풀이를 찾을 수 없습니다." */
  | { readonly step: 'missing' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run panel's state in `params`; null when it is closed. */
export function parseRunState(params: URLSearchParams): RunUrlState | null {
  const value = params.get(RUN_PARAM);
  if (!value) return null;
  if (value === NEW_RUN) {
    const source: RunSource = params.get(RUN_SOURCE_PARAM) === 'mock' ? 'mock' : 'bank';
    const mock = params.get(RUN_MOCK_PARAM);
    return {
      step: 'picker',
      source,
      mockExamId: source === 'mock' && mock && UUID.test(mock) ? mock.toLowerCase() : null,
    };
  }
  if (!UUID.test(value)) return { step: 'missing' };
  const runId = value.toLowerCase();
  if (params.get(RUN_VIEW_PARAM) === RESULTS_VIEW) return { step: 'results', runId };
  const raw = params.get(RUN_POSITION_PARAM);
  const position = raw && /^\d{1,4}$/.test(raw) ? Number(raw) : 1;
  return {
    step: 'solve',
    runId,
    position: Math.min(PRACTICE_RUN_MAX, Math.max(1, position)),
  };
}

function patch(search: string, values: Readonly<Record<string, string | null>>): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

const CLEARED = {
  [RUN_PARAM]: null,
  [RUN_SOURCE_PARAM]: null,
  [RUN_POSITION_PARAM]: null,
  [RUN_VIEW_PARAM]: null,
} as const;

/** `search` with the run panel's keys set to `state` (null: closed). */
export function withRunState(search: string, state: RunUrlState | null): string {
  const mockOwned = new URLSearchParams(search).get(RUN_SOURCE_PARAM) === 'mock';
  // `mock` belongs to the run panel only while it starts a mock exam run.
  const base = { ...CLEARED, ...(mockOwned ? { [RUN_MOCK_PARAM]: null } : {}) };
  if (state === null || state.step === 'missing') return patch(search, base);
  if (state.step === 'picker') {
    return patch(search, {
      ...base,
      [RUN_PARAM]: NEW_RUN,
      [RUN_SOURCE_PARAM]: state.source,
      ...(state.source === 'mock' && state.mockExamId
        ? { [RUN_MOCK_PARAM]: state.mockExamId }
        : {}),
    });
  }
  if (state.step === 'results') {
    return patch(search, { ...base, [RUN_PARAM]: state.runId, [RUN_VIEW_PARAM]: RESULTS_VIEW });
  }
  return patch(search, {
    ...base,
    [RUN_PARAM]: state.runId,
    [RUN_POSITION_PARAM]: String(state.position),
  });
}

/** "n문제 중 k번째": the progress bar's value text and its live announcement. */
export function progressText(position: number, total: number): string {
  return `${total}문제 중 ${position}번째`;
}

/** The question's number as the Heatmap shows it: "3장 12번" (mock exams: "문제 k"). */
export function positionLabel(
  item: Pick<RunItem, 'chapter_number' | 'chapter_title' | 'question_number' | 'position'>,
  source: RunSource,
): string {
  if (source === 'mock' || item.question_number === null) return `문제 ${item.position}`;
  if (item.chapter_number !== null) return `${item.chapter_number}장 ${item.question_number}번`;
  if (item.chapter_title) return `${item.chapter_title} ${item.question_number}번`;
  return `${item.question_number}번`;
}

export type PositionResult = NonNullable<RunResultItem['result']>;

/** The result word of a position in the results step (text, never color alone). */
export const RESULT_WORDS: Readonly<Record<PositionResult, string>> = {
  correct: '맞음',
  incorrect: '틀림',
  pending: '채점 대기',
  skipped: '건너뜀',
};

/** "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w". */
export function summaryText(summary: RunSummary): string {
  return (
    `맞음 ${summary.correct} · 틀림 ${summary.incorrect} · ` +
    `채점 대기 ${summary.pending} · 건너뜀 ${summary.skipped}`
  );
}

/**
 * The range of `처음부터 다시`: the questions of the run that can still be practised, in the run's
 * order (the server orders them again, by the Heatmap or a new seed).
 */
export function restartRange(items: readonly RunResultItem[]): RunRange {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.available && item.question_id) ids.add(item.question_id);
  }
  return { question_ids: [...ids] };
}
