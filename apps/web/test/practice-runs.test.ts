// QVIEW-01 range run helpers: the run panel's URL state and its place among the home's dialogs
// (QOV-01-AC14 rules: a dialog of its own whose steps and positions are not closes), the range a
// selection sends (QVIEW-01-C01: `전체 선택` / whole chapters as `all` / `chapter_ids`), the labels
// and the run API failures.
import { describe, expect, it } from 'vitest';
import {
  allIds,
  EMPTY_RANGE_FILTERS,
  keepVisible,
  rangeGroups,
  rangeRequest,
  toggleIds,
  triState,
} from '../src/components/questions/viewer/range-model';
import { classifyRunFailure } from '../src/lib/questions/practice-run-problems';
import {
  parseRunState,
  positionLabel,
  progressText,
  restartRange,
  summaryText,
  withRunState,
} from '../src/lib/questions/practice-runs';
import { closeDialog, openDialogs, RUN_DIALOG, withoutPanels } from '../src/lib/workspaces/home';

const RUN = '33333333-3333-4333-8333-000000000001';

describe('run panel URL state', () => {
  it('parses the range step, a position and the results step', () => {
    const p = (q: string) => parseRunState(new URLSearchParams(q));
    expect(p('')).toBeNull();
    expect(p('practice=new&source=bank')).toEqual({
      step: 'picker',
      source: 'bank',
      mockExamId: null,
    });
    expect(p(`practice=${RUN}&i=2`)).toEqual({ step: 'solve', runId: RUN, position: 2 });
    expect(p(`practice=${RUN.toUpperCase()}`)).toEqual({ step: 'solve', runId: RUN, position: 1 });
    expect(p(`practice=${RUN}&i=99999`)).toEqual({ step: 'solve', runId: RUN, position: 1 });
    expect(p(`practice=${RUN}&i=0`)).toEqual({ step: 'solve', runId: RUN, position: 1 });
    expect(p(`practice=${RUN}&view=results`)).toEqual({ step: 'results', runId: RUN });
    expect(p('practice=not-a-run')).toEqual({ step: 'missing' });
  });

  it('writes and clears its keys, keeping the rest of the home URL', () => {
    const picker = withRunState('?q=물&panel=history', {
      step: 'picker',
      source: 'bank',
      mockExamId: null,
    });
    expect(new URLSearchParams(picker).get('practice')).toBe('new');
    expect(new URLSearchParams(picker).get('source')).toBe('bank');
    const solve = withRunState(picker, { step: 'solve', runId: RUN, position: 3 });
    expect(Object.fromEntries(new URLSearchParams(solve))).toEqual({
      q: '물',
      panel: 'history',
      practice: RUN,
      i: '3',
    });
    const results = withRunState(solve, { step: 'results', runId: RUN });
    expect(new URLSearchParams(results).get('view')).toBe('results');
    expect(new URLSearchParams(results).has('i')).toBe(false);
    expect(withRunState(results, null)).toBe('?q=%EB%AC%BC&panel=history');
  });

  it('is one home dialog: closing it (or every dialog) drops its keys, moving is not a close', () => {
    const search = `?panel=history&practice=${RUN}&i=2`;
    expect(openDialogs(search)).toEqual(['history', RUN_DIALOG]);
    expect(openDialogs(`?panel=history&practice=${RUN}&view=results`)).toEqual(openDialogs(search));
    expect(closeDialog(search, RUN_DIALOG)).toBe('?panel=history');
    expect(withoutPanels(search)).toBe('');
  });
});

describe('range model', () => {
  const overview = {
    chapters: [
      { id: 'c1', title: '1장 물의 순환', number: 1, question_count: 2, document_id: null },
      { id: null, title: '챕터 없음', number: null, question_count: 1, document_id: null },
    ],
    items: [
      { question_id: 'a', chapter_id: 'c1', question_number: 1, preview: '증발은? ( )' },
      { question_id: 'b', chapter_id: 'c1', question_number: 2, preview: '응결은?' },
      { question_id: 'n', chapter_id: null, question_number: 5, preview: '강수는?' },
    ].map((i) => ({
      ...i,
      question_type: 'MCQ' as const,
      status: 'unseen' as const,
      is_favorite: false,
      needs_retry: false,
      last_graded_result: null,
      is_pending_grading: false,
    })),
  };
  const groups = rangeGroups(overview);

  it('groups the Heatmap questions by chapter with their Heatmap numbers', () => {
    expect(groups.map((g) => [g.key, g.title, g.questions.map((q) => q.number)])).toEqual([
      ['c1', '1장 물의 순환', ['1장 1번', '1장 2번']],
      ['none', '챕터 없음', ['5번']],
    ]);
    expect(groups[0]?.questions[0]?.preview).toBe('증발은?');
  });

  it('is tri-state and a click on a checked group clears it', () => {
    expect(triState(['a', 'b'], new Set())).toBe(false);
    expect(triState(['a', 'b'], new Set(['a']))).toBe('indeterminate');
    expect(triState(['a', 'b'], new Set(['a', 'b']))).toBe(true);
    expect([...toggleIds(new Set(['a']), ['a', 'b'])]).toEqual(['a', 'b']);
    expect([...toggleIds(new Set(['a', 'b']), ['a', 'b'])]).toEqual([]);
    expect([...keepVisible(new Set(['a', 'gone']), groups)]).toEqual(['a']);
  });

  it('sends everything as `all`, whole chapters as ids, single questions as ids', () => {
    expect(rangeRequest(groups, new Set(), EMPTY_RANGE_FILTERS)).toBeNull();
    expect(rangeRequest(groups, new Set(allIds(groups)), EMPTY_RANGE_FILTERS)).toEqual({
      all: true,
    });
    expect(rangeRequest(groups, new Set(['a', 'b']), EMPTY_RANGE_FILTERS)).toEqual({
      chapter_ids: ['c1'],
    });
    expect(rangeRequest(groups, new Set(['a', 'n']), EMPTY_RANGE_FILTERS)).toEqual({
      chapter_ids: ['none'],
      question_ids: ['a'],
    });
    const filters = { ...EMPTY_RANGE_FILTERS, status: ['incorrect' as const], retry: true };
    expect(rangeRequest(groups, new Set(allIds(groups)), filters)).toEqual({
      all: true,
      filters: { status: ['incorrect'], retry: true },
    });
  });
});

describe('run labels and failures', () => {
  it('labels positions like the Heatmap, mock exam questions by position', () => {
    const at = { chapter_number: 3, chapter_title: '3장', question_number: 12, position: 4 };
    expect(positionLabel(at, 'bank')).toBe('3장 12번');
    expect(positionLabel({ ...at, chapter_number: null }, 'bank')).toBe('3장 12번');
    expect(positionLabel({ ...at, chapter_number: null, chapter_title: null }, 'bank')).toBe(
      '12번',
    );
    expect(positionLabel(at, 'mock')).toBe('문제 4');
    expect(progressText(2, 5)).toBe('5문제 중 2번째');
    expect(summaryText({ correct: 1, incorrect: 1, pending: 2, skipped: 1 })).toBe(
      '맞음 1 · 틀림 1 · 채점 대기 2 · 건너뜀 1',
    );
  });

  it('starts over with the questions that are still available', () => {
    const row = (position: number, id: string | null, available = true) => ({
      position,
      question_id: id,
      available,
      question_type: null,
      chapter_id: null,
      chapter_number: null,
      chapter_title: null,
      question_number: null,
      preview: null,
      result: null,
    });
    expect(restartRange([row(1, 'a'), row(2, null, false), row(3, 'c'), row(4, 'a')])).toEqual({
      question_ids: ['a', 'c'],
    });
  });

  it('maps the run problems', () => {
    const p = (type: string) => ({ type: `urn:quiz-workspace:problem:${type}` });
    expect(classifyRunFailure(404, undefined)).toBe('notFound');
    expect(classifyRunFailure(401, undefined)).toBe('unauthenticated');
    expect(classifyRunFailure(403, p('workspace-archived'))).toBe('archived');
    expect(classifyRunFailure(409, p('no-matching-questions'))).toBe('noMatching');
    expect(classifyRunFailure(409, p('already-submitted'))).toBe('alreadySubmitted');
    expect(classifyRunFailure(409, p('practice-session-reset'))).toBe('reset');
    expect(classifyRunFailure(409, p('practice-run-finished'))).toBe('finished');
    expect(classifyRunFailure(422, p('practice-run-too-large'))).toBe('tooLarge');
    expect(classifyRunFailure(422, p('range-invalid'))).toBe('rangeInvalid');
    expect(classifyRunFailure(500, undefined)).toBe('unavailable');
  });
});
